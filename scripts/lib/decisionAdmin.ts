import { SecretManagerServiceClient } from '@google-cloud/secret-manager';

import {
  TAG_QUESTIONS,
  buildTagDecisionInput,
  composeTags,
  mapInParallel,
  requestDecisions,
} from '../../functions/src/ai/decision';
import { RECIPE_LABEL_ENGINE } from '../../functions/src/ai/models';
import { tagRecipesWithAdminGemini, type TagRecipeInput } from './geminiAdmin';

// Operator-side recipe tagging for the recipe-index crawler. Uses the same
// gemini-decision-1 questions as the tagRecipes callable (one request per
// recipe, several in flight) and falls back to the Gemini prompt tagger for
// the whole batch if any decision request fails.
const SECRET_ID = 'mealwizard-gemini-api-key';
const DEFAULT_PROJECT_ID = 'meal-wizard-ad202';
const LANES = 8;

let cachedKey: string | null = null;

async function geminiKey(): Promise<string> {
  if (cachedKey) return cachedKey;
  const projectId = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT ?? DEFAULT_PROJECT_ID;
  const client = new SecretManagerServiceClient();
  try {
    const [version] = await client.accessSecretVersion({ name: `projects/${projectId}/secrets/${SECRET_ID}/versions/latest` });
    const value = version.payload?.data?.toString().trim();
    if (!value) throw new Error('Gemini secret version is empty');
    cachedKey = value;
    return value;
  } finally {
    await client.close();
  }
}

/** Tags by recipe id. Existing tags are never repeated, matching the prompt tagger. */
export async function tagRecipesForIndex(
  recipes: TagRecipeInput[],
  fallbackModel: string,
): Promise<{ tagsById: Map<string, string[]>; engine: 'decision' | 'gemini'; fallbackReason?: string }> {
  if (RECIPE_LABEL_ENGINE === 'decision' && recipes.length > 0) {
    try {
      const apiKey = await geminiKey();
      const results = await mapInParallel(recipes, LANES, async (recipe) => [
        recipe.recipeId,
        composeTags(await requestDecisions({ apiKey, input: buildTagDecisionInput(recipe), questions: TAG_QUESTIONS, attempts: 4 }))
          .filter((tag) => !recipe.existingTags.includes(tag)),
      ] as const);
      return { tagsById: new Map(results), engine: 'decision' };
    } catch (error) {
      const fallbackReason = error instanceof Error ? error.message.slice(0, 80) : 'unknown';
      return { tagsById: await tagRecipesWithAdminGemini(recipes, fallbackModel), engine: 'gemini', fallbackReason };
    }
  }
  return { tagsById: await tagRecipesWithAdminGemini(recipes, fallbackModel), engine: 'gemini' };
}
