import type { Recipe } from './types';

type Flags = { needsDefrost: boolean; needsMarinate: boolean };

/** Connected plans bypass legacy confirmation, so fill flags at sync time too. */
export async function ensureReminderFlags(
  recipes: Map<string, Recipe>,
  classify: (recipes: { recipeId: string; recipe: Recipe }[]) => Promise<Map<string, Flags>>,
  persist: (recipeId: string, flags: Flags) => Promise<void>,
): Promise<void> {
  const missing = [...recipes].filter(([, recipe]) =>
    typeof recipe.needsDefrost !== 'boolean' || typeof recipe.needsMarinate !== 'boolean',
  ).map(([recipeId, recipe]) => ({ recipeId, recipe }));
  if (!missing.length) return;
  const flags = await classify(missing);
  for (const { recipeId, recipe } of missing) {
    const result = flags.get(recipeId);
    if (!result) throw new Error(`Missing reminder flags for ${recipeId}`);
    await persist(recipeId, result);
    Object.assign(recipe, result);
  }
}
