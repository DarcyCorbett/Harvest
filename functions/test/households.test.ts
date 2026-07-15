import type { CallableRequest } from 'firebase-functions/v2/https';
import { describe, expect, it, vi } from 'vitest';

const firestoreAdmin = vi.hoisted(() => ({
  arrayUnion: vi.fn((value: string) => ({ operation: 'arrayUnion', value })),
  getFirestore: vi.fn(),
}));

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { arrayUnion: firestoreAdmin.arrayUnion },
  getFirestore: firestoreAdmin.getFirestore,
}));

import {
  createFirestoreHouseholdStore,
  createHouseholdMutations,
  createHouseholdHandlers,
  normalizeInviteCode,
  type HouseholdMutationStore,
  type HouseholdMutations,
} from '../src/callables/households.js';

const AUTH = {
  uid: 'auth-user',
  token: { email: 'member@example.com', email_verified: true },
} as CallableRequest<unknown>['auth'];

function request(data: unknown, auth = AUTH): CallableRequest<unknown> {
  return { auth, data } as CallableRequest<unknown>;
}

function dependencies(overrides: Partial<{
  authorize: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  join: ReturnType<typeof vi.fn>;
}> = {}) {
  return {
    authorize: vi.fn(async () => ({
      uid: 'verified-user',
      email: 'member@example.com',
    })),
    create: vi.fn(async () => ({
      householdId: 'household-created',
      inviteCode: 'ABC234',
    })),
    join: vi.fn(async () => 'household-joined'),
    ...overrides,
  };
}

describe('normalizeInviteCode', () => {
  it('trims and uppercases a code from the existing invite alphabet', () => {
    expect(normalizeInviteCode('  abc234  ')).toBe('ABC234');
  });

  it.each([
    'AB-C23',
    'AB C23',
    'ABC12O',
    'ABC12I',
    'ABC12L',
    'ABC120',
    'short',
    'A'.repeat(21),
  ])('rejects rather than stripping invalid characters from %s', (value) => {
    expect(normalizeInviteCode(value)).toBeNull();
  });
});

describe('createHouseholdHandlers', () => {
  it.each([null, [], { email: 'spoof@example.com' }])(
    'rejects malformed create input before authorization or mutation: %j',
    async (data) => {
    const injected = dependencies();

    await expect(
      createHouseholdHandlers(injected).create(request(data)),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(injected.authorize).not.toHaveBeenCalled();
    expect(injected.create).not.toHaveBeenCalled();
    },
  );

  it('creates from the verified server identity and accepts no client email', async () => {
    const injected = dependencies();

    await expect(
      createHouseholdHandlers(injected).create(request({})),
    ).resolves.toEqual({
      householdId: 'household-created',
      inviteCode: 'ABC234',
    });
    expect(injected.authorize).toHaveBeenCalledWith(AUTH);
    expect(injected.create).toHaveBeenCalledWith(
      'verified-user',
      'member@example.com',
    );
  });

  it.each(['join', 'switch'] as const)(
    '%s validates and normalizes before the exact mutation',
    async (endpoint) => {
      const injected = dependencies();

      await expect(
        createHouseholdHandlers(injected)[endpoint](
          request({ inviteCode: '  abc234  ' }),
        ),
      ).resolves.toEqual({ householdId: 'household-joined' });
      expect(injected.authorize).toHaveBeenCalledWith(AUTH);
      expect(injected.join).toHaveBeenCalledWith(
        'verified-user',
        'member@example.com',
        'ABC234',
      );
    },
  );

  it.each([
    {},
    { inviteCode: 'AB-C23' },
    { inviteCode: 'ABC234', email: 'spoof@example.com' },
    { inviteCode: 123456 },
  ])('rejects malformed invite input before authorization: %j', async (data) => {
    const injected = dependencies();

    await expect(
      createHouseholdHandlers(injected).join(request(data)),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(injected.authorize).not.toHaveBeenCalled();
    expect(injected.join).not.toHaveBeenCalled();
  });

  it('maps a missing or ambiguous exact invite to a bounded not-found error', async () => {
    const injected = dependencies({ join: vi.fn(async () => null) });

    await expect(
      createHouseholdHandlers(injected).join(request({ inviteCode: 'ABC234' })),
    ).rejects.toMatchObject({
      code: 'not-found',
      message: 'Invalid invite code.',
    });
  });

  it('exposes only create, join, and switch operations', () => {
    const handlers = createHouseholdHandlers(dependencies());

    expect(Object.keys(handlers).sort()).toEqual(['create', 'join', 'switch']);
    expect(handlers).not.toHaveProperty('list');
    expect(handlers).not.toHaveProperty('updateMembers');
  });
});

function mutationStore(overrides: Partial<HouseholdMutationStore> = {}): HouseholdMutationStore {
  return {
    getExisting: vi.fn(async () => null),
    findExactInvite: vi.fn(async () => []),
    createAtomic: vi.fn(async (_uid, _email, inviteCode) => ({
      status: 'created' as const,
      householdId: 'household-created',
      inviteCode,
    })),
    joinAtomic: vi.fn(async () => true),
    ...overrides,
  };
}

describe('createHouseholdMutations', () => {
  it('retries legacy and concurrent invite collisions before creating atomically', async () => {
    const codes = ['ABC234', 'DEF567', 'GHJ678'];
    const store = mutationStore({
      findExactInvite: vi.fn()
        .mockResolvedValueOnce(['legacy-household'])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]),
      createAtomic: vi.fn()
        .mockResolvedValueOnce({ status: 'collision' })
        .mockResolvedValueOnce({
          status: 'created',
          householdId: 'new-household',
          inviteCode: 'GHJ678',
        }),
    });
    const generate = vi.fn(() => codes.shift() ?? 'MNP789');

    await expect(
      createHouseholdMutations(store, generate, 5).create(
        'user-1',
        'member@example.com',
      ),
    ).resolves.toEqual({
      householdId: 'new-household',
      inviteCode: 'GHJ678',
    });
    expect(store.createAtomic).toHaveBeenNthCalledWith(
      1,
      'user-1',
      'member@example.com',
      'DEF567',
    );
    expect(store.createAtomic).toHaveBeenNthCalledWith(
      2,
      'user-1',
      'member@example.com',
      'GHJ678',
    );
  });

  it('returns an existing mutually consistent household idempotently', async () => {
    const store = mutationStore({
      getExisting: vi.fn(async () => ({
        householdId: 'existing-household',
        inviteCode: 'MNP789',
      })),
    });
    const generate = vi.fn(() => 'ABC234');

    await expect(
      createHouseholdMutations(store, generate).create(
        'user-1',
        'member@example.com',
      ),
    ).resolves.toEqual({
      householdId: 'existing-household',
      inviteCode: 'MNP789',
    });
    expect(generate).not.toHaveBeenCalled();
    expect(store.findExactInvite).not.toHaveBeenCalled();
    expect(store.createAtomic).not.toHaveBeenCalled();
  });

  it('fails closed after bounded invite collision attempts', async () => {
    const store = mutationStore({
      findExactInvite: vi.fn(async () => ['already-used']),
    });

    await expect(
      createHouseholdMutations(store, () => 'ABC234', 3).create(
        'user-1',
        'member@example.com',
      ),
    ).rejects.toMatchObject({
      code: 'internal',
      message: 'Household creation failed.',
    });
    expect(store.findExactInvite).toHaveBeenCalledTimes(3);
    expect(store.createAtomic).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', []],
    ['ambiguous', ['household-1', 'household-2']],
  ])('rejects a %s invite without an atomic membership write', async (_name, matches) => {
    const store = mutationStore({
      findExactInvite: vi.fn(async () => matches),
    });

    await expect(
      createHouseholdMutations(store, () => 'ABC234').join(
        'user-1',
        'member@example.com',
        'ABC234',
      ),
    ).resolves.toBeNull();
    expect(store.joinAtomic).not.toHaveBeenCalled();
  });

  it('atomically joins the single exact household and updates the current profile', async () => {
    const store = mutationStore({
      findExactInvite: vi.fn(async () => ['household-1']),
    });

    await expect(
      createHouseholdMutations(store, () => 'ABC234').join(
        'user-1',
        'member@example.com',
        'ABC234',
      ),
    ).resolves.toBe('household-1');
    expect(store.joinAtomic).toHaveBeenCalledWith(
      'user-1',
      'member@example.com',
      'ABC234',
      'household-1',
    );
  });

  it('fails closed when the household changes before the join transaction', async () => {
    const store = mutationStore({
      findExactInvite: vi.fn(async () => ['household-1']),
      joinAtomic: vi.fn(async () => false),
    });

    await expect(
      createHouseholdMutations(store, () => 'ABC234').join(
        'user-1',
        'member@example.com',
        'ABC234',
      ),
    ).resolves.toBeNull();
  });
});

describe('createFirestoreHouseholdStore', () => {
  it('resolves legacy invites by exact equality and detects ambiguity', async () => {
    const inviteGet = vi.fn(async () => ({ exists: false }));
    const queryGet = vi.fn(async () => ({
      docs: [
        { id: 'household-1' },
        { id: 'household-2' },
      ],
    }));
    const limit = vi.fn(() => ({ get: queryGet }));
    const where = vi.fn(() => ({ limit }));
    const db = {
      collection: vi.fn((name: string) => {
        if (name === 'householdInvites') {
          return { doc: vi.fn(() => ({ get: inviteGet })) };
        }
        if (name === 'households') return { where };
        throw new Error(`unexpected collection ${name}`);
      }),
    };

    await expect(
      createFirestoreHouseholdStore(db as never).findExactInvite('ABC234'),
    ).resolves.toEqual(['household-1', 'household-2']);
    expect(where).toHaveBeenCalledWith('inviteCode', '==', 'ABC234');
    expect(limit).toHaveBeenCalledWith(2);
  });

  it('combines the reservation and exact legacy matches to fail closed on ambiguity', async () => {
    const queryGet = vi.fn(async () => ({
      docs: [
        { id: 'household-1' },
        { id: 'legacy-duplicate' },
      ],
    }));
    const limit = vi.fn(() => ({ get: queryGet }));
    const where = vi.fn(() => ({ limit }));
    const db = {
      collection: vi.fn((name: string) => {
        if (name === 'householdInvites') {
          return {
            doc: vi.fn(() => ({
              get: vi.fn(async () => ({
                exists: true,
                get: (field: string) => field === 'householdId' ? 'household-1' : undefined,
              })),
            })),
          };
        }
        if (name === 'households') return { where };
        throw new Error(`unexpected collection ${name}`);
      }),
    };

    await expect(
      createFirestoreHouseholdStore(db as never).findExactInvite('ABC234'),
    ).resolves.toEqual(['household-1', 'legacy-duplicate']);
    expect(where).toHaveBeenCalledWith('inviteCode', '==', 'ABC234');
    expect(limit).toHaveBeenCalledWith(2);
    expect(queryGet).toHaveBeenCalledOnce();
  });

  it('creates the household, invite reservation, and profile in one transaction', async () => {
    const householdRef = { id: 'household-created', kind: 'household' };
    const inviteRef = { kind: 'invite' };
    const userRef = { kind: 'user' };
    const transaction = {
      get: vi.fn(async (ref: unknown) => {
        if (ref === userRef || ref === inviteRef) return { exists: false };
        throw new Error('unexpected transaction read');
      }),
      create: vi.fn(),
    };
    const db = {
      collection: vi.fn((name: string) => {
        if (name === 'households') return { doc: vi.fn(() => householdRef) };
        if (name === 'householdInvites') return { doc: vi.fn(() => inviteRef) };
        if (name === 'users') return { doc: vi.fn(() => userRef) };
        throw new Error(`unexpected collection ${name}`);
      }),
      runTransaction: vi.fn(async (callback: (value: typeof transaction) => unknown) =>
        callback(transaction)),
    };

    await expect(
      createFirestoreHouseholdStore(db as never).createAtomic(
        'user-1',
        'member@example.com',
        'ABC234',
      ),
    ).resolves.toEqual({
      status: 'created',
      householdId: 'household-created',
      inviteCode: 'ABC234',
    });
    expect(db.runTransaction).toHaveBeenCalledOnce();
    expect(transaction.create).toHaveBeenCalledWith(householdRef, {
      members: ['user-1'],
      inviteCode: 'ABC234',
    });
    expect(transaction.create).toHaveBeenCalledWith(inviteRef, {
      householdId: 'household-created',
    });
    expect(transaction.create).toHaveBeenCalledWith(userRef, {
      email: 'member@example.com',
      householdId: 'household-created',
    });
  });

  it('returns an existing household only when profile and membership agree', async () => {
    const existingRef = { id: 'household-existing', kind: 'household' };
    const requestedRef = { id: 'unused-new-household', kind: 'household' };
    const userRef = { kind: 'user' };
    const inviteRef = { kind: 'invite' };
    const transaction = {
      get: vi.fn(async (ref: unknown) => {
        if (ref === userRef) {
          return {
            exists: true,
            get: (field: string) => ({
              householdId: 'household-existing',
              email: 'member@example.com',
            })[field],
          };
        }
        if (ref === existingRef) {
          return {
            exists: true,
            get: (field: string) => ({
              members: ['user-1'],
              inviteCode: 'MNP789',
            })[field],
          };
        }
        if (ref === inviteRef) return { exists: false };
        throw new Error('unexpected transaction read');
      }),
      create: vi.fn(),
    };
    const db = {
      collection: vi.fn((name: string) => {
        if (name === 'households') {
          return {
            doc: vi.fn((id?: string) => id === 'household-existing'
              ? existingRef
              : requestedRef),
          };
        }
        if (name === 'householdInvites') return { doc: vi.fn(() => inviteRef) };
        if (name === 'users') return { doc: vi.fn(() => userRef) };
        throw new Error(`unexpected collection ${name}`);
      }),
      runTransaction: vi.fn(async (callback: (value: typeof transaction) => unknown) =>
        callback(transaction)),
    };

    await expect(
      createFirestoreHouseholdStore(db as never).createAtomic(
        'user-1',
        'member@example.com',
        'ABC234',
      ),
    ).resolves.toEqual({
      status: 'existing',
      householdId: 'household-existing',
      inviteCode: 'MNP789',
    });
    expect(transaction.create).not.toHaveBeenCalled();
  });

  it('atomically adds membership, switches the profile, and reserves a legacy invite', async () => {
    const householdRef = { id: 'household-1', kind: 'household' };
    const inviteRef = { kind: 'invite' };
    const userRef = { kind: 'user' };
    const transaction = {
      get: vi.fn(async (ref: unknown) => {
        if (ref === householdRef) {
          return {
            exists: true,
            get: (field: string) => ({
              inviteCode: 'ABC234',
              members: ['existing-user'],
            })[field],
          };
        }
        if (ref === inviteRef) return { exists: false };
        throw new Error('unexpected transaction read');
      }),
      create: vi.fn(),
      set: vi.fn(),
      update: vi.fn(),
    };
    const db = {
      collection: vi.fn((name: string) => {
        if (name === 'households') return { doc: vi.fn(() => householdRef) };
        if (name === 'householdInvites') return { doc: vi.fn(() => inviteRef) };
        if (name === 'users') return { doc: vi.fn(() => userRef) };
        throw new Error(`unexpected collection ${name}`);
      }),
      runTransaction: vi.fn(async (callback: (value: typeof transaction) => unknown) =>
        callback(transaction)),
    };

    await expect(
      createFirestoreHouseholdStore(db as never).joinAtomic(
        'user-1',
        'member@example.com',
        'ABC234',
        'household-1',
      ),
    ).resolves.toBe(true);
    expect(db.runTransaction).toHaveBeenCalledOnce();
    expect(transaction.update).toHaveBeenCalledWith(householdRef, {
      members: { operation: 'arrayUnion', value: 'user-1' },
    });
    expect(transaction.set).toHaveBeenCalledWith(userRef, {
      email: 'member@example.com',
      householdId: 'household-1',
    }, { merge: true });
    expect(transaction.create).toHaveBeenCalledWith(inviteRef, {
      householdId: 'household-1',
    });
  });
});

// Compile-time contract used by the Firestore adapter and handler dependency.
const _householdMutationContract: HouseholdMutations | undefined = undefined;
void _householdMutationContract;
