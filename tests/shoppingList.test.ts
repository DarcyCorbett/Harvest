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

  it('combines "of white pepper" and "white pepper" when units permit it', () => {
    const items = aggregateIngredients([
      {
        recipeId: 'recipe-1',
        recipe: recipe([{ name: 'of white pepper', quantity: 1, unit: 'tsp' }]),
        servings: 4,
      },
      {
        recipeId: 'recipe-2',
        recipe: recipe([{ name: 'white pepper', quantity: 2, unit: 'tsp' }]),
        servings: 4,
      },
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      name: 'white pepper',
      quantity: 3,
      unit: 'tsp',
    });
  });

  it('keeps incompatible units separate when aggregating pepper', () => {
    const items = aggregateIngredients([
      {
        recipeId: 'recipe-1',
        recipe: recipe([{ name: 'of white pepper', quantity: 1, unit: 'piece' }]),
        servings: 4,
      },
      {
        recipeId: 'recipe-2',
        recipe: recipe([{ name: 'white pepper', quantity: 50, unit: 'g' }]),
        servings: 4,
      },
    ]);

    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'white pepper', quantity: 50, unit: 'g' }),
        expect.objectContaining({ name: 'white pepper', quantity: 1, unit: 'piece' }),
      ]),
    );
  });

  it('does not append duplicate rows in completeRecipeIngredients when notes differ cosmetically', () => {
    const rootPrawns = {
      name: 'chopped raw small prawns/shrimp',
      quantity: 100,
      unit: 'g',
      notes: 'peeled and deveined (Note 4)',
    };
    const groupedPrawns = {
      name: 'chopped raw small prawns/shrimp',
      quantity: 100,
      unit: 'g',
      notes: 'Note 4; peeled and deveined',
    };
    const result = completeRecipeIngredients(
      recipe([rootPrawns], {
        ingredientGroups: [{ name: 'Option 1', ingredients: [groupedPrawns] }],
      }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(groupedPrawns);
  });

  it('uses only grouped ingredients when equal-length lists differ', () => {
    const salt = { name: 'salt', quantity: 1, unit: 'pinch' };
    const pepper = { name: 'pepper', quantity: 1, unit: 'pinch' };
    const oil = { name: 'oil', quantity: 1, unit: 'tbsp' };

    const result = completeRecipeIngredients(
      recipe([salt, pepper], {
        ingredientGroups: [{ name: 'Main', ingredients: [salt, oil] }],
      }),
    );
    expect(result).toEqual([salt, oil]);
  });
});
