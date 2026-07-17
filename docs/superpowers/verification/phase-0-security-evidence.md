# Phase 0 Security Evidence

Project: `meal-wizard-ad202`

Region: `europe-west1`
Evidence window: 2026-07-16 to 2026-07-17 UTC

No provider key values, prompts, ingredient payloads, provider responses, email addresses, user IDs, household IDs, or recipe contents are included below.

| Check | Timestamp (UTC) | Result | Sanitized evidence |
|---|---:|---|---|
| Local Phase 0 suite | 2026-07-17 20:16–20:17 | PASS | `npm.cmd run verify:phase0` exited 0: Functions 260/260; client 151 passed with one Windows symlink-permission test skipped; Functions build and root type-check passed; lint reported 0 errors and 20 pre-existing warnings; `Client secret scan clean (6 target(s))`. |
| Firestore emulator matrix | 2026-07-17 20:17 | PASS | 29/29 rules tests passed. Member reads/writes are scoped to household subcollections; unauthenticated and non-member access, client household/member mutation, recipe mutation, recipe-index mutation, allowlist enumeration/write, and invite-reservation access were denied. |
| Functions/rules deployment | 2026-07-17 deploy; 20:20 inventory | PASS | `npx.cmd firebase deploy --only functions,firestore:rules --project meal-wizard-ad202` exited 0 and reported deployment complete for Firestore rules and all 9 required functions. A fresh inventory then found all 9 in `europe-west1`, all on `nodejs22`: household create/join/switch, the four AI callables, and both legacy recipe callables. |
| Sanitized production logs | 2026-07-17 18:20 | PASS | Authenticated `tagRecipes` logged valid callable verification, quota reservation, bounded token counts, duration, and `outcome=success`. Inspection found no prompt field, ingredient list, provider response, or credential. |
| Four authorized AI flows and household flow | 2026-07-17 18:20–20:00 | PASS | User-confirmed installed-preview smoke covered plan generation/tagging, confirmation-dependent shopping/reminder behavior, an ingredient substitution, and household create/join/switch using allowlisted accounts. The generated meal was saved successfully. |
| Live unauthorized callable attempts | 2026-07-17 20:21 | PASS | Fresh unauthenticated request returned HTTP 401 / `UNAUTHENTICATED`. A disposable allowlisted but non-member account returned HTTP 403 / `PERMISSION_DENIED`; its Auth user and allowlist record were deleted immediately afterward. |
| Client/rules mutation denials | 2026-07-17 20:17 | PASS | Emulator evidence independently denied non-member and unauthenticated subcollection writes, all client household/member-array writes, and all client recipe create/update/delete operations. |
| Missing-reference preservation | 2026-07-17 20:21–20:32 | PASS | A deliberately absent recipe had one uniquely named temporary meal-plan reference and one cookbook reference. The installed preview displayed `Recipe unavailable` in both Calendar and Cookbook. A post-refresh Admin SDK read proved both references remained present and the recipe remained absent; only the two temporary references were then deleted and cleanup was verified. |
| Client export secret scan | 2026-07-17 | PASS | Fresh Expo web export completed; the export and source scan were clean. Provider environment names, direct provider hosts, `?key=` calls, and DeepSeek-style tokens are scanner failures. |
| Preview-build smoke | 2026-07-17 | PASS | EAS preview build `4ba6ad35-c290-42fc-b198-9f2cd438c8aa` (Android build 14) finished, was installed, and passed the user smoke test. The client uses Firebase callables rather than direct provider requests. |
| Scheduled tagger | 2026-07-17 | PASS | The scheduled identity can access only `mealwizard-gemini-api-key`; access to the DeepSeek secret was denied. Real one-item runs exercised bounded query/parse handling, and a synthetic one-item run through the same adapter returned one structured result with no credential-pattern leak. The schedule remains a temporary Phase 0 bridge. |
| Replacement Gemini secret | 2026-07-17 20:19 | PASS | Secret Manager version 1 is `ENABLED`; live Gemini tagging succeeded. |
| Replacement DeepSeek secret | 2026-07-17 20:19 | PASS | Secret Manager version 1 is `ENABLED`, stored but unused, and has no runtime accessor grant. |
| Old Gemini key | 2026-07-17 | REVOKED | Provider metadata identified the April key separately from the July replacement. The April key was deleted; a post-delete list proved the old resource absent and the replacement still present. `old-gemini-key=REVOKED`. |
| Old DeepSeek key | 2026-07-17 | REVOKED | The repository-history fingerprint matched the June `IngridientReplacement` key. The provider console confirmed `API key revoked` and removed that row; the July replacement remained. The unrelated `v4 pro` key was not changed. `old-deepseek-key=REVOKED`. |

## Verification methods

This table names the captured command or manual action for every result above. One-off probes intentionally omit inline credentials, account identifiers, household identifiers, and request contents.

| Check | Captured command or manual action | Captured sanitized output |
|---|---|---|
| Local Phase 0 suite | `$env:PATH='C:\Program Files\Android\Android Studio\jbr\bin;'+$env:PATH; npm.cmd run verify:phase0` | Exit 0; 260 Functions tests, 151 client tests plus one platform skip, 29 rules tests, builds/type-check, lint with 0 errors, and clean source scan. |
| Firestore emulator matrix | `npm.cmd run test:rules` (also executed inside `verify:phase0`) | Exit 0; 29/29. Expected denial diagnostics were emitted for anonymous/non-member mutations. |
| Functions/rules deployment | `npx.cmd firebase deploy --only functions,firestore:rules --project meal-wizard-ad202`; then `npx.cmd firebase functions:list --project meal-wizard-ad202 --json` | Deploy exited 0 and reported rules/functions deployment complete. Inventory: required 9, listed 9, all `nodejs22`, region `europe-west1`. |
| Sanitized production logs | `npx.cmd firebase functions:log --project meal-wizard-ad202 --lines 80` followed by field-limited inspection | Valid auth, quota reserved, Gemini usage counts, `tagRecipes` success, and bounded duration; payload/credential field scan clean. |
| Four authorized AI flows and household flow | Manual installed-preview checklist using allowlisted test accounts | User reported the requested generation/confirmation, substitution, and create/join/switch checks successful; a generated meal was saved. |
| Live unauthorized callable attempts | `node -e "<sanitized unauthenticated fetch probe>"`; `node -e "<sanitized disposable non-member Admin SDK/fetch probe>"` | HTTP 401 / `UNAUTHENTICATED`; HTTP 403 / `PERMISSION_DENIED`; disposable Auth and allowlist objects removed. |
| Client/rules mutation denials | `npm.cmd run test:rules` | Exit 0; non-member/anonymous household-content writes, client member-array writes, and recipe mutations denied. |
| Missing-reference preservation | One-off Admin SDK create/read/cleanup probes plus manual Calendar/Cookbook refresh | Before cleanup: meal reference present, cookbook reference present, recipe absent; user saw `Recipe unavailable` on both screens; after cleanup all temporary object counts were zero. |
| Client export secret scan | `npx.cmd expo export --platform web --output-dir .phase0-dist`; `node scripts/scanClientSecrets.mjs .phase0-dist` | Export exited 0; `Client secret scan clean`. |
| Preview-build smoke | `eas build --profile preview --platform android`; manual install and smoke checklist | EAS build finished as Android build 14; installed preview completed the user smoke flow using callable-backed code. |
| Scheduled tagger | `npx.cmd tsx scripts/tagRecipeIndex.ts --limit 1`; Secret Manager IAM/access probes; bounded synthetic adapter smoke | Scheduled identity Gemini access passed, DeepSeek access denied; real one-item runs exited safely; synthetic adapter returned one structured result and credential-pattern scan passed. |
| Replacement Gemini secret | `npx.cmd firebase functions:secrets:get mealwizard-gemini-api-key --project meal-wizard-ad202` | Version 1 `ENABLED`; live tagging succeeded. |
| Replacement DeepSeek secret | `npx.cmd firebase functions:secrets:get mealwizard-deepseek-api-key --project meal-wizard-ad202` | Version 1 `ENABLED`; runtime accessor intentionally absent. |
| Old Gemini key | Google API Keys metadata lookup, exact old-resource delete operation, operation poll, and post-delete list | Delete completed; replacement still listed; old resource no longer listed. |
| Old DeepSeek key | Repository-history masked-fingerprint comparison followed by manual provider-console revoke | Provider toast: `API key revoked`; old row absent; July replacement and unrelated key remained. |

## Gate tokens

- `before-patch=vulnerable: EXPO_PUBLIC_GEMINI_API_KEY`
- `after-patch=hardened: bundle-scan=clean`
- `old-gemini-key=REVOKED`
- `old-deepseek-key=REVOKED`

## Follow-ups outside the Phase 0 security gate

- Tighten generation-time enforcement: a Moderate request can currently accept a fallback recipe whose parsed prep/cook time is missing even when another displayed total exceeds the intended 45-minute ceiling.
- Make ingredient substitution discoverable in the UI; the current long-press gesture is easy to miss.
- Replace the temporary scheduled tagger with the Phase 1 complete-ingestion pipeline and unified indexed selection.
