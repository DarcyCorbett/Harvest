import type { Nutrition, Recipe } from './types';

export function mergeRecipeLabels(
  course: readonly string[] = [],
  tags: readonly string[] = [],
): string[] {
  const labels = new Map<string, string>();
  for (const raw of [...course, ...tags]) {
    const label = raw.trim();
    const key = label.toLowerCase();
    if (label && !labels.has(key)) labels.set(key, label);
  }
  return [...labels.values()];
}

export function hasMeaningfulNutrition(
  nutrition: Nutrition | undefined,
): nutrition is Nutrition {
  return Boolean(nutrition && Object.values(nutrition)
    .some((value) => typeof value === 'number' && Number.isFinite(value) && value > 0));
}

export interface NutritionTotals extends Nutrition {
  contributingRecipes: number;
}

export function sumKnownNutrition(
  recipes: readonly (Recipe | null | undefined)[],
): NutritionTotals {
  const totals: NutritionTotals = { contributingRecipes: 0 };
  for (const recipe of recipes) {
    if (!hasMeaningfulNutrition(recipe?.nutrition)) continue;
    totals.contributingRecipes += 1;
    for (const key of ['calories', 'protein', 'carbs', 'fat'] as const) {
      const value = recipe.nutrition[key];
      if (value !== undefined) totals[key] = (totals[key] ?? 0) + value;
    }
  }
  return totals;
}
