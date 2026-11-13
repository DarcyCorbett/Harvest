# Shopping measurements

Implemented October 6, 2026; deployed and the active production list repaired October 8, 2026.

## Rules

- One displayed card per product within each purchase section. Compatible measurements add together; incompatible measurements remain explicit on the same card, for example `48 g + 3 tbsp`.
- Preserve source kitchen measures. Convert only known units within the same dimension; never estimate ingredient densities, head-to-clove ratios, or item weights.
- Round whole shopping counts up once after summing. Keep original scaled amounts and serving counts in the contribution details. Never round intermediate arithmetic or inflate tiny positive measurements.
- Repair explicit units and encoded range fragments before scaling. Retain range notes. Do not mistake package weights in names for package counts.
- Preserve distinct product forms, including liquid stock versus powder, cubes, or concentrate. Purchased and outstanding amounts remain separate, and later serving edits do not rewrite frozen purchases.
- Checking or removing a mixed-measure card uses a single revision-checked batch command, including the existing offline queue and retry receipts.

## Gemini

The server and operator evaluation use the same versioned prompt. Gemini supplies product identity, category, and source IDs only. The application owns quantities and conversions. Coverage validation rejects missing/duplicate sources, and deterministic product-form checks reject unsafe groupings. Notes and prompt version participate in the cache fingerprint. No additional model call is introduced.

The evaluation script defaults to an offline deterministic baseline. `--live` explicitly evaluates Gemini; offline results are not evidence of model grouping quality.

## Existing-list repair

The active-list read-only preview recovered all 58 entries with no unresolved issues. It produces 53 displayed cards while preserving every contribution and its purchased status. Examples include cauliflower `2 cups`, lemon juice `1.6 tbsp`, garlic `10 cloves`, and butter `48 g + 3 tbsp`. Powdered and liquid stock become separate products.

The repair uses saved source contributions to recover the historical serving scale. Missing or ambiguous evidence stays unchanged and is reported. Manual and legacy items are preserved. Repeated application is idempotent.

Run a fresh read-only preview:

```powershell
npx tsx scripts/repair-shopping-measurements.ts --household <household-id> --out artifacts/shopping-measurements/audit.json
```

Review that report before applying. Deploy the backend before releasing the client because grouped actions use the new optional `shoppingBatch` operation. Then apply the reviewed repair with `--apply --reviewed-hash <snapshotHash>`. The operator checks the active workflow, list and recipes again inside a transaction and stores the original list in `shoppingMeasurementBackups` before writing. A changed snapshot requires a fresh review.

## Verification

- Client suite: 339 passed, 2 skipped.
- Backend suite: 707 passed, 10 pre-existing catalogue-parser failures concerning recipe notes/metadata, as previously documented in the ongoing-shopping release notes.
- Additional package-count regression added afterward; focused measurement, decoder and parser-parity run: 44 passed.
- Backend build, application TypeScript check, and client secret scan passed.
- Scoped lint found four existing hook errors and four dependency warnings in `ConnectedContext.tsx`; the other checked shopping UI, presentation, arithmetic and formatter files passed.
- Regression coverage includes the de-identified current-week snapshot, preserved purchases, serving edits, repair idempotence, atomic stale-revision rejection, grouping safeguards, and pending batch presentation.
- Gemini live output and browser/device rendering have not been verified in this run.

## Production release — October 8, 2026

- Deployed `connectedCommand`, `reconcileConnectedShopping`, `shoppingGroups`, and `importConnectedRecipe` to `meal-wizard-ad202`, `europe-west1`; independently confirmed all four ACTIVE.
- Release checks: 339 client tests passed (2 skipped); 687 backend tests passed with the previously documented catalogue-parser file excluded by a temporary release hook. The standard Firebase configuration remains unchanged.
- Fixed two shared-module import paths caught by the Android production export. Focused measurement/parity tests (37) and application type checking passed afterward. Android Hermes export succeeded; production Firebase and Google web-client values were verified in the bundle, with no provider credentials or emulator project present.
- Published Android production runtime `1.2.0`, update group `68457485-197d-40fe-b111-bd456422dcf6`, update ID `01a11d24-c185-7526-b46d-8d18e7b1a50e`. The production Expo endpoint returned HTTP 200 serving this exact update.
- Applied the reviewed repair with snapshot hash `c016df6978422cae0bea27b6ee3470ec70b476b8e351319491f15fb6ddd3ba11`, saving the original list transactionally. All contributions and purchases are preserved: 58 old entries become 53 displayed cards. There are 59 underlying rows because stock powder was separated from liquid stock.
- Post-repair read reported `changed: false`, zero issues, and 53 cards. Local reports: `artifacts/shopping-measurements/deploy-preview.json`, `deploy-applied.json`, and `deploy-verified.json`.
- No native binary, iOS release or store submission was needed for this Android OTA release. Physical-device smoke testing remains unperformed.

## Shopping sync banner follow-up — October 8, 2026

The shopping screen suppresses the transient pending-change banner through `StatusNotice.hidePendingProgress`. Item-level saving indicators remain, along with offline/error notices. Routine checks no longer insert and remove a banner above the list. Other screens retain their existing notices.

Application TypeScript, focused lint and production Android Hermes export passed. Published Android production runtime `1.2.0`, group `c158d5da-ee0e-4b40-acad-f7d68e84702b`, update `01a11d2a-0e44-7d91-8934-9761a85c9ccf`. No backend or data change was needed.
