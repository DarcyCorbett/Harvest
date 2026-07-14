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

function isBoundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function isRecipeId(value: unknown): value is string {
  return isBoundedText(value, 160);
}

function isTagRecipesResponse(value: unknown): value is TagRecipesResponse {
  if (!isRecord(value) || !Array.isArray(value.results) || value.results.length > 25) return false;
  return value.results.every(
    (entry) =>
      isRecord(entry) &&
      isRecipeId(entry.id) &&
      Array.isArray(entry.tags) &&
      entry.tags.length <= 14 &&
      entry.tags.every((tag) => typeof tag === 'string' && RECIPE_TAGS.has(tag as RecipeTag)),
  );
}

function isReminderFlagsResponse(value: unknown): value is ReminderFlagsResponse {
  if (!isRecord(value) || !Array.isArray(value.results) || value.results.length > 25) return false;
  return value.results.every(
    (entry) =>
      isRecord(entry) &&
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
      isBoundedText(group.canonicalName, 120) &&
      typeof group.category === 'string' &&
      SHOPPING_CATEGORIES.has(group.category as ShoppingCategoryResponse) &&
      Array.isArray(group.sourceIds) &&
      group.sourceIds.length > 0 &&
      group.sourceIds.length <= 500 &&
      group.sourceIds.every(
        (id) => Number.isInteger(id) && id >= 0 && id <= 9_999,
      ) &&
      (group.unit === undefined ||
        (typeof group.unit === 'string' && group.unit.trim().length <= 40)),
  );
}

function isSubstitutionsResponse(value: unknown): value is SubstitutionsResponse {
  if (!isRecord(value) || !Array.isArray(value.substitutions)) return false;
  if (value.substitutions.length !== 3) return false;
  return value.substitutions.every(
    (substitution) =>
      isRecord(substitution) &&
      isBoundedText(substitution.name, 120) &&
      isBoundedText(substitution.adjustment, 160) &&
      isBoundedText(substitution.reason, 300),
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

export function createAiClient(invoke: AiInvoke = firebaseInvoke) {
  return {
    async tagRecipes(
      householdId: string,
      recipes: RecipeAiInput[],
    ): Promise<TagRecipesResponse> {
      const data = await invoke('tagRecipes', {
        householdId: canonicalizeHouseholdId(householdId),
        recipes,
      });
      return isTagRecipesResponse(data) ? data : invalidResponse('tagRecipes');
    },

    async reminderFlags(
      householdId: string,
      recipes: ReminderRecipeAiInput[],
    ): Promise<ReminderFlagsResponse> {
      const data = await invoke('reminderFlags', {
        householdId: canonicalizeHouseholdId(householdId),
        recipes,
      });
      return isReminderFlagsResponse(data) ? data : invalidResponse('reminderFlags');
    },

    async shoppingGroups(
      householdId: string,
      ingredients: ShoppingIngredientAiInput[],
    ): Promise<ShoppingGroupResponse[]> {
      const data = await invoke('shoppingGroups', {
        householdId: canonicalizeHouseholdId(householdId),
        ingredients,
      });
      return isShoppingGroupsResponse(data) ? data : invalidResponse('shoppingGroups');
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
