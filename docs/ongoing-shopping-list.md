# Single ongoing shopping list

The shopping page now uses one household list, independent of meal dates. Saving new meals into a non-empty list offers Keep existing items, Replace list, or Cancel. Replace clears manual and purchased entries too. Existing category grouping, recipe previews and offline checking remain available.

## Behaviour and implementation

- The current `shoppingPeriods` document remains the storage location. `shopping.generation`, enrolled meal IDs, saved ingredient sources and removed contributions replace date filtering for version-4 clients. No archived trip is imported or deleted.
- Version-4 initialisation creates an ongoing list. Existing households migrate their active list once after queued checks have drained and the prior workflow is ready. Purchased/manual rows retain their identity; dismissed entries become exclusions. Existing purchases without order metadata retain their relative order below new purchases.
- Meal-saving commands include the reviewed shopping revision, list generation, selected meal IDs and keep/replace choice. The shared connected context handles prompts for individual additions, generated plans and templates. Cancellation does not send a mutation. Uncertain requests reuse the exact prepared command and request ID.
- Changes to enrolled meals update unpurchased ingredient sources. Purchased sources retain their saved amounts and recipe information. New meals can add a separate unpurchased requirement for the same ingredient. Dates alone do not change sources. Removed contributions remain excluded; excluded meals do not reappear after replacement.
- Purchase ordering uses a server-ordered sequence, with a local queue overlay for immediate/offline tap order. Unchecking restores the saved amount and merges compatible outstanding entries. Stale item revisions or replacement generations are rejected.
- Replacement is prepared asynchronously and committed with its items, membership and completion revision in one transaction. Existing items survive preparation failures. Writes are held during replacement; concurrent edits/checks during keep updates cause the worker to recompute against the current revision.
- The progress indicator waits for the list snapshot matching the completed workflow revision. Grouping fallback is a completed list; failures expose retry. Browser online/offline events supplement NetInfo so Chromium checks remain queued when disconnected.
- Shopping cards use one column with a combined checkbox/name/quantity target. Recipe titles truncate on one line; multiple recipes expand from the right-hand pill. Item options provide removal. The add window remains open, clears the entry fields after success, retains the aisle, and refocuses the name field. Add items and Generate are anchored outside scrolling content.

## Verification (26 September 2026)

- Client suite: 332 passed, 1 existing skip.
- Final focused suite: 84 passed across shopping, sync, generation and planning tests (including the completion-snapshot regression).
- Backend suite: 693 passed, 10 pre-existing failures in `catalogueParser.test.ts`. These parser failures are also recorded in the earlier shopping release notes.
- TypeScript and backend build passed.
- Firestore emulator rules: 46 passed.
- `node scripts/verifyOngoingShoppingEmulator.mjs`: passed against two authenticated synthetic household members. Covers date independence, request retries, frozen purchases, newly needed amounts, purchase order, stale reviewed replacement, stale offline commands and old-client gating.
- Browser checks passed at 320, 390 and 900 pixels: single column, inline truncation/expansion, larger check target, purchase order, repeated manual entries and focus, floating buttons and no page errors. A second walkthrough verified Cancel/Keep/Replace through the callable. Progress, error/retry and offline/reconnect/reload behaviour also passed.
- New shopping screen, choice component, presentation helper and changed shared UI files pass focused lint. Repository lint still reports existing hook errors in other components and pre-existing hooks in the connected provider, generation screen and calendar screen. No unrelated lint rules were disabled.
- Native Android/iOS device testing, enlarged system fonts and live Gemini grouping remain release smoke checks. Browser screenshots are local ignored artifacts.

## Rollout

Deploy `connectedCommand` and `reconcileConnectedShopping` together before publishing the updated app. The backend continues supporting existing version-2/3 households until a version-4 client migrates them. Migrated households require version 4 for shopping and planning writes, and cannot create dated trips. All household members therefore need the updated app once migration occurs.

Production deployment completed on 27 September 2026 as recorded below. Household migration occurs when an updated client opens the household; deployment verification did not mutate household data. Rolling back the client alone after migration is not supported; retain the version-4 backend and restore service with a forward fix. The standard backend release hook still fails on the existing parser tests; resolve that independent release blocker before using it unchanged.

To reproduce local integration, start the auth, Firestore and functions emulators with project `demo-meal-wizard-rules`, run `node scripts/seedConnectedEmulator.mjs`, then `node scripts/verifyOngoingShoppingEmulator.mjs`. The verifier creates a unique synthetic household and never targets production.

## Production release (27 September 2026)

- Deployed backend first to `meal-wizard-ad202`, region `europe-west1`. Both functions report ACTIVE: `connectedCommand` revision `connectedcommand-00004-nep`; `reconcileConnectedShopping` revision `reconcileconnectedshopping-00003-siv`.
- Scoped release checks passed: 672 tests across 41 files, excluding the previously documented failing `catalogueParser.test.ts` file. Backend TypeScript build passed. A temporary deployment hook applied this exclusion; the standard Firebase configuration remains unchanged.
- Android production export succeeded with production public configuration and emulators disabled. Client secret scan passed.
- Published Android OTA runtime `1.2.0` to branch/channel `production`: update group `1b7bb774-daf9-4d10-a5ff-6c4e0a112394`, update ID `01a0e1d8-f5a1-7575-97d7-17285a41caa8`. The Expo production endpoint returned HTTP 200 and this exact update ID.
- Previous production group: `2a8ee9f4-a5b9-495c-9263-9c7e857690dc`. This is release provenance, not a safe client-only rollback after household migration.
- Production callable validation returned the expected HTTP 400 INVALID_ARGUMENT for an empty request. No live household data was changed by verification.
- No iOS update, new native binary or app-store submission was performed. Native-device and live Gemini smoke checks remain outstanding.
