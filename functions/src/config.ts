import { defineSecret } from 'firebase-functions/params';
import { setGlobalOptions } from 'firebase-functions/v2';

export const REGION = 'europe-west1';

export const GEMINI_API_KEY = defineSecret('mealwizard-gemini-api-key');
/** OpenAI key for ingredient substitutions. It must exist before deploying: see docs/ai-stack-evaluation.md. */
export const OPENAI_API_KEY = defineSecret('MEALWIZARD_OPENAI_API_KEY');

setGlobalOptions({
  region: REGION,
  maxInstances: 3,
  timeoutSeconds: 60,
  memory: '256MiB',
});
