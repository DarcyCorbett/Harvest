import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  aiClient,
  createAiClient,
  type AiEndpoint,
  type AiInvoke,
} from '../services/aiClient';
import { getGeminiReminderFlags, tagRecipesWithGemini } from '../services/gemini';
import {
  getGeminiGroupings,
  type RawIngredient,
} from '../services/shoppingList';
import { getIngredientSubstitutions } from '../services/substitutions';
import type { Recipe } from '../services/types';

const recipeInput = {
  recipeId: 'recipe-1',
  title: 'Tomato pasta',
  totalMinutes: 30,
  ingredients: ['tomato'],
  steps: ['Cook pasta'],
  existingTags: ['Dinner'],
};

function makeRecipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    title: 'Tomato pasta',
    sourceUrl: 'https://example.test/recipe',
    prepTime: '10 min',
    cookTime: '20 min',
    totalTime: '30 min',
    originalServings: 4,
    ingredients: [{ name: 'tomato', quantity: 2, unit: 'items' }],
    instructions: [{ text: 'Cook pasta' }],
    notes: '',
    nutrition: { calories: 100, protein: 5, carbs: 20, fat: 1 },
    scrapedAt: new Date(0),
    ...overrides,
  };
}

function makeRaw(id: number, overrides: Partial<RawIngredient> = {}): RawIngredient {
  return {
    id,
    name: `ingredient-${id}`,
    quantity: 1,
    unit: 'item',
    source: { id: `recipe-${id}`, title: `Recipe ${id}`, servings: 4 },
    ...overrides,
  };
}

describe('createAiClient', () => {
  it('exposes only the four fixed AI methods and invokes their fixed endpoint names', async () => {
    const invoke = vi.fn<AiInvoke>(async (endpoint) => {
      if (endpoint === 'tagRecipes') {
        return { results: [{ id: 'recipe-1', tags: ['Dinner'] }] };
      }
      if (endpoint === 'reminderFlags') {
        return {
          results: [{ id: 'recipe-1', needsDefrost: false, needsMarinate: true }],
        };
      }
      if (endpoint === 'shoppingGroups') {
        return [{ canonicalName: 'tomato', category: 'Produce', sourceIds: [1], unit: 'items' }];
      }
      return {
        substitutions: [
          { name: 'Passata', adjustment: '1:1', reason: 'Similar tomato flavour.' },
          { name: 'Red pepper', adjustment: '1:1', reason: 'Similar sweetness.' },
          { name: 'Pumpkin', adjustment: '1:1', reason: 'Similar body.' },
        ],
      };
    });
    const client = createAiClient(invoke);

    expect(Object.keys(client).sort()).toEqual([
      'reminderFlags',
      'shoppingGroups',
      'substitutions',
      'tagRecipes',
    ]);

    await client.tagRecipes(' household-a ', [recipeInput]);
    await client.reminderFlags(' household-a ', [
      {
        recipeId: recipeInput.recipeId,
        title: recipeInput.title,
        ingredients: recipeInput.ingredients,
        steps: recipeInput.steps,
      },
    ]);
    await client.shoppingGroups(' household-a ', [
      { id: 1, name: 'tomato', quantity: 2, unit: 'items' },
    ]);
    await client.substitutions(' household-a ', {
      ingredientName: 'tomato',
      ingredientUnit: 'items',
      recipeTitle: 'Tomato pasta',
      allIngredients: ['tomato'],
    });

    expect(invoke.mock.calls.map(([endpoint]) => endpoint)).toEqual([
      'tagRecipes',
      'reminderFlags',
      'shoppingGroups',
      'substitutions',
    ]);
    for (const [, payload] of invoke.mock.calls) {
      expect(payload).toMatchObject({ householdId: 'household-a' });
    }
    expect(invoke.mock.calls[0][1]).toMatchObject({ recipes: [recipeInput] });
    expect(invoke.mock.calls[2][1]).toMatchObject({
      ingredients: [{ id: 1, name: 'tomato', quantity: 2, unit: 'items' }],
    });
    expect(invoke.mock.calls[3][1]).toMatchObject({ ingredientName: 'tomato' });
  });

  it.each([
    ['tagRecipes', (client: ReturnType<typeof createAiClient>) => client.tagRecipes('   ', [recipeInput])],
    ['reminderFlags', (client: ReturnType<typeof createAiClient>) => client.reminderFlags('', [])],
    ['shoppingGroups', (client: ReturnType<typeof createAiClient>) => client.shoppingGroups('\t', [])],
    [
      'substitutions',
      (client: ReturnType<typeof createAiClient>) =>
        client.substitutions('  ', {
          ingredientName: 'tomato',
          ingredientUnit: '',
          recipeTitle: 'Pasta',
          allIngredients: ['tomato'],
        }),
    ],
  ])('rejects a blank household before invoking %s', async (_name, call) => {
    const invoke = vi.fn();
    await expect(call(createAiClient(invoke))).rejects.toThrow('Household is required');
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each([
    ['tagRecipes', (client: ReturnType<typeof createAiClient>) => client.tagRecipes('h', [recipeInput])],
    ['reminderFlags', (client: ReturnType<typeof createAiClient>) => client.reminderFlags('h', [])],
    ['shoppingGroups', (client: ReturnType<typeof createAiClient>) => client.shoppingGroups('h', [])],
    [
      'substitutions',
      (client: ReturnType<typeof createAiClient>) =>
        client.substitutions('h', {
          ingredientName: 'tomato',
          ingredientUnit: '',
          recipeTitle: 'Pasta',
          allIngredients: ['tomato'],
        }),
    ],
  ])('rejects malformed %s responses with a stable local error', async (endpoint, call) => {
    const client = createAiClient(vi.fn().mockResolvedValue({ wrong: true }));
    await expect(call(client)).rejects.toThrow(`Invalid response from ${endpoint}`);
  });

  it('preserves valid callable response shapes', async () => {
    const responses = {
      tagRecipes: { results: [{ id: 'recipe-1', tags: ['Dinner'] }] },
      reminderFlags: {
        results: [{ id: 'recipe-1', needsDefrost: true, needsMarinate: false }],
      },
      shoppingGroups: [
        { canonicalName: 'tomato', category: 'Produce', sourceIds: [1], unit: 'items' },
      ],
      substitutions: {
        substitutions: [
          { name: 'A', adjustment: '1:1', reason: 'Reason A' },
          { name: 'B', adjustment: '1:1', reason: 'Reason B' },
          { name: 'C', adjustment: '1:1', reason: 'Reason C' },
        ],
      },
    } as const;
    const client = createAiClient(
      vi.fn<AiInvoke>(async (endpoint: AiEndpoint) => responses[endpoint]),
    );

    await expect(client.tagRecipes('h', [recipeInput])).resolves.toEqual(responses.tagRecipes);
    await expect(client.reminderFlags('h', [])).resolves.toEqual(responses.reminderFlags);
    await expect(client.shoppingGroups('h', [])).resolves.toEqual(responses.shoppingGroups);
    await expect(
      client.substitutions('h', {
        ingredientName: 'tomato',
        ingredientUnit: '',
        recipeTitle: 'Pasta',
        allIngredients: ['tomato'],
      }),
    ).resolves.toEqual(responses.substitutions);
  });
});

describe('mobile AI adapters', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('batches tagging at 25, keeps unique canonical IDs, and maps all results', async () => {
    const invoke = vi.spyOn(aiClient, 'tagRecipes').mockImplementation(async (_householdId, recipes) => ({
      results: recipes.map(({ recipeId }) => ({ id: recipeId, tags: ['Dinner'] as const })),
    }));
    const recipes = Array.from({ length: 26 }, (_, index) => ({
      recipeId: ` recipe-${index} `,
      recipe: makeRecipe({ title: `Recipe ${index}` }),
    }));

    const result = await tagRecipesWithGemini(' household-a ', recipes);

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls.map(([, batch]) => batch.length)).toEqual([25, 1]);
    expect(invoke.mock.calls.every(([householdId]) => householdId === 'household-a')).toBe(true);
    expect(result.size).toBe(26);
    expect(result.get('recipe-25')).toEqual(['Dinner']);
  });

  it('rejects duplicate tagging IDs created by normalization before invoking', async () => {
    const invoke = vi.spyOn(aiClient, 'tagRecipes');
    const recipes = [
      { recipeId: 'same', recipe: makeRecipe() },
      { recipeId: ' same ', recipe: makeRecipe() },
    ];

    await expect(tagRecipesWithGemini('household-a', recipes)).rejects.toThrow(
      'Duplicate recipe IDs',
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it('normalizes and caps recipe payloads without blank or invalid values', async () => {
    const invoke = vi.spyOn(aiClient, 'tagRecipes').mockImplementation(async (_householdId, recipes) => ({
      results: recipes.map(({ recipeId }) => ({ id: recipeId, tags: [] })),
    }));
    const recipe = makeRecipe({
      title: `  ${'t'.repeat(220)}  `,
      totalTime: '999999 min',
      ingredients: [
        { name: '   ', quantity: 1, unit: '' },
        ...Array.from({ length: 105 }, () => ({ name: ` ${'i'.repeat(130)} `, quantity: 1, unit: '' })),
      ],
      instructions: [
        { text: '   ' },
        ...Array.from({ length: 45 }, () => ({ text: ` ${'s'.repeat(320)} ` })),
      ],
      tags: [' ', ...Array.from({ length: 35 }, () => ` ${'x'.repeat(220)} `)],
    });

    await tagRecipesWithGemini('household-a', [
      { recipeId: ` ${'r'.repeat(170)} `, recipe },
    ]);

    const payload = invoke.mock.calls[0][1][0];
    expect(payload.recipeId).toHaveLength(160);
    expect(payload.title).toHaveLength(200);
    expect(payload.totalMinutes).toBe(10_080);
    expect(payload.ingredients).toHaveLength(100);
    expect(payload.ingredients.every((value) => value.length > 0 && value.length <= 120)).toBe(true);
    expect(payload.steps).toHaveLength(40);
    expect(payload.steps.every((value) => value.length > 0 && value.length <= 300)).toBe(true);
    expect(payload.existingTags).toHaveLength(30);
    expect(payload.existingTags.every((value) => value.length > 0 && value.length <= 200)).toBe(true);
  });

  it('validates household before empty tagging and rejects blank recipe titles', async () => {
    const invoke = vi.spyOn(aiClient, 'tagRecipes');
    await expect(tagRecipesWithGemini(' ', [])).rejects.toThrow('Household is required');
    await expect(
      tagRecipesWithGemini('household-a', [{ recipeId: 'id', recipe: makeRecipe({ title: ' ' }) }]),
    ).rejects.toThrow('Recipe title is required');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('batches reminder flags at 25 and maps all results', async () => {
    const invoke = vi.spyOn(aiClient, 'reminderFlags').mockImplementation(async (_householdId, recipes) => ({
      results: recipes.map(({ recipeId }) => ({
        id: recipeId,
        needsDefrost: true,
        needsMarinate: false,
      })),
    }));
    const recipes = Array.from({ length: 27 }, (_, index) => ({
      recipeId: `recipe-${index}`,
      recipe: makeRecipe({ title: `Recipe ${index}` }),
    }));

    const result = await getGeminiReminderFlags('household-a', recipes);

    expect(invoke.mock.calls.map(([, batch]) => batch.length)).toEqual([25, 2]);
    expect(result.size).toBe(27);
    expect(result.get('recipe-26')).toEqual({ needsDefrost: true, needsMarinate: false });
  });

  it('rejects duplicate reminder IDs created by normalization before invoking', async () => {
    const invoke = vi.spyOn(aiClient, 'reminderFlags');
    const recipes = [
      { recipeId: 'same', recipe: makeRecipe() },
      { recipeId: ' same ', recipe: makeRecipe() },
    ];

    await expect(getGeminiReminderFlags('household-a', recipes)).rejects.toThrow(
      'Duplicate recipe IDs',
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it('limits shopping AI input to 500 and preserves every uncovered or overflow ID once', async () => {
    const invoke = vi.spyOn(aiClient, 'shoppingGroups').mockImplementation(async (_householdId, ingredients) => [
      {
        canonicalName: ingredients[0].name,
        category: 'Produce',
        sourceIds: [ingredients[0].id],
        unit: ingredients[0].unit,
      },
    ]);
    const raw = Array.from({ length: 502 }, (_, id) => makeRaw(id));

    const groups = await getGeminiGroupings('household-a', raw);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0][1]).toHaveLength(500);
    const outputIds = groups.flatMap(({ sourceIds }) => sourceIds);
    expect(outputIds).toHaveLength(502);
    expect(new Set(outputIds).size).toBe(502);
    expect(outputIds.sort((a, b) => a - b)).toEqual(raw.map(({ id }) => id));
  });

  it('normalizes shopping payloads and falls back locally for rows invalid for AI', async () => {
    const invoke = vi.spyOn(aiClient, 'shoppingGroups').mockResolvedValue([
      { canonicalName: 'Milk', category: 'Dairy & Eggs', sourceIds: [0], unit: 'ml' },
    ]);
    const raw = [
      makeRaw(0, { name: ` ${'m'.repeat(140)} `, quantity: Number.POSITIVE_INFINITY, unit: ` ${'u'.repeat(50)} ` }),
      makeRaw(10_000, { name: '   ', quantity: Number.NaN, unit: ' ' }),
    ];

    const groups = await getGeminiGroupings('household-a', raw);

    expect(invoke.mock.calls[0][1]).toEqual([
      { id: 0, name: 'm'.repeat(120), quantity: 0, unit: 'u'.repeat(40) },
    ]);
    expect(groups.flatMap(({ sourceIds }) => sourceIds).sort((a, b) => a - b)).toEqual([0, 10_000]);
  });

  it('validates household before empty shopping input and skips the callable for valid empty input', async () => {
    const invoke = vi.spyOn(aiClient, 'shoppingGroups');
    await expect(getGeminiGroupings('  ', [])).rejects.toThrow('Household is required');
    await expect(getGeminiGroupings('household-a', [])).resolves.toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('validates household before substitution cache and scopes cache entries by household', async () => {
    const substitutions = [
      { name: 'A', adjustment: '1:1', reason: 'Reason A' },
      { name: 'B', adjustment: '1:1', reason: 'Reason B' },
      { name: 'C', adjustment: '1:1', reason: 'Reason C' },
    ];
    const invoke = vi.spyOn(aiClient, 'substitutions').mockResolvedValue({ substitutions });
    const args: [string, string, string, string[]] = [
      'Cache ingredient',
      'cup',
      'Cache recipe',
      ['Cache ingredient'],
    ];

    await expect(getIngredientSubstitutions(' ', ...args)).rejects.toThrow('Household is required');
    expect(invoke).not.toHaveBeenCalled();

    const first = await getIngredientSubstitutions('household-a', ...args);
    const cached = await getIngredientSubstitutions(' household-a ', ...args);
    const otherHousehold = await getIngredientSubstitutions('household-b', ...args);

    expect(first).toEqual(substitutions);
    expect(cached).toEqual(substitutions);
    expect(otherHousehold).toEqual(substitutions);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls.map(([householdId]) => householdId)).toEqual([
      'household-a',
      'household-b',
    ]);
  });

  it('normalizes substitution payload caps and returns exactly the validated array', async () => {
    const substitutions = [
      { name: 'A', adjustment: '1:1', reason: 'Reason A' },
      { name: 'B', adjustment: '1:1', reason: 'Reason B' },
      { name: 'C', adjustment: '1:1', reason: 'Reason C' },
    ];
    const invoke = vi.spyOn(aiClient, 'substitutions').mockResolvedValue({ substitutions });

    const result = await getIngredientSubstitutions(
      'household-a',
      ` ${'i'.repeat(140)} `,
      ` ${'u'.repeat(50)} `,
      ` ${'r'.repeat(220)} `,
      [' ', ...Array.from({ length: 105 }, () => ` ${'a'.repeat(140)} `)],
    );

    expect(result).toEqual(substitutions);
    expect(invoke.mock.calls[0][1]).toEqual({
      ingredientName: 'i'.repeat(120),
      ingredientUnit: 'u'.repeat(40),
      recipeTitle: 'r'.repeat(200),
      allIngredients: Array.from({ length: 100 }, () => 'a'.repeat(120)),
    });
  });
});

describe('mobile source isolation', () => {
  it('contains no paid-provider client config, host, query-key transport, or direct call helper', () => {
    const root = process.cwd();
    const files: string[] = [path.join(root, 'eas.json')];
    const collect = (directory: string) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) collect(entryPath);
        else if (/\.(?:ts|tsx|js|jsx|json)$/.test(entry.name)) files.push(entryPath);
      }
    };
    for (const directory of ['app', 'components', 'config', 'contexts', 'services']) {
      collect(path.join(root, directory));
    }

    const forbidden =
      /EXPO_PUBLIC_(?:GEMINI|DEEPSEEK)|generativelanguage\.googleapis\.com|api\.deepseek\.com|\?key=|callGemini/g;
    const matches = files.flatMap((file) => {
      const content = fs.readFileSync(file, 'utf8');
      return Array.from(content.matchAll(forbidden), (match) =>
        `${path.relative(root, file)}:${match[0]}`,
      );
    });

    expect(matches).toEqual([]);
  });
});
