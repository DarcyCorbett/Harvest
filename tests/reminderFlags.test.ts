import { expect, it, vi } from 'vitest';
import { ensureReminderFlags } from '../services/reminderFlags';
import type { Recipe } from '../services/types';

it('classifies missing connected-plan flags and keeps cached false values', async () => {
  const uncached = { title: 'Marinated chicken', schemaVersion: 2 } as Recipe;
  const cached = { needsDefrost: false, needsMarinate: false } as Recipe;
  const recipes = new Map([['new', uncached], ['cached', cached]]);
  const flags = { needsDefrost: true, needsMarinate: true };
  const classify = vi.fn().mockResolvedValue(new Map([['new', flags]]));
  const persist = vi.fn().mockResolvedValue(undefined);
  await ensureReminderFlags(recipes, classify, persist);
  expect(classify).toHaveBeenCalledWith([{ recipeId: 'new', recipe: uncached }]);
  expect(persist).toHaveBeenCalledWith('new', flags);
  expect(uncached).toMatchObject(flags);
  await ensureReminderFlags(recipes, classify, persist);
  expect(classify).toHaveBeenCalledTimes(1);
});

it('does not mark failed detection as false or suppress a retry', async () => {
  const recipes = new Map([['new', {} as Recipe]]);
  const persist = vi.fn();
  await expect(ensureReminderFlags(recipes, async () => { throw new Error('Unavailable'); }, persist)).rejects.toThrow('Unavailable');
  expect(recipes.get('new')?.needsDefrost).toBeUndefined();
  expect(persist).not.toHaveBeenCalled();
  await expect(ensureReminderFlags(recipes, async () => new Map(), persist)).rejects.toThrow('Missing reminder flags');
});

it('reclassifies partially populated flags and propagates persistence failures', async () => {
  const recipe = { needsDefrost: false } as Recipe;
  const classify = vi.fn().mockResolvedValue(new Map([['partial', { needsDefrost: false, needsMarinate: true }]]));
  await expect(ensureReminderFlags(new Map([['partial', recipe]]), classify, async () => { throw new Error('Offline'); })).rejects.toThrow('Offline');
  expect(classify).toHaveBeenCalledTimes(1);
  expect(recipe.needsMarinate).toBeUndefined();
});
