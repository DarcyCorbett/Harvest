import { describe, expect, it } from 'vitest';

import {
  buildSnapshotInventory,
  inventoryTargets,
  newInventoryTargets,
  nextReconciliation,
  type SnapshotInventory,
} from '../src/catalogue/snapshot.js';
import type { RecipeSourceAdapter } from '../src/catalogue/sourceAdapters.js';

function adapter(sourceKey: string, urls: string[]): RecipeSourceAdapter {
  return {
    sourceKey,
    canonicalize: (url) => url,
    async *discover() {
      for (const url of urls) yield { url };
    },
    async fetch() {
      return { kind: 'permanent', status: 404 };
    },
  };
}

describe('catalogue snapshot inventory', () => {
  it('builds deterministic per-source and all-source hashes with canonical IDs', async () => {
    const options = {
      adapters: [
        adapter('second', ['https://second.test/two', 'https://second.test/one']),
        adapter('first', ['https://first.test/one', 'https://first.test/one']),
      ],
      snapshotId: 'snapshot-1',
      now: () => new Date('2026-07-29T12:00:00.000Z'),
    };
    const first = await buildSnapshotInventory(options);
    const second = await buildSnapshotInventory(options);

    expect(first.hash).toBe(second.hash);
    expect(first.total).toBe(3);
    expect(first.bySource.first.count).toBe(1);
    expect(inventoryTargets(first)).toEqual({
      second: ['https://second.test/two', 'https://second.test/one'],
      first: ['https://first.test/one'],
    });
  });

  it('detects URLs inserted at the beginning of a weekly sitemap', async () => {
    const baseline = await buildSnapshotInventory({
      adapters: [adapter('source', [
        'https://source.test/old-one',
        'https://source.test/old-two',
      ])],
      snapshotId: 'baseline',
      now: () => new Date(),
    });
    const current = await buildSnapshotInventory({
      adapters: [adapter('source', [
        'https://source.test/new',
        'https://source.test/old-one',
        'https://source.test/old-two',
      ])],
      snapshotId: 'weekly',
      now: () => new Date(),
    });

    expect(newInventoryTargets(baseline, current)).toEqual({
      source: ['https://source.test/new'],
    });
  });

  it('freezes only after two consecutive complete inventories have the same hash', async () => {
    const inventory = await buildSnapshotInventory({
      adapters: [adapter('source', ['https://source.test/one'])],
      snapshotId: 'verify',
      now: () => new Date(),
    });
    const first = nextReconciliation({ stableCount: 0 }, inventory);
    const second = nextReconciliation(first, inventory);

    expect(first).toMatchObject({ stableCount: 1, frozen: false });
    expect(second).toMatchObject({ stableCount: 2, frozen: true });
  });

  it('refuses crawl targets from a partially failed inventory', () => {
    const inventory = {
      schemaVersion: 1,
      snapshotId: 'failed',
      createdAt: new Date().toISOString(),
      hash: 'hash',
      total: 0,
      bySource: {
        source: {
          status: 'failed',
          hash: 'hash',
          count: 0,
          items: [],
          reasonCode: 'discovery-failed',
        },
      },
    } satisfies SnapshotInventory;
    expect(() => inventoryTargets(inventory)).toThrow('failed sources');
  });
});
