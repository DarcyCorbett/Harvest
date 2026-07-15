import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import {
  applyRecipeFetchResults,
  beginRecipeLoads,
  createRecipeHistoryState,
  executeOwnedHistoryAction,
  getRecipePresentation,
  isCurrentHistorySession,
  pruneRecipeHistory,
  recipeIdsToLoad,
  retryRecipeLoad,
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
    expect(calendar).toContain('onPress={() => handleDelete(entry)}');
    expect(calendar).toContain('deleteMealPlanEntry(ownerHouseholdId, entry.id!)');
    expect(cookbook).toContain('removeFromCookbook(ownerHouseholdId, entry.recipeId)');
    expect(cookbook).toContain('onRemove={() => handleRemove(entry)}');
  });

  it('wires owned settled loading into both history screens', () => {
    const calendar = read('app/(tabs)/index.tsx');
    const cookbook = read('app/(tabs)/cookbook.tsx');

    for (const screen of [calendar, cookbook]) {
      expect(screen).toContain('createRecipeHistoryState');
      expect(screen).toContain('Promise.allSettled');
      expect(screen).toContain('isCurrentHistorySession');
      expect(screen).toContain('executeOwnedHistoryAction');
      expect(screen).toContain('snapshotRevisionRef');
      expect(screen).toContain('snapshotOwnership');
      expect(screen).toContain('activeLoadTokens');
      expect(screen).toContain('loadTokens: Object.fromEntries');
      expect(screen).toContain('getRecipePresentation');
      expect(screen).not.toContain('reconcileRecipeAvailability');
    }

    expect(calendar).toContain('accessibilityLabel="Remove meal"');
    expect(calendar).not.toContain('const firstRecipe =');
    expect(cookbook).toContain('accessibilityLabel="Remove from cookbook"');
    expect(cookbook).toContain('accessibilityLabel={entry.starred ? \'Remove from favourites\' : \'Add to favourites\'}');
    expect(cookbook.match(/accessibilityRole="button"/g)?.length).toBeGreaterThanOrEqual(2);
    for (const screen of [calendar, cookbook]) {
      expect(
        screen.match(/executeOwnedHistoryAction\(\s*snapshotOwnership,\s*getCurrentOwnership\(\),/g)?.length,
      ).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('recipe history state', () => {
  it('keeps successful reads when another read rejects', () => {
    const initial = beginRecipeLoads(
      createRecipeHistoryState<{ title: string }>('household-a', 4),
      ['recipe-a', 'recipe-b'],
    );
    const request = {
      householdId: 'household-a',
      generation: 4,
      recipeIds: ['recipe-a', 'recipe-b'],
      loadTokens: { 'recipe-a': 1, 'recipe-b': 2 },
    };

    const result = applyRecipeFetchResults(initial, request, [
      { status: 'fulfilled', value: { title: 'Pasta' } },
      { status: 'rejected', reason: new Error('temporary') },
    ]);

    expect(result.recipes).toEqual({ 'recipe-a': { title: 'Pasta' } });
    expect([...result.errorRecipeIds]).toEqual(['recipe-b']);
    expect([...result.missingRecipeIds]).toEqual([]);
    expect([...result.loadedRecipeIds]).toEqual(['recipe-a']);
  });

  it('marks only a confirmed null read unavailable', () => {
    const initial = beginRecipeLoads(
      createRecipeHistoryState<{ title: string }>('household-a', 1),
      ['missing-recipe'],
    );
    const result = applyRecipeFetchResults(
      initial,
      {
        householdId: 'household-a',
        generation: 1,
        recipeIds: ['missing-recipe'],
        loadTokens: { 'missing-recipe': 1 },
      },
      [{ status: 'fulfilled', value: null }],
    );

    expect([...result.missingRecipeIds]).toEqual(['missing-recipe']);
    expect([...result.errorRecipeIds]).toEqual([]);
  });

  it('ignores a late fetch result from an older household generation', () => {
    const current = createRecipeHistoryState<{ title: string }>('household-b', 8);
    const result = applyRecipeFetchResults(
      current,
      {
        householdId: 'household-a',
        generation: 7,
        recipeIds: ['old-recipe'],
        loadTokens: { 'old-recipe': 1 },
      },
      [{ status: 'fulfilled', value: { title: 'Old recipe' } }],
    );

    expect(result).toBe(current);
    expect(result.recipes).toEqual({});
  });

  it('makes a rejected read eligible after an explicit retry', () => {
    const loading = beginRecipeLoads(
      createRecipeHistoryState<{ title: string }>('household-a', 1),
      ['recipe-a'],
    );
    const failed = applyRecipeFetchResults(
      loading,
      {
        householdId: 'household-a',
        generation: 1,
        recipeIds: ['recipe-a'],
        loadTokens: { 'recipe-a': 1 },
      },
      [{ status: 'rejected', reason: new Error('temporary') }],
    );

    expect(recipeIdsToLoad(['recipe-a'], failed)).toEqual([]);
    expect(failed.loadedRecipeIds.has('recipe-a')).toBe(false);
    expect(recipeIdsToLoad(['recipe-a'], retryRecipeLoad(failed, 'recipe-a'))).toEqual(['recipe-a']);
  });

  it('forgets removed IDs so a remove and re-add fetches again', () => {
    const loaded = beginRecipeLoads(
      createRecipeHistoryState<{ title: string }>('household-a', 1),
      ['recipe-a'],
    );
    const pruned = pruneRecipeHistory(loaded, []);

    expect(pruned.loadedRecipeIds.has('recipe-a')).toBe(false);
    expect(recipeIdsToLoad(['recipe-a'], pruned)).toEqual(['recipe-a']);
  });

  it('ignores a fetch completion after its reference was removed', () => {
    const loading = beginRecipeLoads(
      createRecipeHistoryState<{ title: string }>('household-a', 1),
      ['recipe-a'],
    );
    const pruned = pruneRecipeHistory(loading, []);
    const result = applyRecipeFetchResults(
      pruned,
      {
        householdId: 'household-a',
        generation: 1,
        recipeIds: ['recipe-a'],
        loadTokens: { 'recipe-a': 1 },
      },
      [{ status: 'fulfilled', value: { title: 'Late recipe' } }],
    );

    expect(result.recipes).toEqual({});
    expect(result.loadedRecipeIds.has('recipe-a')).toBe(false);
  });

  it('ignores request 1 after remove, re-add, and a successful request 2', () => {
    const initial = createRecipeHistoryState<{ title: string }>('household-a', 1);
    const request1State = beginRecipeLoads(initial, ['recipe-a']);
    const request1 = {
      householdId: 'household-a',
      generation: 1,
      recipeIds: ['recipe-a'],
      loadTokens: { 'recipe-a': 1 },
    };
    const removed = pruneRecipeHistory(request1State, []);
    const request2State = beginRecipeLoads(removed, ['recipe-a']);
    const request2 = {
      householdId: 'household-a',
      generation: 1,
      recipeIds: ['recipe-a'],
      loadTokens: { 'recipe-a': 2 },
    };
    const fresh = applyRecipeFetchResults(
      request2State,
      request2,
      [{ status: 'fulfilled', value: { title: 'Fresh recipe' } }],
    );

    const afterLateData = applyRecipeFetchResults(
      fresh,
      request1,
      [{ status: 'fulfilled', value: { title: 'Stale recipe' } }],
    );
    const afterLateNull = applyRecipeFetchResults(
      afterLateData,
      request1,
      [{ status: 'fulfilled', value: null }],
    );

    expect(afterLateNull.recipes).toEqual({ 'recipe-a': { title: 'Fresh recipe' } });
    expect(afterLateNull.missingRecipeIds.has('recipe-a')).toBe(false);
  });

  it('distinguishes loading, unavailable, transient error, and available states', () => {
    expect(getRecipePresentation(undefined, false, false)).toEqual({
      status: 'loading',
      title: 'Loading…',
    });
    expect(getRecipePresentation(undefined, true, false)).toEqual({
      status: 'unavailable',
      title: 'Recipe unavailable',
    });
    expect(getRecipePresentation(undefined, false, true)).toEqual({
      status: 'error',
      title: 'Could not load recipe — tap to retry',
    });
    expect(getRecipePresentation({ title: 'Tomato pasta' }, true, true)).toEqual({
      status: 'available',
      title: 'Tomato pasta',
    });
  });
});

describe('household history ownership', () => {
  const token = (householdId: string, generation: number, snapshotRevision: number) => ({
    householdId,
    generation,
    snapshotRevision,
  });

  it('rejects an old row action after the current household changes', async () => {
    const action = vi.fn(async () => undefined);
    const onError = vi.fn();

    await expect(
      executeOwnedHistoryAction(
        token('household-a', 2, 5),
        token('household-b', 3, 6),
        action,
        onError,
      ),
    ).resolves.toBe('blocked');
    expect(action).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('reports an owned action failure without leaking a rejection', async () => {
    const failure = new Error('permission denied');
    const onError = vi.fn();

    await expect(
      executeOwnedHistoryAction(
        token('household-a', 2, 5),
        token('household-a', 2, 5),
        async () => { throw failure; },
        onError,
      ),
    ).resolves.toBe('failed');
    expect(onError).toHaveBeenCalledWith(failure);
  });

  it('allows an action only when the complete ownership token still matches', async () => {
    const action = vi.fn(async () => undefined);

    await expect(
      executeOwnedHistoryAction(
        token('household-a', 2, 5),
        token('household-a', 2, 5),
        action,
        vi.fn(),
      ),
    ).resolves.toBe('completed');
    expect(action).toHaveBeenCalledWith('household-a');
  });

  it('blocks an A to B to A confirmation with a stale session generation', async () => {
    const action = vi.fn(async () => undefined);

    await expect(
      executeOwnedHistoryAction(
        token('household-a', 2, 5),
        token('household-a', 4, 7),
        action,
        vi.fn(),
      ),
    ).resolves.toBe('blocked');
    expect(action).not.toHaveBeenCalled();
  });

  it('blocks a confirmation after a newer same-household snapshot replaces the row', async () => {
    const action = vi.fn(async () => undefined);

    await expect(
      executeOwnedHistoryAction(
        token('household-a', 2, 5),
        token('household-a', 2, 6),
        action,
        vi.fn(),
      ),
    ).resolves.toBe('blocked');
    expect(action).not.toHaveBeenCalled();
  });

  it('accepts callbacks only for the active household generation', () => {
    expect(isCurrentHistorySession('household-a', 3, 'household-a', 3)).toBe(true);
    expect(isCurrentHistorySession('household-a', 3, 'household-b', 4)).toBe(false);
    expect(isCurrentHistorySession('household-a', 3, 'household-a', 4)).toBe(false);
  });
});
