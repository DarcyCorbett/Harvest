# MealWizard Workspace Guidelines

## Deployment & EAS Updates
When building or deploying client updates via `eas update` (or `expo export`):
- **Environment Variables Required**: `eas update` does not automatically load `build.<profile>.env` from `eas.json`. All required `EXPO_PUBLIC_*` variables (Firebase API keys/project IDs and Google Client IDs) must be present in the process environment before bundling.
- **Verification**: Always ensure `.env` is loaded and exported in the process environment before running `eas update`.
- **Pre-publish Check**: Verify that the bundler export output confirms that `EXPO_PUBLIC_FIREBASE_*` and `EXPO_PUBLIC_GOOGLE_*` variables are loaded (e.g., `env: load .env`, `env: export ...`), or verify the exported bundle before publishing to an EAS channel.
