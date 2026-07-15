import { describe, expect, it } from 'vitest';

import {
  deterministicLegacyRecipeId,
  normalizeLegacySourceUrl,
} from '../functions/src/shared/recipeIdentity';
import {
  createTaggedRecipePersistence,
  type TaggedRecipeTransaction,
} from '../scripts/lib/taggedRecipePersistence';

type Document = Record<string, unknown>;

function cloneMap(source: Map<string, Document>): Map<string, Document> {
  return new Map(
    [...source].map(([id, value]) => [id, structuredClone(value)]),
  );
}

function createMemoryStore() {
  let cache = new Map<string, Document>();
  let indexes = new Map<string, Document>();
  let failNextCommit = false;
  let committedWrites = 0;

  return {
    store: {
      async runTransaction<T>(
        work: (transaction: TaggedRecipeTransaction) => Promise<T>,
      ): Promise<T> {
        const nextCache = cloneMap(cache);
        const nextIndexes = cloneMap(indexes);
        let pendingWrites = 0;
        const result = await work({
          async getCache(recipeId) {
            const value = nextCache.get(recipeId);
            return value ? structuredClone(value) : null;
          },
          createCache(recipeId, value) {
            if (nextCache.has(recipeId)) throw new Error('already-exists');
            nextCache.set(recipeId, structuredClone(value));
            pendingWrites += 1;
          },
          updateIndex(indexId, value) {
            nextIndexes.set(indexId, {
              ...(nextIndexes.get(indexId) ?? {}),
              ...structuredClone(value),
            });
            pendingWrites += 1;
          },
        });
        if (failNextCommit) {
          failNextCommit = false;
          throw new Error('commit-failed');
        }
        cache = nextCache;
        indexes = nextIndexes;
        committedWrites += pendingWrites;
        return result;
      },
    },
    cache: () => cache,
    indexes: () => indexes,
    writes: () => committedWrites,
    failCommit() {
      failNextCommit = true;
    },
    seedCache(recipeId: string, document: Document) {
      cache.set(recipeId, structuredClone(document));
    },
  };
}

function createPersistence(memory: ReturnType<typeof createMemoryStore>) {
  return createTaggedRecipePersistence(memory.store, {
    now: () => 'tagged-now',
    indexUpdateFromCache: (cache) => ({
      title: cache.title,
      tags: cache.tags,
    }),
  });
}

describe('tagged recipe persistence', () => {
  const sourceUrl = 'https://WWW.RECIPETINEATS.COM:443/soup#instructions';
  const normalizedUrl = 'https://www.recipetineats.com/soup';
  const cacheDocument = {
    sourceUrl,
    title: 'Soup',
    tags: ['Dinner'],
  };
  const indexUpdate = { title: 'Soup', tags: ['Dinner'] };

  it('uses the canonical normalized-source deterministic recipe ID', () => {
    expect(normalizeLegacySourceUrl(sourceUrl)).toBe(normalizedUrl);
    expect(deterministicLegacyRecipeId(normalizedUrl)).toBe(
      'legacy_59d8d7d7961787c41cf9e9459fd379ac875b71a3be2e36a650fae7476527179d',
    );
  });

  it('does not leave a tagged marker when the atomic cache commit fails', async () => {
    const memory = createMemoryStore();
    const persistence = createPersistence(memory);
    memory.failCommit();

    await expect(persistence.persist('index-1', cacheDocument, indexUpdate))
      .rejects.toThrow('commit-failed');

    expect(memory.cache().size).toBe(0);
    expect(memory.indexes().get('index-1')).toBeUndefined();
    expect(memory.writes()).toBe(0);
  });

  it('converges retries on one cache document without overwriting it', async () => {
    const memory = createMemoryStore();
    const persistence = createPersistence(memory);
    memory.failCommit();
    await persistence.persist('index-1', cacheDocument, indexUpdate).catch(() => undefined);

    const created = await persistence.persist('index-1', cacheDocument, indexUpdate);
    const repeated = await persistence.persist(
      'index-1',
      { ...cacheDocument, title: 'Replacement' },
      { ...indexUpdate, title: 'Replacement' },
    );

    expect(created).toMatchObject({ created: true, writeCount: 2 });
    expect(repeated).toMatchObject({ created: false, writeCount: 1 });
    expect(created.recipeId).toBe(repeated.recipeId);
    expect(memory.cache().size).toBe(1);
    expect(memory.cache().get(created.recipeId)?.title).toBe('Soup');
    expect(memory.indexes().get('index-1')).toMatchObject({
      title: 'Soup',
      tags: ['Dinner'],
      geminiTaggedAt: 'tagged-now',
    });
    expect(memory.writes()).toBe(3);
  });

  it('marks an already-cached recipe without another cache write', async () => {
    const memory = createMemoryStore();
    const persistence = createPersistence(memory);
    const recipeId = deterministicLegacyRecipeId(normalizedUrl);
    memory.seedCache(recipeId, { ...cacheDocument, sourceUrl: normalizedUrl });

    await expect(persistence.reconcileCached('index-1', sourceUrl)).resolves.toBe(true);

    expect(memory.cache().size).toBe(1);
    expect(memory.indexes().get('index-1')).toMatchObject({
      title: 'Soup',
      tags: ['Dinner'],
      geminiTaggedAt: 'tagged-now',
    });
    expect(memory.writes()).toBe(1);
  });

  it('leaves an uncached index untouched during the preflight check', async () => {
    const memory = createMemoryStore();
    const persistence = createPersistence(memory);

    await expect(persistence.reconcileCached('index-1', sourceUrl)).resolves.toBe(false);
    expect(memory.indexes().size).toBe(0);
    expect(memory.writes()).toBe(0);
  });

  it('fails closed on a deterministic-ID source mismatch', async () => {
    const memory = createMemoryStore();
    const persistence = createPersistence(memory);
    const recipeId = deterministicLegacyRecipeId(normalizedUrl);
    memory.seedCache(recipeId, {
      ...cacheDocument,
      sourceUrl: 'https://www.recipetineats.com/different',
    });

    await expect(persistence.reconcileCached('index-1', sourceUrl)).rejects.toThrow(
      'Cached recipe identity mismatch',
    );
    expect(memory.indexes().size).toBe(0);
  });
});
