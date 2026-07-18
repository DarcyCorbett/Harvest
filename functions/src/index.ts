import { initializeApp } from 'firebase-admin/app';
import { onCall } from 'firebase-functions/v2/https';

import { requestGeminiJson } from './ai/geminiProvider.js';
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
export const substitutions = onCall(aiOptions, handlers.substitutions);
export const createHousehold = onCall(householdHandlers.create);
export const joinHousehold = onCall(householdHandlers.join);
export const switchHousehold = onCall(householdHandlers.switch);
export const saveLegacyRecipe = onCall(legacyRecipeHandlers.save);
export const updateLegacyRecipeMetadata = onCall(legacyRecipeHandlers.update);
export const selectCatalogueRecipes = onCall(catalogueSelectionHandlers.select);
export const updateCanonicalRecipeMetadata = onCall(catalogueMetadataHandlers.update);
