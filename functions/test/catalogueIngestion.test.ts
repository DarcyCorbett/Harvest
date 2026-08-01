import { describe, expect, it, vi } from 'vitest';

import { buildEffectiveMetadata, buildSearchFields, canonicalRecipeId, type CompleteCanonicalRecipeV2 } from '../src/catalogue/domain.js';
import {
  CatalogueIngestionStageError,
  createCatalogueIngestionEngine,
  mergeIngestedRecipe,
  saveVerifiedManifestObject,
  type CatalogueIngestionDependencies,
  type CatalogueRecipeStore,
} from '../src/catalogue/ingestion.js';
import type { CatalogueManifest } from '../src/catalogue/operations.js';
import type { RecipeSourceAdapter } from '../src/catalogue/sourceAdapters.js';

const HTML = `<script type="application/ld+json">${JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'Recipe',
  name: 'Chicken salad',
  recipeYield: '4 servings',
  totalTime: 'PT30M',
  recipeCategory: ['Dinner', 'Healthy', 'Salad'],
  recipeCuisine: 'Mediterranean',
  recipeIngredient: ['2 chicken breasts', 'olive oil'],
  recipeInstructions: [{ '@type': 'HowToStep', text: 'Cook the chicken.' }],
})}</script>`;

function adapter(sourceKey: string, urls: string[], fetch = vi.fn(async () => ({
  kind: 'ok' as const,
  html: HTML,
}))): RecipeSourceAdapter {
  return {
    sourceKey,
    canonicalize: (url) => url,
    async *discover() {
      for (let index = 0; index < urls.length; index += 1) {
        yield { url: urls[index], lastModified: '2026-07-01', cursor: `${sourceKey}-${index}` };
      }
    },
    fetch,
  };
}

function dependencies(adapters: RecipeSourceAdapter[], manifests: Record<string, CatalogueManifest> = {}) {
  const recipes: CompleteCanonicalRecipeV2[] = [];
  const operational: unknown[] = [];
  const recipeStore: CatalogueRecipeStore = {
    writeComplete: vi.fn(async (recipe) => { recipes.push(recipe); }),
    writeOperational: vi.fn(async (record) => { operational.push(record); }),
  };
  const savedManifests: CatalogueManifest[] = [];
  const summaries: unknown[] = [];
  const injected: CatalogueIngestionDependencies = {
    adapters,
    manifests: {
      load: vi.fn(async (sourceKey) => manifests[sourceKey] ?? {
        sourceKey, entries: {}, updatedAt: '2026-07-18T00:00:00.000Z',
      }),
      save: vi.fn(async (manifest) => { savedManifests.push(structuredClone(manifest)); }),
    },
    recipes: recipeStore,
    runs: {
      checkpoint: vi.fn(async () => undefined),
      summarize: vi.fn(async (_runId, summary) => { summaries.push(summary); }),
    },
    lease: {
      acquire: vi.fn(async () => true),
      renew: vi.fn(async () => true),
      release: vi.fn(async () => undefined),
    },
    budget: {
      limit: 18_000,
      reserve: vi.fn(async (requested) => ({
        quotaDate: '2026-07-18', granted: requested, used: requested,
      })),
    },
    now: () => new Date('2026-07-18T12:00:00.000Z'),
    random: () => 0.25,
  };
  return { injected, recipes, operational, savedManifests, summaries, recipeStore };
}

describe('catalogue ingestion engine', () => {
  it('skips unchanged manifest URLs without a page fetch or recipe write', async () => {
    const url = 'https://www.recipetineats.com/unchanged';
    const fetch = vi.fn();
    const source = adapter('recipetineats', [url], fetch);
    const key = canonicalRecipeId(url);
    const manifest: CatalogueManifest = {
      sourceKey: 'recipetineats',
      updatedAt: '2026-07-01T00:00:00.000Z',
      entries: {
        [key]: {
          urlHash: key,
          sourceLastModified: '2026-07-01',
          parserVersion: 1,
          lastFetchedAt: '2026-07-01T00:00:00.000Z',
          state: 'ready',
        },
      },
    };
    const { injected, recipeStore } = dependencies([source], { recipetineats: manifest });

    const result = await createCatalogueIngestionEngine(injected).run({ runId: 'run-1' });

    expect(result.metrics).toMatchObject({ unchanged: 1, fetched: 0, written: 0 });
    expect(fetch).not.toHaveBeenCalled();
    expect(recipeStore.writeComplete).not.toHaveBeenCalled();
  });

  it('never refetches an existing displayable recipe during a snapshot crawl', async () => {
    const url = 'https://www.recipetineats.com/existing';
    const fetch = vi.fn();
    const source = adapter('recipetineats', [url], fetch);
    const key = canonicalRecipeId(url);
    const { injected, recipeStore } = dependencies([source], {
      recipetineats: {
        sourceKey: 'recipetineats',
        updatedAt: '2026-07-01T00:00:00.000Z',
        entries: {
          [key]: {
            urlHash: key,
            sourceLastModified: '2025-01-01',
            parserVersion: 0,
            lastFetchedAt: '2025-01-01T00:00:00.000Z',
            state: 'ready',
          },
        },
      },
    });

    const result = await createCatalogueIngestionEngine(injected).run({
      runId: 'snapshot-existing',
      snapshotMode: true,
      parserVersion: 2,
    });

    expect(result.metrics).toMatchObject({ unchanged: 1, fetched: 0, written: 0 });
    expect(fetch).not.toHaveBeenCalled();
    expect(recipeStore.writeComplete).not.toHaveBeenCalled();
  });

  it('recovers a missing manifest entry from Firestore without refetching the recipe', async () => {
    const url = 'https://www.recipetineats.com/recovered';
    const fetch = vi.fn();
    const source = adapter('recipetineats', [url], fetch);
    const { injected, recipeStore } = dependencies([source]);
    recipeStore.recoverManifestEntry = vi.fn(async (recipeId) => ({
      urlHash: recipeId,
      sourceLastModified: '2026-07-01',
      parserVersion: 1,
      lastFetchedAt: '2026-07-01T00:00:00.000Z',
      state: 'ready',
    }));

    const result = await createCatalogueIngestionEngine(injected).run({ runId: 'run-recovery' });

    expect(recipeStore.recoverManifestEntry).toHaveBeenCalledWith(canonicalRecipeId(url));
    expect(result.metrics).toMatchObject({ unchanged: 1, fetched: 0, written: 0 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('parses and classifies before a single complete recipe write', async () => {
    const url = 'https://www.recipetineats.com/chicken-salad';
    const source = adapter('recipetineats', [url]);
    const { injected, recipes, recipeStore } = dependencies([source]);

    const result = await createCatalogueIngestionEngine(injected).run({ runId: 'run-2' });

    expect(recipeStore.writeComplete).toHaveBeenCalledOnce();
    expect(recipes[0]).toMatchObject({
      schemaVersion: 2,
      id: canonicalRecipeId(url),
      status: 'ready',
      source: { key: 'recipetineats', canonicalUrl: url },
      search: { salad: true, quick30: true, moderate45: true },
    });
    expect(result.metrics).toMatchObject({ fetched: 1, parsed: 1, classified: 1, written: 1 });
  });

  it('stores unresolved deterministic crawl content as review at classifier version zero', async () => {
    const url = 'https://www.recipetineats.com/ambiguous';
    const source = adapter('recipetineats', [url]);
    const { injected, recipes } = dependencies([source]);
    injected.classify = vi.fn(async () => ({
      metadata: { totalMinutes: 30, mealTypes: ['dinner'], cuisines: [], modifiers: [] },
      sources: { mealTypes: 'source', cuisines: 'rule', modifiers: 'rule' },
      complete: false,
      classifierVersion: 0,
    }));

    await createCatalogueIngestionEngine(injected).run({ runId: 'crawl-unresolved' });

    expect(recipes[0]).toMatchObject({
      status: 'review',
      classification: { classifierVersion: 0, complete: false },
      effective: { mealTypes: ['dinner'], cuisines: [] },
    });
  });

  it('rotates fairly across sources and stops at a reducing command cap', async () => {
    const first = adapter('first', ['https://first.test/1', 'https://first.test/2', 'https://first.test/3']);
    const second = adapter('second', ['https://second.test/1']);
    const { injected, recipes } = dependencies([first, second]);

    await createCatalogueIngestionEngine(injected).run({ runId: 'run-3', writeCap: 9 });

    expect(recipes.map((recipe) => recipe.source.key)).toEqual(['first', 'second', 'first']);
  });

  it('reports a partial run when the per-source crawl cap is reached', async () => {
    const source = adapter('source', [
      'https://source.test/1',
      'https://source.test/2',
    ]);
    const { injected } = dependencies([source]);

    const result = await createCatalogueIngestionEngine(injected).run({
      runId: 'source-cap',
      maxPerSource: 1,
    });

    expect(result.status).toBe('source-cap-exhausted');
    expect(result.metrics.written).toBe(1);
  });

  it('reports an incomplete source instead of complete after bounded consecutive failures', async () => {
    const urls = Array.from({ length: 6 }, (_, index) => `https://source.test/${index}`);
    const source = adapter('source', urls, vi.fn(async () => ({
      kind: 'retryable' as const,
      status: 503,
    })));
    const { injected } = dependencies([source]);

    const result = await createCatalogueIngestionEngine(injected).run({
      runId: 'source-failures',
      maxConsecutiveFailures: 4,
    });

    expect(result.status).toBe('source-failure-exhausted');
    expect(result.metrics.discovered).toBe(4);
    expect(result.metrics.retryable).toBe(4);
  });

  it('checkpoints manifests in bounded batches and flushes the final cursor', async () => {
    const source = adapter('source', [
      'https://source.test/1',
      'https://source.test/2',
      'https://source.test/3',
    ]);
    const { injected, savedManifests } = dependencies([source]);

    await createCatalogueIngestionEngine(injected).run({
      runId: 'manifest-checkpoints',
      manifestCheckpointInterval: 2,
    });

    expect(savedManifests).toHaveLength(2);
    expect(savedManifests.at(-1)?.cursor).toBe('source-2');
    expect(Object.keys(savedManifests.at(-1)?.entries ?? {})).toHaveLength(3);
  });

  it('reserves the daily budget in bounded batches instead of claiming the full cap upfront', async () => {
    const urls = Array.from({ length: 300 }, (_, index) => `https://bulk.test/${index}`);
    const source = adapter('bulk', urls);
    const { injected } = dependencies([source]);

    await createCatalogueIngestionEngine(injected).run({ runId: 'run-batches', writeCap: 600 });

    expect(injected.budget.reserve).toHaveBeenNthCalledWith(1, 250, expect.any(Date));
    expect(injected.budget.reserve).toHaveBeenNthCalledWith(2, 250, expect.any(Date));
    expect(injected.budget.reserve).not.toHaveBeenCalledWith(600, expect.any(Date));
  });

  it('turns protected access into a permanent sparse record without bypass attempts', async () => {
    const source = adapter('protected', ['https://protected.test/recipe'], vi.fn(async () => ({
      kind: 'unsupported' as const,
      status: 403,
    })));
    const { injected, operational } = dependencies([source]);

    const result = await createCatalogueIngestionEngine(injected).run({ runId: 'run-4' });

    expect(operational).toEqual([expect.objectContaining({
      status: 'disabled',
      reasonCode: 'protected-access',
    })]);
    expect(result.metrics).toMatchObject({ permanentSkipped: 1 });
  });

  it('summarizes source outcomes, bounded identifiers, bytes, reads, timing, and telemetry', async () => {
    const recipeTinUrl = 'https://www.recipetineats.com/chicken-salad';
    const seriousEatsUrl = 'https://www.seriouseats.com/blocked';
    const ready = adapter('recipetineats', [recipeTinUrl]);
    const blocked = adapter('seriouseats', [seriousEatsUrl], vi.fn(async () => ({
      kind: 'unsupported' as const,
      status: 402,
    })));
    const { injected, recipeStore } = dependencies([ready, blocked]);
    recipeStore.recoverManifestEntry = vi.fn(async () => null);
    injected.getTelemetry = () => ({
      gemini: {
        calls: 1,
        promptTokenCount: 100,
        candidatesTokenCount: 20,
        totalTokenCount: 120,
      },
    });

    const result = await createCatalogueIngestionEngine(injected).run({ runId: 'phase2-test' });

    expect(result.bySource.recipetineats).toMatchObject({
      discovered: 1,
      fetched: 1,
      parsed: 1,
      classified: 1,
      written: 1,
      recipeReads: 1,
      documentWrites: 1,
      sampleRecipeIds: [canonicalRecipeId(recipeTinUrl)],
    });
    expect(result.bySource.recipetineats.estimatedDocumentBytes).toBeGreaterThan(0);
    expect(result.bySource.seriouseats).toMatchObject({
      discovered: 1,
      fetched: 1,
      permanentSkipped: 1,
      recipeReads: 1,
      documentWrites: 1,
      sampleRecipeIds: [canonicalRecipeId(seriousEatsUrl)],
    });
    expect(result.bySource.seriouseats.estimatedDocumentBytes).toBeGreaterThan(0);
    expect(result.telemetry?.gemini).toEqual({
      calls: 1,
      promptTokenCount: 100,
      candidatesTokenCount: 20,
      totalTokenCount: 120,
    });
    expect(result.startedAt).toBe('2026-07-18T12:00:00.000Z');
    expect(result.completedAt).toBe('2026-07-18T12:00:00.000Z');
    expect(result.durationMs).toBe(0);
    expect(JSON.stringify(result)).not.toContain(recipeTinUrl);
    expect(JSON.stringify(result)).not.toContain(seriousEatsUrl);
  });

  it('caps source sample identifiers at twenty entries', async () => {
    const urls = Array.from({ length: 25 }, (_, index) => `https://bulk.test/${index}`);
    const source = adapter('bulk', urls);
    const { injected } = dependencies([source]);

    const result = await createCatalogueIngestionEngine(injected).run({
      runId: 'bounded-samples',
      writeCap: 40,
    });

    expect(result.bySource.bulk.sampleRecipeIds).toHaveLength(20);
    expect(result.bySource.bulk.documentWrites).toBeGreaterThanOrEqual(20);
  });

  it('isolates discovery failure so another source can continue', async () => {
    const broken: RecipeSourceAdapter = {
      sourceKey: 'broken',
      canonicalize: (url) => url,
      async *discover() { throw new Error('sitemap unavailable'); },
      fetch: vi.fn(),
    };
    const healthy = adapter('healthy', ['https://healthy.test/recipe']);
    const { injected, recipes } = dependencies([broken, healthy]);

    const result = await createCatalogueIngestionEngine(injected).run({ runId: 'run-isolation' });

    expect(recipes).toHaveLength(1);
    expect(recipes[0].source.key).toBe('healthy');
    expect(result.metrics.failed).toBe(1);
    expect(result.bySource.broken).toMatchObject({ failed: 1, documentWrites: 0 });
    expect(result.bySource.healthy).toMatchObject({ written: 1, documentWrites: 1 });
  });

  it('stops refresh cleanly at the Gemini cap without replacing the current recipe', async () => {
    const source = adapter('source', ['https://source.test/recipe']);
    const { injected, recipes } = dependencies([source]);
    injected.classify = async () => {
      const error = new Error('cap');
      error.name = 'GeminiCallCapError';
      throw error;
    };

    const result = await createCatalogueIngestionEngine(injected).run({
      runId: 'run-provider-cap',
      forceRefresh: true,
    });

    expect(result.status).toBe('provider-cap-exhausted');
    expect(recipes).toHaveLength(0);
    expect(result.metrics.failed).toBe(0);
  });

  it('preserves infrastructure write failures with an allowlisted stage', async () => {
    const source = adapter('source', ['https://source.test/recipe']);
    const { injected, recipeStore } = dependencies([source]);
    vi.mocked(recipeStore.writeComplete).mockRejectedValueOnce({ code: 14 });

    await expect(createCatalogueIngestionEngine(injected).run({ runId: 'run-write-failure' }))
      .rejects.toMatchObject({
        name: 'CatalogueIngestionStageError',
        stage: 'recipe-write-complete',
        cause: { code: 14 },
      } satisfies Partial<CatalogueIngestionStageError>);
    expect(recipeStore.writeOperational).not.toHaveBeenCalled();
  });

  it('retries idempotent manifest saves after a transient failure', async () => {
    const source = adapter('source', ['https://source.test/recipe']);
    const { injected } = dependencies([source]);
    vi.mocked(injected.manifests.save).mockRejectedValueOnce({ code: 'ECONNRESET' });

    const result = await createCatalogueIngestionEngine(injected).run({
      runId: 'run-manifest-retry',
    });

    expect(result.status).toBe('complete');
    expect(injected.manifests.save).toHaveBeenCalledTimes(2);
  });
});

describe('ingestion refresh merging', () => {
  it('preserves overrides, deterministic fields, and stable timestamps while rebuilding refreshed metadata', () => {
    const sourceMetadata = { totalMinutes: 50, mealTypes: ['dinner'] as const, cuisines: ['mediterranean'] as const, modifiers: [] };
    const effective = buildEffectiveMetadata(sourceMetadata, { totalMinutes: 25, modifiers: ['salad'] });
    const existing = {
      schemaVersion: 2,
      id: 'id',
      status: 'ready',
      source: { key: 'source', canonicalUrl: 'https://source.test/r', originalUrl: 'https://source.test/r' },
      content: { title: 'Old', originalServings: 4, ingredients: [{ name: 'Chicken' }], instructions: [{ text: 'Cook.' }] },
      sourceMetadata,
      manualOverrides: { totalMinutes: 25, modifiers: ['salad'] as const },
      effective,
      search: buildSearchFields(effective, ['Chicken'], 0.1),
      classification: {
        parserVersion: 0, classifierVersion: 1, taxonomyVersion: 1, sources: {}, complete: true,
      },
      ingestion: {
        contentHash: 'old',
        firstIngestedAt: '2026-07-01T00:00:00.000Z',
        lastChangedAt: '2026-07-02T00:00:00.000Z',
      },
    } satisfies CompleteCanonicalRecipeV2;
    const incoming = {
      ...existing,
      content: { ...existing.content, title: 'New' },
      manualOverrides: undefined,
      search: { ...existing.search, randomKey: 0.9 },
      classification: { ...existing.classification, parserVersion: 1 },
      ingestion: {
        contentHash: 'new',
        firstIngestedAt: '2026-07-20T00:00:00.000Z',
        lastChangedAt: '2026-07-20T00:00:00.000Z',
      },
    };

    const merged = mergeIngestedRecipe(existing, incoming);

    expect(merged.content.title).toBe('New');
    expect(merged.manualOverrides).toEqual(existing.manualOverrides);
    expect(merged.effective.totalMinutes).toBe(25);
    expect(merged.search.salad).toBe(true);
    expect(merged.search.randomKey).toBe(0.1);
    expect(merged.source).toEqual(existing.source);
    expect(merged.ingestion.firstIngestedAt).toBe('2026-07-01T00:00:00.000Z');
    expect(merged.ingestion.lastChangedAt).toBe('2026-07-20T00:00:00.000Z');
    expect(merged.classification.parserVersion).toBe(1);
  });

  it('preserves valid stored classification while filling incomplete display content', () => {
    const existingMetadata = {
      totalMinutes: 30,
      mealTypes: ['dinner'] as const,
      cuisines: ['italian'] as const,
      modifiers: ['vegetarian'] as const,
    };
    const effective = buildEffectiveMetadata(existingMetadata);
    const existing = {
      schemaVersion: 2,
      id: 'id',
      status: 'review',
      source: { key: 'source', canonicalUrl: 'https://source.test/r', originalUrl: 'https://source.test/r' },
      content: { title: 'Old', originalServings: 4, ingredients: [{ name: 'Pasta' }], instructions: [{ text: 'Cook.' }] },
      sourceMetadata: existingMetadata,
      effective,
      search: buildSearchFields(effective, ['Pasta'], 0.1),
      classification: {
        parserVersion: 0,
        classifierVersion: 1,
        taxonomyVersion: 1,
        sources: { mealTypes: 'ai' as const, cuisines: 'ai' as const, modifiers: 'ai' as const },
        complete: true,
      },
      ingestion: { contentHash: 'old' },
    } satisfies CompleteCanonicalRecipeV2;
    const incoming = {
      ...existing,
      sourceMetadata: { totalMinutes: 35, mealTypes: [], cuisines: [], modifiers: [] },
      classification: {
        ...existing.classification,
        parserVersion: 2,
        classifierVersion: 0,
        sources: { mealTypes: 'rule' as const, cuisines: 'rule' as const, modifiers: 'rule' as const },
        complete: false,
      },
    };

    const merged = mergeIngestedRecipe(existing, incoming);

    expect(merged.sourceMetadata).toMatchObject({
      totalMinutes: 35,
      mealTypes: ['dinner'],
      cuisines: ['italian'],
      modifiers: ['vegetarian'],
    });
    expect(merged.classification.sources).toMatchObject({
      mealTypes: 'ai',
      cuisines: 'ai',
      modifiers: 'ai',
    });
    expect(merged.classification.classifierVersion).toBe(1);
  });

  it('does not change lastChangedAt when refreshed content is unchanged', () => {
    const sourceMetadata = {
      totalMinutes: 20,
      mealTypes: ['dinner'] as const,
      cuisines: ['global'] as const,
      modifiers: [],
    };
    const effective = buildEffectiveMetadata(sourceMetadata);
    const existing = {
      schemaVersion: 2,
      id: 'id',
      status: 'ready',
      source: { key: 'source', canonicalUrl: 'https://source.test/r', originalUrl: 'https://source.test/r' },
      content: { title: 'Same', originalServings: 4, ingredients: [{ name: 'Rice' }], instructions: [{ text: 'Cook.' }] },
      sourceMetadata,
      effective,
      search: buildSearchFields(effective, ['Rice'], 0.2),
      classification: {
        parserVersion: 0, classifierVersion: 1, taxonomyVersion: 1, sources: {}, complete: true,
      },
      ingestion: {
        contentHash: 'same-hash',
        firstIngestedAt: '2026-07-01T00:00:00.000Z',
        lastChangedAt: '2026-07-02T00:00:00.000Z',
      },
    } satisfies CompleteCanonicalRecipeV2;
    const incoming = {
      ...existing,
      classification: { ...existing.classification, parserVersion: 1 },
      ingestion: {
        contentHash: 'same-hash',
        firstIngestedAt: '2026-07-20T00:00:00.000Z',
        lastChangedAt: '2026-07-20T00:00:00.000Z',
      },
    };

    const merged = mergeIngestedRecipe(existing, incoming);

    expect(merged.ingestion.firstIngestedAt).toBe('2026-07-01T00:00:00.000Z');
    expect(merged.ingestion.lastChangedAt).toBe('2026-07-02T00:00:00.000Z');
  });
});

describe('verified manifest object saves', () => {
  it('accepts an ambiguous save failure only when stored bytes match exactly', async () => {
    const saveError = new Error('ambiguous response');
    const matching = {
      save: vi.fn(async () => { throw saveError; }),
      download: vi.fn(async () => [Buffer.from('{"ok":true}')]),
    };
    await expect(saveVerifiedManifestObject(matching, '{"ok":true}')).resolves.toBeUndefined();

    const mismatched = {
      save: vi.fn(async () => { throw saveError; }),
      download: vi.fn(async () => [Buffer.from('{"ok":false}')]),
    };
    await expect(saveVerifiedManifestObject(mismatched, '{"ok":true}')).rejects.toBe(saveError);
  });
});
