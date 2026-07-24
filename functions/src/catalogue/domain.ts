import { createHash } from 'node:crypto';

export const MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'side', 'snack'] as const;
export const CUISINES = [
  'asian',
  'mexican',
  'mediterranean',
  'italian',
  'indian',
  'greek',
  'american',
  'french',
  'middle-eastern',
  'global',
] as const;
export const MODIFIERS = [
  'vegetarian',
  'kid-friendly',
  'healthy',
  'salad',
] as const;

export type MealType = typeof MEAL_TYPES[number];
export type Cuisine = typeof CUISINES[number];
export type Modifier = typeof MODIFIERS[number];
export type ClassificationSource = 'source' | 'rule' | 'ai' | 'manual';
export type CatalogueTimestamp = string | Date | {
  seconds: number;
  nanoseconds: number;
};

export interface CanonicalIngredient {
  name: string;
  quantity?: number;
  unit?: string;
  notes?: string;
}

export interface CanonicalIngredientGroup {
  name: string;
  ingredients: CanonicalIngredient[];
}

export interface CanonicalInstructionStep {
  text: string;
  imageUrl?: string;
  videoEmbedUrl?: string;
  isHeader?: boolean;
}

export interface RecipeMetadata {
  prepMinutes?: number;
  cookMinutes?: number;
  totalMinutes?: number;
  mealTypes?: readonly MealType[];
  cuisines?: readonly Cuisine[];
  modifiers?: readonly Modifier[];
}

export interface ManualRecipeOverrides {
  prepMinutes?: number | null;
  cookMinutes?: number | null;
  totalMinutes?: number | null;
  mealTypes?: readonly MealType[] | null;
  cuisines?: readonly Cuisine[] | null;
  modifiers?: readonly Modifier[] | null;
  updatedBy?: string;
  updatedAt?: CatalogueTimestamp;
}

export interface EffectiveRecipeMetadata {
  prepMinutes?: number;
  cookMinutes?: number;
  totalMinutes?: number;
  totalTimeProvenance?: 'manual' | 'source' | 'derived';
  mealTypes: readonly MealType[];
  cuisines: readonly Cuisine[];
  modifiers: readonly Modifier[];
}

export interface RecipeSearchFields {
  selectionKeys: string[];
  vegetarian: boolean;
  kidFriendly: boolean;
  healthy: boolean;
  salad: boolean;
  quick30: boolean;
  moderate45: boolean;
  ingredientTokens: string[];
  randomKey: number;
}

interface CanonicalRecipeBase {
  schemaVersion: 2;
  id: string;
  source: {
    key: string;
    canonicalUrl: string;
    originalUrl: string;
    sourceLastModified?: string;
  };
  ingestion: {
    contentHash?: string;
    firstIngestedAt?: CatalogueTimestamp;
    lastChangedAt?: CatalogueTimestamp;
    lastAttemptAt?: CatalogueTimestamp;
    retryCount?: number;
    nextRetryAt?: CatalogueTimestamp;
    lastErrorCode?: string;
  };
}

export interface CompleteCanonicalRecipeV2 extends CanonicalRecipeBase {
  status: 'ready' | 'review';
  content: {
    title: string;
    imageUrl?: string;
    videoEmbedUrl?: string;
    description?: string;
    originalServings: number;
    ingredients: CanonicalIngredient[];
    ingredientGroups?: CanonicalIngredientGroup[];
    instructions: CanonicalInstructionStep[];
    notes?: string;
    nutrition?: Record<string, unknown>;
  };
  sourceMetadata: RecipeMetadata;
  manualOverrides?: ManualRecipeOverrides;
  effective: EffectiveRecipeMetadata;
  search: RecipeSearchFields;
  classification: {
    parserVersion: number;
    classifierVersion?: number;
    taxonomyVersion: number;
    sources: Record<string, ClassificationSource>;
    complete: boolean;
  };
}

export interface OperationalCanonicalRecipeV2 extends CanonicalRecipeBase {
  status: 'retryable' | 'invalid' | 'disabled';
  reasonCode: string;
}

export type CanonicalRecipeV2 =
  | CompleteCanonicalRecipeV2
  | OperationalCanonicalRecipeV2;

const TRACKING_PARAMETER = /^(utm_.+|fbclid|gclid|dclid|mc_cid|mc_eid)$/i;

export function canonicalizeRecipeUrl(value: string): string {
  const url = new URL(value.trim());
  url.hash = '';
  url.hostname = url.hostname.toLowerCase();

  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMETER.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();

  url.pathname = url.pathname.replace(/\/{2,}/g, '/');
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\?$/, '').replace(/\/$/, url.pathname === '/' ? '/' : '');
}

export function canonicalRecipeId(canonicalUrl: string): string {
  return createHash('sha256').update(canonicalUrl, 'utf8').digest('hex');
}

const INGREDIENT_STOP_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'of', 'or', 'the', 'to',
  'cup', 'cups', 'tbsp', 'tablespoon', 'tablespoons', 'tsp', 'teaspoon',
  'teaspoons', 'g', 'gram', 'grams', 'kg', 'kilogram', 'kilograms', 'ml',
  'millilitre', 'millilitres', 'l', 'litre', 'litres', 'oz', 'ounce',
  'ounces', 'lb', 'pound', 'pounds', 'large', 'small', 'medium', 'sliced',
  'diced', 'chopped', 'minced', 'fresh', 'optional', 'divided', 'taste',
]);

function singularize(token: string): string {
  if (token.endsWith('ies') && token.length > 4) return `${token.slice(0, -3)}y`;
  if (token.endsWith('oes') && token.length > 4) return token.slice(0, -2);
  if (token.endsWith('ses') && token.length > 4) return token.slice(0, -1);
  if (token.endsWith('s') && !token.endsWith('ss') && token.length > 3) {
    return token.slice(0, -1);
  }
  return token;
}

export function normalizeIngredientTokens(ingredients: readonly string[]): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];

  for (const ingredient of ingredients) {
    const normalized = ingredient
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[\d\u00bc-\u00be\u2150-\u215e]+(?:[./][\d]+)?/g, ' ')
      .replace(/[^a-z]+/g, ' ')
      .trim();

    for (const rawToken of normalized.split(/\s+/)) {
      if (!rawToken || INGREDIENT_STOP_WORDS.has(rawToken)) continue;
      const token = singularize(rawToken);
      if (!INGREDIENT_STOP_WORDS.has(token) && !seen.has(token)) {
        seen.add(token);
        tokens.push(token);
      }
    }
  }

  return tokens;
}

function effectiveList<T>(source: readonly T[] | undefined, manual: readonly T[] | null | undefined): readonly T[] {
  return [...(manual === null || manual === undefined ? source ?? [] : manual)];
}

function effectiveNumber(source: number | undefined, manual: number | null | undefined): number | undefined {
  return manual === null || manual === undefined ? source : manual;
}

export function buildEffectiveMetadata(
  source: RecipeMetadata,
  manual: ManualRecipeOverrides = {},
): EffectiveRecipeMetadata {
  const prepMinutes = effectiveNumber(source.prepMinutes, manual.prepMinutes);
  const cookMinutes = effectiveNumber(source.cookMinutes, manual.cookMinutes);
  let totalMinutes: number | undefined;
  let totalTimeProvenance: EffectiveRecipeMetadata['totalTimeProvenance'];

  if (manual.totalMinutes !== null && manual.totalMinutes !== undefined) {
    totalMinutes = manual.totalMinutes;
    totalTimeProvenance = 'manual';
  } else if (source.totalMinutes !== undefined) {
    totalMinutes = source.totalMinutes;
    totalTimeProvenance = 'source';
  } else if (prepMinutes !== undefined && cookMinutes !== undefined) {
    totalMinutes = prepMinutes + cookMinutes;
    totalTimeProvenance = 'derived';
  }

  return {
    ...(prepMinutes === undefined ? {} : { prepMinutes }),
    ...(cookMinutes === undefined ? {} : { cookMinutes }),
    ...(totalMinutes === undefined ? {} : { totalMinutes, totalTimeProvenance }),
    mealTypes: effectiveList(source.mealTypes, manual.mealTypes),
    cuisines: effectiveList(source.cuisines, manual.cuisines),
    modifiers: effectiveList(source.modifiers, manual.modifiers),
  };
}

export function buildSearchFields(
  effective: EffectiveRecipeMetadata,
  ingredientNames: readonly string[],
  randomKey: number,
): RecipeSearchFields {
  const modifiers = new Set(effective.modifiers);
  const selectionKeys = effective.mealTypes.flatMap((mealType) => [
    `${mealType}|any`,
    ...effective.cuisines.map((cuisine) => `${mealType}|${cuisine}`),
  ]);

  return {
    selectionKeys: [...new Set(selectionKeys)].sort(),
    vegetarian: modifiers.has('vegetarian'),
    kidFriendly: modifiers.has('kid-friendly'),
    healthy: modifiers.has('healthy'),
    salad: modifiers.has('salad'),
    quick30: effective.totalMinutes !== undefined && effective.totalMinutes <= 30,
    moderate45: effective.totalMinutes !== undefined && effective.totalMinutes <= 45,
    ingredientTokens: normalizeIngredientTokens(ingredientNames),
    randomKey,
  };
}

function equalSearchFields(left: RecipeSearchFields, right: RecipeSearchFields): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function validateReadyRecipe(recipe: CanonicalRecipeV2): string[] {
  if (recipe.status !== 'ready') return [];

  const errors: string[] = [];
  if (!recipe.id) errors.push('id');
  if (!recipe.source.key) errors.push('source.key');
  if (!recipe.source.canonicalUrl) errors.push('source.canonicalUrl');
  if (!recipe.source.originalUrl) errors.push('source.originalUrl');
  if (!recipe.content.title.trim()) errors.push('content.title');
  if (!(recipe.content.originalServings > 0)) errors.push('content.originalServings');
  if (recipe.content.ingredients.length === 0) errors.push('content.ingredients');
  if (recipe.content.instructions.length === 0
    || recipe.content.instructions.some((step) => !step.text.trim())) {
    errors.push('content.instructions');
  }
  if (!(recipe.effective.totalMinutes && recipe.effective.totalMinutes > 0)) {
    errors.push('effective.totalMinutes');
  }
  if (recipe.effective.mealTypes.length === 0) errors.push('effective.mealTypes');
  if (!recipe.classification.complete) errors.push('classification.complete');

  const expectedSearch = buildSearchFields(
    recipe.effective,
    recipe.content.ingredients.map((ingredient) => ingredient.name),
    recipe.search.randomKey,
  );
  if (!equalSearchFields(recipe.search, expectedSearch)) errors.push('search');

  if (Buffer.byteLength(JSON.stringify(recipe), 'utf8') > 900_000) {
    errors.push('firestore.documentSize');
  }
  if (recipe.search.ingredientTokens.length > 5_000
    || recipe.search.selectionKeys.length > 200) {
    errors.push('firestore.indexEntries');
  }

  return errors;
}
