import { readdirSync, readFileSync } from 'node:fs';
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

const DIRECT_RECIPE_WRITE_PATTERNS = [
  /\b(?:setDoc|updateDoc|deleteDoc)\s*\(\s*doc\s*\(\s*db\s*,\s*['"]recipes['"]/g,
  /\baddDoc\s*\(\s*collection\s*\(\s*db\s*,\s*['"]recipes['"]/g,
];

function findDirectRecipeWrites(source: string): string[] {
  return DIRECT_RECIPE_WRITE_PATTERNS.flatMap((pattern) =>
    Array.from(source.matchAll(pattern), (match) => match[0]));
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

function findScopedDirectRecipeWrites(): Array<{ file: string; match: string }> {
  const workspace = process.cwd();
  return ['app', 'components', 'config', 'contexts', 'services'].flatMap((directory) =>
    sourceFiles(resolve(workspace, directory)).flatMap((file) =>
      findDirectRecipeWrites(readFileSync(file, 'utf8')).map((match) => ({
        file,
        match,
      }))));
}

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

  it.each([
    null,
    {},
    { recipeId: '' },
    { recipeId: 'x'.repeat(161) },
    { recipeId: 'server-id', extra: true },
  ])('rejects a malformed save response: %o', async (data) => {
    const client = createLegacyRecipeClient(vi.fn(async () => ({ data })));

    await expect(client.save('h1', recipe)).rejects.toThrow(
      'Invalid response from saveLegacyRecipe',
    );
  });

  it.each([
    null,
    {},
    { recipeId: '' },
    { recipeId: 'x'.repeat(161) },
    { recipeId: 'r1', extra: true },
    { recipeId: 'different-recipe' },
  ])('rejects a malformed or mismatched update response: %o', async (data) => {
    const client = createLegacyRecipeClient(vi.fn(async () => ({ data })));

    await expect(client.update('h1', 'r1', { tags: ['Dinner'] })).rejects.toThrow(
      'Invalid response from updateLegacyRecipeMetadata',
    );
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

    expect(findScopedDirectRecipeWrites()).toEqual([]);
    expect(scraperService).toContain('saveRecipe(request.householdId, recipe)');
    expect(scraperService).toContain('saveRecipe(request.householdId, fallbackRecipe)');
    expect(generatorService).toContain('householdId,');
    expect(generatorService).toContain('updateRecipeTags(householdId, meal.recipeId, merged)');
    expect(generatorService).toContain('updateRecipeFlags(householdId, recipeId, flags)');
    expect(recipeModal).toContain('legacyRecipeClient.update(householdId, recipe.id, {');
    expect(recipeModal).toContain('catalogueMetadataClient.updateLabels(recipe.id, localCourse, localTags)');
    expect(recipeModal).not.toContain('recipe.id && !isCatalogueRecipe');
    expect(recipeModal).toContain('course: localCourse');
    expect(recipeModal).toContain('tags: localTags');
  });

  it('detects direct recipe writes even when calls contain arbitrary whitespace', () => {
    const source = `
      setDoc (
        doc ( db , "recipes", recipeId ), data
      );
      updateDoc( doc( db,
        'recipes', recipeId), data);
      deleteDoc ( doc ( db , 'recipes', recipeId ) );
      addDoc (
        collection ( db , "recipes" ), data
      );
    `;

    expect(findDirectRecipeWrites(source)).toHaveLength(4);
  });
});
