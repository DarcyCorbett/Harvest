# Expo SDK 57 upgrade

Upgraded incrementally from SDK 54 through 55 and 56 to Expo 57.0.22 on 2026-09-14, matching the installed Expo Go SDK 57. React is 19.2.3 and React Native is 0.86.3. Dependencies and lockfile are aligned with Expo's supported versions.

App version is now 1.2.0 so the appVersion runtime policy separates this native runtime from older builds. Removed obsolete newArchEnabled and edgeToEdgeEnabled settings; added the Expo image and status-bar plugins. Migrated useIsFocused to Expo Router's navigation export, removed obsolete direct React Navigation dependencies, replaced absoluteFillObject, and added a light-theme fallback for nullable Appearance values. Declared dotenv for existing maintenance scripts.

Validation: 286 client tests passed (one skipped), 667 backend tests passed, client TypeScript and backend build passed, client secret scan passed, Expo dependency check passed, and Expo Doctor passed 21/21 checks. Android prebuild and Android Hermes/web production exports passed; custom ADI registration asset was retained. No native APK compilation or physical-device validation has been performed.

The upgraded ESLint configuration reports 53 React Hooks errors in existing components (including state updates in effects and ref access during render). These remain follow-up work; rules were not suppressed and a clean lint result is not claimed.

Pre-upgrade configuration and the old generated Android directory are backed up at `C:\Users\User\AppData\Local\Temp\mealwizard-before-sdk57-KFh6tv`. Production export output is stored there in `sdk57-export`. These temporary backups are not permanent source control.

To test, run `npx expo start --go --lan --port 8081` and scan the terminal QR in Expo Go SDK 57 with phone and computer on the same Wi-Fi. Use email/password authentication: native Google sign-in requires a development/native build. This local upgrade has not been pushed, published through EAS Update, or deployed to the installed production app.

The current testing session uses `CI=1` to avoid slow Windows watcher startup. It serves SDK 57 at `exp://192.168.0.9:8081`; automatic reloads are disabled, so restart the server after editing code. The manifest was verified over LAN with HTTP 200 and SDK 57.0.0.

Device testing exposed an import-time push-token registration error in expo-notifications on Android Expo Go. A shared runtime boundary now avoids evaluating the package in Android Expo Go and web; notification setup, completion alerts, and meal reminders are skipped there. Native builds retain the notifications module. TypeScript and two runtime-import regression tests pass after this fix.

References: [Expo upgrade guide](https://docs.expo.dev/workflow/upgrading-expo-sdk-walkthrough/) and [SDK 57 release notes](https://expo.dev/changelog/sdk-57).

## Release — 14 September 2026

After device testing and fixing the cooking-screen notification import and stray shopping-details whitespace, the full client suite passed: 289 tests, one existing skip. The user explicitly approved EAS source upload, Google Play internal-track release, and invitation APK publication.

- Google Play AAB, version code 21: build `185d999f-372e-499d-8004-1d44fa6e286e`; automatic submission `d746094e-cb4c-4584-b1c0-b0e9619fb4da`, configured for internal/completed.
- Invitation APK, version code 22: build `65ae8322-11e3-4b5c-9e3a-23f5e0567937`.
- Both use app/runtime 1.2.0 and native fingerprint `e738ce74ba7f54aa08d2576b9dbccb57d1fec1d6`.

Builds are queued; publication is not yet confirmed. The initial Google Play lifecycle check still shows version code 20 published. The invitation download will be updated only after a successful APK build.
