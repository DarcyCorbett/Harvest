import type { CookbookEntry, Recipe } from './types';
import { parseMinutes } from './scraper/parse';

/** Only use images already saved with the recipe, in their original priority. */
export function cookbookImageUrls(recipe: Pick<Recipe, 'imageUrl' | 'imageUrls'>): string[] {
  return [...new Set([recipe.imageUrl, ...(recipe.imageUrls ?? [])]
    .map((url) => url?.trim()).filter((url): url is string => !!url))];
}

export function indexCookbook(cookbook: CookbookEntry[], recipes: Record<string, Recipe>) {
  return cookbook.flatMap((entry) => {
    const recipe = recipes[entry.recipeId];
    if (!recipe) return [];
    return [{
      entry,
      recipe,
      duration: parseMinutes(recipe.totalTime ?? '') ||
        (parseMinutes(recipe.prepTime) ?? 0) + (parseMinutes(recipe.cookTime) ?? 0),
      mealTypes: [...(recipe.course ?? []), ...(recipe.tags ?? [])].map((tag) => tag.toLowerCase()),
      searchText: [recipe.title, ...recipe.ingredients.map((ingredient) => ingredient.name),
        ...(recipe.tags ?? []), ...(recipe.course ?? []), recipe.cuisine ?? ''].join(' ').toLowerCase(),
    }];
  }).sort((a, b) => (b.entry.lastCookedAt ?? '').localeCompare(a.entry.lastCookedAt ?? ''));
}

export function filterCookbook(
  rows: ReturnType<typeof indexCookbook>,
  filters: { search: string; starred: boolean; cooked: boolean; time: number; type: string },
) {
  const search = filters.search.toLowerCase();
  return rows.filter(({ entry, duration, mealTypes, searchText }) =>
    (!filters.starred || entry.starred) &&
    (!filters.cooked || !!entry.lastCookedAt) &&
    (!filters.time || (!!duration && duration <= filters.time)) &&
    (filters.type === 'all' || mealTypes.includes(filters.type)) &&
    searchText.includes(search));
}
