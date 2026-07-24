import { describe, expect, it } from 'vitest';

import { parseIngestionArguments } from '../src/catalogue/ingestionCommand.js';

describe('ingestion command arguments', () => {
  it('supports source selection, dry-run, force refresh, and a reducing write cap', () => {
    expect(parseIngestionArguments([
      '--source', 'recipetineats,seriouseats',
      '--dry-run',
      '--force-refresh',
      '--write-cap', '25',
      '--max-per-source', '1',
      '--target', 'recipetineats=https://www.recipetineats.com/chicken-salad',
      '--target', 'seriouseats=https://www.seriouseats.com/baked-ziti',
      '--run-id', 'smoke-1',
    ])).toEqual({
      sourceKeys: ['recipetineats', 'seriouseats'],
      dryRun: true,
      forceRefresh: true,
      writeCap: 25,
      maxPerSource: 1,
      targetUrls: {
        recipetineats: ['https://www.recipetineats.com/chicken-salad'],
        seriouseats: ['https://www.seriouseats.com/baked-ziti'],
      },
      runId: 'smoke-1',
    });
  });

  it('supports multiple source targets in one Cloud Run compatible argument', () => {
    expect(parseIngestionArguments([
      '--target', 'recipetineats=https://www.recipetineats.com/chicken-salad,seriouseats=https://www.seriouseats.com/baked-ziti',
    ])).toEqual({
      targetUrls: {
        recipetineats: ['https://www.recipetineats.com/chicken-salad'],
        seriouseats: ['https://www.seriouseats.com/baked-ziti'],
      },
    });
  });

  it('supports Phase 4 modes and bounded Gemini calls', () => {
    expect(parseIngestionArguments([
      'classify-backfill',
      '--write-cap', '8000',
      '--gemini-call-cap', '500',
      '--run-id', 'phase4-run',
    ])).toEqual({
      mode: 'classify-backfill',
      writeCap: 8000,
      geminiCallCap: 500,
      runId: 'phase4-run',
    });
  });

  it.each([
    ['--write-cap', '18001'],
    ['--write-cap', '-1'],
    ['classify-backfill', '--gemini-call-cap', '501'],
    ['unknown-mode'],
    ['--source', 'unknown'],
    ['--unexpected'],
  ])('rejects unsafe arguments: %s %s', (...args) => {
    expect(() => parseIngestionArguments(args.filter(Boolean))).toThrow('Invalid ingestion arguments');
  });
});
