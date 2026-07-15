import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  getRecipePresentation,
  reconcileRecipeAvailability,
} from '../services/recipeAvailability';

const read = (path: string) => readFileSync(path, 'utf8');

describe('catalogue data safety', () => {
  it('has no global or single recipe deletion client API', () => {
    const service = read('services/firestoreService.ts');

    expect(service).not.toMatch(/export async function clearAllCachedRecipes/);
    expect(service).not.toMatch(/export async function deleteRecipe/);
  });

  it('has no destructive recipe-cache control in Settings', () => {
    const settings = read('components/SettingsModal.tsx');

    expect(settings).not.toContain('Clear Recipe Cache');
    expect(settings).not.toContain('clearAllCachedRecipes');
  });

  it('does not self-delete missing historical references', () => {
    const calendar = read('app/(tabs)/index.tsx');
    const cookbook = read('app/(tabs)/cookbook.tsx');

    expect(calendar).not.toContain('Self-healing');
    expect(calendar).not.toMatch(/missingIds[\s\S]{0,800}deleteMealPlanEntry/);
    expect(cookbook).not.toContain('Self-healing');
    expect(cookbook).not.toMatch(/missingIds[\s\S]{0,800}removeFromCookbook/);
  });

  it('keeps explicit household-reference removal operations', () => {
    const service = read('services/firestoreService.ts');
    const calendar = read('app/(tabs)/index.tsx');
    const cookbook = read('app/(tabs)/cookbook.tsx');

    expect(service).toMatch(/export async function deleteMealPlanEntry/);
    expect(service).toMatch(/export async function removeFromCookbook/);
    expect(calendar).toContain('onLongPress={() => handleDelete(entry)}');
    expect(calendar).toContain('deleteMealPlanEntry(householdId, entry.id!)');
    expect(cookbook).toContain('removeFromCookbook(householdId, entry.recipeId)');
    expect(cookbook).toContain('onRemove={() => handleRemove(entry)}');
  });

  it('wires distinct loading and unavailable presentation into both history screens', () => {
    const calendar = read('app/(tabs)/index.tsx');
    const cookbook = read('app/(tabs)/cookbook.tsx');

    for (const screen of [calendar, cookbook]) {
      expect(screen).toContain('reconcileRecipeAvailability');
      expect(screen).toContain('getRecipePresentation');
      expect(screen).toContain('setMissingRecipeIds');
    }

    expect(calendar).toContain('getRecipePresentation(recipe, missingRecipeIds.has(entry.recipeId))');
    expect(calendar).toContain("disabled={presentation.status === 'loading'}");
    expect(cookbook).toContain('missing={missingRecipeIds.has(entry.recipeId)}');
    expect(cookbook).toContain("disabled={presentation.status === 'loading'}");
  });
});

describe('recipe availability behavior', () => {
  it('marks a missing fetch unavailable without changing historical references', () => {
    const references = [{ id: 'meal-1', recipeId: 'missing-recipe' }];

    const result = reconcileRecipeAvailability(
      ['missing-recipe'],
      [null],
      {},
      new Set<string>(),
    );

    expect(result.recipes).toEqual({});
    expect([...result.missingRecipeIds]).toEqual(['missing-recipe']);
    expect(references).toEqual([{ id: 'meal-1', recipeId: 'missing-recipe' }]);
  });

  it('records an available fetch and clears an earlier unavailable state', () => {
    const recipe = { title: 'Tomato pasta' };

    const result = reconcileRecipeAvailability(
      ['recipe-1'],
      [recipe],
      {},
      new Set(['recipe-1']),
    );

    expect(result.recipes).toEqual({ 'recipe-1': recipe });
    expect(result.missingRecipeIds.size).toBe(0);
  });

  it('returns stable and distinct loading, unavailable, and available presentations', () => {
    expect(getRecipePresentation(undefined, false)).toEqual({
      status: 'loading',
      title: 'Loading…',
      disabled: true,
    });
    expect(getRecipePresentation(undefined, true)).toEqual({
      status: 'unavailable',
      title: 'Recipe unavailable',
      disabled: true,
    });
    expect(getRecipePresentation({ title: 'Tomato pasta' }, true)).toEqual({
      status: 'available',
      title: 'Tomato pasta',
      disabled: false,
    });
  });
});
