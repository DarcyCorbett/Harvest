import { z } from 'zod';

export const shortText = z.string().trim().min(1).max(200);
export const ingredientName = z.string().trim().min(1).max(120);

const recipeId = z.string().trim().min(1).max(160);
const recipeStep = z.string().trim().min(1).max(300);
const ingredientUnit = z.string().trim().max(40);

function requireUniqueIdentifiers<T, Identifier extends string | number>(
  values: T[],
  identifierOf: (value: T) => Identifier,
  context: z.RefinementCtx,
): void {
  const seen = new Set<Identifier>();
  for (const value of values) {
    const identifier = identifierOf(value);
    if (seen.has(identifier)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Duplicate request identifiers.',
      });
      return;
    }
    seen.add(identifier);
  }
}

export const recipeInput = z
  .object({
    recipeId,
    title: shortText,
    totalMinutes: z.number().int().positive().max(10_080).nullable(),
    ingredients: z.array(ingredientName).max(100),
    steps: z.array(recipeStep).max(40),
    existingTags: z.array(shortText).max(30),
  })
  .strict();

export const householdRequest = z
  .object({
    householdId: z.string().trim().min(1).max(128),
  })
  .strict();

export const tagRecipesRequest = householdRequest.extend({
  recipes: z
    .array(recipeInput)
    .min(1)
    .max(25)
    .superRefine((recipes, context) =>
      requireUniqueIdentifiers(recipes, ({ recipeId }) => recipeId, context)),
});

const reminderRecipeInput = recipeInput.pick({
  recipeId: true,
  title: true,
  ingredients: true,
  steps: true,
});

export const reminderFlagsRequest = householdRequest.extend({
  recipes: z
    .array(reminderRecipeInput)
    .min(1)
    .max(25)
    .superRefine((recipes, context) =>
      requireUniqueIdentifiers(recipes, ({ recipeId }) => recipeId, context)),
});

export const rawIngredientSchema = z
  .object({
    id: z.number().int().min(0).max(9_999),
    name: ingredientName,
    quantity: z.number().finite().min(0).max(1_000_000),
    unit: ingredientUnit,
  })
  .strict();

export const shoppingGroupsRequest = householdRequest.extend({
  ingredients: z
    .array(rawIngredientSchema)
    .min(1)
    .max(500)
    .superRefine((ingredients, context) =>
      requireUniqueIdentifiers(ingredients, ({ id }) => id, context)),
});

export const substitutionsRequest = householdRequest.extend({
  ingredientName,
  ingredientUnit,
  recipeTitle: shortText,
  allIngredients: z.array(ingredientName).min(1).max(100),
});

export const legacyTag = z.enum([
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
]);

export const tagRecipesResponse = z
  .object({
    results: z
      .array(
        z
          .object({
            id: recipeId,
            tags: z.array(legacyTag).max(14),
          })
          .strict(),
      )
      .max(25),
  })
  .strict();

export const reminderFlagsResponse = z
  .object({
    results: z
      .array(
        z
          .object({
            id: recipeId,
            needsDefrost: z.boolean(),
            needsMarinate: z.boolean(),
          })
          .strict(),
      )
      .max(25),
  })
  .strict();

const shoppingCategory = z.enum([
  'Produce',
  'Meat & Seafood',
  'Dairy & Eggs',
  'Pantry & Dry Goods',
  'Herbs & Spices',
  'Oils, Sauces & Condiments',
  'Bread & Bakery',
  'Frozen',
  'Other',
]);

export const shoppingGroupsResponse = z
  .array(
    z
      .object({
        canonicalName: ingredientName,
        category: shoppingCategory,
        sourceIds: z
          .array(z.number().int().min(0).max(9_999))
          .min(1)
          .max(500),
        unit: ingredientUnit.optional(),
      })
      .strict(),
  )
  .max(500);

export const substitutionsResponse = z
  .object({
    substitutions: z
      .array(
        z
          .object({
            name: ingredientName,
            adjustment: z.string().trim().min(1).max(160),
            reason: z.string().trim().min(1).max(300),
          })
          .strict(),
      )
      .length(3),
  })
  .strict();

export type AiEndpoint =
  | 'tagRecipes'
  | 'reminderFlags'
  | 'shoppingGroups'
  | 'substitutions';

export const MAX_LEGACY_RECIPE_BYTES = 900 * 1024;
export const MAX_LEGACY_RECIPE_INGREDIENTS = 400;

const httpsUrl = z
  .string()
  .url()
  .max(2_048)
  .refine((value) => new URL(value).protocol === 'https:', 'HTTPS URL required');
const optionalHttpsUrl = httpsUrl.optional();
const legacyIngredient = z
  .object({
    name: ingredientName,
    quantity: z.number().finite().min(0).max(1_000_000),
    unit: z.string().max(40),
    notes: z.string().max(300).optional(),
  })
  .strict();
const legacyInstruction = z
  .object({
    text: z.string().trim().min(1).max(5_000),
    imageUrl: optionalHttpsUrl,
    videoEmbedUrl: optionalHttpsUrl,
    isHeader: z.boolean().optional(),
  })
  .strict();

export const legacyRecipeSchema = z
  .object({
    title: shortText,
    sourceUrl: z.string().url().max(2_048),
    imageUrl: optionalHttpsUrl,
    videoEmbedUrl: optionalHttpsUrl,
    prepTime: z.string().max(80),
    cookTime: z.string().max(80),
    totalTime: z.string().max(80).optional(),
    originalServings: z.number().positive().max(10_000),
    course: z.array(shortText).max(20).optional(),
    tags: z.array(legacyTag).max(14).optional(),
    description: z.string().max(5_000).optional(),
    cuisine: z.string().max(100).optional(),
    difficulty: z.string().max(100).optional(),
    ingredients: z.array(legacyIngredient).min(1).max(200),
    ingredientGroups: z
      .array(
        z
          .object({
            name: z.string().max(200),
            ingredients: z.array(legacyIngredient).max(200),
          })
          .strict(),
      )
      .max(30)
      .optional(),
    instructions: z.array(legacyInstruction).min(1).max(150),
    notes: z.string().max(20_000),
    nutrition: z
      .object({
        calories: z.number().finite().min(0).max(1_000_000),
        protein: z.number().finite().min(0).max(1_000_000),
        carbs: z.number().finite().min(0).max(1_000_000),
        fat: z.number().finite().min(0).max(1_000_000),
      })
      .strict(),
    needsDefrost: z.boolean().optional(),
    needsMarinate: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const aggregateIngredientCount = value.ingredients.length
      + (value.ingredientGroups ?? []).reduce(
        (count, group) => count + group.ingredients.length,
        0,
      );
    if (aggregateIngredientCount > MAX_LEGACY_RECIPE_INGREDIENTS) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ingredientGroups'],
        message: 'Too many aggregate ingredients.',
      });
    }

    if (
      Buffer.byteLength(JSON.stringify(value), 'utf8')
      > MAX_LEGACY_RECIPE_BYTES
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Recipe payload is too large.',
      });
    }
  });

export const saveLegacyRecipeRequest = householdRequest
  .extend({ recipe: legacyRecipeSchema })
  .strict();

export const updateLegacyRecipeMetadataRequest = householdRequest
  .extend({
    recipeId: z.string().trim().min(1).max(160),
    course: z.array(shortText).max(20).optional(),
    tags: z.array(legacyTag).max(14).optional(),
    needsDefrost: z.boolean().optional(),
    needsMarinate: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.course !== undefined
      || value.tags !== undefined
      || value.needsDefrost !== undefined
      || value.needsMarinate !== undefined,
    'At least one metadata field is required',
  );

export type QuotaEndpoint =
  | AiEndpoint
  | 'legacyRecipeCreate'
  | 'legacyRecipeMetadata';

export type TagRecipesInput = z.infer<typeof tagRecipesRequest>;
export type ReminderFlagsInput = z.infer<typeof reminderFlagsRequest>;
export type ShoppingGroupsInput = z.infer<typeof shoppingGroupsRequest>;
export type SubstitutionsInput = z.infer<typeof substitutionsRequest>;
