# Phase 4 catalogue backfill evidence

Status: in progress. Implementation, local acceptance, deployment, inventory,
classification canary, and the first capped classification batch are complete.
Further classification must wait for the next Pacific Gemini quota day.

## Local verification

- Phase 4 plan commit: `fd87e85`.
- Initial implementation commit: `6efe476`.
- Bounded-memory Firestore scan fix: `1254d4e`.
- Operator-runner argument fixes: `ab1a415` and `84c736f`.
- Verified 2026-07-24: 494 Functions tests passed across 23 files.
- Verified 2026-07-24: Functions TypeScript build passed.
- Verified 2026-07-24: 41 Firestore Rules emulator tests passed.
- Verified 2026-07-24: client-secret scan and Phase 4 static safety
  assertions passed.
- Static checks confirm that Phase 4 does not change the production generator,
  activate Scheduler, change generation mode, rewrite references, delete legacy
  recipes, or fetch recipe sites during stored-content classification.

## Production rollout

- The existing manual, single-task ingestion job was deployed dormant.
- Initial Cloud Build: `7e213cf8-ad91-44ef-9649-4faf3fda185b`; image digest
  `sha256:7d6ccbfe6407e4fec073b26333f4c1dfca063c22a616d34a00f6dfd9508eaa37`.
- The first zero-write inventory exposed an out-of-memory failure while reading
  the entire catalogue into one snapshot. It made no recipe changes. Catalogue
  scans were changed to deterministic 500-document pages and all local gates
  were rerun successfully.
- Paginated-scan Cloud Build: `718de639-3a3b-4717-a0fc-617fd964c7ce`; image
  digest
  `sha256:1fb018cde7e22f763c672a34028d921c0553e2c0a8d1b108f839f78d93a8c5ff`.
- Baseline inventory `phase4-verify-backfill-20260724184752` (execution
  `mealwizard-catalogue-ingestion-6jsbx`) completed successfully:
  27,657 schema-v2 documents, 27,655 complete recipes, 2 operational records,
  10,977 ready, 16,678 review, 0 invalid ready, and 27,655 classifier-version-0
  recipes. Parser versions were 27,653 at version 0 and 2 at version 1.
- Baseline missing metadata: 14,094 cuisine, 1,830 meal type, and 4,515 time.
- Classification canary `phase4-classify-backfill-20260724185237` (execution
  `mealwizard-catalogue-ingestion-52zjv`) completed with 25 writes, 16 Gemini
  calls, 23 ready outcomes, 2 review outcomes, and zero failures or concurrent
  changes. The command stopped at its 25-write cap.
- Post-canary verification `mealwizard-catalogue-ingestion-gv9lk` reported 25
  classifier-version-1 recipes and zero invalid ready recipes. Ready increased
  by 15 while total complete and operational document counts were unchanged.
- First normal batch `phase4-classify-backfill-20260724185632` (execution
  `mealwizard-catalogue-ingestion-c8c2b`) completed with 859 writes, 500 Gemini
  calls, 721 ready outcomes, 138 review outcomes, 12 preserved classification
  failures, and zero concurrent changes. It stopped at the Gemini provider cap.
  The bounded failure code was `classification-failed`; failed documents were
  preserved for the later `retry-failed` pass.
- Post-batch verification `mealwizard-catalogue-ingestion-j75h8` reported 884
  classifier-version-1 recipes, 26,771 remaining classifier-version-0 recipes,
  11,385 ready, 16,270 review, and zero invalid ready recipes. Missing cuisine
  decreased to 13,615 and missing meal type to 1,778; missing time remained
  4,515 as required.
- Scheduler state before and after every operation remained `PAUSED`.
  Generation mode before and after every operation remained `legacy`.

## Remaining gates

- Continue stored-content classification on subsequent Pacific quota days,
  respecting the 500-call daily Gemini cap.
- Run `retry-failed`, then an idempotency classification pass.
- Run per-source refresh canaries and refresh eligible unresolved recipes.
- Reconcile late Phase 3 legacy writes and references, classify new v2 recipes,
  and run terminal `verify-backfill`.

Do not add household IDs, document paths, recipe IDs, source URLs, recipe
content, or other personal data to this evidence.
