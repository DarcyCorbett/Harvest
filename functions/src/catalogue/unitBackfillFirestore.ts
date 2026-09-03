import { FieldPath, getFirestore, type Firestore } from 'firebase-admin/firestore';

import { catalogueContentHash } from './contentFingerprint.js';
import type { CompleteCanonicalRecipeV2 } from './domain.js';
import type { UnitBackfillStore } from './unitBackfill.js';

function completeRecipe(documentId: string, value: unknown): CompleteCanonicalRecipeV2 | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const recipe = value as Partial<CompleteCanonicalRecipeV2>;
  if (recipe.schemaVersion !== 2 || (recipe.status !== 'ready' && recipe.status !== 'review')
    || !recipe.content || !recipe.classification || !recipe.search || !recipe.effective) {
    return undefined;
  }
  return { ...recipe, id: documentId } as CompleteCanonicalRecipeV2;
}

export function firestoreUnitBackfillStore(
  db: Firestore = getFirestore(),
): UnitBackfillStore {
  return {
    async loadCursor(runId) {
      const snapshot = await db.collection('catalogueUnitBackfillRuns').doc(runId).get();
      const cursor = snapshot.get('cursor');
      return typeof cursor === 'string' && cursor ? cursor : undefined;
    },
    async scan(afterId, limit) {
      let query = db.collection('recipes')
        .where('schemaVersion', '==', 2)
        .orderBy(FieldPath.documentId())
        .limit(limit);
      if (afterId) query = query.startAfter(afterId);
      const snapshot = await query.get();
      return {
        recipes: snapshot.docs.flatMap((document) => {
          const recipe = completeRecipe(document.id, document.data());
          return recipe ? [recipe] : [];
        }),
        ...(snapshot.docs.at(-1) ? { nextCursor: snapshot.docs.at(-1)!.id } : {}),
        exhausted: snapshot.size < limit,
      };
    },
    async write(runId, expectedContentHash, recipe) {
      const recipeReference = db.collection('recipes').doc(recipe.id);
      const backupReference = db.collection('catalogueUnitBackfillRuns').doc(runId)
        .collection('backups').doc(recipe.id);
      return db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(recipeReference);
        const backup = await transaction.get(backupReference);
        const current = completeRecipe(recipe.id, snapshot.data());
        if (!snapshot.exists || !current) return 'concurrent' as const;
        if (catalogueContentHash(current.content) !== expectedContentHash) {
          return 'concurrent' as const;
        }
        if (JSON.stringify(current) === JSON.stringify(recipe)) return 'already-current' as const;
        if (!backup.exists) transaction.create(backupReference, snapshot.data()!);
        transaction.set(recipeReference, recipe);
        return 'written' as const;
      });
    },
    async saveCursor(runId, cursor) {
      await db.collection('catalogueUnitBackfillRuns').doc(runId).set({
        schemaVersion: 1,
        mode: 'unit-backfill',
        cursor: cursor ?? null,
        updatedAt: new Date().toISOString(),
      }, { merge: true });
    },
    async summarize(runId, summary) {
      await db.collection('catalogueUnitBackfillRuns').doc(runId).set({
        schemaVersion: 1,
        ...summary,
        updatedAt: new Date().toISOString(),
      }, { merge: true });
    },
  };
}
