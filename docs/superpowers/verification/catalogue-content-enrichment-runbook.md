# Catalogue content enrichment runbook

This workflow restores bounded recipe-card metadata without storing page HTML or making AI calls. All commands run from `functions/`. Production mutation is opt-in; audit and recovery default to dry-run.

## 1. Audit

```powershell
npm run catalogue:enrich-content -- audit
npm run catalogue:enrich-content -- audit --source recipetineats --max-per-source 100
```

The report contains only aggregate source counts, field coverage, parser-version candidates, estimated reads/fetches/writes, and document byte totals. It emits no recipe identifiers or content.

## 2. Recover preserved legacy enrichment

Start with a dry run, including frozen sources:

```powershell
npm run catalogue:enrich-content -- recover-legacy --dry-run --source seriouseats,akispetretzikis --max-per-source 10
```

Apply with a unique run ID and a cap that includes both the recipe update and its backup:

```powershell
npm run catalogue:enrich-content -- recover-legacy --apply --run-id enrichment-2026-09-04 --write-cap 1000
```

The cursor is persisted under `catalogueContentEnrichmentRuns/{runId}`. Re-running the same command resumes. `--after <mapping-id>` can set an explicit starting cursor. Every changed recipe is copied once to the run's `backups` subcollection before update. Ingredient groups and instruction headers/media are copied only when normalized order and text align with canonical content.

## 3. Re-fetch active sources

Run roughly ten-recipe canaries in this order: WordPress sources, NYT Cooking, then America's Test Kitchen.

```powershell
npm run catalogue:ingest -- content-enrichment-canary --source recipetineats,budgetbytes,thewoksoflife,themediterraneandish,spendwithpennies,cafedelites,skinnytaste,pinchofyum,natashaskitchen --max-per-source 10 --write-cap 200 --run-id enrich-wp-canary
npm run catalogue:ingest -- content-enrichment-canary --source nytcooking --max-per-source 10 --write-cap 30 --run-id enrich-nyt-canary
npm run catalogue:ingest -- content-enrichment-canary --source americastestkitchen --max-per-source 10 --write-cap 30 --run-id enrich-atk-canary
```

After reviewing canary summaries and `coreChangeReview`, run capped batches:

```powershell
npm run catalogue:ingest -- content-enrichment-backfill --source recipetineats --max-per-source 250 --write-cap 1000 --run-id enrich-wp-001
```

The default fairness window remains 250 recipes per source. Once only a small number of well-behaved sources remain, `--max-per-source` may be raised as high as 5,000 to reduce container startups and repeated verification scans. Size the actual window from Cloud Monitoring's complete Pacific-day `document/write_count`, allowing approximately two Firestore writes per candidate plus operational overhead and retaining a safety buffer below the daily quota.

Verify every persisted mutation against its run-scoped backup before increasing the cap:

```powershell
npm run catalogue:enrich-content -- verify-run --run-id enrich-wp-001
```

The verifier is read-only. It reports missing targets, protected metadata drift, core ingredient/instruction drift, and oversized documents without emitting recipe identifiers or content. A successful batch must report zero for all four checks.

If an interrupted or superseded deployment ever changes protected metadata, restore only those protected fields from the backups while retaining valid enrichment:

```powershell
npm run catalogue:enrich-content -- repair-run --run-id enrich-wp-001
npm run catalogue:enrich-content -- repair-run --apply --run-id enrich-wp-001
```

The first command is a dry run. The apply form is transactional and skips recipes changed concurrently after the enrichment run.

Only active sources below the current parser version are selected through the indexed `schemaVersion`/`status`/`source.key`/`classification.parserVersion` query. Serious Eats and Akis are excluded from refetch by construction. The enrichment store preserves canonical ingredient and instruction text; any detected core difference creates a count-only review record. A successful parse advances the parser checkpoint even when the enrichment itself is unchanged or a core difference is held for review, preventing repeat fetches. Persisted checks receive a run-scoped backup. The classifier is deterministic and telemetry must report zero Gemini calls.

`--refresh-outdated-parser` is available for explicit ingestion runs, but normal weekly ingestion does not refresh a recipe solely because its parser version changed.

## 4. Acceptance

- Run `verify-run` and require zero missing recipes, metadata mismatches, core mismatches, and oversized documents before expanding each source batch.
- Review aggregate `coreChangeReview` counts separately; these indicate source text differences that were intentionally not persisted.
- Confirm existing enrichment is non-decreasing and maximum document size remains below Firestore's limit.
- Run the audit again and verify parser-version candidates and missing-field counts decline.
- Run a second complete recovery/refetch pass; expect zero recipe-site fetches and zero recipe writes.
- Smoke-test one WordPress, NYT, ATK, Serious Eats, and Akis detail view, including serving scaling, grouped ingredients, step media fallback, and shopping-list output.
