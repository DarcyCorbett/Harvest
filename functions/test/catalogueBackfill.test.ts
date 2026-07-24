import { describe, expect, it, vi } from 'vitest';

import {
  CLASSIFIER_VERSION,
  GeminiCallCapError,
  classifyStoredRecipe,
  createClassificationBackfillEngine,
  evaluateSourceCanary,
  mergeOperationalFailure,
  type ClassificationBackfillStore,
} from '../src/catalogue/backfill.js';
import {
  buildEffectiveMetadata,
  buildSearchFields,
  type CompleteCanonicalRecipeV2,
} from '../src/catalogue/domain.js';

function recipe(overrides: Partial<CompleteCanonicalRecipeV2> = {}): CompleteCanonicalRecipeV2 {
  const sourceMetadata = {
    totalMinutes: 30,
    mealTypes: ['dinner'] as const,
    cuisines: ['global'] as const,
    modifiers: [],
  };
  const effective = buildEffectiveMetadata(sourceMetadata);
  return {
    schemaVersion: 2,
    id: 'recipe-1',
    status: 'review',
    source: {
      key: 'recipetineats',
      canonicalUrl: 'https://www.recipetineats.com/recipe-1',
      originalUrl: 'https://www.recipetineats.com/recipe-1',
    },
    content: {
      title: 'Chicken dinner',
      originalServings: 4,
      ingredients: [{ name: 'Chicken' }],
      instructions: [{ text: 'Cook.' }],
    },
    sourceMetadata,
    manualOverrides: { totalMinutes: 25, updatedBy: 'editor' },
    effective,
    search: buildSearchFields(effective, ['Chicken'], 0.123),
    classification: {
      parserVersion: 0,
      taxonomyVersion: 1,
      sources: { mealTypes: 'source', cuisines: 'source', modifiers: 'rule' },
      complete: true,
    },
    ingestion: {
      contentHash: 'hash-1',
      firstIngestedAt: '2026-07-01T00:00:00.000Z',
      lastChangedAt: '2026-07-02T00:00:00.000Z',
    },
    ...overrides,
  };
}

describe('stored-content Phase 4 classification', () => {
  it('preserves content, overrides, parser version, timestamps, and random key', async () => {
    const original = recipe();
    const updated = await classifyStoredRecipe(original, async (_content, metadata) => ({
      metadata: { ...metadata, modifiers: ['healthy'] },
      sources: { mealTypes: 'rule', cuisines: 'rule', modifiers: 'rule' },
      complete: true,
    }));

    expect(updated.status).toBe('ready');
    expect(updated.content).toEqual(original.content);
    expect(updated.manualOverrides).toEqual(original.manualOverrides);
    expect(updated.search.randomKey).toBe(0.123);
    expect(updated.ingestion).toEqual(original.ingestion);
    expect(updated.classification).toMatchObject({
      parserVersion: 0,
      classifierVersion: CLASSIFIER_VERSION,
    });
    expect(updated.effective.totalMinutes).toBe(25);
  });

  it('keeps a successfully classified recipe in review when time is missing', async () => {
    const original = recipe({
      sourceMetadata: { mealTypes: [], cuisines: [], modifiers: [] },
      manualOverrides: undefined,
    });
    const updated = await classifyStoredRecipe(original, async () => ({
      metadata: { mealTypes: ['dinner'], cuisines: ['global'], modifiers: [] },
      sources: { mealTypes: 'ai', cuisines: 'ai', modifiers: 'rule' },
      complete: true,
    }));

    expect(updated.status).toBe('review');
    expect(updated.classification.classifierVersion).toBe(CLASSIFIER_VERSION);
  });

  it('preserves a complete recipe when a refresh fails operationally', () => {
    const original = recipe({ status: 'ready' });
    const preserved = mergeOperationalFailure(original, {
      lastAttemptAt: '2026-07-24T00:00:00.000Z',
      lastErrorCode: '403',
      retryCount: 2,
    });

    expect(preserved.status).toBe('ready');
    expect(preserved.content).toEqual(original.content);
    expect(preserved.classification.parserVersion).toBe(0);
    expect(preserved.ingestion).toMatchObject({
      contentHash: 'hash-1',
      lastChangedAt: '2026-07-02T00:00:00.000Z',
      lastErrorCode: '403',
      retryCount: 2,
    });
  });
});

describe('classification backfill engine', () => {
  function memoryStore(recipes: CompleteCanonicalRecipeV2[]): ClassificationBackfillStore & {
    writes: CompleteCanonicalRecipeV2[];
    cursor?: string;
  } {
    return {
      writes: [],
      cursor: undefined,
      async loadCursor() { return this.cursor; },
      async scan(afterId, limit) {
        return recipes
          .filter((candidate) => !afterId || candidate.id > afterId)
          .sort((left, right) => left.id.localeCompare(right.id))
          .slice(0, limit);
      },
      async writeClassified(_expected, updated) {
        this.writes.push(updated);
        return 'written';
      },
      async saveCursor(cursor) { this.cursor = cursor; },
      async recordError() {},
      async summarize() {},
    };
  }

  it('skips current documents and reruns without recipe writes', async () => {
    const current = recipe({
      id: 'recipe-1',
      classification: { ...recipe().classification, classifierVersion: 1 },
    });
    const stale = recipe({ id: 'recipe-2' });
    const store = memoryStore([current, stale]);
    const classify = vi.fn(async (_content, metadata) => ({
      metadata,
      sources: { mealTypes: 'source' as const, cuisines: 'source' as const, modifiers: 'rule' as const },
      complete: true,
    }));
    const engine = createClassificationBackfillEngine({
      store,
      lease: { acquire: async () => true, renew: async () => true, release: async () => {} },
      budget: { limit: 8_000, reserve: async () => ({ quotaDate: '2026-07-24', granted: 8_000, used: 8_000 }) },
      classify,
      getGeminiCalls: () => 0,
      now: () => new Date('2026-07-24T10:00:00.000Z'),
    });

    const first = await engine.run({
      runId: 'run-1', writeCap: 8_000, geminiCallCap: 500,
    });
    const second = await engine.run({
      runId: 'run-2', writeCap: 8_000, geminiCallCap: 500,
    });

    expect(first).toMatchObject({ status: 'complete', written: 1, skippedCurrent: 1 });
    expect(second).toMatchObject({ status: 'complete', written: 0 });
    expect(store.writes).toHaveLength(1);
  });

  it('stops cleanly without advancing past a recipe when the Gemini cap is reached', async () => {
    const store = memoryStore([recipe()]);
    const engine = createClassificationBackfillEngine({
      store,
      lease: { acquire: async () => true, renew: async () => true, release: async () => {} },
      budget: { limit: 8_000, reserve: async () => ({ quotaDate: '2026-07-24', granted: 8_000, used: 8_000 }) },
      classify: async () => { throw new GeminiCallCapError(); },
      getGeminiCalls: () => 500,
      now: () => new Date('2026-07-24T10:00:00.000Z'),
    });

    await expect(engine.run({
      runId: 'run-cap', writeCap: 8_000, geminiCallCap: 500,
    })).resolves.toMatchObject({ status: 'provider-cap-exhausted', written: 0 });
    expect(store.cursor).toBeUndefined();
  });

  it('resumes after the last committed recipe when the write cap is exhausted', async () => {
    const store = memoryStore([recipe({ id: 'recipe-1' }), recipe({ id: 'recipe-2' })]);
    let granted = 1;
    const engine = createClassificationBackfillEngine({
      store,
      lease: { acquire: async () => true, renew: async () => true, release: async () => {} },
      budget: {
        limit: 8_000,
        reserve: async () => ({ quotaDate: '2026-07-24', granted, used: granted }),
      },
      classify: async (_content, metadata) => ({
        metadata,
        sources: { mealTypes: 'source', cuisines: 'source', modifiers: 'rule' },
        complete: true,
      }),
      getGeminiCalls: () => 0,
      now: () => new Date('2026-07-24T10:00:00.000Z'),
    });

    const first = await engine.run({
      runId: 'run-first', writeCap: 8_000, geminiCallCap: 500, pageSize: 2,
    });
    granted = 1;
    const second = await engine.run({
      runId: 'run-second', writeCap: 8_000, geminiCallCap: 500, pageSize: 2,
    });

    expect(first).toMatchObject({
      status: 'write-cap-exhausted', written: 1, endCursor: 'recipe-1',
    });
    expect(second).toMatchObject({ status: 'complete', written: 1, endCursor: 'recipe-2' });
    expect(store.writes.map((value) => value.id)).toEqual(['recipe-1', 'recipe-2']);
  });

  it('does no scans or recipe writes when the shared lease is unavailable', async () => {
    const store = memoryStore([recipe()]);
    const scan = vi.spyOn(store, 'scan');
    const engine = createClassificationBackfillEngine({
      store,
      lease: { acquire: async () => false, renew: async () => false, release: async () => {} },
      budget: { limit: 8_000, reserve: vi.fn() },
      classify: vi.fn(),
      getGeminiCalls: () => 0,
      now: () => new Date('2026-07-24T10:00:00.000Z'),
    });

    await expect(engine.run({
      runId: 'run-lease', writeCap: 8_000, geminiCallCap: 500,
    })).resolves.toMatchObject({ status: 'lease-unavailable', written: 0 });
    expect(scan).not.toHaveBeenCalled();
    expect(store.writes).toHaveLength(0);
  });

  it('records a bounded failure and advances so one recipe cannot block the run', async () => {
    const store = memoryStore([recipe()]);
    const recordError = vi.spyOn(store, 'recordError');
    const engine = createClassificationBackfillEngine({
      store,
      lease: { acquire: async () => true, renew: async () => true, release: async () => {} },
      budget: { limit: 8_000, reserve: async () => ({ quotaDate: '2026-07-24', granted: 1, used: 1 }) },
      classify: async () => { throw new Error('provider unavailable'); },
      getGeminiCalls: () => 1,
      now: () => new Date('2026-07-24T10:00:00.000Z'),
    });

    await expect(engine.run({
      runId: 'run-failure', writeCap: 1, geminiCallCap: 500,
    })).resolves.toMatchObject({ status: 'complete', failed: 1, written: 0 });
    expect(recordError).toHaveBeenCalledWith('recipe-1', 'classification-failed');
    expect(store.cursor).toBe('recipe-1');
  });
});

describe('source refresh canary decisions', () => {
  it('allows one transient failure only when five samples are tested', () => {
    expect(evaluateSourceCanary(['success', 'success', 'success', 'success', 'transient']))
      .toBe('eligible');
    expect(evaluateSourceCanary(['success', 'success', 'transient']))
      .toBe('failed');
  });

  it('marks repeated protected responses unsupported and never treats them as transient', () => {
    expect(evaluateSourceCanary(['protected', 'protected', 'success', 'success', 'success']))
      .toBe('unsupported');
  });
});
