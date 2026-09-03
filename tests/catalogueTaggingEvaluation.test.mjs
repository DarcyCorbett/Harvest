import { describe, expect, it } from 'vitest';

import {
  LUNA_MODEL,
  TAG_STATES,
  buildBlindRows,
  buildClassificationPrompt,
  buildInventory,
  createHumanReviewTemplate,
  createLunaTemplate,
  fingerprintDocuments,
  importLunaResults,
  parseHumanReview,
  scoreHumanReview,
  selectEvaluationSamples,
  summarizeModels,
  tokenCost,
  validateTagResponse,
} from '../scripts/lib/catalogueTaggingEvaluation.mjs';

function evidence(overrides = {}) {
  return {
    kidFriendly: {
      standaloneOrRecognizable: true,
      coreIngredientsAccessible: true,
      broadChildAppeal: true,
      mildOrAdjustable: true,
      easyToEat: true,
      familyPractical: false,
      blocker: 'none',
      adjustment: null,
      confidence: 'high',
      reason: 'Common ingredients and an approachable mild format.',
      ...overrides.kidFriendly,
    },
    healthy: {
      nutrientDenseAnchor: true,
      meaningfulPlantsOrWholeFoods: true,
      suitableLeanOrPlantProtein: true,
      minimallyProcessed: true,
      sensibleFatAndMethod: true,
      limitedSugarRefinedStarchRichness: true,
      clearlyHealthierVersion: false,
      blocker: 'none',
      confidence: 'medium',
      reason: 'Includes vegetables and a useful protein base.',
      ...overrides.healthy,
    },
  };
}

function recipe(id, sourceKey, state = 'neither') {
  const kidFriendly = state === 'kid-only' || state === 'both';
  const healthy = state === 'healthy-only' || state === 'both';
  return {
    schemaVersion: 2,
    status: 'ready',
    id,
    source: {
      key: sourceKey,
      canonicalUrl: `https://example.com/${id}`,
      originalUrl: `https://example.com/${id}`,
    },
    content: {
      title: `Recipe ${id}`,
      description: 'A useful description.',
      originalServings: 4,
      ingredients: [
        { quantity: 1, unit: 'cup', name: 'ingredient one' },
        { name: 'ingredient two', notes: 'optional' },
      ],
      instructions: [{ text: 'Cook it gently.' }],
      nutrition: { calories: 400, protein: 20 },
    },
    effective: {
      mealTypes: ['dinner'],
      cuisines: ['global'],
      modifiers: [
        ...(kidFriendly ? ['kid-friendly'] : []),
        ...(healthy ? ['healthy'] : []),
      ],
    },
    search: { kidFriendly, healthy },
  };
}

function modelResult(sampleKey, model, response = evidence()) {
  return {
    sampleKey,
    model,
    validation: validateTagResponse(response),
    usage: { inputTokens: 100, outputTokens: 50 },
    latencyMs: 100,
    costUsd: 0.001,
    apiEquivalentCostUsd: model === LUNA_MODEL ? 0.001 : undefined,
  };
}

describe('kid-friendly and healthy catalogue evaluation', () => {
  it('selects four distinct deterministic recipes per source by existing state', () => {
    const recipes = [];
    for (const source of ['recipetineats', 'budgetbytes']) {
      for (const state of ['neither', 'kid-only', 'healthy-only', 'both']) {
        recipes.push(recipe(`${source}-${state}`, source, state));
      }
    }
    const first = selectEvaluationSamples(recipes, {
      sourceKeys: ['recipetineats', 'budgetbytes'],
      seed: 'fixed',
    });
    const second = selectEvaluationSamples([...recipes].reverse(), {
      sourceKeys: ['recipetineats', 'budgetbytes'],
      seed: 'fixed',
    });
    expect(first).toEqual(second);
    expect(first).toHaveLength(8);
    expect(new Set(first.map((sample) => sample.recipeId))).toHaveLength(8);
    expect(first.filter((sample) => sample.sourceKey === 'recipetineats')
      .map((sample) => sample.currentState)).toEqual([
      'neither', 'kid-only', 'healthy-only', 'both',
    ]);
  });

  it('fills a missing state from the stable source pool without duplicates', () => {
    const recipes = Array.from({ length: 6 }, (_, index) =>
      recipe(`only-neither-${index}`, 'recipetineats'));
    const selected = selectEvaluationSamples(recipes, {
      sourceKeys: ['recipetineats'],
      seed: 'fixed',
    });
    expect(selected).toHaveLength(4);
    expect(new Set(selected.map((sample) => sample.recipeId)).size).toBe(4);
    expect(selected.map((sample) => sample.selectionKind)).toEqual([
      'neither',
      'fallback-for-kid-only',
      'fallback-for-healthy-only',
      'fallback-for-both',
    ]);
  });

  it('selects three new recipes per source while excluding prior recipe ids', () => {
    const recipes = [];
    for (const source of ['recipetineats', 'budgetbytes']) {
      for (let index = 0; index < 8; index += 1) {
        recipes.push(recipe(`${source}-${index}`, source, TAG_STATES[index % 4]));
      }
    }
    const excludedRecipeIds = ['recipetineats-0', 'budgetbytes-0'];
    const selected = selectEvaluationSamples(recipes, {
      sourceKeys: ['recipetineats', 'budgetbytes'],
      seed: 'new-round',
      recipesPerSource: 3,
      excludedRecipeIds,
    });
    expect(selected).toHaveLength(6);
    expect(selected.filter((sample) => sample.sourceKey === 'recipetineats')).toHaveLength(3);
    expect(selected.filter((sample) => sample.sourceKey === 'budgetbytes')).toHaveLength(3);
    expect(selected.some((sample) => excludedRecipeIds.includes(sample.recipeId))).toBe(false);
  });

  it('builds a rich prompt without exposing existing tags', () => {
    const [sample] = selectEvaluationSamples([
      recipe('a', 'recipetineats'),
      recipe('b', 'recipetineats'),
      recipe('c', 'recipetineats'),
      recipe('d', 'recipetineats'),
    ], { sourceKeys: ['recipetineats'] });
    const prompt = buildClassificationPrompt(sample);
    expect(prompt).toContain('mainstream full-size supermarket');
    expect(prompt).toContain('borderline 50/50 judgment');
    expect(prompt).toContain('nutritionally significant, not necessarily more than half');
    expect(prompt).toContain('ingredient composition and cooking method');
    expect(prompt).toContain('modest honey or light cream cheese');
    expect(prompt).toContain('originalServings');
    expect(prompt).toContain('Cook it gently');
    expect(prompt).not.toContain('currentTags');
    expect(prompt).not.toContain('kid-only');
  });

  it('validates evidence and derives tags from fixed thresholds', () => {
    expect(validateTagResponse(evidence())).toMatchObject({
      valid: true,
      tags: { kidFriendly: true, healthy: true },
    });
    expect(validateTagResponse(evidence({
      kidFriendly: { easyToEat: false },
      healthy: { blocker: 'deep-fried-or-battered' },
    }))).toMatchObject({
      valid: true,
      tags: { kidFriendly: false, healthy: false },
    });
    expect(validateTagResponse(evidence({
      kidFriendly: { broadChildAppeal: false },
      healthy: {
        nutrientDenseAnchor: false,
        meaningfulPlantsOrWholeFoods: false,
        suitableLeanOrPlantProtein: false,
      },
    }))).toMatchObject({
      valid: true,
      tags: { kidFriendly: false, healthy: false },
    });
    expect(validateTagResponse(evidence({
      healthy: {
        nutrientDenseAnchor: false,
        meaningfulPlantsOrWholeFoods: false,
        suitableLeanOrPlantProtein: false,
        clearlyHealthierVersion: true,
      },
    }))).toMatchObject({
      valid: true,
      tags: { healthy: true },
    });
  });

  it('rejects extra fields, invalid enums, and overlong reasons', () => {
    expect(validateTagResponse({ ...evidence(), extra: true }).valid).toBe(false);
    expect(validateTagResponse(evidence({
      kidFriendly: { blocker: 'unknown' },
    })).errors).toContain('kidFriendly-blocker');
    expect(validateTagResponse(evidence({
      healthy: { reason: 'x'.repeat(241) },
    })).errors).toContain('healthy-reason');
  });

  it('calculates current Gemini, DeepSeek, cached, and Luna estimates', () => {
    expect(tokenCost('gemini-3.7-flash', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    })).toBe(4.5);
    expect(tokenCost('gemini-3.7-flash', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    }, { batch: true })).toBe(2.25);
    expect(tokenCost('deepseek-v4-flash', {
      inputTokens: 1_000_000,
      cachedInputTokens: 500_000,
      outputTokens: 1_000_000,
    })).toBeCloseTo(0.3514);
    expect(tokenCost(LUNA_MODEL, {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    })).toBe(1.4);
  });

  it('counts only ready recipes and preserves the four tag states', () => {
    const recipes = [
      recipe('a', 'recipetineats', 'neither'),
      recipe('b', 'recipetineats', 'kid-only'),
      recipe('c', 'recipetineats', 'healthy-only'),
      recipe('d', 'recipetineats', 'both'),
      { ...recipe('e', 'recipetineats', 'both'), status: 'review' },
    ];
    const inventory = buildInventory(recipes);
    expect(inventory.totals).toMatchObject({
      totalDocuments: 5,
      ready: 4,
      kidFriendly: 2,
      healthy: 2,
      both: 1,
      either: 3,
      neither: 1,
    });
  });

  it('imports a complete Luna subscription result set with estimated usage', () => {
    const samples = [
      { sampleKey: 'one', title: 'One', description: '', originalServings: 4,
        ingredients: ['one'], instructions: 'Cook.', nutrition: {} },
    ];
    const template = createLunaTemplate(samples);
    template[0].evidence = evidence();
    const imported = importLunaResults(samples, template);
    expect(imported[0]).toMatchObject({
      model: LUNA_MODEL,
      validation: { valid: true, tags: { kidFriendly: true, healthy: true } },
      subscriptionMarginalCostUsd: 0,
      usage: { estimated: true },
    });
    expect(imported[0].apiEquivalentCostUsd).toBeGreaterThan(0);
  });

  it('builds stable per-recipe blind mappings', () => {
    const samples = [{ sampleKey: 'one' }];
    const results = ['m1', 'm2', 'm3'].map((model) => modelResult('one', model));
    const first = buildBlindRows(samples, results);
    const second = buildBlindRows(samples, [...results].reverse());
    expect(first).toEqual(second);
    expect(first[0].candidates.map((candidate) => candidate.label)).toEqual([
      'Candidate A', 'Candidate B', 'Candidate C',
    ]);
  });

  it('leaves human scores pending until every verdict is boolean', () => {
    const samples = [{ sampleKey: 'one' }];
    const results = [modelResult('one', LUNA_MODEL)];
    expect(scoreHumanReview(samples, results, createHumanReviewTemplate(samples))).toEqual([]);
    const scores = scoreHumanReview(samples, results, [{
      sampleKey: 'one', kidFriendly: true, healthy: false,
    }]);
    expect(scores[0]).toMatchObject({
      model: LUNA_MODEL,
      kidFriendly: { precision: 1, recall: 1 },
      healthy: { fp: 1 },
      exactMatches: 0,
    });
  });

  it('accepts bare or quoted y/n only in human verdict fields', () => {
    expect(parseHumanReview('[{\"kidFriendly\": y, \"healthy\": \"N\", \"notes\": \"y\"}]'))
      .toEqual([{ kidFriendly: true, healthy: false, notes: 'y' }]);
    expect(() => parseHumanReview('[{\"kidFriendly\": maybe, \"healthy\": n}]'))
      .toThrow();
  });

  it('post-stratifies model coverage and projects both catalogue scopes', () => {
    const samples = [{
      sampleKey: 'one', sourceKey: 'recipetineats', currentState: 'neither',
      cellPopulation: 100,
    }];
    const results = [modelResult('one', LUNA_MODEL)];
    const summaries = summarizeModels({
      samples,
      results,
      inventory: { totals: { ready: 100, neither: 60 } },
    });
    expect(summaries[0]).toMatchObject({
      model: LUNA_MODEL,
      weightedKidCoverage: 1,
      weightedHealthyCoverage: 1,
      evaluationCostUsd: 0,
    });
    expect(summaries[0].projectedReadyStandardUsd).toBeGreaterThan(0);
    expect(summaries[0].projectedNeitherStandardUsd)
      .toBeLessThan(summaries[0].projectedReadyStandardUsd);
  });

  it('fingerprints document identity and update time independent of order', () => {
    const first = fingerprintDocuments([
      { path: 'b/2', updateTime: '2' },
      { path: 'a/1', updateTime: '1' },
    ]);
    const second = fingerprintDocuments([
      { path: 'a/1', updateTime: '1' },
      { path: 'b/2', updateTime: '2' },
    ]);
    expect(first).toEqual(second);
    expect(first.hash).toMatch(/^[a-f0-9]{64}$/);
  });
});
