import type { DocumentData, Firestore } from 'firebase-admin/firestore';

export type ReferenceKind = 'meal-plan' | 'cookbook';
export type ReferenceProcessOutcome =
  | 'meal-plan-updated'
  | 'cookbook-moved'
  | 'cookbook-merged'
  | 'noop'
  | 'orphan'
  | 'failed-mapping'
  | 'concurrent-change';

export interface ScannedRecipeReference {
  kind: ReferenceKind;
  path: string;
  id: string;
  recipeId: string;
}

export interface ReferenceMigrationStore {
  scan(): Promise<ScannedRecipeReference[]>;
  process(
    reference: ScannedRecipeReference,
    options: { dryRun: boolean },
  ): Promise<ReferenceProcessOutcome>;
  complete(): Promise<void>;
}

export interface ReferenceMigrationSummary {
  status: 'complete' | 'partial' | 'stopped';
  scanned: number;
  mealPlansUpdated: number;
  cookbooksMoved: number;
  cookbookCollisions: number;
  noops: number;
  orphans: number;
  failedMappings: number;
  concurrentChanges: number;
}

type PlannedReferenceMutation =
  | { outcome: 'meal-plan-updated'; canonicalRecipeId: string }
  | { outcome: 'cookbook-moved' | 'cookbook-merged'; canonicalRecipeId: string; destination: DocumentData }
  | { outcome: 'noop' | 'orphan' | 'failed-mapping' | 'concurrent-change' };

interface ReferencePlanInput {
  kind: ReferenceKind;
  scannedRecipeId: string;
  sourceDocumentId: string;
  source: DocumentData;
  mapping?: DocumentData;
  target?: DocumentData;
  currentRecipe?: DocumentData;
  destination?: DocumentData;
}

function timestampMillis(value: unknown): number | undefined {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : undefined;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (value && typeof value === 'object') {
    const timestamp = value as { toMillis?: () => number; seconds?: unknown };
    if (typeof timestamp.toMillis === 'function') {
      const millis = timestamp.toMillis();
      return Number.isFinite(millis) ? millis : undefined;
    }
    if (typeof timestamp.seconds === 'number' && Number.isFinite(timestamp.seconds)) {
      return timestamp.seconds * 1000;
    }
  }
  return undefined;
}

export function mergeCookbookEntries(
  source: DocumentData,
  destination: DocumentData | undefined,
  canonicalRecipeId: string,
): DocumentData {
  const merged: DocumentData = {
    ...source,
    ...destination,
    recipeId: canonicalRecipeId,
    starred: source.starred === true || destination?.starred === true,
  };
  const candidates = [source.addedAt, destination?.addedAt]
    .map((value) => ({ value, millis: timestampMillis(value) }))
    .filter((candidate): candidate is { value: unknown; millis: number } => candidate.millis !== undefined)
    .sort((left, right) => left.millis - right.millis);
  if (candidates.length > 0) merged.addedAt = candidates[0].value;
  else delete merged.addedAt;
  return merged;
}

export function planReferenceMutation(input: ReferencePlanInput): PlannedReferenceMutation {
  if (input.source.recipeId !== input.scannedRecipeId) return { outcome: 'concurrent-change' };
  if (!input.mapping) {
    return input.currentRecipe?.schemaVersion === 2 && input.currentRecipe.id === input.scannedRecipeId
      ? { outcome: 'noop' }
      : { outcome: 'orphan' };
  }
  if (input.mapping.state === 'failed') return { outcome: 'failed-mapping' };
  const canonicalRecipeId = input.mapping.canonicalRecipeId;
  if (input.mapping.schemaVersion !== 1
    || input.mapping.legacyRecipeId !== input.scannedRecipeId
    || !['migrated', 'linked-existing'].includes(input.mapping.state)
    || typeof canonicalRecipeId !== 'string'
    || !canonicalRecipeId
    || input.target?.schemaVersion !== 2
    || input.target.id !== canonicalRecipeId) return { outcome: 'concurrent-change' };

  if (input.kind === 'meal-plan') return { outcome: 'meal-plan-updated', canonicalRecipeId };
  if (input.sourceDocumentId !== input.scannedRecipeId) return { outcome: 'concurrent-change' };
  if (input.sourceDocumentId === canonicalRecipeId) return { outcome: 'noop' };
  return {
    outcome: input.destination ? 'cookbook-merged' : 'cookbook-moved',
    canonicalRecipeId,
    destination: mergeCookbookEntries(input.source, input.destination, canonicalRecipeId),
  };
}

export async function runReferenceMigration(
  store: ReferenceMigrationStore,
  options: { dryRun: boolean; maxReferences?: number },
): Promise<ReferenceMigrationSummary> {
  const summary: ReferenceMigrationSummary = {
    status: 'complete',
    scanned: 0,
    mealPlansUpdated: 0,
    cookbooksMoved: 0,
    cookbookCollisions: 0,
    noops: 0,
    orphans: 0,
    failedMappings: 0,
    concurrentChanges: 0,
  };
  const references = await store.scan();
  const limit = options.maxReferences ?? references.length;
  if (!Number.isInteger(limit) || limit < 0) throw new Error('Invalid maxReferences');
  for (const reference of references.slice(0, limit)) {
    const outcome = await store.process(reference, options);
    summary.scanned += 1;
    if (outcome === 'meal-plan-updated') summary.mealPlansUpdated += 1;
    if (outcome === 'cookbook-moved') summary.cookbooksMoved += 1;
    if (outcome === 'cookbook-merged') summary.cookbookCollisions += 1;
    if (outcome === 'noop') summary.noops += 1;
    if (outcome === 'orphan') summary.orphans += 1;
    if (outcome === 'failed-mapping') summary.failedMappings += 1;
    if (outcome === 'concurrent-change') {
      summary.concurrentChanges += 1;
      summary.status = 'stopped';
      return summary;
    }
  }
  if (limit < references.length) summary.status = 'partial';
  else if (!options.dryRun) await store.complete();
  return summary;
}

export function firestoreReferenceMigrationStore(
  db: Firestore,
  options: { runId: string; now: () => Date },
): ReferenceMigrationStore {
  if (!options.runId) throw new Error('Reference migration runId is required');
  return {
    async scan() {
      const [mealPlans, cookbooks] = await Promise.all([
        db.collectionGroup('mealPlan').get(),
        db.collectionGroup('cookbook').get(),
      ]);
      return [
        ...mealPlans.docs.map((document) => ({ kind: 'meal-plan' as const, document })),
        ...cookbooks.docs.map((document) => ({ kind: 'cookbook' as const, document })),
      ].flatMap(({ kind, document }) => {
        const recipeId = document.get('recipeId');
        return typeof recipeId === 'string' && recipeId
          ? [{ kind, path: document.ref.path, id: document.id, recipeId }]
          : [];
      }).sort((left, right) => left.path.localeCompare(right.path));
    },

    async process(reference, processOptions) {
      return db.runTransaction(async (transaction): Promise<ReferenceProcessOutcome> => {
        const sourceRef = db.doc(reference.path);
        const mappingRef = db.collection('catalogueRecipeMigrations').doc(reference.recipeId);
        const currentRecipeRef = db.collection('recipes').doc(reference.recipeId);
        const [sourceSnapshot, mappingSnapshot, currentRecipeSnapshot] = await transaction.getAll(
          sourceRef, mappingRef, currentRecipeRef,
        );
        if (!sourceSnapshot.exists) return 'concurrent-change';
        const source = sourceSnapshot.data() as DocumentData;
        const mapping = mappingSnapshot.exists ? mappingSnapshot.data() : undefined;
        const canonicalRecipeId = mapping?.canonicalRecipeId;
        let target: DocumentData | undefined;
        let destination: DocumentData | undefined;
        let destinationRef;
        if (typeof canonicalRecipeId === 'string' && canonicalRecipeId) {
          const targetRef = db.collection('recipes').doc(canonicalRecipeId);
          destinationRef = reference.kind === 'cookbook'
            ? sourceRef.parent.doc(canonicalRecipeId)
            : undefined;
          const snapshots = await transaction.getAll(targetRef, ...(destinationRef ? [destinationRef] : []));
          target = snapshots[0].exists ? snapshots[0].data() : undefined;
          destination = snapshots[1]?.exists ? snapshots[1].data() : undefined;
        }
        const plan = planReferenceMutation({
          kind: reference.kind,
          scannedRecipeId: reference.recipeId,
          sourceDocumentId: reference.id,
          source,
          mapping,
          target,
          currentRecipe: currentRecipeSnapshot.exists ? currentRecipeSnapshot.data() : undefined,
          destination,
        });
        if (processOptions.dryRun || !('canonicalRecipeId' in plan)) return plan.outcome;
        if (plan.outcome === 'meal-plan-updated') {
          transaction.update(sourceRef, { recipeId: plan.canonicalRecipeId });
        } else if ((plan.outcome === 'cookbook-moved' || plan.outcome === 'cookbook-merged') && destinationRef) {
          transaction.set(destinationRef, plan.destination);
          transaction.delete(sourceRef);
        }
        return plan.outcome;
      });
    },

    async complete() {
      const checkpointRef = db.collection('catalogueMigrationCheckpoints').doc('phase3');
      await db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(checkpointRef);
        if (!snapshot.exists || !['meal-plans', 'cookbooks', 'complete'].includes(snapshot.get('stage'))) {
          throw new Error('Recipe migration must complete before reference migration');
        }
        if (snapshot.get('stage') === 'complete') return;
        transaction.set(checkpointRef, {
          stage: 'complete',
          completedStages: ['recipes', 'meal-plans', 'cookbooks'],
          mealPlanCursorPath: null,
          cookbookCursorPath: null,
          lastRunId: options.runId,
          updatedAt: options.now().toISOString(),
        }, { merge: true });
      });
    },
  };
}
