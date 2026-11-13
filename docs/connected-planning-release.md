# Connected planning release

## Implementation

The new client routes are Plan, Generate, Shopping, and Cookbook. Profile and household preferences remain reachable from the header. The prior screen implementations are retained as named legacy exports; normal navigation uses `components/connected`.

The backend owns plan changes, revision checks, confirmation receipts, draft storage, shopping periods, and ingredient reconciliation. Household membership is checked on every command. A successful meal mutation leaves recoverable reconciliation work; the client distinguishes pending, ready, and retry-needed states. Confirmed drafts are deleted only when reconciliation completes successfully.

Shopping quantities represent recipe requirements. There is no pantry inventory, purchase-size estimate, stock deduction, or inference about food remaining. Contributions identify the cooking occasion and recipe. Manual items and purchased checks survive reconciliation. Increased checked requirements need explicit review; trip dismissals survive until their quantities change. Incompatible units remain separate.

Generation saves each successful, failed, or unmatched slot independently. Keep locks a slot; Remove omits it from confirmation. Presets present editable dates and preferences before generating. Favourite counts default to zero. Household exclusions are distinct from optional preferences and remain in effect. Catalogue and legacy generation retain the operator-controlled boundary, with no cross-engine fallback. Catalogue ranking preserves source weights and softly considers ingredient overlap, repeated proteins, and cooking feedback.

Leftovers use an explicit earlier cooking occasion and reserved portions; their ingredients are counted at that source once. Invalid, excessive, or broken allocations are rejected rather than silently reassigned. Meal-specific substitutions preserve original recipes and carry a serving basis for later resizing. The current substitution provider returns explanations without numerical conversions, so applying a substitution requires manual quantity entry.

Cooking stores step progress, ingredient checks, and absolute timer deadlines locally per household/user/occasion/recipe. Timers work even without notification permission. Keep-awake applies only while the cooking screen is focused and active, using [Expo SDK 54 KeepAwake](https://docs.expo.dev/versions/v54.0.0/sdk/keep-awake/). Source instructions remain unchanged. Completion and optional feedback are shared online.

Cookbook supports add-to-plan, multi-field search, filters, household notes/collections, cooking history, trusted-URL import with attribution/preview, and week templates. The active shopping data and planned recipe text are cached locally; explicit shopping changes use a persistent queue with request IDs and revision checks. Plan mutation and generation remain online operations.

## Migration and rollout order

Backend deployment completed in `meal-wizard-ad202`: all four workflow/selection functions and the Firestore rules are live. The reconciliation trigger was separately verified as `ACTIVE` with Firestore document-written events and `RETRY_POLICY_RETRY`. Its initial Eventarc permission-propagation delay was resolved by retrying after the service-agent binding became available. No production household migration was manually initiated.

On 6 September, the user authorised Android deployment. Version 1.1.0 (version code 18) built successfully on EAS using the production profile and existing signing credentials. Both EAS build and submission report `FINISHED` without errors. Following the user's instruction to always proceed through release, build 18 was promoted from draft to `completed` on the Google Play internal track. A separate read of Google's release lifecycle API confirmed `RELEASE_LIFECYCLE_STATE_PUBLISHED` with active artifact version code 18.

The user's standing release preference is to complete releases on the configured distribution track, rather than stop at a draft or ask again for routine release approval. `eas.json` now uses `releaseStatus: completed` for future internal-track submissions. This release is for internal testers; the public production track was not changed.

- [Android build](https://expo.dev/accounts/darcycorbett/projects/meal-wizard/builds/8c7557bd-a0b8-4dc9-8a19-f53b54b037c9)
- [Google Play submission](https://expo.dev/accounts/darcycorbett/projects/meal-wizard/submissions/e3607dbc-cbd5-44ac-8f76-46e9608fd596)

1. Deploy `connectedCommand`, `importConnectedRecipe`, `reconcileConnectedShopping`, and the backwards-compatible `selectCatalogueRecipes` update.
2. Deploy `firestore.rules`. Existing households remain writable by legacy clients until their root `workflowVersion` changes to 2. Upgraded households permit plan and shopping writes only through server operations.
3. Build and validate the new Android client before distributing it. `app.json` uses version/runtime 1.1.0 because native dependencies changed; do not publish this code as a 1.0.0 OTA update.
4. Opening the updated household experience performs an atomic initial archive and migration. Outstanding manual items and purchases are retained. Ambiguous generated legacy rows remain explicitly marked for review. Pending legacy generation results are copied into drafts.

Do not restore the legacy direct-write path for an upgraded household: it would bypass reconciliation. Keep the archive and workflow receipts when diagnosing or recovering a household.

## Verification performed on 6 September 2026

| Check | Result |
| --- | --- |
| Client tests | 275 passed; one existing skipped test |
| Function tests | 637 passed |
| Firestore emulator rules | 43 passed, including upgraded-household gating |
| Client TypeScript | Passed |
| Functions TypeScript/build | Passed |
| Lint | No errors; warnings remain in retained screens and hook dependencies |
| Client secret scan | Passed |
| Android production Hermes bundle | Passed; output in `artifacts/connected-android-export` |
| Signed Android production AAB | EAS build 18 finished successfully; version/runtime 1.1.0 |
| Google Play release | Internal track published; version code 18 confirmed by release lifecycle API |
| Two-user real-emulator integration | Passed |
| Browser at 360 × 800, dark theme | Plan, main-plus-side saving, reconciliation, shopping, cooking checked |
| Cooking reload | Step, checked ingredient, and running timer restored |

The emulator integration used two independently authenticated users. It verified stale partner edits, stale queued shopping changes, duplicate confirmation, quantity review, manual preservation, obsolete purchases, four-success draft persistence and confirmation, and repeated reconciliation. These checks used a `demo-` project and synthetic recipes, not production household data.

## Remaining release validation

- Android device/emulator installation, small-screen layout, enlarged system text, light/dark themes, native timer notifications and keep-awake behavior.
- Full offline/reconnect device walkthrough with two household sessions.
- Live trusted-source import and generation smoke checks against the operator-selected production catalogue.

No Android device was connected, and no Android virtual device was installed during this run. Successful Hermes export and native compilation are build checks, not proof of native device behavior. The Android client is published to internal testers under the user's release authorization; the device validation above remains outstanding.

## UI restoration — 7 September 2026

The user requested the original visual design back while retaining the connected features. Calendar again uses the original carousel/day-card styles and a month grid, including recipe thumbnails, pastel nutrition badges, and compact meal rows. Generate again uses the original headline, emoji/pastel preference tiles, pill controls, serving counters, and recipe cards. Shopping again uses compact paired cards with checkboxes and recipe-source chips; large-text layouts use one column. Extra controls live in sheets and visible icon menus.

The server-controlled workflow, revision checks, drafts, recipe enrichment, cooking, substitutions, leftovers, templates, trip history, quantity review, and offline shopping queue remain connected. Bulk purchase actions cannot silently resolve items awaiting quantity review.

Validation: 275 client tests passed (one existing skip), TypeScript passed, lint had no errors and 20 retained warnings, and the two-authenticated-user emulator integration passed. Browser checks at 360 × 800 covered the light-mode calendar carousel/month grid, shopping checkoffs and trip sheet, saved partial draft review, and dark-mode generation form. No browser errors were reported. Native enlarged-text and device validation remain unverified.

Published successfully as an Android EAS Update on branch/channel `production`, runtime `1.1.0`, for the installed build 18. The production Hermes export passed. Update group: `17e1cedf-0935-42ca-ada3-b9f439be40b1`; Android update: `01a07a10-523a-75b9-83e0-b5f180eb2814`. [Release dashboard](https://expo.dev/accounts/darcycorbett/projects/meal-wizard/updates/17e1cedf-0935-42ca-ada3-b9f439be40b1). This presentation update requires no new native dependency or household migration.

## Reproduce isolated integration checks

```powershell
npx firebase emulators:start --only "auth,firestore,functions" --project demo-meal-wizard-rules
```

In another terminal:

```powershell
node scripts/seedConnectedEmulator.mjs
node scripts/verifyConnectedEmulator.mjs
$env:EXPO_PUBLIC_USE_EMULATORS='true'
$env:EXPO_OFFLINE='1'
npx expo start --web --port 8082
```

The seed script prints its synthetic test-user credentials. Emulator mode is restricted to development builds and uses `demo-meal-wizard-rules`; production Firebase configuration is not used in that mode. Tests leave their isolated fixture households available for inspection.


## Lightweight refinement — 8 September 2026

Published to the existing Android production channel and runtime 1.1.0, compatible with installed build 18. Update group: `14891f30-0b2b-409f-a5db-f95500c9e6a4`; Android update: `01a07f59-ff1c-7d6c-ae0f-e0f466b98c58`. [Release dashboard](https://expo.dev/accounts/darcycorbett/projects/meal-wizard/updates/14891f30-0b2b-409f-a5db-f95500c9e6a4).

Add/Edit/Swap and connected sheets now use a common sliding drawer with swipe-down, close, reduced-motion support and Android back handling. Calendar cards share the tallest day's measured content height, capped by the viewport; the add button is in the header. Generation shortcuts and Skip were removed from Plan, with Restore retained for existing skipped meals. Generate uses compact symmetric modifier/cuisine grids, including a neutral Any cuisine tile; presets sit under Plan Details. Narrow screens use two cuisine columns to avoid splitting Mediterranean mid-word. Shopping removes the extra ellipsis row, reduces recipe chips, and retains detail access through the ingredient name/quantity and existing review controls.

Recipe summaries are hidden; grouped ingredients use two columns with a large-text fallback. Start cooking sits beside Instructions and opens a nested step drawer. Explicit name matching preserves separate grouped ingredient occurrences and scaled, meal-specific substitutions. Back/Next remain aligned in the footer; Done closes without writing completion. Cooking history and optional feedback are available through Recipe options. Timers sit under the instruction, use stable identities, show reset controls, retain deadlines across reload, and update their displayed countdown explicitly with the current time. Old timer records remain accessible inline. Long-press substitutions retain an explicit quantity preview and revision-checked meal-only application. Side recipe views and their serving changes remain separate from main servings.

Validation:
- 284 client tests passed; one pre-existing skipped test. Includes both generation modes, grouped duplicate ingredients, conservative matching, substitution scaling and timer idempotency/reset/deadline tests.
- 637 function tests and 43 Firestore emulator rules tests passed; TypeScript, function build and client secret scan passed. Lint reports zero errors and 20 retained warnings.
- Production Android Hermes export succeeded in `artifacts/lightweight-android-export`.
- Isolated two-user emulator integration passed: duplicate confirmation, concurrent edits, quantity review, manual preservation, obsolete purchases, stale offline checks, four-success draft recovery and reconciliation retry.
- Browser walkthroughs passed at 320, 360 and 420px: equal compact cards, nested date-picker state retention, swipe dismissal, dark Swap surfaces, symmetric cuisine grids and Any cuisine preserving modifiers. Light/dark recipe and shopping screenshots reviewed.
- Cooking reload retained the step and exact timer deadline; reset removed the timer; countdown visibly decreased; Done left the meal planned. Offline shopping checkbox changes showed pending sync and reconciled on reconnect.
- Side-recipe serving changes updated only the side. A locally stubbed substitution walkthrough applied Sauce carrots occurrence 1 without changing Main carrots or the source recipe; no paid substitution request was made in this test.

No Android device or AVD was available. Native swipe/back, system enlarged text, keep-awake and notification delivery remain unverified on a device. Browser checks and Hermes compilation do not replace those checks. No backend schema changes, native dependencies or migration were needed for this release.
`https://u.expo.dev` returned HTTP 200 for the Android production channel and runtime 1.1.0, serving update `01a07f59-ff1c-7d6c-ae0f-e0f466b98c58` after publication.
