import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import { HttpsError } from 'firebase-functions/v2/https';

import type { AiEndpoint } from './ai/contracts.js';

const DAILY_LIMITS: Record<AiEndpoint, number> = {
  tagRecipes: 100,
  reminderFlags: 100,
  shoppingGroups: 40,
  substitutions: 80,
};

export interface QuotaStore {
  incrementIfAllowed(id: string, units: number, limit: number): Promise<number | null>;
}

export function firestoreQuotaStore(): QuotaStore {
  const db = getFirestore();

  return {
    async incrementIfAllowed(id, units, limit) {
      const quotaRef = db.collection('aiUsage').doc(id);
      return db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(quotaRef);
        const current: unknown = snapshot.exists ? snapshot.get('units') : 0;
        if (
          typeof current !== 'number'
          || !Number.isFinite(current)
          || !Number.isInteger(current)
          || current < 0
        ) {
          throw new HttpsError('internal', 'Quota storage unavailable.');
        }

        const next = current + units;
        if (!Number.isFinite(next) || next > limit) return null;

        transaction.set(
          quotaRef,
          { units: next, updatedAt: FieldValue.serverTimestamp() },
          { merge: true },
        );
        return next;
      });
    },
  };
}

export function quotaDocumentId(
  uid: string,
  endpoint: AiEndpoint,
  now: Date,
): string {
  return `${now.toISOString().slice(0, 10)}_${uid}_${endpoint}`;
}

export async function reserveQuota(
  store: QuotaStore,
  uid: string,
  endpoint: AiEndpoint,
  units = 1,
  now = new Date(),
): Promise<number> {
  if (!Number.isFinite(units) || !Number.isInteger(units) || units <= 0) {
    throw new HttpsError('invalid-argument', 'Invalid quota units.');
  }
  if (
    !Object.hasOwn(DAILY_LIMITS, endpoint)
    || !Number.isFinite(DAILY_LIMITS[endpoint])
  ) {
    throw new HttpsError('invalid-argument', 'Invalid quota endpoint.');
  }
  const limit = DAILY_LIMITS[endpoint];

  const used = await store.incrementIfAllowed(
    quotaDocumentId(uid, endpoint, now),
    units,
    limit,
  );
  if (used === null) {
    logger.info('ai_quota', { uid, endpoint, units, outcome: 'rejected' });
    throw new HttpsError('resource-exhausted', 'Daily AI quota exceeded.');
  }

  logger.info('ai_quota', { uid, endpoint, units, outcome: 'reserved' });
  return used;
}
