# Phase 1 Catalogue Foundation Evidence

**Date:** 2026-07-18  
**Baseline:** `51b6b2d`  
**Branch:** `codex/phase-1-catalogue`  
**Project:** `meal-wizard-ad202`  
**Status:** Implemented, deployed dormant, and verified. The Scheduler is paused and catalogue generation remains `legacy`.

## Implemented scope

- Versioned canonical schema, deterministic identity, controlled taxonomies, time precedence, ingredient tokens, effective metadata, search rebuilding, readiness, and Firestore safety checks.
- Shared backend JSON-LD parser and discovery/fetch contracts for all 13 trusted sources.
- Durable Cloud Storage manifests, restart cursors, missing-manifest recovery, unchanged skipping, bounded budget reservations, renewable lease, fair source rotation, retry/tombstone state, circuit isolation, and sanitized run summaries.
- Structured Gemini classification only after deterministic/source classification leaves controlled fields ambiguous.
- Authenticated `selectCatalogueRecipes` and editor-only `updateCanonicalRecipeMetadata` callables in `europe-west1`.
- Server-only catalogue operational collections, authenticated/server-write catalogue configuration, composite indexes, and large-field index exemptions.
- Node 22 ingestion container, checked deployment commands, paused Scheduler creation, operator runbook, capped pilot smoke, and second-run idempotency verification.
- The mobile generator and legacy tagger paths were not modified.

## Local verification

- Backend: 16 test files, 336 tests passed.
- Client/Phase 0: 10 test files, 158 tests passed and 1 existing intentional skip.
- Firestore emulator: 35 tests passed.
- Functions TypeScript build: passed.
- Root TypeScript check: passed.
- Client secret scan: passed for all 6 targets.
- Lint: 0 errors and 20 pre-existing warnings in unchanged mobile files.
- PowerShell and Node deployment/smoke script parsing: passed.
- `git diff --check`: passed.
- Firestore indexes deployed twice identically after correction, both successful.

## Deployment evidence

- Cloud Build `054cb124-705f-4105-baa3-3a65f2856879`: `SUCCESS`.
- Image digest: `sha256:d4aa78e09e859a413498a468139116bf4976f386f396486e29233bcd414872a3`.
- Cloud Run Job: `mealwizard-catalogue-ingestion`, `europe-west1`, one task, parallelism one, 3600-second timeout, three retries.
- Ingestion identity: `mealwizard-catalogue@meal-wizard-ad202.iam.gserviceaccount.com`.
- Manifest bucket: `meal-wizard-ad202-catalogue-manifests`, `EUROPE-WEST1`, uniform bucket-level access enabled.
- Scheduler: `mealwizard-catalogue-daily`, `0 3 * * *`, `Asia/Nicosia`, state `PAUSED`.
- Both callable functions were created successfully in `europe-west1`.
- `/appConfig/catalogue.generationMode` remains `legacy`.

## Production smoke evidence

- First run: `phase1-smoke-20260718110434-first`.
  - Reserved 25 writes and consumed 8.
  - Fetched both pilot targets.
  - RecipeTin Eats produced one canonical recipe.
  - Serious Eats returned HTTP 402 from Cloud Run and was correctly recorded as `disabled / unsupported-402`, as required for unsupported or protected content without bypass attempts.
  - No retryable or failed outcomes.
- Second run: `phase1-smoke-20260718110434-second`.
  - Both targets recognized as unchanged.
  - Zero page fetches and zero recipe writes.
  - `generationMode` remained `legacy`.

## Host tooling note

- Java 21, Google Cloud CLI 576.0.0, WSL 2.7.10, and Docker Desktop 29.6.1 are installed.
- Local Docker cannot start until AMD virtualization is enabled in BIOS/UEFI. This did not block Phase 1: the production container built successfully in Cloud Build and completed two Cloud Run executions.
