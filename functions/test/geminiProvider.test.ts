import { logger } from 'firebase-functions';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  GeminiProviderError,
  requestGeminiJson,
} from '../src/ai/geminiProvider.js';
import {
  reminderFlagsRequest,
  reminderFlagsResponse,
  shoppingGroupsRequest,
  shoppingGroupsResponse,
  substitutionsRequest,
  substitutionsResponse,
  tagRecipesRequest,
  tagRecipesResponse,
} from '../src/ai/contracts.js';

const API_KEY = 'test-secret-key-never-expose';

afterEach(() => vi.restoreAllMocks());

function providerResponse(text: string, finishReason = 'STOP'): Response {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text }] }, finishReason }],
      usageMetadata: {
        promptTokenCount: 4,
        candidatesTokenCount: 2,
        totalTokenCount: 6,
      },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

interface ProviderOverrides {
  apiKey?: string;
  timeoutMs?: number;
}

function callProvider(fetchImpl?: typeof fetch, overrides: ProviderOverrides = {}) {
  return requestGeminiJson<{ answer: string }>({
    apiKey: API_KEY,
    model: 'gemini-test',
    prompt: 'Return JSON.',
    maxOutputTokens: 256,
    fetchImpl,
    ...overrides,
  });
}

describe('requestGeminiJson', () => {
  it('uses a key header, JSON mode, and an abort signal without exposing the key in the URL', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(providerResponse('{"answer":"ok"}'));

    await expect(callProvider(fetchImpl)).resolves.toEqual({ answer: 'ok' });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).not.toContain(API_KEY);
    expect(String(url)).not.toContain('?key=');
    expect(init?.headers).toMatchObject({ 'x-goog-api-key': API_KEY });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init?.body)).generationConfig).toMatchObject({
      temperature: 0,
      maxOutputTokens: 256,
      responseMimeType: 'application/json',
    });
  });

  it('maps HTTP errors to bounded credential-free errors without reading the body', async () => {
    const providerBody = `rate limited: ${API_KEY}`;
    const response = new Response(providerBody, { status: 429 });
    const textSpy = vi.spyOn(response, 'text');
    const jsonSpy = vi.spyOn(response, 'json');
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response);

    let thrown: unknown;
    try {
      await callProvider(fetchImpl);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(GeminiProviderError);
    expect(thrown).toMatchObject({
      code: 'provider-http-429',
      message: 'provider-http-429',
    });
    expect((thrown as Error).message).not.toContain(API_KEY);
    expect((thrown as Error).message).not.toContain(providerBody);
    expect(textSpy).not.toHaveBeenCalled();
    expect(jsonSpy).not.toHaveBeenCalled();
  });

  it('maps credential-bearing transport failures to a bounded network error', async () => {
    const transportMessage = `connection failed for ${API_KEY}`;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error(transportMessage));

    let thrown: unknown;
    try {
      await callProvider(fetchImpl);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(GeminiProviderError);
    expect(thrown).toMatchObject({
      code: 'provider-network',
      message: 'provider-network',
    });
    expect((thrown as Error).message).not.toContain(API_KEY);
    expect((thrown as Error).message).not.toContain(transportMessage);
    expect(Object.hasOwn(thrown as object, 'cause')).toBe(false);
  });

  it('maps an actual request-signal timeout to a bounded timeout error', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) return reject(new Error('missing abort signal'));
          const rejectWithReason = () => reject(signal.reason);
          if (signal.aborted) rejectWithReason();
          else signal.addEventListener('abort', rejectWithReason, { once: true });
        }),
    );

    await expect(callProvider(fetchImpl, { timeoutMs: 5 })).rejects.toMatchObject({
      name: 'GeminiProviderError',
      code: 'provider-timeout',
      message: 'provider-timeout',
    });
  });

  it('rejects non-JSON candidate text with a bounded error', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(providerResponse('not valid JSON'));
    await expect(callProvider(fetchImpl)).rejects.toMatchObject({
      name: 'GeminiProviderError',
      code: 'provider-invalid-json',
      message: 'provider-invalid-json',
    });
  });

  it.each([
    ['null', null],
    ['non-array candidates', { candidates: 'not-an-array' }],
    ['non-array parts', { candidates: [{ content: { parts: 'not-an-array' } }] }],
  ])('maps a malformed %s envelope to a bounded error', async (_name, envelope) => {
    const logSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(envelope), { status: 200 }));

    await expect(callProvider(fetchImpl)).rejects.toMatchObject({
      name: 'GeminiProviderError',
      code: 'provider-invalid-response',
      message: 'provider-invalid-response',
    });
    expect(logSpy).not.toHaveBeenCalled();
  });

  it.each([
    [
      'a credential-bearing string token count',
      JSON.stringify(`tokens-${API_KEY}`),
      `tokens-${API_KEY}`,
    ],
    ['a negative numeric token count', '-1', '-1'],
    ['a non-finite token count', '1e999', '1e999'],
  ])('rejects %s before anything is logged', async (_name, tokenJson, forbidden) => {
    const logSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        `{"candidates":[{"content":{"parts":[{"text":"{\\"answer\\":\\"ok\\"}"}]}}],` +
          `"usageMetadata":{"promptTokenCount":${tokenJson},` +
          `"candidatesTokenCount":2,"totalTokenCount":6}}`,
        { status: 200 },
      ),
    );

    let thrown: unknown;
    try {
      await callProvider(fetchImpl);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(GeminiProviderError);
    expect(thrown).toMatchObject({
      name: 'GeminiProviderError',
      code: 'provider-invalid-response',
      message: 'provider-invalid-response',
    });
    expect(JSON.stringify(thrown)).not.toContain(forbidden);
    expect(JSON.stringify(thrown)).not.toContain(API_KEY);
    expect(Object.hasOwn(thrown as object, 'cause')).toBe(false);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('maps malformed outer JSON to a bounded response error', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('{not-json', { status: 200 }));
    await expect(callProvider(fetchImpl)).rejects.toMatchObject({
      code: 'provider-invalid-response',
    });
  });

  it('allows harmless provider additions without logging them', async () => {
    const logSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const addition = `not-for-logs-${API_KEY}`;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [{
            content: { parts: [{ text: '{"answer":"ok"}', extra: true }], extra: true },
            finishReason: 'STOP',
            extra: true,
          }],
          usageMetadata: {
            promptTokenCount: 4,
            candidatesTokenCount: 2,
            totalTokenCount: 6,
            extra: addition,
          },
          extra: addition,
        }),
        { status: 200 },
      ),
    );

    await expect(callProvider(fetchImpl)).resolves.toEqual({ answer: 'ok' });
    expect(JSON.stringify(logSpy.mock.calls)).not.toContain(addition);
    expect(JSON.stringify(logSpy.mock.calls)).not.toContain(API_KEY);
  });

  it('preserves other bounded provider mappings', async () => {
    await expect(callProvider(undefined, { apiKey: '   ' })).rejects.toMatchObject({
      code: 'provider-secret-missing',
    });
    await expect(
      callProvider(vi.fn<typeof fetch>().mockResolvedValue(
        providerResponse('{"partial":true}', 'MAX_TOKENS'),
      )),
    ).rejects.toMatchObject({ code: 'provider-max-tokens' });
    await expect(
      callProvider(vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ candidates: [] }), { status: 200 }),
      )),
    ).rejects.toMatchObject({ code: 'provider-empty-response' });
  });
});

type Overrides = Record<string, unknown>;
type SafeSchema = { safeParse(value: unknown): { success: boolean } };
type Boundary = [string, SafeSchema, (size: number) => unknown, number];

const TAGS = [
  'Breakfast', 'Lunch', 'Dinner', 'Side', 'Snack', 'Salad', 'Asian',
  'Mexican', 'Mediterranean', 'Italian', 'Indian', 'Healthy', 'Vegetarian',
  'Kid Friendly',
];
const CATEGORIES = [
  'Produce', 'Meat & Seafood', 'Dairy & Eggs', 'Pantry & Dry Goods',
  'Herbs & Spices', 'Oils, Sauces & Condiments', 'Bread & Bakery', 'Frozen',
  'Other',
];

const recipe = (overrides: Overrides = {}) => ({
  recipeId: 'recipe-1', title: 'Dinner', totalMinutes: null,
  ingredients: ['Rice'], steps: ['Cook'], existingTags: [], ...overrides,
});
const reminderRecipe = (overrides: Overrides = {}) => ({
  recipeId: 'recipe-1', title: 'Dinner', ingredients: ['Rice'], steps: ['Cook'],
  ...overrides,
});
const rawIngredient = (overrides: Overrides = {}) => ({
  id: 1, name: 'Rice', quantity: 1, unit: 'g', ...overrides,
});
const tagRequest = (overrides: Overrides = {}) => ({
  householdId: 'household-1', recipes: [recipe()], ...overrides,
});
const reminderRequest = (overrides: Overrides = {}) => ({
  householdId: 'household-1', recipes: [reminderRecipe()], ...overrides,
});
const shoppingRequest = (overrides: Overrides = {}) => ({
  householdId: 'household-1', ingredients: [rawIngredient()], ...overrides,
});
const substitutionsRequestValue = (overrides: Overrides = {}) => ({
  householdId: 'household-1', ingredientName: 'Rice', ingredientUnit: 'g',
  recipeTitle: 'Dinner', allIngredients: ['Rice'], ...overrides,
});
const tagResult = (overrides: Overrides = {}) => ({
  id: 'recipe-1', tags: ['Dinner'], ...overrides,
});
const reminderResult = (overrides: Overrides = {}) => ({
  id: 'recipe-1', needsDefrost: false, needsMarinate: false, ...overrides,
});
const shoppingResult = (overrides: Overrides = {}) => ({
  canonicalName: 'Olive oil', category: 'Oils, Sauces & Condiments',
  sourceIds: [1], unit: 'ml', ...overrides,
});
const substitution = (overrides: Overrides = {}) => ({
  name: 'Quinoa', adjustment: 'Use the same amount', reason: 'Similar texture',
  ...overrides,
});
const substitutionsResult = (count = 3, overrides: Overrides = {}) => ({
  substitutions: Array.from({ length: count }, () => substitution()), ...overrides,
});

const requestBoundaries: Boundary[] = [
  ['household id', tagRecipesRequest, (n) => tagRequest({ householdId: 'h'.repeat(n) }), 128],
  ['tag recipes', tagRecipesRequest, (n) => tagRequest({
    recipes: Array.from({ length: n }, (_, index) =>
      recipe({ recipeId: `recipe-${index}` })),
  }), 25],
  ['recipe id', tagRecipesRequest, (n) => tagRequest({ recipes: [recipe({ recipeId: 'r'.repeat(n) })] }), 160],
  ['recipe title', tagRecipesRequest, (n) => tagRequest({ recipes: [recipe({ title: 't'.repeat(n) })] }), 200],
  ['total minutes', tagRecipesRequest, (n) => tagRequest({ recipes: [recipe({ totalMinutes: n })] }), 10_080],
  ['recipe ingredients', tagRecipesRequest, (n) => tagRequest({ recipes: [recipe({ ingredients: Array(n).fill('Rice') })] }), 100],
  ['ingredient name', tagRecipesRequest, (n) => tagRequest({ recipes: [recipe({ ingredients: ['i'.repeat(n)] })] }), 120],
  ['recipe steps', tagRecipesRequest, (n) => tagRequest({ recipes: [recipe({ steps: Array(n).fill('Cook') })] }), 40],
  ['recipe step text', tagRecipesRequest, (n) => tagRequest({ recipes: [recipe({ steps: ['s'.repeat(n)] })] }), 300],
  ['existing tags', tagRecipesRequest, (n) => tagRequest({ recipes: [recipe({ existingTags: Array(n).fill('Dinner') })] }), 30],
  ['existing tag text', tagRecipesRequest, (n) => tagRequest({ recipes: [recipe({ existingTags: ['t'.repeat(n)] })] }), 200],
  ['reminder recipes', reminderFlagsRequest, (n) => reminderRequest({
    recipes: Array.from({ length: n }, (_, index) =>
      reminderRecipe({ recipeId: `recipe-${index}` })),
  }), 25],
  ['shopping ingredients', shoppingGroupsRequest, (n) => shoppingRequest({ ingredients: Array.from({ length: n }, (_, id) => rawIngredient({ id })) }), 500],
  ['raw ingredient id', shoppingGroupsRequest, (n) => shoppingRequest({ ingredients: [rawIngredient({ id: n })] }), 9_999],
  ['raw ingredient quantity', shoppingGroupsRequest, (n) => shoppingRequest({ ingredients: [rawIngredient({ quantity: n })] }), 1_000_000],
  ['raw ingredient name', shoppingGroupsRequest, (n) => shoppingRequest({ ingredients: [rawIngredient({ name: 'i'.repeat(n) })] }), 120],
  ['raw ingredient unit', shoppingGroupsRequest, (n) => shoppingRequest({ ingredients: [rawIngredient({ unit: 'u'.repeat(n) })] }), 40],
  ['substitution ingredient name', substitutionsRequest, (n) => substitutionsRequestValue({ ingredientName: 'i'.repeat(n) }), 120],
  ['substitution unit', substitutionsRequest, (n) => substitutionsRequestValue({ ingredientUnit: 'u'.repeat(n) }), 40],
  ['substitution recipe title', substitutionsRequest, (n) => substitutionsRequestValue({ recipeTitle: 't'.repeat(n) }), 200],
  ['all ingredients', substitutionsRequest, (n) => substitutionsRequestValue({ allIngredients: Array(n).fill('Rice') }), 100],
  ['all ingredient text', substitutionsRequest, (n) => substitutionsRequestValue({ allIngredients: ['i'.repeat(n)] }), 120],
];

const responseBoundaries: Boundary[] = [
  ['tag results', tagRecipesResponse, (n) => ({ results: Array.from({ length: n }, tagResult) }), 25],
  ['tag result id', tagRecipesResponse, (n) => ({ results: [tagResult({ id: 'r'.repeat(n) })] }), 160],
  ['recipe tags', tagRecipesResponse, (n) => ({ results: [tagResult({ tags: Array(n).fill('Dinner') })] }), 14],
  ['reminder results', reminderFlagsResponse, (n) => ({ results: Array.from({ length: n }, reminderResult) }), 25],
  ['reminder result id', reminderFlagsResponse, (n) => ({ results: [reminderResult({ id: 'r'.repeat(n) })] }), 160],
  ['shopping groups', shoppingGroupsResponse, (n) => Array.from({ length: n }, shoppingResult), 500],
  ['canonical name', shoppingGroupsResponse, (n) => [shoppingResult({ canonicalName: 'i'.repeat(n) })], 120],
  ['source ids', shoppingGroupsResponse, (n) => [shoppingResult({ sourceIds: Array(n).fill(1) })], 500],
  ['shopping unit', shoppingGroupsResponse, (n) => [shoppingResult({ unit: 'u'.repeat(n) })], 40],
  ['substitutions', substitutionsResponse, (n) => substitutionsResult(n), 3],
  ['substitution name', substitutionsResponse, (n) => substitutionsResult(3, { substitutions: Array.from({ length: 3 }, () => substitution({ name: 'n'.repeat(n) })) }), 120],
  ['substitution adjustment', substitutionsResponse, (n) => substitutionsResult(3, { substitutions: Array.from({ length: 3 }, () => substitution({ adjustment: 'a'.repeat(n) })) }), 160],
  ['substitution reason', substitutionsResponse, (n) => substitutionsResult(3, { substitutions: Array.from({ length: 3 }, () => substitution({ reason: 'r'.repeat(n) })) }), 300],
];

describe('AI request contracts', () => {
  it.each(requestBoundaries)('%s accepts max and rejects max plus one',
    (_name, schema, valueAt, maximum) => {
      expect.soft(schema.safeParse(valueAt(maximum)).success).toBe(true);
      expect.soft(schema.safeParse(valueAt(maximum + 1)).success).toBe(false);
    });

  it.each([
    ['tagRecipes', tagRecipesRequest, tagRequest({ recipes: [] })],
    ['reminderFlags', reminderFlagsRequest, reminderRequest({ recipes: [] })],
    ['shoppingGroups', shoppingGroupsRequest, shoppingRequest({ ingredients: [] })],
    ['substitutions', substitutionsRequest, substitutionsRequestValue({ allIngredients: [] })],
  ])('%s rejects its required empty collection', (_name, schema, value) => {
    expect(schema.safeParse(value).success).toBe(false);
  });

  it.each([
    [
      'tagRecipes',
      tagRecipesRequest,
      tagRequest({
        recipes: [
          recipe({ recipeId: 'private-duplicate-id-never-expose' }),
          recipe({ recipeId: 'private-duplicate-id-never-expose' }),
        ],
      }),
      'private-duplicate-id-never-expose',
    ],
    [
      'reminderFlags',
      reminderFlagsRequest,
      reminderRequest({
        recipes: [
          reminderRecipe({ recipeId: 'private-duplicate-id-never-expose' }),
          reminderRecipe({ recipeId: 'private-duplicate-id-never-expose' }),
        ],
      }),
      'private-duplicate-id-never-expose',
    ],
    [
      'shoppingGroups',
      shoppingGroupsRequest,
      shoppingRequest({
        ingredients: [rawIngredient({ id: 7_777 }), rawIngredient({ id: 7_777 })],
      }),
      '7777',
    ],
  ])('%s rejects duplicate input ids with a bounded issue', (
    _name,
    schema,
    value,
    forbidden,
  ) => {
    const parsed = schema.safeParse(value);

    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error('expected duplicate ids to be rejected');
    expect(parsed.error.issues).toEqual([
      expect.objectContaining({ message: 'Duplicate request identifiers.' }),
    ]);
    expect(JSON.stringify(parsed.error.issues)).not.toContain(forbidden);
  });

  it.each([
    ['tagRecipes', tagRecipesRequest, tagRequest()],
    ['reminderFlags', reminderFlagsRequest, reminderRequest()],
    ['shoppingGroups', shoppingGroupsRequest, shoppingRequest()],
    ['substitutions', substitutionsRequest, substitutionsRequestValue()],
  ])('%s rejects unknown top-level keys', (_name, schema, value) => {
    expect(schema.safeParse({ ...value, unexpected: true }).success).toBe(false);
  });

  it.each([
    ['tag recipe', tagRecipesRequest, tagRequest({ recipes: [recipe({ unexpected: true })] })],
    ['reminder recipe', reminderFlagsRequest, reminderRequest({ recipes: [reminderRecipe({ unexpected: true })] })],
    ['raw ingredient', shoppingGroupsRequest, shoppingRequest({ ingredients: [rawIngredient({ unexpected: true })] })],
  ])('%s rejects unknown nested keys', (_name, schema, value) => {
    expect(schema.safeParse(value).success).toBe(false);
  });

  it.each([
    ['zero total minutes', tagRecipesRequest, tagRequest({ recipes: [recipe({ totalMinutes: 0 })] })],
    ['fractional total minutes', tagRecipesRequest, tagRequest({ recipes: [recipe({ totalMinutes: 1.5 })] })],
    ['negative id', shoppingGroupsRequest, shoppingRequest({ ingredients: [rawIngredient({ id: -1 })] })],
    ['negative quantity', shoppingGroupsRequest, shoppingRequest({ ingredients: [rawIngredient({ quantity: -1 })] })],
    ['infinite quantity', shoppingGroupsRequest, shoppingRequest({ ingredients: [rawIngredient({ quantity: Infinity })] })],
  ])('rejects %s', (_name, schema, value) => {
    expect(schema.safeParse(value).success).toBe(false);
  });
});

describe('AI response contracts', () => {
  it.each(responseBoundaries)('%s accepts max and rejects max plus one',
    (_name, schema, valueAt, maximum) => {
      expect.soft(schema.safeParse(valueAt(maximum)).success).toBe(true);
      expect.soft(schema.safeParse(valueAt(maximum + 1)).success).toBe(false);
    });

  it('requires exactly three substitutions', () => {
    expect.soft(substitutionsResponse.safeParse(substitutionsResult(2)).success).toBe(false);
    expect.soft(substitutionsResponse.safeParse(substitutionsResult(3)).success).toBe(true);
    expect.soft(substitutionsResponse.safeParse(substitutionsResult(4)).success).toBe(false);
  });

  it.each([
    ['tagRecipes', tagRecipesResponse, { results: [tagResult()], unexpected: true }],
    ['reminderFlags', reminderFlagsResponse, { results: [reminderResult()], unexpected: true }],
    ['substitutions', substitutionsResponse, substitutionsResult(3, { unexpected: true })],
  ])('%s rejects unknown top-level keys', (_name, schema, value) => {
    expect(schema.safeParse(value).success).toBe(false);
  });

  it.each([
    ['tag result', tagRecipesResponse, { results: [tagResult({ unexpected: true })] }],
    ['reminder result', reminderFlagsResponse, { results: [reminderResult({ unexpected: true })] }],
    ['shopping result', shoppingGroupsResponse, [shoppingResult({ unexpected: true })]],
    ['substitution', substitutionsResponse, substitutionsResult(3, {
      substitutions: [substitution({ unexpected: true }), substitution(), substitution()],
    })],
  ])('%s rejects unknown nested keys', (_name, schema, value) => {
    expect(schema.safeParse(value).success).toBe(false);
  });

  it('accepts every valid enum value and rejects invalid values', () => {
    expect.soft(tagRecipesResponse.safeParse({ results: [tagResult({ tags: TAGS })] }).success).toBe(true);
    expect.soft(tagRecipesResponse.safeParse({ results: [tagResult({ tags: ['Brunch'] })] }).success).toBe(false);
    expect.soft(shoppingGroupsResponse.safeParse(
      CATEGORIES.map((category, id) => shoppingResult({ category, sourceIds: [id] })),
    ).success).toBe(true);
    for (const category of ['Oils', 'Sauces & Condiments', 'Beverages']) {
      expect.soft(shoppingGroupsResponse.safeParse([shoppingResult({ category })]).success).toBe(false);
    }
  });

  it.each([
    ['negative source id', [shoppingResult({ sourceIds: [-1] })]],
    ['source id above max', [shoppingResult({ sourceIds: [10_000] })]],
  ])('rejects %s', (_name, value) => {
    expect(shoppingGroupsResponse.safeParse(value).success).toBe(false);
  });

  it('accepts source id bounds', () => {
    expect(shoppingGroupsResponse.safeParse([
      shoppingResult({ sourceIds: [0, 9_999] }),
    ]).success).toBe(true);
  });
});
