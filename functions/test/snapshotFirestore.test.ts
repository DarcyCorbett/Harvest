import { describe, expect, it } from 'vitest';

import { verifySnapshotInventory } from '../src/catalogue/snapshotFirestore.js';
import type { SnapshotInventory } from '../src/catalogue/snapshot.js';

describe('snapshot Firestore verification', () => {
  it('loads large inventories in bounded batches', async () => {
    const items = Array.from({ length: 501 }, (_, index) => ({
      id: `recipe-${index}`,
      url: `https://source.test/recipe-${index}`,
    }));
    const inventory = {
      schemaVersion: 1,
      snapshotId: 'snapshot',
      createdAt: '2026-08-02T00:00:00.000Z',
      hash: 'inventory-hash',
      total: items.length,
      bySource: {
        source: {
          status: 'complete',
          hash: 'source-hash',
          count: items.length,
          items,
        },
      },
    } satisfies SnapshotInventory;
    const batchSizes: number[] = [];

    const result = await verifySnapshotInventory(inventory, async (ids) => {
      batchSizes.push(ids.length);
      return new Map();
    });

    expect(batchSizes).toEqual([250, 250, 1]);
    expect(result).toMatchObject({
      complete: false,
      totalDiscovered: 501,
      unaccounted: 501,
    });
  });
});
