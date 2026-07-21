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
- Reference canary and full-run counts (updated, merged, orphan, failed):
- Reconciliation and idempotency results:
- Final recipe/mapping counts and checkpoint stage:

Do not include household IDs, document paths, recipe IDs, source URLs, or other personal data.
