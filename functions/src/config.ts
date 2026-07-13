import { defineSecret } from 'firebase-functions/params';
import { setGlobalOptions } from 'firebase-functions/v2';

export const REGION = 'europe-west1';

export const GEMINI_API_KEY = defineSecret('mealwizard-gemini-api-key');

setGlobalOptions({
  region: REGION,
  maxInstances: 3,
  timeoutSeconds: 60,
  memory: '256MiB',
});
