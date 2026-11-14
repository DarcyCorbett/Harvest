import { initializeApp } from 'firebase-admin/app';
import { createAppInviteHandlers, firestoreInviteStore } from './callables/appInvites.js';
import { onCall } from 'firebase-functions/v2/https';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { logger } from 'firebase-functions';
import { connectedCommand as runConnectedCommand, reconcileHousehold } from './connected/service.js';
import { importConnectedRecipe as runImportConnectedRecipe } from './connected/importRecipe.js';

import { requestDecisions } from './ai/decision.js';
import { requestGeminiJson } from './ai/geminiProvider.js';
import { SUBSTITUTION_MODEL, SUBSTITUTION_REASONING_EFFORT, thinkingLevelFor } from './ai/models.js';
import { requestOpenAiJson } from './ai/openaiProvider.js';
import { createAiService } from './ai/service.js';
import {
  authorizeAllowlistedUser,
  authorizeCatalogueEditor,
  authorizeHouseholdMember,
} from './authz.js';
import {
  createCatalogueMetadataHandlers,
  firestoreCanonicalMetadataStore,
} from './catalogue/metadata.js';
import {
  createCatalogueSelectionHandlers,
  firestoreCatalogueSelectionStore,
} from './catalogue/selection.js';
import { createAiHandlers } from './callables/ai.js';
import {
  createHouseholdHandlers,
  firestoreHouseholdMutations,
} from './callables/households.js';
import {
  createLegacyRecipeHandlers,
  firestoreLegacyRecipeStore,
} from './callables/legacyRecipes.js';
import { GEMINI_API_KEY, OPENAI_API_KEY } from './config.js';
import { firestoreQuotaStore, reserveQuota } from './quota.js';

import { browseCatalogueHandler } from './catalogue/browse.js';
initializeApp();
export const browseCatalogueRecipes = onCall({ region: 'europe-west1' }, browseCatalogueHandler);

const appInviteHandlers = createAppInviteHandlers(firestoreInviteStore());
export const getAppInvitePermissions = onCall({ region: 'europe-west1' }, appInviteHandlers.permissions);
export const inviteAppUser = onCall({ region: 'europe-west1' }, appInviteHandlers.invite);

export const connectedCommand = onCall({ region: 'europe-west1', timeoutSeconds: 120 },
  request => runConnectedCommand(request, { deferReconciliation: true }));
export const importConnectedRecipe = onCall({ region: 'europe-west1', timeoutSeconds: 120 }, runImportConnectedRecipe);
export const reconcileConnectedShopping = onDocumentWritten({ document: 'households/{householdId}/connected/state', region: 'europe-west1', retry: true, secrets: [GEMINI_API_KEY], timeoutSeconds: 120 }, async event => {
  const after = event.data?.after.data();
  if (after?.status === 'pending') await reconcileHousehold(event.params.householdId, undefined, groupConnectedShopping);
});

const quotaStore = firestoreQuotaStore();
const service = createAiService({
  requestJson(model, prompt, maxOutputTokens) {
    return requestGeminiJson({
      apiKey: GEMINI_API_KEY.value(),
      model,
      prompt,
      maxOutputTokens,
      thinkingLevel: thinkingLevelFor(model),
    });
  },
  requestDecisions(input, questions) {
    return requestDecisions({ apiKey: GEMINI_API_KEY.value(), input, questions });
  },
  requestSubstitutionJson(prompt) {
    return requestOpenAiJson({
      apiKey: OPENAI_API_KEY.value(),
      model: SUBSTITUTION_MODEL,
      prompt,
      // Reasoning tokens count toward this cap; the answer itself is about 200.
      maxOutputTokens: 4_096,
      reasoningEffort: SUBSTITUTION_REASONING_EFFORT,
      timeoutMs: 30_000,
    });
  },
  onFallback(endpoint, reason) {
    logger.warn('ai_provider_fallback', { endpoint, reason });
  },
});
const groupConnectedShopping: import('./connected/shoppingGrouping.js').ShoppingGrouper = async (householdId, ingredients) => {
  await reserveQuota(quotaStore, `household-${householdId}`, 'shoppingGroups');
  return service.shoppingGroups(ingredients);
};
const handlers = createAiHandlers({
  authorize: authorizeHouseholdMember,
  reserve(uid, endpoint, units) {
    return reserveQuota(quotaStore, uid, endpoint, units);
  },
  service,
});
const householdMutations = firestoreHouseholdMutations();
const householdHandlers = createHouseholdHandlers({
  authorize: authorizeAllowlistedUser,
  create: householdMutations.create,
  join: householdMutations.join,
});
const legacyRecipeStore = firestoreLegacyRecipeStore();
const legacyRecipeHandlers = createLegacyRecipeHandlers({
  authorize: authorizeHouseholdMember,
  reserve(uid, endpoint, units) {
    return reserveQuota(quotaStore, uid, endpoint, units);
  },
  create: legacyRecipeStore.create,
  update: legacyRecipeStore.update,
});
const catalogueSelectionHandlers = createCatalogueSelectionHandlers({
  authorize: authorizeHouseholdMember,
  store: firestoreCatalogueSelectionStore(),
});
const catalogueMetadataHandlers = createCatalogueMetadataHandlers({
  authorize: authorizeCatalogueEditor,
  store: firestoreCanonicalMetadataStore(),
});

const aiOptions = {
  secrets: [GEMINI_API_KEY] as [typeof GEMINI_API_KEY],
  enforceAppCheck: false,
  consumeAppCheckToken: false,
} as const;

export const tagRecipes = onCall(aiOptions, handlers.tagRecipes);
export const reminderFlags = onCall(aiOptions, handlers.reminderFlags);
export const shoppingGroups = onCall(aiOptions, handlers.shoppingGroups);
export const substitutions = onCall(
  { ...aiOptions, secrets: [GEMINI_API_KEY, OPENAI_API_KEY] },
  handlers.substitutions,
);
export const createHousehold = onCall(householdHandlers.create);
export const joinHousehold = onCall(householdHandlers.join);
export const switchHousehold = onCall(householdHandlers.switch);
export const saveLegacyRecipe = onCall(legacyRecipeHandlers.save);
export const updateLegacyRecipeMetadata = onCall(legacyRecipeHandlers.update);
export const selectCatalogueRecipes = onCall(catalogueSelectionHandlers.select);
export const updateCanonicalRecipeMetadata = onCall(catalogueMetadataHandlers.update);
