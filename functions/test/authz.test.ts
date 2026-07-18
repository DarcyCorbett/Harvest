import type { CallableRequest } from 'firebase-functions/v2/https';
import { afterEach, describe, expect, it, vi } from 'vitest';

const firestore = vi.hoisted(() => {
  const get = vi.fn();
  const doc = vi.fn(() => ({ get }));
  const collection = vi.fn(() => ({ doc }));
  const getFirestore = vi.fn(() => ({ collection }));
  return { collection, doc, get, getFirestore };
});

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: firestore.getFirestore,
}));

import {
  authorizeAllowlistedUser,
  authorizeCatalogueEditor,
  authorizeHouseholdMember,
  firestoreAuthzLookups,
  type AuthzLookups,
} from '../src/authz.js';

type AuthData = CallableRequest<unknown>['auth'];
const MISSING_EMAIL_VERIFICATION = Symbol('missing-email-verification');

function auth(
  uid: string,
  email: unknown,
  emailVerified: unknown = true,
): AuthData {
  const token: Record<string, unknown> = { email };
  if (emailVerified !== MISSING_EMAIL_VERIFICATION) {
    token.email_verified = emailVerified;
  }
  return { uid, token } as unknown as AuthData;
}

function lookups(overrides: Partial<AuthzLookups> = {}): AuthzLookups {
  return {
    isAllowlisted: vi.fn().mockResolvedValue(true),
    getMembers: vi.fn().mockResolvedValue(['user-1']),
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
  firestore.get.mockReset();
});

describe('firestoreAuthzLookups', () => {
  it.each([true, false])(
    'returns allowlist snapshot existence when it is %s',
    async (exists) => {
      firestore.get.mockResolvedValue({ exists });
      const injected = firestoreAuthzLookups();

      await expect(
        injected.isAllowlisted('member@example.com'),
      ).resolves.toBe(exists);
      expect(firestore.collection).toHaveBeenCalledWith('allowlist');
      expect(firestore.doc).toHaveBeenCalledWith('member@example.com');
      expect(firestore.get).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ['missing household', { exists: false }, null],
    [
      'non-array members',
      { exists: true, get: () => 'user-1' },
      [],
    ],
    [
      'mixed members',
      { exists: true, get: () => ['user-1', 42, null, 'user-2'] },
      ['user-1', 'user-2'],
    ],
  ])('returns safe members for %s', async (_name, snapshot, expected) => {
    firestore.get.mockResolvedValue(snapshot);
    const injected = firestoreAuthzLookups();

    await expect(injected.getMembers('home-1')).resolves.toEqual(expected);
    expect(firestore.collection).toHaveBeenCalledWith('households');
    expect(firestore.doc).toHaveBeenCalledWith('home-1');
    expect(firestore.get).toHaveBeenCalledOnce();
  });
});

describe('authorizeHouseholdMember', () => {
  it('rejects missing authentication before any lookup', async () => {
    const injected = lookups();

    await expect(
      authorizeHouseholdMember(undefined, 'household-1', injected),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(injected.isAllowlisted).not.toHaveBeenCalled();
    expect(injected.getMembers).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined],
    ['blank', '   '],
    ['non-string', 42],
  ])('rejects a %s email before any lookup', async (_name, email) => {
    const injected = lookups();

    await expect(
      authorizeHouseholdMember(auth('user-1', email), 'household-1', injected),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(injected.isAllowlisted).not.toHaveBeenCalled();
    expect(injected.getMembers).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', MISSING_EMAIL_VERIFICATION],
    ['false', false],
    ['non-boolean', 'true'],
  ])(
    'rejects a %s email_verified claim before any lookup',
    async (_name, emailVerified) => {
      const injected = lookups();

      await expect(
        authorizeHouseholdMember(
          auth('user-1', 'member@example.com', emailVerified),
          'household-1',
          injected,
        ),
      ).rejects.toMatchObject({
        code: 'permission-denied',
        message: 'Permission denied.',
      });
      expect(injected.isAllowlisted).not.toHaveBeenCalled();
      expect(injected.getMembers).not.toHaveBeenCalled();
    },
  );

  it('rejects a non-allowlisted normalized email before membership lookup', async () => {
    const injected = lookups({
      isAllowlisted: vi.fn().mockResolvedValue(false),
    });

    await expect(
      authorizeHouseholdMember(
        auth('user-1', '  OUTSIDER@EXAMPLE.COM  '),
        'household-1',
        injected,
      ),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(injected.isAllowlisted).toHaveBeenCalledWith('outsider@example.com');
    expect(injected.getMembers).not.toHaveBeenCalled();
  });

  it('rejects a missing household', async () => {
    const injected = lookups({
      getMembers: vi.fn().mockResolvedValue(null),
    });

    await expect(
      authorizeHouseholdMember(
        auth('user-1', 'member@example.com'),
        'missing-household',
        injected,
      ),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('rejects an authenticated uid absent from household members', async () => {
    const injected = lookups({
      getMembers: vi.fn().mockResolvedValue(['another-user']),
    });

    await expect(
      authorizeHouseholdMember(
        auth('user-1', 'member@example.com'),
        'household-1',
        injected,
      ),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('returns the uid and normalized email after allowlist and membership checks', async () => {
    const injected = lookups();

    await expect(
      authorizeHouseholdMember(
        auth('user-1', '  MEMBER@EXAMPLE.COM  '),
        'household-1',
        injected,
      ),
    ).resolves.toEqual({ uid: 'user-1', email: 'member@example.com' });
    expect(injected.isAllowlisted).toHaveBeenCalledWith('member@example.com');
    expect(injected.getMembers).toHaveBeenCalledWith('household-1');
  });
});

describe('authorizeAllowlistedUser', () => {
  it('rejects an unverified identity before any allowlist or membership lookup', async () => {
    const injected = lookups();

    await expect(
      authorizeAllowlistedUser(
        auth('user-1', 'member@example.com', false),
        injected,
      ),
    ).rejects.toMatchObject({
      code: 'permission-denied',
      message: 'Permission denied.',
    });
    expect(injected.isAllowlisted).not.toHaveBeenCalled();
    expect(injected.getMembers).not.toHaveBeenCalled();
  });

  it('returns the verified allowlisted identity without reading a household', async () => {
    const injected = lookups();

    await expect(
      authorizeAllowlistedUser(
        auth('user-1', '  MEMBER@EXAMPLE.COM  '),
        injected,
      ),
    ).resolves.toEqual({ uid: 'user-1', email: 'member@example.com' });
    expect(injected.isAllowlisted).toHaveBeenCalledWith('member@example.com');
    expect(injected.getMembers).not.toHaveBeenCalled();
  });
});

describe('authorizeCatalogueEditor', () => {
  it('requires both the login allowlist and an enabled server-only editor record', async () => {
    const authorization = lookups();
    const editorLookup = { isEnabledEditor: vi.fn().mockResolvedValue(false) };

    await expect(authorizeCatalogueEditor(
      auth('user-1', 'member@example.com'),
      authorization,
      editorLookup,
    )).rejects.toMatchObject({ code: 'permission-denied' });
    expect(editorLookup.isEnabledEditor).toHaveBeenCalledWith('user-1');

    editorLookup.isEnabledEditor.mockResolvedValue(true);
    await expect(authorizeCatalogueEditor(
      auth('user-1', 'member@example.com'),
      authorization,
      editorLookup,
    )).resolves.toEqual({ uid: 'user-1', email: 'member@example.com' });
  });
});
