import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  buildEffectiveMetadata,
  buildSearchFields,
  canonicalRecipeId,
  canonicalizeRecipeUrl,
  normalizeIngredientTokens,
  validateReadyRecipe,
  type CanonicalRecipeV2,
} from '../src/catalogue/domain.js';

function readyRecipe(): CanonicalRecipeV2 {
  const effective = {
    totalMinutes: 30,
    totalTimeProvenance: 'source' as const,
    mealTypes: ['dinner'] as const,
    cuisines: ['mediterranean'] as const,
    modifiers: ['healthy', 'salad'] as const,
  };

  return {
    schemaVersion: 2,
    id: 'recipe-id',
    status: 'ready',
    source: {
      key: 'recipetineats',
      canonicalUrl: 'https://www.recipetineats.com/chicken-salad',
      originalUrl: 'https://www.recipetineats.com/chicken-salad?utm_source=test',
    },
    content: {
      title: 'Chicken salad',
      originalServings: 4,
      ingredients: [
        { name: 'Chicken breasts' },
        { name: 'Extra-virgin olive oil' },
      ],
      instructions: [{ text: 'Cook the chicken.' }],
    },
    sourceMetadata: {
      totalMinutes: 30,
      mealTypes: ['dinner'],
      cuisines: ['mediterranean'],
      modifiers: ['healthy', 'salad'],
    },
    effective,
    search: buildSearchFields(effective, ['Chicken breasts', 'Extra-virgin olive oil'], 0.25),
    classification: {
      parserVersion: 1,
      taxonomyVersion: 1,
      sources: {},
      complete: true,
    },
    ingestion: {
      contentHash: 'abc123',
      firstIngestedAt: '2026-07-18T00:00:00.000Z',
      lastChangedAt: '2026-07-18T00:00:00.000Z',
    },
  };
}

describe('canonical recipe identity', () => {
  it('normalizes host, ports, fragments, tracking parameters, query ordering, and trailing slashes', () => {
    expect(canonicalizeRecipeUrl(
      'HTTPS://WWW.RecipeTinEats.com:443/chicken/?utm_source=x&b=2&a=1#card',
    )).toBe('https://www.recipetineats.com/chicken?a=1&b=2');
  });

  it('creates a deterministic unprefixed SHA-256 ID from the canonical URL', () => {
    const url = 'https://www.recipetineats.com/chicken';
    expect(canonicalRecipeId(url)).toBe(
      createHash('sha256').update(url, 'utf8').digest('hex'),
    );
  });
});

describe('ingredient token normalization', () => {
  it('folds accents, singularizes conservative plurals, and removes quantities and stop words', () => {
    expect(normalizeIngredientTokens([
      '2 large Chicken Breasts',
      '1 tbsp extra-virgin olive oil',
      'Jalape\u00f1os, sliced',
    ])).toEqual([
      'chicken',
      'breast',
      'extra',
      'virgin',
      'olive',
      'oil',
      'jalapeno',
    ]);
  });
});

describe('effective metadata and search fields', () => {
  it('uses manual total before source total and derived prep plus cook', () => {
    expect(buildEffectiveMetadata(
      {
        prepMinutes: 10,
        cookMinutes: 20,
        totalMinutes: 40,
        mealTypes: ['dinner'],
        cuisines: ['italian'],
        modifiers: ['healthy'],
      },
      { totalMinutes: 25, mealTypes: ['lunch'], modifiers: null },
    )).toEqual({
      prepMinutes: 10,
      cookMinutes: 20,
      totalMinutes: 25,
      totalTimeProvenance: 'manual',
      mealTypes: ['lunch'],
      cuisines: ['italian'],
      modifiers: ['healthy'],
    });

    expect(buildEffectiveMetadata(
      { prepMinutes: 10, cookMinutes: 20, mealTypes: ['dinner'] },
      { totalMinutes: null },
    ).totalTimeProvenance).toBe('derived');
  });

  it('rebuilds all dependent search fields including salad and duration flags', () => {
    expect(buildSearchFields({
      totalMinutes: 35,
      totalTimeProvenance: 'manual',
      mealTypes: ['lunch'],
      cuisines: ['mediterranean'],
      modifiers: ['vegetarian', 'kid-friendly', 'healthy', 'salad'],
    }, ['Chickpeas'], 0.75)).toEqual({
      selectionKeys: ['lunch|any', 'lunch|mediterranean'],
      vegetarian: true,
      kidFriendly: true,
      healthy: true,
      salad: true,
      quick30: false,
      moderate45: true,
      ingredientTokens: ['chickpea'],
      randomKey: 0.75,
    });
  });
});

describe('ready recipe validation', () => {
  it('accepts a complete ready recipe whose search fields match effective metadata', () => {
    expect(validateReadyRecipe(readyRecipe())).toEqual([]);
  });

  it('rejects missing attribution, unknown time, incomplete classification, and stale search fields', () => {
    const recipe = readyRecipe();
    recipe.source.canonicalUrl = '';
    recipe.effective.totalMinutes = undefined;
    recipe.classification.complete = false;
    recipe.search.salad = false;

    expect(validateReadyRecipe(recipe)).toEqual(expect.arrayContaining([
      'source.canonicalUrl',
      'effective.totalMinutes',
      'classification.complete',
      'search',
    ]));
  });
});
