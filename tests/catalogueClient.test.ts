import { describe, expect, it, vi } from 'vitest';

import {
  CatalogueNoMatchError,
  buildCatalogueMetadataOperations,
  buildCatalogueSelectionRequest,
  createCatalogueClient,
  createCatalogueMetadataClient,
  materializeCatalogueMeals,
  normalizeIngredientFilters,
} from '../services/catalogueClient';
import type { GenerateConfig, Recipe } from '../services/types';

function config(overrides: Partial<GenerateConfig> = {}): GenerateConfig {
  return {
    startDate: new Date(2026, 6, 27),
    numberOfDays: 2,
    adults: 2,
    children: 1,
    mealTypes: ['dinner', 'breakfast'],
    cuisineStyles: ['Quick & Easy', 'Mediterranean', 'Italian', 'Healthy', 'Salad'],
    ingredientFilters: {
      must: [' Chicken ', 'chicken'],
      prefer: ['lemon', 'chicken', 'nuts'],
      exclude: ['Nuts'],
    },
    settings: {
      sourceWeights: {},
      ingredientWeights: {},
      kidFriendly: { excludedIngredients: ['anchovy'] },
    },
    ...overrides,
  };
}

const readyRecipe: Recipe = {
  id: 'recipe-1',
  schemaVersion: 2,
  catalogueStatus: 'ready',
  title: 'Recipe',
  sourceUrl: 'https://example.test/recipe',
  prepTime: '10 min',
  cookTime: '20 min',
  originalServings: 4,
  ingredients: [{ name: 'chicken', quantity: 1, unit: '' }],
  instructions: [{ text: 'Cook.' }],
  notes: '',
  nutrition: { calories: 0, protein: 0, carbs: 0, fat: 0 },
  scrapedAt: new Date(0),
};

describe('catalogue generation request mapping', () => {
  it('normalizes filters, rejects hard conflicts, and removes redundant preferences', () => {
    expect(normalizeIngredientFilters({
      must: [' Chicken ', 'chicken'],
      prefer: ['lemon', 'chicken', 'nuts'],
      exclude: ['Nuts'],
    })).toEqual({
      must: ['chicken'],
      prefer: ['lemon'],
      exclude: ['nuts'],
    });

    expect(() => normalizeIngredientFilters({
      must: ['nuts'],
      prefer: [],
      exclude: ['NUTS'],
    })).toThrow('same ingredient');
  });

  it('maps dates, ordered meal types, cuisine round-robin, modifiers, time, and ingredients', () => {
    const request = buildCatalogueSelectionRequest(
      config(),
      'household-1',
      ['upcoming-1'],
      ['recent-1'],
    );

    expect(request.currentPlanRecipeIds).toEqual(['upcoming-1']);
    expect(request.recentRecipeIds).toEqual(['recent-1']);
    expect(request.slots).toHaveLength(4);
    expect(request.slots.map((slot) => [slot.date, slot.mealType, slot.cuisines])).toEqual([
      ['2026-07-27', 'breakfast', ['mediterranean']],
      ['2026-07-27', 'dinner', ['italian']],
      ['2026-07-28', 'breakfast', ['mediterranean']],
      ['2026-07-28', 'dinner', ['italian']],
    ]);
    expect(request.slots[0]).toMatchObject({
      modifiers: ['healthy', 'salad'],
      maxTotalMinutes: 30,
      ingredients: {
        must: ['chicken'],
        prefer: ['lemon'],
        exclude: ['nuts'],
      },
    });
  });

  it('adds household kid-friendly exclusions only when that modifier is selected', () => {
    const request = buildCatalogueSelectionRequest(
      config({ cuisineStyles: ['Kid Friendly'] }),
      'household-1',
      [],
      [],
    );
    expect(request.slots[0].ingredients.exclude).toEqual(['nuts', 'anchovy']);
  });

  it('orders and sends every expanded catalogue meal type', () => {
    const request = buildCatalogueSelectionRequest(config({
      numberOfDays: 1,
      mealTypes: ['component', 'dessert', 'snack', 'side'],
      cuisineStyles: [],
    }), 'household-1', [], []);
    expect(request.slots.map(({ mealType }) => mealType)).toEqual([
      'side', 'snack', 'dessert', 'component',
    ]);
  });
});

describe('catalogue callable adapter', () => {
  it('maps editable labels to canonical metadata and calls the mutation', async () => {
    expect(buildCatalogueMetadataOperations(
      ['Dinner'],
      ['Mediterranean', 'Kid Friendly', 'Salad'],
    )).toEqual({
      mealTypes: { operation: 'set', value: ['dinner'] },
      cuisines: { operation: 'set', value: ['mediterranean'] },
      modifiers: { operation: 'set', value: ['kid-friendly', 'salad'] },
    });
    expect(buildCatalogueMetadataOperations(
      ['Snack', 'Dessert', 'Sauces, Condiments & More'],
      ['Global'],
    ).mealTypes.value).toEqual(['snack', 'dessert', 'component']);

    const invoke = vi.fn(async () => ({ data: {} }));
    await createCatalogueMetadataClient(invoke).updateLabels(
      'recipe-1',
      ['Dinner'],
      ['Middle Eastern', 'Healthy'],
    );
    expect(invoke).toHaveBeenCalledWith({
      recipeId: 'recipe-1',
      operations: {
        mealTypes: { operation: 'set', value: ['dinner'] },
        cuisines: { operation: 'set', value: ['middle-eastern'] },
        modifiers: { operation: 'set', value: ['healthy'] },
      },
    });
  });

  it('requires catalogue edits to retain a meal type and cuisine', () => {
    expect(() => buildCatalogueMetadataOperations([], ['Global']))
      .toThrow('at least one meal type');
    expect(() => buildCatalogueMetadataOperations(['Dinner'], ['Healthy']))
      .toThrow('at least one cuisine');
  });

  it('strictly validates the callable response', async () => {
    const client = createCatalogueClient(vi.fn(async () => ({
      data: {
        slots: [{
          date: '2026-07-27',
          mealType: 'dinner',
          status: 'selected',
          recipeId: 'recipe-1',
          sourceKey: 'recipetineats',
        }],
      },
    })));
    await expect(client.select(buildCatalogueSelectionRequest(
      config({ numberOfDays: 1, mealTypes: ['dinner'] }),
      'household-1',
      [],
      [],
    ))).resolves.toMatchObject({ slots: [{ recipeId: 'recipe-1' }] });

    const malformed = createCatalogueClient(vi.fn(async () => ({
      data: { slots: [{ status: 'selected', recipeId: 'recipe-1' }] },
    })));
    await expect(malformed.select(buildCatalogueSelectionRequest(
      config({ numberOfDays: 1, mealTypes: ['dinner'] }),
      'household-1',
      [],
      [],
    ))).rejects.toThrow('Invalid catalogue selection response');
  });

  it('discards partial selections on no-match and formats bounded suggestions', async () => {
    const response = {
      slots: [{
        date: '2026-07-27',
        mealType: 'dinner' as const,
        status: 'selected' as const,
        recipeId: 'recipe-1',
        sourceKey: 'recipetineats',
      }, {
        date: '2026-07-28',
        mealType: 'dinner' as const,
        status: 'no-match' as const,
        relaxations: [{
          filter: 'maxTotalMinutes' as const,
          from: 30 as const,
          to: 45 as const,
          matchCount: 8,
        }],
      }],
    };

    await expect(materializeCatalogueMeals(response, vi.fn(), 3))
      .rejects.toMatchObject({
        name: 'CatalogueNoMatchError',
        message: expect.stringContaining('45 minutes'),
      });
    await materializeCatalogueMeals(response, vi.fn(), 3).catch((error) => {
      expect(error).toBeInstanceOf(CatalogueNoMatchError);
    });
  });

  it('loads only complete ready v2 recipes and produces GeneratedMeal values', async () => {
    const loadRecipe = vi.fn(async () => readyRecipe);
    const meals = await materializeCatalogueMeals({
      slots: [{
        date: '2026-07-27',
        mealType: 'dinner',
        status: 'selected',
        recipeId: 'recipe-1',
        sourceKey: 'recipetineats',
      }],
    }, loadRecipe, 3);

    expect(meals).toEqual([{
      recipe: readyRecipe,
      recipeId: 'recipe-1',
      date: '2026-07-27',
      mealType: 'dinner',
      isFromFavourites: false,
      servings: 3,
    }]);

    await expect(materializeCatalogueMeals({
      slots: [{
        date: '2026-07-27',
        mealType: 'dinner',
        status: 'selected',
        recipeId: 'recipe-1',
        sourceKey: 'recipetineats',
      }],
    }, async () => ({ ...readyRecipe, catalogueStatus: 'review' }), 3))
      .rejects.toThrow('Selected catalogue recipe is unavailable');
  });
});
