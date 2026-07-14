export type AiEndpoint =
  | 'tagRecipes'
  | 'reminderFlags'
  | 'shoppingGroups'
  | 'substitutions';

export interface RecipeAiInput {
  recipeId: string;
  title: string;
  totalMinutes: number | null;
  ingredients: string[];
  steps: string[];
  existingTags: string[];
}

export type ReminderRecipeAiInput = Omit<RecipeAiInput, 'totalMinutes' | 'existingTags'>;

export interface ShoppingIngredientAiInput {
  id: number;
  name: string;
  quantity: number;
  unit: string;
}

export interface SubstitutionAiInput {
  ingredientName: string;
  ingredientUnit: string;
  recipeTitle: string;
  allIngredients: string[];
}

export interface TagRecipesResponse {
  results: { id: string; tags: RecipeTag[] }[];
}

export interface ReminderFlagsResponse {
  results: { id: string; needsDefrost: boolean; needsMarinate: boolean }[];
}

export interface ShoppingGroupResponse {
  canonicalName: string;
  category: ShoppingCategoryResponse;
  sourceIds: number[];
  unit?: string;
}

export interface SubstitutionResultResponse {
  name: string;
  adjustment: string;
  reason: string;
}

export interface SubstitutionsResponse {
  substitutions: SubstitutionResultResponse[];
}

export type AiInvoke = (endpoint: AiEndpoint, data: unknown) => Promise<unknown>;

const RECIPE_TAGS = new Set([
  'Breakfast',
  'Lunch',
  'Dinner',
  'Side',
  'Snack',
  'Salad',
  'Asian',
  'Mexican',
  'Mediterranean',
  'Italian',
  'Indian',
  'Healthy',
  'Vegetarian',
  'Kid Friendly',
] as const);

type RecipeTag =
  | 'Breakfast'
  | 'Lunch'
  | 'Dinner'
  | 'Side'
  | 'Snack'
  | 'Salad'
  | 'Asian'
  | 'Mexican'
  | 'Mediterranean'
  | 'Italian'
  | 'Indian'
  | 'Healthy'
  | 'Vegetarian'
  | 'Kid Friendly';

const SHOPPING_CATEGORIES = new Set([
  'Produce',
  'Meat & Seafood',
  'Dairy & Eggs',
  'Pantry & Dry Goods',
  'Herbs & Spices',
  'Oils, Sauces & Condiments',
  'Bread & Bakery',
  'Frozen',
  'Other',
] as const);

type ShoppingCategoryResponse =
  | 'Produce'
  | 'Meat & Seafood'
  | 'Dairy & Eggs'
  | 'Pantry & Dry Goods'
  | 'Herbs & Spices'
  | 'Oils, Sauces & Condiments'
  | 'Bread & Bakery'
  | 'Frozen'
  | 'Other';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactEnumerableKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Reflect.ownKeys(value).filter((key) =>
    Object.prototype.propertyIsEnumerable.call(value, key),
  );
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((requiredKey) => keys.includes(requiredKey)) &&
    keys.every((key) => typeof key === 'string' && allowed.has(key))
  );
}

function isTrimmedText(value: unknown, min: number, max: number): value is string {
  return (
    typeof value === 'string' &&
    value === value.trim() &&
    value.length >= min &&
    value.length <= max
  );
}

function isRecipeId(value: unknown): value is string {
  return isTrimmedText(value, 1, 160);
}

function isShoppingId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 9_999;
}

function hasValidUniqueIds<Id extends string | number>(
  ids: readonly Id[],
  isValid: (value: unknown) => boolean,
): boolean {
  const seen = new Set<Id>();
  for (const id of ids) {
    if (!isValid(id) || seen.has(id)) return false;
    seen.add(id);
  }
  return true;
}

function hasExactIdCoverage<Id extends string | number>(
  requestedIds: readonly Id[],
  responseIds: readonly Id[],
): boolean {
  if (requestedIds.length !== responseIds.length) return false;
  const requested = new Set(requestedIds);
  const returned = new Set<Id>();
  for (const id of responseIds) {
    if (!requested.has(id) || returned.has(id)) return false;
    returned.add(id);
  }
  return returned.size === requested.size;
}

function isTagRecipesResponse(value: unknown): value is TagRecipesResponse {
  if (
    !isRecord(value) ||
    !hasExactEnumerableKeys(value, ['results']) ||
    !Array.isArray(value.results) ||
    value.results.length > 25
  ) {
    return false;
  }
  return value.results.every(
    (entry) =>
      isRecord(entry) &&
      hasExactEnumerableKeys(entry, ['id', 'tags']) &&
      isRecipeId(entry.id) &&
      Array.isArray(entry.tags) &&
      entry.tags.length <= 14 &&
      entry.tags.every((tag) => typeof tag === 'string' && RECIPE_TAGS.has(tag as RecipeTag)),
  );
}

function isReminderFlagsResponse(value: unknown): value is ReminderFlagsResponse {
  if (
    !isRecord(value) ||
    !hasExactEnumerableKeys(value, ['results']) ||
    !Array.isArray(value.results) ||
    value.results.length > 25
  ) {
    return false;
  }
  return value.results.every(
    (entry) =>
      isRecord(entry) &&
      hasExactEnumerableKeys(entry, ['id', 'needsDefrost', 'needsMarinate']) &&
      isRecipeId(entry.id) &&
      typeof entry.needsDefrost === 'boolean' &&
      typeof entry.needsMarinate === 'boolean',
  );
}

function isShoppingGroupsResponse(value: unknown): value is ShoppingGroupResponse[] {
  if (!Array.isArray(value) || value.length > 500) return false;
  return value.every(
    (group) =>
      isRecord(group) &&
      hasExactEnumerableKeys(group, ['canonicalName', 'category', 'sourceIds'], ['unit']) &&
      isTrimmedText(group.canonicalName, 1, 120) &&
      typeof group.category === 'string' &&
      SHOPPING_CATEGORIES.has(group.category as ShoppingCategoryResponse) &&
      Array.isArray(group.sourceIds) &&
      group.sourceIds.length > 0 &&
      group.sourceIds.length <= 500 &&
      group.sourceIds.every(isShoppingId) &&
      new Set(group.sourceIds).size === group.sourceIds.length &&
      (group.unit === undefined ||
        isTrimmedText(group.unit, 0, 40)),
  );
}

function isSubstitutionsResponse(value: unknown): value is SubstitutionsResponse {
  if (
    !isRecord(value) ||
    !hasExactEnumerableKeys(value, ['substitutions']) ||
    !Array.isArray(value.substitutions)
  ) {
    return false;
  }
  if (value.substitutions.length !== 3) return false;
  return value.substitutions.every(
    (substitution) =>
      isRecord(substitution) &&
      hasExactEnumerableKeys(substitution, ['name', 'adjustment', 'reason']) &&
      isTrimmedText(substitution.name, 1, 120) &&
      isTrimmedText(substitution.adjustment, 1, 160) &&
      isTrimmedText(substitution.reason, 1, 300),
  );
}

export function canonicalizeHouseholdId(householdId: string): string {
  const canonical = householdId.trim();
  if (!canonical) throw new Error('Household is required');
  return canonical;
}

const firebaseInvoke: AiInvoke = async (endpoint, data) => {
  const [{ httpsCallable }, { functions }] = await Promise.all([
    import('firebase/functions'),
    import('../config/firebase'),
  ]);
  const callable = httpsCallable<unknown, unknown>(functions, endpoint);
  const response = await callable(data);
  return response.data;
};

function invalidResponse(endpoint: AiEndpoint): never {
  throw new Error(`Invalid response from ${endpoint}`);
}

function invalidRequest(endpoint: AiEndpoint): never {
  throw new Error(`Invalid request for ${endpoint}`);
}

export function createAiClient(invoke: AiInvoke = firebaseInvoke) {
  return {
    async tagRecipes(
      householdId: string,
      recipes: RecipeAiInput[],
    ): Promise<TagRecipesResponse> {
      const requestedIds = recipes.map(({ recipeId }) => recipeId);
      if (!hasValidUniqueIds(requestedIds, isRecipeId)) invalidRequest('tagRecipes');
      const data = await invoke('tagRecipes', {
        householdId: canonicalizeHouseholdId(householdId),
        recipes,
      });
      if (
        !isTagRecipesResponse(data) ||
        !hasExactIdCoverage(requestedIds, data.results.map(({ id }) => id))
      ) {
        invalidResponse('tagRecipes');
      }
      return data;
    },

    async reminderFlags(
      householdId: string,
      recipes: ReminderRecipeAiInput[],
    ): Promise<ReminderFlagsResponse> {
      const requestedIds = recipes.map(({ recipeId }) => recipeId);
      if (!hasValidUniqueIds(requestedIds, isRecipeId)) invalidRequest('reminderFlags');
      const data = await invoke('reminderFlags', {
        householdId: canonicalizeHouseholdId(householdId),
        recipes,
      });
      if (
        !isReminderFlagsResponse(data) ||
        !hasExactIdCoverage(requestedIds, data.results.map(({ id }) => id))
      ) {
        invalidResponse('reminderFlags');
      }
      return data;
    },

    async shoppingGroups(
      householdId: string,
      ingredients: ShoppingIngredientAiInput[],
    ): Promise<ShoppingGroupResponse[]> {
      const requestedIds = ingredients.map(({ id }) => id);
      if (!hasValidUniqueIds(requestedIds, isShoppingId)) invalidRequest('shoppingGroups');
      const data = await invoke('shoppingGroups', {
        householdId: canonicalizeHouseholdId(householdId),
        ingredients,
      });
      if (
        !isShoppingGroupsResponse(data) ||
        !hasExactIdCoverage(requestedIds, data.flatMap(({ sourceIds }) => sourceIds))
      ) {
        invalidResponse('shoppingGroups');
      }
      return data;
    },

    async substitutions(
      householdId: string,
      input: SubstitutionAiInput,
    ): Promise<SubstitutionsResponse> {
      const data = await invoke('substitutions', {
        householdId: canonicalizeHouseholdId(householdId),
        ...input,
      });
      return isSubstitutionsResponse(data) ? data : invalidResponse('substitutions');
    },
  };
}

export const aiClient = createAiClient();
