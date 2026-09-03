import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

export const EVALUATION_SEED = 'mealwizard-meal-type-evaluation-v1';
export const RUBRIC_VERSION = 'v2-complete-prepared-food-boundaries';
export const SOURCE_KEYS = [
  'recipetineats',
  'budgetbytes',
  'thewoksoflife',
  'themediterraneandish',
  'spendwithpennies',
  'cafedelites',
  'skinnytaste',
  'pinchofyum',
  'natashaskitchen',
  'nytcooking',
  'americastestkitchen',
  'seriouseats',
  'akispetretzikis',
];
export const EXISTING_MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'side', 'snack'];
export const DISH_MEAL_TYPES = [...EXISTING_MEAL_TYPES, 'dessert'];
export const MEAL_TYPES = [...DISH_MEAL_TYPES, 'component'];
export const TARGET_STRATA = [
  'snack-dessert',
  'component-cocktail',
  'side-component',
  'breakfast-lunch',
  'lunch-dinner',
  'snack-meal-overlap',
];
export const COMPONENT_KINDS = [
  'none',
  'sauce-condiment',
  'dip-spread',
  'ingredient-preparation',
  'drink-cocktail',
  'other-non-meal',
];
export const API_MODELS = [
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash-lite',
  'gemini-3.7-flash',
  'deepseek-v4-flash',
  'deepseek-v4-pro',
];
export const LUNA_MODEL = 'gpt-5.6-luna-subscription-medium';
export const ALL_MODELS = [...API_MODELS, LUNA_MODEL];

// First-party pricing checked on 2026-08-24. DeepSeek prices vary by UTC window;
// this rerun began during its documented off-peak period.
export const MODEL_PRICING_USD_PER_MILLION = {
  'gemini-3.1-flash-lite': {
    input: 0.25, output: 1.5, batchInput: 0.125, batchOutput: 0.75,
  },
  'gemini-3.5-flash-lite': {
    input: 0.3, output: 2.5, batchInput: 0.15, batchOutput: 1.25,
  },
  'gemini-3.7-flash': {
    input: 0.75, output: 3.75, batchInput: 0.375, batchOutput: 1.875,
  },
  'deepseek-v4-flash': { input: 0.22, cachedInput: 0.007, output: 0.66 },
  'deepseek-v4-pro': { input: 0.66, cachedInput: 0.022, output: 1.98 },
  [LUNA_MODEL]: {
    input: 0.2,
    cachedInput: 0.02,
    output: 1.2,
    batchInput: 0.1,
    batchOutput: 0.6,
    estimated: true,
  },
};

export const PRICING_SOURCES = {
  google: 'https://ai.google.dev/gemini-api/docs/pricing',
  deepseek: 'https://api-docs.deepseek.com/quick_start/pricing',
  openai: 'https://developers.openai.com/api/docs/models/gpt-5.6-luna',
  refreshedAt: '2026-08-24',
  deepSeekRatePeriod: 'off-peak',
  deepSeekPeakHours: '01:00-04:00 and 06:00-10:00 UTC, Monday-Friday',
};

const CONFIDENCE_VALUES = ['low', 'medium', 'high'];
const ROLE_SCHEMA_PROPERTIES = Object.fromEntries(
  DISH_MEAL_TYPES.map((mealType) => [mealType, { type: 'boolean' }]),
);

export const MEAL_TYPE_RESPONSE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['mode', 'roles', 'componentKind', 'confidence', 'reason'],
  properties: {
    mode: { type: 'string', enum: ['dish', 'component'] },
    roles: {
      type: 'object',
      additionalProperties: false,
      required: DISH_MEAL_TYPES,
      properties: ROLE_SCHEMA_PROPERTIES,
    },
    componentKind: { type: 'string', enum: COMPONENT_KINDS },
    confidence: { type: 'string', enum: CONFIDENCE_VALUES },
    reason: { type: 'string' },
  },
};

function stableRank(seed, ...parts) {
  return createHash('sha256').update([seed, ...parts].join('\n')).digest('hex');
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function boundedString(value, max) {
  return typeof value === 'string' && value.trim() && value.length <= max
    ? value.trim()
    : undefined;
}

function normalizeMealTypes(values, allowed = MEAL_TYPES) {
  if (!Array.isArray(values)) return [];
  const set = new Set(values.filter((value) => allowed.includes(value)));
  return allowed.filter((value) => set.has(value));
}

function mealTypeKey(values) {
  return normalizeMealTypes(values).join('+');
}

function formatAmount(ingredient) {
  return [ingredient?.quantity, ingredient?.unit, ingredient?.name, ingredient?.notes]
    .filter((value) => value !== undefined && value !== null && String(value).trim())
    .map((value) => String(value).trim())
    .join(' ');
}

function isReadyRecipe(recipe) {
  return recipe?.schemaVersion === 2
    && recipe.status === 'ready'
    && typeof recipe.id === 'string'
    && SOURCE_KEYS.includes(recipe.source?.key)
    && typeof recipe.source?.canonicalUrl === 'string'
    && typeof recipe.content?.title === 'string'
    && recipe.content.title.trim().length > 0
    && Array.isArray(recipe.content?.ingredients)
    && recipe.content.ingredients.length > 0
    && Array.isArray(recipe.content?.instructions)
    && recipe.content.instructions.length > 0;
}

function recipeTitleText(recipe) {
  return String(recipe.content?.title ?? '').toLowerCase();
}

const TARGET_MATCHERS = {
  'snack-dessert': /\b(cookie|cookies|brownie|cake|cupcake|muffin|pancake|waffle|cr[eê]pe|smoothie|granola|energy bar|snack bar|ice cream|pudding|dessert|truffle|fudge|doughnut|donut)\b/i,
  'component-cocktail': /\b(sauce|dressing|dip|marinade|rub|seasoning|stock|broth|dough|batter|frosting|icing|syrup|gravy|relish|chutney|aioli|mayonnaise|cocktail|margarita|mojito|martini|spritz|liqueur)\b/i,
  'side-component': /\b(side|salad|slaw|rice|bread|rolls?|potatoes|vegetables|salsa|hummus|gravy|relish|chutney|pickle|dressing|dip|sauce)\b/i,
  'breakfast-lunch': /\b(breakfast|brunch|egg|eggs|omelet|omelette|toast|sandwich|quiche|frittata|pancake|waffle|porridge|oatmeal|breakfast bowl)\b/i,
  'lunch-dinner': /\b(lunch|dinner|main course|pasta|noodles|stew|soup|curry|chicken|beef|pork|lamb|fish|salmon|casserole|burger|tacos?|pizza|risotto)\b/i,
  'snack-meal-overlap': /\b(snack|smoothie|bites?|wings?|sliders?|muffin|toast|sandwich|wrap|flatbread|quesadilla|hand pie|empanada|spring roll|samosa|bar|granola)\b/i,
};

function matchesTargetStratum(recipe, stratum) {
  const current = new Set(normalizeMealTypes(recipe.effective?.mealTypes, EXISTING_MEAL_TYPES));
  if (stratum === 'side-component' && current.has('side')) return true;
  const title = recipeTitleText(recipe);
  if (stratum === 'component-cocktail') {
    return TARGET_MATCHERS[stratum].test(title)
      && !/\b(in|with)\b.*\b(sauce|dressing|dip)\b/i.test(title);
  }
  return TARGET_MATCHERS[stratum].test(title);
}

function sampleFromRecipe(recipe, selectionKind, targetStratum) {
  const instructions = recipe.content.instructions
    .map((step) => step?.text)
    .filter((text) => typeof text === 'string' && text.trim())
    .join(' ')
    .slice(0, 4_000);
  return {
    recipeId: recipe.id,
    sourceKey: recipe.source.key,
    canonicalUrl: recipe.source.canonicalUrl,
    selectionKind,
    ...(targetStratum ? { targetStratum } : {}),
    title: recipe.content.title.trim(),
    description: typeof recipe.content.description === 'string'
      ? recipe.content.description.trim().slice(0, 1_000)
      : '',
    originalServings: Number(recipe.content.originalServings ?? 0),
    ingredients: recipe.content.ingredients.map(formatAmount),
    instructions,
    nutrition: recipe.content.nutrition ?? {},
    currentMealTypes: normalizeMealTypes(recipe.effective?.mealTypes, EXISTING_MEAL_TYPES),
  };
}

function quotas(sourceKeys, seed) {
  const ordered = [...sourceKeys].sort((left, right) =>
    stableRank(seed, left).localeCompare(stableRank(seed, right)));
  const total = Object.fromEntries(ordered.map((sourceKey, index) => [sourceKey, index < 9 ? 4 : 3]));
  const representative = Object.fromEntries(
    ordered.map((sourceKey, index) => [sourceKey, index < 11 ? 2 : 1]),
  );
  const targeted = Object.fromEntries(
    ordered.map((sourceKey) => [sourceKey, total[sourceKey] - representative[sourceKey]]),
  );
  return { total, representative, targeted };
}

export function selectMealTypeEvaluationSamples(
  recipes,
  {
    sourceKeys = SOURCE_KEYS,
    seed = EVALUATION_SEED,
    excludedRecipeIds = [],
  } = {},
) {
  if (sourceKeys.length !== 13) throw new Error('Meal-type evaluation requires 13 sources');
  const excluded = new Set(excludedRecipeIds);
  const candidates = recipes.filter((recipe) => isReadyRecipe(recipe)
    && sourceKeys.includes(recipe.source.key)
    && !excluded.has(recipe.id));
  const sourceQuotas = quotas(sourceKeys, seed);
  const selectedIds = new Set();
  const targeted = [];
  const remainingTargetQuota = { ...sourceQuotas.targeted };

  for (const stratum of TARGET_STRATA) {
    const matches = candidates
      .filter((recipe) => !selectedIds.has(recipe.id)
        && remainingTargetQuota[recipe.source.key] > 0
        && matchesTargetStratum(recipe, stratum))
      .sort((left, right) => stableRank(seed, 'target', stratum, left.source.key, left.id)
        .localeCompare(stableRank(seed, 'target', stratum, right.source.key, right.id)));
    const chosen = [];
    for (const recipe of matches) {
      if (remainingTargetQuota[recipe.source.key] <= 0) continue;
      chosen.push(recipe);
      remainingTargetQuota[recipe.source.key] -= 1;
      if (chosen.length === 4) break;
    }
    if (chosen.length < 4) {
      throw new Error(`Target stratum ${stratum} has fewer than four quota-compatible recipes`);
    }
    for (const recipe of chosen) {
      selectedIds.add(recipe.id);
      targeted.push(sampleFromRecipe(recipe, 'targeted', stratum));
    }
  }
  if (Object.values(remainingTargetQuota).some((value) => value !== 0)) {
    throw new Error('Targeted sampling did not satisfy source quotas');
  }

  const representative = [];
  for (const sourceKey of sourceKeys) {
    const sourceCandidates = candidates
      .filter((recipe) => recipe.source.key === sourceKey && !selectedIds.has(recipe.id))
      .sort((left, right) => stableRank(seed, 'representative', sourceKey, left.id)
        .localeCompare(stableRank(seed, 'representative', sourceKey, right.id)));
    const count = sourceQuotas.representative[sourceKey];
    if (sourceCandidates.length < count) {
      throw new Error(`Source ${sourceKey} has fewer than ${count} representative candidates`);
    }
    for (const recipe of sourceCandidates.slice(0, count)) {
      selectedIds.add(recipe.id);
      representative.push(sampleFromRecipe(recipe, 'representative'));
    }
  }

  const samples = [...representative, ...targeted]
    .sort((left, right) => stableRank(seed, 'sample-order', left.recipeId)
      .localeCompare(stableRank(seed, 'sample-order', right.recipeId)))
    .map((sample, index) => ({ ...sample, sampleKey: `meal-type-${String(index + 1).padStart(2, '0')}` }));
  if (samples.length !== 48 || new Set(samples.map((sample) => sample.recipeId)).size !== 48) {
    throw new Error('Meal-type evaluation must contain 48 distinct recipes');
  }
  return samples;
}

export function buildMealTypePrompt(sample) {
  const recipe = {
    title: sample.title,
    description: sample.description,
    originalServings: sample.originalServings,
    ingredients: sample.ingredients,
    instructions: sample.instructions,
    nutrition: sample.nutrition,
  };
  return [
    'Classify only the meal-type roles of this complete recipe.',
    'Use common intended serving roles, not every theoretically possible occasion.',
    '',
    'CATEGORIES:',
    '- breakfast: commonly intended as a morning or brunch dish.',
    '- lunch: a complete light-to-moderate midday meal.',
    '- dinner: a complete meal commonly served in the evening.',
    '- side: an edible portion served alongside a main, not incorporated into it.',
    '- snack: commonly eaten independently between meals. This can include smoothies, bars, fruit, cookies, small baked goods, and snack-style appetizers.',
    '- dessert: a complete sweet dish primarily intended as dessert.',
    '- component: Sauces, Condiments & More. This includes standalone sauces, dressings, dips, marinades, rubs, stocks, doughs, fillings, toppings, ingredient preparations, cocktails, non-meal drinks, and remaining non-meal recipes.',
    '',
    'COMBINATION RULES:',
    '- Set a role true only when it is a common intended use of the complete recipe, not merely plausible.',
    '- Breakfast, lunch, dinner, side, and snack may overlap when each role is independently well supported.',
    '- Dessert may stand alone or combine with breakfast and/or snack only. It cannot combine with lunch, dinner, or side.',
    '- Dessert-style pancakes, waffles, or crepes may be breakfast+dessert. Ordinary pancakes remain breakfast only; sweetness alone is insufficient.',
    '- Cookies and small baked goods may be snack+dessert when both are normal uses.',
    '- Component is always exclusive. For component mode, every role boolean must be false.',
    '- A dip alone is component/dip-spread. A complete dip-and-carriers recipe may instead be a snack.',
    '- A smoothie may be breakfast+snack. A cocktail is component/drink-cocktail.',
    '',
    'COMPLETE-PREPARED-FOOD BOUNDARIES:',
    '- Classify the complete prepared food as written, not the meals or other recipes in which it could later be used.',
    '- A finished food commonly eaten directly is not a component merely because it can also be used as an ingredient.',
    '- Do not assign lunch or dinner simply because the food can appear within those meals. The recipe itself must constitute a complete meal.',
    '- Assign side only when the prepared recipe is commonly served as a distinct accompaniment to a main dish.',
    '',
    'OUTPUT:',
    '- Use mode="component" only for Sauces, Condiments & More and select the matching componentKind.',
    '- Otherwise use mode="dish", componentKind="none", and set at least one role true.',
    '- Return exactly the requested JSON fields. Keep reason under 280 characters.',
    '',
    `Recipe: ${JSON.stringify(recipe)}`,
  ].join('\n');
}

export function deriveMealTypes(evidence) {
  if (evidence.mode === 'component') return ['component'];
  return DISH_MEAL_TYPES.filter((mealType) => evidence.roles[mealType] === true);
}

export function validateMealTypeResponse(value) {
  const errors = [];
  if (!exactKeys(value, ['mode', 'roles', 'componentKind', 'confidence', 'reason'])) {
    return { valid: false, errors: ['response-shape'] };
  }
  if (!['dish', 'component'].includes(value.mode)) errors.push('mode');
  if (!exactKeys(value.roles, DISH_MEAL_TYPES)) errors.push('roles-shape');
  if (errors.length === 0) {
    for (const role of DISH_MEAL_TYPES) {
      if (typeof value.roles[role] !== 'boolean') errors.push(`role-${role}`);
    }
  }
  if (!COMPONENT_KINDS.includes(value.componentKind)) errors.push('component-kind');
  if (!CONFIDENCE_VALUES.includes(value.confidence)) errors.push('confidence');
  const reason = boundedString(value.reason, 280);
  if (!reason) errors.push('reason');
  if (errors.length > 0) return { valid: false, errors };

  const enabledRoles = DISH_MEAL_TYPES.filter((role) => value.roles[role]);
  if (value.mode === 'component') {
    if (value.componentKind === 'none') errors.push('component-kind-none');
    if (enabledRoles.length > 0) errors.push('component-not-exclusive');
  } else {
    if (value.componentKind !== 'none') errors.push('dish-component-kind');
    if (enabledRoles.length === 0) errors.push('dish-without-role');
    if (value.roles.dessert
      && (value.roles.lunch || value.roles.dinner || value.roles.side)) {
      errors.push('dessert-invalid-overlap');
    }
  }
  if (errors.length > 0) return { valid: false, errors };
  const evidence = { ...value, reason };
  return { valid: true, errors: [], evidence, mealTypes: deriveMealTypes(evidence) };
}

export function tokenCost(model, usage, { batch = false } = {}) {
  const pricing = MODEL_PRICING_USD_PER_MILLION[model];
  if (!pricing) throw new Error(`Missing pricing for ${model}`);
  const inputRate = batch && pricing.batchInput !== undefined ? pricing.batchInput : pricing.input;
  const outputRate = batch && pricing.batchOutput !== undefined ? pricing.batchOutput : pricing.output;
  const cachedInput = Number(usage.cachedInputTokens ?? 0);
  const uncachedInput = Math.max(0, Number(usage.inputTokens ?? 0) - cachedInput);
  const cachedRate = pricing.cachedInput ?? inputRate;
  return (uncachedInput * inputRate + cachedInput * cachedRate
    + Number(usage.outputTokens ?? 0) * outputRate) / 1_000_000;
}

export function fingerprintDocuments(documents) {
  const hash = createHash('sha256');
  const sorted = [...documents].sort((left, right) => left.path.localeCompare(right.path));
  for (const document of sorted) {
    hash.update(document.path);
    hash.update('\0');
    hash.update(document.updateTime ?? '');
    hash.update('\n');
  }
  return { count: sorted.length, hash: hash.digest('hex') };
}

function estimateTextTokens(value) {
  return Math.max(1, Math.ceil(Buffer.byteLength(String(value ?? ''), 'utf8') / 4));
}

export function createLunaTemplate(samples) {
  return samples.map((sample) => ({
    sampleKey: sample.sampleKey,
    model: LUNA_MODEL,
    reasoningEffort: 'medium',
    evidence: null,
  }));
}

export function importLunaResults(samples, input) {
  if (!Array.isArray(input) || input.length !== samples.length
    || new Set(input.map((entry) => entry.sampleKey)).size !== samples.length) {
    throw new Error('Luna results must contain one unique entry per sample');
  }
  const sampleMap = new Map(samples.map((sample) => [sample.sampleKey, sample]));
  return input.map((entry) => {
    const sample = sampleMap.get(entry.sampleKey);
    if (!sample) throw new Error(`Unknown Luna sample: ${entry.sampleKey}`);
    const validation = validateMealTypeResponse(entry.evidence);
    if (!validation.valid) {
      throw new Error(`Invalid Luna result for ${entry.sampleKey}: ${validation.errors.join(', ')}`);
    }
    const prompt = buildMealTypePrompt(sample);
    const rawText = JSON.stringify(entry.evidence);
    const usage = {
      inputTokens: estimateTextTokens(prompt),
      outputTokens: estimateTextTokens(rawText),
      totalTokens: estimateTextTokens(prompt) + estimateTextTokens(rawText),
      estimated: true,
    };
    return {
      sampleKey: entry.sampleKey,
      model: LUNA_MODEL,
      modelConfig: { reasoningEffort: 'medium', subscription: true },
      evaluationIntegrity: 'non-blind-subscription-pass',
      prompt,
      rawText,
      validation,
      usage,
      latencyMs: null,
      costUsd: 0,
      apiEquivalentCostUsd: tokenCost(LUNA_MODEL, usage),
      subscriptionMarginalCostUsd: 0,
    };
  });
}

function resultFor(results, sampleKey, model) {
  return results.find((result) => result.sampleKey === sampleKey && result.model === model);
}

function validSet(result) {
  return result?.validation?.valid ? result.validation.mealTypes : null;
}

function setEqual(left, right) {
  return mealTypeKey(left) === mealTypeKey(right);
}

function currentProjection(mealTypes) {
  return normalizeMealTypes(mealTypes, EXISTING_MEAL_TYPES);
}

export function buildDisagreementShortlist(samples, results, { limit = 20 } = {}) {
  return samples.flatMap((sample) => {
    const candidates = ALL_MODELS.flatMap((model) => {
      const result = resultFor(results, sample.sampleKey, model);
      const mealTypes = validSet(result);
      return result ? [{ model, valid: mealTypes !== null, mealTypes, reason: result.validation?.evidence?.reason }] : [];
    });
    const uniqueSets = new Set(candidates.filter((candidate) => candidate.valid)
      .map((candidate) => mealTypeKey(candidate.mealTypes)));
    if (uniqueSets.size <= 1) return [];
    const newCategoryDisagreement = ['snack', 'dessert', 'component'].some((mealType) => {
      const values = new Set(candidates.filter((candidate) => candidate.valid)
        .map((candidate) => candidate.mealTypes.includes(mealType)));
      return values.size > 1;
    });
    const componentBoundary = candidates.some((candidate) => candidate.mealTypes?.includes('component'))
      && candidates.some((candidate) => candidate.valid && !candidate.mealTypes.includes('component'));
    const score = uniqueSets.size * 10 + (newCategoryDisagreement ? 100 : 0)
      + (componentBoundary ? 50 : 0) + (sample.selectionKind === 'targeted' ? 5 : 0);
    return [{ sample, candidates, uniqueSets: uniqueSets.size, score }];
  }).sort((left, right) => right.score - left.score
    || stableRank(EVALUATION_SEED, 'disagreement', left.sample.recipeId)
      .localeCompare(stableRank(EVALUATION_SEED, 'disagreement', right.sample.recipeId)))
    .slice(0, limit);
}

export function createReviewTemplate(samples, results, { limit = 20 } = {}) {
  return buildDisagreementShortlist(samples, results, { limit }).map((row) => ({
    sampleKey: row.sample.sampleKey,
    title: row.sample.title,
    recipeUrl: row.sample.canonicalUrl,
    currentMealTypes: row.sample.currentMealTypes,
    preferredModel: null,
    approvedMealTypes: null,
    notes: '',
  }));
}

export function parseReview(text) {
  return JSON.parse(String(text));
}

function resolveReviewVerdicts(samples, results, review) {
  if (!Array.isArray(review)) return [];
  const sampleMap = new Map(samples.map((sample) => [sample.sampleKey, sample]));
  return review.flatMap((entry) => {
    if (!sampleMap.has(entry.sampleKey)) return [];
    let approved = entry.approvedMealTypes;
    if (approved === null && ALL_MODELS.includes(entry.preferredModel)) {
      approved = validSet(resultFor(results, entry.sampleKey, entry.preferredModel));
    }
    if (!Array.isArray(approved)) return [];
    const normalized = normalizeMealTypes(approved);
    const structural = normalized.includes('component')
      ? normalized.length === 1
      : normalized.length > 0
        && !(normalized.includes('dessert')
          && normalized.some((type) => ['lunch', 'dinner', 'side'].includes(type)));
    if (!structural || normalized.length !== new Set(approved).size) return [];
    return [{ sampleKey: entry.sampleKey, mealTypes: normalized }];
  });
}

function binaryMetrics(expected, predicted) {
  let tp = 0; let fp = 0; let fn = 0; let tn = 0;
  for (let index = 0; index < expected.length; index += 1) {
    if (expected[index] && predicted[index]) tp += 1;
    else if (!expected[index] && predicted[index]) fp += 1;
    else if (expected[index] && !predicted[index]) fn += 1;
    else tn += 1;
  }
  const precision = tp + fp ? tp / (tp + fp) : 1;
  const recall = tp + fn ? tp / (tp + fn) : 1;
  return { tp, fp, fn, tn, precision, recall, f1: precision + recall ? 2 * precision * recall / (precision + recall) : 0 };
}

export function scoreReview(samples, results, review) {
  const verdicts = resolveReviewVerdicts(samples, results, review);
  if (verdicts.length === 0) return [];
  const verdictMap = new Map(verdicts.map((verdict) => [verdict.sampleKey, verdict.mealTypes]));
  return ALL_MODELS.flatMap((model) => {
    const reviewed = verdicts.flatMap((verdict) => {
      const result = resultFor(results, verdict.sampleKey, model);
      return result?.validation?.valid ? [{ expected: verdict.mealTypes, predicted: result.validation.mealTypes }] : [];
    });
    if (reviewed.length === 0) return [];
    const byMealType = Object.fromEntries(MEAL_TYPES.map((mealType) => [mealType, binaryMetrics(
      reviewed.map((row) => row.expected.includes(mealType)),
      reviewed.map((row) => row.predicted.includes(mealType)),
    )]));
    const exactMatches = reviewed.filter((row) => setEqual(row.expected, row.predicted)).length;
    return [{
      model,
      reviewed: verdictMap.size,
      validReviewed: reviewed.length,
      exactMatches,
      exactAccuracy: exactMatches / reviewed.length,
      byMealType,
    }];
  });
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
}

export function summarizeModels({ samples, results, readyRecipeCount }) {
  return ALL_MODELS.flatMap((model) => {
    const modelResults = results.filter((result) => result.model === model);
    if (modelResults.length === 0) return [];
    const validResults = modelResults.filter((result) => result.validation?.valid);
    const usage = modelResults.reduce((sum, result) => ({
      inputTokens: sum.inputTokens + Number(result.usage?.inputTokens ?? 0),
      cachedInputTokens: sum.cachedInputTokens + Number(result.usage?.cachedInputTokens ?? 0),
      outputTokens: sum.outputTokens + Number(result.usage?.outputTokens ?? 0),
    }), { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 });
    const actualCostUsd = model === LUNA_MODEL ? 0
      : modelResults.reduce((sum, result) => sum + Number(result.costUsd ?? 0), 0);
    const apiEquivalentCostUsd = model === LUNA_MODEL
      ? modelResults.reduce((sum, result) => sum + Number(result.apiEquivalentCostUsd ?? 0), 0)
      : actualCostUsd;
    const batchCost = tokenCost(model, usage, { batch: true });
    let currentAssignments = 0; let retained = 0; let added = 0; let removed = 0;
    let exactCurrentProjection = 0; let componentTransitions = 0;
    for (const result of validResults) {
      const sample = samples.find((candidate) => candidate.sampleKey === result.sampleKey);
      const current = currentProjection(sample.currentMealTypes);
      const proposed = currentProjection(result.validation.mealTypes);
      currentAssignments += current.length;
      retained += current.filter((type) => proposed.includes(type)).length;
      removed += current.filter((type) => !proposed.includes(type)).length;
      added += proposed.filter((type) => !current.includes(type)).length;
      if (setEqual(current, proposed)) exactCurrentProjection += 1;
      if (result.validation.mealTypes.includes('component')
        && current.some((type) => type === 'side' || type === 'snack')) componentTransitions += 1;
    }
    const perRecipeStandard = modelResults.length ? apiEquivalentCostUsd / modelResults.length : 0;
    const perRecipeBatch = modelResults.length ? batchCost / modelResults.length : 0;
    return [{
      model,
      results: modelResults.length,
      valid: validResults.length,
      validRate: validResults.length / modelResults.length,
      inputTokens: usage.inputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      outputTokens: usage.outputTokens,
      medianLatencyMs: median(modelResults.map((result) => result.latencyMs)),
      actualCostUsd,
      apiEquivalentCostUsd,
      projectedReadyStandardUsd: perRecipeStandard * readyRecipeCount,
      projectedReadyBatchUsd: perRecipeBatch * readyRecipeCount,
      categoryCounts: Object.fromEntries(MEAL_TYPES.map((mealType) => [mealType,
        validResults.filter((result) => result.validation.mealTypes.includes(mealType)).length])),
      currentAssignments,
      retained,
      retentionRate: currentAssignments ? retained / currentAssignments : 1,
      added,
      removed,
      exactCurrentProjection,
      componentTransitions,
      dessertCount: validResults.filter((result) => result.validation.mealTypes.includes('dessert')).length,
    }];
  });
}

export function pairwiseAgreement(samples, results) {
  const rows = [];
  for (let leftIndex = 0; leftIndex < ALL_MODELS.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < ALL_MODELS.length; rightIndex += 1) {
      const leftModel = ALL_MODELS[leftIndex];
      const rightModel = ALL_MODELS[rightIndex];
      let compared = 0; let exact = 0;
      for (const sample of samples) {
        const left = validSet(resultFor(results, sample.sampleKey, leftModel));
        const right = validSet(resultFor(results, sample.sampleKey, rightModel));
        if (!left || !right) continue;
        compared += 1;
        if (setEqual(left, right)) exact += 1;
      }
      if (compared) rows.push({ leftModel, rightModel, compared, exact, agreement: exact / compared });
    }
  }
  return rows;
}

function escapeCell(value) {
  return String(value ?? '—').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function displayTypes(values) {
  return values?.length
    ? values.map((value) => value === 'component' ? 'Sauces, Condiments & More' : value).join(', ')
    : 'invalid';
}

function money(value) {
  return value === null || value === undefined ? 'n/a' : `$${Number(value).toFixed(6)}`;
}

export function renderComparisonReport({ samples, results, verification }) {
  const models = ALL_MODELS.filter((model) => results.some((result) => result.model === model));
  const lines = [
    '# Expanded meal-type model comparison', '',
    'Existing tags are shown only for continuity review. They were not included in model prompts.', '',
    `| # | Recipe | Selection | Current | ${models.join(' | ')} |`,
    `|---:|---|---|---|${models.map(() => '---').join('|')}|`,
  ];
  for (const [index, sample] of samples.entries()) {
    const cells = models.map((model) => displayTypes(validSet(resultFor(results, sample.sampleKey, model))));
    lines.push(`| ${index + 1} | [${escapeCell(sample.title)}](${sample.canonicalUrl})<br>${sample.sourceKey} | ${sample.selectionKind}${sample.targetStratum ? `: ${sample.targetStratum}` : ''} | ${displayTypes(sample.currentMealTypes)} | ${cells.map(escapeCell).join(' | ')} |`);
  }
  lines.push('', '## Read-only verification', '',
    `- Recipe fingerprint unchanged: ${verification.recipesUnchanged ? 'yes' : 'NO'}`,
    `- Meal-plan fingerprint unchanged: ${verification.mealPlansUnchanged ? 'yes' : 'NO'}`,
    `- Cookbook fingerprint unchanged: ${verification.cookbooksUnchanged ? 'yes' : 'NO'}`,
    '- Recipe-site requests: 0', '');
  return `${lines.join('\n')}\n`;
}

export function renderReviewShortlist({ samples, results, limit = 20 }) {
  const shortlist = buildDisagreementShortlist(samples, results, { limit });
  const lines = [
    '# Meal-type disagreement shortlist', '',
    'Review only the cases you want to adjudicate. In `review.json`, either enter an approved label array or select a preferred model. Partial review is supported.', '',
  ];
  for (const [index, row] of shortlist.entries()) {
    lines.push(`## ${index + 1}. [${row.sample.title}](${row.sample.canonicalUrl})`, '',
      `Current: ${displayTypes(row.sample.currentMealTypes)}; selection: ${row.sample.selectionKind}${row.sample.targetStratum ? `/${row.sample.targetStratum}` : ''}.`, '',
      '| Model | Proposed types | Reason |', '|---|---|---|');
    for (const candidate of row.candidates) {
      lines.push(`| ${candidate.model} | ${escapeCell(displayTypes(candidate.mealTypes))} | ${escapeCell(candidate.reason ?? 'invalid or unavailable')} |`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

function pct(value) {
  return `${(Number(value) * 100).toFixed(1)}%`;
}

export function renderModelSummaryReport({ samples, results, modelSummaries, reviewScores = [] }) {
  const lines = [
    '# Expanded meal-type model and cost summary', '',
    `Pricing refreshed: ${PRICING_SOURCES.refreshedAt}`, '',
    `- Gemini: ${PRICING_SOURCES.google}`,
    `- DeepSeek: ${PRICING_SOURCES.deepseek}`,
    `- OpenAI Luna: ${PRICING_SOURCES.openai}`, '',
    `DeepSeek cost projections use ${PRICING_SOURCES.deepSeekRatePeriod} rates. Peak rates apply ${PRICING_SOURCES.deepSeekPeakHours} and are double the off-peak rates.`, '',
    'Luna uses the current subscription at medium reasoning. Its marginal subscription cost is $0; token counts and API-equivalent costs are estimates.', '',
    'Current-tag comparison is a continuity diagnostic, not a ground-truth accuracy score.', '',
    '| Model | Valid | Input/cached/output | Category counts B/L/D/Side/Snack/Dessert/More | Median latency | Eval cost | Ready standard | Ready batch | Current retention | Added/removed | Exact current |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const summary of modelSummaries) {
    const count = summary.categoryCounts;
    const counts = `${count.breakfast}/${count.lunch}/${count.dinner}/${count.side}/${count.snack}/${count.dessert}/${count.component}`;
    lines.push(`| ${summary.model} | ${summary.valid}/${summary.results} | ${summary.inputTokens}/${summary.cachedInputTokens}/${summary.outputTokens}${summary.model === LUNA_MODEL ? ' estimated' : ''} | ${counts} | ${summary.medianLatencyMs === null ? 'n/a' : `${summary.medianLatencyMs} ms`} | ${money(summary.actualCostUsd)} | ${money(summary.projectedReadyStandardUsd)} | ${money(summary.projectedReadyBatchUsd)} | ${summary.retained}/${summary.currentAssignments} (${pct(summary.retentionRate)}) | ${summary.added}/${summary.removed} | ${summary.exactCurrentProjection}/${summary.valid} |`);
  }
  lines.push('', '## Pairwise exact-set agreement', '', '| Models | Agreement |', '|---|---:|');
  for (const row of pairwiseAgreement(samples, results)) {
    lines.push(`| ${row.leftModel} / ${row.rightModel} | ${row.exact}/${row.compared} (${pct(row.agreement)}) |`);
  }
  if (reviewScores.length === 0) {
    lines.push('', '## Provisional recommendation', '',
      'Cursory review is pending. No quality winner is declared from model consensus or continuity alone.', '');
    return `${lines.join('\n')}\n`;
  }
  lines.push('', '## Cursory-review scores', '',
    '| Model | Valid reviewed | Exact set | Snack F1 | Dessert F1 | Sauces, Condiments & More F1 |',
    '|---|---:|---:|---:|---:|---:|');
  for (const score of reviewScores) {
    lines.push(`| ${score.model} | ${score.validReviewed}/${score.reviewed} | ${score.exactMatches}/${score.validReviewed} (${pct(score.exactAccuracy)}) | ${pct(score.byMealType.snack.f1)} | ${pct(score.byMealType.dessert.f1)} | ${pct(score.byMealType.component.f1)} |`);
  }
  const bestExact = Math.max(...reviewScores.map((score) => score.exactMatches));
  const eligible = reviewScores.filter((score) => bestExact - score.exactMatches <= 1)
    .sort((left, right) => {
      const leftSummary = modelSummaries.find((summary) => summary.model === left.model);
      const rightSummary = modelSummaries.find((summary) => summary.model === right.model);
      return (rightSummary?.retentionRate ?? 0) - (leftSummary?.retentionRate ?? 0)
        || (leftSummary?.projectedReadyBatchUsd ?? Infinity) - (rightSummary?.projectedReadyBatchUsd ?? Infinity);
    });
  lines.push('', '## Provisional recommendation', '',
    eligible[0]
      ? `**${eligible[0].model}** leads the reviewed disagreement cases after applying the one-recipe quality band, continuity, and projected batch-cost tie-breakers.`
      : 'No provisional recommendation is available.',
    '', 'This disagreement-focused cursory review is diagnostic and is not a catalogue-wide accuracy estimate.', '');
  return `${lines.join('\n')}\n`;
}

export function renderTaxonomyCriteriaReport() {
  return `# Expanded meal-type taxonomy criteria

## Categories

- **Breakfast:** commonly intended as a morning or brunch dish.
- **Lunch:** a complete light-to-moderate midday meal.
- **Dinner:** a complete meal commonly served in the evening.
- **Side:** an edible portion served alongside a main, not incorporated into it.
- **Snack:** commonly eaten independently between meals, including smoothies, bars, fruit, cookies, small baked goods, and snack-style appetizers.
- **Dessert:** a complete sweet dish primarily intended as dessert.
- **Sauces, Condiments & More:** internally \`component\`; sauces, dressings, dips, marinades, rubs, stocks, doughs, fillings, toppings, ingredient preparations, cocktails, non-meal drinks, and other non-meal recipes.

## Complete-prepared-food boundaries

- Classify the complete prepared food as written, not meals or recipes in which it could later be used.
- A finished food commonly eaten directly is not a component merely because it can also be used as an ingredient.
- Lunch or Dinner requires the recipe itself to constitute a complete meal; appearing within such a meal is insufficient.
- Side requires a common intended use as a distinct accompaniment to a main dish.

## Combination policy

Multiple labels require common intended uses rather than theoretical suitability. Breakfast, Lunch, Dinner, Side, and Snack may overlap when independently justified. Dessert may stand alone or combine with Breakfast and/or Snack only. Ordinary pancakes remain Breakfast; clearly dessert-style pancakes may also be Dessert. Component is always exclusive.

This evaluation does not change production tags, the public taxonomy, Firestore, or the UI.
`;
}
