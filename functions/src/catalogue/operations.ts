import { getFirestore } from 'firebase-admin/firestore';

export interface CatalogueManifestEntry {
  urlHash: string;
  sourceLastModified?: string;
  parserVersion: number;
  lastFetchedAt: string;
  state: 'ready' | 'retryable' | 'invalid' | 'permanent-skip';
  retryCount?: number;
  nextRetryAt?: string;
}

export interface CatalogueManifest {
  sourceKey: string;
  cursor?: string;
  entries: Record<string, CatalogueManifestEntry>;
  updatedAt: string;
}

export function shouldRefreshManifestEntry(
  entry: CatalogueManifestEntry | undefined,
  options: {
    discoveredLastModified?: string;
    parserVersion: number;
    force?: boolean;
    now: Date;
  },
): boolean {
  if (!entry || options.force) return true;
  if (entry.state === 'permanent-skip') return false;
  if (entry.parserVersion !== options.parserVersion) return true;

  if (options.discoveredLastModified) {
    if (!entry.sourceLastModified) return true;
    const discovered = Date.parse(options.discoveredLastModified);
    const known = Date.parse(entry.sourceLastModified);
    if (Number.isFinite(discovered) && Number.isFinite(known)) return discovered > known;
    return options.discoveredLastModified !== entry.sourceLastModified;
  }

  const lastFetched = Date.parse(entry.lastFetchedAt);
  return !Number.isFinite(lastFetched)
    || options.now.getTime() - lastFetched >= 90 * 24 * 60 * 60 * 1_000;
}

export interface LeaseDocuments {
  acquire(ownerId: string, nowMs: number, expiresAtMs: number): Promise<boolean>;
  renew(ownerId: string, nowMs: number, expiresAtMs: number): Promise<boolean>;
  release(ownerId: string): Promise<void>;
}

export function createLeaseManager(
  documents: LeaseDocuments,
  options: { ownerId: string; ttlMs: number },
) {
  if (!options.ownerId || options.ttlMs <= 0) throw new Error('Invalid lease options');
  let renewAfterMs = 0;
  return {
    async acquire(nowMs = Date.now()) {
      const acquired = await documents.acquire(options.ownerId, nowMs, nowMs + options.ttlMs);
      if (acquired) renewAfterMs = nowMs + Math.floor(options.ttlMs / 2);
      return acquired;
    },
    async renew(nowMs = Date.now()) {
      if (nowMs < renewAfterMs) return true;
      const renewed = await documents.renew(options.ownerId, nowMs, nowMs + options.ttlMs);
      if (renewed) renewAfterMs = nowMs + Math.floor(options.ttlMs / 2);
      return renewed;
    },
    release() {
      return documents.release(options.ownerId);
    },
  };
}

export interface BudgetDocuments {
  reserve(
    quotaDate: string,
    requested: number,
    limit: number,
  ): Promise<{ granted: number; used: number }>;
}

export function pacificQuotaDate(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function createBudgetManager(
  documents: BudgetDocuments,
  options: { limit: number; commandCap?: number },
) {
  if (!Number.isInteger(options.limit) || options.limit <= 0) {
    throw new Error('Budget limit must be a positive integer');
  }
  if (options.commandCap !== undefined
    && (!Number.isInteger(options.commandCap) || options.commandCap < 0)) {
    throw new Error('Command cap must be a non-negative integer');
  }
  if (options.commandCap !== undefined && options.commandCap > options.limit) {
    throw new Error('Command cap cannot exceed the configured limit');
  }
  const limit = options.commandCap ?? options.limit;

  return {
    limit,
    async reserve(requested: number, now = new Date()) {
      if (!Number.isInteger(requested) || requested < 0) {
        throw new Error('Requested writes must be a non-negative integer');
      }
      const quotaDate = pacificQuotaDate(now);
      const reservation = await documents.reserve(quotaDate, requested, limit);
      return { quotaDate, ...reservation };
    },
  };
}

export function firestoreCatalogueOpsDocuments(): {
  lease: LeaseDocuments;
  budget: BudgetDocuments;
} {
  const db = getFirestore();
  const leaseReference = db.collection('catalogueOps').doc('lease');

  return {
    lease: {
      acquire(ownerId, nowMs, expiresAtMs) {
        return db.runTransaction(async (transaction) => {
          const snapshot = await transaction.get(leaseReference);
          const currentOwner = snapshot.get('ownerId');
          const currentExpiry = snapshot.get('expiresAtMs');
          if (snapshot.exists
            && currentOwner !== ownerId
            && typeof currentExpiry === 'number'
            && currentExpiry > nowMs) {
            return false;
          }
          transaction.set(leaseReference, { ownerId, expiresAtMs, renewedAtMs: nowMs });
          return true;
        });
      },
      renew(ownerId, nowMs, expiresAtMs) {
        return db.runTransaction(async (transaction) => {
          const snapshot = await transaction.get(leaseReference);
          if (!snapshot.exists
            || snapshot.get('ownerId') !== ownerId
            || typeof snapshot.get('expiresAtMs') !== 'number'
            || snapshot.get('expiresAtMs') <= nowMs) {
            return false;
          }
          transaction.update(leaseReference, { expiresAtMs, renewedAtMs: nowMs });
          return true;
        });
      },
      release(ownerId) {
        return db.runTransaction(async (transaction) => {
          const snapshot = await transaction.get(leaseReference);
          if (snapshot.exists && snapshot.get('ownerId') === ownerId) {
            transaction.delete(leaseReference);
          }
        });
      },
    },
    budget: {
      reserve(quotaDate, requested, limit) {
        const reference = db.collection('catalogueBudgets').doc(quotaDate);
        return db.runTransaction(async (transaction) => {
          const snapshot = await transaction.get(reference);
          const current = snapshot.exists && typeof snapshot.get('used') === 'number'
            ? snapshot.get('used') as number
            : 0;
          const granted = Math.max(0, Math.min(requested, limit - current));
          const used = current + granted;
          transaction.set(reference, {
            quotaDate,
            limit,
            used,
            updatedAtMs: Date.now(),
          }, { merge: true });
          return { granted, used };
        });
      },
    },
  };
}
