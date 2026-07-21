# Simplified Phase 3 — Legacy Recipe Migration

## Summary

Keep the nearly completed recipe conversion and restartable migration engine, but simplify everything that remains.

Phase 3 uses one manually invoked Google Cloud Run Job to preview the migration, copy legacy recipes into deterministic v2 documents, update meal-plan and cookbook references, and verify counts. Legacy recipes remain in place, the existing generator remains active, Cloud Scheduler remains `PAUSED`, and `/appConfig/catalogue.generationMode` remains `legacy`. Phase 3 performs no Gemini calls.

## Implementation

### Finish the existing recipe engine

- Retain deterministic conversion, safe resume, idempotent reruns, collision and concurrent-change protection, configurable write caps, dry-run, and reconciliation.
- Finish the pending Firestore scanner/transaction store and its existing focused tests.
- Do not add more generic migration frameworks.

### Add simple reference migration

- Scan meal-plan and cookbook collection groups after recipe migration completes.
- Use `/catalogueRecipeMigrations/{legacyRecipeId}` to resolve canonical IDs.
- Meal plans update only `recipeId`.
- Cookbooks transactionally create or merge the canonical-ID document and delete the legacy-ID entry. Preserve other fields, combine `starred` with logical OR, and keep the earliest valid `addedAt`.
- Leave orphans and failed mappings untouched. Reruns are no-ops when already migrated.
- Do not build reference-audit collections, reverse replay, or automated rollback. Recovery uses the pre-migration backup and preserved legacy recipes.

### Add one operator Cloud Run Job

- Add one migration CLI supporting `dry-run`, `migrate-recipes`, `migrate-references`, `reconcile`, and `verify`.
- Deploy one manually invoked `mealwizard-catalogue-migration` Cloud Run Job with one task, one worker, and no Scheduler trigger.
- Reuse existing project infrastructure and service-account permissions where safe.
- Complete a timestamped full Firestore export to the existing private catalogue bucket before the first production write.
- Use Cloud Logging and one sanitized JSON summary per command. Never log recipe URLs, household IDs, user IDs, or recipe content.

## Test and Rollout Plan

Keep the existing conversion, restart, idempotency, cap, collision, and Firestore-store tests. Add only focused tests for:

- Meal-plan replacement while preserving other fields.
- Cookbook move and collision merge.
- Orphan and failed-mapping no-ops.
- Reference rerun idempotency.
- CLI parsing and dry-run write prevention.
- Client denial for server-only migration collections.

Local acceptance requires the focused migration tests, existing Functions tests, Functions TypeScript build, and Firestore rules tests to pass. Static checks must confirm there is no change to the mobile generator, Scheduler configuration, catalogue generation mode, or Gemini behavior.

Cloud rollout is manual and gated:

1. Confirm Scheduler is `PAUSED` and generation mode is `legacy`.
2. Deploy the migration job without a Scheduler.
3. Run `dry-run` and review counts.
4. Complete a full Firestore export to the existing private bucket.
5. Run a canary of at most 25 recipes and rerun it to prove idempotency.
6. Run manually triggered recipe batches using the existing write cap.
7. Run reference migration after recipe migration completes.
8. Run `reconcile`, followed by `verify`.
9. Confirm legacy documents remain, references resolve, Scheduler remains paused, and generation mode remains legacy.

Stop on unexpected collisions, malformed operational state, count mismatches, or reference failures. Investigate and rerun after correction rather than adding an automated rollback framework.

## Removed and Deferred Work

Removed from Phase 3:

- Reference audit and rollback framework.
- Dedicated backup infrastructure and retention policies.
- Passive production shadow mode and fixed selector performance matrix.
- Selector latency/source-distribution gates.
- A large new emulator transaction suite.
- Daily automation, recurring scheduling, alerts, and detailed cost telemetry.

Gemini tagging and parser-version-1 classification remain Phase 4. Selector testing and catalogue-generation cutover remain Phase 5. A final reconciliation still runs immediately before Phase 5 cutover.

For later phases, default to one direct implementation path, manual operation before automation, a small number of data-safety tests, and new infrastructure only when a demonstrated need justifies it.
