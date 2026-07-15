import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { createLegacyRecipeClient } from '../services/legacyRecipeClient';

const recipe = {
  id: 'client-id',
  title: 'Soup',
  sourceUrl: 'https://www.recipetineats.com/soup/',
  prepTime: '10 min',
  cookTime: '20 min',
  originalServings: 4,
  ingredients: [{ name: 'onion', quantity: 1, unit: '' }],
  instructions: [{ text: 'Cook.' }],
  notes: '',
  nutrition: { calories: 100, protein: 2, carbs: 20, fat: 1 },
  scrapedAt: new Date('2026-07-13T00:00:00Z'),
};

describe('legacy recipe client', () => {
  it('strips client IDs and dates before saving', async () => {
    const invoke = vi.fn(async () => ({ data: { recipeId: 'server-id' } }));
    const client = createLegacyRecipeClient(invoke);

    await expect(client.save('h1', recipe)).resolves.toBe('server-id');

    expect(invoke).toHaveBeenCalledWith('saveLegacyRecipe', {
      householdId: 'h1',
      recipe: expect.not.objectContaining({
        id: 'client-id',
        scrapedAt: expect.anything(),
      }),
    });
  });

  it('sends only the approved metadata fields to the fixed update endpoint', async () => {
    const invoke = vi.fn(async () => ({ data: { recipeId: 'r1' } }));
    const client = createLegacyRecipeClient(invoke);

    await client.update('h1', 'r1', {
      course: ['Dinner'],
      tags: ['Healthy'],
      needsDefrost: true,
      needsMarinate: false,
    });

    expect(invoke).toHaveBeenCalledWith('updateLegacyRecipeMetadata', {
      householdId: 'h1',
      recipeId: 'r1',
      course: ['Dinner'],
      tags: ['Healthy'],
      needsDefrost: true,
      needsMarinate: false,
    });
  });

  it('rejects missing household context without invoking a callable', async () => {
    const invoke = vi.fn();
    const client = createLegacyRecipeClient(invoke);

    await expect(client.save('  ', recipe)).rejects.toThrow('Household is required');
    await expect(client.update('', 'r1', { tags: ['Dinner'] })).rejects.toThrow(
      'Household is required',
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it('routes generation, label editing, and reminder caching through household-aware wrappers', () => {
    const firestoreService = readFileSync(
      resolve(process.cwd(), 'services/firestoreService.ts'),
      'utf8',
    );
    const scraperService = readFileSync(
      resolve(process.cwd(), 'services/recipeScraperService.ts'),
      'utf8',
    );
    const generatorService = readFileSync(
      resolve(process.cwd(), 'services/generatorService.ts'),
      'utf8',
    );
    const recipeModal = readFileSync(
      resolve(process.cwd(), 'components/RecipeDetailModal.tsx'),
      'utf8',
    );

    expect(firestoreService).not.toMatch(
      /(?:setDoc|updateDoc|deleteDoc)\(doc\(db, ['"]recipes['"]/,
    );
    expect(firestoreService).not.toMatch(
      /addDoc\(collection\(db, ['"]recipes['"]\)/,
    );
    expect(scraperService).toContain('saveRecipe(request.householdId, recipe)');
    expect(scraperService).toContain('saveRecipe(request.householdId, fallbackRecipe)');
    expect(generatorService).toContain('householdId,');
    expect(generatorService).toContain('updateRecipeTags(householdId, meal.recipeId, merged)');
    expect(generatorService).toContain('updateRecipeFlags(householdId, recipeId, flags)');
    expect(recipeModal).toContain('legacyRecipeClient.update(householdId, recipe.id, {');
    expect(recipeModal).toContain('course: localCourse');
    expect(recipeModal).toContain('tags: localTags');
  });
});
