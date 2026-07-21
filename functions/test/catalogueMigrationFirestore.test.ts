import { describe, expect, it } from 'vitest';

import { convertLegacyRecipe } from '../src/catalogue/migration.js';
import {
  firestoreRecipeMigrationScanner,
  firestoreRecipeMigrationStore,
} from '../src/catalogue/migrationFirestore.js';
import type { CommitRecipeInput, MigrationCheckpoint, ScannedDocument } from '../src/catalogue/migrationEngine.js';

const timestamp = '2026-07-19T08:00:00.000Z';
const transactionTimeMs = Date.parse(timestamp);
const quotaDate = '2026-07-19';

function legacyRecipe(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Soup', sourceUrl: 'https://www.recipetineats.com/soup', totalTime: '30 minutes',
    originalServings: 4, course: 'Dinner', cuisine: 'Mediterranean',
    ingredients: [{ name: 'Onion', quantity: 1 }], instructions: [{ text: 'Cook.' }],
    ...overrides,
  };
}

type Stored = { data: Record<string, unknown>; updateTime: string };

class Ref {
  constructor(readonly path: string, private readonly db: FakeFirestore) {}
  collection(name: string) { return new Collection(`${this.path}/${name}`, this.db); }
  async get() { return this.db.snapshot(this); }
  async set(data: Record<string, unknown>, options?: { merge?: boolean }) {
    const prior = this.db.documents.get(this.path)?.data ?? {};
    this.db.put(this.path, options?.merge ? { ...prior, ...data } : data);
  }
}

class Collection {
  constructor(readonly path: string, private readonly db: FakeFirestore) {}
  doc(id: string) { return new Ref(`${this.path}/${id}`, this.db); }
  orderBy(field: unknown) { this.db.queryLog.push(['orderBy', field]); return new Query(this, this.db); }
}

class Query {
  private after?: unknown;
  private maximum = 0;
  constructor(private readonly collection: Collection, private readonly db: FakeFirestore) {}
  startAfter(value: unknown) { this.after = value; this.db.queryLog.push(['startAfter', value]); return this; }
  limit(value: number) { this.maximum = value; this.db.queryLog.push(['limit', value]); return this; }
  async get() {
    const prefix = `${this.collection.path}/`;
    const docs = [...this.db.documents.keys()]
      .filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
      .map((path) => this.db.snapshot(new Ref(path, this.db)))
      .filter((doc) => this.after === undefined || doc.id > this.after)
      .sort((a, b) => a.id.localeCompare(b.id)).slice(0, this.maximum);
    return { docs, size: docs.length };
  }
}

type Operation = { kind: 'set' | 'merge'; path: string; data: Record<string, unknown> };
class Transaction {
  readonly operations: Operation[] = [];
  private wrote = false;
  constructor(private readonly db: FakeFirestore) {}
  async getAll(...refs: Ref[]) {
    if (this.wrote) throw new Error('read-after-write');
    this.db.readBatches.push(refs.map((ref) => ref.path));
    return refs.map((ref) => this.db.snapshot(ref));
  }
  set(ref: Ref, data: Record<string, unknown>, options?: { merge?: boolean }) {
    this.wrote = true;
    this.operations.push({ kind: options?.merge ? 'merge' : 'set', path: ref.path, data: structuredClone(data) });
  }
  update(ref: Ref, data: Record<string, unknown>) { this.set(ref, data, { merge: true }); }
  apply() {
    for (const operation of this.operations) {
      const prior = this.db.documents.get(operation.path)?.data ?? {};
      this.db.put(operation.path, operation.kind === 'merge' ? { ...prior, ...operation.data } : operation.data);
    }
  }
}

class FakeFirestore {
  readonly documents = new Map<string, Stored>();
  readonly queryLog: unknown[][] = [];
  readonly readBatches: string[][] = [];
  readonly attempts: Transaction[] = [];
  retry = false;
  private version = 0;
  collection(path: string) { return new Collection(path, this); }
  doc(path: string) { return new Ref(path, this); }
  put(path: string, data: Record<string, unknown>, updateTime = `v${++this.version}`) {
    this.documents.set(path, { data: structuredClone(data), updateTime });
  }
  snapshot(ref: Ref) {
    const stored = this.documents.get(ref.path);
    return {
      id: ref.path.split('/').at(-1) as string, ref, exists: Boolean(stored),
      updateTime: stored ? { valueOf: () => stored.updateTime } : undefined,
      data: () => stored ? structuredClone(stored.data) : undefined,
      get: (field: string) => stored?.data[field],
    };
  }
  async runTransaction<T>(callback: (transaction: Transaction) => Promise<T>) {
    if (this.retry) { const first = new Transaction(this); this.attempts.push(first); await callback(first); }
    const transaction = new Transaction(this); this.attempts.push(transaction);
    const result = await callback(transaction); transaction.apply(); return result;
  }
}

function checkpoint(overrides: Partial<MigrationCheckpoint> = {}): MigrationCheckpoint {
  return {
    schemaVersion: 1, epoch: 0, stage: 'recipes', recipeCursorId: null,
    mealPlanCursorPath: null, cookbookCursorPath: null, completedStages: [],
    lastRunId: null, updatedAt: timestamp, ...overrides,
  };
}

function seed(db: FakeFirestore, runId = 'run-1', consumedWrites = 0, dailyUsed = 0) {
  db.put('catalogueOps/lease', { ownerId: runId, expiresAtMs: transactionTimeMs + 60_000 });
  db.put('catalogueMigrationCheckpoints/phase3', checkpoint());
  db.put(`catalogueMigrationRuns/${runId}`, {
    schemaVersion: 1, runId, command: 'migrate-recipes', epoch: 0,
    commandCap: 10, dailyLimit: 100, consumedWrites, status: 'running', quotaDate,
    startedAt: timestamp,
  });
  db.put(`catalogueBudgets/${quotaDate}`, { quotaDate, used: dailyUsed, limit: 18_000 });
}

function scanned(db: FakeFirestore): ScannedDocument {
  const stored = db.documents.get('recipes/legacy-1') as Stored;
  return { path: 'recipes/legacy-1', id: 'legacy-1', data: stored.data, updateTime: stored.updateTime };
}

function input(db: FakeFirestore, overrides: Partial<CommitRecipeInput> = {}): CommitRecipeInput {
  const document = scanned(db);
  return {
    runId: 'run-1', epoch: 0, document, scannedUpdateTime: document.updateTime,
    conversion: convertLegacyRecipe({ legacyRecipeId: document.id, data: document.data, runId: 'run-1', timestamp }),
    commandCap: 10, dailyLimit: 100, quotaDate, transactionTimeMs, ...overrides,
  };
}

function successfulMapping(commit: CommitRecipeInput, overrides: Record<string, unknown> = {}) {
  if (commit.conversion.kind !== 'success') throw new Error('fixture');
  return {
    schemaVersion: 1, legacyRecipeId: commit.document.id, state: 'migrated',
    canonicalRecipeId: commit.conversion.mapping.canonicalRecipeId,
    sourceKey: commit.conversion.mapping.sourceKey,
    contentHash: commit.conversion.mapping.contentHash,
    targetStatus: commit.conversion.mapping.targetStatus,
    reasonCodes: commit.conversion.mapping.reasonCodes,
    firstRunId: 'older-run', lastEvaluatedRunId: 'older-run',
    createdAt: timestamp, updatedAt: timestamp,
    ...overrides,
  };
}

describe('Firestore recipe migration scanner', () => {
  it('orders root recipes by document ID, resumes after the cursor, and serializes update time', async () => {
    const db = new FakeFirestore();
    db.put('recipes/a', { title: 'A' }, 'update-a'); db.put('recipes/b', { title: 'B' }, 'update-b');

    const result = await firestoreRecipeMigrationScanner(db as never, '__name__' as never).scanRecipes('a', 1);

    expect(db.queryLog).toEqual([['orderBy', '__name__'], ['startAfter', 'a'], ['limit', 1]]);
    expect(result).toEqual([{ path: 'recipes/b', id: 'b', updateTime: 'update-b', data: { title: 'B' } }]);
  });
});

describe('Firestore recipe migration transaction store', () => {
  it('starts idempotently under the lease and persists only bounded summary fields', async () => {
    const db = new FakeFirestore(); seed(db);
    db.documents.delete('catalogueMigrationRuns/run-1');
    const store = firestoreRecipeMigrationStore(db as never, 'run-1');
    const start = {
      runId: 'run-1', command: 'migrate-recipes' as const, epoch: 0, startCursor: null,
      commandCap: 10, dailyLimit: 100, startedAt: timestamp, quotaDate, transactionTimeMs,
    };
    expect(await store.startRun(start)).toBe('started');
    expect(await store.startRun(start)).toBe('noop');
    expect(db.documents.get('catalogueMigrationRuns/run-1')?.data.schemaVersion).toBe(1);

    await store.summarizeRun('run-1', {
      runId: 'run-1', command: 'migrate-recipes', status: 'complete', startCursor: null,
      endCursor: 'legacy-1', epoch: 0, commandCap: 10, dailyLimit: 100,
      dataWrites: 2, commandUsed: 2, dailyUsed: 2, startedAt: timestamp,
      completedAt: timestamp, cleanupErrors: [],
      counts: { scanned: 1, skippedV2: 0, migrated: 1, linkedExisting: 0, failed: 0, ready: 1, review: 0, noops: 0, concurrentChanges: 0 },
    });
    const persisted = db.documents.get('catalogueMigrationRuns/run-1')?.data ?? {};
    expect(persisted).toMatchObject({ runId: 'run-1', status: 'complete', consumedWrites: 2 });
    expect(persisted.schemaVersion).toBe(1);
    expect(JSON.stringify(persisted)).not.toContain('https://');
  });

  it('initializes an absent epoch-zero checkpoint at start and rejects racy or mismatched replays', async () => {
    const db = new FakeFirestore(); seed(db); db.documents.delete('catalogueMigrationCheckpoints/phase3');
    db.documents.delete('catalogueMigrationRuns/run-1');
    const store = firestoreRecipeMigrationStore(db as never, 'run-1');
    const start = {
      runId: 'run-1', command: 'migrate-recipes' as const, epoch: 0, startCursor: null,
      commandCap: 10, dailyLimit: 100, startedAt: timestamp, quotaDate, transactionTimeMs,
    };
    expect(await store.startRun(start)).toBe('started');
    expect(db.documents.get('catalogueMigrationCheckpoints/phase3')?.data).toMatchObject({
      schemaVersion: 1, epoch: 0, stage: 'recipes', recipeCursorId: null,
    });
    expect(await store.startRun(start)).toBe('noop');

    db.put('catalogueMigrationCheckpoints/phase3', checkpoint({ recipeCursorId: 'raced' }));
    db.put('catalogueOps/lease', { ownerId: 'run-2', expiresAtMs: transactionTimeMs + 1 });
    expect(await firestoreRecipeMigrationStore(db as never, 'run-2').startRun({ ...start, runId: 'run-2' }))
      .toBe('concurrent-change');

    db.put('catalogueMigrationCheckpoints/phase3', checkpoint());
    db.put('catalogueMigrationRuns/run-3', {
      schemaVersion: 1, runId: 'run-3', command: 'migrate-recipes', epoch: 0,
      commandCap: 9, dailyLimit: 100, status: 'running', consumedWrites: 0, quotaDate,
      startedAt: timestamp,
    });
    db.put('catalogueOps/lease', { ownerId: 'run-3', expiresAtMs: transactionTimeMs + 1 });
    expect(await firestoreRecipeMigrationStore(db as never, 'run-3').startRun({ ...start, runId: 'run-3' }))
      .toBe('concurrent-change');
  });

  it('creates target and mapping atomically and accounts exactly two data writes', async () => {
    const db = new FakeFirestore(); seed(db); db.put('recipes/legacy-1', legacyRecipe(), 'scan-v1');
    const commit = input(db); if (commit.conversion.kind !== 'success') throw new Error('fixture');

    const outcome = await firestoreRecipeMigrationStore(db as never, 'run-1').commitRecipe(commit);

    expect(outcome).toMatchObject({ status: 'committed', disposition: 'migrated', dataWrites: 2, commandUsed: 2, dailyUsed: 2 });
    expect(db.documents.get(`recipes/${commit.conversion.recipe.id}`)?.data).toEqual(commit.conversion.recipe);
    expect(db.documents.get('catalogueRecipeMigrations/legacy-1')?.data).toMatchObject({
      schemaVersion: 1, legacyRecipeId: 'legacy-1', canonicalRecipeId: commit.conversion.recipe.id, sourceKey: 'recipetineats',
      targetStatus: 'ready', state: 'migrated', reasonCodes: [], firstRunId: 'run-1',
      lastEvaluatedRunId: 'run-1', createdAt: timestamp, updatedAt: timestamp,
    });
    expect(db.documents.get('catalogueMigrationCheckpoints/phase3')?.data.recipeCursorId).toBe('legacy-1');
    expect(db.documents.get('catalogueMigrationRuns/run-1')?.data.consumedWrites).toBe(2);
    expect(db.documents.get(`catalogueBudgets/${quotaDate}`)?.data.used).toBe(2);
    expect(db.documents.get(`catalogueBudgets/${quotaDate}`)?.data.limit).toBe(18_000);
  });

  it('enforces a lower invocation daily cap without lowering the shared global budget limit', async () => {
    const db = new FakeFirestore(); seed(db); db.put('recipes/legacy-1', legacyRecipe(), 'scan-v1');
    db.put(`catalogueBudgets/${quotaDate}`, { quotaDate, used: 5, limit: 7 });
    db.put('catalogueMigrationRuns/run-1', {
      schemaVersion: 1, runId: 'run-1', command: 'migrate-recipes', epoch: 0,
      commandCap: 10, dailyLimit: 10, consumedWrites: 0, status: 'running', quotaDate,
    });

    const outcome = await firestoreRecipeMigrationStore(db as never, 'run-1').commitRecipe(
      input(db, { dailyLimit: 10 }),
    );

    expect(outcome).toMatchObject({ status: 'committed', dailyUsed: 7 });
    expect(db.documents.get(`catalogueBudgets/${quotaDate}`)?.data).toMatchObject({ used: 7, limit: 18_000 });
  });

  it.each([
    ['quota date', { quotaDate: '2026-07-18', used: 0, limit: 18_000 }],
    ['fractional used', { quotaDate, used: 1.5, limit: 18_000 }],
    ['negative used', { quotaDate, used: -1, limit: 18_000 }],
    ['used over global cap', { quotaDate, used: 18_001, limit: 18_000 }],
    ['missing limit', { quotaDate, used: 0 }],
    ['invalid limit', { quotaDate, used: 0, limit: 18_001 }],
  ])('rejects an existing budget with corrupt %s without writes', async (_label, budget) => {
    const db = new FakeFirestore(); seed(db); db.put('recipes/legacy-1', legacyRecipe(), 'scan-v1');
    db.put(`catalogueBudgets/${quotaDate}`, budget);
    const outcome = await firestoreRecipeMigrationStore(db as never, 'run-1').commitRecipe(input(db));
    expect(outcome).toMatchObject({ status: 'concurrent-change', dataWrites: 0 });
    expect(db.attempts.at(-1)?.operations).toEqual([]);
    expect(db.documents.get('catalogueMigrationCheckpoints/phase3')?.data.recipeCursorId).toBeNull();
  });

  it('accepts an absent budget as zero usage and creates it at the global limit', async () => {
    const db = new FakeFirestore(); seed(db); db.put('recipes/legacy-1', legacyRecipe(), 'scan-v1');
    db.documents.delete(`catalogueBudgets/${quotaDate}`);
    const outcome = await firestoreRecipeMigrationStore(db as never, 'run-1').commitRecipe(input(db));
    expect(outcome).toMatchObject({ status: 'committed', dailyUsed: 2 });
    expect(db.documents.get(`catalogueBudgets/${quotaDate}`)?.data).toMatchObject({
      quotaDate, used: 2, limit: 18_000,
    });
  });

  it('links a matching target with one write, records collisions/failures with one, and noops terminal mappings with zero', async () => {
    const make = (overrides: Record<string, unknown> = {}) => {
      const db = new FakeFirestore(); seed(db); db.put('recipes/legacy-1', legacyRecipe(overrides), 'scan-v1'); return db;
    };
    const linked = make(); const linkedInput = input(linked);
    if (linkedInput.conversion.kind !== 'success') throw new Error('fixture');
    const targetPath = `recipes/${linkedInput.conversion.recipe.id}`;
    const existing = { schemaVersion: 2, source: { canonicalUrl: linkedInput.conversion.recipe.source.canonicalUrl }, keep: true };
    linked.put(targetPath, existing);
    expect(await firestoreRecipeMigrationStore(linked as never, 'run-1').commitRecipe(linkedInput))
      .toMatchObject({ status: 'committed', disposition: 'linked-existing', dataWrites: 1 });
    expect(linked.documents.get(targetPath)?.data).toEqual(existing);

    const collision = make(); const collisionInput = input(collision);
    if (collisionInput.conversion.kind !== 'success') throw new Error('fixture');
    collision.put(`recipes/${collisionInput.conversion.recipe.id}`, { occupied: true });
    expect(await firestoreRecipeMigrationStore(collision as never, 'run-1').commitRecipe(collisionInput))
      .toMatchObject({ status: 'committed', disposition: 'failed', dataWrites: 1 });
    expect(collision.documents.get('catalogueRecipeMigrations/legacy-1')?.data).toMatchObject({
      state: 'failed', reasonCodes: ['canonical-id-collision'], targetStatus: null,
    });

    const failed = make({ sourceUrl: 'invalid' });
    expect(await firestoreRecipeMigrationStore(failed as never, 'run-1').commitRecipe(input(failed)))
      .toMatchObject({ status: 'committed', disposition: 'failed', dataWrites: 1 });
    expect(failed.documents.get('catalogueRecipeMigrations/legacy-1')?.data).toMatchObject({
      canonicalRecipeId: null, sourceKey: null, targetStatus: null, contentHash: null,
    });

    const noop = make(); const noopInput = input(noop);
    if (noopInput.conversion.kind !== 'success') throw new Error('fixture');
    noop.put(`recipes/${noopInput.conversion.recipe.id}`, noopInput.conversion.recipe);
    noop.put('catalogueRecipeMigrations/legacy-1', {
      schemaVersion: 1, legacyRecipeId: 'legacy-1', state: 'migrated',
      canonicalRecipeId: noopInput.conversion.mapping.canonicalRecipeId,
      sourceKey: noopInput.conversion.mapping.sourceKey,
      contentHash: noopInput.conversion.mapping.contentHash,
      targetStatus: noopInput.conversion.mapping.targetStatus, reasonCodes: [],
      firstRunId: 'older-run', lastEvaluatedRunId: 'older-run',
      createdAt: timestamp, updatedAt: timestamp,
    });
    expect(await firestoreRecipeMigrationStore(noop as never, 'run-1').commitRecipe(noopInput))
      .toMatchObject({ status: 'noop', dataWrites: 0, commandUsed: 0, dailyUsed: 0 });
    expect(noop.documents.get('catalogueMigrationCheckpoints/phase3')?.data.recipeCursorId).toBe('legacy-1');
  });

  it('rejects concurrent changes, lost leases, and either exhausted cap with zero writes', async () => {
    const cases: Array<[string, (db: FakeFirestore) => Partial<CommitRecipeInput> | void, string]> = [
      ['concurrent', (db) => { db.put('recipes/legacy-1', legacyRecipe({ title: 'changed' }), 'scan-v2'); }, 'concurrent-change'],
      ['missing legacy', (db) => { db.documents.delete('recipes/legacy-1'); }, 'concurrent-change'],
      ['lost lease', (db) => { db.put('catalogueOps/lease', { ownerId: 'other', expiresAtMs: transactionTimeMs + 1 }); }, 'lease-lost'],
      ['expired lease', (db) => { db.put('catalogueOps/lease', { ownerId: 'run-1', expiresAtMs: transactionTimeMs }); }, 'lease-lost'],
      ['command cap', (db) => {
        db.put('catalogueMigrationRuns/run-1', {
          schemaVersion: 1, runId: 'run-1', command: 'migrate-recipes', epoch: 0,
          commandCap: 1, dailyLimit: 100, consumedWrites: 0, status: 'running', quotaDate,
        });
        return { commandCap: 1 };
      }, 'budget-exhausted'],
      ['daily cap', (db) => {
        db.put(`catalogueBudgets/${quotaDate}`, { quotaDate, used: 99, limit: 18_000 });
        return { dailyLimit: 100 };
      }, 'budget-exhausted'],
    ];
    for (const [_label, arrange, status] of cases) {
      const db = new FakeFirestore(); seed(db); db.put('recipes/legacy-1', legacyRecipe(), 'scan-v1');
      const commit = input(db); const overrides = arrange(db) ?? {};
      const outcome = await firestoreRecipeMigrationStore(db as never, 'run-1').commitRecipe({ ...commit, ...overrides });
      expect(outcome).toMatchObject({ status, dataWrites: 0 });
      expect(db.attempts.at(-1)?.operations).toEqual([]);
      expect(db.documents.get('catalogueMigrationCheckpoints/phase3')?.data.recipeCursorId).toBeNull();
    }
  });

  it('rejects a missing or mismatched authoritative run on every atomic recipe path', async () => {
    const make = () => { const db = new FakeFirestore(); seed(db); db.put('recipes/legacy-1', legacyRecipe(), 'scan-v1'); return db; };
    const commitDb = make(); const commit = input(commitDb); commitDb.documents.delete('catalogueMigrationRuns/run-1');
    expect(await firestoreRecipeMigrationStore(commitDb as never, 'run-1').commitRecipe(commit))
      .toMatchObject({ status: 'concurrent-change', dataWrites: 0 });

    const advanceDb = make(); advanceDb.put('recipes/legacy-1', { schemaVersion: 2 }, 'scan-v1');
    advanceDb.put('catalogueMigrationRuns/run-1', {
      schemaVersion: 2, runId: 'run-1', command: 'migrate-recipes', epoch: 0,
      commandCap: 10, dailyLimit: 100, consumedWrites: 0, status: 'running', quotaDate,
    });
    const document = scanned(advanceDb);
    expect(await firestoreRecipeMigrationStore(advanceDb as never, 'run-1').advanceRecipeCursor({
      runId: 'run-1', epoch: 0, document, scannedUpdateTime: document.updateTime,
      reason: 'schema-v2', commandCap: 10, dailyLimit: 100, quotaDate, transactionTimeMs,
    })).toMatchObject({ status: 'concurrent-change', dataWrites: 0 });

    const completeDb = make();
    completeDb.put('catalogueMigrationRuns/run-1', {
      schemaVersion: 1, runId: 'run-1', command: 'migrate-recipes', epoch: 0,
      commandCap: 9, dailyLimit: 100, consumedWrites: 0, status: 'running', quotaDate,
    });
    expect(await firestoreRecipeMigrationStore(completeDb as never, 'run-1').completeRecipes({
      runId: 'run-1', epoch: 0, cursorId: null, updatedAt: timestamp,
      commandCap: 10, dailyLimit: 100, quotaDate, transactionTimeMs,
    })).toMatchObject({ status: 'concurrent-change', dataWrites: 0 });
  });

  it.each([
    ['cross-linked', { schemaVersion: 1, legacyRecipeId: 'other', state: 'migrated', canonicalRecipeId: 'id', sourceKey: 'source', contentHash: 'hash', targetStatus: 'ready', reasonCodes: [] }],
    ['malformed success', { schemaVersion: 1, legacyRecipeId: 'legacy-1', state: 'linked-existing', canonicalRecipeId: null, sourceKey: 'source', contentHash: 'hash', targetStatus: 'ready', reasonCodes: [] }],
    ['unbounded failure', { schemaVersion: 1, legacyRecipeId: 'legacy-1', state: 'failed', canonicalRecipeId: null, sourceKey: null, contentHash: null, targetStatus: null, reasonCodes: ['not-bounded'] }],
  ])('rejects a %s terminal mapping without advancing or overwriting it', async (_label, mapping) => {
    const db = new FakeFirestore(); seed(db); db.put('recipes/legacy-1', legacyRecipe(), 'scan-v1');
    db.put('catalogueRecipeMigrations/legacy-1', mapping);
    const outcome = await firestoreRecipeMigrationStore(db as never, 'run-1').commitRecipe(input(db));
    expect(outcome).toMatchObject({ status: 'concurrent-change', dataWrites: 0 });
    expect(db.documents.get('catalogueMigrationCheckpoints/phase3')?.data.recipeCursorId).toBeNull();
    expect(db.documents.get('catalogueRecipeMigrations/legacy-1')?.data).toEqual(mapping);
  });

  it.each([
    ['canonical ID', { canonicalRecipeId: 'wrong-id' }],
    ['source', { sourceKey: 'wrong-source' }],
    ['content hash', { contentHash: 'wrong-hash' }],
    ['target status', { targetStatus: 'review' }],
  ])('rejects a terminal mapping with stale %s', async (_label, stale) => {
    const db = new FakeFirestore(); seed(db); db.put('recipes/legacy-1', legacyRecipe(), 'scan-v1');
    const commit = input(db); if (commit.conversion.kind !== 'success') throw new Error('fixture');
    db.put(`recipes/${commit.conversion.recipe.id}`, commit.conversion.recipe);
    const mapping = successfulMapping(commit, stale);
    db.put('catalogueRecipeMigrations/legacy-1', mapping);
    const outcome = await firestoreRecipeMigrationStore(db as never, 'run-1').commitRecipe(commit);
    expect(outcome).toMatchObject({ status: 'concurrent-change', dataWrites: 0 });
    expect(db.documents.get('catalogueRecipeMigrations/legacy-1')?.data).toEqual(mapping);
  });

  it.each(['missing', 'mismatched'] as const)('rejects a successful terminal mapping with a %s target', async (targetState) => {
    const db = new FakeFirestore(); seed(db); db.put('recipes/legacy-1', legacyRecipe(), 'scan-v1');
    const commit = input(db); if (commit.conversion.kind !== 'success') throw new Error('fixture');
    if (targetState === 'mismatched') {
      db.put(`recipes/${commit.conversion.recipe.id}`, { schemaVersion: 2, source: { canonicalUrl: 'https://example.com/wrong' } });
    }
    db.put('catalogueRecipeMigrations/legacy-1', successfulMapping(commit));
    expect(await firestoreRecipeMigrationStore(db as never, 'run-1').commitRecipe(commit))
      .toMatchObject({ status: 'concurrent-change', dataWrites: 0 });
  });

  it('rejects a stale failed mapping whose proposal no longer matches', async () => {
    const db = new FakeFirestore(); seed(db); db.put('recipes/legacy-1', legacyRecipe({ sourceUrl: 'invalid' }), 'scan-v1');
    const commit = input(db);
    db.put('catalogueRecipeMigrations/legacy-1', {
      schemaVersion: 1, legacyRecipeId: 'legacy-1', state: 'failed',
      canonicalRecipeId: null, sourceKey: null, contentHash: null, targetStatus: null,
      reasonCodes: ['unsupported-source'], firstRunId: 'older', lastEvaluatedRunId: 'older',
      createdAt: timestamp, updatedAt: timestamp,
    });
    expect(await firestoreRecipeMigrationStore(db as never, 'run-1').commitRecipe(commit))
      .toMatchObject({ status: 'concurrent-change', dataWrites: 0 });
  });

  it('noops a live collision mapping and rejects it after the target no longer collides', async () => {
    const db = new FakeFirestore(); seed(db); db.put('recipes/legacy-1', legacyRecipe(), 'scan-v1');
    const commit = input(db); if (commit.conversion.kind !== 'success') throw new Error('fixture');
    const targetPath = `recipes/${commit.conversion.recipe.id}`;
    db.put(targetPath, { schemaVersion: 2, source: { canonicalUrl: 'https://example.com/occupied' } });
    db.put('catalogueRecipeMigrations/legacy-1', successfulMapping(commit, {
      state: 'failed', targetStatus: null, reasonCodes: ['canonical-id-collision'],
    }));
    expect(await firestoreRecipeMigrationStore(db as never, 'run-1').commitRecipe(commit))
      .toMatchObject({ status: 'noop', dataWrites: 0 });

    db.put(targetPath, commit.conversion.recipe);
    expect(await firestoreRecipeMigrationStore(db as never, 'run-1').commitRecipe(commit))
      .toMatchObject({ status: 'concurrent-change', dataWrites: 0 });
  });

  it.each([
    ['negative epoch', checkpoint({ epoch: -1 })],
    ['duplicate stages', checkpoint({ completedStages: ['recipes', 'recipes'] })],
    ['unknown stage history', checkpoint({ completedStages: ['unknown' as never] })],
    ['out of order', checkpoint({ completedStages: ['meal-plans', 'recipes'] })],
    ['inconsistent stage', checkpoint({ completedStages: ['recipes'] })],
  ])('rejects a checkpoint with %s without writes', async (_label, invalidCheckpoint) => {
    const db = new FakeFirestore(); seed(db); db.put('recipes/legacy-1', legacyRecipe(), 'scan-v1');
    db.put('catalogueMigrationCheckpoints/phase3', invalidCheckpoint);
    const outcome = await firestoreRecipeMigrationStore(db as never, 'run-1').commitRecipe(input(db));
    expect(outcome).toMatchObject({ status: 'concurrent-change', dataWrites: 0 });
    expect(db.attempts.at(-1)?.operations).toEqual([]);
  });

  it('performs all reads before writes and emits identical operations on a retry', async () => {
    const db = new FakeFirestore(); seed(db); db.put('recipes/legacy-1', legacyRecipe(), 'scan-v1'); db.retry = true;
    await firestoreRecipeMigrationStore(db as never, 'run-1').commitRecipe(input(db));
    expect(db.attempts).toHaveLength(2);
    expect(db.attempts[1].operations).toEqual(db.attempts[0].operations);
    expect(db.readBatches.every((batch) => batch.includes('catalogueOps/lease'))).toBe(true);
  });

  it('advances v2 with zero accounting, completes recipes, and replays reconciliation reset without a second epoch', async () => {
    const db = new FakeFirestore(); seed(db, 'run-1', 3, 7); db.put('recipes/legacy-1', { schemaVersion: 2 }, 'scan-v1');
    const store = firestoreRecipeMigrationStore(db as never, 'run-1'); const document = scanned(db);
    expect(await store.advanceRecipeCursor({
      runId: 'run-1', epoch: 0, document, scannedUpdateTime: document.updateTime, reason: 'schema-v2',
      commandCap: 10, dailyLimit: 100, quotaDate, transactionTimeMs,
    })).toMatchObject({ status: 'committed', dataWrites: 0, commandUsed: 3, dailyUsed: 7 });
    expect(await store.completeRecipes({
      runId: 'run-1', epoch: 0, cursorId: 'legacy-1', updatedAt: timestamp,
      commandCap: 10, dailyLimit: 100, quotaDate, transactionTimeMs,
    })).toMatchObject({ status: 'committed', dataWrites: 0 });
    expect(db.documents.get('catalogueMigrationCheckpoints/phase3')?.data).toMatchObject({ stage: 'meal-plans', completedStages: ['recipes'] });

    db.put('catalogueMigrationCheckpoints/phase3', checkpoint({ epoch: 4, stage: 'complete', completedStages: ['recipes', 'meal-plans', 'cookbooks'] }));
    db.put('catalogueOps/lease', { ownerId: 'reconcile-run', expiresAtMs: transactionTimeMs + 1 });
    const reconcileStore = firestoreRecipeMigrationStore(db as never, 'reconcile-run');
    const resetInput = {
      runId: 'reconcile-run', command: 'reconcile' as const, previousEpoch: 4, startCursor: null,
      startedAt: timestamp, updatedAt: timestamp, commandCap: 10, dailyLimit: 100, quotaDate, transactionTimeMs,
    };
    const first = await reconcileStore.resetForReconciliation(resetInput);
    const replay = await reconcileStore.resetForReconciliation(resetInput);
    expect(first).toMatchObject({ status: 'committed', checkpoint: { epoch: 5, stage: 'recipes', recipeCursorId: null, completedStages: [] } });
    expect(replay).toMatchObject({ status: 'noop', checkpoint: { epoch: 5 } });
    expect('checkpoint' in first && 'checkpoint' in replay && replay.checkpoint).toEqual(
      'checkpoint' in first ? first.checkpoint : undefined,
    );
    expect(db.documents.get('catalogueMigrationCheckpoints/phase3')?.data.epoch).toBe(5);
    expect(db.documents.get('catalogueMigrationRuns/reconcile-run')?.data).toMatchObject({
      schemaVersion: 1, runId: 'reconcile-run', command: 'reconcile', previousEpoch: 4,
      epoch: 5, commandCap: 10, dailyLimit: 100, status: 'running',
    });
    db.put('catalogueMigrationRuns/reconcile-run', {
      ...(db.documents.get('catalogueMigrationRuns/reconcile-run')?.data ?? {}),
      commandCap: 9,
    });
    expect(await reconcileStore.resetForReconciliation(resetInput)).toMatchObject({
      status: 'concurrent-change', dataWrites: 0,
    });
    expect(db.documents.get('catalogueMigrationCheckpoints/phase3')?.data.epoch).toBe(5);
    expect(db.readBatches.every((batch) => batch.includes('catalogueOps/lease'))).toBe(true);
  });
});
