import {
  deterministicLegacyRecipeId,
  normalizeLegacySourceUrl,
} from '../../functions/src/shared/recipeIdentity';

type Document = Record<string, unknown>;

export interface TaggedRecipeTransaction {
  getCache(recipeId: string): Promise<Document | null>;
  createCache(recipeId: string, value: Document): void;
  updateIndex(indexId: string, value: Document): void;
}

export interface TaggedRecipeTransactionStore {
  runTransaction<T>(
    work: (transaction: TaggedRecipeTransaction) => Promise<T>,
  ): Promise<T>;
}

interface TaggedRecipePersistenceOptions {
  now: () => unknown;
  indexUpdateFromCache: (cache: Document) => Document;
}

function normalizedDocumentSource(document: Document): string {
  if (typeof document.sourceUrl !== 'string') {
    throw new Error('Cached recipe identity mismatch');
  }
  try {
    return normalizeLegacySourceUrl(document.sourceUrl);
  } catch {
    throw new Error('Cached recipe identity mismatch');
  }
}

function requireMatchingSource(
  cached: Document,
  normalizedSourceUrl: string,
): void {
  if (normalizedDocumentSource(cached) !== normalizedSourceUrl) {
    throw new Error('Cached recipe identity mismatch');
  }
}

export function createTaggedRecipePersistence(
  store: TaggedRecipeTransactionStore,
  options: TaggedRecipePersistenceOptions,
) {
  return {
    async reconcileCached(indexId: string, sourceUrl: string): Promise<boolean> {
      const normalizedSourceUrl = normalizeLegacySourceUrl(sourceUrl);
      const recipeId = deterministicLegacyRecipeId(normalizedSourceUrl);
      return store.runTransaction(async (transaction) => {
        const cached = await transaction.getCache(recipeId);
        if (!cached) return false;
        requireMatchingSource(cached, normalizedSourceUrl);
        transaction.updateIndex(indexId, {
          ...options.indexUpdateFromCache(cached),
          geminiTaggedAt: options.now(),
        });
        return true;
      });
    },

    async persist(
      indexId: string,
      cacheDocument: Document,
      indexUpdate: Document,
    ): Promise<{ recipeId: string; created: boolean; writeCount: 1 | 2 }> {
      const normalizedSourceUrl = normalizedDocumentSource(cacheDocument);
      const recipeId = deterministicLegacyRecipeId(normalizedSourceUrl);
      return store.runTransaction(async (transaction) => {
        const cached = await transaction.getCache(recipeId);
        if (cached) {
          requireMatchingSource(cached, normalizedSourceUrl);
          transaction.updateIndex(indexId, {
            ...options.indexUpdateFromCache(cached),
            geminiTaggedAt: options.now(),
          });
          return { recipeId, created: false, writeCount: 1 };
        }

        transaction.createCache(recipeId, {
          ...cacheDocument,
          sourceUrl: normalizedSourceUrl,
        });
        transaction.updateIndex(indexId, {
          ...indexUpdate,
          geminiTaggedAt: options.now(),
        });
        return { recipeId, created: true, writeCount: 2 };
      });
    },
  };
}
