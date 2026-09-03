import { describe, expect, it } from 'vitest';

import {
  aggregateByGeminiGroups,
  aggregateIngredients,
  completeRecipeIngredients,
  prepareMealsForShopping,
  type RawIngredient,
} from '../services/shoppingList';
import type { Ingredient, Recipe } from '../services/types';

function recipe(
  ingredients: Ingredient[],
  overrides: Partial<Recipe> = {},
): Recipe {
  return {
    id: 'recipe-1',
    title: 'Test recipe',
    sourceUrl: 'https://example.test/recipe',
    prepTime: '',
    cookTime: '',
    originalServings: 4,
    ingredients,
    instructions: [{ text: 'Cook.' }],
    notes: '',
    scrapedAt: new Date(0),
    ...overrides,
  };
}

describe('shopping ingredient preparation', () => {
  it('adds group-only rows without duplicating root rows', () => {
    const tomato = { name: 'tomato', quantity: 2, unit: '' };
    const oliveOil = { name: 'olive oil', quantity: 1, unit: 'tbsp' };
    const result = completeRecipeIngredients(recipe([tomato], {
      ingredientGroups: [{ name: 'Sauce', ingredients: [tomato, oliveOil] }],
    }));

    expect(result).toEqual([tomato, oliveOil]);
  });

  it('scales catalogue quantities for shopping without changing units or source recipes', () => {
    const source = recipe([
      { name: 'flour', quantity: 500, unit: 'g' },
      { name: 'milk', quantity: 2, unit: 'cup' },
    ], { schemaVersion: 2, catalogueStatus: 'ready' });

    const [prepared] = prepareMealsForShopping([{
      recipeId: 'recipe-1', recipe: source, servings: 2,
    }]);

    expect(prepared.recipe.ingredients).toEqual([
      { name: 'flour', quantity: 250, unit: 'g' },
      { name: 'milk', quantity: 1, unit: 'cup' },
    ]);
    expect(source.ingredients[0]).toEqual({ name: 'flour', quantity: 500, unit: 'g' });
  });

  it('does not rescale legacy generator recipes that already contain adjusted quantities', () => {
    const source = recipe([{ name: 'rice', quantity: 1.5, unit: 'cup' }]);
    const [prepared] = prepareMealsForShopping([{
      recipeId: 'recipe-1', recipe: source, servings: 2,
    }]);

    expect(prepared.recipe.ingredients[0]).toEqual({ name: 'rice', quantity: 1.5, unit: 'cup' });
  });
});

describe('lossless shopping aggregation', () => {
  it('retains qualitative zero-quantity ingredients as unsized rows', () => {
    const items = aggregateIngredients([{
      recipeId: 'recipe-1',
      recipe: recipe([{ name: 'Kosher salt', quantity: 0, unit: '' }]),
      servings: 4,
    }]);

    expect(items).toEqual([expect.objectContaining({
      name: 'kosher salt', quantity: 0, unit: '', checked: false, manual: false,
    })]);
  });

  it('keeps unconvertible positive amounts as residual rows instead of dropping them', () => {
    const raw: RawIngredient[] = [
      {
        id: 0, name: 'mystery mix', quantity: 100, unit: 'g',
        source: { id: 'recipe-1', title: 'Test recipe', servings: 4 },
      },
      {
        id: 1, name: 'mystery mix', quantity: 2, unit: 'piece',
        source: { id: 'recipe-1', title: 'Test recipe', servings: 4 },
      },
    ];

    const items = aggregateByGeminiGroups(raw, [{
      canonicalName: 'mystery mix',
      category: 'Pantry & Dry Goods',
      sourceIds: [0, 1],
    }]);

    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'mystery mix', quantity: 100, unit: 'g' }),
      expect.objectContaining({ name: 'mystery mix', quantity: 2, unit: 'piece' }),
    ]));
  });
});
