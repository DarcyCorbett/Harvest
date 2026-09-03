# Catalogue Unit Backfill Runbook

The unit backfill is dry-run-only unless `--apply` is supplied. Apply runs also
require an explicit run ID. Every changed recipe is copied unchanged to:

`catalogueUnitBackfillRuns/{runId}/backups/{recipeId}`

before the recipe document is replaced in the same transaction. Keep these
backups until the application smoke test and post-run audit pass.

## 1. Source canaries

Run a dry canary for each enabled source:

```powershell
npm.cmd --prefix functions run catalogue:backfill-units -- --source recipetineats --page-size 50
```

Review `candidates`, `ambiguous`, `issueCounts`, and the bounded
`ambiguousSamples`. Apply a small canary; a write cap of 20 permits at most ten
recipe updates because each update reserves one backup write and one recipe
write:

```powershell
npm.cmd --prefix functions run catalogue:backfill-units -- --apply --run-id units-canary-recipetineats-20260831 --source recipetineats --write-cap 20 --page-size 50
```

Open several updated recipes in the app and verify ingredient display, serving
scaling, instruction temperatures, and shopping-list quantities.

## 2. Full dry run and apply

```powershell
npm.cmd --prefix functions run catalogue:backfill-units
```

After reviewing the full dry-run summary, start the bounded apply run:

```powershell
npm.cmd --prefix functions run catalogue:backfill-units -- --apply --run-id units-v4-20260831 --write-cap 18000 --page-size 250
```

If `complete` is false, rerun the exact command with the same run ID. The saved
cursor resumes after the last processed recipe. Do not use a canary run ID for
the full backfill.

## 3. Audit

Run the command again without `--apply`. A clean result has zero candidates.
Any ambiguous samples are intentionally left unchanged for manual review; the
report contains recipe IDs and reason codes but no recipe content.

Run the application smoke flow: generate, open recipes, change servings,
confirm the plan, and verify the shopping list. Do not delete the run-scoped
backup documents until this audit passes.

