# Cookbook performance and thumbnails — 27 September 2026

The Android cookbook now uses a bounded FlatList instead of rendering every recipe inside a ScrollView. Search, filters and import controls stay in the list header. Searchable metadata and sorting are memoized; recipe cards are memoized and favourite callbacks remain stable during unrelated screen updates. Note drafts stay in screen state when rows leave the rendered window.

Cookbook thumbnails use Expo Image with disk caching. Candidates are the primary image followed by unique, nonempty saved alternate URLs. Each failed candidate advances to the next, ending with a themed restaurant-icon placeholder. Changing a recipe's sources resets the failure state. Both images and placeholders open the recipe. Saved video posters can be used when already present in image fields; the list does not create video players or fetch new posters.

No database, scraper, backend, recipe-detail media, native dependency or public data-contract changes were made. Recipe downloading is unchanged. Existing workspace changes, including the ongoing shopping release, were preserved.

## Validation

- Client tests: 339 passed, 1 existing skip across 33 files, including 7 new cookbook presentation tests.
- TypeScript passed. Focused lint passed for all changed implementation and test files. Repository lint retains 52 existing errors; before/after logs are byte-for-byte identical.
- `node scripts/verifyCookbookUi.mjs` passed using the real cookbook, React Native Web FlatList and Expo Image with 200 synthetic recipes. Backend, navigation, safe-area wrapper and icons are test adapters; recipe-detail opening uses a stub.
- Browser fixture: 4 recipe cards mounted initially and 17 after scrolling, instead of all 200. Primary success, failed-primary fallback, alternate-only video poster, exhausted candidates, placeholder opening, changed-source recovery, ingredient search, favourites, add-to-plan, note saving and draft retention across filtering/scrolling passed. No browser runtime errors or list video players.
- Production Android Hermes export and client secret scan passed. Export used the production public configuration from `eas.json`, with dotenv disabled.
- Android SDK tools were available, but no device was connected and no AVD was installed. Native-device behavior remains unverified; browser checks do not replace Android profiling.

Local ignored evidence is under `artifacts/cookbook-*`, including the browser result, export, lint comparison, release response and endpoint verification.

## Deployment

- Published Android EAS Update on channel/branch `production`, runtime `1.2.0`.
- Update group: `6ecf99b3-3c8f-4d7c-8018-195674329059`.
- Update ID: `01a0e1f8-5eee-72a6-b9f0-06c45ee51f8f`.
- [Release dashboard](https://expo.dev/accounts/darcycorbett/projects/meal-wizard/updates/6ecf99b3-3c8f-4d7c-8018-195674329059).
- Native fingerprint `312919397dbda0fce1fcbca88ab9e3535980da3c` matches the current completed production Android build, version code 24, and the prior production update.
- Production update endpoint returned HTTP 200 with this exact update ID for Android runtime `1.2.0` at 08:26 UTC on 27 September 2026.
- The validated bundle was uploaded directly with `--skip-bundler`; no backend deployment, native build, Play submission or iOS update was performed.
- Previous production group: `1b7bb774-daf9-4d10-a5ff-6c4e0a112394` (ongoing shopping release).
