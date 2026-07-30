import { describe, expect, it } from 'vitest';

import { selectSourceCanaryUrls } from '../src/catalogue/backfillFirestore.js';

describe('source canary sample selection', () => {
  it('prioritizes known displayable recipes and uses prior failures only as fallback', () => {
    expect(selectSourceCanaryUrls(
      ['https://example.test/ready-1', 'https://example.test/ready-2'],
      ['https://example.test/failed-1', 'https://example.test/ready-1'],
      3,
    )).toEqual([
      'https://example.test/ready-1',
      'https://example.test/ready-2',
      'https://example.test/failed-1',
    ]);
  });
});
