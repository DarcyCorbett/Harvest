import { describe, expect, it, vi } from 'vitest';

import { buildEffectiveMetadata, buildSearchFields, type CompleteCanonicalRecipeV2 } from '../src/catalogue/domain.js';
import {
  recoverLegacyContent,
  runLegacyContentRecovery,
  type ContentEnrichmentStore,
  type LegacyEnrichmentCandidate,
} from '../src/catalogue/contentEnrichment.js';

function recipe(): CompleteCanonicalRecipeV2 {
  const sourceMetadata = { mealTypes: ['dinner'] as const, cuisines: ['global'] as const, modifiers: [] };
  const effective = buildEffectiveMetadata(sourceMetadata);
  return {
    schemaVersion: 2, id: 'canonical', status: 'ready',
    source: { key: 'seriouseats', canonicalUrl: 'https://example.test/soup', originalUrl: 'https://example.test/soup' },
    content: {
      title: 'Soup', originalServings: 4,
      ingredients: [{ name: 'onion' }, { name: 'carrot' }],
      instructions: [{ text: 'Chop.' }, { text: 'Simmer.' }],
    },
    sourceMetadata, effective, search: buildSearchFields(effective, ['onion', 'carrot'], 0.2),
    classification: { parserVersion: 0, taxonomyVersion: 1, sources: {}, complete: true },
    ingestion: { contentHash: 'old' },
  };
}

function candidate(legacy: Record<string, unknown>, cursor = 'legacy-1'): LegacyEnrichmentCandidate {
  return { mappingCursor: cursor, sourceKey: 'seriouseats', recipe: recipe(), legacy };
}

describe('legacy content recovery', () => {
  it('recovers aligned groups, headers, step media, notes, and description without changing core text', () => {
    const result = recoverLegacyContent(recipe(), {
      description: 'A rich soup.', notes: 'Taste before serving.',
      ingredientGroups: [{ name: 'Vegetables', ingredients: [{ name: 'onion' }, { name: 'carrot' }] }],
      instructions: [
        { text: 'Soup', isHeader: true },
        { text: 'Chop.', title: 'Prepare', imageUrl: 'https://images.test/chop.jpg' },
        { text: 'Simmer.', videoEmbedUrl: 'https://video.test/simmer' },
      ],
    }, '2026-09-01T00:00:00.000Z');

    expect(result.status).toBe('candidate');
    expect(result.recipe?.content).toMatchObject({
      description: 'A rich soup.', notes: 'Taste before serving.',
      ingredientGroups: [{ name: 'Vegetables' }],
      instructions: [
        { text: 'Soup', isHeader: true },
        { text: 'Chop.', title: 'Prepare', imageUrl: 'https://images.test/chop.jpg' },
        { text: 'Simmer.', videoEmbedUrl: 'https://video.test/simmer' },
      ],
    });
  });

  it('reports ambiguous ingredient or instruction alignment and leaves it unchanged', () => {
    expect(recoverLegacyContent(recipe(), {
      ingredientGroups: [{ name: 'Wrong', ingredients: [{ name: 'potato' }] }],
      instructions: [{ text: 'Completely different.', imageUrl: 'https://images.test/no.jpg' }],
    }).status).toBe('alignment-failure');
  });

  it('is idempotent after enrichment is present', () => {
    const legacy = {
      description: 'A rich soup.',
      ingredientGroups: [{ name: 'Vegetables', ingredients: [{ name: 'onion' }, { name: 'carrot' }] }],
    };
    const first = recoverLegacyContent(recipe(), legacy);
    expect(first.status).toBe('candidate');
    expect(recoverLegacyContent(first.recipe!, legacy).status).toBe('unchanged');
  });

  it('chooses the richest mapping, creates backup/write estimates, and obeys the write cap', async () => {
    const writes: CompleteCanonicalRecipeV2[] = [];
    const store: ContentEnrichmentStore = {
      loadCursor: vi.fn(async () => undefined),
      scan: vi.fn(async () => ({
        candidates: [
          candidate({ description: 'Short.' }, 'legacy-1'),
          candidate({ description: 'Longer.', notes: 'Also notes.' }, 'legacy-2'),
        ],
        nextCursor: 'legacy-2', exhausted: true, reads: 6,
      })),
      write: vi.fn(async (_runId, _hash, value) => { writes.push(value); return 'written'; }),
      saveCursor: vi.fn(async () => undefined),
      summarize: vi.fn(async () => undefined),
    };
    const dryRun = await runLegacyContentRecovery({ runId: 'dry-run', store, dryRun: true });
    expect(dryRun).toMatchObject({ candidates: 1, estimatedReads: 6, estimatedWrites: 1, estimatedBackupWrites: 1 });
    expect(store.write).not.toHaveBeenCalled();

    const applied = await runLegacyContentRecovery({ runId: 'apply-1', store, dryRun: false, writeCap: 2 });
    expect(applied.written).toBe(1);
    expect(writes[0].content).toMatchObject({ description: 'Longer.', notes: 'Also notes.' });
    expect(store.saveCursor).toHaveBeenCalled();
    expect(store.summarize).toHaveBeenCalled();
  });
});
