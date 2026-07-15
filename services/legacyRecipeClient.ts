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

export function createLegacyRecipeClient(invoke: Invoke = firebaseInvoke) {
  return {
    async save(householdId: string, recipe: Recipe): Promise<string> {
      if (!householdId.trim()) throw new Error('Household is required');

      const { id: _id, scrapedAt: _scrapedAt, ...serializable } = recipe;
      const result = await invoke('saveLegacyRecipe', {
        householdId,
        recipe: JSON.parse(JSON.stringify(serializable)),
      }) as { data: { recipeId: string } };

      return result.data.recipeId;
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

      await invoke('updateLegacyRecipeMetadata', {
        householdId,
        recipeId,
        ...metadata,
      });
    },
  };
}

export const legacyRecipeClient = createLegacyRecipeClient();
