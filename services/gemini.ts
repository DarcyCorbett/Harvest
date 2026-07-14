import {
  aiClient,
  canonicalizeHouseholdId,
  type RecipeAiInput,
  type ReminderRecipeAiInput,
} from './aiClient';
import type { Recipe } from './types';

interface RecipeRequest {
  recipeId: string;
  recipe: Recipe;
}

const BATCH_SIZE = 25;

function boundedRequiredText(value: string, max: number, label: string): string {
  const normalized = value.trim().slice(0, max);
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function boundedTextList(values: string[], maxItems: number, maxLength: number): string[] {
  return values
    .map((value) => value.trim().slice(0, maxLength))
    .filter((value) => value.length > 0)
    .slice(0, maxItems);
}

function totalMinutesOf(recipe: Recipe): number | null {
  if (!recipe.totalTime) return null;
  const parsed = Number.parseInt(recipe.totalTime, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.min(10_080, Math.floor(parsed));
}

function normalizeRecipeInput({ recipeId, recipe }: RecipeRequest): RecipeAiInput {
  return {
    recipeId: boundedRequiredText(recipeId, 160, 'Recipe ID'),
    title: boundedRequiredText(recipe.title, 200, 'Recipe title'),
    totalMinutes: totalMinutesOf(recipe),
    ingredients: boundedTextList(
      recipe.ingredients.map(({ name }) => name),
      100,
      120,
    ),
    steps: boundedTextList(
      recipe.instructions.map(({ text }) => text),
      40,
      300,
    ),
    existingTags: boundedTextList(recipe.tags ?? [], 30, 200),
  };
}

function requireUniqueRecipeIds(recipes: { recipeId: string }[]): void {
  const ids = new Set<string>();
  for (const { recipeId } of recipes) {
    if (ids.has(recipeId)) throw new Error('Duplicate recipe IDs');
    ids.add(recipeId);
  }
}

function batchesOf<T>(values: T[]): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < values.length; index += BATCH_SIZE) {
    batches.push(values.slice(index, index + BATCH_SIZE));
  }
  return batches;
}

export async function tagRecipesWithGemini(
  householdId: string,
  recipes: RecipeRequest[],
): Promise<Map<string, string[]>> {
  const household = canonicalizeHouseholdId(householdId);
  if (recipes.length === 0) return new Map();

  const normalized = recipes.map(normalizeRecipeInput);
  requireUniqueRecipeIds(normalized);

  const output = new Map<string, string[]>();
  for (const batch of batchesOf(normalized)) {
    const response = await aiClient.tagRecipes(household, batch);
    const requested = new Set(batch.map(({ recipeId }) => recipeId));
    const returned = new Set<string>();
    for (const result of response.results) {
      if (!requested.has(result.id) || returned.has(result.id)) {
        throw new Error('Invalid response from tagRecipes');
      }
      returned.add(result.id);
      output.set(result.id, result.tags);
    }
  }
  return output;
}

export async function getGeminiReminderFlags(
  householdId: string,
  recipes: RecipeRequest[],
): Promise<Map<string, { needsDefrost: boolean; needsMarinate: boolean }>> {
  const household = canonicalizeHouseholdId(householdId);
  if (recipes.length === 0) return new Map();

  const normalized: ReminderRecipeAiInput[] = recipes.map((recipe) => {
    const input = normalizeRecipeInput(recipe);
    return {
      recipeId: input.recipeId,
      title: input.title,
      ingredients: input.ingredients,
      steps: input.steps,
    };
  });
  requireUniqueRecipeIds(normalized);

  const output = new Map<string, { needsDefrost: boolean; needsMarinate: boolean }>();
  for (const batch of batchesOf(normalized)) {
    const response = await aiClient.reminderFlags(household, batch);
    const requested = new Set(batch.map(({ recipeId }) => recipeId));
    const returned = new Set<string>();
    for (const result of response.results) {
      if (!requested.has(result.id) || returned.has(result.id)) {
        throw new Error('Invalid response from reminderFlags');
      }
      returned.add(result.id);
      output.set(result.id, {
        needsDefrost: result.needsDefrost,
        needsMarinate: result.needsMarinate,
      });
    }
  }
  return output;
}
