import { describe, expect, it } from 'vitest';

import {
  buildClassificationPrompt,
  buildInventory,
  fingerprintDocuments,
  programmaticTags,
  selectEvaluationSamples,
  tokenCost,
  validateTagResponse,
} from '../scripts/lib/catalogueTaggingEvaluation.mjs';

function recipe(id, sourceKey, title, metadata = {}, classifierVersion = 0) {
  return {
    schemaVersion: 2,
    id,
    source: { key: sourceKey },
    content: {
      title,
      ingredients: [{ name: 'ingredient one' }, { name: 'ingredient two' }],
      time: { totalMinutes: 30 },
    },
    sourceMetadata: metadata,
    classification: { classifierVersion },
  };
}

describe('catalogue tagging evaluation', () => {
  it('selects one complete and one ambiguous distinct sample per source', () => {
    const recipes = [
      recipe('a', 'one', 'Dinner', { mealTypes: ['dinner'], cuisines: ['global'] }),
      recipe('b', 'one', 'Mystery', {}),
      recipe('c', 'two', 'Italian dinner', { mealTypes: ['dinner'] }),
      recipe('d', 'two', 'Breakfast', { cuisines: ['american'] }),
    ];
    const selected = selectEvaluationSamples(recipes, {
      sourceKeys: ['one', 'two'],
      seed: 'fixed',
    });
    expect(selected).toHaveLength(4);
    expect(new Set(selected.map((sample) => sample.sampleKey)).size).toBe(4);
    expect(selected.filter((sample) => sample.sourceKey === 'one').map((sample) => sample.selectionKind))
      .toEqual(['programmatic-complete', 'programmatic-ambiguous']);
    expect(selected.filter((sample) => sample.sourceKey === 'two').map((sample) =>
      sample.selectionKind)).toEqual(['programmatic-complete', 'seeded-fallback']);
  });

  it('matches the production deterministic title rules', () => {
    expect(programmaticTags(recipe('a', 'one', 'Greek breakfast salad', {}))).toEqual({
      mealTypes: ['breakfast'],
      cuisines: ['greek'],
      modifiers: ['salad'],
      complete: true,
    });
  });

  it('builds identical prompts from the same sample', () => {
    const sample = {
      title: 'A recipe',
      ingredients: ['one', 'two'],
    };
    expect(buildClassificationPrompt(sample)).toBe(buildClassificationPrompt(sample));
    expect(buildClassificationPrompt(sample)).toContain('Return JSON');
  });

  it('rejects invalid taxonomy values and extra fields', () => {
    expect(validateTagResponse({
      mealTypes: ['supper'],
      cuisines: ['global'],
      modifiers: [],
      explanation: 'extra',
    })).toMatchObject({
      valid: false,
      errors: expect.arrayContaining(['unexpected-fields', 'mealTypes-invalid']),
    });
  });

  it('calculates standard, cached, and batch token costs', () => {
    expect(tokenCost('gemini-3.1-flash-lite', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    })).toBe(1.75);
    expect(tokenCost('gemini-3.1-flash-lite', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    }, { batch: true })).toBe(0.875);
    expect(tokenCost('deepseek-v4-pro', {
      inputTokens: 1_000_000,
      cachedInputTokens: 500_000,
      outputTokens: 1_000_000,
    })).toBeCloseTo(1.0893125);
  });

  it('counts current, programmatic, and AI-required recipes separately', () => {
    const recipes = [
      recipe('a', 'recipetineats', 'Dinner', {
        mealTypes: ['dinner'],
        cuisines: ['global'],
      }),
      recipe('b', 'recipetineats', 'Mystery', {}),
      recipe('c', 'recipetineats', 'Mystery', {}, 1),
    ];
    const inventory = buildInventory(recipes);
    expect(inventory.totals).toMatchObject({
      recipes: 3,
      classifierCurrent: 1,
      programmaticComplete: 1,
      aiRequired: 1,
    });
  });

  it('fingerprints document identity and update time without exposing data', () => {
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
