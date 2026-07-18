# Phase 2 Catalogue Pilot Evidence

**Date:** 2026-07-18  
**Phase 1 baseline:** `e6aa1b2`  
**Plan commit:** `062864b`  
**Locally verified implementation:** `9e7283b`  
**Branch:** `codex/phase-2-two-source-pilot`  
**Project:** `meal-wizard-ad202`  
**Status:** Local gate passed. Cloud deployment and bounded pilot evidence are pending.

## Implemented scope

- Optional, validated Gemini usage observations containing model and numeric token counts only.
- Source-attributed ingestion metrics for discovery, unchanged skips, fetch, parse, classification, complete/review writes, retryable/permanent outcomes, failures, recipe reads, document writes, and estimated serialized document bytes.
- Run timing, aggregate Gemini usage, and at most 20 deterministic hashed sample recipe IDs per source.
- A pure Phase 2 evidence validator enforcing Scheduler/mode, source outcome, write cap, idempotency, recipe quality, protected-access, measurement, and selector latency gates.
- A read-only evidence collector that allowlists run summary fields, audits sampled Firestore recipes with the production readiness/search logic, and benchmarks the production Firestore selector path with fixed pilot weights.
- A PowerShell runner for discovery-only, forced target, and unchanged target executions limited to RecipeTin Eats and Serious Eats with a 40-write command cap.
- The mobile generator, legacy scraper/tagger paths, Scheduler configuration, and generation mode were not modified.

## TDD evidence

- Gemini usage observer: focused RED failed because `onUsage` was never invoked; GREEN passed 82 provider tests.
- Per-source ingestion telemetry: three focused RED cases failed because `bySource` was absent; GREEN passed 10 ingestion tests.
- Pilot validator: RED failed because `cataloguePilotValidation.mjs` did not exist; GREEN passed 16 initial validator cases.
- Pilot scripts: five RED cases failed because the runner, verifier, runbook, and package command did not exist; GREEN passed all script contract cases.
- Sanitized evidence boundary: RED failed because `sanitizeCataloguePilotRun` did not exist; GREEN passed after checkpoint cursors and unknown run fields were allowlisted out.

## Local verification gate

Command:

```powershell
npm.cmd run verify:phase2:local
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
git diff --check
```

The first sandboxed attempt stopped when Firebase CLI could not read `C:\Users\User\.config\configstore\firebase-tools.json` (`EPERM`). The identical full command was rerun with the required filesystem permission; no verification step was removed or replaced.

Fresh passing results from the permission-complete run:

- Host Node.js: `v24.13.0`; npm: `11.6.2`.
- Functions target/runtime remains Node.js 22; Functions TypeScript build passed.
- Functions: 16 test files, 340 tests passed.
- Client/root: 12 test files, 180 tests passed and 1 existing intentional skip.
- Firestore Emulator: 1 test file, 35 tests passed.
- Root TypeScript check: passed with no output.
- Lint: 0 errors and 20 pre-existing warnings in unchanged mobile files.
- Client secret scan: clean for all 6 targets.
- `git diff --check`: passed.
- The local aggregate command contains no production `gcloud`, Scheduler, or Firestore mutation step.

## Local gate acceptance mapping

- Full aggregate command: exit code 0.
- Exact results: recorded above without rounding or suppressing the intentional skip/warnings.
- Diff hygiene: `git diff --check` exit code 0.
- Rollout safety: local verification did not contact or mutate production cloud resources.

## Cloud gate

Pending. The cloud gate must record the deployment build/image, Cloud Run Job shape, Scheduler `PAUSED` before and after, `generationMode: legacy`, three run IDs, per-source outcomes, zero-fetch/zero-document-write rerun, sample quality/storage, selector read/latency results, and Gemini usage. An HTTP 402 from Serious Eats must remain `disabled / unsupported-402`; no bypass is permitted.
