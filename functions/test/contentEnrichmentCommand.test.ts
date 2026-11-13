import { describe, expect, it } from 'vitest';

import { parseContentEnrichmentArguments } from '../src/catalogue/contentEnrichmentCommand.js';

describe('content enrichment command', () => {
  it('defaults audit and recovery to a sanitized dry run', () => {
    expect(parseContentEnrichmentArguments(['audit'])).toMatchObject({ mode: 'audit', dryRun: true });
    expect(parseContentEnrichmentArguments([
      'recover-legacy', '--dry-run', '--source', 'seriouseats,akispetretzikis',
      '--max-per-source', '10', '--write-cap', '20', '--run-id', 'audit-1',
    ])).toMatchObject({
      mode: 'recover-legacy', dryRun: true,
      sourceKeys: ['seriouseats', 'akispetretzikis'], maxPerSource: 10,
      writeCap: 20, runId: 'audit-1',
    });
  });

  it('requires a run id for writes and supports resumable execution', () => {
    expect(() => parseContentEnrichmentArguments(['recover-legacy', '--apply']))
      .toThrow('Invalid content enrichment arguments');
    expect(parseContentEnrichmentArguments([
      'recover-legacy', '--apply', '--run-id', 'recover-1', '--after', 'legacy-cursor',
    ])).toMatchObject({
      mode: 'recover-legacy', dryRun: false, runId: 'recover-1', startAfter: 'legacy-cursor',
    });
  });

  it('requires explicit apply authorization for run metadata repair', () => {
    expect(() => parseContentEnrichmentArguments(['repair-run', '--run-id', 'canary-1']))
      .toThrow('Invalid content enrichment arguments');
    expect(parseContentEnrichmentArguments([
      'repair-run', '--apply', '--run-id', 'canary-1',
    ])).toMatchObject({ mode: 'repair-run', dryRun: false, runId: 'canary-1' });
  });

  it('supports read-only run verification', () => {
    expect(parseContentEnrichmentArguments(['verify-run', '--run-id', 'canary-1']))
      .toMatchObject({ mode: 'verify-run', dryRun: true, runId: 'canary-1' });
  });
});
