import { describe, expect, it } from 'vitest';

import {
  mergeCookbookEntries,
  planReferenceMutation,
  runReferenceMigration,
  type ReferenceMigrationStore,
  type ScannedRecipeReference,
} from '../src/catalogue/migrationReferences.js';

const successfulMapping = {
  schemaVersion: 1,
  legacyRecipeId: 'legacy-1',
  canonicalRecipeId: 'canonical-1',
  state: 'migrated',
};

const target = { schemaVersion: 2, id: 'canonical-1', status: 'ready' };

describe('catalogue reference migration', () => {
  it('merges cookbook collisions without losing favourites or earlier addedAt', () => {
    const merged = mergeCookbookEntries(
      {
        recipeId: 'legacy-1',
        starred: true,
        addedAt: new Date('2026-01-01T00:00:00Z'),
        sourceOnly: 'kept',
        shared: 'source',
      },
      {
        recipeId: 'canonical-1',
        starred: false,
        addedAt: new Date('2026-02-01T00:00:00Z'),
        destinationOnly: 'kept',
        shared: 'destination',
      },
      'canonical-1',
    );

    expect(merged).toMatchObject({
      recipeId: 'canonical-1',
      starred: true,
      sourceOnly: 'kept',
      destinationOnly: 'kept',
      shared: 'destination',
    });
    expect(merged.addedAt).toEqual(new Date('2026-01-01T00:00:00Z'));
  });

  it('plans a meal-plan update while preserving every other field', () => {
    expect(planReferenceMutation({
      kind: 'meal-plan',
      scannedRecipeId: 'legacy-1',
      sourceDocumentId: '2026-07-21_dinner',
      source: { recipeId: 'legacy-1', date: '2026-07-21', mealType: 'dinner', servings: 4 },
      mapping: successfulMapping,
      target,
    })).toEqual({
      outcome: 'meal-plan-updated',
      canonicalRecipeId: 'canonical-1',
    });
  });

  it('plans a cookbook move and identifies a destination collision', () => {
    expect(planReferenceMutation({
      kind: 'cookbook',
      scannedRecipeId: 'legacy-1',
      sourceDocumentId: 'legacy-1',
      source: { recipeId: 'legacy-1', starred: false, addedAt: '2026-01-01' },
      mapping: successfulMapping,
      target,
      destination: { recipeId: 'canonical-1', starred: true, addedAt: '2026-02-01' },
    })).toMatchObject({
      outcome: 'cookbook-merged',
      canonicalRecipeId: 'canonical-1',
      destination: { recipeId: 'canonical-1', starred: true, addedAt: '2026-01-01' },
    });
  });

  it.each([
    [undefined, 'orphan'],
    [{ ...successfulMapping, state: 'failed' }, 'failed-mapping'],
  ] as const)('leaves an unresolved reference unchanged', (mapping, outcome) => {
    expect(planReferenceMutation({
      kind: 'meal-plan',
      scannedRecipeId: 'legacy-1',
      sourceDocumentId: 'entry-1',
      source: { recipeId: 'legacy-1' },
      mapping,
      target: undefined,
    })).toEqual({ outcome });
  });

  it('treats a reference that already points at a v2 recipe as a no-op', () => {
    expect(planReferenceMutation({
      kind: 'meal-plan',
      scannedRecipeId: 'canonical-1',
      sourceDocumentId: 'entry-1',
      source: { recipeId: 'canonical-1' },
      mapping: undefined,
      currentRecipe: target,
    })).toEqual({ outcome: 'noop' });
  });

  it('runs dry-run without applying mutations or completing the checkpoint', async () => {
    const store = memoryStore(['meal-plan-updated', 'orphan']);

    const summary = await runReferenceMigration(store, { dryRun: true });

    expect(summary).toMatchObject({ status: 'complete', scanned: 2, mealPlansUpdated: 1, orphans: 1 });
    expect(store.applied).toEqual([]);
    expect(store.completed).toBe(false);
  });

  it('applies references sequentially and completes after a clean run', async () => {
    const store = memoryStore(['meal-plan-updated', 'cookbook-moved', 'cookbook-merged', 'noop']);

    const summary = await runReferenceMigration(store, { dryRun: false });

    expect(summary).toMatchObject({
      status: 'complete',
      scanned: 4,
      mealPlansUpdated: 1,
      cookbooksMoved: 1,
      cookbookCollisions: 1,
      noops: 1,
    });
    expect(store.applied).toHaveLength(4);
    expect(store.completed).toBe(true);
  });

  it('stops on a concurrent change and does not complete the checkpoint', async () => {
    const store = memoryStore(['meal-plan-updated', 'concurrent-change', 'cookbook-moved']);

    const summary = await runReferenceMigration(store, { dryRun: false });

    expect(summary).toMatchObject({ status: 'stopped', scanned: 2, concurrentChanges: 1 });
    expect(store.applied).toHaveLength(2);
    expect(store.completed).toBe(false);
  });
});

type TestOutcome = Awaited<ReturnType<ReferenceMigrationStore['process']>>;

function memoryStore(outcomes: TestOutcome[]) {
  const references: ScannedRecipeReference[] = outcomes.map((_, index) => ({
    kind: index % 2 === 0 ? 'meal-plan' : 'cookbook',
    path: `households/test/${index}`,
    id: `entry-${index}`,
    recipeId: `legacy-${index}`,
  }));
  const applied: ScannedRecipeReference[] = [];
  const store: ReferenceMigrationStore & {
    applied: ScannedRecipeReference[];
    completed: boolean;
  } = {
    applied,
    completed: false,
    async scan() {
      return references;
    },
    async process(reference, options) {
      if (!options.dryRun) applied.push(reference);
      return outcomes[references.indexOf(reference)];
    },
    async complete() {
      store.completed = true;
    },
  };
  return store;
}
