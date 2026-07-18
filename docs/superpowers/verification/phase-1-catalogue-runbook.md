# Phase 1 Catalogue Deployment and Smoke Runbook

Phase 1 deploys dormant catalogue infrastructure. The installed app must remain on the legacy generator, the existing scheduled tagger remains active, and the new Cloud Scheduler job remains paused.

## Preconditions

- Phase 0 commit `51b6b2d` is deployed and its evidence remains valid.
- Google Cloud CLI is installed and authenticated to the target project.
- Application Default Credentials are available for the configuration and evidence scripts.
- The existing `mealwizard-gemini-api-key` Secret Manager secret contains the server-only key.
- Java is installed when running Firestore emulator tests.

## Verify locally

From the repository root:

```powershell
npm.cmd run test:functions
npm.cmd run build:functions
npm.cmd run test:client
npm.cmd run test:rules
npm.cmd run lint
npx.cmd tsc --noEmit
npm.cmd run scan:client-secrets
```

## Deploy dormant infrastructure

```powershell
.\scripts\deploy-phase1-catalogue.ps1 -ProjectId meal-wizard-ad202
```

The script is idempotent. It enables required APIs, creates or updates Artifact Registry, the private manifest bucket, least-privilege service accounts, the one-task Cloud Run Job, the paused 03:00 `Asia/Nicosia` Scheduler trigger, Firestore rules/indexes, both catalogue callables, and `/appConfig/catalogue` with `generationMode: "legacy"`.

After deployment, verify these invariants before any smoke:

```powershell
gcloud run jobs describe mealwizard-catalogue-ingestion --region=europe-west1 --project=meal-wizard-ad202
gcloud scheduler jobs describe mealwizard-catalogue-daily --location=europe-west1 --project=meal-wizard-ad202
```

The job must show one task and parallelism one. The Scheduler state must be `PAUSED`.

## Production smoke and idempotency proof

```powershell
.\scripts\smoke-phase1-catalogue.ps1 -ProjectId meal-wizard-ad202
```

The first execution force-refreshes one known RecipeTin Eats URL and one known Serious Eats URL while reserving no more than 25 total ingestion writes. The second execution targets the same URLs without force refresh. `verifyCatalogueSmoke.mjs` fails unless the second execution reports zero page fetches and zero recipe writes, both runs stay within the cap, and `generationMode` remains `legacy`.

## Evidence to retain

- Local test file and assertion counts.
- Cloud Run Job description showing one task, parallelism one, service account, image digest, and region.
- Paused Scheduler description showing `0 3 * * *` and `Asia/Nicosia`.
- IAM policies for the ingestion and Scheduler identities.
- Artifact Registry image digest and manifest-bucket location.
- Both `/catalogueRuns/{runId}` summaries printed by the smoke verifier.
- Sanitized Cloud Logging entries containing only run IDs, counters, status codes, latency, and provider token usage. Do not retain recipe content, prompts, credentials, or user data.

## Rollback

Keep the Scheduler paused. If catalogue infrastructure must be disabled, leave `generationMode` set to `legacy`, disable the two catalogue callables or remove their traffic, and retain manifests and catalogue documents for audit. Do not delete legacy recipes, recipe-index data, meal plans, cookbook entries, or the existing tagger during Phase 1.
