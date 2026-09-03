import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';

export const EVALUATION_SEED = 'mealwizard-kid-healthy-evaluation-v2';
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
export const TAG_STATES = ['neither', 'kid-only', 'healthy-only', 'both'];
export const API_MODELS = [
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash-lite',
  'gemini-3.7-flash',
  'deepseek-v4-flash',
  'deepseek-v4-pro',
];
export const LUNA_MODEL = 'gpt-5.6-luna-subscription-medium';
export const ALL_MODELS = [...API_MODELS, LUNA_MODEL];
export const RUBRIC_VERSION = 'v4-broad-appeal-composition-first';

// Pricing snapshot refreshed from first-party provider documentation on 2026-08-14.
// Luna is an API-equivalent estimate only; the evaluation itself uses the subscription.
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
  'deepseek-v4-flash': {
    input: 0.14, cachedInput: 0.0028, output: 0.28,
  },
  'deepseek-v4-pro': {
    input: 0.435, cachedInput: 0.003625, output: 0.87,
  },
  [LUNA_MODEL]: {
    input: 0.2, cachedInput: 0.02, output: 1.2, estimated: true,
  },
};

export const PRICING_SOURCES = {
  google: 'https://ai.google.dev/gemini-api/docs/pricing',
  deepseek: 'https://api-docs.deepseek.com/quick_start/pricing',
  openai: 'https://developers.openai.com/api/docs/models/gpt-5.6-luna',
  refreshedAt: '2026-08-14',
};

const KID_BLOCKERS = [
  'none',
  'integral-extreme-heat',
  'alcohol-forward',
  'awkward-bones-or-shells',
  'central-specialty-or-acquired',
  'component-only',
  'requires-major-changes',
];
const HEALTHY_BLOCKERS = [
  'none',
  'deep-fried-or-battered',
  'excess-added-sugar',
  'processed-meat-dominant',
  'richness-dominant',
  'refined-starch-dominant',
];
const CONFIDENCE_VALUES = ['low', 'medium', 'high'];

export const TAG_RESPONSE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kidFriendly', 'healthy'],
  properties: {
    kidFriendly: {
      type: 'object',
      additionalProperties: false,
      required: [
        'standaloneOrRecognizable',
        'coreIngredientsAccessible',
        'broadChildAppeal',
        'mildOrAdjustable',
        'easyToEat',
        'familyPractical',
        'blocker',
        'adjustment',
        'confidence',
        'reason',
      ],
      properties: {
        standaloneOrRecognizable: { type: 'boolean' },
        coreIngredientsAccessible: { type: 'boolean' },
        broadChildAppeal: { type: 'boolean' },
        mildOrAdjustable: { type: 'boolean' },
        easyToEat: { type: 'boolean' },
        familyPractical: { type: 'boolean' },
        blocker: { type: 'string', enum: KID_BLOCKERS },
        adjustment: { type: ['string', 'null'] },
        confidence: { type: 'string', enum: CONFIDENCE_VALUES },
        reason: { type: 'string' },
      },
    },
    healthy: {
      type: 'object',
      additionalProperties: false,
      required: [
        'nutrientDenseAnchor',
        'meaningfulPlantsOrWholeFoods',
        'suitableLeanOrPlantProtein',
        'minimallyProcessed',
        'sensibleFatAndMethod',
        'limitedSugarRefinedStarchRichness',
        'clearlyHealthierVersion',
        'blocker',
        'confidence',
        'reason',
      ],
      properties: {
        nutrientDenseAnchor: { type: 'boolean' },
        meaningfulPlantsOrWholeFoods: { type: 'boolean' },
        suitableLeanOrPlantProtein: { type: 'boolean' },
        minimallyProcessed: { type: 'boolean' },
        sensibleFatAndMethod: { type: 'boolean' },
        limitedSugarRefinedStarchRichness: { type: 'boolean' },
        clearlyHealthierVersion: { type: 'boolean' },
        blocker: { type: 'string', enum: HEALTHY_BLOCKERS },
        confidence: { type: 'string', enum: CONFIDENCE_VALUES },
        reason: { type: 'string' },
      },
    },
  },
};

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function boundedString(value, max, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  return typeof value === 'string' && value.trim() && value.length <= max
    ? value.trim()
    : undefined;
}

function stableRank(seed, sourceKey, id) {
  return createHash('sha256').update(`${seed}\n${sourceKey}\n${id}`).digest('hex');
}

function formatAmount(ingredient) {
  return [ingredient?.quantity, ingredient?.unit, ingredient?.name, ingredient?.notes]
    .filter((value) => value !== undefined && value !== null && String(value).trim())
    .map((value) => String(value).trim())
    .join(' ');
}

function recipeTagState(recipe) {
  const modifiers = new Set(recipe?.effective?.modifiers ?? []);
  const kidFriendly = recipe?.search?.kidFriendly === true || modifiers.has('kid-friendly');
  const healthy = recipe?.search?.healthy === true || modifiers.has('healthy');
  if (kidFriendly && healthy) return 'both';
  if (kidFriendly) return 'kid-only';
  if (healthy) return 'healthy-only';
  return 'neither';
}

function currentTags(recipe) {
  const state = recipeTagState(recipe);
  return {
    kidFriendly: state === 'kid-only' || state === 'both',
    healthy: state === 'healthy-only' || state === 'both',
  };
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
    && recipe.content.ingredients.every((ingredient) =>
      ingredient && typeof ingredient.name === 'string')
    && Array.isArray(recipe.content?.instructions)
    && recipe.content.instructions.length > 0;
}

function sampleFromCandidate(candidate, sourceKey, index, requestedState, stateCounts) {
  const { recipe, state } = candidate;
  const instructions = recipe.content.instructions
    .map((step) => step?.text)
    .filter((text) => typeof text === 'string' && text.trim())
    .join(' ')
    .slice(0, 4_000);
  const description = typeof recipe.content.description === 'string'
    ? recipe.content.description.trim().slice(0, 1_000)
    : '';
  return {
    sampleKey: `${sourceKey}-${index + 1}`,
    recipeId: recipe.id,
    sourceKey,
    canonicalUrl: recipe.source.canonicalUrl,
    selectionKind: state === requestedState ? requestedState : `fallback-for-${requestedState}`,
    requestedState,
    currentState: state,
    cellPopulation: stateCounts[state],
    title: recipe.content.title.trim(),
    description,
    originalServings: Number(recipe.content.originalServings ?? 0),
    ingredients: recipe.content.ingredients.map(formatAmount),
    instructions,
    nutrition: recipe.content.nutrition ?? {},
    currentTags: currentTags(recipe),
  };
}

export function selectEvaluationSamples(
  recipes,
  {
    sourceKeys = SOURCE_KEYS,
    seed = EVALUATION_SEED,
    recipesPerSource = TAG_STATES.length,
    excludedRecipeIds = [],
  } = {},
) {
  if (!Number.isInteger(recipesPerSource)
    || recipesPerSource < 1
    || recipesPerSource > TAG_STATES.length) {
    throw new Error('recipesPerSource must be an integer from 1 through 4');
  }
  const excluded = new Set(excludedRecipeIds);
  const samples = [];
  for (const [sourceIndex, sourceKey] of sourceKeys.entries()) {
    const allCandidates = recipes
      .filter((recipe) => isReadyRecipe(recipe) && recipe.source.key === sourceKey)
      .map((recipe) => ({
        recipe,
        state: recipeTagState(recipe),
        rank: stableRank(seed, sourceKey, recipe.id),
      }))
      .sort((left, right) => left.rank.localeCompare(right.rank));
    const stateCounts = Object.fromEntries(TAG_STATES.map((state) => [
      state,
      allCandidates.filter((candidate) => candidate.state === state).length,
    ]));
    const candidates = allCandidates.filter((candidate) => !excluded.has(candidate.recipe.id));
    if (candidates.length < recipesPerSource) {
      throw new Error(`Source ${sourceKey} has fewer than ${recipesPerSource} eligible ready recipes`);
    }
    const selectedIds = new Set();
    for (let index = 0; index < recipesPerSource; index += 1) {
      const requestedState = TAG_STATES[
        (sourceIndex * recipesPerSource + index) % TAG_STATES.length
      ];
      const selected = candidates.find((candidate) =>
        candidate.state === requestedState && !selectedIds.has(candidate.recipe.id))
        ?? candidates.find((candidate) => !selectedIds.has(candidate.recipe.id));
      if (!selected) {
        throw new Error(`Source ${sourceKey} did not yield ${recipesPerSource} distinct samples`);
      }
      selectedIds.add(selected.recipe.id);
      samples.push(sampleFromCandidate(selected, sourceKey, index, requestedState, stateCounts));
    }
  }
  return samples;
}

export function buildClassificationPrompt(sample) {
  const recipePayload = {
    title: sample.title,
    description: sample.description,
    originalServings: sample.originalServings,
    ingredients: sample.ingredients,
    instructions: sample.instructions,
    nutrition: sample.nutrition,
  };
  return [
    'Evaluate only the Kid Friendly and Healthy labels for this recipe.',
    '',
    'KID FRIENDLY (roughly ages 4-12):',
    '- A typical child should reasonably be expected to choose and enjoy the complete dish, not merely tolerate or physically eat it.',
    '- broadChildAppeal is mandatory and must be clearly supported, not a borderline 50/50 judgment. Mildness, sweetness, supermarket availability, or easy eating alone do not establish appeal. If a typical child might eat the dish but would not clearly be expected to choose and enjoy it, set broadChildAppeal to false.',
    '- Do not presume that a sweet glaze makes fish broadly child-appealing or that a creamy texture makes a vegetable-forward risotto broadly child-appealing. These can qualify only when the complete dish itself has clear broad appeal.',
    '- standaloneOrRecognizable is false for a component-only condiment, sauce, dressing, garnish, topping, crouton, puree, dip, or ingredient preparation that is not normally chosen as a dish or recognizable standalone snack. Use blocker component-only.',
    '- Core ingredients must normally be available in a mainstream full-size supermarket. Do not treat Western origin as inherently more familiar or non-Western origin as unfamiliar.',
    '- One trivial serving adjustment is allowed only for an already-optional garnish or heat/strong sauce that can be served separately. Changing integral seasoning, replacing a core ingredient, deconstructing the dish, or making several omissions is not trivial.',
    '- Spicy fish tacos, spicy composed salads, strongly acquired seafood, bitter salads, and similar concepts do not become broadly child-appealing merely because heat or dressing can be removed.',
    '- blocker must identify integral extreme heat, alcohol-forward preparation, awkward bones/shells, a central specialist/acquired ingredient, a component-only recipe, or changes to the core concept.',
    '',
    'HEALTHY means an everyday nutritious choice or a genuinely healthier version of a normally indulgent recipe. Judge the nutritional content of the ingredients and cooking method first:',
    '- nutrientDenseAnchor requires meaningful non-starchy vegetables, fruit, legumes, nuts/seeds, whole grains, or suitable lean/plant protein. Plain pasta, noodles, white rice, potatoes, taro, bread, or refined flour are not sufficient anchors by themselves.',
    '- limitedSugarRefinedStarchRichness is mandatory: added sugar, refined starch, processed meat, cheese, cream, butter, sauces, and oil must be restrained in the complete recipe and realistic serving.',
    '- A significant amount of bacon, sausage, salami, or other processed meat fails Healthy even when the dish also contains vegetables. Use processed-meat-dominant for this blocker; "dominant" means nutritionally significant, not necessarily more than half the recipe.',
    '- A combination of materially high fat and sodium can fail Healthy even with lean protein or vegetables. Examples include skin-on meat paired with substantial salty cheese or olives. Use richness-dominant when the overall fat, salt, cheese, butter, cream, or oil load makes the dish unsuitable as an everyday healthy choice.',
    '- A nutritionally strong recipe also needs at least two supporting strengths: meaningful plants/whole foods, suitable lean/plant protein, mostly minimally processed ingredients, or a sensible fat/cooking method.',
    '- clearlyHealthierVersion is true only when the formulation materially reduces unhealthy features of the conventional version, such as baked lightly breaded chicken instead of battered/fried chicken, vegetable-forward flatbread pizza, low/no-added-sugar pancakes, or a fruit-led light dessert. It need not closely reproduce the conventional food: modest honey or light cream cheese can be acceptable when the complete recipe is substantially healthier. A health-oriented title alone is not evidence.',
    '- Baked or air-fried chicken with light breading and reasonably low oil can qualify. Battered, deep-fried, or oil-heavy chicken does not.',
    '- Desserts are not automatic failures. A genuinely healthier fruit-led or low-sugar version may qualify even with a modest amount of honey or light dairy; ordinary cookies, confections, or sugar-heavy pancakes do not.',
    '- blocker must identify deep frying/substantial batter, excessive added sugar, processed-meat dominance, richness dominance, or refined-starch dominance.',
    '- Vegetable sides and salads can qualify without protein when they have a meaningful nutrient-dense plant base and restrained dressing or fat.',
    '- Listed calories and macronutrients provide secondary context only. They may support a borderline decision, but must not override ingredient composition and cooking method, especially when nutrition data appears incomplete, inconsistent, or based on an unrealistic serving.',
    '',
    'Return exactly the requested JSON fields. Keep each reason under 240 characters and any kid adjustment under 160 characters. Use null when no adjustment is needed.',
    '',
    `Recipe: ${JSON.stringify(recipePayload)}`,
  ].join('\n');
}

function deriveTags(evidence) {
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
    kidFriendly: evidence.kidFriendly.standaloneOrRecognizable
      && evidence.kidFriendly.coreIngredientsAccessible
      && evidence.kidFriendly.broadChildAppeal
      && evidence.kidFriendly.mildOrAdjustable
      && evidence.kidFriendly.easyToEat
      && evidence.kidFriendly.blocker === 'none',
    healthy: evidence.healthy.blocker === 'none'
      && (nutritionPath || healthierVersionPath),
  };
}

export function validateTagResponse(value) {
  const errors = [];
  if (!exactKeys(value, ['kidFriendly', 'healthy'])) {
    return { valid: false, errors: ['response-shape'], tags: undefined };
  }
  const kidKeys = [
    'standaloneOrRecognizable', 'coreIngredientsAccessible', 'broadChildAppeal',
    'mildOrAdjustable', 'easyToEat', 'familyPractical', 'blocker', 'adjustment',
    'confidence', 'reason',
  ];
  const healthyKeys = [
    'nutrientDenseAnchor', 'meaningfulPlantsOrWholeFoods',
    'suitableLeanOrPlantProtein', 'minimallyProcessed', 'sensibleFatAndMethod',
    'limitedSugarRefinedStarchRichness', 'clearlyHealthierVersion', 'blocker',
    'confidence', 'reason',
  ];
  if (!exactKeys(value.kidFriendly, kidKeys)) errors.push('kidFriendly-shape');
  if (!exactKeys(value.healthy, healthyKeys)) errors.push('healthy-shape');
  if (errors.length > 0) return { valid: false, errors, tags: undefined };

  const kid = value.kidFriendly;
  const healthy = value.healthy;
  for (const key of kidKeys.slice(0, 6)) {
    if (typeof kid[key] !== 'boolean') errors.push(`kidFriendly-${key}`);
  }
  for (const key of healthyKeys.slice(0, 7)) {
    if (typeof healthy[key] !== 'boolean') errors.push(`healthy-${key}`);
  }
  if (!KID_BLOCKERS.includes(kid.blocker)) errors.push('kidFriendly-blocker');
  if (!HEALTHY_BLOCKERS.includes(healthy.blocker)) errors.push('healthy-blocker');
  if (!CONFIDENCE_VALUES.includes(kid.confidence)) errors.push('kidFriendly-confidence');
  if (!CONFIDENCE_VALUES.includes(healthy.confidence)) errors.push('healthy-confidence');
  const adjustment = boundedString(kid.adjustment, 160, { nullable: true });
  if (adjustment === undefined) errors.push('kidFriendly-adjustment');
  const kidReason = boundedString(kid.reason, 240);
  const healthyReason = boundedString(healthy.reason, 240);
  if (!kidReason) errors.push('kidFriendly-reason');
  if (!healthyReason) errors.push('healthy-reason');
  if (errors.length > 0) return { valid: false, errors, tags: undefined };

  const evidence = {
    kidFriendly: { ...kid, adjustment, reason: kidReason },
    healthy: { ...healthy, reason: healthyReason },
  };
  return { valid: true, errors: [], evidence, tags: deriveTags(evidence) };
}

export function tokenCost(model, usage, { batch = false } = {}) {
  const pricing = MODEL_PRICING_USD_PER_MILLION[model];
  if (!pricing) throw new Error(`Missing pricing for ${model}`);
  const inputRate = batch && pricing.batchInput !== undefined ? pricing.batchInput : pricing.input;
  const outputRate = batch && pricing.batchOutput !== undefined ? pricing.batchOutput : pricing.output;
  const cachedInput = Number(usage.cachedInputTokens ?? 0);
  const input = Math.max(0, Number(usage.inputTokens ?? 0) - cachedInput);
  const cachedRate = pricing.cachedInput ?? inputRate;
  return (input * inputRate + cachedInput * cachedRate
    + Number(usage.outputTokens ?? 0) * outputRate) / 1_000_000;
}

function emptyInventoryBucket() {
  return {
    ready: 0, kidFriendly: 0, healthy: 0, both: 0,
    kidOnly: 0, healthyOnly: 0, either: 0, neither: 0,
  };
}

export function buildInventory(recipes) {
  const bySource = Object.fromEntries(SOURCE_KEYS.map((sourceKey) => [sourceKey, emptyInventoryBucket()]));
  const totals = { totalDocuments: recipes.length, ...emptyInventoryBucket() };
  for (const recipe of recipes) {
    if (!isReadyRecipe(recipe)) continue;
    const sourceKey = recipe.source.key;
    const state = recipeTagState(recipe);
    const bucket = bySource[sourceKey];
    for (const target of [bucket, totals]) {
      target.ready += 1;
      if (state === 'kid-only' || state === 'both') target.kidFriendly += 1;
      if (state === 'healthy-only' || state === 'both') target.healthy += 1;
      if (state === 'both') target.both += 1;
      if (state === 'kid-only') target.kidOnly += 1;
      if (state === 'healthy-only') target.healthyOnly += 1;
      if (state !== 'neither') target.either += 1;
      if (state === 'neither') target.neither += 1;
    }
  }
  return { totals, bySource };
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

export function createHumanReviewTemplate(samples) {
  return samples.map((sample) => ({
    sampleKey: sample.sampleKey,
    title: sample.title,
    recipeUrl: sample.canonicalUrl,
    kidFriendly: null,
    healthy: null,
    notes: '',
  }));
}

export function parseHumanReview(text) {
  const normalized = String(text).replace(
    /(\"(?:kidFriendly|healthy)\"\s*:\s*)(?:\"([yn])\"|([yn]))(?=\s*[,}])/gi,
    (_match, prefix, quotedValue, bareValue) =>
      `${prefix}${String(quotedValue ?? bareValue).toLowerCase() === 'y'}`,
  );
  return JSON.parse(normalized);
}

export function createLunaTemplate(samples) {
  return samples.map((sample) => ({
    sampleKey: sample.sampleKey,
    model: LUNA_MODEL,
    reasoningEffort: 'medium',
    evidence: null,
  }));
}

function estimateTextTokens(value) {
  return Math.max(1, Math.ceil(Buffer.byteLength(String(value ?? ''), 'utf8') / 4));
}

export function importLunaResults(samples, input) {
  if (!Array.isArray(input) || input.length !== samples.length
    || new Set(input.map((entry) => entry.sampleKey)).size !== samples.length) {
    throw new Error('Luna tags must contain exactly one unique result per sample');
  }
  const sampleMap = new Map(samples.map((sample) => [sample.sampleKey, sample]));
  return input.map((entry) => {
    const sample = sampleMap.get(entry.sampleKey);
    if (!sample) throw new Error(`Unknown Luna sample: ${entry.sampleKey}`);
    const validation = validateTagResponse(entry.evidence);
    if (!validation.valid) {
      throw new Error(`Invalid Luna tags for ${entry.sampleKey}: ${validation.errors.join(', ')}`);
    }
    const prompt = buildClassificationPrompt(sample);
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
      evaluationIntegrity: entry.evaluationIntegrity ?? 'blind',
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

function money(value) {
  return value === undefined || value === null ? '—' : `$${Number(value).toFixed(6)}`;
}

function percent(value, total) {
  return total ? `${(value / total * 100).toFixed(2)}%` : '—';
}

function escapeCell(value) {
  return String(value ?? '—').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function tagPair(tags) {
  if (!tags) return 'invalid';
  return `K${tags.kidFriendly ? '✓' : '–'} H${tags.healthy ? '✓' : '–'}`;
}

function resultKey(result) {
  return `${result.sampleKey}\n${result.model}`;
}

export function buildBlindRows(samples, results) {
  const labels = 'ABCDEF'.split('');
  return samples.map((sample) => {
    const candidates = results
      .filter((result) => result.sampleKey === sample.sampleKey)
      .sort((left, right) => stableRank('blind-v1', sample.sampleKey, left.model)
        .localeCompare(stableRank('blind-v1', sample.sampleKey, right.model)))
      .map((result, index) => ({
        label: `Candidate ${labels[index]}`,
        resultKey: resultKey(result),
        model: result.model,
        tags: result.validation?.tags,
        evidence: result.validation?.evidence,
        valid: result.validation?.valid === true,
      }));
    return { sample, candidates };
  });
}

export function summarizeModels({ samples, results, inventory }) {
  const sampleCells = new Map();
  for (const sample of samples) {
    const key = `${sample.sourceKey}|${sample.currentState}`;
    sampleCells.set(key, (sampleCells.get(key) ?? 0) + 1);
  }
  return ALL_MODELS.flatMap((model) => {
    const modelResults = results.filter((result) => result.model === model);
    if (modelResults.length === 0) return [];
    const validResults = modelResults.filter((result) => result.validation?.valid);
    const usage = modelResults.reduce((sum, result) => ({
      inputTokens: sum.inputTokens + Number(result.usage?.inputTokens ?? 0),
      cachedInputTokens: sum.cachedInputTokens + Number(result.usage?.cachedInputTokens ?? 0),
      outputTokens: sum.outputTokens + Number(result.usage?.outputTokens ?? 0),
    }), { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 });
    const evaluationCostUsd = model === LUNA_MODEL
      ? 0
      : modelResults.reduce((sum, result) => sum + Number(result.costUsd ?? 0), 0);
    const apiEquivalentCostUsd = model === LUNA_MODEL
      ? modelResults.reduce((sum, result) => sum + Number(result.apiEquivalentCostUsd ?? 0), 0)
      : evaluationCostUsd;
    const perRecipeStandard = modelResults.length ? apiEquivalentCostUsd / modelResults.length : 0;
    const batchEvaluationCost = model === LUNA_MODEL
      ? apiEquivalentCostUsd
      : tokenCost(model, usage, { batch: true });
    const perRecipeBatch = modelResults.length ? batchEvaluationCost / modelResults.length : 0;
    let weightedKid = 0;
    let weightedHealthy = 0;
    for (const result of validResults) {
      const sample = samples.find((candidate) => candidate.sampleKey === result.sampleKey);
      const sampledInCell = sampleCells.get(`${sample.sourceKey}|${sample.currentState}`) ?? 1;
      const weight = sample.cellPopulation / sampledInCell;
      if (result.validation.tags.kidFriendly) weightedKid += weight;
      if (result.validation.tags.healthy) weightedHealthy += weight;
    }
    const latencies = modelResults.map((result) => result.latencyMs)
      .filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
    const medianLatencyMs = latencies.length ? latencies[Math.floor(latencies.length / 2)] : null;
    return [{
      model,
      results: modelResults.length,
      valid: validResults.length,
      validRate: validResults.length / modelResults.length,
      kidTagged: validResults.filter((result) => result.validation.tags.kidFriendly).length,
      healthyTagged: validResults.filter((result) => result.validation.tags.healthy).length,
      weightedKidCoverage: inventory.totals.ready ? weightedKid / inventory.totals.ready : 0,
      weightedHealthyCoverage: inventory.totals.ready ? weightedHealthy / inventory.totals.ready : 0,
      inputTokens: usage.inputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      outputTokens: usage.outputTokens,
      medianLatencyMs,
      evaluationCostUsd,
      apiEquivalentCostUsd,
      projectedReadyStandardUsd: perRecipeStandard * inventory.totals.ready,
      projectedReadyBatchUsd: perRecipeBatch * inventory.totals.ready,
      projectedNeitherStandardUsd: perRecipeStandard * inventory.totals.neither,
      projectedNeitherBatchUsd: perRecipeBatch * inventory.totals.neither,
      nonBlind: modelResults.some((result) => result.evaluationIntegrity === 'prompt-tuned-non-blind'),
      evaluationIntegrity: [...new Set(modelResults
        .map((result) => result.evaluationIntegrity)
        .filter(Boolean))],
    }];
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
  return {
    tp, fp, fn, tn, precision, recall,
    f1: precision + recall ? 2 * precision * recall / (precision + recall) : 0,
  };
}

export function scoreHumanReview(samples, results, humanReview) {
  if (!Array.isArray(humanReview) || humanReview.length !== samples.length) return [];
  const reviewMap = new Map(humanReview.map((review) => [review.sampleKey, review]));
  if (samples.some((sample) => typeof reviewMap.get(sample.sampleKey)?.kidFriendly !== 'boolean'
    || typeof reviewMap.get(sample.sampleKey)?.healthy !== 'boolean')) return [];
  return ALL_MODELS.flatMap((model) => {
    const allModelResults = results.filter((result) => result.model === model);
    const validResults = allModelResults.filter((result) => result.validation?.valid);
    if (validResults.length === 0) return [];
    const expectedKid = validResults.map((result) => reviewMap.get(result.sampleKey).kidFriendly);
    const expectedHealthy = validResults.map((result) => reviewMap.get(result.sampleKey).healthy);
    const predictedKid = validResults.map((result) => result.validation.tags.kidFriendly);
    const predictedHealthy = validResults.map((result) => result.validation.tags.healthy);
    const exactMatches = validResults.filter((result) => {
      const expected = reviewMap.get(result.sampleKey);
      return result.validation.tags.kidFriendly === expected.kidFriendly
        && result.validation.tags.healthy === expected.healthy;
    }).length;
    const actualCostUsd = model === LUNA_MODEL
      ? 0
      : allModelResults.reduce((sum, result) => sum + Number(result.costUsd ?? 0), 0);
    const apiEquivalentCostUsd = model === LUNA_MODEL
      ? allModelResults.reduce((sum, result) => sum + Number(result.apiEquivalentCostUsd ?? 0), 0)
      : actualCostUsd;
    return [{
      model,
      kidFriendly: binaryMetrics(expectedKid, predictedKid),
      healthy: binaryMetrics(expectedHealthy, predictedHealthy),
      exactMatches,
      exactAccuracy: exactMatches / validResults.length,
      reviewedResults: validResults.length,
      schemaInvalid: allModelResults.length - validResults.length,
      costPerCorrectRecipeUsd: exactMatches ? actualCostUsd / exactMatches : null,
      apiEquivalentCostPerCorrectRecipeUsd:
        exactMatches ? apiEquivalentCostUsd / exactMatches : null,
    }];
  });
}

export function renderInventoryReport({ inventory, modelSummaries = [] }) {
  const lines = [
    '# MealWizard kid-friendly and healthy tag inventory',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    `Firestore recipe documents: ${inventory.totals.totalDocuments}`,
    '',
    `Ready recipes used as the catalogue denominator: ${inventory.totals.ready}`,
    '',
    '| Source | Ready | Kid Friendly | Healthy | Both | Either | Neither |',
    '|---|---:|---:|---:|---:|---:|---:|',
  ];
  for (const sourceKey of SOURCE_KEYS) {
    const row = inventory.bySource[sourceKey];
    lines.push(`| ${sourceKey} | ${row.ready} | ${row.kidFriendly} (${percent(row.kidFriendly, row.ready)}) | ${row.healthy} (${percent(row.healthy, row.ready)}) | ${row.both} (${percent(row.both, row.ready)}) | ${row.either} (${percent(row.either, row.ready)}) | ${row.neither} (${percent(row.neither, row.ready)}) |`);
  }
  const total = inventory.totals;
  lines.push(
    `| **Total** | **${total.ready}** | **${total.kidFriendly} (${percent(total.kidFriendly, total.ready)})** | **${total.healthy} (${percent(total.healthy, total.ready)})** | **${total.both} (${percent(total.both, total.ready)})** | **${total.either} (${percent(total.either, total.ready)})** | **${total.neither} (${percent(total.neither, total.ready)})** |`,
    '',
    `Kid-only: ${total.kidOnly} (${percent(total.kidOnly, total.ready)}); healthy-only: ${total.healthyOnly} (${percent(total.healthyOnly, total.ready)}).`,
    '',
    '## Why coverage is low',
    '',
    'Production is in catalogue mode. Source-site modifier labels are trusted, deterministic rules only add limited modifiers such as salad, and AI modifier output is normally used only when the same call is already required for a missing meal type or cuisine. Recipes with complete meal/cuisine metadata therefore often receive no independent modifier assessment.',
    '',
  );
  if (modelSummaries.length > 0) {
    lines.push(
      '## Cost projections',
      '',
      '| Model | Eval cost | API-equivalent eval | All ready standard | All ready batch | Neither standard | Neither batch |',
      '|---|---:|---:|---:|---:|---:|---:|',
    );
    for (const summary of modelSummaries) {
      lines.push(`| ${summary.model} | ${money(summary.evaluationCostUsd)} | ${money(summary.apiEquivalentCostUsd)} | ${money(summary.projectedReadyStandardUsd)} | ${money(summary.projectedReadyBatchUsd)} | ${money(summary.projectedNeitherStandardUsd)} | ${money(summary.projectedNeitherBatchUsd)} |`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export function renderCriteriaReport() {
  return `# Proposed Kid Friendly and Healthy criteria

## Selected rubric

Kid Friendly targets roughly ages 4–12 and means a typical child would reasonably choose and enjoy the complete dish. Broad child appeal must be clearly supported rather than a borderline 50/50 judgment. Mildness, sweetness, or ease of eating is not enough by itself. Accessible core ingredients, mild or trivially adjustable flavor, easy eating, and a recognizable standalone dish or snack are also mandatory. Component-only sauces, dips, garnishes, croutons, purees, and ingredient preparations do not qualify. Cultural origin is not a negative signal.

A trivial adjustment may omit an already-optional garnish or serve heat or strong sauce separately. Changing integral seasoning, replacing a core ingredient, deconstructing the recipe, or changing the core concept does not qualify.

Healthy means an everyday nutritious choice or a genuinely healthier version of an otherwise indulgent recipe. Ingredient composition and cooking method are primary; listed calories and macronutrients are supporting context. It requires restrained added sugar, refined starch, processed meat, richness, and oil. A nutritionally significant amount of processed meat fails even alongside vegetables, and a materially high combined fat and sodium load can also fail. The normal path requires a nutrient-dense anchor plus at least two supporting strengths from meaningful plants, suitable lean or plant protein, minimal processing, and sensible preparation.

Plain pasta, noodles, white rice, potatoes, taro, bread, and refined flour are not nutritious anchors by themselves. Rich refined-starch dishes such as risotto do not become Healthy merely by including a vegetable. Baked lightly breaded chicken can qualify; battered, deep-fried, or oil-heavy chicken cannot. Desserts are judged on composition rather than name: a materially healthier fruit-led version may qualify with modest honey or light dairy, while ordinary confections and sugar-heavy pancakes do not.

## Further options

- Add a separate Kid Adaptable tag while keeping Kid Friendly literal.
- Personalize heat, texture, and disliked-ingredient tolerance per household or child age.
- Expose the evidence score instead of only a binary tag, then tune the threshold from user feedback.
- Add a separate supermarket-accessible or weeknight-practical facet rather than folding both into Kid Friendly.
- Compare health within recipe categories, so a pizza is judged against other pizzas rather than against a vegetable salad.

## Scope

This evaluation does not alter the production taxonomy, classifier, Firestore tags, or app behavior.
`;
}

export function renderBlindReviewReport({ samples, results, verification }) {
  const blindRows = buildBlindRows(samples, results);
  const candidateLabels = blindRows[0]?.candidates.map((candidate) => candidate.label) ?? [];
  const lines = [
    '# Blind kid-friendly and healthy tag review',
    '',
    'Use the recipe link and anonymous candidate decisions to enter your own verdict in `human-review.json`. Candidate order is independently randomized for every recipe.',
    '',
    `| # | Recipe | ${candidateLabels.map((label) => label.replace('Candidate ', '')).join(' | ')} |`,
    `|---:|---|${candidateLabels.map(() => '---').join('|')}|`,
  ];
  for (const [index, row] of blindRows.entries()) {
    const candidateCells = row.candidates.map((candidate) => tagPair(candidate.tags));
    lines.push(`| ${index + 1} | [${escapeCell(row.sample.title)}](${row.sample.canonicalUrl})<br>${row.sample.sourceKey} | ${candidateCells.join(' | ')} |`);
  }
  for (const [index, row] of blindRows.entries()) {
    lines.push(
      '',
      `## ${index + 1}. [${row.sample.title}](${row.sample.canonicalUrl})`,
      '',
      `Source: ${row.sample.sourceKey}; sample: ${row.sample.sampleKey}`,
      '',
      '| Candidate | Tags | Kid reason / adjustment | Healthy reason |',
      '|---|---|---|---|',
    );
    for (const candidate of row.candidates) {
      const evidence = candidate.evidence;
      const kidDetail = evidence
        ? `${evidence.kidFriendly.reason}${evidence.kidFriendly.adjustment ? ` Adjustment: ${evidence.kidFriendly.adjustment}` : ''}`
        : 'invalid response';
      lines.push(`| ${candidate.label} | ${tagPair(candidate.tags)} | ${escapeCell(kidDetail)} | ${escapeCell(evidence?.healthy?.reason ?? 'invalid response')} |`);
    }
  }
  lines.push(
    '',
    '## Read-only verification',
    '',
    `- Recipe fingerprint unchanged: ${verification.recipesUnchanged ? 'yes' : 'NO'}`,
    `- Meal-plan fingerprint unchanged: ${verification.mealPlansUnchanged ? 'yes' : 'NO'}`,
    `- Cookbook fingerprint unchanged: ${verification.cookbooksUnchanged ? 'yes' : 'NO'}`,
    '- Recipe-site requests: 0',
    '',
  );
  return `${lines.join('\n')}\n`;
}

export function renderModelSummaryReport({ modelSummaries, scores = [], blindRows }) {
  const expectedReviewed = Math.max(...modelSummaries.map((summary) => summary.results), 0);
  const lunaSummary = modelSummaries.find((summary) => summary.model === LUNA_MODEL);
  const lines = [
    '# Model and cost summary',
    '',
    `Pricing refreshed: ${PRICING_SOURCES.refreshedAt}`,
    '',
    `- Gemini: ${PRICING_SOURCES.google}`,
    `- DeepSeek: ${PRICING_SOURCES.deepseek}`,
    `- OpenAI Luna: ${PRICING_SOURCES.openai}`,
    '',
    lunaSummary
      ? 'Luna used the current subscription at medium reasoning. Its sample cost is $0 marginal subscription cost; API-equivalent token counts and prices are estimates.'
      : 'The Luna subscription pass is pending and is not included in the current five-model API report.',
    '',
    'Gemini 3.7 Flash was run at `low`, its lowest accepted thinking level; the provider rejected `minimal`. Other Gemini models used `minimal`, and both DeepSeek models used non-thinking mode.',
    '',
    'Schema-invalid responses remain invalid in the benchmark. They are included in actual token/cost totals but excluded from tag and coverage counts.',
    '',
    '| Model | Valid | Input / cached / output tokens | Sample K/H | Weighted catalogue K/H | Median latency | Eval cost | Ready batch projection |',
    '|---|---:|---:|---:|---:|---:|---:|---:|',
  ];
  if (lunaSummary?.nonBlind) {
    lines.splice(11, 0,
      'Important: this Luna pass was produced after the human labels were visible. It is a prompt-tuned diagnostic result, not a blind comparison, and is excluded from production qualification.',
      '');
  } else if (lunaSummary?.evaluationIntegrity.includes('human-label-blind-in-session')) {
    lines.splice(11, 0,
      'The Luna judgments were completed before any human labels were entered. They were produced in this subscription task rather than through an independent API call, so treat them as human-label-blind but not provider-independent.',
      '');
  }
  for (const summary of modelSummaries) {
    const tokens = `${summary.inputTokens} / ${summary.cachedInputTokens} / ${summary.outputTokens}${summary.model === LUNA_MODEL ? ' estimated' : ''}`;
    const latency = summary.medianLatencyMs === null ? 'n/a' : `${summary.medianLatencyMs} ms`;
    lines.push(`| ${summary.model} | ${summary.valid}/${summary.results} | ${tokens} | ${summary.kidTagged}/${summary.healthyTagged} | ${(summary.weightedKidCoverage * 100).toFixed(1)}%/${(summary.weightedHealthyCoverage * 100).toFixed(1)}% | ${latency} | ${money(summary.evaluationCostUsd)} | ${money(summary.projectedReadyBatchUsd)} |`);
  }
  if (scores.length > 0) {
    lines.push(
      '',
      '## Human-scored performance',
      '',
      '| Model | Valid reviewed | Kid P/R/F1 | Healthy P/R/F1 | False positives K/H | Exact | Cost / correct |',
      '|---|---:|---:|---:|---:|---:|---:|',
    );
    for (const score of scores) {
      const costPerCorrect = score.model === LUNA_MODEL
        ? `${money(score.costPerCorrectRecipeUsd)} marginal (${money(score.apiEquivalentCostPerCorrectRecipeUsd)} API estimate)`
        : money(score.costPerCorrectRecipeUsd);
      lines.push(`| ${score.model} | ${score.reviewedResults}/${expectedReviewed} (${score.schemaInvalid} invalid) | ${(score.kidFriendly.precision * 100).toFixed(1)}%/${(score.kidFriendly.recall * 100).toFixed(1)}%/${(score.kidFriendly.f1 * 100).toFixed(1)}% | ${(score.healthy.precision * 100).toFixed(1)}%/${(score.healthy.recall * 100).toFixed(1)}%/${(score.healthy.f1 * 100).toFixed(1)}% | ${score.kidFriendly.fp}/${score.healthy.fp} | ${score.exactMatches}/${score.reviewedResults} | ${costPerCorrect} |`);
    }
    const eligible = scores.filter((score) => score.kidFriendly.precision >= 0.85
      && score.healthy.precision >= 0.85
      && score.reviewedResults === expectedReviewed
      && !modelSummaries.find((summary) => summary.model === score.model)?.nonBlind);
    const bestExactMatches = Math.max(...eligible.map((score) => score.exactMatches), -Infinity);
    const recommendation = eligible
      .filter((score) => bestExactMatches - score.exactMatches <= 1)
      .sort((left, right) =>
        (modelSummaries.find((summary) => summary.model === left.model)?.projectedReadyBatchUsd ?? Infinity)
        - (modelSummaries.find((summary) => summary.model === right.model)?.projectedReadyBatchUsd ?? Infinity))[0];
    lines.push(
      '',
      recommendation
        ? `Recommended qualifying model: **${recommendation.model}** (at least 85% precision for both tags; price breaks quality ties of one recipe or less).`
        : 'No model currently qualifies for a production recommendation at 85% precision for both tags.',
    );
  } else {
    lines.push('', 'Human scores are pending. No quality winner is declared before user judgments.', '');
  }
  lines.push(
    '',
    '## Blind candidate key',
    '',
    '| Sample | Candidate | Model |',
    '|---|---|---|',
  );
  for (const row of blindRows) {
    for (const candidate of row.candidates) {
      lines.push(`| ${row.sample.sampleKey} | ${candidate.label} | ${candidate.model} |`);
    }
  }
  return `${lines.join('\n')}\n`;
}
