import { createHash } from 'node:crypto';

import { getStorage } from 'firebase-admin/storage';

import { canonicalRecipeId } from './domain.js';
import type { RecipeSourceAdapter } from './sourceAdapters.js';

export interface SnapshotInventoryItem {
  id: string;
  url: string;
  lastModified?: string;
}

export interface SnapshotSourceInventory {
  status: 'complete' | 'failed';
  hash: string;
  count: number;
  items: SnapshotInventoryItem[];
  reasonCode?: string;
}

export interface SnapshotInventory {
  schemaVersion: 1;
  snapshotId: string;
  createdAt: string;
  hash: string;
  total: number;
  bySource: Record<string, SnapshotSourceInventory>;
}

export interface SnapshotInventoryStore {
  saveImmutable(inventory: SnapshotInventory): Promise<void>;
  setLatest(snapshotId: string): Promise<void>;
  load(snapshotId: string): Promise<SnapshotInventory>;
  loadLatest(): Promise<SnapshotInventory>;
  loadReconciliation(): Promise<{
    lastHash?: string;
    stableCount: number;
    snapshotId?: string;
    frozen?: boolean;
  }>;
  saveReconciliation(value: {
    lastHash: string;
    stableCount: number;
    snapshotId: string;
    frozen: boolean;
    updatedAt: string;
  }): Promise<void>;
}

function hashLines(values: readonly string[]): string {
  const hash = createHash('sha256');
  for (const value of values) hash.update(value).update('\n');
  return hash.digest('hex');
}

function boundedReason(error: unknown): string {
  const message = error instanceof Error ? error.message : 'unknown-error';
  return message.toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 64)
    || 'unknown-error';
}

export async function buildSnapshotInventory(options: {
  adapters: RecipeSourceAdapter[];
  snapshotId: string;
  now: () => Date;
}): Promise<SnapshotInventory> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(options.snapshotId)) {
    throw new Error('Invalid snapshot ID');
  }
  const bySource: Record<string, SnapshotSourceInventory> = {};
  for (const adapter of options.adapters) {
    const unique = new Map<string, SnapshotInventoryItem>();
    try {
      // Snapshot discovery always starts at the beginning. Durable crawl cursors
      // belong to the frozen inventory consumer, never to sitemap discovery.
      for await (const discovered of adapter.discover()) {
        const id = canonicalRecipeId(discovered.url);
        if (!unique.has(id)) {
          unique.set(id, {
            id,
            url: discovered.url,
            ...(discovered.lastModified
              ? { lastModified: discovered.lastModified }
              : {}),
          });
        }
      }
      const items = [...unique.values()].sort((left, right) =>
        left.id.localeCompare(right.id));
      bySource[adapter.sourceKey] = {
        status: 'complete',
        count: items.length,
        hash: hashLines(items.map(({ id }) => id)),
        items,
      };
    } catch (error) {
      const items = [...unique.values()].sort((left, right) =>
        left.id.localeCompare(right.id));
      bySource[adapter.sourceKey] = {
        status: 'failed',
        count: items.length,
        hash: hashLines(items.map(({ id }) => id)),
        items,
        reasonCode: boundedReason(error),
      };
    }
  }
  const sourceHashes = Object.entries(bySource)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([sourceKey, source]) => `${sourceKey}:${source.status}:${source.hash}`);
  return {
    schemaVersion: 1,
    snapshotId: options.snapshotId,
    createdAt: options.now().toISOString(),
    hash: hashLines(sourceHashes),
    total: Object.values(bySource).reduce((total, source) => total + source.count, 0),
    bySource,
  };
}

export function assertCompleteInventory(inventory: SnapshotInventory): void {
  const failures = Object.entries(inventory.bySource)
    .filter(([, source]) => source.status !== 'complete')
    .map(([sourceKey]) => sourceKey);
  if (failures.length > 0) {
    throw new Error(`Snapshot inventory has failed sources: ${failures.join(', ')}`);
  }
}

export function inventoryTargets(
  inventory: SnapshotInventory,
  sourceKeys?: readonly string[],
): Record<string, string[]> {
  assertCompleteInventory(inventory);
  const selected = sourceKeys ? new Set(sourceKeys) : undefined;
  return Object.fromEntries(Object.entries(inventory.bySource)
    .filter(([sourceKey]) => !selected || selected.has(sourceKey))
    .map(([sourceKey, source]) => [sourceKey, source.items.map(({ url }) => url)]));
}

export function newInventoryTargets(
  baseline: SnapshotInventory,
  current: SnapshotInventory,
): Record<string, string[]> {
  assertCompleteInventory(baseline);
  assertCompleteInventory(current);
  const known = new Set(Object.values(baseline.bySource)
    .flatMap(({ items }) => items.map(({ id }) => id)));
  return Object.fromEntries(Object.entries(current.bySource).map(([sourceKey, source]) => [
    sourceKey,
    source.items.filter(({ id }) => !known.has(id)).map(({ url }) => url),
  ]));
}

export function newAvailableInventoryTargets(
  baseline: SnapshotInventory,
  current: SnapshotInventory,
): Record<string, string[]> {
  assertCompleteInventory(baseline);
  const known = new Set(Object.values(baseline.bySource)
    .flatMap(({ items }) => items.map(({ id }) => id)));
  return Object.fromEntries(Object.entries(current.bySource).map(([sourceKey, source]) => [
    sourceKey,
    source.status === 'complete'
      ? source.items.filter(({ id }) => !known.has(id)).map(({ url }) => url)
      : [],
  ]));
}

export function nextReconciliation(
  prior: { lastHash?: string; stableCount: number },
  inventory: SnapshotInventory,
): { lastHash: string; stableCount: number; frozen: boolean } {
  assertCompleteInventory(inventory);
  const stableCount = prior.lastHash === inventory.hash ? prior.stableCount + 1 : 1;
  return { lastHash: inventory.hash, stableCount, frozen: stableCount >= 2 };
}

export function cloudStorageSnapshotStore(
  bucketName = process.env.CATALOGUE_MANIFEST_BUCKET,
): SnapshotInventoryStore {
  if (!bucketName) throw new Error('Catalogue manifest bucket is required');
  const bucket = getStorage().bucket(bucketName);
  const loadJson = async <T>(path: string): Promise<T> => {
    const [contents] = await bucket.file(path).download();
    return JSON.parse(contents.toString('utf8')) as T;
  };
  return {
    async saveImmutable(inventory) {
      await bucket.file(`snapshots/${inventory.snapshotId}/inventory.json`).save(
        JSON.stringify(inventory),
        {
          contentType: 'application/json',
          resumable: false,
          preconditionOpts: { ifGenerationMatch: 0 },
        },
      );
    },
    async setLatest(snapshotId) {
      await bucket.file('snapshots/latest.json').save(JSON.stringify({ snapshotId }), {
        contentType: 'application/json',
        resumable: false,
      });
    },
    load(snapshotId) {
      return loadJson<SnapshotInventory>(`snapshots/${snapshotId}/inventory.json`);
    },
    async loadLatest() {
      const latest = await loadJson<{ snapshotId: string }>('snapshots/latest.json');
      return this.load(latest.snapshotId);
    },
    async loadReconciliation() {
      try {
        return await loadJson<{
          lastHash?: string;
          stableCount: number;
          snapshotId?: string;
          frozen?: boolean;
        }>(
          'snapshots/reconciliation.json',
        );
      } catch (error) {
        const code = (error as { code?: number }).code;
        if (code === 404) return { stableCount: 0 };
        throw error;
      }
    },
    async saveReconciliation(value) {
      await bucket.file('snapshots/reconciliation.json').save(JSON.stringify(value), {
        contentType: 'application/json',
        resumable: false,
      });
    },
  };
}
