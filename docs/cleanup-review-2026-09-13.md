# Codebase cleanup review — 13 September 2026

## Applied cleanup

The user authorized the source cleanup after this review. **22 files were deleted**, the four tab files now contain only their existing default re-exports, and the three unused Firestore functions plus `GeneratorConfig` were removed. The starter reset command/README section and two unused imports were also removed. The net reduction across changed/deleted implementation, test, and README files is approximately **6,000 lines**, excluding this report.

The three obsolete screen-source assertions were retired. Connected command-handler tests now verify that rejected household authorization leaves records untouched, explicit meal removal preserves shared recipes and cookbook references, and missing recipes do not cause plan/cookbook reference deletion. The existing legacy history-helper unit tests remain, clearly labeled as legacy, with `services/recipeAvailability.ts` retained pending a separate retirement of that test-only code.

Validation after cleanup:

| Check | Result |
| --- | --- |
| Client tests | 286 passed; 1 existing skip |
| Functions tests | 667 passed |
| Client and Functions TypeScript | Both passed |
| Expo lint | No errors or warnings; previously 19 warnings |
| Client secret scan | Passed |
| Web production export | Passed |
| Android Hermes production export | Passed |

The initial combined export could not execute Hermes inside the sandbox. The Android export succeeded on retry with the necessary local execution permission; web export also succeeded separately. Export output is in the system temporary directory. No native device walkthrough, Firestore emulator run, or deployment was performed.

Dependencies, reminder scheduling, legacy recipe services, operational scripts, historical snapshots, and existing build/evaluation artifacts were preserved. Pre-cleanup copies of changed/deleted files were saved under `C:\Users\User\AppData\Local\Temp\mealwizard-cleanup-before-pQn6FV`. Existing unrelated working-tree changes were preserved; no commit or deployment was made.

The remainder of this document is the **original review**, with paths and line numbers as they existed before cleanup. Its sections 1 and 2 are now applied except for the explicitly deferred `recipeAvailability.ts` retirement. Sections 3–5 remain recommendations for later consideration.

---

The strongest cleanup opportunity is the retained old tab implementations, followed by unused Expo starter files. Roughly **5,800 lines of source** can be removed by simplifying four routes and deleting their three exclusive UI dependencies plus the starter cluster. This is a source-maintenance estimate, not a measured bundle-size reduction.

The original review covered the **working tree at review time**, including uncommitted and untracked connected-workflow changes. It did not establish what every installed app version or production job uses. No app source, dependencies, databases, or deployment configuration were changed during the review itself; the subsequently authorized implementation is recorded above.

## 1. High-confidence standalone cleanup

### Unused starter components and helpers: 10 files

Delete these together. A TypeScript AST import/re-export/require scan found no path from app routes, backend entrypoints, tests, or operational scripts into this cluster. Some reference one another, which can make a simple “does anything import this file?” search misleading.

```text
components/external-link.tsx
components/haptic-tab.tsx
components/hello-wave.tsx
components/parallax-scroll-view.tsx
components/themed-text.tsx
components/themed-view.tsx
components/ui/collapsible.tsx
components/ui/icon-symbol.tsx
components/ui/icon-symbol.ios.tsx
hooks/use-theme-color.ts
```

Keep `hooks/use-color-scheme.ts`: active screens still use it. Keep the app's actual theme provider and constants.

### Exact duplicate web hook

`hooks/use-color-scheme.web.ts` is byte-for-byte identical to `hooks/use-color-scheme.ts`. Remove the web-specific file and let resolution use the common implementation. Both return `useTheme().effectiveScheme`; there is no web-specific behavior to preserve.

### Unreferenced starter images: 7 files

```text
assets/images/react-logo.png
assets/images/react-logo@2x.png
assets/images/react-logo@3x.png
assets/images/partial-react-logo.png
assets/images/android-icon-background.png
assets/images/android-icon-foreground.png
assets/images/android-icon-monochrome.png
```

No references were found in maintained application code, plugins, scripts, or configuration. `app.json` uses `icon.png` for the adaptive foreground, a background color, `favicon.png` for web, and `splash-icon.png` for splash. Keep those three configured images. The seven candidates total approximately 144 KiB.

### Unused declarations

These names occur only at their declaration across the scanned JavaScript/TypeScript source, including tests and scripts:

| File | Declaration | Current line |
| --- | --- | ---: |
| `services/firestoreService.ts` | `updateRecipeCourse` | 198 |
| `services/firestoreService.ts` | `getMealPlan` | 283 |
| `services/firestoreService.ts` | `clearAllShoppingItems` | 429 |
| `services/types.ts` | `GeneratorConfig` | 231 |

Delete those declarations, then let typechecking/lint identify any newly unused imports. Do not confuse `GeneratorConfig` with the used `GenerateConfig`, or remove `addShoppingItem`: it has an internal caller in `addManualItem` even though no other file imports it.

### Starter reset utility and documentation

Remove `scripts/reset-project.js`, the `reset-project` package script, and the README's “Get a fresh project” section together. This utility resets application directories to an Expo starter; it is not part of app operation. Do not run it as a cleanup command. The remaining README is also largely starter documentation and should eventually describe the real app.

## 2. Biggest cleanup: retain the routes, remove their old implementations

Each of these files already re-exports a connected screen as its default. Its named legacy component has no callers anywhere in application, test, or script source.

| Route file | Current default-export line | Keep only this content | Approximate existing lines |
| --- | ---: | --- | ---: |
| `app/(tabs)/index.tsx` | 137 | `export { default } from '@/components/connected/PlanScreen';` | 901 |
| `app/(tabs)/generate.tsx` | 121 | `export { default } from '@/components/connected/GenerateScreen';` | 1,756 |
| `app/(tabs)/shopping.tsx` | 107 | `export { default } from '@/components/connected/ShoppingScreen';` | 1,292 |
| `app/(tabs)/cookbook.tsx` | 60 | `export { default } from '@/components/connected/CookbookScreen';` | 718 |

This removes approximately 4,660 lines of old screen bodies, imports, helpers, and styles without changing the default route targets. **Do not delete the route files themselves.** `docs/connected-planning-release.md` also explicitly records that normal navigation uses the connected screens and that the older implementations were retained as named exports.

After simplifying those routes, these components lose their only importers and can be deleted in the same cleanup:

| File | Only current importer | Approximate lines |
| --- | --- | ---: |
| `components/AnimatedPressable.tsx` | Old Generate screen | 54 |
| `components/DevLogTerminal.tsx` | Old Generate screen | 311 |
| `components/IngredientSubstitutionSheet.tsx` | Old Shopping screen | 451 |

Keep `components/connected/SubstitutionDrawer.tsx`, `components/RecipeDetailModal.tsx`, `components/PastelCard.tsx`, and `components/SettingsModal.tsx`: they are still reachable from active screens.

**Test work required:** `tests/dataSafety.test.ts:58` and `:72` contain source-text assertions against the old calendar/cookbook implementations. They require old handler strings and the old recipe-history wiring. Replacing the routes with re-exports will fail these assertions even though navigation continues to target the same connected components. Update coverage to exercise the active connected workflow's explicit removal, household ownership, and missing-recipe behavior. Do not simply delete all data-safety coverage.

`services/recipeAvailability.ts` becomes test-only after this cleanup. Its remaining importer is `tests/dataSafety.test.ts`. Consider retiring its 208 lines with the old history-state tests only after confirming that relevant safety cases are covered for `ConnectedContext` and the connected screens.

Seventeen of the current nineteen lint warnings are in the old Generate/Shopping implementations. The other two are unused imports (`Platform` in Profile and `useEffect` in Login).

## 3. Refactor first; these are not safe wholesale deletions

| Area | Why it looks redundant | Why it must be retained or disentangled |
| --- | --- | --- |
| `contexts/BackgroundJobsContext.tsx` and `components/JobToast.tsx` | Old generation/confirmation UI has no active screen callers | The provider is mounted in `app/_layout.tsx`. Its effect at lines 124–153 still subscribes to reminder state and schedules per-device meal reminders. It also attempts persisted-result rehydration before connected version 2 is established. Extract and preserve reminder scheduling, then assess retiring old job state and toast behavior. |
| `services/generatorService.ts`, `catalogueGenerator.ts`, `generationDispatcher.ts`, `gemini.ts` | Parallel to newer `connectedGeneration.ts` | The mounted background provider still imports the old generator. Tests and `scripts/verifyFinalCatalogueStatic.mjs` also reference these files; `firestoreService.ts` imports the generation-mode type. Retire as a coordinated follow-up after disentangling the provider. |
| `services/recipeScraperService.ts` and `services/scraper/*` | Pre-catalogue recipe discovery/parsing | The active `connectedGeneration.ts` reads the generation mode and calls `scrapeRecipe` on its legacy path. Current screens also consume filters and parsing helpers. `sitemap.ts` is operational tooling used by index-building/tagging scripts. |
| `services/legacyRecipeClient.ts` and `functions/src/callables/legacyRecipes.ts` | Explicitly named legacy | `firestoreService.ts` still delegates recipe writes to the client; `functions/src/index.ts:103–104` publishes its backend endpoints. Deleting backend exports can also affect installed older clients. |
| Client parser vs catalogue parser/unit normalization | Similar conversion and parsing code | Both have active consumers and distinct output contracts. `tests/unitNormalizationParity.test.ts` intentionally compares client/server conversion behavior. Share pure helpers with retained parity coverage if desired; do not delete either parser wholesale. |
| Migration, ingestion, backfill, enrichment, taxonomy and snapshot code | Much is not imported by the callable entrypoint | CLI roots in `functions/package.json`, Docker files, deployment scripts, and maintenance runbooks use it. An app-only reachability scan incorrectly classifies these modules as dead. Production scheduling/rollback needs were not audited. |

`components/connected/classic.tsx`, `ClassicCalendar.tsx`, and `calendarStyles.ts` are used by current connected screens. “Classic” here describes the restored appearance, not unused legacy screens.

## 4. Dependency cleanup candidates

No removal or lockfile change was performed. The following are good candidates based on local application imports and installed package manifests:

- `expo-image`: no application import found.
- `expo-auth-session`: no application import found; current sign-in uses `@react-native-google-signin/google-signin`.
- `expo-symbols`: only referenced by the unused starter icon components; remove after deleting those files.
- `expo-web-browser`: only imported by the unused `external-link.tsx`, but also explicitly registered in `app.json` and depended on by `expo-auth-session`. Evaluate/remove these together and remove the plugin entry if uninstalling it.

Validate dependency changes with lockfile regeneration, clean bundling and a native build; import absence alone is not proof about native configuration. Native dependency changes need appropriate native-build/runtime handling.

Do not infer that these are unused just because application code does not directly import them:

- `expo-constants` and `expo-linking`: declared peers of the installed Expo Router.
- `expo-font`: configured plugin and used through the font-loading package.
- `expo-updates`: configured update URL and runtime policy in `app.json`.
- `expo-system-ui`: retain while validating the app's configured appearance behavior.
- `react-native-worklets`: peer of the installed Reanimated.
- `react-dom`, `react-native-web`, and `react-native-web-webview`: web rendering/video support; the last is a peer of the installed YouTube iframe package.
- Navigation packages and `react-native-screens`: navigation infrastructure. Bottom tabs/elements remain transitive navigation dependencies even after the unused haptic tab component is removed, so removing their direct declarations is not the same as eliminating those packages.
- The separate root and Functions manifests/lockfiles: these serve different install/deployment boundaries.

## 5. Files that can be archived without changing runtime behavior

- Historical snapshot subfolders `baseline`, `post-plugin-aware`, `post-refactor`, `post-video`, `post-video-fallbacks`, and `wip-newsites`: 69 JSON files, approximately 405 KiB. No current code reads these historical subfolders. Keep any before/after evidence you still want. **Keep the root snapshot JSONs**: `scripts/evaluate-shopping-list.ts` names specific files and `scripts/test-tagger.ts` reads that directory.
- Generated `dist/`: approximately 20.5 MiB locally. Regenerable when no local preview/consumer needs it. `firebase.json` has no hosting deployment configured here.
- Generated Android export folders under `artifacts/`: approximately 31.2 MiB combined for `connected-android-export`, `lightweight-android-export`, and `admin-invites-android-export`. They are ignored build outputs, not redundant tracked source. Retain any release evidence still needed.
- Local `scratch*.js`, `fix2.js`, and logs: not application dependencies. Archive/discard when no longer useful and logs are no longer in use. This only reclaims roughly half a MiB here.
- Old plans and task JSONs: documentation/history, not app bundle content. Archive selectively rather than deleting all docs: `tests/phase2PilotScripts.test.ts:129` actually reads a runbook, and current deployment/recovery procedures remain useful.

Do not blanket-delete `artifacts/`: tagging/meal-type evaluations and the production taxonomy transition report are evidence that may be expensive or impossible to recreate exactly. Do not treat `.worktrees`, generated native projects, credentials, `.env`, or signing/configuration assets as confirmed redundant. `plugins/withAdiRegistration.js` is registered in `app.json` and explicitly requires `assets/adi-registration.properties` during prebuild.

## Verification and limits

Performed on the unchanged application working tree:

- `npm run test:client`: 27 files passed; **289 tests passed, 1 skipped**.
- `npm run test:functions`: 39 files passed; **665 tests passed**.
- Client `tsc --noEmit`: passed.
- Functions `tsc --project functions/tsconfig.json --noEmit`: passed.
- `npm run lint`: no errors; **19 warnings**.
- AST dependency tracing, explicit source/config/script reference searches, and byte-level source duplicate checking.
- **In-memory cleanup simulation:** TypeScript passed with all ten starter files, the duplicate web hook, and the three old-screen-only components removed; all four routes replaced by their existing default re-exports; and the three unused Firestore functions plus unused type removed. No source files were changed by this simulation. `recipeAvailability.ts` was retained for its existing tests.

Baseline tests are not a post-deletion runtime guarantee. No cleaned native/web bundle, device walkthrough, Firestore emulator suite, production deployment, or production scheduling audit was performed. The old screen source assertions will require the coordinated test changes described above.

Recommended sequence: remove starter/duplicate files and unused declarations; simplify the four routes with updated connected-workflow safety coverage; remove their exclusive components; then separately evaluate background-job retirement, dependency changes, and historical tooling. Keep the connected-workflow changes together with the cleanup—the safe conclusions depend on those current changes being present.
