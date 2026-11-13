import { beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => {
  const records = new Map<string, Record<string, unknown>>();
  const create = vi.fn((ref: string, value: Record<string, unknown>) => records.set(ref, value));
  const set = vi.fn((ref: string, value: Record<string, unknown>) => records.set(ref, value));
  const get = vi.fn(async (ref: string) => ({ exists: records.has(ref), get: (field: string) => records.get(ref)?.[field] }));
  const db = {
    collection: (collection: string) => ({ doc: (id: string) => `${collection}/${id}` }),
    runTransaction: async (callback: (transaction: unknown) => unknown) => callback({ get, create, set }),
  };
  return { records, create, set, db };
});
vi.mock('firebase-admin/firestore', () => ({ getFirestore: () => fake.db, FieldValue: { serverTimestamp: () => 'timestamp' } }));
import { firestoreInviteStore } from '../src/callables/appInvites.js';

beforeEach(() => {
  fake.records.clear(); vi.clearAllMocks();
  fake.records.set('appAdmins/admin', { enabled: true, canInvite: true });
  fake.records.set('appDistribution/current', { downloadUrl: 'https://example.com/app.apk' });
});
describe('invite transaction', () => {
  it('creates access once and keeps inviter metadata in the private audit collection', async () => {
    const store = firestoreInviteStore();
    await expect(store.grant('admin', 'guest@example.com')).resolves.toMatchObject({ alreadyAllowed: false });
    await expect(store.grant('admin', 'guest@example.com')).resolves.toMatchObject({ alreadyAllowed: true });
    expect(fake.create).toHaveBeenCalledTimes(1);
    expect(fake.records.get('allowlist/guest@example.com')).toEqual({ enabled: true });
    expect(fake.records.get('appInvitations/guest@example.com')).toMatchObject({ invitedBy: 'admin' });
  });
  it('preserves existing allowlist data', async () => {
    fake.records.set('allowlist/guest@example.com', { legacy: 'keep' });
    await firestoreInviteStore().grant('admin', 'guest@example.com');
    expect(fake.records.get('allowlist/guest@example.com')).toEqual({ legacy: 'keep' });
    expect(fake.create).not.toHaveBeenCalled();
  });
  it.each([{}, { enabled: false, canInvite: true }, { enabled: true, canInvite: false }])('rechecks current role before writing %j', async role => {
    fake.records.set('appAdmins/admin', role);
    await expect(firestoreInviteStore().grant('admin', 'guest@example.com')).rejects.toThrow('Admin invite permission required');
    expect(fake.create).not.toHaveBeenCalled(); expect(fake.set).not.toHaveBeenCalled();
  });
  it.each([undefined, 'http://example.com', 'javascript:alert(1)', 'https://bad url'])('fails without granting access when download config is invalid %s', async downloadUrl => {
    fake.records.set('appDistribution/current', { downloadUrl });
    await expect(firestoreInviteStore().grant('admin', 'guest@example.com')).rejects.toThrow('App download is not configured');
    expect(fake.create).not.toHaveBeenCalled(); expect(fake.set).not.toHaveBeenCalled();
  });
});
