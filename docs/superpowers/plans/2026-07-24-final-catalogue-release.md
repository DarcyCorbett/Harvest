# Final Catalogue Release — Consolidated Phase 5+

## Summary

Replace the original Phase 5 cutover and Phase 6 maintenance with one staged final phase. Mobile integration can proceed while the remaining Phase 4 classification runs continue.

The practical cutover gate will depend on real selector coverage and end-to-end app behavior, not every protected or incomplete recipe reaching classifier version 1. After cutover, catalogue maintenance remains manual, Cloud Scheduler stays paused, and legacy generation remains available only through the operator-controlled feature flag.

Before implementation:

- Create `codex/final-catalogue-release` from the latest Phase 4 commit.
- Save this plan as `docs/superpowers/plans/2026-07-24-final-catalogue-release.md`.
- Commit the plan separately.
- Continue recording Phase 4 classification progress, but do not make full backfill completion a prerequisite for development or cutover.

## Implementation Changes

### Mobile compatibility and structured generation

- Add a central recipe-document decoder supporting both legacy documents and schema-v2 `ready`/`review` recipes. Convert v2 content, time, taxonomy, ingredients, instructions, nutrition, media, timestamps, and reminder flags into the existing mobile `Recipe` presentation shape. Operational v2 records remain unavailable.
- Use this decoder everywhere recipes are loaded so migrated cookbook, calendar, shopping-list, reminder, and generation-result references display correctly before changing generation mode.
- Mark decoded v2 recipes as catalogue recipes. Display their taxonomy metadata read-only in the existing recipe modal; do not send legacy course/tag updates to v2 documents.
- Add structured ingredient filters to `GenerateConfig`:
  - `must`, `prefer`, and `exclude`, each bounded to 20 normalized values.
  - Existing ingredient tiles populate `prefer`.
  - Replace Additional Requests free text with simple Must Include and Exclude chip/text inputs.
  - Reject overlap between `must` and `exclude`; remove redundant preferred values already present in either hard list.
- Preserve the old optional custom-instructions field internally for legacy rollback and persisted-result compatibility, but remove it from the normal catalogue UI.
- Keep current effort, cuisine, modifier, meal-type, date, and serving controls. Map Quick/Moderate to 30/45 minutes, Salad to a modifier, and selected cuisines round-robin across slots.
- When Kid Friendly is selected, append household-specific kid-friendly exclusions to the slot’s excluded ingredients.
- Retain source-weight settings. Hide or label ingredient-weight and strict-matching settings as legacy-only because catalogue selection already guarantees exact matching.

### Catalogue generation and feature flag

- Add a validated mobile adapter for the existing `selectCatalogueRecipes` callable; do not create another generation API.
- Build catalogue slots from `GenerateConfig`, pass upcoming-plan recipe IDs plus recipe IDs used during the previous 28 days, and fetch every selected recipe through the v2-compatible decoder.
- Convert selected recipes into the existing `GeneratedMeal[]` contract with calculated servings so confirmation, cookbook, calendar, shopping-list, notifications, and persisted generation results continue unchanged.
- Make `generateMealPlan` and selected-meal regeneration dispatch on `/appConfig/catalogue.generationMode`:
  - `legacy`: run the existing scraper generator.
  - `catalogue`: call the selector and never invoke scraping, recipe-site requests, Gemini tagging, or automatic legacy fallback.
  - Missing or invalid configuration: return a bounded generation error rather than guessing a mode.
- Re-read the mode for each generation or regeneration so an operator rollback takes effect without another app build.
- If any requested slot returns `no-match`, discard the partial selection and show concise relaxation suggestions. Never relax filters or scrape automatically.
- Keep Auto Fix inactive for catalogue-generated plans because selector results already satisfy their hard filters.
- Add one aggregate server log per selector request containing duration and selected/no-match counts only—no household IDs, recipe IDs, URLs, or content.

### Backfill, cutover, and maintenance

- Allow the Phase 4 classification and refresh runner to operate in either `legacy` or `catalogue` mode. It must capture the mode before execution, require the same mode afterward, and continue requiring Scheduler `PAUSED`.
- Keep Phase 3 migration/reconciliation legacy-only. Run one final reconciliation and reference pass immediately before cutover. If legacy rollback later creates recipes, repeat reconciliation before switching back to catalogue.
- Add a small operator command for explicitly setting `generationMode` to `legacy` or `catalogue`. It must display the old/new mode, verify Scheduler remains paused, and reject other values.
- Do not enable scheduled maintenance, build dashboards, add alert infrastructure, delete legacy documents, remove `/recipeIndex`, or remove the legacy bridge/generator.
- Continue stored-content classification manually under the existing 500-Gemini-call and write caps. Run refresh canaries and eligible-source refresh only when useful.
- Treat legacy retirement as an optional future cleanup, not another project phase.

## Tests and Cutover Gates

### Focused local tests

- Legacy and v2 recipe documents decode into equivalent mobile presentation data; operational v2 records are rejected.
- Migrated cookbook, meal-plan, shopping, reminder, and persisted generation-result paths resolve v2 documents.
- Generate-screen values map correctly to catalogue slots, including cuisine round-robin, 30/45-minute limits, modifiers, must/prefer/exclude ingredients, and kid-friendly exclusions.
- Callable responses are strictly validated; missing recipes, malformed responses, and partial no-match results fail safely.
- Catalogue mode never calls the scraper, Gemini tagger, or legacy recipe-save path.
- Legacy mode remains behaviorally unchanged and can still be selected by the operator flag.
- Catalogue regeneration excludes retained meals and keeps the original plan unchanged on no-match.
- Existing selector tests continue covering hard constraints, source weighting, preference boosts, duplicates, pagination, and relaxation diagnostics.
- Run focused client tests, Functions tests/build, TypeScript, rules tests, and the client-secret scan. No new exhaustive deployment suite is required.

### Practical production gate

With generation still in `legacy`:

1. Deploy the backend/client integration dormant and verify migrated v2 recipes display correctly.
2. Run the remaining desired Phase 4 classification batches opportunistically.
3. Run final Phase 3 reconciliation and reference migration.
4. Execute a sanitized production selector matrix covering:
   - Broad breakfast, lunch, dinner, and side requests.
   - The five visible cuisines.
   - Vegetarian, healthy, kid-friendly, and salad.
   - 30- and 45-minute limits.
   - Preferred, must-have, and excluded ingredients.
   - Duplicate/recent-use exclusion.
   - One intentionally impossible request with accurate relaxation advice.
5. Require every broad case to select successfully, every result to be an existing schema-v2 `ready` recipe satisfying its hard constraints, zero duplicates per request, zero external recipe-site requests, and selector p95 no greater than two seconds.
6. Install the updated app on the intended hobby-app devices, set `generationMode=catalogue`, and perform one end-to-end smoke flow: generate, regenerate one meal, inspect recipes, confirm, then verify calendar, cookbook, shopping list, and reminders.
7. Leave catalogue mode enabled if the smoke flow passes. On failure, explicitly set `generationMode=legacy`; do not alter migrated references or delete catalogue data.

Record only the local results, matrix aggregates, app smoke outcome, final mode, Scheduler state, and relevant commit/build identifiers in one sanitized final-release evidence document.

## Assumptions

- One final staged phase replaces separate Phase 5 and Phase 6.
- Practical coverage, rather than classifier-version-1 completion for every recipe, controls cutover.
- Ingredient tiles are soft preferences; Must Include and Exclude are explicit hard filters.
- Any no-match aborts the proposed plan and shows suggestions instead of returning partial or silently relaxed results.
- Scheduler remains paused indefinitely and maintenance remains operator-triggered.
- Legacy generation and `/recipeIndex` remain preserved as manual rollback facilities.
- Older app builds do not honor the new feature flag; cutover is complete only after the updated build is installed on the devices that use this hobby app.
