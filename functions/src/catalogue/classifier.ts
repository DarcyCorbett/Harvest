import { z } from 'zod';

import {
  CUISINES,
  MEAL_TYPES,
  MODIFIERS,
  type CompleteCanonicalRecipeV2,
  type Cuisine,
  type MealType,
  type Modifier,
  type RecipeMetadata,
} from './domain.js';
import type { CatalogueClassification } from './ingestion.js';

const responseSchema = z.object({
  mealTypes: z.array(z.enum(MEAL_TYPES)).min(1).max(MEAL_TYPES.length),
  cuisines: z.array(z.enum(CUISINES)).min(1).max(CUISINES.length),
  modifiers: z.array(z.enum(MODIFIERS)).max(MODIFIERS.length),
}).strict();

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function deterministicRules(content: CompleteCanonicalRecipeV2['content']): {
  mealTypes: MealType[];
  cuisines: Cuisine[];
  modifiers: Modifier[];
} {
  const title = content.title.toLowerCase();
  const mealTypes: MealType[] = [];
  if (/\b(breakfast|brunch|pancake|granola|omelette|omelet)\b/.test(title)) mealTypes.push('breakfast');
  if (/\b(snack|cookie|cookies|biscuit|bites)\b/.test(title)) mealTypes.push('snack');
  if (/\b(side dish|side salad|condiment)\b/.test(title)) mealTypes.push('side');

  const cuisines: Cuisine[] = [];
  const cuisineRules: Array<[Cuisine, RegExp]> = [
    ['mediterranean', /\bmediterranean\b/],
    ['italian', /\bitalian\b/],
    ['indian', /\bindian\b/],
    ['mexican', /\b(mexican|tex-mex)\b/],
    ['greek', /\bgreek\b/],
    ['french', /\bfrench\b/],
    ['asian', /\b(asian|chinese|japanese|thai|korean|vietnamese)\b/],
    ['middle-eastern', /\b(middle eastern|levantine)\b/],
  ];
  for (const [cuisine, pattern] of cuisineRules) {
    if (pattern.test(title)) cuisines.push(cuisine);
  }

  const modifiers: Modifier[] = [];
  if (/\bsalad\b/.test(title)) modifiers.push('salad');
  return { mealTypes, cuisines, modifiers };
}

export function createCatalogueClassifier(dependencies: {
  requestJson(prompt: string): Promise<unknown>;
}) {
  return async (
    content: CompleteCanonicalRecipeV2['content'],
    sourceMetadata: RecipeMetadata,
  ): Promise<CatalogueClassification> => {
    const rules = deterministicRules(content);
    let mealTypes = unique([...(sourceMetadata.mealTypes ?? []), ...rules.mealTypes]);
    let cuisines = unique([...(sourceMetadata.cuisines ?? []), ...rules.cuisines]);
    let modifiers = unique([...(sourceMetadata.modifiers ?? []), ...rules.modifiers]);
    const sources: CatalogueClassification['sources'] = {
      mealTypes: sourceMetadata.mealTypes?.length ? 'source' : 'rule',
      cuisines: sourceMetadata.cuisines?.length ? 'source' : 'rule',
      modifiers: sourceMetadata.modifiers?.length ? 'source' : 'rule',
    };

    if (mealTypes.length === 0 || cuisines.length === 0) {
      const prompt = [
        'Classify this recipe using only the allowed JSON values.',
        `mealTypes: ${MEAL_TYPES.join(', ')}`,
        `cuisines: ${CUISINES.join(', ')}`,
        `modifiers: ${MODIFIERS.join(', ')}`,
        `Title: ${content.title.slice(0, 200)}`,
        `Ingredients: ${content.ingredients.map((ingredient) => ingredient.name).join(', ').slice(0, 2_000)}`,
        'Return JSON with mealTypes, cuisines, and modifiers arrays and no other fields.',
      ].join('\n');
      const parsed = responseSchema.safeParse(await dependencies.requestJson(prompt));
      if (!parsed.success) throw new Error('Invalid catalogue classification');
      if (mealTypes.length === 0) {
        mealTypes = parsed.data.mealTypes;
        sources.mealTypes = 'ai';
      }
      if (cuisines.length === 0) {
        cuisines = parsed.data.cuisines;
        sources.cuisines = 'ai';
      }
      // Modifiers are optional. Only use AI modifier output when the same call
      // was already required for a missing meal type or cuisine.
      if (modifiers.length === 0) {
        modifiers = parsed.data.modifiers;
        sources.modifiers = 'ai';
      }
    }

    return {
      metadata: {
        ...sourceMetadata,
        mealTypes,
        cuisines,
        modifiers,
      },
      sources,
      complete: mealTypes.length > 0 && cuisines.length > 0,
    };
  };
}
