import type { Recipe } from './types';

type Endpoint = 'saveLegacyRecipe' | 'updateLegacyRecipeMetadata';
type Invoke = (
  endpoint: Endpoint,
  data: object,
) => Promise<{ data: unknown }>;

// Temporary Phase 0 adapter; remove with the legacy callables during Phase 5.

const firebaseInvoke: Invoke = async (endpoint, data) => {
  const [{ httpsCallable }, { functions }] = await Promise.all([
    import('firebase/functions'),
    import('../config/firebase'),
  ]);
  const response = await httpsCallable<object, unknown>(functions, endpoint)(data);
  return { data: response.data };
};

function parseRecipeIdResponse(
  endpoint: Endpoint,
  value: unknown,
  expectedRecipeId?: string,
): string {
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || Object.keys(value).length !== 1
    || !Object.hasOwn(value, 'recipeId')
  ) {
    throw new Error(`Invalid response from ${endpoint}`);
  }

  const { recipeId } = value as { recipeId: unknown };
  if (
    typeof recipeId !== 'string'
    || recipeId.length === 0
    || recipeId.length > 160
    || recipeId.trim() !== recipeId
    || (expectedRecipeId !== undefined && recipeId !== expectedRecipeId)
  ) {
    throw new Error(`Invalid response from ${endpoint}`);
  }

  return recipeId;
}

export function createLegacyRecipeClient(invoke: Invoke = firebaseInvoke) {
  return {
    async save(householdId: string, recipe: Recipe): Promise<string> {
      if (!householdId.trim()) throw new Error('Household is required');

      const { id: _id, scrapedAt: _scrapedAt, ...serializable } = recipe;
      const result = await invoke('saveLegacyRecipe', {
        householdId,
        recipe: JSON.parse(JSON.stringify(serializable)),
      });

      return parseRecipeIdResponse('saveLegacyRecipe', result.data);
    },

    async update(
      householdId: string,
      recipeId: string,
      metadata: {
        course?: string[];
        tags?: string[];
        needsDefrost?: boolean;
        needsMarinate?: boolean;
      },
    ): Promise<void> {
      if (!householdId.trim()) throw new Error('Household is required');

      const result = await invoke('updateLegacyRecipeMetadata', {
        householdId,
        recipeId,
        ...metadata,
      });
      parseRecipeIdResponse(
        'updateLegacyRecipeMetadata',
        result.data,
        recipeId,
      );
    },
  };
}

export const legacyRecipeClient = createLegacyRecipeClient();
