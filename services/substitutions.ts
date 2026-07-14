import { aiClient, canonicalizeHouseholdId } from './aiClient';

export interface SubstitutionResult {
  name: string;
  adjustment: string;
  reason: string;
}

interface SubstitutionCacheEntry {
  expiresAt: number;
  value: SubstitutionResult[];
}

const CACHE_MAX_ENTRIES = 100;
const CACHE_TTL_MS = 30 * 60 * 1000;
const substitutionCache = new Map<string, SubstitutionCacheEntry>();

function cloneSubstitutions(values: SubstitutionResult[]): SubstitutionResult[] {
  return values.map((value) => ({ ...value }));
}

function readCachedSubstitutions(cacheKey: string): SubstitutionResult[] | null {
  const cached = substitutionCache.get(cacheKey);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    substitutionCache.delete(cacheKey);
    return null;
  }
  substitutionCache.delete(cacheKey);
  substitutionCache.set(cacheKey, cached);
  return cloneSubstitutions(cached.value);
}

function cacheSubstitutions(cacheKey: string, values: SubstitutionResult[]): SubstitutionResult[] {
  const snapshot = cloneSubstitutions(values);
  substitutionCache.set(cacheKey, {
    expiresAt: Date.now() + CACHE_TTL_MS,
    value: snapshot,
  });
  while (substitutionCache.size > CACHE_MAX_ENTRIES) {
    const oldestKey = substitutionCache.keys().next().value;
    if (oldestKey === undefined) break;
    substitutionCache.delete(oldestKey);
  }
  return cloneSubstitutions(snapshot);
}

function requiredText(value: string, max: number, label: string): string {
  const normalized = value.trim().slice(0, max);
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function optionalText(value: string, max: number): string {
  return value.trim().slice(0, max);
}

export async function getIngredientSubstitutions(
  householdId: string,
  ingredientName: string,
  ingredientUnit: string,
  recipeTitle: string,
  allIngredients: string[],
): Promise<SubstitutionResult[]> {
  const household = canonicalizeHouseholdId(householdId);
  const input = {
    ingredientName: requiredText(ingredientName, 120, 'Ingredient'),
    ingredientUnit: optionalText(ingredientUnit, 40),
    recipeTitle: requiredText(recipeTitle, 200, 'Recipe title'),
    allIngredients: allIngredients
      .map((value) => value.trim().slice(0, 120))
      .filter((value) => value.length > 0)
      .slice(0, 100),
  };
  if (input.allIngredients.length === 0) {
    throw new Error('Recipe ingredients are required');
  }

  const cacheKey = JSON.stringify([
    household,
    input.recipeTitle.toLowerCase(),
    input.ingredientName.toLowerCase(),
    input.ingredientUnit.toLowerCase(),
    input.allIngredients.map((value) => value.toLowerCase()),
  ]);
  const cached = readCachedSubstitutions(cacheKey);
  if (cached) return cached;

  const response = await aiClient.substitutions(household, input);
  return cacheSubstitutions(cacheKey, response.substitutions);
}
