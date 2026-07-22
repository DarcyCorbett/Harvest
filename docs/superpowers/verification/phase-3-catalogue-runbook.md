# Phase 3 catalogue migration runbook

Phase 3 is operator-run only. It does not tag recipes with Gemini, fetch recipe websites, enable catalogue generation, or create a Scheduler trigger.

## Before production writes

1. Run `npm run verify:phase3:local` from the repository root.
2. Deploy the single-task job:
   `./scripts/deploy-phase3-migration.ps1 -ProjectId <project>`
3. Create a Firestore export in the existing private catalogue bucket and retain the printed URI:
   `./scripts/backup-phase3-firestore.ps1 -ProjectId <project> -Bucket <bucket>`
4. Run the read-only inventory:
   `./scripts/run-phase3-migration.ps1 -ProjectId <project> -Stage dry-run`
5. Record the sanitized output in the Phase 3 evidence file. Stop if the source distribution or failures are materially unexpected.

Every runner invocation checks that Scheduler is `PAUSED` and `generationMode` is `legacy` both before and after execution. Mutating stages refuse to run without a discoverable backup URI.

## Recipe migration

Run a canary capped at 25 catalogue-data writes:

`./scripts/run-phase3-migration.ps1 -ProjectId <project> -Stage migrate-recipes -MaxWrites 25 -BackupUri <gs-uri>`

Inspect mappings and ready/review targets, then continue with manual runs capped at 20,000 writes:

`./scripts/run-phase3-migration.ps1 -ProjectId <project> -Stage migrate-recipes -MaxWrites 20000 -BackupUri <gs-uri>`

Repeat until the summary reports `complete`. Budget-exhausted runs are expected and resume from the durable cursor.

## References and reconciliation

After recipes complete, migrate a 10-reference canary, inspect it, then process the remainder:

`./scripts/run-phase3-migration.ps1 -ProjectId <project> -Stage migrate-references -MaxReferences 10 -BackupUri <gs-uri>`

`./scripts/run-phase3-migration.ps1 -ProjectId <project> -Stage migrate-references -BackupUri <gs-uri>`

Late legacy writes are handled by `reconcile`, followed by another reference run:

`./scripts/run-phase3-migration.ps1 -ProjectId <project> -Stage reconcile -MaxWrites 20000 -BackupUri <gs-uri>`

Finish with `-Stage verify`. Keep Scheduler paused and generation mode legacy; Phase 5 owns cutover.
