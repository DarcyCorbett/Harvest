import { createHash } from 'node:crypto';

import type { CompleteCanonicalRecipeV2 } from './domain.js';

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)]));
  }
  return value;
}

export function catalogueContentHash(
  content: CompleteCanonicalRecipeV2['content'],
): string {
  return createHash('sha256').update(JSON.stringify(stableValue(content)), 'utf8').digest('hex');
}
