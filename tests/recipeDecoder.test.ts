import { describe, expect, it } from 'vitest';

import { decodeRecipeDocument } from '../services/recipeDecoder';

describe('decodeRecipeDocument', () => {
  it('preserves the legacy recipe presentation shape', () => {
    const scrapedAt = new Date('2026-07-01T12:00:00Z');
    const decoded = decodeRecipeDocument('legacy-1', {
      title: 'Legacy pasta',
      sourceUrl: 'https://example.test/legacy-pasta',
      prepTime: '10 min',
      cookTime: '20 min',
      originalServings: 4,
      ingredients: [{ name: 'pasta', quantity: 200, unit: 'g' }],
      instructions: [{ text: 'Cook it.' }],
      notes: '',
      nutrition: { calories: 400, protein: 12, carbs: 60, fat: 8 },
      scrapedAt,
    });

    expect(decoded).toMatchObject({
      id: 'legacy-1',
      title: 'Legacy pasta',
      sourceUrl: 'https://example.test/legacy-pasta',
      scrapedAt,
    });
    expect(decoded?.schemaVersion).toBeUndefined();
  });

  it('maps a complete v2 recipe into the mobile recipe shape', () => {
    const decoded = decodeRecipeDocument('canonical-1', {
      schemaVersion: 2,
      status: 'ready',
      source: {
        key: 'recipetineats',
        canonicalUrl: 'https://example.test/chicken',
        originalUrl: 'https://example.test/chicken?utm_source=test',
      },
      ingestion: {
        firstIngestedAt: '2026-07-01T10:00:00.000Z',
        lastChangedAt: { toDate: () => new Date('2026-07-02T11:00:00.000Z') },
      },
      content: {
        title: 'Lemon Chicken',
        description: 'Bright and quick.',
        imageUrl: 'https://example.test/chicken.jpg',
        videoEmbedUrl: 'https://example.test/video',
        originalServings: 4,
        ingredients: [
          { name: 'chicken breast', quantity: 2, unit: 'pieces', notes: 'sliced' },
          { name: 'lemon' },
        ],
        ingredientGroups: [{
          name: 'Sauce',
          ingredients: [{ name: 'olive oil', quantity: 1, unit: 'tbsp' }],
        }],
        instructions: [{ text: 'Cook chicken.' }],
        notes: 'Serve warm.',
        nutrition: { calories: 420, protein: 35, carbs: 8, fat: 20 },
      },
      effective: {
        prepMinutes: 10,
        cookMinutes: 20,
        totalMinutes: 30,
        mealTypes: ['dinner'],
        cuisines: ['mediterranean'],
        modifiers: ['healthy', 'kid-friendly'],
      },
      classification: { parserVersion: 1, taxonomyVersion: 1, sources: {}, complete: true },
      sourceMetadata: {},
      search: {},
      needsDefrost: true,
      needsMarinate: false,
    });

    expect(decoded).toMatchObject({
      id: 'canonical-1',
      schemaVersion: 2,
      catalogueStatus: 'ready',
      title: 'Lemon Chicken',
      sourceUrl: 'https://example.test/chicken',
      prepTime: '10 min',
      cookTime: '20 min',
      totalTime: '30 min',
      originalServings: 4,
      course: ['Dinner'],
      tags: ['Mediterranean', 'Healthy', 'Kid Friendly'],
      cuisine: 'Mediterranean',
      notes: 'Serve warm.',
      needsDefrost: true,
      needsMarinate: false,
      scrapedAt: new Date('2026-07-02T11:00:00.000Z'),
    });
    expect(decoded?.ingredients[1]).toEqual({
      name: 'lemon',
      quantity: 0,
      unit: '',
    });
    expect(decoded?.ingredientGroups?.[0].ingredients[0]).toEqual({
      name: 'olive oil',
      quantity: 1,
      unit: 'tbsp',
    });
    expect(decoded?.nutrition).toEqual({ calories: 420, protein: 35, carbs: 8, fat: 20 });
  });

  it('allows review recipes to display but rejects operational v2 documents', () => {
    const review = decodeRecipeDocument('review-1', {
      schemaVersion: 2,
      status: 'review',
      source: { canonicalUrl: 'https://example.test/review' },
      ingestion: {},
      content: {
        title: 'Review recipe',
        originalServings: 2,
        ingredients: [{ name: 'rice' }],
        instructions: [{ text: 'Cook.' }],
      },
      effective: { mealTypes: [], cuisines: [], modifiers: [] },
    });
    expect(review).toMatchObject({ schemaVersion: 2, catalogueStatus: 'review' });

    expect(decodeRecipeDocument('retry-1', {
      schemaVersion: 2,
      status: 'retryable',
      reasonCode: 'timeout',
    })).toBeNull();
  });

  it('decodes the expanded meal-type display labels', () => {
    const decoded = decodeRecipeDocument('expanded-1', {
      schemaVersion: 2,
      status: 'ready',
      source: { canonicalUrl: 'https://example.test/sauce' },
      ingestion: {},
      content: {
        title: 'Sauce', originalServings: 4,
        ingredients: [{ name: 'tomato' }], instructions: [{ text: 'Blend.' }],
      },
      effective: {
        mealTypes: ['snack', 'dessert', 'component'], cuisines: ['global'], modifiers: [],
      },
    });
    expect(decoded?.course).toEqual(['Snack', 'Dessert', 'Sauces, Condiments & More']);
  });

  it('rejects malformed recipe documents', () => {
    expect(decodeRecipeDocument('bad-1', null)).toBeNull();
    expect(decodeRecipeDocument('bad-2', { title: '' })).toBeNull();
    expect(decodeRecipeDocument('bad-3', {
      schemaVersion: 2,
      status: 'ready',
      content: { title: '' },
    })).toBeNull();
  });

  it('treats missing and all-zero nutrition as unavailable but preserves partial macros', () => {
    const base = {
      title: 'Nutrition test',
      sourceUrl: 'https://example.test/nutrition',
      ingredients: [],
      instructions: [],
    };
    expect(decodeRecipeDocument('missing', base)?.nutrition).toBeUndefined();
    expect(decodeRecipeDocument('zero', {
      ...base,
      nutrition: { calories: 0, protein: 0, carbs: 0, fat: 0 },
    })?.nutrition).toBeUndefined();
    expect(decodeRecipeDocument('partial', {
      ...base,
      nutrition: { calories: 250, protein: '12.5' },
    })?.nutrition).toEqual({ calories: 250, protein: 12.5 });
  });
});
