import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
import {
  getIngredientSubstitutions,
  type SubstitutionResult,
} from '../services/substitutions';
import type { Recipe } from '../services/types';

const recipeInput = {
  recipeId: 'recipe-1',
  title: 'Tomato pasta',
  totalMinutes: 30,
  ingredients: ['tomato'],
  steps: ['Cook pasta'],
  existingTags: ['Dinner'],
};
const reminderInput = {
  recipeId: recipeInput.recipeId,
  title: recipeInput.title,
  ingredients: recipeInput.ingredients,
  steps: recipeInput.steps,
};
const shoppingInput = { id: 1, name: 'tomato', quantity: 2, unit: 'items' };

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

const validTagItem = { id: 'recipe-1', tags: ['Dinner'] } as const;
const validReminderItem = {
  id: 'recipe-1',
  needsDefrost: true,
  needsMarinate: false,
} as const;
const validShoppingGroup = {
  canonicalName: 'tomato',
  category: 'Produce',
  sourceIds: [1],
  unit: 'items',
} as const;
const validSubstitutions = [
  { name: 'A', adjustment: '1:1', reason: 'Reason A' },
  { name: 'B', adjustment: '1:1', reason: 'Reason B' },
  { name: 'C', adjustment: '1:1', reason: 'Reason C' },
] as const;

const freshSubstitutions = (): SubstitutionResult[] =>
  validSubstitutions.map((substitution) => ({ ...substitution }));

const validCallableResponses = {
  tagRecipes: { results: [validTagItem] },
  reminderFlags: { results: [validReminderItem] },
  shoppingGroups: [validShoppingGroup],
  substitutions: { substitutions: validSubstitutions },
} as const;

const repeated = <T>(count: number, value: T): T[] =>
  Array.from({ length: count }, () => value);
const shoppingGroup = (overrides: Record<string, unknown>) => ({
  ...validShoppingGroup,
  ...overrides,
});
const substitutionsWithFirst = (first: Record<string, unknown>) => ({
  substitutions: [first, ...validSubstitutions.slice(1)],
});

type StrictResponseCase = {
  endpoint: AiEndpoint;
  call: (client: ReturnType<typeof createAiClient>) => Promise<unknown>;
  invalid: Array<[label: string, response: unknown]>;
};

type ExactCoverageCase = {
  endpoint: Exclude<AiEndpoint, 'substitutions'>;
  call: (client: ReturnType<typeof createAiClient>) => Promise<unknown>;
  invalid: Array<[label: string, response: unknown]>;
};

const exactCoverageCases: ExactCoverageCase[] = [
  {
    endpoint: 'tagRecipes',
    call: (client) =>
      client.tagRecipes('h', [recipeInput, { ...recipeInput, recipeId: 'recipe-2' }]),
    invalid: [
      ['missing id', { results: [validTagItem] }],
      ['extra id', { results: [validTagItem, { ...validTagItem, id: 'recipe-2' }, { ...validTagItem, id: 'recipe-3' }] }],
      ['duplicate id', { results: [validTagItem, validTagItem] }],
    ],
  },
  {
    endpoint: 'tagRecipes',
    call: (client) =>
      client.tagRecipes('h', [
        { ...recipeInput, recipeId: 'a,b' },
        { ...recipeInput, recipeId: 'c' },
      ]),
    invalid: [
      [
        'join-collision ids',
        { results: [{ ...validTagItem, id: 'a' }, { ...validTagItem, id: 'b,c' }] },
      ],
    ],
  },
  {
    endpoint: 'reminderFlags',
    call: (client) =>
      client.reminderFlags('h', [reminderInput, { ...reminderInput, recipeId: 'recipe-2' }]),
    invalid: [
      ['missing id', { results: [validReminderItem] }],
      ['extra id', { results: [validReminderItem, { ...validReminderItem, id: 'recipe-2' }, { ...validReminderItem, id: 'recipe-3' }] }],
      ['duplicate id', { results: [validReminderItem, validReminderItem] }],
    ],
  },
  {
    endpoint: 'shoppingGroups',
    call: (client) =>
      client.shoppingGroups('h', [shoppingInput, { ...shoppingInput, id: 2 }]),
    invalid: [
      [
        'same source id in two groups',
        [validShoppingGroup, { ...validShoppingGroup, canonicalName: 'tomatoes', sourceIds: [1] }],
      ],
      ['missing id', [validShoppingGroup]],
      ['extra id', [shoppingGroup({ sourceIds: [1, 2, 3] })]],
    ],
  },
];

type InvalidRequestCase = {
  endpoint: Exclude<AiEndpoint, 'substitutions'>;
  label: string;
  call: (client: ReturnType<typeof createAiClient>) => Promise<unknown>;
};

const invalidRequestCases: InvalidRequestCase[] = [
  {
    endpoint: 'tagRecipes',
    label: 'duplicate recipe ids',
    call: (client) => client.tagRecipes('h', [recipeInput, recipeInput]),
  },
  {
    endpoint: 'tagRecipes',
    label: 'malformed recipe id',
    call: (client) => client.tagRecipes('h', [{ ...recipeInput, recipeId: ' recipe-1 ' }]),
  },
  {
    endpoint: 'reminderFlags',
    label: 'duplicate recipe ids',
    call: (client) => client.reminderFlags('h', [reminderInput, reminderInput]),
  },
  {
    endpoint: 'reminderFlags',
    label: 'malformed recipe id',
    call: (client) => client.reminderFlags('h', [{ ...reminderInput, recipeId: '' }]),
  },
  {
    endpoint: 'shoppingGroups',
    label: 'duplicate ingredient ids',
    call: (client) => client.shoppingGroups('h', [shoppingInput, shoppingInput]),
  },
  {
    endpoint: 'shoppingGroups',
    label: 'malformed ingredient id',
    call: (client) => client.shoppingGroups('h', [{ ...shoppingInput, id: 1.5 }]),
  },
];

const strictResponseCases: StrictResponseCase[] = [
  {
    endpoint: 'tagRecipes',
    call: (client) => client.tagRecipes('h', [recipeInput]),
    invalid: [
      ['null top level', null],
      ['array top level', []],
      ['unknown top-level field', { results: [], extra: true }],
      ['null nested item', { results: [null] }],
      ['unknown nested field', { results: [{ ...validTagItem, extra: true }] }],
      ['invalid tag enum', { results: [{ ...validTagItem, tags: ['Other'] }] }],
      ['too many results', { results: repeated(26, validTagItem) }],
      ['empty id', { results: [{ ...validTagItem, id: '' }] }],
      ['untrimmed id', { results: [{ ...validTagItem, id: ' recipe-1 ' }] }],
      ['oversized id', { results: [{ ...validTagItem, id: 'r'.repeat(161) }] }],
      ['too many tags', { results: [{ ...validTagItem, tags: repeated(15, 'Dinner') }] }],
    ],
  },
  {
    endpoint: 'reminderFlags',
    call: (client) => client.reminderFlags('h', []),
    invalid: [
      ['null top level', null],
      ['array top level', []],
      ['unknown top-level field', { results: [], extra: true }],
      ['null nested item', { results: [null] }],
      ['unknown nested field', { results: [{ ...validReminderItem, extra: true }] }],
      ['too many results', { results: repeated(26, validReminderItem) }],
      ['empty id', { results: [{ ...validReminderItem, id: '' }] }],
      ['oversized id', { results: [{ ...validReminderItem, id: 'r'.repeat(161) }] }],
      ['non-boolean flag', { results: [{ ...validReminderItem, needsDefrost: 1 }] }],
    ],
  },
  {
    endpoint: 'shoppingGroups',
    call: (client) => client.shoppingGroups('h', []),
    invalid: [
      ['null top level', null],
      ['object top level', { groups: [] }],
      ['null nested item', [null]],
      ['unknown nested field', [shoppingGroup({ extra: true })]],
      ['invalid category enum', [shoppingGroup({ category: 'Drinks' })]],
      ['too many groups', repeated(501, validShoppingGroup)],
      ['blank canonical name', [shoppingGroup({ canonicalName: ' ' })]],
      ['untrimmed canonical name', [shoppingGroup({ canonicalName: ' tomato ' })]],
      ['oversized canonical name', [shoppingGroup({ canonicalName: 't'.repeat(121) })]],
      ['empty source ids', [shoppingGroup({ sourceIds: [] })]],
      ['too many source ids', [shoppingGroup({ sourceIds: Array.from({ length: 501 }, (_, id) => id) })]],
      ['duplicate source ids', [shoppingGroup({ sourceIds: [1, 1] })]],
      ['negative source id', [shoppingGroup({ sourceIds: [-1] })]],
      ['oversized source id', [shoppingGroup({ sourceIds: [10_000] })]],
      ['fractional source id', [shoppingGroup({ sourceIds: [1.5] })]],
      ['untrimmed unit', [shoppingGroup({ unit: ' items ' })]],
      ['oversized unit', [shoppingGroup({ unit: 'u'.repeat(41) })]],
    ],
  },
  {
    endpoint: 'substitutions',
    call: (client) =>
      client.substitutions('h', {
        ingredientName: 'tomato',
        ingredientUnit: '',
        recipeTitle: 'Pasta',
        allIngredients: ['tomato'],
      }),
    invalid: [
      ['null top level', null],
      ['array top level', []],
      ['unknown top-level field', { substitutions: validSubstitutions, extra: true }],
      ['null nested item', { substitutions: [null, ...validSubstitutions.slice(1)] }],
      [
        'unknown nested field',
        substitutionsWithFirst({ ...validSubstitutions[0], extra: true }),
      ],
      [
        'extra substitution',
        {
          substitutions: [
            ...validSubstitutions,
            { name: 'D', adjustment: '1:1', reason: 'Reason D' },
          ],
        },
      ],
      ['blank name', substitutionsWithFirst({ ...validSubstitutions[0], name: ' ' })],
      [
        'oversized name',
        substitutionsWithFirst({ ...validSubstitutions[0], name: 'n'.repeat(121) }),
      ],
      [
        'blank adjustment',
        substitutionsWithFirst({ ...validSubstitutions[0], adjustment: ' ' }),
      ],
      [
        'untrimmed adjustment',
        substitutionsWithFirst({ ...validSubstitutions[0], adjustment: ' 1:1 ' }),
      ],
      [
        'oversized reason',
        substitutionsWithFirst({ ...validSubstitutions[0], reason: 'r'.repeat(301) }),
      ],
    ],
  },
];


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

  it.each(strictResponseCases)(
    'rejects strict $endpoint response contract violations',
    async ({ endpoint, call, invalid }) => {
      for (const [label, response] of invalid) {
        const client = createAiClient(vi.fn().mockResolvedValue(response));
        await expect(call(client), label).rejects.toThrow(`Invalid response from ${endpoint}`);
      }
    },
  );

  it.each(exactCoverageCases)(
    'rejects $endpoint responses without exact requested-id coverage',
    async ({ endpoint, call, invalid }) => {
      for (const [label, response] of invalid) {
        const client = createAiClient(vi.fn().mockResolvedValue(response));
        await expect(call(client), label).rejects.toThrow(`Invalid response from ${endpoint}`);
      }
    },
  );

  it.each(invalidRequestCases)(
    'rejects $label before invoking $endpoint',
    async ({ endpoint, call }) => {
      const invoke = vi.fn().mockResolvedValue(validCallableResponses[endpoint]);
      await expect(call(createAiClient(invoke))).rejects.toThrow(`Invalid request for ${endpoint}`);
      expect(invoke).not.toHaveBeenCalled();
    },
  );

  it('preserves valid callable response shapes', async () => {
    const client = createAiClient(
      vi.fn<AiInvoke>(async (endpoint: AiEndpoint) => validCallableResponses[endpoint]),
    );

    await expect(client.tagRecipes('h', [recipeInput])).resolves.toEqual(validCallableResponses.tagRecipes);
    await expect(client.reminderFlags('h', [reminderInput])).resolves.toEqual(validCallableResponses.reminderFlags);
    await expect(client.shoppingGroups('h', [shoppingInput])).resolves.toEqual(validCallableResponses.shoppingGroups);
    await expect(
      client.substitutions('h', {
        ingredientName: 'tomato',
        ingredientUnit: '',
        recipeTitle: 'Pasta',
        allIngredients: ['tomato'],
      }),
    ).resolves.toEqual(validCallableResponses.substitutions);
  });
});
describe('mobile AI adapters', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
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

  it('parses scraper and numeric durations across tagging batches', async () => {
    const invoke = vi.spyOn(aiClient, 'tagRecipes').mockImplementation(async (_householdId, recipes) => ({
      results: recipes.map(({ recipeId }) => ({ id: recipeId, tags: [] })),
    }));
    const totalTimes = [
      '1 hr',
      '1 hr 30 min',
      '90',
      'N/A',
      'invalid',
      '0',
      '-5',
      '0.5',
      '999999 min',
      ...Array.from({ length: 16 }, () => '30 min'),
      '1 hr 30 min',
    ];

    await tagRecipesWithGemini(
      'household-a',
      totalTimes.map((totalTime, index) => ({
        recipeId: `duration-${index}`,
        recipe: makeRecipe({ title: `Duration ${index}`, totalTime }),
      })),
    );

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[0][1].slice(0, 9).map(({ totalMinutes }) => totalMinutes)).toEqual([
      60,
      90,
      90,
      null,
      null,
      null,
      null,
      null,
      10_080,
    ]);
    expect(invoke.mock.calls[1][1][0].totalMinutes).toBe(90);
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
    expect(
      invoke.mock.calls.flatMap(([, batch]) => batch).every((input) => !('totalMinutes' in input)),
    ).toBe(true);
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

  it('validates household before cache hits and scopes substitutions by every normalized input', async () => {
    const substitutions = freshSubstitutions();
    const invoke = vi.spyOn(aiClient, 'substitutions').mockResolvedValue({ substitutions });
    const args: [string, string, string, string[]] = [
      'Scope ingredient',
      'cup',
      'Scope recipe',
      ['Scope ingredient', 'Salt'],
    ];

    const first = await getIngredientSubstitutions('household-a', ...args);
    await expect(getIngredientSubstitutions(' ', ...args)).rejects.toThrow('Household is required');
    const cached = await getIngredientSubstitutions(' household-a ',
      ' scope ingredient ', ' CUP ', ' scope recipe ', [' scope ingredient ', ' salt ']);
    await getIngredientSubstitutions('household-b', ...args);
    await getIngredientSubstitutions('household-a', 'Other ingredient', args[1], args[2], args[3]);
    await getIngredientSubstitutions('household-a', args[0], 'tbsp', args[2], args[3]);
    await getIngredientSubstitutions('household-a', args[0], args[1], 'Other recipe', args[3]);
    await getIngredientSubstitutions('household-a', args[0], args[1], args[2], [
      'Scope ingredient',
      'Pepper',
    ]);

    expect(first).toEqual(substitutions);
    expect(cached).toEqual(substitutions);
    expect(invoke).toHaveBeenCalledTimes(6);
  });

  it('returns owned substitution snapshots that callers and responses cannot poison', async () => {
    const substitutions = freshSubstitutions();
    const original = substitutions.map((substitution) => ({ ...substitution }));
    const invoke = vi.spyOn(aiClient, 'substitutions').mockResolvedValue({ substitutions });
    const args: [string, string, string, string[]] = [
      'Owned ingredient',
      'cup',
      'Owned recipe',
      ['Owned ingredient'],
    ];

    const first = await getIngredientSubstitutions('household-a', ...args);
    first[0].name = 'Caller mutation';
    first.pop();
    substitutions[0].reason = 'Response mutation';
    substitutions.pop();

    const second = await getIngredientSubstitutions('household-a', ...args);

    expect(second).toEqual(original);
    expect(second).not.toBe(first);
    expect(second[0]).not.toBe(first[0]);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failed substitution callable', async () => {
    const substitutions = freshSubstitutions();
    const invoke = vi.spyOn(aiClient, 'substitutions')
      .mockRejectedValueOnce(new Error('Provider unavailable'))
      .mockResolvedValueOnce({ substitutions });
    const args: [string, string, string, string[]] = [
      'Retry ingredient',
      'cup',
      'Retry recipe',
      ['Retry ingredient'],
    ];

    await expect(getIngredientSubstitutions('household-a', ...args)).rejects.toThrow(
      'Provider unavailable',
    );
    await expect(getIngredientSubstitutions('household-a', ...args)).resolves.toEqual(substitutions);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('reuses substitutions within 30 minutes and refreshes an expired entry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-14T00:00:00Z'));
    const substitutions = freshSubstitutions();
    const invoke = vi.spyOn(aiClient, 'substitutions').mockResolvedValue({ substitutions });
    const args: [string, string, string, string[]] = [
      'TTL ingredient',
      'cup',
      'TTL recipe',
      ['TTL ingredient'],
    ];

    await getIngredientSubstitutions('household-a', ...args);
    vi.advanceTimersByTime(30 * 60 * 1000 - 1);
    await getIngredientSubstitutions('household-a', ...args);
    expect(invoke).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2);
    await getIngredientSubstitutions('household-a', ...args);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('evicts the least-recently-used substitution while retaining a touched entry', async () => {
    const substitutions = freshSubstitutions();
    const invoke = vi.spyOn(aiClient, 'substitutions').mockResolvedValue({ substitutions });
    const call = (index: number) => getIngredientSubstitutions(
      'household-lru',
      `LRU ingredient ${index}`,
      'cup',
      'LRU recipe',
      [`LRU ingredient ${index}`],
    );

    for (let index = 0; index < 100; index += 1) await call(index);
    await call(0);
    await call(100);
    await call(1);
    await call(0);

    expect(invoke).toHaveBeenCalledTimes(102);
    expect(invoke.mock.calls[invoke.mock.calls.length - 1][1].ingredientName).toBe(
      'LRU ingredient 1',
    );
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
