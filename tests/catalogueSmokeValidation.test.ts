import { describe, expect, it } from 'vitest';

import { validateCatalogueSmokeEvidence } from '../scripts/catalogueSmokeValidation.mjs';

const idempotentSecondRun = {
  reservedWrites: 25,
  consumedWrites: 6,
  metrics: { fetched: 0, written: 0, permanentSkipped: 0 },
};

describe('catalogue smoke validation', () => {
  it('rejects a first run that does not resolve both pilot sources', () => {
    expect(() => validateCatalogueSmokeEvidence({
      first: {
        reservedWrites: 25,
        consumedWrites: 8,
        metrics: { fetched: 2, written: 1, permanentSkipped: 0, failed: 0, retryable: 0 },
      },
      second: idempotentSecondRun,
      generationMode: 'legacy',
    })).toThrow('resolve both pilot sources');
  });

  it('accepts a ready recipe plus a source correctly marked as unsupported', () => {
    expect(() => validateCatalogueSmokeEvidence({
      first: {
        reservedWrites: 25,
        consumedWrites: 8,
        metrics: { fetched: 2, written: 1, permanentSkipped: 1, failed: 0, retryable: 0 },
      },
      second: idempotentSecondRun,
      generationMode: 'legacy',
    })).not.toThrow();
  });

  it('accepts two successful pilot recipes followed by a zero-fetch, zero-write rerun', () => {
    expect(() => validateCatalogueSmokeEvidence({
      first: {
        reservedWrites: 25,
        consumedWrites: 10,
        metrics: { fetched: 2, written: 2, permanentSkipped: 0, failed: 0, retryable: 0 },
      },
      second: idempotentSecondRun,
      generationMode: 'legacy',
    })).not.toThrow();
  });
});
