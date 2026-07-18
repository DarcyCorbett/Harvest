# Phase 2 Catalogue Pilot Evidence

**Date:** 2026-07-18
**Phase 1 baseline:** `e6aa1b2`
**Plan commit:** `062864b`
**Final implementation:** `60aec18`
**Branch:** `codex/phase-2-two-source-pilot`
**Project:** `meal-wizard-ad202`
**Status:** Implemented, deployed, and verified. Scheduler remains paused and catalogue generation remains legacy.

## Implemented scope

- Optional, validated Gemini usage observations containing model and numeric token counts only.
- Source-attributed ingestion metrics for discovery, unchanged skips, fetch, parse, classification, complete/review writes, retryable/permanent outcomes, failures, recipe reads, document writes, and estimated serialized document bytes.
- Run timing, aggregate Gemini usage, and at most 20 deterministic hashed sample recipe IDs per source.
- A pure Phase 2 evidence validator enforcing Scheduler/mode, aggregate/source consistency, SHA-256 sample IDs, complete sample resolution, source outcome, write cap, idempotency, recipe quality, protected-access, measurement, and selector latency gates.
- A read-only evidence collector that allowlists run summary fields, audits sampled Firestore recipes with the production readiness/search logic, and benchmarks the production Firestore selector path with fixed pilot weights.
- A PowerShell runner for discovery-only, forced target, and unchanged target executions limited to RecipeTin Eats and Serious Eats with a 40-write command cap. It checks `generationMode=legacy` before the first execution and rechecks both mode and Scheduler state in a `finally` block.
- The mobile generator, legacy scraper/tagger paths, Scheduler configuration, and generation mode were not modified.

## TDD evidence

- Gemini usage observer: focused RED failed because `onUsage` was never invoked; GREEN passed 82 provider tests.
- Per-source ingestion telemetry: three focused RED cases failed because `bySource` was absent; GREEN passed 10 ingestion tests.
- Pilot validator: RED failed because `cataloguePilotValidation.mjs` did not exist; GREEN passed 16 initial validator cases.
- Pilot scripts: five RED cases failed because the runner, verifier, runbook, and package command did not exist; GREEN passed all script contract cases.
- Sanitized evidence boundary: RED failed because `sanitizeCataloguePilotRun` did not exist; GREEN passed after checkpoint cursors and unknown run fields were allowlisted out.
- Review hardening: RED cases proved arbitrary/non-unique sample IDs, missing sample documents, aggregate/source contradictions, unsafe protected-source reasons, missing mode preflight, and skipped failure-path postconditions could pass; GREEN passed 22 validator and 7 runner/verifier cases, including a mocked failing Cloud Run execution.
- Persisted run timing: RED proved the Firestore run store replaced the summary's completion timestamp while retaining its original duration; GREEN passed after the summary snapshot was persisted unchanged.

## Local verification gate

Command:

```powershell
npm.cmd run verify:phase2:local
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
git diff --check
```

The first sandboxed attempt stopped when Firebase CLI could not read `C:\Users\User\.config\configstore\firebase-tools.json` (`EPERM`). The identical full command was rerun with the required filesystem permission; no verification step was removed or replaced.

During review hardening, one aggregate run exposed three TypeScript fixture-inference errors after the tests passed. The fixture was typed as a string-ID array, the focused type/test checks passed, and the entire aggregate command was rerun from the committed implementation. The results below are from that fresh successful rerun.

Fresh passing results from the permission-complete run:

- Host Node.js: `v24.13.0`; npm: `11.6.2`.
- Functions target/runtime remains Node.js 22; Functions TypeScript build passed.
- Functions: 17 test files, 342 tests passed.
- Client/root: 12 test files, 187 tests passed and 1 existing intentional skip.
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

## Cloud deployment evidence

- Final Cloud Build: `d810abfe-c965-4dca-bf21-2a437f22ac04`, status `SUCCESS`.
- Final ingestion image digest: `sha256:a4143a766a93d294a163fb04add2f600bd746a648c1693c6a33856ee7779c392`.
- Image tag remains `europe-west1-docker.pkg.dev/meal-wizard-ad202/mealwizard/catalogue-ingestion:phase1`; the tag name reflects the dormant infrastructure path, not enabled generation.
- Cloud Run Job: `mealwizard-catalogue-ingestion`, `europe-west1`, task count 1, parallelism 1, 3600-second timeout, three retries.
- Ingestion identity: `mealwizard-catalogue@meal-wizard-ad202.iam.gserviceaccount.com`.
- Scheduler: `mealwizard-catalogue-daily`, `0 3 * * *`, `Asia/Nicosia`, state `PAUSED` before deployment, after deployment, before pilot, after pilot, and during final revalidation.
- `/appConfig/catalogue.generationMode`: `legacy` in the final read-only verifier output.
- The selector dependency-injection commit was deployed through `firebase deploy --only functions`; its predeploy reran 341 Functions tests and the TypeScript build before all configured Node.js 22 Functions updated successfully. The final reviewed ingestion code was then rebuilt and the Cloud Run Job updated to the digest above before the final pilot.

Cloud Build reported the existing lockfile's nine moderate npm audit findings, and Firebase reported the existing `firebase-functions` version as outdated. Neither warning changed the gate result; dependency upgrades remain separate work because they can be breaking.

## Production pilot evidence

Pilot run IDs:

- Discovery: `phase2-pilot-20260718140731-discovery` / Cloud Run execution `mealwizard-catalogue-ingestion-pc6gj`.
- Forced targets: `phase2-pilot-20260718140731-first` / execution `mealwizard-catalogue-ingestion-8fwch`.
- Unchanged targets: `phase2-pilot-20260718140731-second` / execution `mealwizard-catalogue-ingestion-t89dh`.

### Discovery coverage

- Status: complete in 10,568 ms.
- Reserved/consumed writes: 40 / 10.
- RecipeTin Eats: 495 canonical URLs discovered, 495 defensive recipe reads, zero fetches, zero document writes, zero failures.
- Serious Eats: discovery produced one bounded source-attributed failure and no URL count. The adapter did not attempt an alternate identity, browser, proxy, or access-control bypass.
- Gemini: zero calls/tokens.

### Forced target run

- Status: complete in 6,324 ms.
- Reserved/consumed writes: 40 / 9.
- Total: 3 discovered, 3 fetched, 2 parsed, 2 classified, 2 complete writes, 1 permanent skip, zero review/retryable/failed outcomes.
- RecipeTin Eats: 2 fetched, parsed, classified, and ready documents; 2 recipe writes; 9,596 estimated serialized bytes; 0 defensive recipe reads.
- Serious Eats: 1 fetch returned HTTP 402 and produced one `disabled / unsupported-402` document; 428 estimated serialized bytes; no bypass attempted.
- Gemini: 2 calls, 550 prompt tokens, 105 candidate tokens, 655 total tokens.

### Unchanged target run

- Status: complete in 2,039 ms.
- Reserved/consumed writes: 40 / 6.
- All 3 targets were recognized as unchanged.
- Page fetches: 0.
- Recipe document writes: 0.
- Gemini calls/tokens: 0.

### Recipe quality and storage

- Expected/sampled/missing documents: 3 / 3 / 0.
- Ready RecipeTin Eats documents: 2.
- Disabled Serious Eats documents: 1 with reason `unsupported-402`.
- Invalid protected-access reason codes: 0.
- Review documents: 0.
- Invalid ready documents: 0.
- Search-field mismatches: 0.
- Missing time: 0.
- Missing taxonomy: 0.
- Estimated serialized sample size: 10,024 bytes.

### Selection latency and reads

- Real Firestore selector iterations: 10.
- Selected: 10; explicit no-match: 0.
- Final p95: 197.9 ms against a 2,000 ms threshold.
- Maximum: 197.9 ms.
- Candidate documents read: 20 across 20 source queries.
- Evidence collection reads: 3 run documents, 1 config document, and 3 sample recipe documents.

Read/write figures above are application-level counters and sampled document/query measurements, not exported Firestore billing metrics.

## Cloud gate acceptance mapping

- Dormant deployment: Cloud Build `SUCCESS`; job remains one task/parallelism one.
- Rollout state: Scheduler `PAUSED`; `generationMode` `legacy`.
- Write safety: all runs reserved and consumed no more than the 40-write command cap.
- Idempotency: second run `fetched=0` and recipe `documentWrites=0`.
- Source outcome: RecipeTin Eats produced two ready recipes; Serious Eats remained explicitly `unsupported-402`.
- Quality: zero invalid, search mismatch, missing-time, or missing-taxonomy samples.
- Cost/size: writes, reads, bytes, and Gemini tokens recorded above.
- Latency: selector p95 197.9 ms, below the 2,000 ms gate.

## Code review closure

- Independent review found no Critical issues.
- All Important findings were closed in `60aec18`: legacy-mode preflight/postflight, failure-path Scheduler/mode checks, strict hashed sample identifiers, protected-source reason allowlisting, aggregate/source reconciliation, and complete sample-document reconciliation.
- Both Minor findings were closed: evidence trailing whitespace was removed, and the persisted completion timestamp now remains the same clock snapshot used for `durationMs`.
- The hardened read-only verifier passed first against the original pilot evidence and again through the guarded final pilot on the final image.
