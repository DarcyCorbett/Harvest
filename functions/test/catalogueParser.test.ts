import { describe, expect, it } from 'vitest';

import { parseCatalogueRecipe, parseIsoDurationMinutes } from '../src/catalogue/parser.js';
import { SOURCE_CONFIGS } from '../src/catalogue/sourceAdapters.js';

const sourceUrl = 'https://www.recipetineats.com/chicken-soup';

function page(recipe: Record<string, unknown>): string {
  return `<!doctype html><html><head><script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebPage', name: 'Page' },
      { '@type': 'Recipe', ...recipe },
    ],
  })}</script></head></html>`;
}

describe('parseIsoDurationMinutes', () => {
  it.each([
    ['PT45M', 45],
    ['PT1H30M', 90],
    ['P1DT2H', 1_560],
    ['not-a-duration', undefined],
  ])('parses %s', (value, expected) => {
    expect(parseIsoDurationMinutes(value)).toBe(expected);
  });
});

describe('parseCatalogueRecipe', () => {
  it.each(SOURCE_CONFIGS)('honors the shared parsing contract for $sourceKey fixtures', (config) => {
    const result = parseCatalogueRecipe(page({
      name: `${config.sourceKey} fixture`,
      recipeYield: '4',
      totalTime: 'PT30M',
      recipeCuisine: 'Global',
      recipeCategory: 'Dinner',
      recipeIngredient: ['1 onion'],
      recipeInstructions: ['Cook the onion.'],
    }), `https://${config.host}/fixture`);

    expect(result.content.title).toBe(`${config.sourceKey} fixture`);
    expect(result.content.ingredients).toHaveLength(1);
    expect(result.content.instructions).toHaveLength(1);
  });

  it('maps Schema.org Recipe data into canonical content and source metadata', () => {
    const result = parseCatalogueRecipe(page({
      name: 'Chicken Soup',
      description: 'A warming soup.',
      image: ['https://images.example/soup.jpg'],
      recipeYield: 'Serves 4',
      prepTime: 'PT10M',
      cookTime: 'PT35M',
      totalTime: 'PT45M',
      recipeCuisine: ['Mediterranean'],
      recipeCategory: ['Dinner', 'Healthy'],
      recipeIngredient: ['2 chicken breasts', '1 litre stock'],
      recipeInstructions: [
        { '@type': 'HowToSection', name: 'Soup', itemListElement: [
          { '@type': 'HowToStep', text: 'Brown the chicken.' },
          { '@type': 'HowToStep', text: 'Add stock and simmer.' },
        ] },
      ],
    }), sourceUrl);

    expect(result.content).toMatchObject({
      title: 'Chicken Soup',
      description: 'A warming soup.',
      imageUrl: 'https://images.example/soup.jpg',
      originalServings: 4,
      ingredients: [
        { name: '2 chicken breasts' },
        { name: '1 litre stock' },
      ],
      instructions: [
        { text: 'Brown the chicken.' },
        { text: 'Add stock and simmer.' },
      ],
    });
    expect(result.sourceMetadata).toEqual({
      prepMinutes: 10,
      cookMinutes: 35,
      totalMinutes: 45,
      mealTypes: ['dinner'],
      cuisines: ['mediterranean'],
      modifiers: ['healthy'],
    });
  });

  it('rejects pages without a complete Recipe node', () => {
    expect(() => parseCatalogueRecipe('<html></html>', sourceUrl)).toThrow('Recipe JSON-LD');
    expect(() => parseCatalogueRecipe(page({ name: 'Incomplete' }), sourceUrl)).toThrow('ingredients');
  });
});
