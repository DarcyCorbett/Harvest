import { describe, expect, it, vi } from 'vitest';

import {
  hasMeaningfulCanonicalNutrition,
  runNutritionCanaries,
} from '../src/catalogue/nutritionBackfill.js';
import type { RecipeSourceAdapter } from '../src/catalogue/sourceAdapters.js';

function page(nutrition?: Record<string, unknown>): string {
  return `<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Recipe',
    name: 'Soup',
    recipeYield: '4',
    recipeCategory: 'Dinner',
    recipeCuisine: 'Global',
    recipeIngredient: ['1 onion'],
    recipeInstructions: ['Cook.'],
    ...(nutrition ? { nutrition } : {}),
  })}</script>`;
}

function adapter(responses: Record<string, Awaited<ReturnType<RecipeSourceAdapter['fetch']>>>): RecipeSourceAdapter {
  return {
    sourceKey: 'recipetineats',
    async *discover() {},
    canonicalize: (url) => url,
    fetch: vi.fn(async (url) => responses[url]),
  };
}

describe('nutrition backfill', () => {
  it('detects meaningful normalized nutrition only', () => {
    expect(hasMeaningfulCanonicalNutrition({ content: { nutrition: { calories: 200 } } } as never))
      .toBe(true);
    expect(hasMeaningfulCanonicalNutrition({ content: { nutrition: { calories: 0 } } } as never))
      .toBe(false);
    expect(hasMeaningfulCanonicalNutrition({ content: {} } as never)).toBe(false);
  });

  it('reports found, unavailable, transient, and terminal canary outcomes without writes', async () => {
    const urls = ['https://source.test/found', 'https://source.test/none',
      'https://source.test/retry', 'https://source.test/gone'];
    const source = adapter({
      [urls[0]]: { kind: 'ok', html: page({ calories: '300 kcal' }) },
      [urls[1]]: { kind: 'ok', html: page() },
      [urls[2]]: { kind: 'retryable', status: 503 },
      [urls[3]]: { kind: 'permanent', status: 404 },
    });

    const result = await runNutritionCanaries({
      adapters: [source],
      targetUrls: { recipetineats: urls },
    });

    expect(result.bySource.recipetineats).toMatchObject({
      tested: 4,
      nutritionFound: 1,
      unavailable: 1,
      transient: 1,
      terminal: 1,
    });
  });
});
