# Phase 3 catalogue migration evidence

Status: complete. Production recipe and reference migration, reconciliation, idempotency, and final verification passed.

## Final pre-cutover maintenance (2026-08-07)

- A fresh Firestore export completed before writes at sanitized URI
  `gs://<private-catalogue-bucket>/phase3-backups/20260807173459`.
- Reconciliation `phase3-reconcile-20260807173742` scanned 89,843 recipe
  documents, retained 27,656 durable mapping no-ops, and reconciled 64 late
  legacy recipes as 26 new canonical targets plus 38 links to existing targets.
  It used 90 data writes and reported zero failures, concurrent changes, or
  cleanup errors.
- Reference pass `phase3-migrate-references-20260807183511` scanned 220
  references and reported 104 canonical no-ops plus 116 unchanged pre-existing
  orphans, with zero updates, moves, collisions, failures, or concurrent
  changes.
- Terminal verifier `phase3-verify-20260807183754` reported checkpoint epoch 2,
  stage `complete`, completed recipe/meal-plan/cookbook stages, 27,720 mappings,
  89,869 recipe documents, and generation mode `legacy`.
- The Sunday catalogue scheduler was restored to `ENABLED` after maintenance;
  the generation mode remained `legacy` throughout.

## Local verification

- Phase 3 implementation uses stored legacy data only; Gemini and recipe-site fetching are excluded by static checks.
- Legacy recipe documents are never deleted.
- Reference migration preserves meal-plan documents and merges cookbook collisions conservatively.
- Firestore operational collections are explicitly server-only.
- Verified 2026-07-21: 478 Functions tests passed across 22 files.
- Verified 2026-07-21: Functions TypeScript build passed.
- Verified 2026-07-21: 38 Firestore Rules emulator tests passed.
- Verified 2026-07-21: client-secret scan and Phase 3 static safety assertions passed.
- Re-verified 2026-07-22 after raising the operator-approved cap: 479 Functions tests across 22 files, Functions build, 38 Firestore Rules emulator tests, client-secret scan, Phase 3 static safety assertions, and PowerShell syntax all passed.

## Production evidence template

- Reviewed commit: `873102f`
- Cloud Build: `a460542d-106c-4616-8223-585a8c472fc0`; manual job has one task, parallelism one, zero retries, and no Scheduler trigger.
- Scheduler state before/after each 2026-07-21 operation: `PAUSED` / `PAUSED`.
- Generation mode before/after each 2026-07-21 operation: `legacy` / `legacy`.
- Full Firestore export completed before migration writes. Sanitized URI: `gs://<private-catalogue-bucket>/phase3-backups/20260721200400`.
- Initial dry-run `phase3-dry-run-20260721200434`: 27,649 legacy, 4 existing v2, zero conversion failures; stable legacy ID hash `2d58697348f18e28c7a577336be0d94b319a0e7f38f2c96fe8946f66b48b3120`.
- Initial target distribution: 10,973 ready and 16,676 review. Approved-source counts: Akis 5,151; America's Test Kitchen 14,586; Budget Bytes 17; Cafe Delites 40; Natasha's Kitchen 21; NYT Cooking 6,122; Pinch of Yum 30; RecipeTin Eats 39; Serious Eats 1,552; Skinnytaste 33; Spend With Pennies 26; Mediterranean Dish 18; Woks of Life 14.
- Recipe canary `phase3-migrate-recipes-20260721200732`: 24 writes, 12 mappings/targets, 6 ready, 6 review, zero failures. All sampled legacy documents remained present; maximum sampled target size was 6,451 bytes.
- Day-one batch `phase3-migrate-recipes-20260721200922`: 7,976 writes, 3,988 mappings/targets, 1,569 ready, 2,419 review, zero failures or concurrent changes. Combined daily usage including canary: exactly 8,000 writes.
- Post-batch dry-run `phase3-dry-run-20260721201523`: legacy count remained 27,649 and stable ID hash was unchanged. Total v2 count 4,004; total mappings 4,000; checkpoint remains at recipe stage and epoch 0.
- Additional execution `phase3-migrate-recipes-20260722045701`: 8,000 writes, 4,000 mappings/targets, 1,605 ready, 2,395 review, zero failures or concurrent changes. This ran at 05:00 UTC, still July 21 Pacific, raising that quota day's catalogue usage from 8,000 to 16,000. It remained below the enforced 18,000 hard limit but exceeded the conservative 8,000 target; all further writes stopped immediately.
- Follow-up hardening sets the migration engine's daily limit to 8,000, not merely its per-command cap, preventing multiple commands or timezone mistakes from exceeding the conservative Pacific-day target.
- Daily-cap hardening deployed through Cloud Build `4ba47349-b105-4f43-be0e-b1c574bfd440`, image digest `sha256:c78e3d587b1b191815853cbdaeb1acc3d2d60bda95093411c94d40f4d05e3a8f`; the job remained single-task/manual, Scheduler remained `PAUSED`, and generation mode remained `legacy`.
- On 2026-07-22 the operator explicitly raised the Phase 3 command and Pacific-day ceilings to 20,000 writes to complete the remaining migration in two quota days. This prioritizes rollout speed and may exceed the Firestore free allowance when combined with normal application and operational writes.
- The 20,000-write version was deployed through Cloud Build `168c34f2-b433-4564-86ca-0ed75ce4622e`, image digest `sha256:dd8071c9b665623173cf6d3118b98e7f7688baad348996f8ec4531af87763ced`; the job remained single-task/manual, Scheduler remained `PAUSED`, and generation mode remained `legacy`.
- Post-execution dry-run `phase3-dry-run-20260722050224`: 27,656 legacy recipes, 8,004 v2 documents, zero conversion failures. Seven new Serious Eats legacy recipes arrived through the still-active legacy generator, producing the expected reconciliable hash `d039e8b97b966b0ce22b4c18824ad26e5518ac7fe8afbf127dc665c8e12da518`.
- First accelerated batch `phase3-migrate-recipes-20260722201734` (execution `mealwizard-catalogue-migration-44fmr`): exactly 20,000 catalogue writes, 10,000 mappings/targets, 3,990 ready, 6,010 review, zero failures or concurrent changes; completed successfully in 13m29s.
- Post-batch inventory `phase3-dry-run-20260722203245`: 27,656 legacy recipes and 18,004 v2 documents, with 18,000 migrated mappings represented by the v2 increase. The legacy count and stable ID hash remained unchanged and conversion failures remained zero. Remaining recipe work is 9,656 mappings/targets (19,312 catalogue writes). Current auto-mappable references are 29 meal-plan updates and 33 cookbook moves; 158 existing orphans remain untouched.
- Second accelerated recipe batch `phase3-migrate-recipes-20260723193221` (execution `mealwizard-catalogue-migration-5wchx`): 19,309 catalogue writes; 9,653 new targets and 3 mappings linked to existing canonical targets; 3,808 ready and 5,848 review outcomes; zero failures or concurrent changes. The recipe scan completed within the second 20,000-write quota day.
- Reference canary `phase3-migrate-references-20260723194250`: 10 cookbook moves, zero collisions, failures, no-ops, or concurrent changes.
- Full reference run `phase3-migrate-references-20260723194436`: 50 meal-plan updates and 44 additional cookbook moves; zero collisions, failed mappings, or concurrent changes. Together with the canary, all 50 auto-mappable meal-plan references and all 54 auto-mappable cookbook references were migrated. The 116 pre-existing orphans remained unchanged.
- Reconciliation `phase3-reconcile-20260723194605`: all 27,656 legacy recipes were durable no-ops, with zero recipe, mapping, or target data writes, zero failures, and zero concurrent changes. The complete collection scan checked 55,313 recipe documents.
- Post-reconciliation reference rerun `phase3-migrate-references-20260723202333`: 104 canonical-reference no-ops and 116 unchanged orphans; zero updates, moves, collisions, failures, or concurrent changes. This advanced the reference checkpoint after recipe reconciliation.
- Terminal verifier `phase3-verify-20260723202531`: 27,656 mappings, 55,313 total recipe documents, generation mode `legacy`, checkpoint epoch 1 and stage `complete`, with completed stages `recipes`, `meal-plans`, and `cookbooks`.
- Final zero-write inventory `phase3-dry-run-20260723202700`: 27,656 legacy recipes, 27,657 v2 documents, 10,978 ready and 16,678 review outcomes, zero conversion failures, zero remaining auto-mappable reference changes, and 116 unchanged orphans. The final legacy ID hash remained `d039e8b97b966b0ce22b4c18824ad26e5518ac7fe8afbf127dc665c8e12da518`.
- Scheduler state before and after every accelerated operation remained `PAUSED`; generation mode remained `legacy`. The production generator was not changed or activated for catalogue selection.

Do not include household IDs, document paths, recipe IDs, source URLs, or other personal data.
