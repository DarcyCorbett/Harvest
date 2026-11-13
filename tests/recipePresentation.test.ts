import { describe, expect, it } from 'vitest';

import {
  hasMeaningfulNutrition,
  formatRecipeNoteItems,
  formatRecipeNotes,
  mergeRecipeLabels,
  sumKnownNutrition,
} from '../services/recipePresentation';
import type { Recipe } from '../services/types';

function recipe(nutrition?: Recipe['nutrition']): Recipe {
  return {
    title: 'Recipe',
    sourceUrl: 'https://example.test/recipe',
    prepTime: '',
    cookTime: '',
    originalServings: 1,
    ingredients: [],
    instructions: [],
    notes: '',
    ...(nutrition ? { nutrition } : {}),
    scrapedAt: new Date(0),
  };
}

describe('recipe presentation helpers', () => {
  it('merges course and tags case-insensitively while preserving display order', () => {
    expect(mergeRecipeLabels(
      ['Dinner', ' Main Course '],
      ['dinner', 'Mediterranean', 'mediterranean'],
    )).toEqual(['Dinner', 'Main Course', 'Mediterranean']);
  });

  it('recognizes meaningful nutrition and ignores zero-only sentinels', () => {
    expect(hasMeaningfulNutrition(undefined)).toBe(false);
    expect(hasMeaningfulNutrition({ calories: 0, protein: 0 })).toBe(false);
    expect(hasMeaningfulNutrition({ calories: 250 })).toBe(true);
  });

  it('sums only known nutrition values from contributing recipes', () => {
    expect(sumKnownNutrition([
      recipe({ calories: 250, protein: 10 }),
      recipe(),
      recipe({ calories: 300, fat: 12 }),
    ])).toEqual({ calories: 550, protein: 10, fat: 12, contributingRecipes: 2 });
  });

  it('restores flattened numbered notes without splitting measurements', () => {
    expect(formatRecipeNotes('1. Chill overnight. 2. Bake at 180°C. 3. Rest for 1.5 hours.')).toEqual([
      '1. Chill overnight.', '2. Bake at 180°C.', '3. Rest for 1.5 hours.',
    ]);
    expect(formatRecipeNotes('Use 1.5 cups of water at 180°C. Stir well.')).toEqual([
      'Use 1.5 cups of water at 180°C. Stir well.',
    ]);
  });

  it('formats a single flattened note-section item and preserves source order', () => {
    expect(formatRecipeNoteItems(['First note. Second note. Third note.'])).toEqual([
      'First note. Second note.', 'Third note.',
    ]);
    expect(formatRecipeNoteItems(['Keep chilled', 'Serve fresh'])).toEqual([
      '• Keep chilled', '• Serve fresh',
    ]);
  });
});
