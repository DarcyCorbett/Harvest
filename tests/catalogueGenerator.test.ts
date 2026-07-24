import { describe, expect, it, vi } from 'vitest';

import { CatalogueNoMatchError } from '../services/catalogueClient';
import { createCatalogueGenerator } from '../services/catalogueGenerator';
import type { GenerateConfig, GeneratedMeal, Recipe } from '../services/types';

function recipe(id: string): Recipe {
  return {
    id,
    schemaVersion: 2,
    catalogueStatus: 'ready',
    title: id,
    sourceUrl: `https://example.test/${id}`,
    prepTime: '',
    cookTime: '',
    originalServings: 4,
    ingredients: [{ name: 'rice', quantity: 1, unit: 'cup' }],
    instructions: [{ text: 'Cook.' }],
    notes: '',
    nutrition: { calories: 0, protein: 0, carbs: 0, fat: 0 },
    scrapedAt: new Date(0),
  };
}

const config: GenerateConfig = {
  startDate: new Date(2026, 6, 27),
  numberOfDays: 1,
  adults: 2,
  children: 1,
  mealTypes: ['dinner'],
  cuisineStyles: ['Mediterranean'],
  ingredientFilters: { must: [], prefer: [], exclude: [] },
};

describe('catalogue generator', () => {
  it('builds complete GeneratedMeal values without a scraper', async () => {
    const generator = createCatalogueGenerator({
      getHistory: vi.fn(async () => ({
        currentPlanRecipeIds: ['planned'],
        recentRecipeIds: ['recent'],
      })),
      select: vi.fn(async () => ({
        slots: [{
          date: '2026-07-27',
          mealType: 'dinner' as const,
          status: 'selected' as const,
          recipeId: 'selected',
          sourceKey: 'recipetineats',
        }],
      })),
      loadRecipe: vi.fn(async () => recipe('selected')),
    });

    await expect(generator.generate(config, 'household', vi.fn())).resolves.toEqual([{
      recipe: recipe('selected'),
      recipeId: 'selected',
      date: '2026-07-27',
      mealType: 'dinner',
      isFromFavourites: false,
      servings: 2.5,
    }]);
  });

  it('leaves the original plan unchanged when regeneration has no exact match', async () => {
    const original: GeneratedMeal[] = [{
      recipe: recipe('original'),
      recipeId: 'original',
      date: '2026-07-27',
      mealType: 'dinner',
      isFromFavourites: false,
      servings: 2.5,
    }];
    const generator = createCatalogueGenerator({
      getHistory: vi.fn(async () => ({ currentPlanRecipeIds: [], recentRecipeIds: [] })),
      select: vi.fn(async () => ({
        slots: [{
          date: '2026-07-27',
          mealType: 'dinner' as const,
          status: 'no-match' as const,
          relaxations: [],
        }],
      })),
      loadRecipe: vi.fn(),
    });

    await expect(generator.regenerate(
      original,
      [0],
      config,
      'household',
      vi.fn(),
    )).rejects.toBeInstanceOf(CatalogueNoMatchError);
    expect(original[0].recipeId).toBe('original');
  });
});
