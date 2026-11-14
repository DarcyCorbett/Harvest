import { z } from 'zod';

import {
  reminderFlagsRequest,
  reminderFlagsResponse,
  shoppingGroupsRequest,
  shoppingGroupsResponse,
  substitutionsRequest,
  substitutionsResponse,
  tagRecipesRequest,
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
import {
  REMINDER_QUESTIONS,
  TAG_QUESTIONS,
  buildReminderDecisionInput,
  buildTagDecisionInput,
  composeReminders,
  composeTags,
  mapInParallel,
  type DecisionAnswers,
  type DecisionQuestion,
} from './decision.js';
import { RECIPE_LABEL_ENGINE, RECIPE_MODEL, SHOPPING_MODEL } from './models.js';

const INTERNAL_HOUSEHOLD_ID = 'internal-ai-service';
const DUPLICATE_IDENTIFIER_MESSAGE = 'Duplicate request identifiers.';
/** Decision requests in flight per call. One request labels one recipe. */
const DECISION_LANES = 8;

export interface JsonRequester {
  requestJson(
    model: string,
    prompt: string,
    maxOutputTokens: number,
  ): Promise<unknown>;
  /**
   * Yes/no and choice decisions about one input (gemini-decision-1). When
   * present and RECIPE_LABEL_ENGINE is 'decision', tags and reminders use it
   * and fall back to requestJson if it fails.
   */
  requestDecisions?(
    input: string,
    questions: Record<string, DecisionQuestion>,
  ): Promise<DecisionAnswers>;
  /** Substitution suggestions (SUBSTITUTION_MODEL). Falls back to requestJson if it fails. */
  requestSubstitutionJson?(prompt: string): Promise<unknown>;
  /** Told when a preferred provider failed and the fallback answered instead. */
  onFallback?(endpoint: 'tagRecipes' | 'reminderFlags' | 'substitutions', reason: string): void;
}

const failureReason = (error: unknown): string =>
  error instanceof Error ? error.message.slice(0, 80) : 'unknown';

class AiServiceError extends Error {
  constructor(
    code:
      | 'provider-output-invalid'
      | 'provider-id-coverage-mismatch'
      | 'request-id-duplicates'
      | 'request-input-invalid',
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

function parseServiceInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const hasDuplicateIdentifiers = parsed.error.issues.some(
      (issue) =>
        issue.code === z.ZodIssueCode.custom
        && issue.message === DUPLICATE_IDENTIFIER_MESSAGE,
    );
    throw new AiServiceError(
      hasDuplicateIdentifiers ? 'request-id-duplicates' : 'request-input-invalid',
    );
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
      const input = parseServiceInput(tagRecipesRequest, {
        householdId: INTERNAL_HOUSEHOLD_ID,
        recipes,
      });
      requireUniqueInputIds(input.recipes, ({ recipeId }) => recipeId);
      const { requestDecisions } = provider;
      if (RECIPE_LABEL_ENGINE === 'decision' && requestDecisions) {
        try {
          const results = await mapInParallel(input.recipes, DECISION_LANES, async (recipe) => ({
            id: recipe.recipeId,
            // The prompt path never repeats a tag the recipe already has.
            tags: composeTags(await requestDecisions(buildTagDecisionInput(recipe), TAG_QUESTIONS))
              .filter((tag) => !recipe.existingTags.includes(tag)),
          }));
          return parseProviderOutput(tagRecipesResponse, { results });
        } catch (error) {
          provider.onFallback?.('tagRecipes', failureReason(error));
        }
      }
      const output = await provider.requestJson(
        RECIPE_MODEL,
        buildTagRecipesPrompt(input.recipes),
        Math.min(32_000, 4_096 + input.recipes.length * 400),
      );
      const parsed = parseProviderOutput(tagRecipesResponse, output);
      requireExactCoverage(
        input.recipes.map(({ recipeId }) => recipeId),
        parsed.results.map(({ id }) => id),
      );
      return parsed;
    },

    async reminderFlags(recipes: ReminderFlagsInput['recipes']) {
      const input = parseServiceInput(reminderFlagsRequest, {
        householdId: INTERNAL_HOUSEHOLD_ID,
        recipes,
      });
      requireUniqueInputIds(input.recipes, ({ recipeId }) => recipeId);
      const { requestDecisions } = provider;
      if (RECIPE_LABEL_ENGINE === 'decision' && requestDecisions) {
        try {
          const results = await mapInParallel(input.recipes, DECISION_LANES, async (recipe) => ({
            id: recipe.recipeId,
            ...composeReminders(await requestDecisions(buildReminderDecisionInput(recipe), REMINDER_QUESTIONS)),
          }));
          return parseProviderOutput(reminderFlagsResponse, { results });
        } catch (error) {
          provider.onFallback?.('reminderFlags', failureReason(error));
        }
      }
      const output = await provider.requestJson(
        RECIPE_MODEL,
        buildReminderFlagsPrompt(input.recipes),
        Math.min(8_000, 1_024 + input.recipes.length * 200),
      );
      const parsed = parseProviderOutput(reminderFlagsResponse, output);
      requireExactCoverage(
        input.recipes.map(({ recipeId }) => recipeId),
        parsed.results.map(({ id }) => id),
      );
      return parsed;
    },

    async shoppingGroups(ingredients: ShoppingGroupsInput['ingredients']) {
      const input = parseServiceInput(shoppingGroupsRequest, {
        householdId: INTERNAL_HOUSEHOLD_ID,
        ingredients,
      });
      requireUniqueInputIds(input.ingredients, ({ id }) => id);
      const output = await provider.requestJson(
        SHOPPING_MODEL,
        buildShoppingGroupsPrompt(input.ingredients),
        // The shopping model thinks before answering and thinking counts as
        // output, so the cap leaves room for both.
        Math.min(65_536, 16_384 + input.ingredients.length * 400),
      );
      const parsed = parseProviderOutput(shoppingGroupsResponse, output);
      requireExactCoverage(
        input.ingredients.map(({ id }) => id),
        parsed.flatMap(({ sourceIds }) => sourceIds),
      );
      return parsed;
    },

    async substitutions(input: Omit<SubstitutionsInput, 'householdId'>) {
      const parsedInput = parseServiceInput(substitutionsRequest, {
        ...input,
        householdId: INTERNAL_HOUSEHOLD_ID,
      });
      const { householdId: _householdId, ...normalizedInput } = parsedInput;
      if (provider.requestSubstitutionJson) {
        try {
          return parseProviderOutput(
            substitutionsResponse,
            await provider.requestSubstitutionJson(buildSubstitutionsPrompt(normalizedInput)),
          );
        } catch (error) {
          provider.onFallback?.('substitutions', failureReason(error));
        }
      }
      const output = await provider.requestJson(
        RECIPE_MODEL,
        buildSubstitutionsPrompt(normalizedInput),
        600,
      );
      return parseProviderOutput(substitutionsResponse, output);
    },
  };
}
