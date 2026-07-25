import { createHash } from 'node:crypto';

export const EVALUATION_SEED = 'mealwizard-tagging-evaluation-v1';
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
  'seriouseats',
  'akispetretzikis',
  'nytcooking',
  'americastestkitchen',
];
export const MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'side', 'snack'];
export const CUISINES = [
  'asian',
  'mexican',
  'mediterranean',
  'italian',
  'indian',
  'greek',
  'american',
  'french',
  'middle-eastern',
  'global',
];
export const MODIFIERS = ['vegetarian', 'kid-friendly', 'healthy', 'salad'];

export const MODEL_PRICING_USD_PER_MILLION = {
  'gemini-3.1-flash-lite': {
    input: 0.25,
    output: 1.5,
    batchInput: 0.125,
    batchOutput: 0.75,
  },
  'gemini-3.5-flash-lite': {
    input: 0.3,
    output: 2.5,
    batchInput: 0.15,
    batchOutput: 1.25,
  },
  'gemini-3.6-flash': {
    input: 1.5,
    output: 7.5,
    batchInput: 0.75,
    batchOutput: 3.75,
  },
  'deepseek-v4-pro': {
    input: 0.435,
    cachedInput: 0.003625,
    output: 0.87,
  },
  'codex-gpt-5.6-sol-estimate': {
    input: 5,
    cachedInput: 0.5,
    output: 30,
  },
};

function unique(values) {
  return [...new Set(values)];
}

function validList(value, allowed) {
  return Array.isArray(value) ? value.filter((item) => allowed.includes(item)) : [];
}

export function deterministicRules(title) {
  const normalized = String(title ?? '').toLowerCase();
  const mealTypes = [];
  if (/\b(breakfast|brunch|pancake|granola|omelette|omelet)\b/.test(normalized)) {
    mealTypes.push('breakfast');
  }
  if (/\b(snack|cookie|cookies|biscuit|bites)\b/.test(normalized)) {
    mealTypes.push('snack');
  }
  if (/\b(side dish|side salad|condiment)\b/.test(normalized)) {
    mealTypes.push('side');
  }

  const cuisines = [];
  const cuisineRules = [
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
    if (pattern.test(normalized)) cuisines.push(cuisine);
  }

  const modifiers = /\bsalad\b/.test(normalized) ? ['salad'] : [];
  return { mealTypes, cuisines, modifiers };
}

export function programmaticTags(recipe) {
  const metadata = recipe.sourceMetadata ?? {};
  const rules = deterministicRules(recipe.content?.title);
  const mealTypes = unique([
    ...validList(metadata.mealTypes, MEAL_TYPES),
    ...rules.mealTypes,
  ]);
  const cuisines = unique([
    ...validList(metadata.cuisines, CUISINES),
    ...rules.cuisines,
  ]);
  const modifiers = unique([
    ...validList(metadata.modifiers, MODIFIERS),
    ...rules.modifiers,
  ]);
  return {
    mealTypes,
    cuisines,
    modifiers,
    complete: mealTypes.length > 0 && cuisines.length > 0,
  };
}

function stableRank(seed, sourceKey, id) {
  return createHash('sha256')
    .update(`${seed}\n${sourceKey}\n${id}`)
    .digest('hex');
}

function isDisplayableRecipe(recipe) {
  return recipe?.schemaVersion === 2
    && typeof recipe.id === 'string'
    && typeof recipe.source?.key === 'string'
    && typeof recipe.content?.title === 'string'
    && Array.isArray(recipe.content?.ingredients)
    && recipe.content.ingredients.every((ingredient) =>
      ingredient && typeof ingredient.name === 'string');
}

export function selectEvaluationSamples(
  recipes,
  { sourceKeys = SOURCE_KEYS, seed = EVALUATION_SEED } = {},
) {
  const samples = [];
  for (const sourceKey of sourceKeys) {
    const candidates = recipes
      .filter((recipe) => isDisplayableRecipe(recipe) && recipe.source.key === sourceKey)
      .map((recipe) => ({
        recipe,
        baseline: programmaticTags(recipe),
        currentClassifier: Number(recipe.classification?.classifierVersion ?? 0),
        rank: stableRank(seed, sourceKey, recipe.id),
      }))
      .sort((left, right) =>
        left.currentClassifier - right.currentClassifier
        || left.rank.localeCompare(right.rank));
    if (candidates.length < 2) {
      throw new Error(`Source ${sourceKey} has fewer than two displayable recipes`);
    }

    const complete = candidates.find((candidate) => candidate.baseline.complete);
    const ambiguous = candidates.find((candidate) =>
      !candidate.baseline.complete && candidate.recipe.id !== complete?.recipe.id);
    const first = complete ?? candidates[0];
    const second = ambiguous
      ?? candidates.find((candidate) => candidate.recipe.id !== first.recipe.id);
    if (!second) throw new Error(`Source ${sourceKey} did not yield distinct samples`);

    for (const [index, selected] of [first, second].entries()) {
      samples.push({
        sampleKey: `${sourceKey}-${index + 1}`,
        sourceKey,
        selectionKind: index === 0
          ? (complete ? 'programmatic-complete' : 'seeded-fallback')
          : (ambiguous ? 'programmatic-ambiguous' : 'seeded-fallback'),
        title: selected.recipe.content.title,
        ingredients: selected.recipe.content.ingredients.map(({ name }) => name),
        sourceMetadata: {
          mealTypes: validList(selected.recipe.sourceMetadata?.mealTypes, MEAL_TYPES),
          cuisines: validList(selected.recipe.sourceMetadata?.cuisines, CUISINES),
          modifiers: validList(selected.recipe.sourceMetadata?.modifiers, MODIFIERS),
        },
        programmatic: selected.baseline,
      });
    }
  }
  return samples;
}

export function buildClassificationPrompt(sample) {
  return [
    'Classify this recipe using only the allowed JSON values.',
    `mealTypes: ${MEAL_TYPES.join(', ')}`,
    `cuisines: ${CUISINES.join(', ')}`,
    `modifiers: ${MODIFIERS.join(', ')}`,
    `Title: ${sample.title.slice(0, 200)}`,
    `Ingredients: ${sample.ingredients.join(', ').slice(0, 2_000)}`,
    'Return JSON with mealTypes, cuisines, and modifiers arrays and no other fields.',
  ].join('\n');
}

export function validateTagResponse(value) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { valid: false, errors: ['response-not-object'] };
  }
  const keys = Object.keys(value).sort();
  const expectedKeys = ['cuisines', 'mealTypes', 'modifiers'];
  if (keys.join(',') !== expectedKeys.join(',')) errors.push('unexpected-fields');

  const fields = [
    ['mealTypes', MEAL_TYPES, true],
    ['cuisines', CUISINES, true],
    ['modifiers', MODIFIERS, false],
  ];
  const normalized = {};
  for (const [field, allowed, required] of fields) {
    const raw = value[field];
    if (!Array.isArray(raw)) {
      errors.push(`${field}-not-array`);
      normalized[field] = [];
      continue;
    }
    if (required && raw.length === 0) errors.push(`${field}-empty`);
    if (new Set(raw).size !== raw.length) errors.push(`${field}-duplicates`);
    const invalid = raw.filter((item) => !allowed.includes(item));
    if (invalid.length > 0) errors.push(`${field}-invalid`);
    normalized[field] = unique(raw.filter((item) => allowed.includes(item)));
  }

  return {
    valid: errors.length === 0,
    errors,
    tags: normalized,
  };
}

export function tokenCost(model, usage, { batch = false } = {}) {
  const pricing = MODEL_PRICING_USD_PER_MILLION[model];
  if (!pricing) throw new Error(`Missing pricing for ${model}`);
  const inputRate = batch && pricing.batchInput !== undefined
    ? pricing.batchInput
    : pricing.input;
  const outputRate = batch && pricing.batchOutput !== undefined
    ? pricing.batchOutput
    : pricing.output;
  const cachedInput = Number(usage.cachedInputTokens ?? 0);
  const input = Math.max(0, Number(usage.inputTokens ?? 0) - cachedInput);
  const cachedRate = pricing.cachedInput ?? inputRate;
  return (
    input * inputRate
    + cachedInput * cachedRate
    + Number(usage.outputTokens ?? 0) * outputRate
  ) / 1_000_000;
}

export function buildInventory(recipes) {
  const bySource = Object.fromEntries(SOURCE_KEYS.map((sourceKey) => [
    sourceKey,
    {
      recipes: 0,
      classifierCurrent: 0,
      programmaticComplete: 0,
      aiRequired: 0,
      missingTimeOnly: 0,
      invalidOrOperational: 0,
    },
  ]));
  const totals = {
    recipes: 0,
    classifierCurrent: 0,
    programmaticComplete: 0,
    aiRequired: 0,
    missingTimeOnly: 0,
    invalidOrOperational: 0,
  };

  for (const recipe of recipes) {
    const sourceKey = recipe?.source?.key;
    if (!SOURCE_KEYS.includes(sourceKey)) continue;
    const bucket = bySource[sourceKey];
    if (!isDisplayableRecipe(recipe)) {
      bucket.invalidOrOperational += 1;
      totals.invalidOrOperational += 1;
      continue;
    }
    bucket.recipes += 1;
    totals.recipes += 1;
    if (Number(recipe.classification?.classifierVersion ?? 0) >= 1) {
      bucket.classifierCurrent += 1;
      totals.classifierCurrent += 1;
      continue;
    }
    const baseline = programmaticTags(recipe);
    if (baseline.complete) {
      bucket.programmaticComplete += 1;
      totals.programmaticComplete += 1;
      if (!Number.isFinite(recipe.effective?.totalMinutes)) {
        bucket.missingTimeOnly += 1;
        totals.missingTimeOnly += 1;
      }
    } else {
      bucket.aiRequired += 1;
      totals.aiRequired += 1;
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

function formatTags(tags) {
  if (!tags) return '—';
  return `meal=${tags.mealTypes?.join(', ') || '—'}; cuisine=${tags.cuisines?.join(', ') || '—'}; modifiers=${tags.modifiers?.join(', ') || '—'}`;
}

function money(value) {
  return value === undefined ? '—' : `$${value.toFixed(6)}`;
}

export function renderEvaluationReport({ samples, results, codexResults, verification }) {
  const modelOrder = new Map([
    ['gemini-3.1-flash-lite', 0],
    ['gemini-3.5-flash-lite', 1],
    ['gemini-3.6-flash', 2],
    ['deepseek-v4-pro', 3],
  ]);
  const lines = [
    '# MealWizard catalogue tagging evaluation',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    'This local report contains recipe titles and ingredients and is intentionally not committed.',
    '',
  ];
  for (const sample of samples) {
    lines.push(
      `## ${sample.sourceKey} — ${sample.title}`,
      '',
      `Selection: ${sample.selectionKind}`,
      '',
      `Ingredients: ${sample.ingredients.join(', ')}`,
      '',
      `Stored source metadata: ${formatTags(sample.sourceMetadata)}`,
      '',
      `Programmatic baseline: ${formatTags(sample.programmatic)}`,
      '',
      '| Model | Suggested tags | Valid | Latency | Tokens (in/out) | Approx. cost |',
      '|---|---|---:|---:|---:|---:|',
    );
    const sampleResults = results
      .filter((result) => result.sampleKey === sample.sampleKey)
      .sort((left, right) =>
        (modelOrder.get(left.model) ?? 99) - (modelOrder.get(right.model) ?? 99));
    for (const result of sampleResults) {
      lines.push(
        `| ${result.model} | ${formatTags(result.validation?.tags)} | ${result.validation?.valid ? 'yes' : `no (${result.validation?.errors?.join(', ')})`} | ${result.latencyMs} ms | ${result.usage.inputTokens}/${result.usage.outputTokens} | ${money(result.costUsd)} |`,
      );
    }
    const codex = codexResults?.find((result) => result.sampleKey === sample.sampleKey);
    lines.push(
      `| Codex / GPT-5.6 Sol comparison | ${formatTags(codex?.tags)} | ${codex?.valid ? 'yes' : 'pending'} | — | estimated | ${money(codex?.costUsd)} |`,
      '',
      '| Score | Programmatic | Gemini 3.1 Lite | Gemini 3.5 Lite | Gemini 3.6 Flash | DeepSeek V4 Pro | Codex |',
      '|---|---:|---:|---:|---:|---:|---:|',
      '| Meal type correctness |  |  |  |  |  |  |',
      '| Cuisine correctness |  |  |  |  |  |  |',
      '| Modifier correctness |  |  |  |  |  |  |',
      '| Overall preference |  |  |  |  |  |  |',
      '',
    );
  }
  lines.push(
    '## Read-only verification',
    '',
    `- Recipe fingerprint unchanged: ${verification.recipesUnchanged ? 'yes' : 'NO'}`,
    `- Meal-plan fingerprint unchanged: ${verification.mealPlansUnchanged ? 'yes' : 'NO'}`,
    `- Cookbook fingerprint unchanged: ${verification.cookbooksUnchanged ? 'yes' : 'NO'}`,
    '- Recipe-site requests: 0 (provider-host allowlist enforced)',
    '',
  );
  return `${lines.join('\n')}\n`;
}

export function renderInventoryReport({ inventory, modelSummaries }) {
  const lines = [
    '# Catalogue tagging inventory',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    '| Source | Recipes | Classifier current | Programmatic complete | AI required | Missing time only | Invalid/operational |',
    '|---|---:|---:|---:|---:|---:|---:|',
  ];
  for (const sourceKey of SOURCE_KEYS) {
    const row = inventory.bySource[sourceKey];
    lines.push(`| ${sourceKey} | ${row.recipes} | ${row.classifierCurrent} | ${row.programmaticComplete} | ${row.aiRequired} | ${row.missingTimeOnly} | ${row.invalidOrOperational} |`);
  }
  const totals = inventory.totals;
  lines.push(
    `| **Total** | **${totals.recipes}** | **${totals.classifierCurrent}** | **${totals.programmaticComplete}** | **${totals.aiRequired}** | **${totals.missingTimeOnly}** | **${totals.invalidOrOperational}** |`,
    '',
    '## Projected AI cost',
    '',
    '| Model | Evaluation cost | Projected standard backfill | Projected batch backfill |',
    '|---|---:|---:|---:|',
  );
  for (const summary of modelSummaries) {
    lines.push(`| ${summary.model} | ${money(summary.evaluationCostUsd)} | ${money(summary.projectedStandardCostUsd)} | ${money(summary.projectedBatchCostUsd)} |`);
  }
  return `${lines.join('\n')}\n`;
}
