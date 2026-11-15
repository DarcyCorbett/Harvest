# MealWizard Workspace Guidelines

## Deployment & EAS Updates
When building or deploying client updates via `eas update` (or `expo export`):
- **Environment Variables Required**: `eas update` does not automatically load `build.<profile>.env` from `eas.json`. All required `EXPO_PUBLIC_*` variables (Firebase API keys/project IDs and Google Client IDs) must be present in the process environment before bundling.
- **Verification**: Always ensure `.env` is loaded and exported in the process environment before running `eas update`.
- **Pre-publish Check**: Verify that the bundler export output confirms that `EXPO_PUBLIC_FIREBASE_*` and `EXPO_PUBLIC_GOOGLE_*` variables are loaded (e.g., `env: load .env`, `env: export ...`), or verify the exported bundle before publishing to an EAS channel.

## Architecture & Backend Contract Guardrails
- **Verify Backend Schemas Before Changing Client Payloads**: Always inspect `functions/src/connected/service.ts` (Zod schemas) and `functions/src/connected/model.ts` before changing or proposing changes to persisted client enums/fields (e.g., `draftSlot.status` is validated as `z.enum(["ready", "unmatched", "failed"])` — fix UI display text rather than inventing unvalidated statuses unless deploying coordinated schema + client updates).
- **Keep UI Dialogs Out of Generic Transport (`ConnectedContext.run`)**: Do not place UI modals/alerts inside `ConnectedContext.run()`; pass explicit command options (such as `shopping.mode`) from callers.
- **Preserve Revision/Generation Concurrency Guards**: Keep the `pendingRef.current` concurrency check protecting `expectedRevision` and `generation` during shopping syncs. When adjusting queue lockouts, narrow the guard (e.g., exclude errored items `p.error` or surface recovery UI) rather than removing the guard.
- **Preserve the Email Verification Gate**: `passwordOnboarding` in `services/householdClient.ts` intentionally enforces email verification before household creation/joining. Improve onboarding UX via pre-signup validation (such as validating invite codes before account creation) and form pre-filling rather than keeping unverified users signed in.
- **Observability (`devLog` vs. `DeveloperModeContext`)**: Do not wire new features to `contexts/DeveloperModeContext.tsx` (which globally patches `console.*` and flushes React state every 100 ms). Use `services/devLog.ts` (`logEvent()`) at discrete milestones only (avoid per-item/per-token calls since each write re-reads and rewrites AsyncStorage).

## UI/UX Audit & Roadmap Standards
- **Cross-Layer Verification**: When conducting UI/UX or flow audits (including `/swarm` worker briefs), require investigators to cross-check backing transport contexts (`contexts/*`) and backend contracts (`functions/src/connected/*`) before recommending fixes.
- **Split Roadmaps by Work Type & `Frequency × Severity`**: Separate recommendations into three explicit tracks — **1. Correctness Bugs** (one issue per ticket, each with a test), **2. Flow & Architecture Changes** (requiring product decisions), and **3. Design System & Polish** — prioritized by weekly user frequency × severity (recurring shopping/planning loops outrank one-time onboarding).
- **Explicit Metrics & Visual Evidence**: Define the exact counting rules for tap/interaction tables (field focus, typing, external steps, platform alert vs. sheet differences), define rubrics for scorecard labels, and pair visual claims (contrast, truncation, nested scrolling) with phone-width light/dark screenshots when runtime inspection is available.
