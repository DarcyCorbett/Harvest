import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  INVALID_INVITE_CODE,
  ONBOARDING_RESUME_CODE,
  VERIFICATION_REQUIRED_CODE,
  clearAuthenticatedFailureState,
  createAsyncStoragePendingIntentStore,
  completeGoogleHouseholdOnboarding,
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
    hasUserProfile: vi.fn(async () => false),
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

  it('deletes the just-created Auth account and signs out when intent persistence fails', async () => {
    const user = onboardingUser();
    const storageFailure = new Error('storage unavailable');
    const store = pendingStore();
    vi.mocked(store.save).mockRejectedValue(storageFailure);
    const dependencies = onboardingDependencies({
      createUser: vi.fn(async () => user),
      pendingIntents: store,
    });

    await expect(
      createPasswordOnboarding(dependencies).register(
        'member@example.com',
        'private-password',
      ),
    ).rejects.toBe(storageFailure);
    expect(user.delete).toHaveBeenCalledOnce();
    expect(dependencies.signOut).toHaveBeenCalledOnce();
    expect(dependencies.sendVerification).not.toHaveBeenCalled();
    expect(dependencies.households.create).not.toHaveBeenCalled();
    expect(dependencies.households.join).not.toHaveBeenCalled();
  });

  it('preserves the onboarding result and releases busy state when sign-out fails', async () => {
    const cleanupFailure = new Error('sign-out unavailable');
    const dependencies = onboardingDependencies({
      signOut: vi.fn(async () => { throw cleanupFailure; }),
    });
    const onboarding = createPasswordOnboarding(dependencies);

    await expect(
      onboarding.register('member@example.com', 'private-password'),
    ).rejects.toMatchObject({ code: VERIFICATION_REQUIRED_CODE });
    expect(onboarding.isBusy()).toBe(false);
    expect(dependencies.signOut).toHaveBeenCalledOnce();
  });

  it('lets a verified profile-less account replace its intent and resume safely', async () => {
    const emailExists = Object.assign(new Error('email exists'), {
      code: 'auth/email-already-in-use',
    });
    const user = onboardingUser({ emailVerified: true });
    const store = pendingStore();
    const dependencies = onboardingDependencies({
      createUser: vi.fn(async () => { throw emailExists; }),
      signIn: vi.fn(async () => user),
      pendingIntents: store,
    });

    await expect(
      createPasswordOnboarding(dependencies).register(
        'member@example.com',
        'private-password',
        'new234',
      ),
    ).rejects.toMatchObject({ code: ONBOARDING_RESUME_CODE });
    expect(dependencies.hasUserProfile).toHaveBeenCalledWith('new-user');
    expect(store.save).toHaveBeenCalledWith({
      version: 1,
      uid: 'new-user',
      email: 'member@example.com',
      action: 'join',
      inviteCode: 'new234',
    });
    expect(dependencies.sendVerification).not.toHaveBeenCalled();
    expect(dependencies.signOut).toHaveBeenCalledOnce();
  });

  it('does not replace onboarding state for an established profile', async () => {
    const emailExists = Object.assign(new Error('email exists'), {
      code: 'auth/email-already-in-use',
    });
    const user = onboardingUser({ emailVerified: true });
    const store = pendingStore();
    const dependencies = onboardingDependencies({
      createUser: vi.fn(async () => { throw emailExists; }),
      signIn: vi.fn(async () => user),
      hasUserProfile: vi.fn(async () => true),
      pendingIntents: store,
    });

    await expect(
      createPasswordOnboarding(dependencies).register(
        'member@example.com',
        'private-password',
        'new234',
      ),
    ).rejects.toBe(emailExists);
    expect(store.save).not.toHaveBeenCalled();
    expect(dependencies.signOut).toHaveBeenCalledOnce();
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

  it('preserves the login result when failure cleanup cannot sign out', async () => {
    const dependencies = onboardingDependencies({
      signOut: vi.fn(async () => { throw new Error('sign-out unavailable'); }),
    });
    const onboarding = createPasswordOnboarding(dependencies);

    await expect(
      onboarding.login('member@example.com', 'private-password'),
    ).rejects.toMatchObject({ code: VERIFICATION_REQUIRED_CODE });
    expect(onboarding.isBusy()).toBe(false);
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

  it('keeps an invalid join recoverable without deleting the Auth account or intent', async () => {
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
    expect(user.delete).not.toHaveBeenCalled();
    expect(store.clear).not.toHaveBeenCalled();
    expect(dependencies.signOut).toHaveBeenCalledOnce();
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
    expect(dependencies.signOut).toHaveBeenCalledOnce();
  });

  it('clears a matching stale intent without mutation or deletion when a profile exists', async () => {
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
      hasUserProfile: vi.fn(async () => true),
      pendingIntents: store,
      households: {
        create: vi.fn(),
        join: vi.fn(),
        switch: vi.fn(),
      },
    });

    await expect(
      createPasswordOnboarding(dependencies).login(
        'member@example.com',
        'private-password',
      ),
    ).resolves.toEqual({ user, household: null });
    expect(dependencies.hasUserProfile).toHaveBeenCalledWith('new-user');
    expect(dependencies.households.join).not.toHaveBeenCalled();
    expect(dependencies.households.create).not.toHaveBeenCalled();
    expect(user.delete).not.toHaveBeenCalled();
    expect(store.clear).toHaveBeenCalledOnce();
  });
});

describe('completeGoogleHouseholdOnboarding', () => {
  function googleDependencies(overrides: Record<string, unknown> = {}) {
    return {
      isEmailAllowed: vi.fn(async () => true),
      hasUserProfile: vi.fn(async () => false),
      households: {
        create: vi.fn(async () => ({
          householdId: 'google-household',
          inviteCode: 'ABC234',
        })),
        join: vi.fn(),
        switch: vi.fn(),
      },
      ...overrides,
    };
  }

  it('creates a first Google household through the fixed callable', async () => {
    const user = onboardingUser({ emailVerified: true });
    const dependencies = googleDependencies();

    await expect(
      completeGoogleHouseholdOnboarding(user, dependencies),
    ).resolves.toEqual({
      user,
      household: {
        householdId: 'google-household',
        inviteCode: 'ABC234',
      },
    });
    expect(dependencies.households.create).toHaveBeenCalledOnce();
  });

  it('keeps an existing Google profile without creating another household', async () => {
    const user = onboardingUser({ emailVerified: true });
    const dependencies = googleDependencies({
      hasUserProfile: vi.fn(async () => true),
    });

    await expect(
      completeGoogleHouseholdOnboarding(user, dependencies),
    ).resolves.toEqual({ user, household: null });
    expect(dependencies.households.create).not.toHaveBeenCalled();
  });

  it.each([
    ['unverified identity', { emailVerified: false }, {}],
    ['non-allowlisted identity', { emailVerified: true }, {
      isEmailAllowed: vi.fn(async () => false),
    }],
  ])('rejects a %s before it can create a household', async (_name, userOverrides, depOverrides) => {
    const user = onboardingUser(userOverrides);
    const dependencies = googleDependencies(depOverrides);

    await expect(
      completeGoogleHouseholdOnboarding(user, dependencies),
    ).rejects.toThrow('Access Denied');
    expect(dependencies.households.create).not.toHaveBeenCalled();
  });

  it('preserves a first-household creation failure for the context cleanup owner', async () => {
    const user = onboardingUser({ emailVerified: true });
    const failure = new Error('backend unavailable');
    const dependencies = googleDependencies({
      households: {
        create: vi.fn(async () => { throw failure; }),
        join: vi.fn(),
        switch: vi.fn(),
      },
    });

    await expect(
      completeGoogleHouseholdOnboarding(user, dependencies),
    ).rejects.toBe(failure);
  });

  it('joins the invited household instead of creating one for a new Google user', async () => {
    const households = {
      create: vi.fn(),
      join: vi.fn(async () => 'household-9'),
      switch: vi.fn(),
    };
    const user = { uid: 'google-1', email: 'New@Example.com', emailVerified: true } as never;
    const result = await completeGoogleHouseholdOnboarding(user, {
      isEmailAllowed: async () => true,
      hasUserProfile: async () => false,
      households,
    }, ' ABC234 ');
    expect(result.household).toEqual({ householdId: 'household-9' });
    expect(households.join).toHaveBeenCalledWith('ABC234');
    expect(households.create).not.toHaveBeenCalled();
  });

  it('rejects an unknown invite code without creating a household', async () => {
    const households = { create: vi.fn(), join: vi.fn(async () => null), switch: vi.fn() };
    const user = { uid: 'google-1', email: 'new@example.com', emailVerified: true } as never;
    await expect(completeGoogleHouseholdOnboarding(user, {
      isEmailAllowed: async () => true,
      hasUserProfile: async () => false,
      households,
    }, 'ZZZ999')).rejects.toMatchObject({ code: 'household/invalid-invite' });
    expect(households.create).not.toHaveBeenCalled();
  });
});

describe('clearAuthenticatedFailureState', () => {
  it('always clears local auth state when Firebase sign-out rejects', async () => {
    const signOut = vi.fn(async () => { throw new Error('sign-out unavailable'); });
    const clearLocalAuth = vi.fn();

    await expect(
      clearAuthenticatedFailureState(signOut, clearLocalAuth),
    ).resolves.toBeUndefined();
    expect(signOut).toHaveBeenCalledOnce();
    expect(clearLocalAuth).toHaveBeenCalledOnce();
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
    expect(source).toContain('completeGoogleHouseholdOnboarding(');
    expect(source).toContain('clearAuthenticatedFailureState(');
    expect(source).toContain('householdClient.switch(');
    expect(source).not.toMatch(/\b(saveUserProfile|firestoreSwitchHousehold|joinHousehold)\b/);
  });

  it('handles password onboarding results in the password registration handler', () => {
    const source = read('app/register.tsx');
    const passwordHandler = source.slice(
      source.indexOf('const handleRegister'),
      source.indexOf('const handleCopyCode'),
    );
    const googleHandler = source.slice(
      source.indexOf('const handleGoogleSignIn'),
      source.indexOf('const handleRegister'),
    );

    expect(passwordHandler).toContain('VERIFICATION_REQUIRED_CODE');
    expect(passwordHandler).toContain('ONBOARDING_RESUME_CODE');
    expect(googleHandler).not.toContain('VERIFICATION_REQUIRED_CODE');
    expect(googleHandler).not.toContain('ONBOARDING_RESUME_CODE');
    expect(read('app/login.tsx')).toContain('VERIFICATION_REQUIRED_CODE');
  });
});
