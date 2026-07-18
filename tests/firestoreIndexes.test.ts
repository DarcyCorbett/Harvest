import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('Firestore catalogue indexes', () => {
  it('relies on Firestore implicit document-name ordering for idempotent deployment', () => {
    const configuration = JSON.parse(readFileSync('firestore.indexes.json', 'utf8')) as {
      indexes: Array<{ fields: Array<{ fieldPath: string }> }>;
    };

    for (const index of configuration.indexes) {
      expect(index.fields.map((field) => field.fieldPath)).not.toContain('__name__');
    }
  });
});
