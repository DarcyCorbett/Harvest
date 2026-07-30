import { describe, expect, it } from 'vitest';

import { parseIngestionArguments } from '../src/catalogue/ingestionCommand.js';

describe('ingestion command arguments', () => {
  it('supports source selection, dry-run, force refresh, and a reducing write cap', () => {
    expect(parseIngestionArguments([
      '--source', 'recipetineats,nytcooking',
      '--dry-run',
      '--force-refresh',
      '--write-cap', '25',
      '--max-per-source', '1',
      '--target', 'recipetineats=https://www.recipetineats.com/chicken-salad',
      '--target', 'nytcooking=https://cooking.nytimes.com/recipes/1-test',
      '--run-id', 'smoke-1',
    ])).toEqual({
      sourceKeys: ['recipetineats', 'nytcooking'],
      dryRun: true,
      forceRefresh: true,
      writeCap: 25,
      maxPerSource: 1,
      targetUrls: {
        recipetineats: ['https://www.recipetineats.com/chicken-salad'],
        nytcooking: ['https://cooking.nytimes.com/recipes/1-test'],
      },
      runId: 'smoke-1',
    });
  });

  it('supports multiple source targets in one Cloud Run compatible argument', () => {
    expect(parseIngestionArguments([
      '--target', 'recipetineats=https://www.recipetineats.com/chicken-salad,nytcooking=https://cooking.nytimes.com/recipes/1-test',
    ])).toEqual({
      targetUrls: {
        recipetineats: ['https://www.recipetineats.com/chicken-salad'],
        nytcooking: ['https://cooking.nytimes.com/recipes/1-test'],
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

  it('supports WordPress crawl modes and restricts crawl-backfill sources', () => {
    expect(parseIngestionArguments([
      'crawl-backfill',
      '--source', 'recipetineats,budgetbytes',
      '--write-cap', '18000',
      '--max-per-source', '500',
      '--run-id', 'crawl-1',
    ])).toEqual({
      mode: 'crawl-backfill',
      sourceKeys: ['recipetineats', 'budgetbytes'],
      writeCap: 18000,
      maxPerSource: 500,
      runId: 'crawl-1',
    });
    expect(parseIngestionArguments(['crawl-canary'])).toEqual({ mode: 'crawl-canary' });
    expect(parseIngestionArguments(['crawl-inventory'])).toEqual({ mode: 'crawl-inventory' });
    expect(() => parseIngestionArguments([
      'crawl-backfill',
      '--source', 'seriouseats',
    ])).toThrow('Invalid ingestion arguments');
  });

  it('supports all-source snapshot, cost-gated batch, and weekly modes', () => {
    expect(parseIngestionArguments([
      'snapshot-crawl',
      '--source', 'nytcooking,americastestkitchen',
      '--write-cap', '18000',
      '--run-id', 'snapshot-1',
    ])).toMatchObject({
      mode: 'snapshot-crawl',
      sourceKeys: ['nytcooking', 'americastestkitchen'],
      writeCap: 18000,
    });
    expect(parseIngestionArguments([
      'tag-batch-submit',
      '--confirm-paid-batch',
    ])).toEqual({
      mode: 'tag-batch-submit',
      confirmPaidBatch: true,
    });
    expect(parseIngestionArguments([
      'weekly-new',
      '--write-cap', '17500',
      '--gemini-call-cap', '500',
    ])).toMatchObject({ mode: 'weekly-new', writeCap: 17500, geminiCallCap: 500 });
    expect(() => parseIngestionArguments(['tag-batch-submit'])).toThrow();
    expect(() => parseIngestionArguments(['weekly-new', '--write-cap', '18000'])).toThrow();
  });

  it.each([
    ['--write-cap', '18001'],
    ['--write-cap', '-1'],
    ['classify-backfill', '--gemini-call-cap', '501'],
    ['unknown-mode'],
    ['--source', 'unknown'],
    ['--source', 'seriouseats'],
    ['--source', 'akispetretzikis'],
    ['--unexpected'],
  ])('rejects unsafe arguments: %s %s', (...args) => {
    expect(() => parseIngestionArguments(args.filter(Boolean))).toThrow('Invalid ingestion arguments');
  });
});
