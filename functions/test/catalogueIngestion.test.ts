import { describe, expect, it, vi } from 'vitest';

import { buildEffectiveMetadata, buildSearchFields, canonicalRecipeId, type CompleteCanonicalRecipeV2 } from '../src/catalogue/domain.js';
import {
  createCatalogueIngestionEngine,
  mergeIngestedRecipe,
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

  it('rotates fairly across sources and stops at a reducing command cap', async () => {
    const first = adapter('first', ['https://first.test/1', 'https://first.test/2', 'https://first.test/3']);
    const second = adapter('second', ['https://second.test/1']);
    const { injected, recipes } = dependencies([first, second]);

    await createCatalogueIngestionEngine(injected).run({ runId: 'run-3', writeCap: 9 });

    expect(recipes.map((recipe) => recipe.source.key)).toEqual(['first', 'second', 'first']);
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
      reasonCode: 'unsupported-403',
    })]);
    expect(result.metrics).toMatchObject({ permanentSkipped: 1 });
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
  });
});

describe('ingestion refresh merging', () => {
  it('preserves manual overrides and rebuilds effective search fields from refreshed source metadata', () => {
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
      classification: { parserVersion: 1, taxonomyVersion: 1, sources: {}, complete: true },
      ingestion: { contentHash: 'old' },
    } satisfies CompleteCanonicalRecipeV2;
    const incoming = { ...existing, content: { ...existing.content, title: 'New' }, manualOverrides: undefined };

    const merged = mergeIngestedRecipe(existing, incoming);

    expect(merged.content.title).toBe('New');
    expect(merged.manualOverrides).toEqual(existing.manualOverrides);
    expect(merged.effective.totalMinutes).toBe(25);
    expect(merged.search.salad).toBe(true);
  });
});
