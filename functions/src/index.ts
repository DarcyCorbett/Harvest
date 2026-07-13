import { initializeApp } from 'firebase-admin/app';
import { onCall } from 'firebase-functions/v2/https';

import { requestGeminiJson } from './ai/geminiProvider.js';
import { createAiService } from './ai/service.js';
import { authorizeHouseholdMember } from './authz.js';
import { createAiHandlers } from './callables/ai.js';
import { GEMINI_API_KEY } from './config.js';
import { firestoreQuotaStore, reserveQuota } from './quota.js';

initializeApp();

const quotaStore = firestoreQuotaStore();
const service = createAiService({
  requestJson(model, prompt, maxOutputTokens) {
    return requestGeminiJson({
      apiKey: GEMINI_API_KEY.value(),
      model,
      prompt,
      maxOutputTokens,
    });
  },
});
const handlers = createAiHandlers({
  authorize: authorizeHouseholdMember,
  reserve(uid, endpoint, units) {
    return reserveQuota(quotaStore, uid, endpoint, units);
  },
  service,
});

const aiOptions = {
  secrets: [GEMINI_API_KEY] as [typeof GEMINI_API_KEY],
  enforceAppCheck: false,
  consumeAppCheckToken: false,
} as const;

export const tagRecipes = onCall(aiOptions, handlers.tagRecipes);
export const reminderFlags = onCall(aiOptions, handlers.reminderFlags);
export const shoppingGroups = onCall(aiOptions, handlers.shoppingGroups);
export const substitutions = onCall(aiOptions, handlers.substitutions);
