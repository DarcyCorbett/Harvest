import { describe, expect, it } from 'vitest';

import { parseUnitBackfillArguments } from '../src/catalogue/unitBackfillCommand.js';

describe('unit backfill command', () => {
  it('defaults to a non-mutating dry run', () => {
    expect(parseUnitBackfillArguments([])).toEqual({
      apply: false,
      runId: 'dry-run',
      writeCap: 1_000,
      pageSize: 250,
    });
  });

  it('accepts bounded resumable apply arguments', () => {
    expect(parseUnitBackfillArguments([
      '--apply', '--run-id', 'units-20260831', '--write-cap', '200',
      '--page-size', '50', '--source', 'recipetineats,budgetbytes', '--after', 'recipe-10',
    ])).toEqual({
      apply: true,
      runId: 'units-20260831',
      writeCap: 200,
      pageSize: 50,
      sourceKeys: ['recipetineats', 'budgetbytes'],
      startAfter: 'recipe-10',
    });
  });

  it.each([
    ['--apply'],
    ['--write-cap', '18001'],
    ['--page-size', '0'],
    ['--source', 'unknown'],
    ['--unknown'],
  ])('rejects unsafe arguments: %j', (...args) => {
    expect(() => parseUnitBackfillArguments(args)).toThrow('Invalid unit backfill arguments');
  });
});

