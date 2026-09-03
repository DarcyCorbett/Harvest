import { describe, expect, it } from 'vitest';

import {
  ALL_MODELS,
  DISH_MEAL_TYPES,
  LUNA_MODEL,
  SOURCE_KEYS,
  TARGET_STRATA,
  buildDisagreementShortlist,
  buildMealTypePrompt,
  createLunaTemplate,
  createReviewTemplate,
  fingerprintDocuments,
  importLunaResults,
  scoreReview,
  selectMealTypeEvaluationSamples,
  summarizeModels,
  tokenCost,
  validateMealTypeResponse,
} from '../scripts/lib/catalogueMealTypeEvaluation.mjs';

const titles = {
  'snack-dessert': 'Chocolate Cookie',
  'component-cocktail': 'Classic Cocktail',
  'side-component': 'Roasted Vegetable Side',
  'breakfast-lunch': 'Egg Omelette',
  'lunch-dinner': 'Beef Stew',
  'snack-meal-overlap': 'Savory Hand Pie',
};

function recipe(sourceKey, id, title = `Ordinary Recipe ${id}`, mealTypes = ['dinner']) {
  return {
    id: `${sourceKey}-${id}`,
    schemaVersion: 2,
    status: 'ready',
    source: {
      key: sourceKey,
      canonicalUrl: `https://example.test/${sourceKey}/${id}`,
    },
    content: {
      title,
      description: `Description for ${title}`,
      originalServings: 4,
      ingredients: [{ quantity: 1, unit: 'cup', name: 'ingredient' }],
      instructions: [{ text: 'Cook and serve.' }],
      nutrition: { calories: 200 },
    },
    effective: { mealTypes, cuisines: ['global'], modifiers: [] },
  };
}

function catalogue() {
  return SOURCE_KEYS.flatMap((sourceKey) => [
    ...TARGET_STRATA.flatMap((stratum) => Array.from({ length: 6 }, (_value, index) =>
      recipe(sourceKey, `${stratum}-${index}`, titles[stratum],
        stratum === 'breakfast-lunch' ? ['breakfast']
          : stratum === 'lunch-dinner' ? ['lunch', 'dinner']
            : stratum === 'side-component' ? ['side']
              : stratum === 'snack-meal-overlap' ? ['snack'] : ['dinner']))),
    ...Array.from({ length: 10 }, (_value, index) => recipe(sourceKey, `ordinary-${index}`)),
  ]);
}

function evidence(overrides = {}) {
  return {
    mode: 'dish',
    roles: Object.fromEntries(DISH_MEAL_TYPES.map((type) => [type, type === 'dinner'])),
    componentKind: 'none',
    confidence: 'high',
    reason: 'A complete dinner meal.',
    ...overrides,
  };
}

function result(sampleKey, model, mealTypes, { valid = true } = {}) {
  const component = mealTypes.includes('component');
  const value = evidence({
    mode: component ? 'component' : 'dish',
    roles: Object.fromEntries(DISH_MEAL_TYPES.map((type) => [type, mealTypes.includes(type)])),
    componentKind: component ? 'other-non-meal' : 'none',
    reason: 'Evidence-based classification.',
  });
  return {
    sampleKey,
    model,
    validation: valid ? validateMealTypeResponse(value) : { valid: false, errors: ['test'] },
    usage: { inputTokens: 100, outputTokens: 20 },
    latencyMs: 50,
    costUsd: 0.001,
    ...(model === LUNA_MODEL ? { apiEquivalentCostUsd: 0.001 } : {}),
  };
}

describe('catalogue meal-type evaluation', () => {
  it('selects a deterministic 24/24 sample with exact source quotas and exclusions', () => {
    const recipes = catalogue();
    const excluded = [recipes[0].id];
    const first = selectMealTypeEvaluationSamples(recipes, { excludedRecipeIds: excluded });
    const second = selectMealTypeEvaluationSamples([...recipes].reverse(), { excludedRecipeIds: excluded });
    expect(first).toEqual(second);
    expect(first).toHaveLength(48);
    expect(new Set(first.map((sample) => sample.recipeId))).toHaveLength(48);
    expect(first.some((sample) => excluded.includes(sample.recipeId))).toBe(false);
    expect(first.filter((sample) => sample.selectionKind === 'representative')).toHaveLength(24);
    expect(first.filter((sample) => sample.selectionKind === 'targeted')).toHaveLength(24);
    for (const stratum of TARGET_STRATA) {
      expect(first.filter((sample) => sample.targetStratum === stratum)).toHaveLength(4);
    }
    const sourceCounts = SOURCE_KEYS.map((sourceKey) =>
      first.filter((sample) => sample.sourceKey === sourceKey).length);
    expect(sourceCounts.every((count) => count === 3 || count === 4)).toBe(true);
    expect(sourceCounts.filter((count) => count === 4)).toHaveLength(9);
  });

  it('does not expose current tags in the model prompt', () => {
    const sample = selectMealTypeEvaluationSamples(catalogue())[0];
    sample.currentMealTypes = ['dinner'];
    const prompt = buildMealTypePrompt(sample);
    expect(prompt).toContain('Dessert-style pancakes');
    expect(prompt).toContain('Component is always exclusive');
    expect(prompt).toContain('complete prepared food as written');
    expect(prompt).toContain('not a component merely because it can also be used as an ingredient');
    expect(prompt).toContain('recipe itself must constitute a complete meal');
    expect(prompt).toContain('distinct accompaniment to a main dish');
    expect(prompt).not.toContain('currentMealTypes');
  });

  it('accepts controlled overlaps and derives ordered labels', () => {
    const value = evidence({
      roles: {
        breakfast: true, lunch: false, dinner: false, side: false, snack: true, dessert: true,
      },
      reason: 'Dessert-style pancakes are breakfast, dessert, and a possible normal snack.',
    });
    expect(validateMealTypeResponse(value)).toMatchObject({
      valid: true,
      mealTypes: ['breakfast', 'snack', 'dessert'],
    });
  });

  it('enforces component exclusivity and dessert overlap restrictions', () => {
    const validComponent = evidence({
      mode: 'component',
      roles: Object.fromEntries(DISH_MEAL_TYPES.map((type) => [type, false])),
      componentKind: 'drink-cocktail',
      reason: 'A cocktail is a non-meal drink.',
    });
    expect(validateMealTypeResponse(validComponent)).toMatchObject({ valid: true, mealTypes: ['component'] });
    expect(validateMealTypeResponse({ ...validComponent, roles: { ...validComponent.roles, snack: true } }))
      .toMatchObject({ valid: false, errors: expect.arrayContaining(['component-not-exclusive']) });
    const dessertLunch = evidence({
      roles: { breakfast: false, lunch: true, dinner: false, side: false, snack: false, dessert: true },
    });
    expect(validateMealTypeResponse(dessertLunch))
      .toMatchObject({ valid: false, errors: expect.arrayContaining(['dessert-invalid-overlap']) });
  });

  it('rejects extra fields, missing roles, empty dishes, and long reasons', () => {
    expect(validateMealTypeResponse({ ...evidence(), extra: true })).toMatchObject({ valid: false });
    const missing = evidence();
    delete missing.roles.side;
    expect(validateMealTypeResponse(missing)).toMatchObject({ valid: false });
    expect(validateMealTypeResponse(evidence({
      roles: Object.fromEntries(DISH_MEAL_TYPES.map((type) => [type, false])),
    }))).toMatchObject({ valid: false, errors: expect.arrayContaining(['dish-without-role']) });
    expect(validateMealTypeResponse(evidence({ reason: 'x'.repeat(281) }))).toMatchObject({ valid: false });
  });

  it('calculates standard, batch, cached-input, and Luna estimated costs', () => {
    expect(tokenCost('gemini-3.1-flash-lite', { inputTokens: 1_000_000, outputTokens: 1_000_000 }))
      .toBeCloseTo(1.75);
    expect(tokenCost('gemini-3.1-flash-lite', { inputTokens: 1_000_000, outputTokens: 1_000_000 }, { batch: true }))
      .toBeCloseTo(0.875);
    expect(tokenCost('deepseek-v4-flash', {
      inputTokens: 1_000_000, cachedInputTokens: 500_000, outputTokens: 1_000_000,
    })).toBeCloseTo(0.7735);
    expect(tokenCost(LUNA_MODEL, { inputTokens: 1_000_000, outputTokens: 1_000_000 }))
      .toBeCloseTo(1.4);
    expect(tokenCost(LUNA_MODEL, { inputTokens: 1_000_000, outputTokens: 1_000_000 }, { batch: true }))
      .toBeCloseTo(0.7);
  });

  it('strictly imports one Luna result per sample', () => {
    const samples = [{
      sampleKey: 'one', title: 'One', description: '', originalServings: 1,
      ingredients: ['one ingredient'], instructions: 'Cook.', nutrition: {},
    }];
    const template = createLunaTemplate(samples);
    template[0].evidence = evidence();
    const imported = importLunaResults(samples, template);
    expect(imported[0]).toMatchObject({
      model: LUNA_MODEL,
      validation: { valid: true, mealTypes: ['dinner'] },
      subscriptionMarginalCostUsd: 0,
    });
    expect(() => importLunaResults(samples, [...template, ...template])).toThrow(/one unique entry/);
  });

  it('prioritizes new-category disagreements and creates a partial review template', () => {
    const samples = [
      { sampleKey: 'new', recipeId: 'new', title: 'Cookie', canonicalUrl: 'https://x/new', currentMealTypes: ['snack'], selectionKind: 'targeted' },
      { sampleKey: 'old', recipeId: 'old', title: 'Main', canonicalUrl: 'https://x/old', currentMealTypes: ['dinner'], selectionKind: 'representative' },
    ];
    const results = ALL_MODELS.flatMap((model, index) => [
      result('new', model, index % 2 ? ['snack', 'dessert'] : ['dessert']),
      result('old', model, index % 2 ? ['lunch'] : ['dinner']),
    ]);
    const shortlist = buildDisagreementShortlist(samples, results);
    expect(shortlist.map((row) => row.sample.sampleKey)).toEqual(['new', 'old']);
    expect(createReviewTemplate(samples, results)[0]).toMatchObject({
      sampleKey: 'new', preferredModel: null, approvedMealTypes: null,
    });
  });

  it('scores only reviewed disagreements and supports preferred-model or custom verdicts', () => {
    const samples = [{ sampleKey: 'one' }, { sampleKey: 'two' }];
    const results = ALL_MODELS.flatMap((model) => [
      result('one', model, ['snack', 'dessert']),
      result('two', model, ['component']),
    ]);
    const review = [
      { sampleKey: 'one', preferredModel: ALL_MODELS[0], approvedMealTypes: null },
      { sampleKey: 'two', preferredModel: null, approvedMealTypes: ['component'] },
    ];
    const scores = scoreReview(samples, results, review);
    expect(scores).toHaveLength(ALL_MODELS.length);
    expect(scores[0]).toMatchObject({ reviewed: 2, exactMatches: 2, exactAccuracy: 1 });
    expect(scores[0].byMealType.component.f1).toBe(1);
  });

  it('summarizes continuity separately from quality', () => {
    const samples = [{ sampleKey: 'one', currentMealTypes: ['side', 'snack'] }];
    const results = ALL_MODELS.map((model) => result('one', model, ['component']));
    const summaries = summarizeModels({ samples, results, readyRecipeCount: 100 });
    expect(summaries[0]).toMatchObject({
      currentAssignments: 2,
      retained: 0,
      removed: 2,
      componentTransitions: 1,
      dessertCount: 0,
    });
  });

  it('fingerprints identity and timestamps independent of order', () => {
    const first = fingerprintDocuments([
      { path: 'recipes/b', updateTime: '2' }, { path: 'recipes/a', updateTime: '1' },
    ]);
    const second = fingerprintDocuments([
      { path: 'recipes/a', updateTime: '1' }, { path: 'recipes/b', updateTime: '2' },
    ]);
    expect(first).toEqual(second);
    expect(fingerprintDocuments([{ path: 'recipes/a', updateTime: '2' }]).hash).not.toBe(first.hash);
  });
});
