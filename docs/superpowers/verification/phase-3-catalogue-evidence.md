# Phase 3 catalogue migration evidence

Status: production rollout in progress; day-one recipe batch complete at the 8,000-write safety cap.

## Local verification

- Phase 3 implementation uses stored legacy data only; Gemini and recipe-site fetching are excluded by static checks.
- Legacy recipe documents are never deleted.
- Reference migration preserves meal-plan documents and merges cookbook collisions conservatively.
- Firestore operational collections are explicitly server-only.
- Verified 2026-07-21: 478 Functions tests passed across 22 files.
- Verified 2026-07-21: Functions TypeScript build passed.
- Verified 2026-07-21: 38 Firestore Rules emulator tests passed.
- Verified 2026-07-21: client-secret scan and Phase 3 static safety assertions passed.

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
- Post-execution dry-run `phase3-dry-run-20260722050224`: 27,656 legacy recipes, 8,004 v2 documents, zero conversion failures. Seven new Serious Eats legacy recipes arrived through the still-active legacy generator, producing the expected reconciliable hash `d039e8b97b966b0ce22b4c18824ad26e5518ac7fe8afbf127dc665c8e12da518`.
- Reference canary and full-run counts (updated, merged, orphan, failed):
- Reconciliation and idempotency results:
- Final recipe/mapping counts and checkpoint stage:

Do not include household IDs, document paths, recipe IDs, source URLs, or other personal data.
