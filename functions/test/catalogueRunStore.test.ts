import { describe, expect, it, vi } from 'vitest';

const firestore = vi.hoisted(() => {
  const set = vi.fn(async () => undefined);
  return {
    set,
    db: {
      collection: vi.fn(() => ({
        doc: vi.fn(() => ({ set })),
      })),
    },
  };
});

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: () => firestore.db,
}));

import { firestoreCatalogueRunStore, type CatalogueRunSummary } from '../src/catalogue/ingestion.js';

describe('Firestore catalogue run store', () => {
  it('persists the summary completion timestamp used to calculate duration', async () => {
    const summary: CatalogueRunSummary = {
      status: 'complete',
      quotaDate: '2026-07-18',
      reservedWrites: 10,
      consumedWrites: 6,
      metrics: {
        discovered: 0,
        unchanged: 0,
        fetched: 0,
        parsed: 0,
        classified: 0,
        written: 0,
        review: 0,
        retryable: 0,
        permanentSkipped: 0,
        failed: 0,
      },
      startedAt: '2026-07-18T12:00:00.000Z',
      completedAt: '2026-07-18T12:00:02.000Z',
      durationMs: 2_000,
      bySource: {},
    };

    await firestoreCatalogueRunStore().summarize('phase2-run', summary);

    expect(firestore.set).toHaveBeenCalledWith(summary, { merge: true });
  });
});
