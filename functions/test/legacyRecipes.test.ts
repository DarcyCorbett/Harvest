import { describe, expect, it, vi } from 'vitest';

import {
  createLegacyRecipeHandlers,
  createLegacyRecipeStore,
  type LegacyRecipeDocuments,
} from '../src/callables/legacyRecipes.js';

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

const MAX_LEGACY_RECIPE_BYTES = 900 * 1024;

function recipeWithAggregateIngredients(rootCount: number, groupedCount: number) {
  return {
    ...recipe,
    ingredients: Array.from({ length: rootCount }, () => ({
      name: 'x',
      quantity: 1,
      unit: '',
      notes: '',
    })),
    ingredientGroups: groupedCount === 0
      ? []
      : [{
          name: '',
          ingredients: Array.from({ length: groupedCount }, () => ({
            name: 'x',
            quantity: 1,
            unit: '',
            notes: '',
          })),
        }],
  };
}

function recipeAtSerializedBytes(targetBytes: number) {
  const candidate = {
    ...recipeWithAggregateIngredients(200, 200),
    description: '',
    notes: '',
    instructions: Array.from({ length: 150 }, () => ({ text: 'x' })),
  };
  let remaining = targetBytes - Buffer.byteLength(JSON.stringify(candidate), 'utf8');

  const fill = (
    current: string,
    capacity: number,
    assign: (value: string) => void,
  ) => {
    const amount = Math.min(remaining, capacity - current.length);
    if (amount <= 0) return;
    assign(`${current}${'x'.repeat(amount)}`);
    remaining -= amount;
  };

  for (const instruction of candidate.instructions) {
    fill(instruction.text, 5_000, (value) => {
      instruction.text = value;
    });
  }
  fill(candidate.notes, 20_000, (value) => {
    candidate.notes = value;
  });
  fill(candidate.description, 5_000, (value) => {
    candidate.description = value;
  });
  for (const ingredient of candidate.ingredients) {
    fill(ingredient.notes, 300, (value) => {
      ingredient.notes = value;
    });
  }
  for (const ingredient of candidate.ingredientGroups[0].ingredients) {
    fill(ingredient.notes, 300, (value) => {
      ingredient.notes = value;
    });
  }
  for (const ingredient of candidate.ingredients) {
    fill(ingredient.name, 120, (value) => {
      ingredient.name = value;
    });
  }
  for (const ingredient of candidate.ingredientGroups[0].ingredients) {
    fill(ingredient.name, 120, (value) => {
      ingredient.name = value;
    });
  }

  if (remaining !== 0) {
    throw new Error(`Unable to construct ${targetBytes}-byte recipe; ${remaining} bytes remain`);
  }
  expect(Buffer.byteLength(JSON.stringify(candidate), 'utf8')).toBe(targetBytes);
  return candidate;
}

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

  it.each([
    ['imageUrl', 'javascript:alert(1)'],
    ['imageUrl', 'data:image/png;base64,AAAA'],
    ['imageUrl', 'file:///tmp/recipe.png'],
    ['imageUrl', 'http://images.example/recipe.png'],
    ['videoEmbedUrl', 'javascript:alert(1)'],
    ['videoEmbedUrl', 'data:video/mp4;base64,AAAA'],
    ['videoEmbedUrl', 'file:///tmp/recipe.mp4'],
    ['videoEmbedUrl', 'http://videos.example/recipe.mp4'],
  ])('rejects a non-HTTPS root %s before authorization: %s', async (field, value) => {
    const dependencies = createDependencies();
    const handlers = createLegacyRecipeHandlers(dependencies);

    await expect(handlers.save({
      auth: { uid: 'u1', token: {} },
      data: {
        householdId: 'h1',
        recipe: { ...recipe, [field]: value },
      },
    } as never)).rejects.toMatchObject({ code: 'invalid-argument' });

    expect(dependencies.authorize).not.toHaveBeenCalled();
    expect(dependencies.reserve).not.toHaveBeenCalled();
    expect(dependencies.create).not.toHaveBeenCalled();
  });

  it.each([
    ['imageUrl', 'javascript:alert(1)'],
    ['imageUrl', 'data:image/png;base64,AAAA'],
    ['imageUrl', 'file:///tmp/step.png'],
    ['imageUrl', 'http://images.example/step.png'],
    ['videoEmbedUrl', 'javascript:alert(1)'],
    ['videoEmbedUrl', 'data:video/mp4;base64,AAAA'],
    ['videoEmbedUrl', 'file:///tmp/step.mp4'],
    ['videoEmbedUrl', 'http://videos.example/step.mp4'],
  ])('rejects a non-HTTPS instruction %s before authorization: %s', async (field, value) => {
    const dependencies = createDependencies();
    const handlers = createLegacyRecipeHandlers(dependencies);

    await expect(handlers.save({
      auth: { uid: 'u1', token: {} },
      data: {
        householdId: 'h1',
        recipe: {
          ...recipe,
          instructions: [{ text: 'Cook.', [field]: value }],
        },
      },
    } as never)).rejects.toMatchObject({ code: 'invalid-argument' });

    expect(dependencies.authorize).not.toHaveBeenCalled();
    expect(dependencies.reserve).not.toHaveBeenCalled();
    expect(dependencies.create).not.toHaveBeenCalled();
  });

  it('accepts a recipe exactly at the aggregate UTF-8 payload ceiling', async () => {
    const dependencies = createDependencies();
    const handlers = createLegacyRecipeHandlers(dependencies);
    const boundaryRecipe = recipeAtSerializedBytes(MAX_LEGACY_RECIPE_BYTES);

    await expect(handlers.save({
      auth: { uid: 'u1', token: {} },
      data: { householdId: 'h1', recipe: boundaryRecipe },
    } as never)).resolves.toEqual({ recipeId: 'server-id' });
    expect(dependencies.create).toHaveBeenCalledOnce();
  });

  it('rejects a recipe one byte over the aggregate payload ceiling before authorization', async () => {
    const dependencies = createDependencies();
    const handlers = createLegacyRecipeHandlers(dependencies);
    const oversizedRecipe = recipeAtSerializedBytes(MAX_LEGACY_RECIPE_BYTES + 1);

    await expect(handlers.save({
      auth: { uid: 'u1', token: {} },
      data: { householdId: 'h1', recipe: oversizedRecipe },
    } as never)).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(dependencies.authorize).not.toHaveBeenCalled();
    expect(dependencies.reserve).not.toHaveBeenCalled();
    expect(dependencies.create).not.toHaveBeenCalled();
  });

  it('measures aggregate payload size as UTF-8 bytes rather than JavaScript characters', async () => {
    const dependencies = createDependencies();
    const handlers = createLegacyRecipeHandlers(dependencies);
    const oversizedRecipe = {
      ...recipe,
      instructions: Array.from({ length: 100 }, () => ({
        text: 'é'.repeat(5_000),
      })),
    };

    expect(JSON.stringify(oversizedRecipe).length).toBeLessThan(MAX_LEGACY_RECIPE_BYTES);
    expect(Buffer.byteLength(JSON.stringify(oversizedRecipe), 'utf8')).toBeGreaterThan(
      MAX_LEGACY_RECIPE_BYTES,
    );
    await expect(handlers.save({
      auth: { uid: 'u1', token: {} },
      data: { householdId: 'h1', recipe: oversizedRecipe },
    } as never)).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(dependencies.authorize).not.toHaveBeenCalled();
    expect(dependencies.reserve).not.toHaveBeenCalled();
    expect(dependencies.create).not.toHaveBeenCalled();
  });

  it('accepts 400 aggregate ingredients across the flat and grouped representations', async () => {
    const dependencies = createDependencies();
    const handlers = createLegacyRecipeHandlers(dependencies);

    await expect(handlers.save({
      auth: { uid: 'u1', token: {} },
      data: {
        householdId: 'h1',
        recipe: recipeWithAggregateIngredients(200, 200),
      },
    } as never)).resolves.toEqual({ recipeId: 'server-id' });
  });

  it('rejects more than 400 aggregate ingredients before authorization', async () => {
    const dependencies = createDependencies();
    const handlers = createLegacyRecipeHandlers(dependencies);
    const oversizedRecipe = recipeWithAggregateIngredients(200, 200);
    oversizedRecipe.ingredientGroups.push({
      name: 'extra',
      ingredients: [{ name: 'x', quantity: 1, unit: '', notes: '' }],
    });

    await expect(handlers.save({
      auth: { uid: 'u1', token: {} },
      data: { householdId: 'h1', recipe: oversizedRecipe },
    } as never)).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(dependencies.authorize).not.toHaveBeenCalled();
    expect(dependencies.reserve).not.toHaveBeenCalled();
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

describe('legacy recipe persistence', () => {
  function createMemoryDocuments() {
    const recipes = new Map<string, typeof recipe>();
    let writes = 0;
    const documents: LegacyRecipeDocuments = {
      async createIfMissing(recipeId, candidate) {
        await Promise.resolve();
        const existing = recipes.get(recipeId);
        if (existing) return { sourceUrl: existing.sourceUrl };
        recipes.set(recipeId, structuredClone(candidate));
        writes += 1;
        return { sourceUrl: candidate.sourceUrl };
      },
      update: vi.fn(async () => undefined),
    };
    return {
      documents,
      recipes,
      writes: () => writes,
    };
  }

  it('uses one deterministic server ID for normalized source URLs', async () => {
    const firstMemory = createMemoryDocuments();
    const secondMemory = createMemoryDocuments();
    const firstStore = createLegacyRecipeStore(firstMemory.documents);
    const secondStore = createLegacyRecipeStore(secondMemory.documents);

    const firstId = await firstStore.create({
      ...recipe,
      sourceUrl: 'https://WWW.RECIPETINEATS.COM:443/soup#first',
    });
    const secondId = await secondStore.create({
      ...recipe,
      sourceUrl: 'https://www.recipetineats.com/soup#second',
    });

    expect(firstId).toBe(secondId);
    expect(firstId).toMatch(/^legacy_[a-f0-9]{64}$/);
    expect(firstMemory.recipes.get(firstId)?.sourceUrl).toBe(
      'https://www.recipetineats.com/soup',
    );
  });

  it('makes repeated saves idempotent without overwriting the existing recipe', async () => {
    const memory = createMemoryDocuments();
    const store = createLegacyRecipeStore(memory.documents);

    const firstId = await store.create(recipe);
    const secondId = await store.create({ ...recipe, title: 'Replacement title' });

    expect(secondId).toBe(firstId);
    expect(memory.writes()).toBe(1);
    expect(memory.recipes.get(firstId)?.title).toBe('Soup');
  });

  it('makes concurrent saves converge on one ID and one write', async () => {
    const memory = createMemoryDocuments();
    const store = createLegacyRecipeStore(memory.documents);

    const [firstId, secondId] = await Promise.all([
      store.create(recipe),
      store.create({ ...recipe, title: 'Concurrent replacement' }),
    ]);

    expect(secondId).toBe(firstId);
    expect(memory.writes()).toBe(1);
    expect(memory.recipes.size).toBe(1);
    expect(memory.recipes.get(firstId)?.title).toBe('Soup');
  });

  it('fails closed if a deterministic ID resolves to a different source URL', async () => {
    const documents: LegacyRecipeDocuments = {
      createIfMissing: vi.fn(async () => ({
        sourceUrl: 'https://www.recipetineats.com/different',
      })),
      update: vi.fn(async () => undefined),
    };
    const store = createLegacyRecipeStore(documents);

    await expect(store.create(recipe)).rejects.toMatchObject({
      code: 'internal',
      message: 'Recipe storage unavailable.',
    });
  });
});
