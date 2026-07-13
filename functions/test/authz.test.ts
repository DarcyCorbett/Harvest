import type { CallableRequest } from 'firebase-functions/v2/https';
import { describe, expect, it, vi } from 'vitest';

import {
  authorizeHouseholdMember,
  type AuthzLookups,
} from '../src/authz.js';

type AuthData = CallableRequest<unknown>['auth'];

function auth(uid: string, email: unknown): AuthData {
  return { uid, token: { email } } as unknown as AuthData;
}

function lookups(overrides: Partial<AuthzLookups> = {}): AuthzLookups {
  return {
    isAllowlisted: vi.fn().mockResolvedValue(true),
    getMembers: vi.fn().mockResolvedValue(['user-1']),
    ...overrides,
  };
}

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
