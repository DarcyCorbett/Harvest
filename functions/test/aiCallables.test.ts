import { logger } from 'firebase-functions';
import {
  HttpsError,
  type CallableRequest,
} from 'firebase-functions/v2/https';
import { z } from 'zod';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const indexMocks = vi.hoisted(() => {
  const secret = { value: vi.fn(() => 'unit-test-secret') };
  const quotaStore = { kind: 'quota-store' };
  return {
    authorizeAllowlistedUser: vi.fn(async () => ({
      uid: 'user-1',
      email: 'member@example.com',
    })),
    authorizeHouseholdMember: vi.fn(async () => ({
      uid: 'user-1',
      email: 'member@example.com',
    })),
    firestoreQuotaStore: vi.fn(() => quotaStore),
    initializeApp: vi.fn(),
    onCall: vi.fn((options: unknown, handler: unknown) => ({ options, handler })),
    quotaStore,
    requestGeminiJson: vi.fn(),
    reserveQuota: vi.fn(async () => 1),
    secret,
    householdMutations: {
      create: vi.fn(),
      join: vi.fn(),
    },
  };
});

vi.mock('firebase-admin/app', () => ({
  initializeApp: indexMocks.initializeApp,
}));

vi.mock('firebase-functions/v2/https', async () => {
  const actual = await vi.importActual<typeof import('firebase-functions/v2/https')>(
    'firebase-functions/v2/https',
  );
  return { ...actual, onCall: indexMocks.onCall };
});

vi.mock('../src/config.js', () => ({
  GEMINI_API_KEY: indexMocks.secret,
}));

vi.mock('../src/authz.js', () => ({
  authorizeAllowlistedUser: indexMocks.authorizeAllowlistedUser,
  authorizeHouseholdMember: indexMocks.authorizeHouseholdMember,
}));

vi.mock('../src/callables/households.js', () => ({
  firestoreHouseholdMutations: vi.fn(() => indexMocks.householdMutations),
  createHouseholdHandlers: vi.fn(() => ({
    create: vi.fn(),
    join: vi.fn(),
    switch: vi.fn(),
  })),
}));

vi.mock('../src/quota.js', () => ({
  firestoreQuotaStore: indexMocks.firestoreQuotaStore,
  reserveQuota: indexMocks.reserveQuota,
}));

vi.mock('../src/ai/geminiProvider.js', () => ({
  requestGeminiJson: indexMocks.requestGeminiJson,
}));

import { createAiHandlers } from '../src/callables/ai.js';

const AUTH = { uid: 'auth-user', token: {} } as CallableRequest<unknown>['auth'];
const HOUSEHOLD_ID = 'private-household-never-log';
const UID = 'authorized-user';

const tagInput = {
  householdId: HOUSEHOLD_ID,
  recipes: [{
    recipeId: 'recipe-1',
    title: 'Private recipe title',
    totalMinutes: 20,
    ingredients: ['private ingredient'],
    steps: ['private preparation step'],
    existingTags: [],
  }],
};

const reminderInput = {
  householdId: HOUSEHOLD_ID,
  recipes: [{
    recipeId: 'recipe-1',
    title: 'Private recipe title',
    ingredients: ['private ingredient'],
    steps: ['private preparation step'],
  }],
};

const shoppingInput = {
  householdId: HOUSEHOLD_ID,
  ingredients: [{
    id: 7,
    name: 'private ingredient',
    quantity: 2,
    unit: 'g',
  }],
};

const substitutionsInput = {
  householdId: HOUSEHOLD_ID,
  ingredientName: 'private ingredient',
  ingredientUnit: 'g',
  recipeTitle: 'Private recipe title',
  allIngredients: ['private ingredient', 'another private ingredient'],
};

const tagOutput = { results: [{ id: 'recipe-1', tags: ['Dinner'] }] };
const reminderOutput = {
  results: [{
    id: 'recipe-1',
    needsDefrost: false,
    needsMarinate: false,
  }],
};
const shoppingOutput = [{
  canonicalName: 'Ingredient',
  category: 'Other',
  sourceIds: [7],
}];
const substitutionsOutput = {
  substitutions: [
    { name: 'One', adjustment: '1:1', reason: 'Reason one.' },
    { name: 'Two', adjustment: '1:1', reason: 'Reason two.' },
    { name: 'Three', adjustment: '1:1', reason: 'Reason three.' },
  ],
};

const endpointCases = [
  {
    endpoint: 'tagRecipes' as const,
    input: tagInput,
    serviceArgument: tagInput.recipes,
    output: tagOutput,
  },
  {
    endpoint: 'reminderFlags' as const,
    input: reminderInput,
    serviceArgument: reminderInput.recipes,
    output: reminderOutput,
  },
  {
    endpoint: 'shoppingGroups' as const,
    input: shoppingInput,
    serviceArgument: shoppingInput.ingredients,
    output: shoppingOutput,
  },
  {
    endpoint: 'substitutions' as const,
    input: substitutionsInput,
    serviceArgument: {
      ingredientName: substitutionsInput.ingredientName,
      ingredientUnit: substitutionsInput.ingredientUnit,
      recipeTitle: substitutionsInput.recipeTitle,
      allIngredients: substitutionsInput.allIngredients,
    },
    output: substitutionsOutput,
  },
];

function request(data: unknown): CallableRequest<unknown> {
  return { auth: AUTH, data } as CallableRequest<unknown>;
}

function dependencies() {
  const order: string[] = [];
  const authorize = vi.fn(async () => {
    order.push('authorize');
    return { uid: UID, email: 'sensitive@example.com' };
  });
  const reserve = vi.fn(async () => {
    order.push('reserve');
    return 1;
  });
  const service = {
    tagRecipes: vi.fn(async () => {
      order.push('tagRecipes');
      return tagOutput;
    }),
    reminderFlags: vi.fn(async () => {
      order.push('reminderFlags');
      return reminderOutput;
    }),
    shoppingGroups: vi.fn(async () => {
      order.push('shoppingGroups');
      return shoppingOutput;
    }),
    substitutions: vi.fn(async () => {
      order.push('substitutions');
      return substitutionsOutput;
    }),
  };
  return { authorize, order, reserve, service };
}

function assertSafeLogKeys(metadata: unknown, expectedKeys: string[]) {
  expect(metadata).toBeTypeOf('object');
  expect(Object.keys(metadata as object).sort()).toEqual(expectedKeys.sort());
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(logger, 'info').mockImplementation(() => undefined);
});

afterEach(() => vi.restoreAllMocks());

describe('createAiHandlers', () => {
  it('returns exactly four fixed endpoints and no generic call or proxy', () => {
    const handlers = createAiHandlers(dependencies());

    expect(Object.keys(handlers).sort()).toEqual([
      'reminderFlags',
      'shoppingGroups',
      'substitutions',
      'tagRecipes',
    ]);
    expect(handlers).not.toHaveProperty('call');
    expect(handlers).not.toHaveProperty('proxy');
  });

  it.each(endpointCases)(
    '$endpoint rejects malformed input before authorization, quota, service, or logs',
    async ({ endpoint, input }) => {
      const injected = dependencies();
      const handlers = createAiHandlers(injected);

      await expect(
        handlers[endpoint](request({ ...input, prompt: 'arbitrary prompt' })),
      ).rejects.toMatchObject({ code: 'invalid-argument' });

      expect(injected.authorize).not.toHaveBeenCalled();
      expect(injected.reserve).not.toHaveBeenCalled();
      for (const method of Object.values(injected.service)) {
        expect(method).not.toHaveBeenCalled();
      }
      expect(logger.info).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      endpoint: 'tagRecipes' as const,
      input: {
        ...tagInput,
        recipes: [tagInput.recipes[0], { ...tagInput.recipes[0] }],
      },
    },
    {
      endpoint: 'reminderFlags' as const,
      input: {
        ...reminderInput,
        recipes: [reminderInput.recipes[0], { ...reminderInput.recipes[0] }],
      },
    },
    {
      endpoint: 'shoppingGroups' as const,
      input: {
        ...shoppingInput,
        ingredients: [
          shoppingInput.ingredients[0],
          { ...shoppingInput.ingredients[0] },
        ],
      },
    },
  ])(
    '$endpoint rejects duplicate ids before authorization, quota, service, or logs',
    async ({ endpoint, input }) => {
      const injected = dependencies();

      await expect(
        createAiHandlers(injected)[endpoint](request(input)),
      ).rejects.toMatchObject({ code: 'invalid-argument' });

      expect(injected.authorize).not.toHaveBeenCalled();
      expect(injected.reserve).not.toHaveBeenCalled();
      for (const method of Object.values(injected.service)) {
        expect(method).not.toHaveBeenCalled();
      }
      expect(logger.info).not.toHaveBeenCalled();
    },
  );

  it.each(endpointCases)(
    '$endpoint authorizes, reserves its fixed quota, and calls only its fixed service method',
    async ({ endpoint, input, serviceArgument, output }) => {
      const injected = dependencies();
      const handlers = createAiHandlers(injected);

      await expect(handlers[endpoint](request(input))).resolves.toEqual(output);

      expect(injected.order).toEqual(['authorize', 'reserve', endpoint]);
      expect(injected.authorize).toHaveBeenCalledWith(AUTH, HOUSEHOLD_ID);
      expect(injected.reserve).toHaveBeenCalledWith(UID, endpoint, 1);
      expect(injected.service[endpoint]).toHaveBeenCalledWith(serviceArgument);
      for (const [methodName, method] of Object.entries(injected.service)) {
        expect(method).toHaveBeenCalledTimes(methodName === endpoint ? 1 : 0);
      }

      expect(logger.info).toHaveBeenCalledOnce();
      const [event, metadata] = vi.mocked(logger.info).mock.calls[0];
      expect(event).toBe('ai_callable');
      assertSafeLogKeys(metadata, ['durationMs', 'endpoint', 'outcome', 'uid']);
      expect(metadata).toMatchObject({ endpoint, outcome: 'success', uid: UID });
      expect((metadata as { durationMs: number }).durationMs).toBeGreaterThanOrEqual(0);
    },
  );

  it.each(endpointCases)(
    '$endpoint preserves authorization HttpsErrors and short-circuits quota and service',
    async ({ endpoint, input }) => {
      const injected = dependencies();
      const authError = new HttpsError('permission-denied', 'Permission denied.');
      injected.authorize.mockRejectedValue(authError);

      await expect(
        createAiHandlers(injected)[endpoint](request(input)),
      ).rejects.toBe(authError);

      expect(injected.reserve).not.toHaveBeenCalled();
      expect(injected.service[endpoint]).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith('ai_callable', {
        endpoint,
        outcome: 'failed',
        failureClass: 'authorization',
      });
    },
  );

  it.each(endpointCases)(
    '$endpoint preserves quota HttpsErrors and short-circuits service',
    async ({ endpoint, input }) => {
      const injected = dependencies();
      const quotaError = new HttpsError(
        'resource-exhausted',
        'Daily AI quota exceeded.',
      );
      injected.reserve.mockRejectedValue(quotaError);

      await expect(
        createAiHandlers(injected)[endpoint](request(input)),
      ).rejects.toBe(quotaError);

      expect(injected.authorize).toHaveBeenCalledOnce();
      expect(injected.service[endpoint]).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith('ai_callable', {
        endpoint,
        outcome: 'failed',
        failureClass: 'quota',
      });
    },
  );

  it.each(endpointCases)(
    '$endpoint maps malformed provider output to bounded internal without leaking it',
    async ({ endpoint, input }) => {
      const injected = dependencies();
      const parsed = z.string().safeParse({
        secret: 'provider-response-never-log',
      });
      if (parsed.success) throw new Error('expected an invalid fixture');
      injected.service[endpoint].mockRejectedValue(parsed.error);

      await expect(
        createAiHandlers(injected)[endpoint](request(input)),
      ).rejects.toMatchObject({
        code: 'internal',
        message: 'AI request failed.',
      });

      expect(logger.info).toHaveBeenCalledOnce();
      const [event, metadata] = vi.mocked(logger.info).mock.calls[0];
      expect(event).toBe('ai_callable');
      assertSafeLogKeys(metadata, ['endpoint', 'failureClass', 'outcome']);
      expect(metadata).toEqual({
        endpoint,
        outcome: 'failed',
        failureClass: 'service',
      });
      const serialized = JSON.stringify(vi.mocked(logger.info).mock.calls);
      for (const forbidden of [
        'provider-response-never-log',
        HOUSEHOLD_ID,
        'sensitive@example.com',
        'private ingredient',
        'Private recipe title',
        'ZodError',
        'message',
        'stack',
        'cause',
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
    },
  );
});

describe('Functions entrypoint', () => {
  it('registers four secret-bound AI callables and three non-secret household callables', async () => {
    vi.resetModules();

    const entrypoint = await import('../src/index.js');

    expect(Object.keys(entrypoint).sort()).toEqual([
      'createHousehold',
      'joinHousehold',
      'reminderFlags',
      'shoppingGroups',
      'substitutions',
      'switchHousehold',
      'tagRecipes',
    ]);
    expect(indexMocks.initializeApp).toHaveBeenCalledOnce();
    expect(indexMocks.firestoreQuotaStore).toHaveBeenCalledOnce();
    expect(indexMocks.onCall).toHaveBeenCalledTimes(7);
    for (const [options] of indexMocks.onCall.mock.calls.slice(0, 4)) {
      expect(options).toEqual({
        secrets: [indexMocks.secret],
        enforceAppCheck: false,
        consumeAppCheckToken: false,
      });
    }
    for (const call of indexMocks.onCall.mock.calls.slice(4)) {
      expect(call).toHaveLength(1);
      expect(call[0]).toEqual(expect.any(Function));
    }
    expect(indexMocks.secret.value).not.toHaveBeenCalled();
    expect(entrypoint).not.toHaveProperty('callAi');
    expect(entrypoint).not.toHaveProperty('proxy');
  });
});
