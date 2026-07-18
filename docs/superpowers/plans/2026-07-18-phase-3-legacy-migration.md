# Phase 3 — Legacy Recipe Migration Plan

## Summary

Phase 3 migrates every legacy `/recipes` document into a deterministic schema-v2 document, preserves all legacy documents, migrates valid meal-plan and cookbook references, and evaluates the catalogue selector through fixed operator-run tests. The production generator remains unchanged.

Production planning baseline as of 2026-07-18:

- 27,647 legacy recipes and 4 schema-v2 recipes.
- 69 meal-plan references: 50 point to legacy recipes and 19 are existing orphans.
- 151 cookbook references: 54 point to legacy recipes and 97 are existing orphans.
- All approved-source legacy recipes are in scope.
- Manually triggered batches are capped at approximately 8,000 catalogue-data writes per day.
- Cloud Scheduler stays `PAUSED`; `/appConfig/catalogue.generationMode` stays `legacy`.
- No passive selector execution occurs during normal user generation.
- Migration performs no recipe-site fetches and makes no Gemini calls.

## Data Contracts and Migration Behavior

Add a server-only `/catalogueRecipeMigrations/{legacyRecipeId}` mapping with:

- `schemaVersion: 1`
- `legacyRecipeId`, `canonicalRecipeId`, and `sourceKey`
- `state: migrated | linked-existing | failed`
- `targetStatus: ready | review` for successful mappings
- bounded `reasonCodes`, deterministic `contentHash`, run ID, and timestamps

Add server-only migration checkpoint, run-summary, and reference-audit collections. Firestore rules explicitly deny client access. Reference audit records retain the old/new IDs, operation type, document path, and sufficient before-state to reverse the exact reference update. Checked-in evidence redacts household IDs, recipe IDs, URLs, and document paths.

Do not add or change a mobile API or callable. Migration and shadow verification remain operator-only Cloud Run Job entrypoints.

For each legacy recipe:

1. Validate and canonicalize `sourceUrl`, resolve the host against `SOURCE_CONFIGS`, and derive the canonical SHA-256 recipe ID.
2. Convert stored content without external requests: preserve display fields; parse time strings; map course, cuisine, and tags into the fixed taxonomy; build effective metadata and search fields; and derive `search.randomKey` deterministically from the ID.
3. Set `classification.parserVersion` to `0` so Phase 4 parser version 1 refreshes migrated content.
4. Emit `ready` only when `validateReadyRecipe` succeeds; otherwise emit a structurally displayable `review` document with bounded reasons.
5. For invalid display content, unsupported sources, or invalid URLs, write only a failed mapping and do not migrate references.
6. Create the v2 target and mapping atomically. Preserve a matching existing v2 target and record `linked-existing`. Fail closed if an occupied target ID contains a different canonical URL.
7. Map duplicate legacy IDs to the same canonical target. Existing v2 content wins; otherwise the first legacy document in document-ID order creates the target. Reruns never overwrite it.

Reference migration runs after the recipe pass:

- Meal plans transactionally replace only `recipeId`.
- Cookbooks transactionally create or merge the canonical-ID document, then delete the legacy-ID document. Preserve unknown fields, combine `starred` with logical OR, and keep the earliest valid `addedAt`.
- A concurrently changed reference becomes a no-op.
- Existing orphans and failed mappings remain untouched and are reported.
- Generation-result documents are backed up but not rewritten.
- Reconciliation remains rerunnable while legacy generation can create additional recipes or references.

## Implementation Sequence

### 1. Migration conversion under TDD

- Add failing tests for URL/ID conversion, source resolution, time and taxonomy normalization, deterministic hashes/search keys, ready-versus-review classification, unsupported sources, collisions, and duplicate canonical URLs.
- Implement pure conversion functions using the existing catalogue domain model.
- Use representative synthetic fixtures for every legacy source shape.

### 2. Restartable migration engine under TDD

- Scan `/recipes` in document-ID order and skip schema-v2 documents.
- Store a durable stage and cursor.
- Share the existing catalogue lease so ingestion and migration cannot overlap.
- Reserve exact target, mapping, reference, and audit writes through the existing 18,000-write daily budget and enforce the additional 8,000-write command cap.
- Stop before exceeding a cap and resume after the last committed unit.
- Allow a completed scan to restart in reconciliation mode.

### 3. Transactional reference engine under TDD

- Cover meal-plan updates, cookbook moves and collisions, concurrent edits, failed targets, orphans, exact reruns, and rollback in emulator tests.
- Roll back references by replaying a selected run's audit entries in reverse order. Additive recipes and mappings remain preserved.

### 4. Operator tooling and infrastructure

- Add a manually invoked `mealwizard-catalogue-migration` Cloud Run Job using the Functions image and a migration CLI entrypoint.
- Keep task count and parallelism at one and create no Scheduler trigger.
- Support `dry-run`, `migrate-recipes`, `migrate-references`, `reconcile`, `verify`, `shadow-verify`, and `rollback-references` stages.
- Add a PowerShell runner that checks Scheduler and generation mode before execution and rechecks both in a `finally` block.
- Add a private EU backup bucket with uniform access, public-access prevention, 90-day retention, and lifecycle cleanup after one year. Complete a managed full-Firestore export before the first migration write.

### 5. Fixed selector shadow evaluation

- Add a non-personal checked-in matrix covering app meal types, cuisines, modifiers, 30/45-minute limits, ingredient controls, duplicate/recent exclusion, and intentional no-match cases.
- Run the production selector core against Firestore with equal static source weights and a seeded random generator.
- Do not read household settings, write results, call recipe sites, or expose selected IDs in evidence. Discard selections after validation.

## Verification and Rollout Gates

Add `verify:phase3:local` and require:

- Migration conversion and engine unit tests.
- Firestore emulator transaction, resume, rollback, and authorization tests.
- Existing Functions and client tests.
- Functions build, TypeScript, lint, Firestore rules, and client-secret scan.
- Static assertions that Phase 3 does not modify the legacy generator, enable Scheduler, change generation mode, fetch recipe sites, invoke Gemini, or delete legacy recipes.

Production rollout is gated:

1. Confirm reviewed code, a single-task migration job, Scheduler `PAUSED`, and `generationMode=legacy`.
2. Complete and verify a full Firestore export before any migration write.
3. Run a zero-write inventory, refresh baseline counts, and calculate a stable legacy-ID hash.
4. Run a canary of at most 25 recipes and validate mappings, target documents, sizes, samples, and legacy preservation.
5. Run manual daily batches capped at 8,000 catalogue-data writes, verifying cursor, budget, failures, legacy hash, Scheduler, and mode after every batch.
6. Migrate references only after the recipe scan, starting with a bounded canary.
7. Run reconciliation and an idempotency rerun with zero recipe, mapping, or reference changes aside from operational summaries.
8. Run the fixed selector matrix. Require valid responses, no duplicates, valid ready targets satisfying hard constraints, successful broad breakfast/lunch/dinner/side cases, accurate no-match diagnostics, p95 latency no greater than two seconds, zero writes, and zero external recipe requests.
9. Record sanitized results in `docs/superpowers/verification/phase-3-catalogue-evidence.md`.

Phase 3 is complete only when every legacy recipe at the final reconciliation timestamp has a successful mapping or documented failure; successful targets validate; legacy IDs remain unchanged; all mappable meal-plan and cookbook references resolve; existing orphans remain unchanged; cookbook IDs match their migrated `recipeId`; rollback is proven; and Scheduler/mode invariants remain intact.

## Assumptions and Deferred Work

- Migration defaults to conservative 8,000-write daily runs.
- Shadow mode means fixed operator tests only, with no production background comparison.
- Phase 4 owns fetching, Gemini-assisted parser-version-1 classification, and completion of `review` documents.
- Phase 5 owns mobile catalogue generation, structured filter UI, cutover, generation-result decisions, and final reconciliation.
- Legacy recipes, the scraper/tagger, `/recipeIndex`, and the rollback path remain in place.
