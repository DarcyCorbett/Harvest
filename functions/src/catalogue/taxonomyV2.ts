import { createHash } from 'node:crypto';

import { z } from 'zod';

import {
  validateMealTypeCombination,
  type CompleteCanonicalRecipeV2,
  type MealType,
} from './domain.js';

export const TAXONOMY_V2_MODEL = 'gemini-3.1-flash-lite';
export const TAXONOMY_V2_PROMPT_VERSION = 'taxonomy-v2-combined-2026-08-24';
export const DISH_MEAL_TYPES = [
  'breakfast', 'lunch', 'dinner', 'side', 'snack', 'dessert',
] as const;
export const COMPONENT_KINDS = [
  'none',
  'sauce-condiment',
  'dip-spread',
  'ingredient-preparation',
  'drink-cocktail',
  'other-non-meal',
] as const;
export const CONFIDENCE_VALUES = ['low', 'medium', 'high'] as const;
export const KID_BLOCKERS = [
  'none',
  'integral-extreme-heat',
  'alcohol-forward',
  'awkward-bones-or-shells',
  'central-specialty-or-acquired',
  'component-only',
  'requires-major-changes',
] as const;
export const HEALTHY_BLOCKERS = [
  'none',
  'deep-fried-or-battered',
  'excess-added-sugar',
  'processed-meat-dominant',
  'richness-dominant',
  'refined-starch-dominant',
] as const;

const roleShape = Object.fromEntries(DISH_MEAL_TYPES.map((role) => [role, z.boolean()])) as {
  [K in typeof DISH_MEAL_TYPES[number]]: z.ZodBoolean;
};
const boundedText = (maximum: number) => z.string().trim().min(1)
  .transform((value) => value.slice(0, maximum));
const boundedNullableText = (maximum: number) => z.string().trim().min(1)
  .transform((value) => value.slice(0, maximum)).nullable();

export const taxonomyV2ResponseSchema = z.object({
  mealType: z.object({
    mode: z.enum(['dish', 'component']),
    roles: z.object(roleShape).strict(),
    componentKind: z.enum(COMPONENT_KINDS),
    confidence: z.enum(CONFIDENCE_VALUES),
    reason: boundedText(280),
  }).strict(),
  kidFriendly: z.object({
    standaloneOrRecognizable: z.boolean(),
    coreIngredientsAccessible: z.boolean(),
    broadChildAppeal: z.boolean(),
    mildOrAdjustable: z.boolean(),
    easyToEat: z.boolean(),
    familyPractical: z.boolean(),
    blocker: z.enum(KID_BLOCKERS),
    adjustment: boundedNullableText(160),
    confidence: z.enum(CONFIDENCE_VALUES),
    reason: boundedText(240),
  }).strict(),
  healthy: z.object({
    nutrientDenseAnchor: z.boolean(),
    meaningfulPlantsOrWholeFoods: z.boolean(),
    suitableLeanOrPlantProtein: z.boolean(),
    minimallyProcessed: z.boolean(),
    sensibleFatAndMethod: z.boolean(),
    limitedSugarRefinedStarchRichness: z.boolean(),
    clearlyHealthierVersion: z.boolean(),
    blocker: z.enum(HEALTHY_BLOCKERS),
    confidence: z.enum(CONFIDENCE_VALUES),
    reason: boundedText(240),
  }).strict(),
}).strict();

export type TaxonomyV2Evidence = z.infer<typeof taxonomyV2ResponseSchema>;

const booleanProperty = { type: 'boolean' } as const;
const roleProperties = Object.fromEntries(
  DISH_MEAL_TYPES.map((role) => [role, booleanProperty]),
);

export const TAXONOMY_V2_RESPONSE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['mealType', 'kidFriendly', 'healthy'],
  properties: {
    mealType: {
      type: 'object',
      additionalProperties: false,
      required: ['mode', 'roles', 'componentKind', 'confidence', 'reason'],
      properties: {
        mode: { type: 'string', enum: ['dish', 'component'] },
        roles: {
          type: 'object',
          additionalProperties: false,
          required: DISH_MEAL_TYPES,
          properties: roleProperties,
        },
        componentKind: { type: 'string', enum: COMPONENT_KINDS },
        confidence: { type: 'string', enum: CONFIDENCE_VALUES },
        reason: { type: 'string', maxLength: 280 },
      },
    },
    kidFriendly: {
      type: 'object',
      additionalProperties: false,
      required: [
        'standaloneOrRecognizable', 'coreIngredientsAccessible', 'broadChildAppeal',
        'mildOrAdjustable', 'easyToEat', 'familyPractical', 'blocker', 'adjustment',
        'confidence', 'reason',
      ],
      properties: {
        standaloneOrRecognizable: booleanProperty,
        coreIngredientsAccessible: booleanProperty,
        broadChildAppeal: booleanProperty,
        mildOrAdjustable: booleanProperty,
        easyToEat: booleanProperty,
        familyPractical: booleanProperty,
        blocker: { type: 'string', enum: KID_BLOCKERS },
        adjustment: { type: ['string', 'null'], maxLength: 160 },
        confidence: { type: 'string', enum: CONFIDENCE_VALUES },
        reason: { type: 'string', maxLength: 240 },
      },
    },
    healthy: {
      type: 'object',
      additionalProperties: false,
      required: [
        'nutrientDenseAnchor', 'meaningfulPlantsOrWholeFoods',
        'suitableLeanOrPlantProtein', 'minimallyProcessed', 'sensibleFatAndMethod',
        'limitedSugarRefinedStarchRichness', 'clearlyHealthierVersion', 'blocker',
        'confidence', 'reason',
      ],
      properties: {
        nutrientDenseAnchor: booleanProperty,
        meaningfulPlantsOrWholeFoods: booleanProperty,
        suitableLeanOrPlantProtein: booleanProperty,
        minimallyProcessed: booleanProperty,
        sensibleFatAndMethod: booleanProperty,
        limitedSugarRefinedStarchRichness: booleanProperty,
        clearlyHealthierVersion: booleanProperty,
        blocker: { type: 'string', enum: HEALTHY_BLOCKERS },
        confidence: { type: 'string', enum: CONFIDENCE_VALUES },
        reason: { type: 'string', maxLength: 240 },
      },
    },
  },
} as const;

function ingredientText(
  ingredient: CompleteCanonicalRecipeV2['content']['ingredients'][number],
): string {
  return [ingredient.quantity, ingredient.unit, ingredient.name, ingredient.notes]
    .filter((value) => value !== undefined && value !== null && String(value).trim())
    .map((value) => String(value).trim())
    .join(' ');
}

export function buildTaxonomyV2Prompt(
  content: CompleteCanonicalRecipeV2['content'],
): string {
  const recipe = {
    title: content.title.trim().slice(0, 300),
    description: content.description?.trim().slice(0, 1_000) ?? '',
    originalServings: content.originalServings,
    ingredients: content.ingredients.map(ingredientText),
    instructions: content.instructions.map(({ text }) => text.trim()).filter(Boolean).join(' ').slice(0, 4_000),
    nutrition: content.nutrition ?? {},
  };
  return [
    'Classify the meal-type roles, Kid Friendly label, and Healthy label for this complete recipe.',
    'Use only the recipe content below. Existing catalogue tags and source classifications are intentionally unavailable.',
    '',
    'MEAL-TYPE CATEGORIES:',
    '- breakfast: commonly intended as a morning or brunch dish.',
    '- lunch: a complete light-to-moderate midday meal.',
    '- dinner: a complete meal commonly served in the evening.',
    '- side: an edible portion served alongside a main, not incorporated into it.',
    '- snack: commonly eaten independently between meals, including smoothies, bars, fruit, cookies, small baked goods, and snack-style appetizers.',
    '- dessert: a complete sweet dish primarily intended as dessert.',
    '- component: Sauces, Condiments & More, including standalone sauces, dressings, dips, marinades, rubs, stocks, doughs, fillings, toppings, ingredient preparations, cocktails, non-meal drinks, and remaining non-meal recipes.',
    '',
    'MEAL-TYPE COMBINATION RULES:',
    '- Set a role true only when it is a common intended use of the complete recipe, not merely plausible.',
    '- Breakfast, lunch, dinner, side, and snack may overlap when each role is independently well supported.',
    '- Dessert may stand alone or combine with breakfast and/or snack only. It cannot combine with lunch, dinner, or side.',
    '- Dessert-style pancakes, waffles, or crepes may be breakfast+dessert. Ordinary pancakes remain breakfast only; sweetness alone is insufficient.',
    '- Cookies and small baked goods may be snack+dessert when both are normal uses.',
    '- Component is always exclusive. In component mode every role boolean must be false.',
    '- A dip alone is component/dip-spread. A complete dip-and-carriers recipe may instead be a snack.',
    '- A smoothie may be breakfast+snack. A cocktail is component/drink-cocktail.',
    '- Classify the complete prepared food as written, not meals or other recipes in which it could later be used.',
    '- A finished food commonly eaten directly is not a component merely because it can also be used as an ingredient.',
    '- Do not assign lunch or dinner simply because the food can appear within those meals. The recipe itself must constitute a complete meal.',
    '- Assign side only when the prepared recipe is commonly served as a distinct accompaniment to a main dish.',
    '',
    'KID FRIENDLY (roughly ages 4-12):',
    '- A typical child should reasonably be expected to choose and enjoy the complete dish, not merely tolerate or physically eat it.',
    '- broadChildAppeal is mandatory and must be clearly supported, not a borderline 50/50 judgment. Mildness, sweetness, supermarket availability, or easy eating alone do not establish appeal.',
    '- Do not presume that a sweet glaze makes fish broadly child-appealing or that a creamy texture makes a vegetable-forward risotto broadly child-appealing.',
    '- standaloneOrRecognizable is false for a component-only recipe. Use blocker component-only.',
    '- Core ingredients must normally be available in a mainstream full-size supermarket. Do not treat Western origin as inherently more familiar.',
    '- One trivial serving adjustment is allowed only for an already-optional garnish or heat/strong sauce that can be served separately.',
    '- Changing integral seasoning, replacing a core ingredient, deconstructing the dish, or making several omissions is not trivial.',
    '- Spicy fish tacos, spicy composed salads, strongly acquired seafood, bitter salads, and similar concepts do not become broadly appealing merely because heat or dressing can be removed.',
    '- blocker must identify integral extreme heat, alcohol-forward preparation, awkward bones/shells, a central specialist/acquired ingredient, a component-only recipe, or changes to the core concept.',
    '',
    'HEALTHY means an everyday nutritious choice or a genuinely healthier version of a normally indulgent recipe. Judge ingredients and cooking method first:',
    '- nutrientDenseAnchor requires meaningful non-starchy vegetables, fruit, legumes, nuts/seeds, whole grains, or suitable lean/plant protein.',
    '- Plain pasta, noodles, white rice, potatoes, taro, bread, or refined flour are not sufficient anchors by themselves.',
    '- limitedSugarRefinedStarchRichness is mandatory: added sugar, refined starch, processed meat, cheese, cream, butter, sauces, and oil must be restrained in the complete recipe and realistic serving.',
    '- A significant amount of bacon, sausage, salami, or other processed meat fails Healthy even when vegetables are present. Dominant means nutritionally significant, not necessarily over half.',
    '- Materially high fat and sodium can fail Healthy even with lean protein or vegetables, including skin-on meat with substantial salty cheese or olives.',
    '- A nutritionally strong recipe needs at least two supporting strengths: meaningful plants/whole foods, suitable lean/plant protein, mostly minimally processed ingredients, or sensible fat/cooking method.',
    '- clearlyHealthierVersion is true only when the formulation materially reduces unhealthy features of the conventional version.',
    '- Baked or air-fried chicken with light breading and reasonably low oil can qualify. Battered, deep-fried, or oil-heavy chicken does not.',
    '- Desserts are not automatic failures. A genuinely healthier fruit-led or low-sugar version may qualify; ordinary cookies, confections, or sugar-heavy pancakes do not.',
    '- Vegetable sides and salads can qualify without protein when they have a meaningful nutrient-dense plant base and restrained dressing or fat.',
    '- Listed calories and macronutrients provide secondary context only and must not override ingredient composition and cooking method.',
    '',
    'OUTPUT:',
    '- Use mealType.mode="component" only for Sauces, Condiments & More, select its componentKind, and set every role false.',
    '- Otherwise use mode="dish", componentKind="none", and set at least one role true.',
    '- Return exactly the requested JSON fields. Keep meal-type reason under 280 characters, tag reasons under 240, and adjustment under 160. Use null when no adjustment is needed.',
    '',
    `Recipe: ${JSON.stringify(recipe)}`,
  ].join('\n');
}

export function taxonomyV2PromptHash(): string {
  return createHash('sha256')
    .update(TAXONOMY_V2_PROMPT_VERSION)
    .update('\n')
    .update(buildTaxonomyV2Prompt({
      title: '', originalServings: 1, ingredients: [], instructions: [],
    }))
    .digest('hex');
}

export interface DerivedTaxonomyV2 {
  mealTypes: MealType[];
  kidFriendly: boolean;
  healthy: boolean;
}

export function deriveTaxonomyV2(evidence: TaxonomyV2Evidence): DerivedTaxonomyV2 {
  let mealTypes: MealType[];
  if (evidence.mealType.mode === 'component') {
    if (evidence.mealType.componentKind === 'none'
      || DISH_MEAL_TYPES.some((role) => evidence.mealType.roles[role])) {
      throw new Error('Invalid component classification');
    }
    mealTypes = ['component'];
  } else {
    if (evidence.mealType.componentKind !== 'none') {
      throw new Error('Invalid dish component kind');
    }
    mealTypes = DISH_MEAL_TYPES.filter((role) => evidence.mealType.roles[role]);
    if (mealTypes.length === 0) mealTypes = ['component'];
    if (mealTypes.includes('dessert')) {
      mealTypes = mealTypes.filter((role) =>
        role !== 'lunch' && role !== 'dinner' && role !== 'side');
    }
    if (validateMealTypeCombination(mealTypes).length > 0) {
      throw new Error('Invalid dish meal-type combination');
    }
  }

  const healthySupportingSignals = [
    evidence.healthy.meaningfulPlantsOrWholeFoods,
    evidence.healthy.suitableLeanOrPlantProtein,
    evidence.healthy.minimallyProcessed,
    evidence.healthy.sensibleFatAndMethod,
  ].filter(Boolean).length;
  const nutritionPath = evidence.healthy.nutrientDenseAnchor
    && evidence.healthy.limitedSugarRefinedStarchRichness
    && healthySupportingSignals >= 2;
  const healthierVersionPath = evidence.healthy.clearlyHealthierVersion
    && evidence.healthy.limitedSugarRefinedStarchRichness
    && evidence.healthy.sensibleFatAndMethod
    && (evidence.healthy.nutrientDenseAnchor || evidence.healthy.minimallyProcessed);

  return {
    mealTypes,
    kidFriendly: mealTypes[0] !== 'component'
      && evidence.kidFriendly.standaloneOrRecognizable
      && evidence.kidFriendly.coreIngredientsAccessible
      && evidence.kidFriendly.broadChildAppeal
      && evidence.kidFriendly.mildOrAdjustable
      && evidence.kidFriendly.easyToEat
      && evidence.kidFriendly.blocker === 'none',
    healthy: evidence.healthy.blocker === 'none'
      && (nutritionPath || healthierVersionPath),
  };
}

export function parseAndDeriveTaxonomyV2(value: unknown): {
  evidence: TaxonomyV2Evidence;
  derived: DerivedTaxonomyV2;
} {
  const evidence = taxonomyV2ResponseSchema.parse(value);
  return { evidence, derived: deriveTaxonomyV2(evidence) };
}
