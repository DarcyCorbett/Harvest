import { describe, expect, it, vi } from 'vitest';

import {
  buildReminderFlagsPrompt,
  buildShoppingGroupsPrompt,
  buildSubstitutionsPrompt,
  buildTagRecipesPrompt,
} from '../src/ai/prompts.js';
import {
  createAiService,
  type JsonRequester,
} from '../src/ai/service.js';

const tagRecipe = (recipeId = 'recipe-1') => ({
  recipeId,
  title: 'Vegetable rice bowl',
  totalMinutes: 25,
  ingredients: ['Rice', 'Carrots'],
  steps: ['Cook rice', 'Add carrots'],
  existingTags: ['Lunch'],
});

const reminderRecipe = (recipeId = 'recipe-1') => ({
  recipeId,
  title: 'Marinated chicken',
  ingredients: ['Chicken breast', 'Yoghurt'],
  steps: ['Marinate for 2 hours in the fridge', 'Bake'],
});

const rawIngredient = (id = 1) => ({
  id,
  name: 'Carrot',
  quantity: 2,
  unit: '',
});

const substitutionInput = {
  ingredientName: 'Butter',
  ingredientUnit: 'g',
  recipeTitle: 'Chocolate cake',
  allIngredients: ['Flour', 'Butter', 'Chocolate'],
};

const threeSubstitutions = {
  substitutions: [
    {
      name: 'Coconut oil',
      adjustment: 'Use a 1:1 ratio',
      reason: 'It provides a similar fat content.',
    },
    {
      name: 'Neutral oil',
      adjustment: 'Use 80 g per 100 g',
      reason: 'It keeps the cake moist.',
    },
    {
      name: 'Margarine',
      adjustment: 'Use a 1:1 ratio',
      reason: 'It behaves similarly when baked.',
    },
  ],
};

function requester(response: unknown): JsonRequester & {
  requestJson: ReturnType<typeof vi.fn<JsonRequester['requestJson']>>;
} {
  return {
    requestJson: vi.fn<JsonRequester['requestJson']>().mockResolvedValue(response),
  };
}

describe('fixed AI prompts', () => {
  it('serializes the tagging input using provider ids and joined steps', () => {
    const recipes = [tagRecipe('recipe|with|pipes')];

    const prompt = buildTagRecipesPrompt(recipes);

    expect(prompt).toContain('Allowed tags:');
    expect(prompt).toContain('Every input recipe must appear exactly once');
    expect(prompt).toContain(JSON.stringify([{
      id: 'recipe|with|pipes',
      title: 'Vegetable rice bowl',
      totalMinutes: 25,
      ingredients: ['Rice', 'Carrots'],
      steps: 'Cook rice | Add carrots',
      existingTags: ['Lunch'],
    }]));
  });

  it('keeps the controlled reminder rules and appends only serialized recipes', () => {
    const recipes = [reminderRecipe()];

    const prompt = buildReminderFlagsPrompt(recipes);

    expect(prompt).toContain('needsDefrost');
    expect(prompt).toContain('False negatives are better than false positives');
    expect(prompt).toContain(JSON.stringify(recipes));
  });

  it('keeps the controlled shopping taxonomy and appends only serialized ingredients', () => {
    const ingredients = [rawIngredient()];

    const prompt = buildShoppingGroupsPrompt(ingredients);

    expect(prompt).toContain('Meat & Seafood');
    expect(prompt).toContain('Every ingredient id must appear in exactly one group');
    expect(prompt).toContain(JSON.stringify(ingredients));
  });

  it('requires exactly three substitutions and appends only the structured context', () => {
    const prompt = buildSubstitutionsPrompt(substitutionInput);

    expect(prompt).toContain('Suggest exactly 3 suitable ingredient replacements');
    expect(prompt).toContain('"substitutions"');
    expect(prompt).toContain(JSON.stringify(substitutionInput));
  });
});

describe('createAiService', () => {
  it('exposes only the four fixed-purpose methods', () => {
    const service = createAiService(requester({}));

    expect(Object.keys(service).sort()).toEqual([
      'reminderFlags',
      'shoppingGroups',
      'substitutions',
      'tagRecipes',
    ]);
    expect(service).not.toHaveProperty('call');
    expect(service).not.toHaveProperty('proxy');
    expect(service).not.toHaveProperty('request');
  });

  it('returns a schema-validated tagging response', async () => {
    const response = {
      results: [{ id: 'recipe-1', tags: ['Dinner', 'Healthy'] }],
    };
    const provider = requester(response);

    await expect(
      createAiService(provider).tagRecipes([tagRecipe()]),
    ).resolves.toEqual(response);
  });

  it('rejects a tag outside the controlled taxonomy with a bounded error', async () => {
    const provider = requester({
      results: [{ id: 'recipe-1', tags: ['Brunch'] }],
    });

    await expect(
      createAiService(provider).tagRecipes([tagRecipe()]),
    ).rejects.toMatchObject({ message: 'provider-output-invalid' });
  });

  it('returns a schema-validated reminder response', async () => {
    const response = {
      results: [{
        id: 'recipe-1',
        needsDefrost: true,
        needsMarinate: true,
      }],
    };

    await expect(
      createAiService(requester(response)).reminderFlags([reminderRecipe()]),
    ).resolves.toEqual(response);
  });

  it.each([
    {
      results: [{
        id: 'recipe-1',
        needsDefrost: 'yes',
        needsMarinate: false,
      }],
    },
    { results: [{ id: 'recipe-1', needsDefrost: false }] },
  ])('rejects a malformed reminder response with a bounded error', async (response) => {
    await expect(
      createAiService(requester(response)).reminderFlags([reminderRecipe()]),
    ).rejects.toMatchObject({ message: 'provider-output-invalid' });
  });

  it('returns schema-validated shopping groups', async () => {
    const response = [{
      canonicalName: 'Carrots',
      category: 'Produce',
      sourceIds: [1],
      unit: 'carrots',
    }];

    await expect(
      createAiService(requester(response)).shoppingGroups([rawIngredient()]),
    ).resolves.toEqual(response);
  });

  it.each([
    [{ canonicalName: 'Carrots', category: 'Vegetables', sourceIds: [1] }],
    { groups: [] },
  ])('rejects a malformed shopping response with a bounded error', async (response) => {
    await expect(
      createAiService(requester(response)).shoppingGroups([rawIngredient()]),
    ).rejects.toMatchObject({ message: 'provider-output-invalid' });
  });

  it('returns exactly three schema-validated substitutions', async () => {
    await expect(
      createAiService(requester(threeSubstitutions)).substitutions(
        substitutionInput,
      ),
    ).resolves.toEqual(threeSubstitutions);
  });

  it.each([
    { substitutions: threeSubstitutions.substitutions.slice(0, 2) },
    { substitutions: [...threeSubstitutions.substitutions, threeSubstitutions.substitutions[0]] },
    {
      substitutions: [
        { ...threeSubstitutions.substitutions[0], extra: 'not allowed' },
        ...threeSubstitutions.substitutions.slice(1),
      ],
    },
  ])('rejects a non-strict exactly-three substitution response', async (response) => {
    await expect(
      createAiService(requester(response)).substitutions(substitutionInput),
    ).rejects.toMatchObject({ message: 'provider-output-invalid' });
  });

  it.each([
    {
      name: 'tagging',
      invoke: (provider: JsonRequester) => createAiService(provider).tagRecipes([
        tagRecipe('__proto__|middle'),
        tagRecipe('right'),
      ]),
      response: {
        results: [
          { id: '__proto__', tags: ['Lunch'] },
          { id: 'middle|right', tags: ['Dinner'] },
        ],
      },
    },
    {
      name: 'reminders',
      invoke: (provider: JsonRequester) => createAiService(provider).reminderFlags([
        reminderRecipe('expected-one'),
        reminderRecipe('expected-two'),
      ]),
      response: {
        results: [
          { id: 'expected-one', needsDefrost: false, needsMarinate: false },
          { id: 'expected-one', needsDefrost: false, needsMarinate: false },
        ],
      },
    },
    {
      name: 'shopping',
      invoke: (provider: JsonRequester) => createAiService(provider).shoppingGroups([
        rawIngredient(1),
        rawIngredient(2),
        rawIngredient(3),
      ]),
      response: [
        { canonicalName: 'One', category: 'Other', sourceIds: [1] },
        { canonicalName: 'Two', category: 'Other', sourceIds: [2, 2] },
      ],
    },
  ])('rejects $name output with colliding, missing, extra, or duplicate ids', async ({
    invoke,
    response,
  }) => {
    await expect(invoke(requester(response))).rejects.toMatchObject({
      message: 'provider-id-coverage-mismatch',
    });
  });

  it.each([
    {
      name: 'tagging',
      invoke: (provider: JsonRequester) => createAiService(provider).tagRecipes([
        tagRecipe('private-duplicate-id-never-expose'),
        tagRecipe('private-duplicate-id-never-expose'),
      ]),
    },
    {
      name: 'reminders',
      invoke: (provider: JsonRequester) => createAiService(provider).reminderFlags([
        reminderRecipe('private-duplicate-id-never-expose'),
        reminderRecipe('private-duplicate-id-never-expose'),
      ]),
    },
    {
      name: 'shopping',
      invoke: (provider: JsonRequester) => createAiService(provider).shoppingGroups([
        rawIngredient(7),
        rawIngredient(7),
      ]),
    },
    {
      name: 'normalized-equivalent tagging',
      invoke: (provider: JsonRequester) => createAiService(provider).tagRecipes([
        tagRecipe('same'),
        tagRecipe(' same '),
      ]),
    },
    {
      name: 'normalized-equivalent reminders',
      invoke: (provider: JsonRequester) => createAiService(provider).reminderFlags([
        reminderRecipe('same'),
        reminderRecipe(' same '),
      ]),
    },
  ])('rejects duplicate $name input ids before calling the provider', async ({
    invoke,
  }) => {
    const provider = requester({});

    await expect(invoke(provider)).rejects.toMatchObject({
      message: 'request-id-duplicates',
    });
    expect(provider.requestJson).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'tagging',
      response: { results: [{ id: 'normalized-id', tags: [] }] },
      invoke: (provider: JsonRequester) => createAiService(provider).tagRecipes([{
        ...tagRecipe(' normalized-id '),
        steps: [' Cook rice ', ' Add carrots '],
      }]),
      expectedSerializedInput: JSON.stringify([{
        id: 'normalized-id',
        title: 'Vegetable rice bowl',
        totalMinutes: 25,
        ingredients: ['Rice', 'Carrots'],
        steps: 'Cook rice | Add carrots',
        existingTags: ['Lunch'],
      }]),
    },
    {
      name: 'reminders',
      response: {
        results: [{
          id: 'normalized-id',
          needsDefrost: false,
          needsMarinate: false,
        }],
      },
      invoke: (provider: JsonRequester) => createAiService(provider).reminderFlags([{
        ...reminderRecipe(' normalized-id '),
        steps: [' Marinate for 2 hours in the fridge ', ' Bake '],
      }]),
      expectedSerializedInput: JSON.stringify([{
        recipeId: 'normalized-id',
        title: 'Marinated chicken',
        ingredients: ['Chicken breast', 'Yoghurt'],
        steps: ['Marinate for 2 hours in the fridge', 'Bake'],
      }]),
    },
    {
      name: 'shopping',
      response: [{
        canonicalName: 'Carrot',
        category: 'Produce',
        sourceIds: [1],
      }],
      invoke: (provider: JsonRequester) => createAiService(provider).shoppingGroups([{
        ...rawIngredient(1),
        name: ' Carrot ',
        unit: ' g ',
      }]),
      expectedSerializedInput: JSON.stringify([{
        id: 1,
        name: 'Carrot',
        quantity: 2,
        unit: 'g',
      }]),
    },
    {
      name: 'substitutions',
      response: threeSubstitutions,
      invoke: (provider: JsonRequester) => createAiService(provider).substitutions({
        ...substitutionInput,
        ingredientName: ' Butter ',
        ingredientUnit: ' g ',
        recipeTitle: ' Chocolate cake ',
        allIngredients: [' Flour ', ' Butter ', ' Chocolate '],
      }),
      expectedSerializedInput: JSON.stringify(substitutionInput),
    },
  ])('normalizes direct $name input before building the prompt', async ({
    response,
    invoke,
    expectedSerializedInput,
  }) => {
    const provider = requester(response);

    await invoke(provider);

    expect(provider.requestJson).toHaveBeenCalledOnce();
    expect(provider.requestJson.mock.calls[0][1]).toContain(expectedSerializedInput);
  });

  it.each([
    {
      name: 'tagging',
      invoke: (provider: JsonRequester) => createAiService(provider).tagRecipes([{
        ...tagRecipe(),
        unexpected: true,
      }]),
    },
    {
      name: 'reminders',
      invoke: (provider: JsonRequester) => createAiService(provider).reminderFlags([{
        ...reminderRecipe(),
        unexpected: true,
      }]),
    },
    {
      name: 'shopping',
      invoke: (provider: JsonRequester) => createAiService(provider).shoppingGroups([{
        ...rawIngredient(),
        id: -1,
      }]),
    },
    {
      name: 'substitutions',
      invoke: (provider: JsonRequester) => createAiService(provider).substitutions({
        ...substitutionInput,
        allIngredients: [],
      }),
    },
  ])('rejects invalid direct $name input before calling the provider', async ({
    invoke,
  }) => {
    const provider = requester({});

    await expect(invoke(provider)).rejects.toMatchObject({
      message: 'request-input-invalid',
    });
    expect(provider.requestJson).not.toHaveBeenCalled();
  });

  it.each([
    {
      endpoint: 'tagRecipes',
      response: { results: [
        { id: 'one', tags: [] },
        { id: 'two', tags: [] },
      ] },
      expectedModel: 'gemini-3.1-flash-lite',
      expectedTokens: 4_896,
      invoke: (provider: JsonRequester) => createAiService(provider).tagRecipes([
        tagRecipe('one'),
        tagRecipe('two'),
      ]),
    },
    {
      endpoint: 'reminderFlags',
      response: { results: [
        { id: 'one', needsDefrost: false, needsMarinate: false },
        { id: 'two', needsDefrost: false, needsMarinate: false },
      ] },
      expectedModel: 'gemini-3.1-flash-lite',
      expectedTokens: 1_424,
      invoke: (provider: JsonRequester) => createAiService(provider).reminderFlags([
        reminderRecipe('one'),
        reminderRecipe('two'),
      ]),
    },
    {
      endpoint: 'shoppingGroups',
      response: [
        { canonicalName: 'One', category: 'Other', sourceIds: [1] },
        { canonicalName: 'Two', category: 'Other', sourceIds: [2] },
      ],
      expectedModel: 'gemini-3.5-flash',
      expectedTokens: 4_496,
      invoke: (provider: JsonRequester) => createAiService(provider).shoppingGroups([
        rawIngredient(1),
        rawIngredient(2),
      ]),
    },
    {
      endpoint: 'substitutions',
      response: threeSubstitutions,
      expectedModel: 'gemini-3.1-flash-lite',
      expectedTokens: 600,
      invoke: (provider: JsonRequester) => createAiService(provider).substitutions(
        substitutionInput,
      ),
    },
  ])('uses fixed model and internal token budget for $endpoint', async ({
    response,
    expectedModel,
    expectedTokens,
    invoke,
  }) => {
    const provider = requester(response);

    await invoke(provider);

    expect(provider.requestJson).toHaveBeenCalledOnce();
    expect(provider.requestJson).toHaveBeenCalledWith(
      expectedModel,
      expect.any(String),
      expectedTokens,
    );
  });
});
