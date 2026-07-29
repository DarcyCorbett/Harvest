import { describe, expect, it } from 'vitest';

import {
  createBudgetManager,
  createLeaseManager,
  shouldRefreshManifestEntry,
  type BudgetDocuments,
  type CatalogueManifestEntry,
  type LeaseDocuments,
} from '../src/catalogue/operations.js';

describe('manifest refresh decisions', () => {
  const entry: CatalogueManifestEntry = {
    urlHash: 'hash',
    sourceLastModified: '2026-06-01T00:00:00.000Z',
    parserVersion: 2,
    lastFetchedAt: '2026-06-01T00:00:00.000Z',
    state: 'ready',
  };

  it('skips unchanged known URLs before any recipe read or fetch', () => {
    expect(shouldRefreshManifestEntry(entry, {
      discoveredLastModified: '2026-06-01T00:00:00.000Z',
      parserVersion: 2,
      now: new Date('2026-07-01T00:00:00.000Z'),
    })).toBe(false);
  });

  it('refreshes new, changed, parser-stale, forced, and 90-day fallback URLs', () => {
    expect(shouldRefreshManifestEntry(undefined, { parserVersion: 2, now: new Date() })).toBe(true);
    expect(shouldRefreshManifestEntry(entry, {
      discoveredLastModified: '2026-06-02T00:00:00.000Z', parserVersion: 2, now: new Date(),
    })).toBe(true);
    expect(shouldRefreshManifestEntry(entry, { parserVersion: 3, now: new Date() })).toBe(true);
    expect(shouldRefreshManifestEntry(entry, { parserVersion: 2, force: true, now: new Date() })).toBe(true);
    expect(shouldRefreshManifestEntry({ ...entry, sourceLastModified: undefined }, {
      parserVersion: 2,
      now: new Date('2026-08-31T00:00:00.000Z'),
    })).toBe(true);
  });

  it('never refreshes permanent skips unless explicitly forced', () => {
    const permanent = { ...entry, state: 'permanent-skip' as const };
    expect(shouldRefreshManifestEntry(permanent, { parserVersion: 3, now: new Date() })).toBe(false);
    expect(shouldRefreshManifestEntry(permanent, { parserVersion: 3, force: true, now: new Date() })).toBe(true);
  });

  it('retries invalid entries and retryable entries only when their backoff is due', () => {
    expect(shouldRefreshManifestEntry(
      { ...entry, state: 'invalid' },
      { parserVersion: 2, now: new Date('2026-07-01T00:00:00.000Z') },
    )).toBe(true);
    expect(shouldRefreshManifestEntry(
      { ...entry, state: 'retryable', nextRetryAt: '2026-07-02T00:00:00.000Z' },
      { parserVersion: 2, now: new Date('2026-07-01T00:00:00.000Z') },
    )).toBe(false);
    expect(shouldRefreshManifestEntry(
      { ...entry, state: 'retryable', nextRetryAt: '2026-07-02T00:00:00.000Z' },
      { parserVersion: 2, now: new Date('2026-07-03T00:00:00.000Z') },
    )).toBe(true);
  });
});

describe('renewable ingestion lease', () => {
  function memoryLease(): LeaseDocuments {
    let lease: { ownerId: string; expiresAtMs: number } | null = null;
    return {
      async acquire(ownerId, nowMs, expiresAtMs) {
        if (lease && lease.ownerId !== ownerId && lease.expiresAtMs > nowMs) return false;
        lease = { ownerId, expiresAtMs };
        return true;
      },
      async renew(ownerId, nowMs, expiresAtMs) {
        if (!lease || lease.ownerId !== ownerId || lease.expiresAtMs <= nowMs) return false;
        lease = { ownerId, expiresAtMs };
        return true;
      },
      async release(ownerId) {
        if (lease?.ownerId === ownerId) lease = null;
      },
    };
  }

  it('allows one owner, supports renewal, and releases cleanly', async () => {
    const documents = memoryLease();
    const first = createLeaseManager(documents, { ownerId: 'run-1', ttlMs: 60_000 });
    const second = createLeaseManager(documents, { ownerId: 'run-2', ttlMs: 60_000 });

    await expect(first.acquire(1_000)).resolves.toBe(true);
    await expect(second.acquire(1_000)).resolves.toBe(false);
    await expect(first.renew(2_000)).resolves.toBe(true);
    await first.release();
    await expect(second.acquire(3_000)).resolves.toBe(true);
  });
});

describe('Pacific quota-day budget', () => {
  function memoryBudget(): BudgetDocuments {
    const usage = new Map<string, number>();
    return {
      async reserve(date, requested, limit) {
        const used = usage.get(date) ?? 0;
        const granted = Math.max(0, Math.min(requested, limit - used));
        usage.set(date, used + granted);
        return { granted, used: used + granted };
      },
    };
  }

  it('uses the Firestore Pacific date and never reserves beyond 18,000 writes', async () => {
    const manager = createBudgetManager(memoryBudget(), { limit: 18_000 });
    const now = new Date('2026-07-18T06:30:00.000Z');

    await expect(manager.reserve(17_995, now)).resolves.toEqual({
      quotaDate: '2026-07-17', granted: 17_995, used: 17_995,
    });
    await expect(manager.reserve(10, now)).resolves.toEqual({
      quotaDate: '2026-07-17', granted: 5, used: 18_000,
    });
    await expect(manager.reserve(1, now)).resolves.toEqual({
      quotaDate: '2026-07-17', granted: 0, used: 18_000,
    });
  });

  it('allows command caps to reduce but never increase the configured limit', () => {
    const manager = createBudgetManager(memoryBudget(), { limit: 18_000, commandCap: 25 });
    expect(manager.limit).toBe(25);
    expect(() => createBudgetManager(memoryBudget(), { limit: 18_000, commandCap: 18_001 }))
      .toThrow('cannot exceed');
  });
});
