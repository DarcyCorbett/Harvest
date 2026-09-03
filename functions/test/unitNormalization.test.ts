import { describe, expect, it } from 'vitest';

import {
  convertLegacyInstructionUnits,
  normalizeCatalogueContent,
  parseLegacyIngredient,
} from '../src/catalogue/unitNormalization.js';

describe('legacy-compatible catalogue ingredient normalization', () => {
  it.each([
    ['2 cups squash (peeled and cubed)', { name: 'squash', quantity: 2, unit: 'cup', notes: 'peeled and cubed' }],
    ['1/2 cup olive oil – rosemary infused', { name: 'olive oil', quantity: 0.5, unit: 'cup', notes: 'rosemary infused' }],
    ['1 1/2 tablespoons sugar', { name: 'sugar', quantity: 1.5, unit: 'tbsp' }],
    ['½ teaspoon salt', { name: 'salt', quantity: 0.5, unit: 'tsp' }],
    ['2-3 lb chicken', { name: 'chicken', quantity: 0.9, unit: 'kg' }],
    ['8 ounces cheese', { name: 'cheese', quantity: 227, unit: 'g' }],
    ['2 lbs. beef', { name: 'beef', quantity: 0.9, unit: 'kg' }],
    ['250g/8oz flour', { name: 'flour', quantity: 250, unit: 'g' }],
    ['1 kg / 2 lb potatoes', { name: 'potatoes', quantity: 1, unit: 'kg' }],
    ['¼ cup/½ ounce dried flowers', { name: 'dried flowers', quantity: 0.25, unit: 'cup' }],
    ['12 ounces/340g noodles', { name: 'noodles', quantity: 340, unit: 'g' }],
    ['350 - 400g/ 12 - 14oz chicken', { name: 'chicken', quantity: 350, unit: 'g' }],
    ['▢ 3 cloves garlic, minced', { name: 'garlic', quantity: 3, unit: 'clove', notes: 'minced' }],
    ['1 cup stock (warm (not boiling))', { name: 'stock', quantity: 1, unit: 'cup', notes: 'warm (not boiling)' }],
    ['1 eggplant (aubergine) (, diced (skin on))', { name: 'eggplant', quantity: 1, unit: '', notes: 'aubergine; , diced (skin on)' }],
    ['a swish of sherry', { name: 'a swish of sherry', quantity: 0, unit: '' }],
  ])('parses %s', (input, expected) => {
    expect(parseLegacyIngredient(input)).toEqual(expected);
  });

  it('is idempotent for raw and already-structured ingredients', () => {
    const first = normalizeCatalogueContent({
      title: 'Roast',
      originalServings: 4,
      ingredients: [
        { name: '2 lb beef' },
        { name: 'stock', quantity: 1, unit: 'cups' },
      ],
      instructions: [{ text: 'Roast at 450 degrees F in a 12 inch pan.' }],
    });
    const second = normalizeCatalogueContent(first.content);
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(second.content).toEqual(first.content);
    expect(first.content.ingredients).toEqual([
      { name: 'beef', quantity: 0.9, unit: 'kg' },
      { name: 'stock', quantity: 1, unit: 'cup' },
    ]);
  });

  it('converts deterministic package and note weights embedded in ingredient text', () => {
    const result = normalizeCatalogueContent({
      title: 'Tomatoes',
      originalServings: 4,
      ingredients: [
        { name: '1 can tomatoes (14 oz)' },
        { name: '1 12 oz bag frozen raspberries' },
        { name: '1 eggplant (~450g / 16oz)' },
      ],
      instructions: [{ text: 'Cook.' }],
    });
    expect(result.issues).toEqual([]);
    expect(result.content.ingredients).toEqual([
      { name: 'tomatoes', quantity: 1, unit: 'can', notes: '397 g' },
      { name: '340 g bag frozen raspberries', quantity: 1, unit: '' },
      { name: 'eggplant', quantity: 1, unit: '', notes: '~450 g' },
    ]);
  });

  it('reports an invalid structured quantity without reparsing the name', () => {
    const result = normalizeCatalogueContent({
      title: 'Tomatoes',
      originalServings: 4,
      ingredients: [{ name: 'tomatoes', quantity: Number.NaN, unit: 'can' }],
      instructions: [{ text: 'Cook.' }],
    });
    expect(result.issues).toEqual([{ path: 'ingredients.0', reason: 'invalid-quantity' }]);
  });
});

describe('legacy-compatible instruction conversion', () => {
  it.each([
    ['450°F', '232°C'],
    ['450 °F', '232°C'],
    ['450° F', '232°C'],
    ['450 ° F', '232°C'],
    ['450 degree F', '232°C'],
    ['450 degrees F', '232°C'],
    ['450 degree Fahrenheit', '232°C'],
    ['450 degrees Fahrenheit', '232°C'],
    ['400F', '204°C'],
    ['380 F', '193°C'],
    ['400.5 degrees f', '205°C'],
    ['Bake in a 9 inch pan.', 'Bake in a 22.9cm pan.'],
    ['Cut into 1.5 inches pieces.', 'Cut into 3.8cm pieces.'],
    ['Preheat to 220°C/425°F.', 'Preheat to 220°C.'],
    ['Preheat to 180C/350F.', 'Preheat to 180°C.'],
    ['Preheat to 425°F/220°C.', 'Preheat to 220°C.'],
  ])('converts %s', (input, expected) => {
    expect(convertLegacyInstructionUnits(input)).toBe(expected);
  });

  it('leaves metric text and instruction headers unchanged', () => {
    const result = normalizeCatalogueContent({
      title: 'Cake',
      originalServings: 4,
      ingredients: [{ name: 'flour', quantity: 200, unit: 'g' }],
      instructions: [
        { text: '450 degrees F method', isHeader: true },
        { text: 'Bake at 230°C.' },
      ],
    });
    expect(result.content.instructions).toEqual([
      { text: '450 degrees F method', isHeader: true },
      { text: 'Bake at 230°C.' },
    ]);
  });
});
