import { logger } from 'firebase-functions';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const firestore = vi.hoisted(() => {
  const docRef = {};
  const set = vi.fn();
  const get = vi.fn();
  const collection = vi.fn(() => ({ doc: vi.fn(() => docRef) }));
  const runTransaction = vi.fn(async (callback: (transaction: unknown) => unknown) =>
    callback({ get, set }),
  );
  const getFirestore = vi.fn(() => ({ collection, runTransaction }));
  const serverTimestamp = vi.fn(() => 'server-timestamp');
  return { collection, docRef, get, getFirestore, runTransaction, serverTimestamp, set };
});

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: firestore.serverTimestamp },
  getFirestore: firestore.getFirestore,
}));

import type { AiEndpoint } from '../src/ai/contracts.js';
import {
  firestoreQuotaStore,
  quotaDocumentId,
  reserveQuota,
  type QuotaStore,
} from '../src/quota.js';

class MemoryQuotaStore implements QuotaStore {
  readonly counters = new Map<string, number>();

  async incrementIfAllowed(id: string, units: number, limit: number) {
    const next = (this.counters.get(id) ?? 0) + units;
    if (next > limit) return null;
    this.counters.set(id, next);
    return next;
  }
}

const NOW = new Date('2026-07-13T23:59:00Z');

beforeEach(() => {
  vi.spyOn(logger, 'info').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  firestore.collection.mockClear();
  firestore.get.mockReset();
  firestore.getFirestore.mockClear();
  firestore.runTransaction.mockClear();
  firestore.serverTimestamp.mockClear();
  firestore.set.mockReset();
});

describe('quotaDocumentId', () => {
  it('uses the UTC date, uid, and endpoint', () => {
    expect(quotaDocumentId('u1', 'tagRecipes', NOW)).toBe(
      '2026-07-13_u1_tagRecipes',
    );
  });

  it('isolates counters by uid, endpoint, and UTC date', () => {
    const ids = [
      quotaDocumentId('u1', 'tagRecipes', NOW),
      quotaDocumentId('u2', 'tagRecipes', NOW),
      quotaDocumentId('u1', 'reminderFlags', NOW),
      quotaDocumentId('u1', 'tagRecipes', new Date('2026-07-14T00:00:00Z')),
    ];

    expect(new Set(ids).size).toBe(ids.length);
    expect(
      quotaDocumentId(
        'u1',
        'tagRecipes',
        new Date('2026-07-14T01:00:00+03:00'),
      ),
    ).toBe('2026-07-13_u1_tagRecipes');
  });
});

describe('reserveQuota', () => {
  it.each<[AiEndpoint, number]>([
    ['tagRecipes', 100],
    ['reminderFlags', 100],
    ['shoppingGroups', 40],
    ['substitutions', 80],
  ])('%s accepts exactly %i units and rejects the next unit', async (endpoint, limit) => {
    const store = new MemoryQuotaStore();

    await expect(reserveQuota(store, 'u1', endpoint, limit, NOW)).resolves.toBe(limit);
    await expect(reserveQuota(store, 'u1', endpoint, 1, NOW)).rejects.toMatchObject({
      code: 'resource-exhausted',
    });
    expect(store.counters.get(quotaDocumentId('u1', endpoint, NOW))).toBe(limit);
  });

  it('does not mutate the counter when a request would exceed the limit', async () => {
    const store = new MemoryQuotaStore();
    const id = quotaDocumentId('u1', 'shoppingGroups', NOW);

    await reserveQuota(store, 'u1', 'shoppingGroups', 39, NOW);
    await expect(
      reserveQuota(store, 'u1', 'shoppingGroups', 2, NOW),
    ).rejects.toMatchObject({ code: 'resource-exhausted' });
    expect(store.counters.get(id)).toBe(39);
  });

  it('logs only bounded quota metadata for reserved and rejected requests', async () => {
    const store = new MemoryQuotaStore();
    const logSpy = vi.mocked(logger.info);

    await reserveQuota(store, 'u1', 'shoppingGroups', 39, NOW);
    await expect(
      reserveQuota(store, 'u1', 'shoppingGroups', 2, NOW),
    ).rejects.toMatchObject({ code: 'resource-exhausted' });

    expect(logSpy).toHaveBeenNthCalledWith(1, 'ai_quota', {
      uid: 'u1',
      endpoint: 'shoppingGroups',
      units: 39,
      outcome: 'reserved',
    });
    expect(logSpy).toHaveBeenNthCalledWith(2, 'ai_quota', {
      uid: 'u1',
      endpoint: 'shoppingGroups',
      units: 2,
      outcome: 'rejected',
    });
    for (const [, metadata] of logSpy.mock.calls) {
      expect(Object.keys(metadata as object).sort()).toEqual([
        'endpoint',
        'outcome',
        'uid',
        'units',
      ]);
      expect(['reserved', 'rejected']).toContain(
        (metadata as { outcome: unknown }).outcome,
      );
    }
  });

  it.each([0, -1, 1.5, Number.NaN, Infinity, -Infinity])(
    'rejects invalid units %s before reaching the store',
    async (units) => {
      const store: QuotaStore = {
        incrementIfAllowed: vi.fn(),
      };

      await expect(
        reserveQuota(store, 'u1', 'tagRecipes', units, NOW),
      ).rejects.toMatchObject({ code: 'invalid-argument' });
      expect(store.incrementIfAllowed).not.toHaveBeenCalled();
    },
  );
});

describe('firestoreQuotaStore', () => {
  it.each([Number.NaN, Infinity, -1, '39', null, undefined])(
    'fails closed for a malformed stored counter (%s)',
    async (storedUnits) => {
      firestore.get.mockResolvedValue({
        exists: true,
        get: () => storedUnits,
      });
      const store = firestoreQuotaStore();

      await expect(
        store.incrementIfAllowed('2026-07-13_u1_tagRecipes', 1, 100),
      ).rejects.toMatchObject({
        code: 'internal',
        message: 'Quota storage unavailable.',
      });
      expect(firestore.set).not.toHaveBeenCalled();
    },
  );
});
