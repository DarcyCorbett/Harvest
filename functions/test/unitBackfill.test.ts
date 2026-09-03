import { describe, expect, it, vi } from 'vitest';

import { buildSearchFields, type CompleteCanonicalRecipeV2 } from '../src/catalogue/domain.js';
import {
  normalizeRecipeForUnitBackfill,
  runUnitBackfill,
  type UnitBackfillStore,
} from '../src/catalogue/unitBackfill.js';

function recipe(id: string, ingredient = '2 lb beef'): CompleteCanonicalRecipeV2 {
  const effective = {
    totalMinutes: 30,
    mealTypes: ['dinner'] as const,
    cuisines: ['global'] as const,
    modifiers: [] as const,
  };
  return {
    schemaVersion: 2,
    id,
    status: 'ready',
    source: {
      key: 'recipetineats',
      canonicalUrl: `https://example.test/${id}`,
      originalUrl: `https://example.test/${id}`,
    },
    ingestion: {},
    content: {
      title: id,
      originalServings: 4,
      ingredients: [{ name: ingredient }],
      instructions: [{ text: 'Bake at 450 degrees F in a 9 inch pan.' }],
    },
    sourceMetadata: {},
    effective,
    search: buildSearchFields(effective, [ingredient], 0.5),
    classification: {
      parserVersion: 3,
      taxonomyVersion: 2,
      sources: {},
      complete: true,
    },
  };
}

describe('unit backfill transform', () => {
  it('updates content, search fields, hash, and parser version idempotently', () => {
    const first = normalizeRecipeForUnitBackfill(recipe('one'), '2026-08-31T00:00:00.000Z');
    expect(first.status).toBe('candidate');
    if (first.status !== 'candidate') return;
    expect(first.recipe.content.ingredients).toEqual([{ name: 'beef', quantity: 0.9, unit: 'kg' }]);
    expect(first.recipe.content.instructions[0].text).toBe('Bake at 232°C in a 22.9cm pan.');
    expect(first.recipe.search.ingredientTokens).toContain('beef');
    expect(first.recipe.classification.parserVersion).toBe(4);
    expect(first.recipe.ingestion.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(normalizeRecipeForUnitBackfill(first.recipe).status).toBe('unchanged');
  });

  it('normalizes deterministic embedded imperial quantities', () => {
    const result = normalizeRecipeForUnitBackfill(recipe('one', '1 can tomatoes (14 oz)'));
    expect(result).toMatchObject({
      status: 'candidate',
      recipe: { content: { ingredients: [{ name: 'tomatoes', quantity: 1, unit: 'can', notes: '397 g' }] } },
    });
  });
});

describe('unit backfill engine', () => {
  it('dry-runs without writes and reports candidates', async () => {
    const store: UnitBackfillStore = {
      loadCursor: vi.fn(),
      scan: vi.fn(async () => ({ recipes: [recipe('one')], nextCursor: 'one', exhausted: true })),
      write: vi.fn(),
      saveCursor: vi.fn(),
      summarize: vi.fn(),
    };
    const summary = await runUnitBackfill({ runId: 'dry-run', store });
    expect(summary).toMatchObject({ apply: false, scanned: 1, candidates: 1, written: 0, complete: true });
    expect(store.write).not.toHaveBeenCalled();
    expect(store.saveCursor).not.toHaveBeenCalled();
  });

  it('stops before exceeding the backup-plus-recipe write cap and saves a resumable cursor', async () => {
    const write = vi.fn(async () => 'written' as const);
    const saveCursor = vi.fn(async () => undefined);
    const store: UnitBackfillStore = {
      loadCursor: vi.fn(async () => undefined),
      scan: vi.fn(async () => ({
        recipes: [recipe('one'), recipe('two')],
        nextCursor: 'two',
        exhausted: true,
      })),
      write,
      saveCursor,
      summarize: vi.fn(async () => undefined),
    };
    const summary = await runUnitBackfill({
      runId: 'apply-1', store, apply: true, writeCap: 2,
    });
    expect(write).toHaveBeenCalledOnce();
    expect(saveCursor).toHaveBeenLastCalledWith('apply-1', 'one');
    expect(summary).toMatchObject({ written: 1, complete: false, nextCursor: 'one' });
  });
});
