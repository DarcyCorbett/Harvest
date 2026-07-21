import {
  FieldPath,
  type DocumentReference,
  type DocumentSnapshot,
  type FieldPath as FirestoreFieldPath,
  type Firestore,
  type Transaction,
} from 'firebase-admin/firestore';

import {
  LEGACY_MIGRATION_REASON_CODES,
  resolveMigrationTargetDisposition,
  type LegacyMigrationConversionResult,
  type LegacyMigrationReasonCode,
} from './migration.js';
import type {
  CommitRecipeInput,
  CursorAdvanceInput,
  CursorTransactionOutcome,
  MigrationAccounting,
  MigrationCheckpoint,
  MigrationRunStart,
  MigrationRunSummary,
  MigrationTransactionStore,
  RecipeMigrationScanner,
  RecipeTransactionOutcome,
  ReconciledCheckpoint,
  ReconciliationResetOutcome,
  ScannedDocument,
} from './migrationEngine.js';

const CHECKPOINT_PATH = ['catalogueMigrationCheckpoints', 'phase3'] as const;
const TERMINAL_STATES = new Set(['migrated', 'linked-existing', 'failed']);
const GLOBAL_DAILY_WRITE_LIMIT = 18_000;

function serializedUpdateTime(snapshot: DocumentSnapshot): string | null {
  return snapshot.updateTime ? String(snapshot.updateTime.valueOf()) : null;
}

export function firestoreRecipeMigrationScanner(
  db: Firestore,
  documentId: FirestoreFieldPath = FieldPath.documentId(),
): RecipeMigrationScanner {
  return {
    async scanRecipes(afterId, pageSize) {
      let query = db.collection('recipes').orderBy(documentId);
      if (afterId !== null) query = query.startAfter(afterId);
      const snapshot = await query.limit(pageSize).get();
      return snapshot.docs.map((document): ScannedDocument => ({
        id: document.id,
        path: document.ref.path,
        updateTime: serializedUpdateTime(document),
        data: document.data(),
      }));
    },
  };
}

function defaultCheckpoint(): MigrationCheckpoint {
  return {
    schemaVersion: 1,
    epoch: 0,
    stage: 'recipes',
    recipeCursorId: null,
    mealPlanCursorPath: null,
    cookbookCursorPath: null,
    completedStages: [],
    lastRunId: null,
    updatedAt: '1970-01-01T00:00:00.000Z',
  };
}

function checkpointFrom(snapshot: DocumentSnapshot): MigrationCheckpoint {
  return snapshot.exists ? snapshot.data() as MigrationCheckpoint : defaultCheckpoint();
}

function validCheckpoint(snapshot: DocumentSnapshot): MigrationCheckpoint | undefined {
  if (!snapshot.exists) return undefined;
  const value = snapshot.data() as Partial<MigrationCheckpoint> | undefined;
  if (!value
    || value.schemaVersion !== 1
    || !Number.isInteger(value.epoch)
    || (value.epoch as number) < 0
    || !['recipes', 'meal-plans', 'cookbooks', 'complete'].includes(value.stage ?? '')
    || !(value.recipeCursorId === null || typeof value.recipeCursorId === 'string')
    || !(value.mealPlanCursorPath === null || typeof value.mealPlanCursorPath === 'string')
    || !(value.cookbookCursorPath === null || typeof value.cookbookCursorPath === 'string')
    || !Array.isArray(value.completedStages)
    || JSON.stringify(value.completedStages) !== JSON.stringify({
      recipes: [],
      'meal-plans': ['recipes'],
      cookbooks: ['recipes', 'meal-plans'],
      complete: ['recipes', 'meal-plans', 'cookbooks'],
    }[value.stage as MigrationCheckpoint['stage']])
    || !(value.lastRunId === null || typeof value.lastRunId === 'string')
    || typeof value.updatedAt !== 'string') return undefined;
  return value as MigrationCheckpoint;
}

function budgetUsed(snapshot: DocumentSnapshot, quotaDate: string): number | undefined {
  if (!snapshot.exists) return 0;
  const used = snapshot.get('used');
  const limit = snapshot.get('limit');
  return snapshot.get('quotaDate') === quotaDate
    && Number.isInteger(used) && (used as number) >= 0 && (used as number) <= GLOBAL_DAILY_WRITE_LIMIT
    && Number.isInteger(limit) && (limit as number) > 0 && (limit as number) <= GLOBAL_DAILY_WRITE_LIMIT
    ? used as number
    : undefined;
}

function accounting(
  run: DocumentSnapshot,
  budget: DocumentSnapshot,
  quotaDate: string,
): Omit<MigrationAccounting, 'dataWrites'> | undefined {
  const commandUsed = run.exists ? run.get('consumedWrites') : undefined;
  const dailyUsed = budgetUsed(budget, quotaDate);
  return Number.isInteger(commandUsed) && dailyUsed !== undefined
    ? { commandUsed: commandUsed as number, dailyUsed }
    : undefined;
}

function reportedAccounting(run: DocumentSnapshot, budget: DocumentSnapshot): Omit<MigrationAccounting, 'dataWrites'> {
  const commandUsed = run.exists ? run.get('consumedWrites') : undefined;
  const dailyUsed = budget.exists ? budget.get('used') : 0;
  return {
    commandUsed: Number.isInteger(commandUsed) && (commandUsed as number) >= 0 ? commandUsed as number : 0,
    dailyUsed: Number.isInteger(dailyUsed) && (dailyUsed as number) >= 0 ? dailyUsed as number : 0,
  };
}

function hasLease(snapshot: DocumentSnapshot, ownerId: string, runId: string, nowMs: number): boolean {
  return ownerId === runId
    && snapshot.exists
    && snapshot.get('ownerId') === runId
    && typeof snapshot.get('expiresAtMs') === 'number'
    && (snapshot.get('expiresAtMs') as number) > nowMs;
}

function validOperationalRun(
  snapshot: DocumentSnapshot,
  input: { runId: string; epoch: number; commandCap: number; dailyLimit: number; quotaDate: string },
): boolean {
  const consumedWrites = snapshot.exists ? snapshot.get('consumedWrites') : undefined;
  return snapshot.exists
    && snapshot.get('schemaVersion') === 1
    && snapshot.get('runId') === input.runId
    && (snapshot.get('command') === 'migrate-recipes' || snapshot.get('command') === 'reconcile')
    && snapshot.get('epoch') === input.epoch
    && snapshot.get('status') === 'running'
    && snapshot.get('commandCap') === input.commandCap
    && snapshot.get('dailyLimit') === input.dailyLimit
    && snapshot.get('quotaDate') === input.quotaDate
    && Number.isInteger(consumedWrites)
    && (consumedWrites as number) >= 0
    && (consumedWrites as number) <= input.commandCap;
}

function validStartRun(snapshot: DocumentSnapshot, start: MigrationRunStart): boolean {
  return validOperationalRun(snapshot, start)
    && snapshot.get('command') === start.command
    && snapshot.get('startCursor') === start.startCursor
    && snapshot.get('startedAt') === start.startedAt;
}

function isCurrentRecipeCheckpoint(checkpoint: MigrationCheckpoint, epoch: number): boolean {
  return checkpoint.epoch === epoch && checkpoint.stage === 'recipes';
}

function boundedReasons(reasons: readonly string[]): LegacyMigrationReasonCode[] {
  const requested = new Set(reasons);
  return LEGACY_MIGRATION_REASON_CODES.filter((reason) => requested.has(reason));
}

function validReasonCodes(value: unknown): value is LegacyMigrationReasonCode[] {
  return Array.isArray(value)
    && value.every((reason) => typeof reason === 'string')
    && JSON.stringify(value) === JSON.stringify(boundedReasons(value));
}

function validTerminalMapping(
  snapshot: DocumentSnapshot,
  legacyRecipeId: string,
  conversion: LegacyMigrationConversionResult,
  target: DocumentSnapshot | undefined,
): boolean {
  if (!snapshot.exists || snapshot.get('schemaVersion') !== 1
    || snapshot.get('legacyRecipeId') !== legacyRecipeId
    || !TERMINAL_STATES.has(snapshot.get('state') as string)
    || !validReasonCodes(snapshot.get('reasonCodes'))) return false;
  const data = snapshot.data() as Record<string, unknown>;
  const nullableString = (value: unknown) => value === null || (typeof value === 'string' && value.length > 0);
  if (typeof data.firstRunId !== 'string' || !data.firstRunId
    || typeof data.lastEvaluatedRunId !== 'string' || !data.lastEvaluatedRunId
    || typeof data.createdAt !== 'string' || !data.createdAt
    || typeof data.updatedAt !== 'string' || !data.updatedAt) return false;
  if (!nullableString(data.canonicalRecipeId)
    || !nullableString(data.sourceKey)
    || !nullableString(data.contentHash)) return false;
  const sameProposalIdentity = data.canonicalRecipeId === (conversion.mapping.canonicalRecipeId ?? null)
    && data.sourceKey === (conversion.mapping.sourceKey ?? null)
    && data.contentHash === (conversion.mapping.contentHash ?? null);
  const sameProposalReasons = JSON.stringify(data.reasonCodes)
    === JSON.stringify(conversion.mapping.reasonCodes);
  if (conversion.kind === 'failure') {
    return data.state === 'failed'
      && data.targetStatus === null
      && sameProposalIdentity
      && sameProposalReasons;
  }
  const targetDisposition = resolveMigrationTargetDisposition(conversion.recipe, target);
  if (data.state === 'migrated' || data.state === 'linked-existing') {
    return typeof data.canonicalRecipeId === 'string' && data.canonicalRecipeId.length > 0
      && typeof data.sourceKey === 'string' && data.sourceKey.length > 0
      && typeof data.contentHash === 'string' && data.contentHash.length > 0
      && data.targetStatus === conversion.mapping.targetStatus
      && sameProposalIdentity
      && sameProposalReasons
      && targetDisposition === 'linked-existing';
  }
  return data.state === 'failed'
    && data.targetStatus === null
    && sameProposalIdentity
    && JSON.stringify(data.reasonCodes) === JSON.stringify(['canonical-id-collision'])
    && targetDisposition === 'collision';
}

function mappingDocument(
  conversion: LegacyMigrationConversionResult,
  state: 'migrated' | 'linked-existing' | 'failed',
  runId: string,
  reasonCodes: readonly string[] = conversion.mapping.reasonCodes,
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    legacyRecipeId: conversion.mapping.legacyRecipeId,
    canonicalRecipeId: conversion.mapping.canonicalRecipeId ?? null,
    sourceKey: conversion.mapping.sourceKey ?? null,
    targetStatus: state === 'failed' ? null : conversion.mapping.targetStatus ?? null,
    state,
    reasonCodes: boundedReasons(reasonCodes),
    contentHash: conversion.mapping.contentHash ?? null,
    firstRunId: runId,
    lastEvaluatedRunId: runId,
    createdAt: conversion.mapping.createdAt,
    updatedAt: conversion.mapping.updatedAt,
  };
}

function operationalWrites(
  transaction: Transaction,
  refs: { checkpoint: DocumentReference; run: DocumentReference; budget: DocumentReference },
  input: { runId: string; documentId: string; quotaDate: string; commandCap: number; dailyLimit: number },
  checkpoint: MigrationCheckpoint,
  current: Omit<MigrationAccounting, 'dataWrites'>,
  dataWrites: number,
  updatedAt: unknown,
): MigrationAccounting {
  const commandUsed = current.commandUsed + dataWrites;
  const dailyUsed = current.dailyUsed + dataWrites;
  transaction.set(refs.checkpoint, {
    ...checkpoint,
    recipeCursorId: input.documentId,
    lastRunId: input.runId,
    updatedAt,
  });
  transaction.set(refs.run, {
    consumedWrites: commandUsed,
    lastCursor: input.documentId,
    updatedAt,
  }, { merge: true });
  if (dataWrites > 0) {
    transaction.set(refs.budget, {
      quotaDate: input.quotaDate,
      limit: GLOBAL_DAILY_WRITE_LIMIT,
      used: dailyUsed,
      updatedAt,
    }, { merge: true });
  }
  return { dataWrites, commandUsed, dailyUsed };
}

function overBudget(
  current: Omit<MigrationAccounting, 'dataWrites'>,
  dataWrites: number,
  commandCap: number,
  dailyLimit: number,
): boolean {
  return current.commandUsed + dataWrites > commandCap
    || current.dailyUsed + dataWrites > dailyLimit;
}

export function firestoreRecipeMigrationStore(db: Firestore, ownerId: string): MigrationTransactionStore {
  if (!ownerId) throw new Error('Migration ownerId is required');
  const checkpointRef = db.collection(CHECKPOINT_PATH[0]).doc(CHECKPOINT_PATH[1]);
  const leaseRef = db.collection('catalogueOps').doc('lease');

  const commonRefs = (runId: string, quotaDate: string) => ({
    checkpoint: checkpointRef,
    lease: leaseRef,
    run: db.collection('catalogueMigrationRuns').doc(runId),
    budget: db.collection('catalogueBudgets').doc(quotaDate),
  });

  return {
    async loadCheckpoint() {
      return checkpointFrom(await checkpointRef.get());
    },

    async startRun(start: MigrationRunStart) {
      const refs = commonRefs(start.runId, start.quotaDate);
      return db.runTransaction(async (transaction) => {
        const [lease, checkpointSnapshot, existing] = await transaction.getAll(
          refs.lease, refs.checkpoint, refs.run,
        );
        if (!hasLease(lease, ownerId, start.runId, start.transactionTimeMs)) return 'lease-lost';
        const checkpoint = validCheckpoint(checkpointSnapshot);
        if (checkpointSnapshot.exists && (!checkpoint
          || checkpoint.stage !== 'recipes'
          || checkpoint.epoch !== start.epoch
          || checkpoint.recipeCursorId !== start.startCursor)) return 'concurrent-change';
        if (!checkpointSnapshot.exists && (start.epoch !== 0 || start.startCursor !== null)) {
          return 'concurrent-change';
        }
        if (existing.exists) return validStartRun(existing, start) ? 'noop' : 'concurrent-change';
        if (!checkpoint) {
          transaction.set(refs.checkpoint, { ...defaultCheckpoint(), updatedAt: start.startedAt });
        }
        transaction.set(refs.run, {
          schemaVersion: 1,
          runId: start.runId,
          command: start.command,
          epoch: start.epoch,
          startCursor: start.startCursor,
          commandCap: start.commandCap,
          dailyLimit: start.dailyLimit,
          quotaDate: start.quotaDate,
          consumedWrites: 0,
          status: 'running',
          startedAt: start.startedAt,
          updatedAt: start.startedAt,
        });
        return 'started';
      });
    },

    async commitRecipe(input: CommitRecipeInput): Promise<RecipeTransactionOutcome> {
      const refs = commonRefs(input.runId, input.quotaDate);
      const legacyRef = db.doc(input.document.path);
      const mappingRef = db.collection('catalogueRecipeMigrations').doc(input.document.id);
      const targetRef = input.conversion.mapping.canonicalRecipeId
        ? db.collection('recipes').doc(input.conversion.mapping.canonicalRecipeId)
        : undefined;
      return db.runTransaction(async (transaction) => {
        const snapshots = await transaction.getAll(
          refs.lease, refs.checkpoint, refs.run, refs.budget, mappingRef, legacyRef,
          ...(targetRef ? [targetRef] : []),
        );
        const [lease, checkpointSnapshot, run, budget, mapping, legacy, target] = snapshots;
        const current = accounting(run, budget, input.quotaDate);
        const reported = reportedAccounting(run, budget);
        if (!hasLease(lease, ownerId, input.runId, input.transactionTimeMs)) {
          return { status: 'lease-lost', dataWrites: 0, ...reported };
        }
        const checkpoint = validCheckpoint(checkpointSnapshot);
        if (!current
          || !checkpoint
          || !validOperationalRun(run, input)
          || !isCurrentRecipeCheckpoint(checkpoint, input.epoch)
          || !legacy.exists
          || serializedUpdateTime(legacy) !== String(input.scannedUpdateTime)) {
          return { status: 'concurrent-change', dataWrites: 0, ...reported };
        }

        if (mapping.exists && !validTerminalMapping(
          mapping, input.document.id, input.conversion, target,
        )) {
          return { status: 'concurrent-change', dataWrites: 0, ...current };
        }
        if (mapping.exists) {
          const result = operationalWrites(transaction, refs, {
            ...input, documentId: input.document.id,
          }, checkpoint, current, 0, input.conversion.mapping.updatedAt);
          return { status: 'noop', ...result };
        }

        let disposition: 'migrated' | 'linked-existing' | 'failed';
        let dataWrites = 1;
        let mappingData: Record<string, unknown>;
        let createTarget = false;
        if (input.conversion.kind === 'failure') {
          disposition = 'failed';
          mappingData = mappingDocument(input.conversion, disposition, input.runId);
        } else {
          const targetDisposition = resolveMigrationTargetDisposition(input.conversion.recipe, target);
          if (targetDisposition === 'create') {
            disposition = 'migrated';
            dataWrites = 2;
            createTarget = true;
            mappingData = mappingDocument(input.conversion, disposition, input.runId);
          } else if (targetDisposition === 'linked-existing') {
            disposition = 'linked-existing';
            mappingData = mappingDocument(input.conversion, disposition, input.runId);
          } else {
            disposition = 'failed';
            mappingData = mappingDocument(input.conversion, disposition, input.runId, ['canonical-id-collision']);
          }
        }
        if (overBudget(current, dataWrites, input.commandCap, input.dailyLimit)) {
          return { status: 'budget-exhausted', dataWrites: 0, ...current };
        }
        if (createTarget && targetRef && input.conversion.kind === 'success') {
          transaction.set(targetRef, input.conversion.recipe);
        }
        transaction.set(mappingRef, mappingData);
        const result = operationalWrites(transaction, refs, {
          ...input, documentId: input.document.id,
        }, checkpoint, current, dataWrites, input.conversion.mapping.updatedAt);
        return {
          status: 'committed',
          disposition,
          ...(disposition === 'failed' ? {} : { targetStatus: input.conversion.mapping.targetStatus as 'ready' | 'review' }),
          ...result,
        } as RecipeTransactionOutcome;
      });
    },

    async advanceRecipeCursor(input: CursorAdvanceInput): Promise<CursorTransactionOutcome> {
      const refs = commonRefs(input.runId, input.quotaDate);
      const legacyRef = db.doc(input.document.path);
      return db.runTransaction(async (transaction) => {
        const [lease, checkpointSnapshot, run, budget, legacy] = await transaction.getAll(
          refs.lease, refs.checkpoint, refs.run, refs.budget, legacyRef,
        );
        const current = accounting(run, budget, input.quotaDate);
        const reported = reportedAccounting(run, budget);
        if (!hasLease(lease, ownerId, input.runId, input.transactionTimeMs)) {
          return { status: 'lease-lost', dataWrites: 0, ...reported };
        }
        const checkpoint = validCheckpoint(checkpointSnapshot);
        if (!current
          || !checkpoint
          || !validOperationalRun(run, input)
          || !isCurrentRecipeCheckpoint(checkpoint, input.epoch)
          || !legacy.exists
          || serializedUpdateTime(legacy) !== String(input.scannedUpdateTime)) {
          return { status: 'concurrent-change', dataWrites: 0, ...reported };
        }
        return {
          status: 'committed',
          ...operationalWrites(transaction, refs, { ...input, documentId: input.document.id },
            checkpoint, current, 0, new Date(input.transactionTimeMs).toISOString()),
        };
      });
    },

    async completeRecipes(input): Promise<CursorTransactionOutcome> {
      const refs = commonRefs(input.runId, input.quotaDate);
      return db.runTransaction(async (transaction) => {
        const [lease, checkpointSnapshot, run, budget] = await transaction.getAll(
          refs.lease, refs.checkpoint, refs.run, refs.budget,
        );
        const current = accounting(run, budget, input.quotaDate);
        const reported = reportedAccounting(run, budget);
        if (!hasLease(lease, ownerId, input.runId, input.transactionTimeMs)) {
          return { status: 'lease-lost', dataWrites: 0, ...reported };
        }
        const checkpoint = validCheckpoint(checkpointSnapshot);
        if (!current
          || !checkpoint
          || !validOperationalRun(run, input)
          || !isCurrentRecipeCheckpoint(checkpoint, input.epoch)
          || checkpoint.recipeCursorId !== input.cursorId) {
          return { status: 'concurrent-change', dataWrites: 0, ...reported };
        }
        const completed: MigrationCheckpoint['completedStages'] = checkpoint.completedStages.includes('recipes')
          ? checkpoint.completedStages
          : [...checkpoint.completedStages, 'recipes'];
        const next: MigrationCheckpoint = {
          ...checkpoint,
          stage: 'meal-plans',
          completedStages: completed,
          lastRunId: input.runId,
          updatedAt: input.updatedAt,
        };
        transaction.set(refs.checkpoint, next);
        transaction.set(refs.run, { lastCursor: input.cursorId, updatedAt: input.updatedAt }, { merge: true });
        return { status: 'committed', checkpoint: next, dataWrites: 0, ...current };
      });
    },

    async resetForReconciliation(input): Promise<ReconciliationResetOutcome> {
      const refs = commonRefs(input.runId, input.quotaDate);
      return db.runTransaction(async (transaction) => {
        const [lease, checkpointSnapshot, run, budget] = await transaction.getAll(
          refs.lease, refs.checkpoint, refs.run, refs.budget,
        );
        const reported = reportedAccounting(run, budget);
        const dailyUsed = budgetUsed(budget, input.quotaDate);
        if (!hasLease(lease, ownerId, input.runId, input.transactionTimeMs)) {
          return { status: 'lease-lost', dataWrites: 0, ...reported };
        }
        const checkpoint = validCheckpoint(checkpointSnapshot);
        if (!checkpoint || dailyUsed === undefined) {
          return { status: 'concurrent-change', dataWrites: 0, ...reported };
        }
        const current = { commandUsed: run.exists ? reported.commandUsed : 0, dailyUsed };
        const replay = run.exists
          && run.get('schemaVersion') === 1
          && run.get('runId') === input.runId
          && run.get('command') === 'reconcile'
          && run.get('previousEpoch') === input.previousEpoch
          && run.get('epoch') === input.previousEpoch + 1
          && run.get('startCursor') === null
          && run.get('commandCap') === input.commandCap
          && run.get('dailyLimit') === input.dailyLimit
          && run.get('quotaDate') === input.quotaDate
          && run.get('status') === 'running'
          && run.get('consumedWrites') === 0
          && checkpoint.epoch === input.previousEpoch + 1
          && checkpoint.stage === 'recipes'
          && checkpoint.lastRunId === input.runId;
        if (replay) {
          return { status: 'noop', checkpoint: checkpoint as ReconciledCheckpoint, dataWrites: 0, ...current };
        }
        if (run.exists) {
          return { status: 'concurrent-change', dataWrites: 0, ...current };
        }
        if (checkpoint.epoch !== input.previousEpoch || checkpoint.stage !== 'complete') {
          return { status: 'concurrent-change', dataWrites: 0, ...current };
        }
        const next: ReconciledCheckpoint = {
          schemaVersion: 1,
          epoch: input.previousEpoch + 1,
          stage: 'recipes',
          recipeCursorId: null,
          mealPlanCursorPath: null,
          cookbookCursorPath: null,
          completedStages: [],
          lastRunId: input.runId,
          updatedAt: input.updatedAt,
        };
        transaction.set(refs.checkpoint, next);
        transaction.set(refs.run, {
          schemaVersion: 1,
          runId: input.runId,
          command: input.command,
          previousEpoch: input.previousEpoch,
          epoch: next.epoch,
          startCursor: null,
          commandCap: input.commandCap,
          dailyLimit: input.dailyLimit,
          quotaDate: input.quotaDate,
          consumedWrites: 0,
          status: 'running',
          startedAt: input.startedAt,
          updatedAt: input.updatedAt,
        });
        return { status: 'committed', checkpoint: next, dataWrites: 0, commandUsed: 0, dailyUsed: current.dailyUsed };
      });
    },

    async summarizeRun(runId: string, summary: MigrationRunSummary) {
      await db.collection('catalogueMigrationRuns').doc(runId).set({
        schemaVersion: 1,
        runId,
        command: summary.command,
        status: summary.status,
        epoch: summary.epoch,
        startCursor: summary.startCursor,
        endCursor: summary.endCursor,
        commandCap: summary.commandCap,
        dailyLimit: summary.dailyLimit,
        consumedWrites: summary.commandUsed,
        dailyUsed: summary.dailyUsed,
        dataWrites: summary.dataWrites,
        startedAt: summary.startedAt,
        completedAt: summary.completedAt,
        cleanupErrors: summary.cleanupErrors.slice(0, 1),
        counts: summary.counts,
        ...(summary.legacyIdHash ? { legacyIdHash: summary.legacyIdHash } : {}),
        ...(summary.bySource ? { bySource: summary.bySource } : {}),
        ...(summary.byStatus ? { byStatus: summary.byStatus } : {}),
        ...(summary.byFailureReason ? { byFailureReason: summary.byFailureReason } : {}),
      }, { merge: true });
    },
  };
}
