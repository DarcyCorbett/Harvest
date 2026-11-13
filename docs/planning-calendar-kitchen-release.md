# Planning, calendar and kitchen enhancements

Implementation and verification record, 16 September 2026.

## Current status

The four feature stages are implemented locally. The updated `connectedCommand` and new `browseCatalogueRecipes` functions were deployed successfully to `meal-wizard-ad202` in `europe-west1` on 16 September 2026 after explicit user approval. Client publication and the native acceptance checklist below remain outstanding.

| Area | Implemented behavior |
| --- | --- |
| Shopping | Distinct recipe pills, direct previews, ingredient contribution details, local Monday–Sunday presets, explicit update/new trip actions, discarded unapplied date edits |
| Cookbook | Image/title detail access, independent pending favourites, transactional creation/starring preserving metadata, Notes with Save/Cancel, collection UI removed without deleting stored collections |
| Planning | UUID additions, preserved legacy identities, custom labels, stable moves/swaps, new IDs for copies, revision/receipt checks, transactional leftover validation |
| Generation/templates | Explicit Add/Replace review, specific replacement targets, source-ID mapping, legacy draft conversion, active date/type gap checks, maximum 62 changes per mutation |
| Discovery | Saved/Discover picker, ingredient/meal type/cuisine filters, bounded scanning and cursors, household exclusions/source preferences, preview/use, Surprise Me and session rejection tracking |
| Nutrition | Optional adult/child target slots from default counts, reusable inactive slots, combined household goals, servings/sides/leftover-day totals, missing/estimated indicators |
| Calendar gestures | Week long-press, seven labelled date targets, occupied-day additions, cancellation and pending placement; ordinary Move to date retained |

Retries in review and the meal editor preserve the exact submitted changes and request ID. A leftover retry does not rebuild its source update from a newer subscription snapshot after an uncertain response.

Nutrition represents planned portions, not consumption. Source meal servings exclude separately reserved extras; leftovers count on their eating date. Leftovers from a substituted source carry the estimated indicator. No recommendations or person profiles are introduced.

## Completed checks

| Check | Actual result |
| --- | --- |
| `npm test` | 70 files passed; 983 tests passed, 1 existing skipped |
| Firestore rules suite | 46 passed |
| `npx tsc --noEmit` | Passed |
| `npm run build:functions` | Passed |
| Client secret scan | Clean, 6 targets |
| Targeted lint for new helpers/components and ClassicCalendar | Passed |
| `npm run lint` | Failed: 52 existing React-hook errors; `artifacts/planning-expo-lint.txt` |
| Production Android Hermes export | Passed; `artifacts/planning-android-export` |
| Existing two-user emulator workflow | Passed |
| New planning/discovery emulator workflow | Passed |
| Production indexes, read-only inspection | Required ingredient-token and selection-key indexes present |
| Backend deployment prechecks | 675 function tests passed; functions build passed |
| Production callable smoke checks | Both deployed endpoints rejected empty requests with HTTP 400 / `INVALID_ARGUMENT`; no household data changed |

Lint failures include retained ref-during-render and synchronous effect state patterns in recipe details, drawers, generation/planning screens, settings, job notifications and invitation UI. Targeted lint does not replace a passing full run.

The new emulator workflow checks simultaneous additions, legacy IDs, atomic planning-version activation, version-2 shopping, stable moves, duplicate receipts, stale replacements, invalid leftover moves, purchase preservation and discovery pagination/exclusions/ready-only filtering. Integration data is synthetic and scoped to `demo-meal-wizard-rules`.

Browser checks completed locally:

- Add two independently labelled dinners to one date.
- Display household portions and missing-nutrition indicators.
- Open a recipe directly from a shopping pill.
- Select Next 2 Weeks across September/October; close without applying and retain trip dates.
- Cancel notes and reopen without the discarded text.
- At 360px width, show four adult slots and one child slot, save synthetic inputs and verify their combined 9,500 kcal / 450g protein calendar goal.
- Discover by ingredient/cuisine, append another page, preview/use a canonical recipe and save it as a meal.
- Retain continuation after an empty filtered scan page.
- Surprise Me shows nutrition, Try another returns a different recipe, and cancelling the picker/editor leaves the plan empty.
- Save/reuse a template, show Add/Replace choices and apply a named replacement.

## Remaining acceptance checks

- Native long-press, scrolling before activation, seven date targets, outside-target cancellation, failed/conflicting move recovery, and accessible Move to date.
- Native enlarged system text and both themes across changed screens.
- Full two-device offline/reconnect walkthrough, cached Saved browsing and preserved shopping checks.
- Remaining negative UI paths: unavailable historical recipes, failed note/favourite saves, dismissal during picker responses, and concurrent replacement edits.
- Resolve or explicitly account for the full-lint baseline before declaring every release gate green.

No native acceptance is claimed from Hermes export. Browser/backend checks do not establish native gesture behavior.

## Backend-first rollout

1. **Completed:** deployed updated `connectedCommand` and new `browseCatalogueRecipes` in `europe-west1` to `meal-wizard-ad202` after explicit approval. Firebase reported a successful update and creation respectively. The earlier rejected attempt did not execute.
2. Verify callable contracts. Discovery uses existing indexes: equality on `schemaVersion`, `status`, `source.key`, one array constraint on `search.ingredientTokens` or `search.selectionKeys`, then `search.randomKey` and document ID ordering. No additional index definition is needed.
3. Complete native checks and publish the compatible client after the backend is ready.
4. Verify a version-3 planning write atomically records `minPlanningClientVersion: 3`. Older plan/draft writes must show the update-required message; compatible shopping remains accepted.

Activation occurs inside a successful planning transaction. Backend deployment alone does not activate every household. Existing meals, cookbook collections and templates are retained. Receipt replay returns the accepted result without repeating the mutation.

Rollback must retain a backend that understands stable IDs and the planning-version gate. Do not restore date/type-derived identities after activation. Activated households also require a stable-ID-capable client rollback build.

## Reproduce local validation

Run rules tests before seeding acceptance fixtures: that suite clears emulator data and must not run concurrently with a browser walkthrough using the same project.

```powershell
npm run build:functions
npx firebase emulators:start --only auth,firestore,functions --project demo-meal-wizard-rules
```

In another terminal:

```powershell
$env:FIRESTORE_EMULATOR_HOST='127.0.0.1:8080'
npm run test:rules:vitest
node scripts/seedConnectedEmulator.mjs
node scripts/verifyConnectedEmulator.mjs
node scripts/verifyPlanningEnhancementsEmulator.mjs
$env:EXPO_PUBLIC_USE_EMULATORS='true'
$env:EXPO_OFFLINE='1'
npx expo start --web --port 8082
```

The seed script prints synthetic credentials. Production export must set `EXPO_PUBLIC_USE_EMULATORS=false`; emulator use is also guarded by development mode.

## Production publication — 20 September 2026

- Published Android runtime 1.2.0 to the EAS `production` branch. Update group: `698c04c2-e655-478e-a38e-2e8be910c67a`.
- Completed signed Android production build 23 with fingerprint `312919397dbda0fce1fcbca88ab9e3535980da3c`. Build: `55f967bd-fff2-466b-84c4-b70b998b2893`.
- Automatic Google Play submission `b26842fb-ec8c-41f9-a051-f49e61eebef5` targeted the internal track with completed release status. Google's release lifecycle API confirmed version code 23 as `RELEASE_LIFECYCLE_STATE_PUBLISHED` with the artifact active on `internal`.
