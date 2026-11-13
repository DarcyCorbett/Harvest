# Admin invitations

The verified account `darcy.r.corbett@gmail.com` has an enabled `appAdmins/{uid}` record with `canInvite: true` in the existing Firebase project. Administration is checked on the server using the authenticated UID, verified email, existing allowlist membership, and private role record. Clients cannot grant themselves roles. These privileges currently cover app invitations; catalogue editing is a separate role.

Profile now contains **Admin · Invite to Harvest** for authorized administrators. Enter the recipient's sign-in email and choose **Enable access**. The server normalizes the email and creates its allowlist document only if absent. Existing records are preserved. Then **Share invitation** or **Copy invitation** provides the Android download URL and sign-in instructions. No email is sent automatically. Access is granted before sharing; cancelling the share sheet does not undo access. Forwarding the download does not approve additional accounts.

Recipients sign in with Google or register with a password and verify their email through the existing onboarding flow. Inviting someone to the app does not join them to the admin's household; household codes remain separate.

## Backend configuration

- `getAppInvitePermissions` and `inviteAppUser`: Firebase callable functions in `europe-west1`.
- `appAdmins/{uid}`: private role, requiring both `enabled: true` and `canInvite: true`.
- `appDistribution/current.downloadUrl`: operator-configured HTTPS download URL.
- `appInvitations/{email}`: private inviter and last-invited audit record.
- `allowlist/{email}`: existing pre-login access check. Newly created records contain only `enabled: true`.

The transaction rechecks admin permissions, requires a configured download, preserves existing access records, and writes the audit record atomically. Missing download configuration returns an actionable error without granting recipient access. Existing Firestore default-deny rules already protect the three new private collections.

## Android delivery

The new EAS `invitation` build profile extends `production`, produces a signed APK, and uses the production update channel/runtime. Direct APK installation avoids Google Play internal testing's separate tester membership requirement. Android may ask recipients to allow installation from the browser. The download itself is shareable; sign-in access remains email restricted.

The user approved the Expo source upload, existing signing credentials, build, and publication on 8 September 2026. Their standing preference is to publish completed changes without asking again when a new build is required. Continue using the existing project and configured distribution channels.

Delivery steps:

1. Run `eas build --platform android --profile invitation --non-interactive --no-wait` and wait for success.
2. Verify the resulting APK artifact URL, then run `node scripts/publishInvitationApk.mjs <EAS-artifact-url> <version-code>` to preserve it in the dedicated app-download bucket, verify the public download, and configure invitations. Only the APK object is public; bucket enumeration remains private.
3. Deliver the updated admin UI to the owner through the APK or the production EAS update channel, using the same approved Expo workflow.
4. Verify on Android: owner sees admin controls, a regular account does not; enable a chosen email, share the invitation, install, and sign in using that verified address.

The owner role is configured and both invitation functions deployed successfully on 8 September 2026. Live unauthenticated probes returned HTTP 401 / UNAUTHENTICATED from both endpoints. The user explicitly approved the initially blocked Expo build/publishing operation, including the existing signing workflow.

The client UI is published to the production Android update channel, runtime 1.1.0. Update group: `fac28c42-81fc-4a5b-a196-fd4dd7027788`; Android update: `01a08241-0d07-7446-b914-e5af1e99914e`. A direct update-protocol request confirmed HTTP 200 and the expected update ID. APK build 19 (`72b71dc5-ce93-4425-b8b6-a345f7091888`) finished successfully and its durable download is configured in Firebase.

The dedicated `meal-wizard-ad202-app-downloads` bucket in `europe-west1` hosts the public APK object. The download was verified with an unauthenticated ranged request (HTTP 206, Android package content type, ZIP header). Download: https://storage.googleapis.com/meal-wizard-ad202-app-downloads/app-releases/harvest-19-23a30a8f1126.apk . SHA-256: `23a30a8f11266938d926ce36618a5faf27f34e2c80891ae92e1bbd3831473e08`.

The user subsequently explicitly requested Google Play publication and authorized a delayed follow-up after builds finish. Production AAB build 20 (`83832485-47de-4c9f-acad-79d24ad8ac75`) was started with `eas build --platform android --profile production --auto-submit --non-interactive --no-wait`. It finished successfully. On 9 September 2026, the Google Play release lifecycle API confirmed version code 20 as `RELEASE_LIFECYCLE_STATE_PUBLISHED` on `internal`. The public production track was not changed. Future Play releases should use the production AAB profile with auto-submit, followed by verification of Google's published lifecycle state. An APK build alone does not publish a Play update.

No follow-up automation was created; this release completed in the resumed task. The in-app invitation link uses the direct APK so new recipients do not also need Google Play tester membership. Build 19 APK and build 20 AAB contain the same invitation feature; the artifact formats require separate build numbers.

## Verification

### Google sign-in correction — 9 September 2026

An invited recipient could register by password but Google sign-in failed before a Firebase Auth account existed. Inspection of the released invitation APK with Android `apksigner verify --print-certs` showed an unregistered EAS signing certificate. Firebase had only the Play Store app-signing certificate. Google authentication was enabled and the configured web client ID matched Firebase's provider, so the concrete discrepancy was the missing APK certificate/OAuth mapping.

Added APK SHA-1 `4c836419cf22d9e4dd043c5bc0dc86e4ef571e83` and SHA-256 `818f257ea1179c7581bcc2c112c30a7c7db654f4e1fe2a5632aad3483d3b5c86` to the existing Firebase Android app. A subsequent Firebase configuration read confirmed a new Android OAuth client (`1023058847517-tjfs3ufcviptfnn61dnqif8kh4hej9e1.apps.googleusercontent.com`) mapped to `com.mealwizard.app` and that SHA-1. The original Play OAuth mapping remains present. The Play generated-APK API independently confirmed its SHA-256 is `36c515fba6642aba0f39da9b0bea9986b1b9fc62e165ef990747c0a4f9de8909`.

This is a server configuration correction; the installed APK already requests the correct web client ID, so no rebuild or OTA change is needed. `signInWithCredential` already creates first-time Firebase accounts, followed by the allowlist/verified-email check and `completeGoogleHouseholdOnboarding` to create the first household. Do not create an artificial password account or bypass verified-email checks to work around Google authentication. Recipient should close/reopen Harvest and retry Google sign-in. Actual on-device Google sign-in still requires confirmation from the recipient.

For future Android signing changes, verify both the direct APK certificate and the Play app-signing certificate have OAuth mappings before publishing invitations.

- Backend: 664 tests passed, including 27 invitation authorization/transaction cases.
- Client: 284 passed, one existing skip.
- Firestore emulator: 46 passed, including private role/audit/distribution access denial.
- Client TypeScript and focused lint passed; client secret scan passed.
- Local Android Hermes export passed (`artifacts/admin-invites-android-export`).
- Live deployed callable verification passed: regular users denied, admin approval succeeded, recipient email normalized, duplicate invitation preserved existing access data, and revoked invite permission enforced. Disposable test account and all four test documents were removed and cleanup verified.
- Native device installation and the on-device sharing/sign-in walkthrough remain unverified.
