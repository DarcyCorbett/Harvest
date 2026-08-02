import { describe, expect, it } from 'vitest';

import {
  hasDisplayContent,
  snapshotReconciliationTargets,
  verifySnapshotInventory,
} from '../src/catalogue/snapshotFirestore.js';
import type { CanonicalRecipeV2 } from '../src/catalogue/domain.js';
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

  it('targets only records that still require reconciliation', async () => {
    const items = ['missing', 'incomplete', 'retryable', 'terminal', 'displayable']
      .map((id) => ({ id, url: `https://source.test/${id}` }));
    const inventory = {
      schemaVersion: 1,
      snapshotId: 'snapshot',
      createdAt: '2026-08-02T00:00:00.000Z',
      hash: 'inventory-hash',
      total: items.length,
      bySource: {
        source: { status: 'complete', hash: 'source-hash', count: items.length, items },
      },
    } satisfies SnapshotInventory;
    const recipes = new Map<string, CanonicalRecipeV2>([
      ['incomplete', {
        schemaVersion: 2,
        id: 'incomplete',
        status: 'review',
        content: { title: 'Incomplete', originalServings: 0, ingredients: [], instructions: [] },
      } as CanonicalRecipeV2],
      ['retryable', {
        schemaVersion: 2,
        id: 'retryable',
        status: 'retryable',
        reasonCode: 'fetch-retryable',
      } as CanonicalRecipeV2],
      ['terminal', {
        schemaVersion: 2,
        id: 'terminal',
        status: 'invalid',
        reasonCode: 'missing-display-content',
      } as CanonicalRecipeV2],
      ['displayable', {
        schemaVersion: 2,
        id: 'displayable',
        status: 'ready',
        content: {
          title: 'Displayable',
          originalServings: 4,
          ingredients: [{ name: 'Ingredient' }],
          instructions: [{ text: 'Cook.' }],
        },
      } as CanonicalRecipeV2],
    ]);

    const targets = await snapshotReconciliationTargets(inventory, {
      loadRecipes: async () => recipes,
    });

    expect(targets).toEqual({ source: [
      'https://source.test/missing',
      'https://source.test/incomplete',
      'https://source.test/retryable',
    ] });
  });
});
