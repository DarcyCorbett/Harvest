import { describe, expect, it } from 'vitest';

import { hasDisplayContent, verifySnapshotInventory } from '../src/catalogue/snapshotFirestore.js';
import type { SnapshotInventory } from '../src/catalogue/snapshot.js';

describe('snapshot Firestore verification', () => {
  it('rejects malformed and incomplete stored display content safely', () => {
    expect(hasDisplayContent({})).toBe(false);
    expect(hasDisplayContent({
      content: {
        title: 'Recipe',
        originalServings: 0,
        ingredients: [{ name: 'Ingredient' }],
        instructions: [{ text: 'Cook.' }],
      },
    })).toBe(false);
    expect(hasDisplayContent({
      content: {
        title: 'Recipe',
        originalServings: 4,
        ingredients: [{ name: 'Ingredient' }],
        instructions: [{ text: ' ' }],
      },
    })).toBe(false);
  });

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
