import type { CallableRequest } from 'firebase-functions/v2/https';
import { describe, expect, it, vi } from 'vitest';

import { buildEffectiveMetadata, buildSearchFields, type CompleteCanonicalRecipeV2 } from '../src/catalogue/domain.js';
import {
  applyCanonicalMetadataOperations,
  createCatalogueMetadataHandlers,
  type CanonicalMetadataStore,
} from '../src/catalogue/metadata.js';

function recipe(): CompleteCanonicalRecipeV2 {
  const sourceMetadata = {
    prepMinutes: 10,
    cookMinutes: 30,
    totalMinutes: 40,
    mealTypes: ['dinner'] as const,
    cuisines: ['mediterranean'] as const,
    modifiers: ['healthy'] as const,
  };
  const manualOverrides = { totalMinutes: 25 };
  const effective = buildEffectiveMetadata(sourceMetadata, manualOverrides);
  return {
    schemaVersion: 2,
    id: 'recipe-1',
    status: 'ready',
    source: {
      key: 'recipetineats',
      canonicalUrl: 'https://www.recipetineats.com/recipe',
      originalUrl: 'https://www.recipetineats.com/recipe',
    },
    content: {
      title: 'Recipe',
      originalServings: 4,
      ingredients: [{ name: 'Chicken' }],
      instructions: [{ text: 'Cook.' }],
    },
    sourceMetadata,
    manualOverrides,
    effective,
    search: buildSearchFields(effective, ['Chicken'], 0.2),
    classification: { parserVersion: 1, taxonomyVersion: 1, sources: {}, complete: true },
    ingestion: { contentHash: 'hash' },
  };
}

describe('canonical metadata operations', () => {
  it('sets overrides and rebuilds effective and search values atomically', () => {
    const updated = applyCanonicalMetadataOperations(recipe(), {
      totalMinutes: { operation: 'set', value: 35 },
      mealTypes: { operation: 'set', value: ['lunch'] },
      modifiers: { operation: 'set', value: ['vegetarian', 'salad'] },
    }, 'editor-1', '2026-07-18T10:00:00.000Z');

    expect(updated.manualOverrides).toMatchObject({
      totalMinutes: 35,
      mealTypes: ['lunch'],
      modifiers: ['vegetarian', 'salad'],
      updatedBy: 'editor-1',
      updatedAt: '2026-07-18T10:00:00.000Z',
    });
    expect(updated.effective).toMatchObject({
      totalMinutes: 35,
      totalTimeProvenance: 'manual',
      mealTypes: ['lunch'],
    });
    expect(updated.search).toMatchObject({
      quick30: false,
      moderate45: true,
      vegetarian: true,
      salad: true,
      selectionKeys: ['lunch|any', 'lunch|mediterranean'],
    });
  });

  it('resets only requested fields to source values without clearing other overrides', () => {
    const updated = applyCanonicalMetadataOperations(recipe(), {
      totalMinutes: { operation: 'reset' },
    }, 'editor-1', '2026-07-18T10:00:00.000Z');

    expect(updated.manualOverrides?.totalMinutes).toBeNull();
    expect(updated.effective.totalMinutes).toBe(40);
    expect(updated.effective.totalTimeProvenance).toBe('source');
  });
});

describe('canonical metadata callable', () => {
  it('validates before editor authorization and returns the transaction result', async () => {
    const authorize = vi.fn(async () => ({ uid: 'editor-1', email: 'editor@example.com' }));
    const update = vi.fn(async () => recipe());
    const store: CanonicalMetadataStore = { update };
    const handler = createCatalogueMetadataHandlers({ authorize, store });

    await expect(handler.update({ auth: {} as never, data: {
      recipeId: 'recipe-1', operations: {},
    } } as CallableRequest<unknown>)).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(authorize).not.toHaveBeenCalled();

    const request = {
      auth: { uid: 'editor-1', token: {} },
      data: {
        recipeId: 'recipe-1',
        operations: { totalMinutes: { operation: 'reset' } },
      },
    } as CallableRequest<unknown>;
    await expect(handler.update(request)).resolves.toMatchObject({ id: 'recipe-1' });
    expect(authorize).toHaveBeenCalledWith(request.auth);
    expect(update).toHaveBeenCalledWith(
      'recipe-1',
      { totalMinutes: { operation: 'reset' } },
      'editor-1',
    );
  });
});
