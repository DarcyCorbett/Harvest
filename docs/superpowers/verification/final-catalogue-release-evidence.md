# Final catalogue release evidence

Status: implementation, complete-catalogue snapshot, Gemini tagging, weekly
maintenance validation, and final production reconciliation are complete.
Catalogue cutover remains pending installation of the updated native app on
the intended devices and the device smoke flow.

## Reviewed implementation

- Plan commit: `2218a90`.
- Mobile and backend integration commit: `e0ed29c`.
- Bounded required-ingredient selector and index commit: `cb260e3`.
- Weighted source-batch selector commit: `2e8c400`.
- Projected-field selector commit: `f616df4`.
- Complete-snapshot targeting commit: `b0761b0`.
- Complete Gemini batch collection fixes: `e903b04` and `dd3e390`.
- Weekly discovery-failure isolation commit: `acf0047`.
- The central mobile decoder supports legacy recipes and schema-v2 `ready` or
  `review` recipes while rejecting operational schema-v2 records.
- Catalogue generation uses the existing `selectCatalogueRecipes` callable,
  validates its response, aborts a partial plan on any no-match result, and has
  no scraper, recipe-site, Gemini-tagger, or automatic legacy fallback path.
- The generate screen maps its existing controls to structured catalogue
  slots, including normalized must/prefer/exclude ingredients, cuisine
  rotation, time limits, modifiers, and household kid-friendly exclusions.
- The manual Phase 4 runner now permits either valid generation mode but
  requires that mode to be unchanged after every command. Scheduler must remain
  paused.
- The operator mode command accepts only `legacy` or `catalogue`, reports the
  old and new values, and checks Scheduler before and after the update.

## Local verification

- Final local gate passed again on 2026-08-07.
- 528 Functions tests passed across 27 files.
- 214 client tests passed, with one platform-conditional test skipped.
- 41 Firestore Rules emulator tests passed.
- Functions and client TypeScript builds passed.
- Lint completed with warnings only and no errors.
- Client-secret scan and final static safety assertions passed.
- Static checks confirm that catalogue mode cannot call the legacy generator,
  scraper, Gemini tagger, or legacy recipe-save bridge, and that the
  implementation does not activate Scheduler or delete legacy data.

## Dormant production rollout

- The Functions backend was deployed while generation mode was `legacy`.
- The manual single-task ingestion job was rebuilt and deployed dormant from
  Cloud Build `62115b26-7d38-4575-a937-fb481cfe895f`.
- Deployed ingestion image digest:
  `sha256:9c460f46707665ed0d7def4c7321c90463279fc5e9f8c461be7694a6b161fc1f`.
- The required-ingredient Firestore composite index reached `READY` before
  selector code that depends on it was deployed.
- The deployed `selectCatalogueRecipes` function is `ACTIVE`, uses Node.js 22,
  and reported update time `2026-07-24T22:08:30.894772748Z`.
- The final selector reads only the small fields required for selection,
  searches sources in weighted random batches, and keeps no-match diagnostics
  bounded.

## Sanitized production selector matrix

- Matrix mode: `legacy`; the catalogue path remained dormant to users.
- Cases: 20.
- Selected outcomes: 20.
- Broad breakfast, lunch, dinner, and side cases passed.
- Five visible cuisines, four visible modifiers, 30/45-minute limits, preferred
  ingredients, required ingredients, and excluded ingredients passed.
- Duplicate and 28-day recent-use exclusions passed.
- The intentional impossible request returned a bounded required-ingredient
  relaxation.
- Every selection resolved to an existing, valid schema-v2 `ready` recipe and
  satisfied its hard constraints.
- Selector p95: 488 ms.
- Firestore writes: 0.
- External recipe-site requests: 0.
- No recipe IDs, URLs, household data, or content were emitted.

## Complete catalogue snapshot and Gemini tagging

- Final snapshot verification reported 55,367 canonical inventory entries:
  53,012 displayable recipes and 2,355 documented terminal outcomes.
- Retryable, structurally incomplete, and unaccounted counts were all zero;
  snapshot completeness was `true`.
- All 34,601 recipes in the frozen initial AI-required inventory were tagged
  through sequential Gemini file-batch shards.
- The final collection wrote the last 1,629 deferred results with zero failed
  or invalid responses and zero remaining shards.
- Final backlog verification reported zero recipes, zero shards, zero tokens,
  and zero estimated cost.

## Weekly maintenance validation

- The production ingestion image includes bounded source-discovery failure
  isolation for weekly runs; a source that fails discovery is excluded from
  that run and cannot advance its baseline.
- The first corrected weekly execution completed successfully: 23 new URLs
  discovered, 22 fetched, 21 parsed/classified/written, and 12 synchronously
  tagged, with zero tagging failures or overflow.
- One inaccessible sitemap was reported as a bounded discovery failure and one
  discovered non-recipe candidate remained a bounded source failure; neither
  invalidated the completed baseline.
- Cloud Scheduler is enabled for Sunday 03:00 in `Asia/Nicosia`. Its service
  account has a job-scoped custom role containing only `run.jobs.run` and
  `run.jobs.runWithOverrides`, plus the existing job invocation grant.

## Final pre-cutover reconciliation

- A fresh Firestore export completed before writes at sanitized URI
  `gs://<private-catalogue-bucket>/phase3-backups/20260807173459`.
- Reconciliation `phase3-reconcile-20260807173742` scanned 89,843 recipe
  documents. It retained 27,656 existing legacy mappings as no-ops and
  reconciled 64 late legacy recipes: 26 new canonical targets and 38 links to
  existing canonical targets.
- Reconciliation used 90 data writes and reported zero failures, concurrent
  changes, or cleanup errors.
- Reference pass `phase3-migrate-references-20260807183511` scanned 220
  references: 104 canonical no-ops and 116 unchanged pre-existing orphans,
  with zero updates, moves, collisions, failed mappings, or concurrent changes.
- Terminal verifier `phase3-verify-20260807183754` reported checkpoint epoch 2,
  stage `complete`, completed recipe/meal-plan/cookbook stages, 27,720 mappings,
  89,869 recipe documents, and generation mode `legacy`.
- Post-reconciliation tagging preparation reported zero residual recipes and
  therefore required no paid Gemini submission.

## Android verification build

- EAS verification build `40d9b1f9-f292-4f8e-88c9-9c21752c7fb2` completed
  successfully on 2026-08-07.
- Artifact profile/channel: `verify`; app version `1.0.0`; Android version code
  `15`; runtime version `1.0.0`; source commit `acf0047`.
- The signed APK is intended for direct installation and the device smoke gate,
  not for Play production submission. The EAS artifact expires on 2026-09-06.

## Final safety state and remaining cutover gate

- Cloud Scheduler: `ENABLED`, Sunday 03:00 `Asia/Nicosia`.
- Generation mode: `legacy`.
- Legacy generation and `/recipeIndex` remain available as rollback
  facilities.
- Install the Android verification build on the intended devices. While the
  mode remains `legacy`, confirm the app launches and the existing user flow is
  intact; then explicitly set mode to `catalogue` for the cutover smoke flow.
- Smoke-test generation, one-meal regeneration, recipe display, confirmation,
  calendar, cookbook, shopping list, and reminders.
- If the device smoke flow fails, explicitly restore mode to `legacy`. Do not
  delete catalogue data or reverse migrated references.
- After the device smoke gate passes, build the production AAB, submit it to
  the Play internal track as a draft, review Play Console release checks, and
  promote only after those checks are green.

This document intentionally excludes household IDs, document paths, recipe
IDs, source URLs, recipe content, and other personal data.
