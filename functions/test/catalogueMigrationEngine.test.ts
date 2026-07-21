import { describe, expect, it } from 'vitest';

import {
  runRecipeMigration,
  type MigrationCheckpoint,
  type MigrationTransactionStore,
  type RecipeMigrationScanner,
  type ScannedDocument,
} from '../src/catalogue/migrationEngine.js';

const runTimestamp = new Date('2026-07-19T08:00:00.000Z');

function legacyRecipe(
  title = 'Soup',
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    title,
    sourceUrl: `https://www.recipetineats.com/${title.toLowerCase()}`,
    totalTime: '30 minutes',
    originalServings: 4,
    course: 'Dinner',
    cuisine: 'Mediterranean',
    ingredients: [{ name: 'Onion', quantity: 1 }],
    instructions: [{ text: 'Cook.' }],
    ...overrides,
  };
}

function document(id: string, data: Record<string, unknown> = legacyRecipe(id)): ScannedDocument {
  return { path: `recipes/${id}`, id, updateTime: `update-${id}`, data };
}

function checkpoint(overrides: Partial<MigrationCheckpoint> = {}): MigrationCheckpoint {
  return {
    schemaVersion: 1,
    epoch: 0,
    stage: 'recipes',
    recipeCursorId: null,
    mealPlanCursorPath: null,
    cookbookCursorPath: null,
    completedStages: [],
    lastRunId: null,
    updatedAt: '2026-07-18T08:00:00.000Z',
    ...overrides,
  };
}

function transaction(
  overrides: Partial<Awaited<ReturnType<MigrationTransactionStore['commitRecipe']>>> = {},
) {
  return {
    status: 'committed' as const,
    disposition: 'migrated' as const,
    targetStatus: 'ready' as const,
    dataWrites: 3,
    commandUsed: 3,
    dailyUsed: 3,
    ...overrides,
  };
}

function memoryStore(
  overrides: Partial<MigrationTransactionStore> = {},
  initial = checkpoint(),
): MigrationTransactionStore {
  return {
    async loadCheckpoint() { return initial; },
    async startRun() { return 'started' as const; },
    async commitRecipe() { return transaction(); },
    async advanceRecipeCursor() {
      return { status: 'committed', dataWrites: 1, commandUsed: 1, dailyUsed: 1 };
    },
    async completeRecipes() {
      return { status: 'committed', dataWrites: 1, commandUsed: 1, dailyUsed: 1 };
    },
    async resetForReconciliation() {
      return {
        status: 'committed',
        checkpoint: checkpoint({ epoch: initial.epoch + 1 }),
        dataWrites: 1,
        commandUsed: 1,
        dailyUsed: 1,
      };
    },
    async summarizeRun() { return undefined; },
    ...overrides,
  };
}

function availableLease(renewResults: boolean[] = []) {
  let released = 0;
  let renewals = 0;
  return {
    lease: {
      async acquire() { return true; },
      async renew() { return renewResults[renewals++] ?? true; },
      async release() { released += 1; },
    },
    released: () => released,
    renewals: () => renewals,
  };
}

describe('recipe migration engine', () => {
  it.each([
    [{ commandCap: 8_001 }, 'commandCap'],
    [{ commandCap: 1.5 }, 'commandCap'],
    [{ commandCap: 0 }, 'commandCap'],
    [{ dailyLimit: 18_001 }, 'dailyLimit'],
    [{ dailyLimit: 1.5 }, 'dailyLimit'],
    [{ dailyLimit: -1 }, 'dailyLimit'],
  ])('rejects an invalid hard-cap option %o before calling dependencies', async (invalid, field) => {
    let dependencyCalls = 0;
    const touch = () => { dependencyCalls += 1; throw new Error('dependency called'); };

    await expect(runRecipeMigration('dry-run', {
      scanner: { async scanRecipes() { return touch(); } },
      store: memoryStore({ async loadCheckpoint() { return touch(); } }),
      lease: {
        async acquire() { return touch(); },
        async renew() { return touch(); },
        async release() { return touch(); },
      },
      now: touch,
    }, { runId: 'invalid-caps', ...invalid })).rejects.toThrow(`Invalid ${field}`);

    expect(dependencyCalls).toBe(0);
  });

  it('passes lower positive integer canary ceilings unchanged', async () => {
    const caps: Array<[number, number]> = [];
    const store = memoryStore({
      async commitRecipe(input) {
        caps.push([input.commandCap, input.dailyLimit]);
        return transaction({ commandUsed: 1, dailyUsed: 1 });
      },
    });
    const scanner: RecipeMigrationScanner = {
      async scanRecipes(afterId) { return afterId === null ? [document('canary')] : []; },
    };

    await runRecipeMigration('migrate-recipes', {
      scanner, store, lease: availableLease().lease, now: () => runTimestamp,
    }, { runId: 'run-canary-caps', commandCap: 25, dailyLimit: 250 });

    expect(caps).toEqual([[25, 250]]);
  });

  it('acquires the migration lease before reading the resumable checkpoint', async () => {
    let acquired = false;
    const order: string[] = [];
    const store = memoryStore({
      async loadCheckpoint() {
        order.push(`checkpoint:${acquired}`);
        return checkpoint();
      },
    });
    const lease = {
      async acquire() { order.push('acquire'); acquired = true; return true; },
      async renew() { return true; },
      async release() { return undefined; },
    };

    await runRecipeMigration('migrate-recipes', {
      scanner: { async scanRecipes() { return []; } },
      store, lease, now: () => runTimestamp,
    }, { runId: 'run-acquire-first' });

    expect(order.slice(0, 2)).toEqual(['acquire', 'checkpoint:true']);
  });

  it('resumes recipe scanning after the durable checkpoint cursor', async () => {
    const scanCalls: Array<string | null> = [];
    const scanner: RecipeMigrationScanner = {
      async scanRecipes(afterId) {
        scanCalls.push(afterId);
        return afterId === 'legacy-a' ? [document('legacy-b')] : [];
      },
    };
    const committed: string[] = [];
    const store: MigrationTransactionStore = {
      async loadCheckpoint() { return checkpoint({ recipeCursorId: 'legacy-a' }); },
      async startRun() { return 'started' as const; },
      async commitRecipe(input) {
        committed.push(input.document.id);
        return {
          status: 'committed',
          disposition: 'migrated',
          targetStatus: 'ready',
          dataWrites: 3,
          commandUsed: 3,
          dailyUsed: 3,
        };
      },
      async advanceRecipeCursor() { throw new Error('not used'); },
      async completeRecipes(input) {
        return {
          status: 'committed' as const,
          checkpoint: checkpoint({
            recipeCursorId: input.cursorId,
            stage: 'meal-plans',
            completedStages: ['recipes'],
          }),
          dataWrites: 1,
          commandUsed: 4,
          dailyUsed: 4,
        };
      },
      async resetForReconciliation() { throw new Error('not used'); },
      async summarizeRun() { return undefined; },
    };
    const lease = {
      async acquire() { return true; },
      async renew() { return true; },
      async release() { return undefined; },
    };

    const summary = await runRecipeMigration('migrate-recipes', {
      scanner,
      store,
      lease,
      now: () => runTimestamp,
    }, { runId: 'run-resume', pageSize: 10 });

    expect(scanCalls).toEqual(['legacy-a', 'legacy-b']);
    expect(committed).toEqual(['legacy-b']);
    expect(summary.startCursor).toBe('legacy-a');
    expect(summary.endCursor).toBe('legacy-b');
    expect(summary.status).toBe('complete');
  });

  it('renews the lease before the empty-page completion transaction', async () => {
    let completed = false;
    const store: MigrationTransactionStore = {
      async loadCheckpoint() { return checkpoint(); },
      async startRun() { return 'started' as const; },
      async commitRecipe() { throw new Error('not used'); },
      async advanceRecipeCursor() { throw new Error('not used'); },
      async completeRecipes() {
        completed = true;
        return { status: 'committed', dataWrites: 1, commandUsed: 1, dailyUsed: 1 };
      },
      async resetForReconciliation() { throw new Error('not used'); },
      async summarizeRun() { return undefined; },
    };

    const summary = await runRecipeMigration('migrate-recipes', {
      scanner: { async scanRecipes() { return []; } },
      store,
      lease: {
        async acquire() { return true; },
        async renew() { return false; },
        async release() { return undefined; },
      },
      now: () => runTimestamp,
    }, { runId: 'run-empty-lease' });

    expect(summary.status).toBe('lease-lost');
    expect(completed).toBe(false);
  });

  it('counts a concurrent change reported by the recipe completion transaction', async () => {
    const store = memoryStore({
      async completeRecipes() {
        return { status: 'concurrent-change', dataWrites: 0, commandUsed: 2, dailyUsed: 12 };
      },
    });

    const summary = await runRecipeMigration('migrate-recipes', {
      scanner: { async scanRecipes() { return []; } },
      store, lease: availableLease().lease, now: () => runTimestamp,
    }, { runId: 'run-complete-concurrent' });

    expect(summary).toMatchObject({
      status: 'concurrent-change',
      endCursor: null,
      counts: { concurrentChanges: 1 },
    });
  });

  it('skips schema-v2 recipes through durable cursor advancement without conversion writes', async () => {
    const calls = { commits: 0, advances: [] as Array<{ id: string; updateTime: unknown }> };
    const scanner: RecipeMigrationScanner = {
      async scanRecipes(afterId) {
        return afterId === null ? [document('already-v2', { schemaVersion: 2 })] : [];
      },
    };
    const store = memoryStore({
      async commitRecipe() { calls.commits += 1; return transaction(); },
      async advanceRecipeCursor(input) {
        calls.advances.push({ id: input.document.id, updateTime: input.scannedUpdateTime });
        return { status: 'committed', dataWrites: 1, commandUsed: 1, dailyUsed: 7 };
      },
      async completeRecipes() {
        return { status: 'committed', dataWrites: 1, commandUsed: 2, dailyUsed: 8 };
      },
    });
    const lease = availableLease();

    const summary = await runRecipeMigration('migrate-recipes', {
      scanner, store, lease: lease.lease, now: () => runTimestamp,
    }, { runId: 'run-skip-v2' });

    expect(calls.commits).toBe(0);
    expect(calls.advances).toEqual([{ id: 'already-v2', updateTime: 'update-already-v2' }]);
    expect(summary).toMatchObject({
      status: 'complete', endCursor: 'already-v2', dataWrites: 2,
      commandUsed: 2, dailyUsed: 8, counts: { scanned: 1, skippedV2: 1 },
    });
  });

  it('continues after a short non-empty page and completes only on an empty page', async () => {
    const cursors: Array<string | null> = [];
    const completedAt: Array<string | null> = [];
    const scanner: RecipeMigrationScanner = {
      async scanRecipes(afterId) {
        cursors.push(afterId);
        if (afterId === null) return [document('a')];
        if (afterId === 'a') return [document('b')];
        return [];
      },
    };
    const store = memoryStore({
      async completeRecipes(input) {
        completedAt.push(input.cursorId);
        return { status: 'committed', dataWrites: 1, commandUsed: 7, dailyUsed: 7 };
      },
    });

    const summary = await runRecipeMigration('migrate-recipes', {
      scanner, store, lease: availableLease().lease, now: () => runTimestamp,
    }, { runId: 'run-short-page', pageSize: 10 });

    expect(cursors).toEqual([null, 'a', 'b']);
    expect(completedAt).toEqual(['b']);
    expect(summary.counts.scanned).toBe(2);
  });

  it.each([
    ['command', { commandUsed: 8_000, dailyUsed: 11_000 }],
    ['daily', { commandUsed: 3_000, dailyUsed: 18_000 }],
  ] as const)('stops on the %s cap without advancing the rejected recipe', async (_cap, usage) => {
    let completionCalls = 0;
    const inputs: Array<{ commandCap: number; dailyLimit: number }> = [];
    const store = memoryStore({
      async commitRecipe(input) {
        inputs.push({ commandCap: input.commandCap, dailyLimit: input.dailyLimit });
        return transaction({
          status: 'budget-exhausted',
          disposition: undefined,
          targetStatus: undefined,
          dataWrites: 0,
          ...usage,
        });
      },
      async completeRecipes() {
        completionCalls += 1;
        return { status: 'committed', dataWrites: 1, commandUsed: 1, dailyUsed: 1 };
      },
    });
    const scanner: RecipeMigrationScanner = {
      async scanRecipes(afterId) { return afterId === null ? [document('blocked')] : []; },
    };

    const summary = await runRecipeMigration('migrate-recipes', {
      scanner, store, lease: availableLease().lease, now: () => runTimestamp,
    }, { runId: `run-${_cap}-cap` });

    expect(inputs).toEqual([{ commandCap: 8_000, dailyLimit: 18_000 }]);
    expect(summary).toMatchObject({
      status: 'budget-exhausted', endCursor: null, dataWrites: 0, ...usage,
    });
    expect(completionCalls).toBe(0);
  });

  it('returns lease-unavailable without starting or persisting a mutating run', async () => {
    let starts = 0;
    let summaries = 0;
    const store = memoryStore({
      async startRun() { starts += 1; return 'started' as const; },
      async summarizeRun() { summaries += 1; },
    });

    const summary = await runRecipeMigration('migrate-recipes', {
      scanner: { async scanRecipes() { throw new Error('must not scan'); } },
      store,
      lease: {
        async acquire() { return false; },
        async renew() { throw new Error('must not renew'); },
        async release() { throw new Error('must not release unowned lease'); },
      },
      now: () => runTimestamp,
    }, { runId: 'run-lease-unavailable' });

    expect(summary.status).toBe('lease-unavailable');
    expect(starts).toBe(0);
    expect(summaries).toBe(0);
  });

  it('stops on a concurrent start transaction without scanning or summarizing', async () => {
    let scans = 0;
    let summaries = 0;
    const store = memoryStore({
      async startRun() { return 'concurrent-change'; },
      async summarizeRun() { summaries += 1; },
    });

    const summary = await runRecipeMigration('migrate-recipes', {
      scanner: { async scanRecipes() { scans += 1; return []; } },
      store,
      lease: availableLease().lease,
      now: () => runTimestamp,
    }, { runId: 'run-start-race' });

    expect(summary.status).toBe('concurrent-change');
    expect(scans).toBe(0);
    expect(summaries).toBe(0);
  });

  it('stops on lease loss before the next unit and releases the acquired lease', async () => {
    let commits = 0;
    const lease = availableLease([false]);
    const store = memoryStore({
      async commitRecipe() { commits += 1; return transaction(); },
    });

    const summary = await runRecipeMigration('migrate-recipes', {
      scanner: { async scanRecipes() { return [document('not-committed')]; } },
      store, lease: lease.lease, now: () => runTimestamp,
    }, { runId: 'run-lease-lost' });

    expect(summary.status).toBe('lease-lost');
    expect(summary.endCursor).toBe(null);
    expect(commits).toBe(0);
    expect(lease.released()).toBe(1);
  });

  it('persists a failed summary and releases the lease when a unit crashes', async () => {
    const summaries: Array<{ status: string; failed: number }> = [];
    const lease = availableLease();
    const store = memoryStore({
      async commitRecipe() { throw new Error('simulated transaction crash'); },
      async summarizeRun(_runId, summary) {
        summaries.push({ status: summary.status, failed: summary.counts.failed });
      },
    });

    const summary = await runRecipeMigration('migrate-recipes', {
      scanner: { async scanRecipes() { return [document('crash')]; } },
      store, lease: lease.lease, now: () => runTimestamp,
    }, { runId: 'run-crash' });

    expect(summary.status).toBe('failed');
    expect(summaries).toEqual([{ status: 'failed', failed: 0 }]);
    expect(lease.released()).toBe(1);
  });

  it('preserves the operation result and persists the same bounded cleanup error when release rejects', async () => {
    const order: string[] = [];
    const persisted: Array<{ status: string; cleanupErrors: unknown }> = [];
    const store = memoryStore({
      async summarizeRun(_runId, summary) {
        order.push('summary');
        persisted.push({ status: summary.status, cleanupErrors: summary.cleanupErrors });
      },
    });

    const summary = await runRecipeMigration('migrate-recipes', {
      scanner: { async scanRecipes() { return []; } },
      store,
      lease: {
        async acquire() { return true; },
        async renew() { return true; },
        async release() { order.push('release'); throw new Error('sensitive release detail'); },
      },
      now: () => runTimestamp,
    }, { runId: 'run-release-rejection' });

    expect(order).toEqual(['release', 'summary']);
    expect(summary).toMatchObject({ status: 'complete', cleanupErrors: ['lease-release'] });
    expect(persisted).toEqual([{
      status: 'complete', cleanupErrors: ['lease-release'],
    }]);
  });

  it('does not advance the cursor when the transaction detects a concurrent change', async () => {
    const store = memoryStore({
      async commitRecipe(input) {
        expect(input.scannedUpdateTime).toBe('update-racy');
        return transaction({
          status: 'concurrent-change', disposition: undefined, targetStatus: undefined,
          dataWrites: 0, commandUsed: 0, dailyUsed: 0,
        });
      },
    });

    const summary = await runRecipeMigration('migrate-recipes', {
      scanner: { async scanRecipes() { return [document('racy')]; } },
      store, lease: availableLease().lease, now: () => runTimestamp,
    }, { runId: 'run-concurrent' });

    expect(summary).toMatchObject({
      status: 'concurrent-change', endCursor: null, dataWrites: 0,
      counts: { concurrentChanges: 1 },
    });
  });

  it('stops as lease-lost when an atomic recipe transaction rejects the lease', async () => {
    const store = memoryStore({
      async commitRecipe() {
        return { status: 'lease-lost', dataWrites: 0, commandUsed: 2, dailyUsed: 12 };
      },
    });

    const summary = await runRecipeMigration('migrate-recipes', {
      scanner: {
        async scanRecipes(afterId) { return afterId === null ? [document('legacy-a')] : []; },
      },
      store,
      lease: availableLease().lease,
      now: () => runTimestamp,
    }, { runId: 'run-transaction-lease-lost' });

    expect(summary).toMatchObject({
      status: 'lease-lost', endCursor: null, dataWrites: 0, commandUsed: 2, dailyUsed: 12,
    });
  });

  it('treats a replayed terminal mapping as a noop while durably advancing', async () => {
    const scanner: RecipeMigrationScanner = {
      async scanRecipes(afterId) { return afterId === null ? [document('replayed')] : []; },
    };
    const store = memoryStore({
      async commitRecipe() {
        return transaction({ status: 'noop', disposition: undefined, targetStatus: undefined, dataWrites: 1 });
      },
    });

    const summary = await runRecipeMigration('migrate-recipes', {
      scanner, store, lease: availableLease().lease, now: () => runTimestamp,
    }, { runId: 'run-replay' });

    expect(summary.endCursor).toBe('replayed');
    expect(summary.counts).toMatchObject({ noops: 1, migrated: 0, linkedExisting: 0 });
  });

  it('uses one run timestamp and counts committed migration dispositions exactly', async () => {
    const timestamps: unknown[] = [];
    const scanner: RecipeMigrationScanner = {
      async scanRecipes(afterId) {
        if (afterId === null) return [
          document('migrated-ready'),
          document('migrated-review'),
          document('linked-ready'),
          document('linked-review'),
          document('failed'),
        ];
        return [];
      },
    };
    const store = memoryStore({
      async commitRecipe(input) {
        timestamps.push(input.conversion.mapping.updatedAt);
        if (input.document.id === 'migrated-review') {
          return transaction({ disposition: 'migrated', targetStatus: 'review' });
        }
        if (input.document.id === 'linked-ready') {
          return transaction({ disposition: 'linked-existing', targetStatus: 'ready' });
        }
        if (input.document.id === 'linked-review') {
          return transaction({ disposition: 'linked-existing', targetStatus: 'review' });
        }
        if (input.document.id === 'failed') {
          return transaction({ disposition: 'failed', targetStatus: undefined, dataWrites: 1 });
        }
        return transaction();
      },
    });

    const summary = await runRecipeMigration('migrate-recipes', {
      scanner, store, lease: availableLease().lease, now: () => runTimestamp,
    }, { runId: 'run-dispositions' });

    expect(timestamps).toEqual([
      '2026-07-19T08:00:00.000Z',
      '2026-07-19T08:00:00.000Z',
      '2026-07-19T08:00:00.000Z',
      '2026-07-19T08:00:00.000Z',
      '2026-07-19T08:00:00.000Z',
    ]);
    expect(summary.counts).toMatchObject({
      migrated: 2, linkedExisting: 2, failed: 1, ready: 2, review: 2,
    });
  });

  it('reconcile resets all stages and cursors while incrementing epoch before scanning', async () => {
    const order: string[] = [];
    const old = checkpoint({
      epoch: 4,
      stage: 'complete',
      recipeCursorId: 'old-recipe',
      mealPlanCursorPath: 'households/h/mealPlans/p',
      cookbookCursorPath: 'households/h/cookbook/c',
      completedStages: ['recipes', 'meal-plans', 'cookbooks'],
    });
    const store = memoryStore({
      async resetForReconciliation() {
        order.push('reset');
        return {
          status: 'committed',
          checkpoint: checkpoint({ epoch: 5, lastRunId: 'run-reconcile' }),
          dataWrites: 1,
          commandUsed: 1,
          dailyUsed: 10,
        };
      },
      async commitRecipe(input) {
        order.push(`commit:${input.epoch}`);
        return transaction({ commandUsed: 4, dailyUsed: 13 });
      },
      async completeRecipes(input) {
        order.push(`complete:${input.epoch}`);
        return { status: 'committed', dataWrites: 1, commandUsed: 5, dailyUsed: 14 };
      },
    }, old);
    const scanner: RecipeMigrationScanner = {
      async scanRecipes(afterId) {
        order.push(`scan:${afterId ?? 'null'}`);
        return afterId === null ? [document('new-recipe')] : [];
      },
    };

    const summary = await runRecipeMigration('reconcile', {
      scanner, store, lease: availableLease().lease, now: () => runTimestamp,
    }, { runId: 'run-reconcile' });

    expect(order).toEqual(['reset', 'scan:null', 'commit:5', 'scan:new-recipe', 'complete:5']);
    expect(summary).toMatchObject({ status: 'complete', epoch: 5, startCursor: null, endCursor: 'new-recipe' });
  });

  it('rejects reconcile outside the complete stage without starting or mutating a run', async () => {
    const mutations: string[] = [];
    const lease = availableLease();
    const store = memoryStore({
      async startRun() { mutations.push('start'); return 'started' as const; },
      async resetForReconciliation() {
        mutations.push('reset');
        return {
          status: 'committed',
          checkpoint: checkpoint({ epoch: 1 }),
          dataWrites: 1,
          commandUsed: 1,
          dailyUsed: 1,
        };
      },
      async summarizeRun() { mutations.push('summary'); },
    }, checkpoint({ stage: 'recipes' }));

    const summary = await runRecipeMigration('reconcile', {
      scanner: { async scanRecipes() { mutations.push('scan'); return []; } },
      store, lease: lease.lease, now: () => runTimestamp,
    }, { runId: 'run-invalid-stage' });

    expect(summary.status).toBe('invalid-stage');
    expect(mutations).toEqual([]);
    expect(lease.released()).toBe(1);
  });

  it('uses an authoritative reset noop to initialize a replayed reconciliation run', async () => {
    const order: string[] = [];
    const resetInputs: unknown[] = [];
    const persistedEpochs: number[] = [];
    const old = checkpoint({
      epoch: 8,
      stage: 'complete',
      recipeCursorId: 'old-last-recipe',
      mealPlanCursorPath: 'old-meal-plan',
      cookbookCursorPath: 'old-cookbook',
      completedStages: ['recipes', 'meal-plans', 'cookbooks'],
    });
    const replayed = checkpoint({
      epoch: 9,
      stage: 'recipes',
      recipeCursorId: null,
      mealPlanCursorPath: null,
      cookbookCursorPath: null,
      completedStages: [],
      lastRunId: 'run-reconcile-replay',
    });
    const store = memoryStore({
      async loadCheckpoint() { order.push('checkpoint'); return old; },
      async startRun() { order.push('startRun'); return 'started' as const; },
      async resetForReconciliation(input) {
        order.push('reset');
        resetInputs.push(input);
        return {
          status: 'noop',
          checkpoint: replayed,
          dataWrites: 0,
          commandUsed: 12,
          dailyUsed: 112,
        };
      },
      async completeRecipes(input) {
        order.push(`complete:${input.epoch}`);
        return { status: 'committed', dataWrites: 1, commandUsed: 13, dailyUsed: 113 };
      },
      async summarizeRun(_runId, summary) {
        order.push('summary');
        persistedEpochs.push(summary.epoch);
      },
    }, old);
    const lease = {
      async acquire() { order.push('acquire'); return true; },
      async renew() { order.push('renew'); return true; },
      async release() { order.push('release'); },
    };

    const summary = await runRecipeMigration('reconcile', {
      scanner: { async scanRecipes(afterId) { order.push(`scan:${afterId}`); return []; } },
      store, lease, now: () => runTimestamp,
    }, {
      runId: 'run-reconcile-replay',
      commandCap: 77,
      dailyLimit: 123,
    });

    expect(resetInputs).toEqual([{
      runId: 'run-reconcile-replay',
      command: 'reconcile',
      previousEpoch: 8,
      startCursor: null,
      commandCap: 77,
      dailyLimit: 123,
      quotaDate: '2026-07-19',
      transactionTimeMs: runTimestamp.getTime(),
      startedAt: '2026-07-19T08:00:00.000Z',
      updatedAt: '2026-07-19T08:00:00.000Z',
    }]);
    expect(order).toEqual([
      'acquire', 'checkpoint', 'renew', 'reset', 'scan:null', 'renew',
      'complete:9', 'release', 'summary',
    ]);
    expect(summary).toMatchObject({ status: 'complete', epoch: 9, startCursor: null, endCursor: null });
    expect(persistedEpochs).toEqual([9]);
  });

  it.each(['budget-exhausted', 'concurrent-change'] as const)(
    'does not create or summarize a reconcile run when reset returns %s',
    async (status) => {
      const mutations: string[] = [];
      const lease = availableLease();
      const store = memoryStore({
        async startRun() { mutations.push('start'); return 'started' as const; },
        async resetForReconciliation() {
          return { status, dataWrites: 0, commandUsed: 4, dailyUsed: 40 };
        },
        async summarizeRun() { mutations.push('summary'); },
      }, checkpoint({ stage: 'complete' }));

      const summary = await runRecipeMigration('reconcile', {
        scanner: { async scanRecipes() { mutations.push('scan'); return []; } },
        store, lease: lease.lease, now: () => runTimestamp,
      }, { runId: `run-reset-${status}` });

      expect(summary).toMatchObject({
        status,
        dataWrites: 0,
        commandUsed: 4,
        dailyUsed: 40,
        counts: { concurrentChanges: status === 'concurrent-change' ? 1 : 0 },
      });
      expect(mutations).toEqual([]);
      expect(lease.released()).toBe(1);
    },
  );

  it('dry-run produces a stable sorted legacy-ID hash and counts with zero mutations', async () => {
    const mutations: string[] = [];
    const store = memoryStore({
      async loadCheckpoint() { mutations.push('checkpoint'); return checkpoint(); },
      async startRun() { mutations.push('start'); return 'started' as const; },
      async commitRecipe() { mutations.push('commit'); return transaction(); },
      async advanceRecipeCursor() { mutations.push('advance'); return { status: 'committed', dataWrites: 1, commandUsed: 1, dailyUsed: 1 }; },
      async completeRecipes() { mutations.push('complete'); return { status: 'committed', dataWrites: 1, commandUsed: 1, dailyUsed: 1 }; },
      async resetForReconciliation() { mutations.push('reset'); return { status: 'committed', dataWrites: 1, commandUsed: 1, dailyUsed: 1 }; },
      async summarizeRun() { mutations.push('summary'); },
    });
    const scans = (ids: string[]): RecipeMigrationScanner => ({
      async scanRecipes(afterId) {
        if (afterId !== null) return [];
        return ids.map((id) => id === 'v2'
          ? document(id, { schemaVersion: 2 })
          : document(id, id === 'bad'
            ? legacyRecipe(id, { sourceUrl: 'not a URL' })
            : legacyRecipe(id)));
      },
    });
    let leaseCalls = 0;
    const lease = {
      async acquire() { leaseCalls += 1; return true; },
      async renew() { leaseCalls += 1; return true; },
      async release() { leaseCalls += 1; },
    };

    const first = await runRecipeMigration('dry-run', {
      scanner: scans(['b', 'v2', 'bad', 'a']), store, lease, now: () => runTimestamp,
    }, { runId: 'dry-one' });
    const second = await runRecipeMigration('dry-run', {
      scanner: scans(['bad', 'a', 'b', 'v2']), store, lease, now: () => runTimestamp,
    }, { runId: 'dry-two' });

    expect(first.legacyIdHash).toBe(second.legacyIdHash);
    expect(first).toMatchObject({
      status: 'complete', dataWrites: 0, commandUsed: 0, dailyUsed: 0,
      counts: { scanned: 4, skippedV2: 1, migrated: 2, failed: 1, ready: 2 },
      bySource: { recipetineats: 2, unknown: 1 },
      byStatus: { ready: 2, failed: 1 },
      byFailureReason: { 'invalid-source-url': 1 },
    });
    expect(mutations).toEqual([]);
    expect(leaseCalls).toBe(0);
  });
});
