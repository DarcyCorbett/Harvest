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
import {
  TAXONOMY_V2_RESPONSE_JSON_SCHEMA,
  buildTaxonomyV2Prompt,
  parseAndDeriveTaxonomyV2,
} from './taxonomyV2.js';

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

export function classifyCatalogueDeterministically(
  content: CompleteCanonicalRecipeV2['content'],
  sourceMetadata: RecipeMetadata,
): CatalogueClassification {
  const rules = deterministicRules(content);
  const mealTypes = unique([...(sourceMetadata.mealTypes ?? []), ...rules.mealTypes]);
  const cuisines = unique([...(sourceMetadata.cuisines ?? []), ...rules.cuisines]);
  const modifiers = unique([...(sourceMetadata.modifiers ?? []), ...rules.modifiers]);

  const complete = mealTypes.length > 0 && cuisines.length > 0;
  return {
    metadata: {
      ...sourceMetadata,
      mealTypes,
      cuisines,
      modifiers,
    },
    sources: {
      mealTypes: sourceMetadata.mealTypes?.length ? 'source' : 'rule',
      cuisines: sourceMetadata.cuisines?.length ? 'source' : 'rule',
      modifiers: sourceMetadata.modifiers?.length ? 'source' : 'rule',
    },
    complete,
    classifierVersion: 0,
  };
}

export function createCatalogueClassifier(dependencies: {
  requestJson(prompt: string, responseJsonSchema?: object, maxOutputTokens?: number): Promise<unknown>;
}) {
  return async (
    content: CompleteCanonicalRecipeV2['content'],
    sourceMetadata: RecipeMetadata,
  ): Promise<CatalogueClassification> => {
    const deterministic = classifyCatalogueDeterministically(content, sourceMetadata);
    let mealTypes = deterministic.metadata.mealTypes ?? [];
    let cuisines = deterministic.metadata.cuisines ?? [];
    let modifiers = deterministic.metadata.modifiers ?? [];
    const sources = deterministic.sources;

    if (cuisines.length === 0) {
      const prompt = [
        'Classify only the cuisine of this recipe using the allowed JSON values.',
        `cuisines: ${CUISINES.join(', ')}`,
        `Title: ${content.title.slice(0, 200)}`,
        `Ingredients: ${content.ingredients.map((ingredient) => ingredient.name).join(', ').slice(0, 2_000)}`,
        'Return JSON with a cuisines array containing at least one value and no other fields.',
      ].join('\n');
      const cuisineSchema = z.object({
        cuisines: z.array(z.enum(CUISINES)).min(1).max(CUISINES.length),
      }).strict();
      const parsed = cuisineSchema.safeParse(await dependencies.requestJson(prompt, {
        type: 'object',
        additionalProperties: false,
        required: ['cuisines'],
        properties: {
          cuisines: { type: 'array', minItems: 1, items: { type: 'string', enum: CUISINES } },
        },
      }, 256));
      if (!parsed.success) throw new Error('Invalid catalogue cuisine classification');
      cuisines = parsed.data.cuisines;
      sources.cuisines = 'ai';
    }

    const { derived } = parseAndDeriveTaxonomyV2(await dependencies.requestJson(
      buildTaxonomyV2Prompt(content),
      TAXONOMY_V2_RESPONSE_JSON_SCHEMA as object,
      2_048,
    ));
    mealTypes = derived.mealTypes;
    modifiers = [
      ...modifiers.filter((modifier) => modifier !== 'kid-friendly' && modifier !== 'healthy'),
      ...(derived.kidFriendly ? ['kid-friendly' as const] : []),
      ...(derived.healthy ? ['healthy' as const] : []),
    ];
    sources.mealTypes = 'ai';
    sources.modifiers = 'ai';

    return {
      metadata: {
        ...sourceMetadata,
        mealTypes,
        cuisines,
        modifiers,
      },
      sources,
      complete: mealTypes.length > 0 && cuisines.length > 0,
      classifierVersion: 2,
    };
  };
}
