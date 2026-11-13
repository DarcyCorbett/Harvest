# Shopping grouping and immediate checks

Connected shopping uses the existing Gemini shopping-group service to choose canonical ingredient names and categories. The backend validates exact source-ID coverage and retains all quantity arithmetic, conversions, recipe contributions, and purchase reconciliation in code. Incompatible units remain separate; AI-suggested units never overwrite measured units.

The shopping period stores the validated grouping with a fingerprint of source names and units. Serving-only changes reuse it. Changes to the ingredient set request a new grouping. AI errors, quota exhaustion, and invalid responses fall back to the deterministic list and show a basic-grouping notice. A later plan change retries grouping. Manual items are preserved separately. This uses the existing shopping model configuration and a household-scoped daily grouping quota.

Recipe groups are authoritative for both the card and shopping input. Original flat indices are retained only to resolve saved substitutions; unmatched flat rows do not enter the list.

Plan commands persist the pending workflow and return without waiting for Gemini. The existing Firestore workflow trigger performs reconciliation. Checkbox commands never invoke Gemini or regenerate requirements.

Checkboxes update local pending state immediately, which moves the card into Purchased. Persisting the queue and calling the backend happen in the background. The queue starts after each enqueue rather than waiting for the two-second retry timer. Successful writes remain overlaid until the period subscription observes the returned revision, preventing a stale snapshot from moving the item back. Queued writes survive offline sessions; definitive conflicts show an error. A small positioned sync icon avoids changing card height when saving finishes.

## Release

The reconciliation trigger requires the existing `GEMINI_API_KEY` secret. Existing lists receive AI grouping on the next plan/date reconciliation; checks alone do not regroup them. No production data migration was performed.

### Production deployment — 20 September 2026

- Updated `connectedCommand` and `reconcileConnectedShopping` in `meal-wizard-ad202`, region `europe-west1`. Firebase confirmed successful updates for both.
- Confirmed the trigger is ACTIVE at revision `reconcileconnectedshopping-00002-xis`, bound to version 1 of the existing `mealwizard-gemini-api-key` secret. A non-mutating malformed-request check returned HTTP 400 / `INVALID_ARGUMENT` from the callable.
- Published Android runtime 1.2.0 on EAS channel/branch `production`: update group `97ee3fb6-dde1-4c3b-a403-a7b008c87f21`, Android update `01a0bf73-4ed3-7a52-9c23-10ecfce67e1b`.
- Verified the production update endpoint returns HTTP 200 with that exact update ID for Android runtime 1.2.0.
- Prior production update group: `d6bbd96b-e78a-4736-8b04-4ddc2f5e43be`.
- Production Hermes export, client secret scans, backend build, and 655 backend tests passed during release. The scoped release hook excluded `catalogueParser.test.ts`, whose 10 previously reported failures concern unrelated parser enrichment behavior. The standard Firebase config and test suite were not changed. Existing hook-lint findings remain unresolved.
- This was an over-the-air Android release, not a new Google Play binary or iOS update. Live device/offline interaction and real Gemini grouping remain smoke-test follow-ups.

## Verification

Tests cover grouping coverage, quantity preservation, incompatible units, cached serving changes, purchase-state preservation, grouped recipe substitutions, AI failure fallback, asynchronous command acknowledgement, queued taps, transient retries, and household changes. Provider responses are mocked; live Gemini behavior and device animation timings need a deployed smoke test.

Manual smoke test: check several items quickly; each should immediately move to Purchased once, remain there through synchronization, and match a second household device. Repeat offline and reconnect. Change servings and verify totals plus purchase-review flags; add a recipe with different wording and verify AI grouping and source recipe links.
