# Phase 2 Recipe Catalogue Pilot Runbook

Phase 2 measures the dormant catalogue with RecipeTin Eats and Serious Eats. It does not cut generation over to the catalogue, resume managed ingestion, remove the legacy tagger, or migrate recipe references.

## Safety invariants

- Cloud Scheduler `mealwizard-catalogue-daily` must be `PAUSED` before and after the pilot.
- `/appConfig/catalogue.generationMode` must remain `legacy`.
- The Cloud Run Job remains one task with parallelism one.
- Every execution uses a command write cap of 40, below the 18,000 daily ingestion ceiling.
- HTTP 401, HTTP 402, and HTTP 403 from Serious Eats are unsupported protected-access outcomes. Do not add browser automation, alternate identities, proxying, or other bypass behavior.
- Evidence contains counters, timing, reason codes, token counts, byte estimates, and deterministic hashes only. Do not retain recipe content, source URLs, prompts, credentials, emails, UIDs, or household identifiers.

## Local gate

Install locked dependencies when the worktree is new:

```powershell
npm.cmd ci
npm.cmd --prefix functions ci
```

Run the complete local gate:

```powershell
npm.cmd run verify:phase2:local
git diff --check
```

The aggregate command runs Functions tests/build, client and pilot tests, Firestore Emulator rules tests, lint, the root TypeScript check, and the client secret scan. Record exact file/test totals, the intentional skip, and lint warnings rather than rounding them.

## Dormant deployment

The existing Phase 1 deployment script remains the idempotent deployment path because the infrastructure is intentionally still dormant:

```powershell
.\scripts\deploy-phase1-catalogue.ps1 -ProjectId meal-wizard-ad202
```

The script builds the current Functions container, updates the Cloud Run Job and callable functions, deploys rules/indexes, pauses Scheduler, and pins `generationMode` to `legacy`.

Verify the resource shape before running the pilot:

```powershell
gcloud run jobs describe mealwizard-catalogue-ingestion --region=europe-west1 --project=meal-wizard-ad202
gcloud scheduler jobs describe mealwizard-catalogue-daily --location=europe-west1 --project=meal-wizard-ad202
```

Require one task, parallelism one, the dedicated ingestion service account, and Scheduler state `PAUSED`.

## Bounded pilot

Build the Functions modules used by the read-only evidence collector, then run the orchestrator:

```powershell
npm.cmd run build:functions
.\scripts\run-phase2-pilot.ps1 -ProjectId meal-wizard-ad202
```

The runner creates three timestamped run IDs:

1. A discovery-only run for `recipetineats,seriouseats`.
2. A forced target run using two curated RecipeTin Eats pages and one curated Serious Eats page.
3. An unchanged run using the exact same targets without force refresh.

The Node verifier reads the three run documents, catalogue mode, hashed sample documents, and real Firestore selection candidate pages. It uses fixed pilot source weights and does not read or mutate a household.

## Pass thresholds

- Both sources have explicit discovery evidence. A Serious Eats discovery failure is acceptable only when it is source-attributed and bounded.
- The first target run has no retryable or unbounded failures.
- At least one RecipeTin Eats sample is `ready` and passes canonical readiness/search consistency checks.
- Serious Eats is either a valid complete sample or a `disabled` record with `unsupported-401`, `unsupported-402`, or `unsupported-403`. The Phase 1 production result was HTTP 402, so `disabled / unsupported-402` remains the expected protected-source outcome unless access changes.
- The second target run has zero page fetches and zero recipe-document writes.
- Every run reserves and consumes no more than 40 writes.
- Sampled ready recipes have time, meal type, cuisine, complete classification, and rebuilt search fields.
- The real selector path completes 10 iterations with p95 no greater than 2,000 ms.
- Evidence reports run writes, recipe reads, selector query/candidate reads, estimated document bytes, and Gemini calls/input/output/total token counts.

The verifier exits non-zero on any failure. Do not weaken thresholds in response to a failing cloud run; diagnose the implementation or record the source as unavailable when the bounded source policy permits it.

## Evidence to retain

- Implementation commit and deployed Cloud Build ID/image digest.
- Cloud Run Job task count, parallelism, region, and service account.
- Scheduler schedule, timezone, and `PAUSED` state before and after.
- `generationMode: legacy` from the read-only Firestore verifier.
- All three run IDs and sanitized validator JSON.
- Per-source discovery/fetch/parse/classification/write/skip/failure counters.
- Sample quality, size, read/write, selection latency, and Gemini usage aggregates.
- Exact local verification totals.

## Rollback

Keep Scheduler `PAUSED` and generation mode `legacy`. If the deployed image is faulty, update the Cloud Run Job back to the Phase 1 image digest recorded in `phase-1-catalogue-evidence.md`. Retain manifests, run summaries, canonical pilot documents, legacy recipes, recipe-index data, cookbook entries, meal plans, and the existing tagger. Do not bulk-delete catalogue or legacy data.
