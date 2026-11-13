import { describe, expect, it } from 'vitest';

import { parseCatalogueRecipe, parseIsoDurationMinutes, parseNutrition } from '../src/catalogue/parser.js';
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

describe('parseNutrition', () => {
  it('normalizes publisher energy and macro units independently', () => {
    expect(parseNutrition({
      calories: '1,046 kJ',
      proteinContent: '12.25 g',
      carbohydrateContent: '850 mg',
      fatContent: 7.04,
    })).toEqual({ calories: 250, protein: 12.3, carbs: 0.9, fat: 7 });
  });

  it('keeps valid partial nutrition and rejects invalid values', () => {
    expect(parseNutrition({ calories: '320 calories', proteinContent: '-5 g' }))
      .toEqual({ calories: 320 });
    expect(parseNutrition({ calories: 'unknown', proteinContent: '2 oz' })).toBeUndefined();
    expect(parseNutrition(undefined)).toBeUndefined();
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
      nutrition: {
        calories: '420 kcal',
        proteinContent: '35 g',
        carbohydrateContent: '8 g',
        fatContent: '20 g',
      },
    }), sourceUrl);

    expect(result.content).toMatchObject({
      title: 'Chicken Soup',
      description: 'A warming soup.',
      imageUrl: 'https://images.example/soup.jpg',
      originalServings: 4,
      ingredients: [
        { name: 'chicken breasts', quantity: 2, unit: '' },
        { name: 'stock', quantity: 1, unit: 'l' },
      ],
      instructions: [
        { text: 'Soup', isHeader: true },
        { text: 'Brown the chicken.' },
        { text: 'Add stock and simmer.' },
      ],
      nutrition: { calories: 420, protein: 35, carbs: 8, fat: 20 },
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

  it('keeps named sections, step media, attribution, ratings, taxonomy, and expanded nutrition', () => {
    const result = parseCatalogueRecipe(page({
      name: 'Enriched Soup',
      image: ['http://unsafe.test/no.jpg', 'https://images.example/one.jpg', 'https://images.example/two.jpg'],
      author: { '@type': 'Person', name: 'Recipe Author' },
      publisher: { '@type': 'Organization', name: 'Test Kitchen' },
      datePublished: '2025-01-02',
      dateModified: '2026-02-03',
      aggregateRating: { ratingValue: '4.8', ratingCount: '123' },
      recipeYield: '4',
      recipeCategory: ['Dinner', 'Soups'],
      recipeCuisine: ['Greek'],
      keywords: 'warming, weeknight',
      suitableForDiet: ['https://schema.org/GlutenFreeDiet'],
      cookingMethod: ['Simmering'],
      recipeIngredient: ['1 onion'],
      recipeInstructions: [{
        '@type': 'HowToSection', name: 'Finish the soup', itemListElement: [{
          '@type': 'HowToStep', name: 'Season', text: 'Add salt.',
          url: 'https://example.test/enriched#season',
          image: 'https://images.example/step.jpg',
          video: { embedUrl: 'https://www.youtube.com/watch?v=abc123' },
        }],
      }],
      tool: [{ '@type': 'HowToTool', name: 'Dutch oven' }],
      nutrition: {
        calories: '200 kcal', fiberContent: '6 g', sugarContent: '3 g',
        saturatedFatContent: '2 g', sodiumContent: '450 mg', cholesterolContent: '20 mg',
      },
    }), sourceUrl);

    expect(result.content).toMatchObject({
      imageUrl: 'https://images.example/one.jpg',
      imageUrls: ['https://images.example/one.jpg', 'https://images.example/two.jpg'],
      attribution: { author: 'Recipe Author', publisher: 'Test Kitchen', publishedAt: '2025-01-02' },
      sourceRating: { value: 4.8, count: 123 },
      equipment: [{ name: 'Dutch oven' }],
      dietaryClaims: ['Gluten Free'],
      cookingMethods: ['Simmering'],
      sourceKeywords: ['warming', 'weeknight'],
      nutrition: { calories: 200, fiber: 6, sugar: 3, saturatedFat: 2, sodium: 450, cholesterol: 20 },
      instructions: [
        { text: 'Finish the soup', isHeader: true },
        {
          title: 'Season', text: 'Add salt.', sourceUrl: 'https://example.test/enriched#season',
          imageUrl: 'https://images.example/step.jpg',
          videoEmbedUrl: 'https://www.youtube.com/embed/abc123',
        },
      ],
    });
  });

  it('extracts WPRM groups, structured notes, equipment, custom time, and step images', () => {
    const html = page({
      name: 'Plugin Soup', recipeYield: '2',
      recipeIngredient: ['1 onion', '2 carrots'],
      recipeInstructions: ['Chop vegetables.', 'Simmer soup.'],
    }).replace('</html>', `
      <div class="wprm-recipe-container">
        <div class="wprm-recipe-ingredients-container">
          <div class="wprm-recipe-ingredient-group"><h4 class="wprm-recipe-ingredient-group-name">Vegetables</h4><ul>
            <li class="wprm-recipe-ingredient">1 onion</li><li class="wprm-recipe-ingredient">2 carrots</li>
          </ul></div>
        </div>
        <div class="wprm-recipe-instructions-container">
          <div class="wprm-recipe-instruction-group"><h4 class="wprm-recipe-instruction-group-name">Cook</h4>
            <div class="wprm-recipe-instruction">Chop vegetables.<img src="https://images.example/chop.jpg"></div>
            <div class="wprm-recipe-instruction">Simmer soup.</div>
          </div>
        </div>
        <div class="wprm-recipe-equipment-container"><div class="wprm-recipe-equipment">Stock pot</div></div>
        <div class="wprm-recipe-notes-container"><p>Salt to taste.</p></div>
        <div class="wprm-recipe-custom-time-container"><span class="wprm-recipe-custom-time-name">Resting:</span> 15 minutes</div>
      </div></html>`);
    const result = parseCatalogueRecipe(html, sourceUrl);
    expect(result.content).toMatchObject({
      ingredientGroups: [{ name: 'Vegetables' }],
      equipment: [{ name: 'Stock pot' }],
      additionalTimes: [{ label: 'Resting', minutes: 15 }],
      noteSections: [{ items: ['Salt to taste.'] }],
      instructions: [
        { text: 'Cook', isHeader: true },
        { text: 'Chop vegetables.', imageUrl: 'https://images.example/chop.jpg' },
        { text: 'Simmer soup.' },
      ],
    });
  });

  it.each([
    ['Tasty Recipes', 'tasty-recipes', 'tasty-recipes-notes-body'],
    ['Mediavine Create', 'mv-create-card', 'mv-create-notes'],
    ['WP Delicious', 'delicious-recipe', 'delicious-recipe-notes'],
    ['Cooked', 'cooked-recipe-card', 'cooked-recipe-notes'],
    ['WPZoom', 'wpzoom-recipe-card', 'wpzoom-recipe-card-notes'],
    ['Mantle', 'recipe-card', 'recipe-card__notes'],
  ])('uses the %s plugin profile for structured notes', (_name, containerClass, notesClass) => {
    const html = page({
      name: 'Profile Recipe', recipeYield: '2', recipeIngredient: ['1 onion'],
      recipeInstructions: ['Cook.'],
    }).replace('</html>', `<div class="${containerClass}"><div class="${notesClass}"><p>Keep chilled.</p></div></div></html>`);
    expect(parseCatalogueRecipe(html, sourceUrl).content).toMatchObject({
      notes: 'Keep chilled.', noteSections: [{ items: ['Keep chilled.'] }],
    });
  });

  it('preserves mixed note paragraphs and list items in source order', () => {
    const html = page({
      name: 'Ordered Notes', recipeYield: '2', recipeIngredient: ['1 onion'],
      recipeInstructions: ['Cook.'],
    }).replace('</html>', '<div class="wprm-recipe-container"><div class="wprm-recipe-notes-container"><p>First paragraph.<br>Second line.</p><ul><li>Third item.</li></ul><p>Fourth paragraph.</p></div></div></html>');
    expect(parseCatalogueRecipe(html, sourceUrl).content.noteSections).toEqual([
      { items: ['First paragraph.', 'Second line.', 'Third item.', 'Fourth paragraph.'] },
    ]);
  });

  it('rejects pages without a complete Recipe node', () => {
    expect(() => parseCatalogueRecipe('<html></html>', sourceUrl)).toThrow('non-recipe-page');
    expect(() => parseCatalogueRecipe(page({ name: 'Incomplete' }), sourceUrl))
      .toThrow('Recipe is missing ingredients');
    expect(() => parseCatalogueRecipe(page({
      name: 'Missing yield',
      recipeIngredient: ['1 onion'],
      recipeInstructions: ['Cook.'],
    }), sourceUrl)).toThrow('Recipe is missing servings');
  });

  it('parses public WordPress Recipe Maker markup when JSON-LD is absent', () => {
    const result = parseCatalogueRecipe(`
      <div class="wprm-recipe">
        <h2 class="wprm-recipe-name">WPRM Soup</h2>
        <span class="wprm-recipe-servings">4 servings</span>
        <li class="wprm-recipe-ingredient">1 onion</li>
        <div class="wprm-recipe-instruction-text">Simmer the soup.</div>
      </div>
    `, sourceUrl);
    expect(result.content).toMatchObject({
      title: 'WPRM Soup',
      ingredients: [{ name: 'onion', quantity: 1, unit: '' }],
      instructions: [{ text: 'Simmer the soup.' }],
    });
  });

  it('parses Tasty Recipes and microdata fallbacks', () => {
    const tasty = parseCatalogueRecipe(`
      <article class="tasty-recipes">
        <h2 class="tasty-recipes-title">Tasty Pasta</h2>
        <span class="tasty-recipes-yield">Serves 2</span>
        <li class="ingredient">200g pasta</li>
        <li class="instruction">Boil the pasta.</li>
      </article>
    `, sourceUrl);
    expect(tasty.content.title).toBe('Tasty Pasta');

    const microdata = parseCatalogueRecipe(`
      <article itemscope itemtype="https://schema.org/Recipe">
        <h1 itemprop="name">Microdata Curry</h1>
        <span itemprop="recipeYield">4</span>
        <span itemprop="recipeIngredient">1 onion</span>
        <div itemprop="recipeInstructions">Cook until tender.</div>
      </article>
    `, sourceUrl);
    expect(microdata.content.title).toBe('Microdata Curry');
  });

  it('parses a Recipe from public embedded application state', () => {
    const result = parseCatalogueRecipe(`
      <script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
        '@graph': [{
          '@type': 'Recipe',
          name: 'State Stew',
          recipeYield: '4',
          recipeIngredient: ['1 carrot'],
          recipeInstructions: ['Simmer.'],
        }],
      })}</script>
    `, sourceUrl);
    expect(result.content.title).toBe('State Stew');
  });
});
