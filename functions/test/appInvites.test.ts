import { describe, expect, it, vi } from 'vitest';
import type { CallableRequest } from 'firebase-functions/v2/https';
import { authorizeAllowlistedUser } from '../src/authz.js';
import { createAppInviteHandlers, normalizeInviteEmail } from '../src/callables/appInvites.js';

type Auth = CallableRequest<unknown>['auth'];
const auth = (emailVerified = true): Auth => ({ uid: 'admin', token: { email: 'owner@example.com', email_verified: emailVerified } }) as Auth;
function setup(admin = true, allowed = true) {
  const store = {
    isAdmin: vi.fn().mockResolvedValue(admin),
    grant: vi.fn().mockResolvedValue({ alreadyAllowed: false, downloadUrl: 'https://example.com/app.apk' }),
  };
  const handlers = createAppInviteHandlers(store, value => authorizeAllowlistedUser(value, {
    isAllowlisted: async () => allowed, getMembers: async () => [],
  }));
  return { store, handlers };
}
describe('app invite authorization', () => {
  it.each([undefined, auth(false)])('rejects unauthenticated or unverified accounts', async value => {
    const { handlers, store } = setup();
    await expect(handlers.invite({ auth: value, data: { email: 'guest@example.com' } })).rejects.toThrow();
    expect(store.grant).not.toHaveBeenCalled();
  });
  it.each([[false, true], [true, false]])('rejects non-admin and removed accounts', async (admin, allowed) => {
    const { handlers, store } = setup(admin, allowed);
    await expect(handlers.invite({ auth: auth(), data: { email: 'guest@example.com' } })).rejects.toThrow();
    expect(store.grant).not.toHaveBeenCalled();
  });
  it('returns server permissions without granting access', async () => {
    const { handlers, store } = setup(false);
    await expect(handlers.permissions({ auth: auth() })).resolves.toEqual({ canInvite: false });
    expect(store.grant).not.toHaveBeenCalled();
  });
  it('normalizes the recipient and returns a shareable download after granting', async () => {
    const { handlers, store } = setup();
    const result = await handlers.invite({ auth: auth(), data: { email: ' Guest@Example.com ' } });
    expect(store.grant).toHaveBeenCalledWith('admin', 'guest@example.com');
    expect(result).toEqual({ email: 'guest@example.com', alreadyAllowed: false, downloadUrl: 'https://example.com/app.apk' });
  });
  it('handles already-approved recipients', async () => {
    const { handlers, store } = setup();
    store.grant.mockResolvedValue({ alreadyAllowed: true, downloadUrl: 'https://example.com/app.apk' });
    await expect(handlers.invite({ auth: auth(), data: { email: 'guest@example.com' } })).resolves.toMatchObject({ alreadyAllowed: true });
  });
  it.each([null, [], {}, { email: 'a@example.com', admin: true }, { email: '../bad@example.com' }])('rejects invalid payload %j', async data => {
    const { handlers, store } = setup();
    await expect(handlers.invite({ auth: auth(), data })).rejects.toThrow();
    expect(store.grant).not.toHaveBeenCalled();
  });
  it.each(['', 'x', 'a@b', 'a b@example.com', 'a/b@example.com', 'x'.repeat(250) + '@example.com'])('rejects invalid email %s', email => {
    expect(() => normalizeInviteEmail(email)).toThrow();
  });
});
