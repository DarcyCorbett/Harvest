import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  INVALID_INVITE_CODE,
  VERIFICATION_REQUIRED_CODE,
  createAsyncStoragePendingIntentStore,
  createPasswordOnboarding,
  createHouseholdClient,
  type PasswordOnboardingDependencies,
  type PasswordOnboardingUser,
  type PendingHouseholdIntentStore,
  type KeyValueStorage,
  type HouseholdInvoke,
} from '../services/householdClient';

function invokeReturning(data: unknown): HouseholdInvoke {
  return vi.fn(async () => data);
}

describe('createHouseholdClient', () => {
  it('returns the strict created-household response', async () => {
    const invoke = invokeReturning({
      householdId: 'household-1',
      inviteCode: 'ABC234',
    });

    await expect(createHouseholdClient(invoke).create()).resolves.toEqual({
      householdId: 'household-1',
      inviteCode: 'ABC234',
    });
    expect(invoke).toHaveBeenCalledWith('createHousehold', {});
  });

  it.each([
    null,
    {},
    { householdId: '', inviteCode: 'ABC234' },
    { householdId: 'household-1', inviteCode: 'ABC234', email: 'leak@example.com' },
  ])('rejects a malformed create response: %j', async (response) => {
    await expect(
      createHouseholdClient(invokeReturning(response)).create(),
    ).rejects.toThrow('Invalid response from createHousehold');
  });

  it.each(['join', 'switch'] as const)(
    '%s passes the raw invite to its fixed callable and returns the household id',
    async (endpoint) => {
      const invoke = invokeReturning({ householdId: 'household-2' });

      await expect(
        createHouseholdClient(invoke)[endpoint]('  abc234  '),
      ).resolves.toBe('household-2');
      expect(invoke).toHaveBeenCalledWith(
        endpoint === 'join' ? 'joinHousehold' : 'switchHousehold',
        { inviteCode: '  abc234  ' },
      );
    },
  );

  it.each(['join', 'switch'] as const)(
    '%s maps only Firebase not-found to null',
    async (endpoint) => {
      const notFound = Object.assign(new Error('bounded'), {
        code: 'functions/not-found',
      });
      const invoke: HouseholdInvoke = vi.fn(async () => {
        throw notFound;
      });

      await expect(
        createHouseholdClient(invoke)[endpoint]('ABC234'),
      ).resolves.toBeNull();
    },
  );

  it('preserves non-not-found callable errors', async () => {
    const denied = Object.assign(new Error('denied'), {
      code: 'functions/permission-denied',
    });
    const invoke: HouseholdInvoke = vi.fn(async () => {
      throw denied;
    });

    await expect(
      createHouseholdClient(invoke).join('ABC234'),
    ).rejects.toBe(denied);
  });

  it('rejects unknown fields in join and switch responses', async () => {
    const client = createHouseholdClient(invokeReturning({
      householdId: 'household-2',
      inviteCode: 'unexpected',
    }));

    await expect(client.join('ABC234')).rejects.toThrow(
      'Invalid response from joinHousehold',
    );
  });
});

function onboardingUser(overrides: Partial<PasswordOnboardingUser> = {}): PasswordOnboardingUser {
  return {
    uid: 'new-user',
    email: 'member@example.com',
    emailVerified: false,
    reload: vi.fn(async () => undefined),
    getIdToken: vi.fn(async () => 'refreshed-token'),
    delete: vi.fn(async () => undefined),
    ...overrides,
  };
}

function pendingStore(
  initial: Awaited<ReturnType<PendingHouseholdIntentStore['load']>> = null,
): PendingHouseholdIntentStore {
  let value = initial;
  return {
    load: vi.fn(async () => value),
    save: vi.fn(async (next) => {
      value = next;
    }),
    clear: vi.fn(async () => {
      value = null;
    }),
  };
}

function onboardingDependencies(
  overrides: Partial<PasswordOnboardingDependencies> = {},
): PasswordOnboardingDependencies {
  const user = onboardingUser();
  return {
    isEmailAllowed: vi.fn(async () => true),
    createUser: vi.fn(async () => user),
    signIn: vi.fn(async () => user),
    sendVerification: vi.fn(async () => undefined),
    signOut: vi.fn(async () => undefined),
    pendingIntents: pendingStore(),
    households: {
      create: vi.fn(async () => ({
        householdId: 'household-created',
        inviteCode: 'ABC234',
      })),
      join: vi.fn(async () => 'household-joined'),
      switch: vi.fn(async () => 'household-switched'),
    },
    ...overrides,
  };
}

describe('createPasswordOnboarding registration', () => {
  it('persists a UID-scoped create intent, sends verification, signs out, and stops', async () => {
    const user = onboardingUser();
    const store = pendingStore();
    const dependencies = onboardingDependencies({
      createUser: vi.fn(async () => user),
      pendingIntents: store,
    });

    await expect(
      createPasswordOnboarding(dependencies).register(
        '  MEMBER@EXAMPLE.COM  ',
        'private-password',
      ),
    ).rejects.toMatchObject({ code: VERIFICATION_REQUIRED_CODE });
    expect(dependencies.isEmailAllowed).toHaveBeenCalledWith('member@example.com');
    expect(dependencies.createUser).toHaveBeenCalledWith(
      'member@example.com',
      'private-password',
    );
    expect(store.save).toHaveBeenCalledWith({
      version: 1,
      uid: 'new-user',
      email: 'member@example.com',
      action: 'create',
    });
    expect(dependencies.sendVerification).toHaveBeenCalledWith(user);
    expect(dependencies.signOut).toHaveBeenCalledOnce();
    expect(dependencies.households.create).not.toHaveBeenCalled();
    expect(dependencies.households.join).not.toHaveBeenCalled();
  });

  it('persists only the explicit join intent and never a password or token', async () => {
    const store = pendingStore();
    const dependencies = onboardingDependencies({ pendingIntents: store });

    await expect(
      createPasswordOnboarding(dependencies).register(
        'member@example.com',
        'private-password',
        '  abc234  ',
      ),
    ).rejects.toMatchObject({ code: VERIFICATION_REQUIRED_CODE });
    expect(store.save).toHaveBeenCalledWith({
      version: 1,
      uid: 'new-user',
      email: 'member@example.com',
      action: 'join',
      inviteCode: 'abc234',
    });
    const serialized = JSON.stringify(vi.mocked(store.save).mock.calls);
    expect(serialized).not.toContain('private-password');
    expect(serialized).not.toContain('refreshed-token');
  });

  it('rejects a non-allowlisted email before creating an Auth account', async () => {
    const dependencies = onboardingDependencies({
      isEmailAllowed: vi.fn(async () => false),
    });

    await expect(
      createPasswordOnboarding(dependencies).register(
        'outsider@example.com',
        'private-password',
      ),
    ).rejects.toThrow('Access Denied');
    expect(dependencies.createUser).not.toHaveBeenCalled();
    expect(dependencies.pendingIntents.save).not.toHaveBeenCalled();
  });
});

describe('createPasswordOnboarding login and resume', () => {
  it('refreshes, re-sends verification to an existing unverified user, and signs out', async () => {
    const user = onboardingUser({ emailVerified: false });
    const dependencies = onboardingDependencies({
      signIn: vi.fn(async () => user),
    });

    await expect(
      createPasswordOnboarding(dependencies).login(
        'member@example.com',
        'private-password',
      ),
    ).rejects.toMatchObject({ code: VERIFICATION_REQUIRED_CODE });
    expect(user.reload).toHaveBeenCalledOnce();
    expect(user.getIdToken).toHaveBeenCalledWith(true);
    expect(dependencies.sendVerification).toHaveBeenCalledWith(user);
    expect(dependencies.signOut).toHaveBeenCalledOnce();
    expect(dependencies.pendingIntents.load).not.toHaveBeenCalled();
    expect(dependencies.households.create).not.toHaveBeenCalled();
    expect(dependencies.households.join).not.toHaveBeenCalled();
  });

  it('resumes exactly the verified create intent and clears it only after success', async () => {
    const user = onboardingUser({ emailVerified: true });
    const store = pendingStore({
      version: 1,
      uid: 'new-user',
      email: 'member@example.com',
      action: 'create',
    });
    const dependencies = onboardingDependencies({
      signIn: vi.fn(async () => user),
      pendingIntents: store,
    });

    await expect(
      createPasswordOnboarding(dependencies).login(
        'member@example.com',
        'private-password',
      ),
    ).resolves.toEqual({
      user,
      household: {
        householdId: 'household-created',
        inviteCode: 'ABC234',
      },
    });
    expect(dependencies.households.create).toHaveBeenCalledOnce();
    expect(dependencies.households.join).not.toHaveBeenCalled();
    expect(store.clear).toHaveBeenCalledOnce();
  });

  it('resumes exactly the verified join intent', async () => {
    const user = onboardingUser({ emailVerified: true });
    const store = pendingStore({
      version: 1,
      uid: 'new-user',
      email: 'member@example.com',
      action: 'join',
      inviteCode: 'abc234',
    });
    const dependencies = onboardingDependencies({
      signIn: vi.fn(async () => user),
      pendingIntents: store,
    });

    await expect(
      createPasswordOnboarding(dependencies).login(
        'member@example.com',
        'private-password',
      ),
    ).resolves.toEqual({
      user,
      household: { householdId: 'household-joined' },
    });
    expect(dependencies.households.join).toHaveBeenCalledWith('abc234');
    expect(dependencies.households.create).not.toHaveBeenCalled();
    expect(store.clear).toHaveBeenCalledOnce();
  });

  it('cleans up only the matching newly-created account after an invalid resumed join', async () => {
    const user = onboardingUser({ emailVerified: true });
    const store = pendingStore({
      version: 1,
      uid: 'new-user',
      email: 'member@example.com',
      action: 'join',
      inviteCode: 'bad234',
    });
    const dependencies = onboardingDependencies({
      signIn: vi.fn(async () => user),
      pendingIntents: store,
      households: {
        create: vi.fn(),
        join: vi.fn(async () => null),
        switch: vi.fn(),
      },
    });

    await expect(
      createPasswordOnboarding(dependencies).login(
        'member@example.com',
        'private-password',
      ),
    ).rejects.toMatchObject({ code: INVALID_INVITE_CODE });
    expect(user.delete).toHaveBeenCalledOnce();
    expect(store.clear).toHaveBeenCalledOnce();
  });

  it.each([
    ['different uid', { uid: 'established-user', email: 'member@example.com' }],
    ['different email', { uid: 'new-user', email: 'other@example.com' }],
  ])('never consumes a pending intent for a %s', async (_name, identity) => {
    const user = onboardingUser({
      uid: identity.uid,
      email: identity.email,
      emailVerified: true,
    });
    const store = pendingStore({
      version: 1,
      uid: 'new-user',
      email: 'member@example.com',
      action: 'join',
      inviteCode: 'abc234',
    });
    const dependencies = onboardingDependencies({
      signIn: vi.fn(async () => user),
      pendingIntents: store,
    });

    await expect(
      createPasswordOnboarding(dependencies).login(
        identity.email,
        'private-password',
      ),
    ).resolves.toEqual({ user, household: null });
    expect(dependencies.households.join).not.toHaveBeenCalled();
    expect(dependencies.households.create).not.toHaveBeenCalled();
    expect(user.delete).not.toHaveBeenCalled();
    expect(store.clear).not.toHaveBeenCalled();
  });

  it('retains the create intent when the callable fails so login can retry safely', async () => {
    const user = onboardingUser({ emailVerified: true });
    const store = pendingStore({
      version: 1,
      uid: 'new-user',
      email: 'member@example.com',
      action: 'create',
    });
    const failure = new Error('temporary backend failure');
    const dependencies = onboardingDependencies({
      signIn: vi.fn(async () => user),
      pendingIntents: store,
      households: {
        create: vi.fn(async () => { throw failure; }),
        join: vi.fn(),
        switch: vi.fn(),
      },
    });

    await expect(
      createPasswordOnboarding(dependencies).login(
        'member@example.com',
        'private-password',
      ),
    ).rejects.toBe(failure);
    expect(store.clear).not.toHaveBeenCalled();
    expect(user.delete).not.toHaveBeenCalled();
  });
});

describe('createAsyncStoragePendingIntentStore', () => {
  it('round-trips only the bounded onboarding intent', async () => {
    let stored: string | null = null;
    const storage: KeyValueStorage = {
      getItem: vi.fn(async () => stored),
      setItem: vi.fn(async (_key, value) => { stored = value; }),
      removeItem: vi.fn(async () => { stored = null; }),
    };
    const intents = createAsyncStoragePendingIntentStore(storage);
    const intent = {
      version: 1 as const,
      uid: 'new-user',
      email: 'member@example.com',
      action: 'join' as const,
      inviteCode: 'abc234',
    };

    await intents.save(intent);
    await expect(intents.load()).resolves.toEqual(intent);
    expect(stored).not.toContain('password');
    expect(stored).not.toContain('token');

    await intents.clear();
    await expect(intents.load()).resolves.toBeNull();
  });

  it.each([
    '{not-json',
    JSON.stringify({
      version: 1,
      uid: 'new-user',
      email: 'MEMBER@example.com',
      action: 'create',
    }),
    JSON.stringify({
      version: 1,
      uid: 'new-user',
      email: 'member@example.com',
      action: 'join',
    }),
    JSON.stringify({
      version: 1,
      uid: 'new-user',
      email: 'member@example.com',
      action: 'create',
      password: 'forbidden',
    }),
  ])('fails closed on malformed persisted intent: %s', async (stored) => {
    const storage: KeyValueStorage = {
      getItem: vi.fn(async () => stored),
      setItem: vi.fn(async () => undefined),
      removeItem: vi.fn(async () => undefined),
    };

    await expect(
      createAsyncStoragePendingIntentStore(storage).load(),
    ).resolves.toBeNull();
  });
});

describe('mobile household mutation boundary', () => {
  const read = (relativePath: string) => fs.readFileSync(
    path.join(process.cwd(), relativePath),
    'utf8',
  );

  it('keeps direct Firestore household membership mutations out of the client service', () => {
    const source = read('services/firestoreService.ts');

    expect(source).not.toMatch(/export async function (createHousehold|joinHousehold|switchHousehold|saveUserProfile)/);
    expect(source).not.toContain("where('inviteCode', '== '");
    expect(source).not.toContain('members: [...data.members, userId]');
  });

  it('routes password and Google onboarding plus switching through the protected adapters', () => {
    const source = read('contexts/AuthContext.tsx');

    expect(source).toContain('passwordOnboarding.register(');
    expect(source).toContain('passwordOnboarding.login(');
    expect(source).toContain('householdClient.create()');
    expect(source).toContain('householdClient.switch(');
    expect(source).not.toMatch(/\b(saveUserProfile|firestoreSwitchHousehold|joinHousehold)\b/);
  });

  it('shows the stable verification-required result on registration and login', () => {
    expect(read('app/register.tsx')).toContain('VERIFICATION_REQUIRED_CODE');
    expect(read('app/login.tsx')).toContain('VERIFICATION_REQUIRED_CODE');
  });
});
