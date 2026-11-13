import type {
  CuisineStyle,
  GenerateConfig,
  GeneratedMeal,
  MealType,
  Recipe,
} from './types';

export type CatalogueMealType = MealType;
export type CatalogueCuisine =
  | 'asian'
  | 'mexican'
  | 'mediterranean'
  | 'italian'
  | 'indian'
  | 'greek' | 'american' | 'french' | 'middle-eastern' | 'global';
export type CatalogueModifier =
  | 'vegetarian'
  | 'kid-friendly'
  | 'healthy'
  | 'salad';

export interface CatalogueIngredientFilters {
  must: string[];
  prefer: string[];
  exclude: string[];
}

export interface CatalogueMealSlot {
  date: string;
  mealType: CatalogueMealType;
  cuisines: CatalogueCuisine[];
  modifiers: CatalogueModifier[];
  maxTotalMinutes?: 30 | 45;
  ingredients: CatalogueIngredientFilters;
}

export interface CatalogueSelectionRequest {
  householdId: string;
  slots: CatalogueMealSlot[];
  currentPlanRecipeIds: string[];
  recentRecipeIds: string[];
  ranking?: { recentProteins: string[]; preferredRecipeIds: string[]; depreferredRecipeIds: string[] };
}

type Relaxation =
  | { filter: 'maxTotalMinutes'; from: 30; to: 45; matchCount: number }
  | { filter: 'modifier'; value: CatalogueModifier; matchCount: number }
  | { filter: 'cuisine'; value: CatalogueCuisine; matchCount: number }
  | { filter: 'mustIngredient'; value: string; matchCount: number }
  | { filter: 'excludedIngredient'; value: string; matchCount: number };

type SelectedSlot = {
  date: string;
  mealType: CatalogueMealType;
  status: 'selected';
  recipeId: string;
  sourceKey: string;
};

type NoMatchSlot = {
  date: string;
  mealType: CatalogueMealType;
  status: 'no-match';
  relaxations: Relaxation[];
};

export interface CatalogueSelectionResponse {
  slots: Array<SelectedSlot | NoMatchSlot>;
}

type Invoke = (data: CatalogueSelectionRequest) => Promise<{ data: unknown }>;
type LoadRecipe = (recipeId: string) => Promise<Recipe | null>;

type CanonicalMealType = MealType;
type CanonicalCuisine = CatalogueCuisine
  | 'greek'
  | 'american'
  | 'french'
  | 'middle-eastern'
  | 'global';
type CanonicalModifier = CatalogueModifier;

export interface CatalogueMetadataOperations {
  mealTypes: { operation: 'set'; value: CanonicalMealType[] };
  cuisines: { operation: 'set'; value: CanonicalCuisine[] };
  modifiers: { operation: 'set'; value: CanonicalModifier[] };
}

export interface CatalogueMetadataRequest {
  recipeId: string;
  operations: CatalogueMetadataOperations;
}

type MetadataInvoke = (data: CatalogueMetadataRequest) => Promise<{ data: unknown }>;

const MEAL_TYPE_BY_LABEL: Record<string, CanonicalMealType> = {
  breakfast: 'breakfast',
  lunch: 'lunch',
  dinner: 'dinner',
  side: 'side',
  snack: 'snack',
  dessert: 'dessert',
  component: 'component',
  'sauces, condiments & more': 'component',
};
const CUISINE_BY_LABEL: Record<string, CanonicalCuisine> = {
  asian: 'asian',
  mexican: 'mexican',
  mediterranean: 'mediterranean',
  italian: 'italian',
  indian: 'indian',
  greek: 'greek',
  american: 'american',
  french: 'french',
  'middle eastern': 'middle-eastern',
  global: 'global',
};
const MODIFIER_BY_LABEL: Record<string, CanonicalModifier> = {
  vegetarian: 'vegetarian',
  'kid friendly': 'kid-friendly',
  healthy: 'healthy',
  salad: 'salad',
};

function mappedValues<T extends string>(
  labels: readonly string[],
  mapping: Readonly<Record<string, T>>,
): T[] {
  return [...new Set(labels.flatMap((label) => {
    const value = mapping[label.trim().toLowerCase()];
    return value ? [value] : [];
  }))];
}

export function buildCatalogueMetadataOperations(
  course: readonly string[],
  tags: readonly string[],
): CatalogueMetadataOperations {
  // Inspect both arrays because legacy tagging sometimes stored meal types in
  // `tags`, while Salad is a canonical modifier even if older UIs treated it
  // as a course.
  const labels = [...course, ...tags];
  const mealTypes = mappedValues(labels, MEAL_TYPE_BY_LABEL);
  const cuisines = mappedValues(labels, CUISINE_BY_LABEL);
  const modifiers = mappedValues(labels, MODIFIER_BY_LABEL);
  if (mealTypes.length === 0) throw new Error('Choose at least one meal type.');
  if (cuisines.length === 0) throw new Error('Choose at least one cuisine.');
  return {
    mealTypes: { operation: 'set', value: mealTypes },
    cuisines: { operation: 'set', value: cuisines },
    modifiers: { operation: 'set', value: modifiers },
  };
}

const MEAL_ORDER: MealType[] = [
  'breakfast', 'lunch', 'dinner', 'side', 'snack', 'dessert', 'component',
];
const CUISINE_MAP: Partial<Record<CuisineStyle, CatalogueCuisine>> = {
  Asian: 'asian',
  Mexican: 'mexican',
  Mediterranean: 'mediterranean',
  Italian: 'italian',
  Indian: 'indian',
};
const MODIFIER_MAP: Partial<Record<CuisineStyle, CatalogueModifier>> = {
  Vegetarian: 'vegetarian',
  'Kid Friendly': 'kid-friendly',
  Healthy: 'healthy',
  Salad: 'salad',
};

function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function normalizeIngredient(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizeList(values: readonly string[] | undefined): string[] {
  if (!Array.isArray(values) || values.length > 20) {
    if ((values?.length ?? 0) > 20) throw new Error('Too many ingredient filters.');
    return [];
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    if (typeof raw !== 'string') throw new Error('Invalid ingredient filter.');
    const value = normalizeIngredient(raw);
    if (!value) continue;
    if (value.length > 120) throw new Error('Ingredient filter is too long.');
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

export function normalizeIngredientFilters(
  filters: GenerateConfig['ingredientFilters'],
  extraExcluded: readonly string[] = [],
): CatalogueIngredientFilters {
  const must = normalizeList(filters?.must);
  const exclude = normalizeList([...(filters?.exclude ?? []), ...extraExcluded]);
  const hard = new Set(must);
  if (exclude.some((value) => hard.has(value))) {
    throw new Error('The same ingredient cannot be both required and excluded.');
  }
  const excluded = new Set(exclude);
  const prefer = normalizeList(filters?.prefer)
    .filter((value) => !hard.has(value) && !excluded.has(value));
  return { must, prefer, exclude };
}

function maxTotalMinutes(styles: readonly CuisineStyle[]): 30 | 45 | undefined {
  if (styles.includes('Quick & Easy')) return 30;
  if (styles.includes('Moderate')) return 45;
  return undefined;
}

export function buildCatalogueSelectionRequest(
  config: GenerateConfig,
  householdId: string,
  currentPlanRecipeIds: readonly string[],
  recentRecipeIds: readonly string[],
): CatalogueSelectionRequest {
  if (!Number.isInteger(config.numberOfDays) || config.numberOfDays < 1 || config.numberOfDays > 31) {
    throw new Error('Invalid generation date range.');
  }
  const orderedMealTypes = [...new Set(config.mealTypes)]
    .sort((left, right) => MEAL_ORDER.indexOf(left) - MEAL_ORDER.indexOf(right));
  if (orderedMealTypes.length === 0 || orderedMealTypes.some((value) => !MEAL_ORDER.includes(value))) {
    throw new Error('Invalid meal types.');
  }
  const requestedSlots: Array<{ date: string; mealType: MealType }> = [];
  for (let day = 0; day < config.numberOfDays; day += 1) {
    for (const mealType of orderedMealTypes) {
      requestedSlots.push({ date: formatDate(addDays(config.startDate, day)), mealType });
    }
  }
  return buildCatalogueSelectionRequestForSlots(
    config,
    householdId,
    requestedSlots,
    currentPlanRecipeIds,
    recentRecipeIds,
  );
}

export function buildCatalogueSelectionRequestForSlots(
  config: Pick<GenerateConfig, 'cuisineStyles' | 'ingredientFilters' | 'settings'>,
  householdId: string,
  requestedSlots: readonly { date: string; mealType: MealType }[],
  currentPlanRecipeIds: readonly string[],
  recentRecipeIds: readonly string[],
): CatalogueSelectionRequest {
  if (!householdId.trim()) throw new Error('Household is required.');
  if (requestedSlots.length < 1 || requestedSlots.length > 31
    || requestedSlots.some((slot) => !validDate(slot.date) || !MEAL_ORDER.includes(slot.mealType))) {
    throw new Error('Invalid catalogue slots.');
  }
  const cuisines = config.cuisineStyles.flatMap((style) =>
    CUISINE_MAP[style] ? [CUISINE_MAP[style] as CatalogueCuisine] : []);
  const modifiers = [...new Set(config.cuisineStyles.flatMap((style) =>
    MODIFIER_MAP[style] ? [MODIFIER_MAP[style] as CatalogueModifier] : []))];
  const kidExclusions = modifiers.includes('kid-friendly')
    ? config.settings?.kidFriendly?.excludedIngredients ?? []
    : [];
  const ingredients = normalizeIngredientFilters(config.ingredientFilters, kidExclusions);
  const duration = maxTotalMinutes(config.cuisineStyles);

  const slots: CatalogueMealSlot[] = requestedSlots.map((requested, slotIndex) => {
    const cuisine = cuisines.length ? cuisines[slotIndex % cuisines.length] : undefined;
    return {
      ...requested,
      cuisines: cuisine ? [cuisine] : [],
      modifiers,
      ...(duration ? { maxTotalMinutes: duration } : {}),
      ingredients: {
        must: [...ingredients.must],
        prefer: [...ingredients.prefer],
        exclude: [...ingredients.exclude],
      },
    };
  });

  return {
    householdId: householdId.trim(),
    slots,
    currentPlanRecipeIds: [...new Set(currentPlanRecipeIds)].slice(0, 500),
    recentRecipeIds: [...new Set(recentRecipeIds)].slice(0, 500),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function validMealType(value: unknown): value is CatalogueMealType {
  return typeof value === 'string' && MEAL_ORDER.includes(value as MealType);
}

function validId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= 160
    && value.trim() === value;
}

function validMatchCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function parseRelaxation(value: unknown): Relaxation | null {
  if (!isRecord(value) || !validMatchCount(value.matchCount)) return null;
  if (value.filter === 'maxTotalMinutes' && value.from === 30 && value.to === 45) {
    return value as unknown as Relaxation;
  }
  if (value.filter === 'modifier'
    && typeof value.value === 'string'
    && Object.values(MODIFIER_MAP).includes(value.value as CatalogueModifier)) {
    return value as unknown as Relaxation;
  }
  if (value.filter === 'cuisine'
    && typeof value.value === 'string'
    && Object.values(CUISINE_BY_LABEL).includes(value.value as CatalogueCuisine)) {
    return value as unknown as Relaxation;
  }
  if ((value.filter === 'mustIngredient' || value.filter === 'excludedIngredient')
    && typeof value.value === 'string'
    && value.value.trim()
    && value.value.length <= 120) {
    return value as unknown as Relaxation;
  }
  return null;
}

function parseResponse(value: unknown, request: CatalogueSelectionRequest): CatalogueSelectionResponse {
  if (!isRecord(value) || Object.keys(value).length !== 1 || !Array.isArray(value.slots)
    || value.slots.length !== request.slots.length) {
    throw new Error('Invalid catalogue selection response.');
  }
  const seen = new Set<string>();
  const slots = value.slots.map((entry, index): SelectedSlot | NoMatchSlot => {
    if (!isRecord(entry)
      || !validDate(entry.date)
      || !validMealType(entry.mealType)
      || entry.date !== request.slots[index].date
      || entry.mealType !== request.slots[index].mealType) {
      throw new Error('Invalid catalogue selection response.');
    }
    if (entry.status === 'selected'
      && validId(entry.recipeId)
      && validId(entry.sourceKey)
      && Object.keys(entry).length === 5
      && !seen.has(entry.recipeId)) {
      seen.add(entry.recipeId);
      return {
        date: entry.date,
        mealType: entry.mealType,
        status: 'selected',
        recipeId: entry.recipeId,
        sourceKey: entry.sourceKey,
      };
    }
    if (entry.status === 'no-match'
      && Array.isArray(entry.relaxations)
      && Object.keys(entry).length === 4) {
      const relaxations = entry.relaxations.map(parseRelaxation);
      if (relaxations.some((item) => item === null)) {
        throw new Error('Invalid catalogue selection response.');
      }
      return {
        date: entry.date,
        mealType: entry.mealType,
        status: 'no-match',
        relaxations: relaxations as Relaxation[],
      };
    }
    throw new Error('Invalid catalogue selection response.');
  });
  return { slots };
}

const firebaseInvoke: Invoke = async (data) => {
  const [{ httpsCallable }, { functions }] = await Promise.all([
    import('firebase/functions'),
    import('../config/firebase'),
  ]);
  const response = await httpsCallable<CatalogueSelectionRequest, unknown>(
    functions,
    'selectCatalogueRecipes',
  )(data);
  return { data: response.data };
};

export function createCatalogueClient(invoke: Invoke = firebaseInvoke) {
  return {
    async select(request: CatalogueSelectionRequest): Promise<CatalogueSelectionResponse> {
      const response = await invoke(request);
      return parseResponse(response.data, request);
    },
  };
}

const firebaseMetadataInvoke: MetadataInvoke = async (data) => {
  const [{ httpsCallable }, { functions }] = await Promise.all([
    import('firebase/functions'),
    import('../config/firebase'),
  ]);
  const response = await httpsCallable<CatalogueMetadataRequest, unknown>(
    functions,
    'updateCanonicalRecipeMetadata',
  )(data);
  return { data: response.data };
};

export function createCatalogueMetadataClient(invoke: MetadataInvoke = firebaseMetadataInvoke) {
  return {
    async updateLabels(
      recipeId: string,
      course: readonly string[],
      tags: readonly string[],
    ): Promise<void> {
      if (!recipeId.trim() || recipeId.length > 160) throw new Error('Invalid recipe.');
      await invoke({
        recipeId,
        operations: buildCatalogueMetadataOperations(course, tags),
      });
    },
  };
}

export const catalogueMetadataClient = createCatalogueMetadataClient();

function relaxationMessage(relaxation: Relaxation): string {
  if (relaxation.filter === 'maxTotalMinutes') {
    return `${relaxation.matchCount} match${relaxation.matchCount === 1 ? '' : 'es'} at 45 minutes`;
  }
  if (relaxation.filter === 'modifier') {
    return `${relaxation.matchCount} without ${relaxation.value}`;
  }
  if (relaxation.filter === 'cuisine') {
    return `${relaxation.matchCount} without ${relaxation.value}`;
  }
  if (relaxation.filter === 'mustIngredient') {
    return `${relaxation.matchCount} without requiring ${relaxation.value}`;
  }
  return `${relaxation.matchCount} if ${relaxation.value} is allowed`;
}

export class CatalogueNoMatchError extends Error {
  constructor(public readonly slots: NoMatchSlot[]) {
    const suggestions = slots
      .flatMap((slot) => slot.relaxations.slice(0, 2).map(relaxationMessage))
      .slice(0, 3);
    super(suggestions.length
      ? `No exact recipe match. Try ${suggestions.join(', ')}.`
      : 'No exact recipe match. Remove one filter and try again.');
    this.name = 'CatalogueNoMatchError';
  }
}

export async function materializeCatalogueMeals(
  response: CatalogueSelectionResponse,
  loadRecipe: LoadRecipe,
  servings: number,
): Promise<GeneratedMeal[]> {
  const noMatches = response.slots.filter((slot): slot is NoMatchSlot => slot.status === 'no-match');
  if (noMatches.length) throw new CatalogueNoMatchError(noMatches);

  return Promise.all(response.slots.map(async (slot) => {
    if (slot.status !== 'selected') throw new CatalogueNoMatchError([slot]);
    const recipe = await loadRecipe(slot.recipeId);
    if (!recipe || recipe.schemaVersion !== 2 || recipe.catalogueStatus !== 'ready') {
      throw new Error('Selected catalogue recipe is unavailable.');
    }
    return {
      recipe,
      recipeId: slot.recipeId,
      date: slot.date,
      mealType: slot.mealType,
      isFromFavourites: false,
      servings,
    };
  }));
}

export const catalogueClient = createCatalogueClient();
