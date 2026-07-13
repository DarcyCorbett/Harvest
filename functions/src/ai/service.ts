import { z } from 'zod';

import {
  reminderFlagsResponse,
  shoppingGroupsResponse,
  substitutionsResponse,
  tagRecipesResponse,
  type ReminderFlagsInput,
  type ShoppingGroupsInput,
  type SubstitutionsInput,
  type TagRecipesInput,
} from './contracts.js';
import {
  buildReminderFlagsPrompt,
  buildShoppingGroupsPrompt,
  buildSubstitutionsPrompt,
  buildTagRecipesPrompt,
} from './prompts.js';

const FLASH_LITE_MODEL = 'gemini-3.1-flash-lite';
const FLASH_MODEL = 'gemini-3.5-flash';

export interface JsonRequester {
  requestJson(
    model: string,
    prompt: string,
    maxOutputTokens: number,
  ): Promise<unknown>;
}

class AiServiceError extends Error {
  constructor(
    code:
      | 'provider-output-invalid'
      | 'provider-id-coverage-mismatch'
      | 'request-id-duplicates',
  ) {
    super(code);
    this.name = 'AiServiceError';
  }
}

function parseProviderOutput<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new AiServiceError('provider-output-invalid');
  }
  return parsed.data;
}

function frequencyMap<T extends string | number>(values: readonly T[]): Map<T, number> {
  const frequencies = new Map<T, number>();
  for (const value of values) {
    frequencies.set(value, (frequencies.get(value) ?? 0) + 1);
  }
  return frequencies;
}

function hasExactMultiset<T extends string | number>(
  expected: readonly T[],
  actual: readonly T[],
): boolean {
  if (expected.length !== actual.length) return false;

  const expectedFrequencies = frequencyMap(expected);
  const actualFrequencies = frequencyMap(actual);
  if (expectedFrequencies.size !== actualFrequencies.size) return false;

  for (const [value, count] of expectedFrequencies) {
    if (actualFrequencies.get(value) !== count) return false;
  }
  return true;
}

function requireExactCoverage<T extends string | number>(
  expected: readonly T[],
  actual: readonly T[],
): void {
  if (!hasExactMultiset(expected, actual)) {
    throw new AiServiceError('provider-id-coverage-mismatch');
  }
}

function requireUniqueInputIds<T, Identifier extends string | number>(
  values: readonly T[],
  identifierOf: (value: T) => Identifier,
): void {
  const seen = new Set<Identifier>();
  for (const value of values) {
    const identifier = identifierOf(value);
    if (seen.has(identifier)) {
      throw new AiServiceError('request-id-duplicates');
    }
    seen.add(identifier);
  }
}

export function createAiService(provider: JsonRequester) {
  return {
    async tagRecipes(recipes: TagRecipesInput['recipes']) {
      requireUniqueInputIds(recipes, ({ recipeId }) => recipeId);
      const output = await provider.requestJson(
        FLASH_LITE_MODEL,
        buildTagRecipesPrompt(recipes),
        Math.min(32_000, 4_096 + recipes.length * 400),
      );
      const parsed = parseProviderOutput(tagRecipesResponse, output);
      requireExactCoverage(
        recipes.map(({ recipeId }) => recipeId),
        parsed.results.map(({ id }) => id),
      );
      return parsed;
    },

    async reminderFlags(recipes: ReminderFlagsInput['recipes']) {
      requireUniqueInputIds(recipes, ({ recipeId }) => recipeId);
      const output = await provider.requestJson(
        FLASH_LITE_MODEL,
        buildReminderFlagsPrompt(recipes),
        Math.min(8_000, 1_024 + recipes.length * 200),
      );
      const parsed = parseProviderOutput(reminderFlagsResponse, output);
      requireExactCoverage(
        recipes.map(({ recipeId }) => recipeId),
        parsed.results.map(({ id }) => id),
      );
      return parsed;
    },

    async shoppingGroups(ingredients: ShoppingGroupsInput['ingredients']) {
      requireUniqueInputIds(ingredients, ({ id }) => id);
      const output = await provider.requestJson(
        FLASH_MODEL,
        buildShoppingGroupsPrompt(ingredients),
        Math.min(65_536, 4_096 + ingredients.length * 200),
      );
      const parsed = parseProviderOutput(shoppingGroupsResponse, output);
      requireExactCoverage(
        ingredients.map(({ id }) => id),
        parsed.flatMap(({ sourceIds }) => sourceIds),
      );
      return parsed;
    },

    async substitutions(input: Omit<SubstitutionsInput, 'householdId'>) {
      const output = await provider.requestJson(
        FLASH_LITE_MODEL,
        buildSubstitutionsPrompt(input),
        600,
      );
      return parseProviderOutput(substitutionsResponse, output);
    },
  };
}
