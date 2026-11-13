import { describe, expect, it } from 'vitest';

import {
  convertInstructionUnits,
  parseIngredientString,
} from '../services/scraper/parse';
import {
  convertLegacyInstructionUnits,
  parseLegacyIngredient,
} from '../functions/src/catalogue/unitNormalization';
import { applyServingScale } from '../services/scraper/parse';
import { aggregateIngredients } from '../services/shoppingList';
import type { Recipe } from '../services/types';

describe('catalogue and legacy unit parser parity', () => {
  it.each([
    '2 cups squash (peeled and cubed)',
    '1/2 cup olive oil – rosemary infused',
    '1 1/2 tablespoons sugar',
    '½ teaspoon salt',
    '2-3 lb chicken',
    '8 ounces cheese',
    '2 lbs. beef',
    '250g/8oz flour',
    '▢ 3 cloves garlic, minced',
    '1 cup stock (warm (not boiling))',
    'a swish of sherry',
    'dash of white pepper',
    'pinch of salt',
    'cream of tartar',
    '100 &ndash; 120g/3.5 &ndash; 4 oz chopped raw small prawns/shrimp',
  ])('matches the legacy ingredient result for %s', (input) => {
    expect(parseLegacyIngredient(input)).toEqual(parseIngredientString(input));
  });

  it.each([
    'Bake at 450°F.',
    'Bake at 450 ° F.',
    'Bake at 450 degree F.',
    'Bake at 450 degrees F.',
    'Bake at 450 degree Fahrenheit.',
    'Bake at 450 degrees Fahrenheit.',
    'Bake at 400.5 degrees f in a 9 inch pan.',
  ])('matches the legacy instruction result for %s', (input) => {
    expect(convertLegacyInstructionUnits(input)).toBe(convertInstructionUnits(input));
  });
});

describe('normalized catalogue ingredients in downstream consumers', () => {
  it('scales and aggregates structured quantities', () => {
    const base: Recipe = {
      id: 'one',
      title: 'Roast',
      sourceUrl: 'https://example.test/one',
      prepTime: '10 min',
      cookTime: '20 min',
      originalServings: 4,
      ingredients: [parseLegacyIngredient('2 lb beef')],
      instructions: [{ text: 'Cook.' }],
      notes: '',
      scrapedAt: new Date(0),
    };
    const scaled = applyServingScale(base, 8);
    expect(scaled.ingredients[0]).toMatchObject({ quantity: 1.814368, unit: 'kg', name: 'beef' });
    expect(aggregateIngredients([{ recipeId: 'one', recipe: scaled, servings: 8 }]))
      .toEqual([expect.objectContaining({ name: 'beef', quantity: 1.814368, unit: 'kg' })]);
  });
});
