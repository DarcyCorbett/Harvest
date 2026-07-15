import { describe, expect, it, vi } from 'vitest';

import { createLegacyRecipeHandlers } from '../src/callables/legacyRecipes.js';

const recipe = {
  title: 'Soup',
  sourceUrl: 'https://www.recipetineats.com/soup/',
  prepTime: '10 min',
  cookTime: '20 min',
  totalTime: '30 min',
  originalServings: 4,
  ingredients: [{ name: 'onion', quantity: 1, unit: '' }],
  instructions: [{ text: 'Cook.' }],
  notes: '',
  nutrition: { calories: 100, protein: 2, carbs: 20, fat: 1 },
};

function createDependencies() {
  return {
    authorize: vi.fn(async () => ({ uid: 'u1', email: 'user@example.com' })),
    reserve: vi.fn(async () => 1),
    create: vi.fn(async () => 'server-id'),
    update: vi.fn(async () => undefined),
  };
}

describe('legacy recipe bridge', () => {
  it('authorizes, quotas, and creates with a server ID', async () => {
    const dependencies = createDependencies();
    const handlers = createLegacyRecipeHandlers(dependencies);

    await expect(handlers.save({
      auth: { uid: 'u1', token: {} },
      data: { householdId: 'h1', recipe },
    } as never)).resolves.toEqual({ recipeId: 'server-id' });

    expect(dependencies.authorize).toHaveBeenCalledWith(
      { uid: 'u1', token: {} },
      'h1',
    );
    expect(dependencies.reserve).toHaveBeenCalledWith(
      'u1',
      'legacyRecipeCreate',
      1,
    );
    expect(dependencies.create).toHaveBeenCalledWith(recipe);
  });

  it.each([
    'https://attacker.example/recipe',
    'https://www.recipetineats.com.attacker.example/recipe',
    'http://www.recipetineats.com/recipe',
  ])('rejects an untrusted source URL before authorization or writing: %s', async (sourceUrl) => {
    const dependencies = createDependencies();
    const handlers = createLegacyRecipeHandlers(dependencies);

    await expect(handlers.save({
      auth: { uid: 'u1', token: {} },
      data: { householdId: 'h1', recipe: { ...recipe, sourceUrl } },
    } as never)).rejects.toMatchObject({ code: 'invalid-argument' });

    expect(dependencies.authorize).not.toHaveBeenCalled();
    expect(dependencies.reserve).not.toHaveBeenCalled();
    expect(dependencies.create).not.toHaveBeenCalled();
  });

  it('rejects caller-selected IDs, membership fields, and arbitrary fields', async () => {
    const dependencies = createDependencies();
    const handlers = createLegacyRecipeHandlers(dependencies);

    await expect(handlers.save({
      auth: { uid: 'u1', token: {} },
      data: {
        householdId: 'h1',
        recipe: {
          ...recipe,
          id: 'caller-id',
          householdId: 'other-household',
          arbitrary: true,
        },
      },
    } as never)).rejects.toMatchObject({ code: 'invalid-argument' });

    expect(dependencies.create).not.toHaveBeenCalled();
  });

  it('updates only schema-approved metadata fields', async () => {
    const dependencies = createDependencies();
    const handlers = createLegacyRecipeHandlers(dependencies);

    await expect(handlers.update({
      auth: { uid: 'u1', token: {} },
      data: {
        householdId: 'h1',
        recipeId: 'r1',
        tags: ['Dinner'],
        needsDefrost: true,
      },
    } as never)).resolves.toEqual({ recipeId: 'r1' });

    expect(dependencies.reserve).toHaveBeenCalledWith(
      'u1',
      'legacyRecipeMetadata',
      1,
    );
    expect(dependencies.update).toHaveBeenCalledWith('r1', {
      tags: ['Dinner'],
      needsDefrost: true,
    });
  });

  it.each([
    { householdId: 'h1', recipeId: 'r1' },
    { householdId: 'h1', recipeId: 'r1', title: 'Replacement title' },
    { householdId: 'h1', recipeId: 'r1', members: ['u1'] },
    { householdId: 'h1', recipeId: 'r1', tags: ['Unsupported'] },
    { householdId: 'h1', recipeId: 'r1', tags: ['Dinner'], arbitrary: true },
  ])('rejects empty or non-approved metadata without writing: %o', async (data) => {
    const dependencies = createDependencies();
    const handlers = createLegacyRecipeHandlers(dependencies);

    await expect(handlers.update({
      auth: { uid: 'u1', token: {} },
      data,
    } as never)).rejects.toMatchObject({ code: 'invalid-argument' });

    expect(dependencies.authorize).not.toHaveBeenCalled();
    expect(dependencies.reserve).not.toHaveBeenCalled();
    expect(dependencies.update).not.toHaveBeenCalled();
  });
});
