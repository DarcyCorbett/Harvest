# Final catalogue release evidence

Status: implementation and dormant production rollout complete. Catalogue
cutover remains pending the final reconciliation, installation of the updated
native app on the intended devices, and the device smoke flow.

## Reviewed implementation

- Plan commit: `2218a90`.
- Mobile and backend integration commit: `e0ed29c`.
- Bounded required-ingredient selector and index commit: `cb260e3`.
- Weighted source-batch selector commit: `2e8c400`.
- Projected-field selector commit: `f616df4`.
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

- Final local gate passed on 2026-07-25.
- 494 Functions tests passed across 23 files.
- 207 client tests passed, with one existing conditional test skipped.
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

## Final safety state and remaining cutover gate

- Cloud Scheduler: `PAUSED`.
- Generation mode: `legacy`.
- Legacy generation and `/recipeIndex` remain available as rollback
  facilities.
- Phase 4 stored-content classification may continue manually on later Pacific
  quota days; full classifier-version coverage is not a cutover prerequisite.
- Immediately before cutover, run the final Phase 3 reconciliation and
  reference pass, then classify any newly migrated schema-v2 recipes.
- Install the updated app on the intended devices, explicitly set mode to
  `catalogue`, and smoke-test generation, one-meal regeneration, recipe
  display, confirmation, calendar, cookbook, shopping list, and reminders.
- If the device smoke flow fails, explicitly restore mode to `legacy`. Do not
  delete catalogue data or reverse migrated references.

This document intentionally excludes household IDs, document paths, recipe
IDs, source URLs, recipe content, and other personal data.
