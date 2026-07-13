import { z } from 'zod';

export const shortText = z.string().trim().min(1).max(200);
export const ingredientName = z.string().trim().min(1).max(120);

const recipeId = z.string().trim().min(1).max(160);
const recipeStep = z.string().trim().min(1).max(300);
const ingredientUnit = z.string().trim().max(40);

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
  recipes: z.array(recipeInput).min(1).max(25),
});

const reminderRecipeInput = recipeInput.pick({
  recipeId: true,
  title: true,
  ingredients: true,
  steps: true,
});

export const reminderFlagsRequest = householdRequest.extend({
  recipes: z.array(reminderRecipeInput).min(1).max(25),
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
  ingredients: z.array(rawIngredientSchema).min(1).max(500),
});

export const substitutionsRequest = householdRequest.extend({
  ingredientName,
  ingredientUnit,
  recipeTitle: shortText,
  allIngredients: z.array(ingredientName).min(1).max(100),
});

const recipeTag = z.enum([
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
            tags: z.array(recipeTag).max(14),
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
  'Oils',
  'Sauces & Condiments',
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

export type TagRecipesInput = z.infer<typeof tagRecipesRequest>;
export type ReminderFlagsInput = z.infer<typeof reminderFlagsRequest>;
export type ShoppingGroupsInput = z.infer<typeof shoppingGroupsRequest>;
export type SubstitutionsInput = z.infer<typeof substitutionsRequest>;
