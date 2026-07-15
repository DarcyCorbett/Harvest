import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import {
  shoppingGroupsResponse,
  tagRecipesResponse,
} from '../../functions/src/ai/contracts';
import {
  buildShoppingGroupsPrompt,
  buildTagRecipesPrompt,
} from '../../functions/src/ai/prompts';
import { requestGeminiJson } from '../../functions/src/ai/geminiProvider';

const SECRET_ID = 'mealwizard-gemini-api-key';
const DEFAULT_PROJECT_ID = 'meal-wizard-ad202';
const DEFAULT_TAGGING_MODEL = 'gemini-3.1-flash-lite';
const DEFAULT_SHOPPING_MODEL = 'gemini-3.5-flash';
const MAX_TAG_BATCH_SIZE = 25;

type TagRecipeInput = Parameters<typeof buildTagRecipesPrompt>[0][number];
type ShoppingIngredientInput = Parameters<
  typeof buildShoppingGroupsPrompt
>[0][number];
type ShoppingGroups = ReturnType<typeof shoppingGroupsResponse.parse>;

interface ProviderRequest {
  apiKey: string;
  model: string;
  prompt: string;
  maxOutputTokens: number;
}

interface GeminiAdminDependencies {
  projectId: string;
  accessSecretVersion: (
    name: string,
  ) => Promise<string | Uint8Array | undefined>;
  requestJson: (request: ProviderRequest) => Promise<unknown>;
}

export interface GeminiAdminAdapter {
  tagRecipes(
    recipes: TagRecipeInput[],
    model?: string,
  ): Promise<Map<string, string[]>>;
  getShoppingGroups(
    ingredients: ShoppingIngredientInput[],
    model?: string,
  ): Promise<ShoppingGroups>;
}

export function createGeminiAdminAdapter(
  dependencies: GeminiAdminDependencies,
): GeminiAdminAdapter {
  let cachedKey: string | null = null;

  async function getGeminiKey(): Promise<string> {
    if (cachedKey) return cachedKey;

    const secretName =
      `projects/${dependencies.projectId}/secrets/${SECRET_ID}/versions/latest`;
    const payload = await dependencies.accessSecretVersion(secretName);
    const value = typeof payload === 'string'
      ? payload.trim()
      : Buffer.from(payload ?? []).toString('utf8').trim();
    if (!value) throw new Error('Gemini secret version is empty');
    cachedKey = value;
    return value;
  }

  return {
    async tagRecipes(
      recipes: TagRecipeInput[],
      model = DEFAULT_TAGGING_MODEL,
    ): Promise<Map<string, string[]>> {
      const tagsById = new Map<string, string[]>();
      if (recipes.length === 0) return tagsById;

      const apiKey = await getGeminiKey();
      for (let offset = 0; offset < recipes.length; offset += MAX_TAG_BATCH_SIZE) {
        const batch = recipes.slice(offset, offset + MAX_TAG_BATCH_SIZE);
        const raw = await dependencies.requestJson({
          apiKey,
          model,
          prompt: buildTagRecipesPrompt(batch),
          maxOutputTokens: Math.min(32_000, 4_096 + batch.length * 400),
        });
        const parsed = tagRecipesResponse.safeParse(raw);
        if (!parsed.success) {
          throw new Error('Gemini tagging response failed validation');
        }
        for (const entry of parsed.data.results) {
          tagsById.set(entry.id, entry.tags);
        }
      }
      return tagsById;
    },

    async getShoppingGroups(
      ingredients: ShoppingIngredientInput[],
      model = DEFAULT_SHOPPING_MODEL,
    ): Promise<ShoppingGroups> {
      if (ingredients.length === 0) return [];
      const raw = await dependencies.requestJson({
        apiKey: await getGeminiKey(),
        model,
        prompt: buildShoppingGroupsPrompt(ingredients),
        maxOutputTokens: Math.min(65_536, 4_096 + ingredients.length * 200),
      });
      const parsed = shoppingGroupsResponse.safeParse(raw);
      if (!parsed.success) {
        throw new Error('Gemini shopping response failed validation');
      }
      return parsed.data;
    },
  };
}

let defaultAdapter: GeminiAdminAdapter | null = null;

function getDefaultAdapter(): GeminiAdminAdapter {
  if (defaultAdapter) return defaultAdapter;

  const secretClient = new SecretManagerServiceClient();
  const projectId = process.env.GOOGLE_CLOUD_PROJECT
    ?? process.env.GCLOUD_PROJECT
    ?? DEFAULT_PROJECT_ID;
  defaultAdapter = createGeminiAdminAdapter({
    projectId,
    accessSecretVersion: async (name) => {
      const [version] = await secretClient.accessSecretVersion({ name });
      const data = version.payload?.data;
      return data == null ? undefined : Buffer.from(data);
    },
    requestJson: (request) => requestGeminiJson<unknown>(request),
  });
  return defaultAdapter;
}

export async function tagRecipesWithAdminGemini(
  recipes: TagRecipeInput[],
  model?: string,
): Promise<Map<string, string[]>> {
  return getDefaultAdapter().tagRecipes(recipes, model);
}

export async function getAdminShoppingGroups(
  ingredients: ShoppingIngredientInput[],
  model?: string,
): Promise<ShoppingGroups> {
  return getDefaultAdapter().getShoppingGroups(ingredients, model);
}
