import { createHash } from 'node:crypto';

import {
  convertLegacyRecipe,
  type LegacyMigrationConversionResult,
  type LegacyMigrationMappingState,
} from './migration.js';
import type { CatalogueTimestamp } from './domain.js';

export type MigrationStage = 'recipes' | 'meal-plans' | 'cookbooks' | 'complete';
export type MigrationCommand = 'dry-run' | 'migrate-recipes' | 'reconcile';
export type MigrationRunStatus =
  | 'complete'
  | 'budget-exhausted'
  | 'lease-unavailable'
  | 'lease-lost'
  | 'invalid-stage'
  | 'concurrent-change'
  | 'failed';

export interface MigrationCheckpoint {
  schemaVersion: 1;
  epoch: number;
  stage: MigrationStage;
  recipeCursorId: string | null;
  mealPlanCursorPath: string | null;
  cookbookCursorPath: string | null;
  completedStages: MigrationStage[];
  lastRunId: string | null;
  updatedAt: CatalogueTimestamp;
}

export interface ScannedDocument {
  path: string;
  id: string;
  updateTime: unknown;
  data: Record<string, unknown>;
}

export interface RecipeMigrationScanner {
  scanRecipes(afterId: string | null, pageSize: number): Promise<ScannedDocument[]>;
}

export interface MigrationLease {
  acquire(nowMs?: number): Promise<boolean>;
  renew(nowMs?: number): Promise<boolean>;
  release(): Promise<void>;
}

export interface MigrationAccounting {
  dataWrites: number;
  commandUsed: number;
  dailyUsed: number;
}

type RejectedTransactionOutcome = Omit<MigrationAccounting, 'dataWrites'> & {
  status: 'budget-exhausted' | 'concurrent-change';
  dataWrites: 0;
};

type CountableCommittedRecipeOutcome = MigrationAccounting & (
  | {
      status: 'committed';
      disposition: Exclude<LegacyMigrationMappingState, 'failed'>;
      targetStatus: 'ready' | 'review';
    }
  | {
      status: 'committed';
      disposition: 'failed';
      targetStatus?: never;
    }
);

export type RecipeTransactionOutcome =
  | RejectedTransactionOutcome
  | CountableCommittedRecipeOutcome
  | (MigrationAccounting & {
      status: 'noop';
      disposition?: never;
      targetStatus?: never;
    });

export type CursorTransactionOutcome = RejectedTransactionOutcome | (MigrationAccounting & {
  status: 'committed' | 'noop';
  checkpoint?: MigrationCheckpoint;
});

export interface ReconciledCheckpoint extends MigrationCheckpoint {
  stage: 'recipes';
  recipeCursorId: null;
  mealPlanCursorPath: null;
  cookbookCursorPath: null;
  completedStages: [];
}

export type ReconciliationResetOutcome = RejectedTransactionOutcome | (MigrationAccounting & {
  status: 'committed' | 'noop';
  checkpoint: ReconciledCheckpoint;
});

export interface MigrationRunStart {
  runId: string;
  command: Exclude<MigrationCommand, 'dry-run'>;
  epoch: number;
  startCursor: string | null;
  commandCap: number;
  dailyLimit: number;
  startedAt: string;
}

export interface CommitRecipeInput {
  runId: string;
  epoch: number;
  document: ScannedDocument;
  scannedUpdateTime: unknown;
  conversion: LegacyMigrationConversionResult;
  commandCap: number;
  dailyLimit: number;
}

export interface CursorAdvanceInput {
  runId: string;
  epoch: number;
  document: ScannedDocument;
  scannedUpdateTime: unknown;
  reason: 'schema-v2';
  commandCap: number;
  dailyLimit: number;
}

export interface MigrationTransactionStore {
  loadCheckpoint(): Promise<MigrationCheckpoint>;
  startRun(start: MigrationRunStart): Promise<void>;
  commitRecipe(input: CommitRecipeInput): Promise<RecipeTransactionOutcome>;
  advanceRecipeCursor(input: CursorAdvanceInput): Promise<CursorTransactionOutcome>;
  completeRecipes(input: {
    runId: string;
    epoch: number;
    cursorId: string | null;
    updatedAt: string;
    commandCap: number;
    dailyLimit: number;
  }): Promise<CursorTransactionOutcome>;
  resetForReconciliation(input: {
    runId: string;
    command: 'reconcile';
    previousEpoch: number;
    startCursor: null;
    startedAt: string;
    updatedAt: string;
    commandCap: number;
    dailyLimit: number;
  }): Promise<ReconciliationResetOutcome>;
  summarizeRun(runId: string, summary: MigrationRunSummary): Promise<void>;
}

export interface MigrationCounts {
  scanned: number;
  skippedV2: number;
  migrated: number;
  linkedExisting: number;
  failed: number;
  ready: number;
  review: number;
  noops: number;
  concurrentChanges: number;
}

export interface MigrationRunSummary extends MigrationAccounting {
  runId: string;
  command: MigrationCommand;
  status: MigrationRunStatus;
  startCursor: string | null;
  endCursor: string | null;
  epoch: number;
  commandCap: number;
  dailyLimit: number;
  startedAt: string;
  completedAt: string;
  cleanupErrors: Array<'lease-release'>;
  counts: MigrationCounts;
  legacyIdHash?: string;
  bySource?: Record<string, number>;
  byStatus?: Record<string, number>;
  byFailureReason?: Record<string, number>;
}

export interface RecipeMigrationDependencies {
  scanner: RecipeMigrationScanner;
  store: MigrationTransactionStore;
  lease: MigrationLease;
  now: () => Date;
}

export interface RecipeMigrationOptions {
  runId: string;
  pageSize?: number;
  commandCap?: number;
  dailyLimit?: number;
}

const emptyCounts = (): MigrationCounts => ({
  scanned: 0,
  skippedV2: 0,
  migrated: 0,
  linkedExisting: 0,
  failed: 0,
  ready: 0,
  review: 0,
  noops: 0,
  concurrentChanges: 0,
});

function addAccounting(summary: MigrationRunSummary, outcome: MigrationAccounting): void {
  summary.dataWrites += outcome.dataWrites;
  summary.commandUsed = outcome.commandUsed;
  summary.dailyUsed = outcome.dailyUsed;
}

function outcomeStatus(outcome: CursorTransactionOutcome | RecipeTransactionOutcome):
  MigrationRunStatus | undefined {
  if (outcome.status === 'budget-exhausted') return 'budget-exhausted';
  if (outcome.status === 'concurrent-change') return 'concurrent-change';
  return undefined;
}

function stableHash(ids: readonly string[]): string {
  return createHash('sha256').update([...ids].sort().join('\n'), 'utf8').digest('hex');
}

export async function runRecipeMigration(
  command: MigrationCommand,
  dependencies: RecipeMigrationDependencies,
  options: RecipeMigrationOptions,
): Promise<MigrationRunSummary> {
  const pageSize = options.pageSize ?? 100;
  const commandCap = options.commandCap ?? 8_000;
  const dailyLimit = options.dailyLimit ?? 18_000;
  if (!options.runId || !Number.isInteger(pageSize) || pageSize <= 0) {
    throw new Error('Invalid recipe migration options');
  }
  if (!Number.isInteger(commandCap) || commandCap <= 0 || commandCap > 8_000) {
    throw new Error('Invalid commandCap');
  }
  if (!Number.isInteger(dailyLimit) || dailyLimit <= 0 || dailyLimit > 18_000) {
    throw new Error('Invalid dailyLimit');
  }
  const startedAt = dependencies.now().toISOString();
  if (command === 'dry-run') {
    const counts = emptyCounts();
    const ids: string[] = [];
    const bySource: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    const byFailureReason: Record<string, number> = {};
    let cursor: string | null = null;
    while (true) {
      const page = await dependencies.scanner.scanRecipes(cursor, pageSize);
      if (page.length === 0) break;
      for (const document of page) {
        cursor = document.id;
        counts.scanned += 1;
        if (document.data.schemaVersion === 2) {
          counts.skippedV2 += 1;
          continue;
        }
        ids.push(document.id);
        const conversion = convertLegacyRecipe({
          legacyRecipeId: document.id,
          data: document.data,
          runId: options.runId,
          timestamp: startedAt,
        });
        const source = conversion.mapping.sourceKey ?? 'unknown';
        bySource[source] = (bySource[source] ?? 0) + 1;
        if (conversion.kind === 'failure') {
          counts.failed += 1;
          byStatus.failed = (byStatus.failed ?? 0) + 1;
          for (const reason of conversion.mapping.reasonCodes) {
            byFailureReason[reason] = (byFailureReason[reason] ?? 0) + 1;
          }
        } else {
          counts.migrated += 1;
          counts[conversion.recipe.status] += 1;
          byStatus[conversion.recipe.status] = (byStatus[conversion.recipe.status] ?? 0) + 1;
        }
      }
    }
    return {
      runId: options.runId,
      command,
      status: 'complete',
      startCursor: null,
      endCursor: cursor,
      epoch: 0,
      commandCap,
      dailyLimit,
      dataWrites: 0,
      commandUsed: 0,
      dailyUsed: 0,
      startedAt,
      completedAt: dependencies.now().toISOString(),
      cleanupErrors: [],
      counts,
      legacyIdHash: stableHash(ids),
      bySource,
      byStatus,
      byFailureReason,
    };
  }

  const summary: MigrationRunSummary = {
    runId: options.runId,
    command,
    status: 'failed',
    startCursor: null,
    endCursor: null,
    epoch: 0,
    commandCap,
    dailyLimit,
    dataWrites: 0,
    commandUsed: 0,
    dailyUsed: 0,
    startedAt,
    completedAt: startedAt,
    cleanupErrors: [],
    counts: emptyCounts(),
  };
  let acquired = false;
  let started = false;
  try {
    acquired = await dependencies.lease.acquire(new Date(startedAt).getTime());
    if (!acquired) {
      summary.status = 'lease-unavailable';
      return summary;
    }
    const initialCheckpoint = await dependencies.store.loadCheckpoint();
    summary.startCursor = initialCheckpoint.recipeCursorId;
    summary.endCursor = initialCheckpoint.recipeCursorId;
    summary.epoch = initialCheckpoint.epoch;
    if (command === 'reconcile' && initialCheckpoint.stage !== 'complete') {
      summary.status = 'invalid-stage';
      return summary;
    }
    if (command === 'migrate-recipes') {
      await dependencies.store.startRun({
        runId: options.runId,
        command,
        epoch: summary.epoch,
        startCursor: summary.startCursor,
        commandCap,
        dailyLimit,
        startedAt,
      });
      started = true;
    } else {
      if (!(await dependencies.lease.renew(dependencies.now().getTime()))) {
        summary.status = 'lease-lost';
        return summary;
      }
      const reset = await dependencies.store.resetForReconciliation({
        runId: options.runId,
        command,
        previousEpoch: summary.epoch,
        startCursor: null,
        startedAt,
        updatedAt: startedAt,
        commandCap,
        dailyLimit,
      });
      addAccounting(summary, reset);
      if (!('checkpoint' in reset)) {
        if (reset.status === 'concurrent-change') summary.counts.concurrentChanges += 1;
        summary.status = reset.status;
        return summary;
      }
      started = true;
      summary.epoch = reset.checkpoint.epoch;
      summary.startCursor = null;
      summary.endCursor = null;
    }

    let cursor = summary.endCursor;
    while (true) {
      const page = await dependencies.scanner.scanRecipes(cursor, pageSize);
      if (page.length === 0) {
        if (!(await dependencies.lease.renew(dependencies.now().getTime()))) {
          summary.status = 'lease-lost';
          return summary;
        }
        const complete = await dependencies.store.completeRecipes({
          runId: options.runId,
          epoch: summary.epoch,
          cursorId: cursor,
          updatedAt: startedAt,
          commandCap,
          dailyLimit,
        });
        addAccounting(summary, complete);
        if (complete.status === 'concurrent-change') summary.counts.concurrentChanges += 1;
        summary.status = outcomeStatus(complete) ?? 'complete';
        return summary;
      }
      for (const document of page) {
        if (!(await dependencies.lease.renew(dependencies.now().getTime()))) {
          summary.status = 'lease-lost';
          return summary;
        }
        summary.counts.scanned += 1;
        let outcome: RecipeTransactionOutcome | CursorTransactionOutcome;
        if (document.data.schemaVersion === 2) {
          summary.counts.skippedV2 += 1;
          outcome = await dependencies.store.advanceRecipeCursor({
            runId: options.runId,
            epoch: summary.epoch,
            document,
            scannedUpdateTime: document.updateTime,
            reason: 'schema-v2',
            commandCap,
            dailyLimit,
          });
        } else {
          const conversion = convertLegacyRecipe({
            legacyRecipeId: document.id,
            data: document.data,
            runId: options.runId,
            timestamp: startedAt,
          });
          outcome = await dependencies.store.commitRecipe({
            runId: options.runId,
            epoch: summary.epoch,
            document,
            scannedUpdateTime: document.updateTime,
            conversion,
            commandCap,
            dailyLimit,
          });
        }
        addAccounting(summary, outcome);
        const stopped = outcomeStatus(outcome);
        if (stopped) {
          if (stopped === 'concurrent-change') summary.counts.concurrentChanges += 1;
          summary.status = stopped;
          return summary;
        }
        cursor = document.id;
        summary.endCursor = cursor;
        if (outcome.status === 'noop') {
          summary.counts.noops += 1;
        } else if ('disposition' in outcome) {
          if (outcome.disposition === 'migrated') summary.counts.migrated += 1;
          if (outcome.disposition === 'linked-existing') summary.counts.linkedExisting += 1;
          if (outcome.disposition === 'failed') summary.counts.failed += 1;
          if (outcome.targetStatus === 'ready') summary.counts.ready += 1;
          if (outcome.targetStatus === 'review') summary.counts.review += 1;
        }
      }
    }
  } catch {
    summary.status = 'failed';
    return summary;
  } finally {
    summary.completedAt = dependencies.now().toISOString();
    if (acquired) {
      try {
        await dependencies.lease.release();
      } catch {
        summary.cleanupErrors.push('lease-release');
      }
    }
    if (started) {
      try {
        await dependencies.store.summarizeRun(options.runId, summary);
      } catch {
        summary.status = 'failed';
      }
    }
  }
}
