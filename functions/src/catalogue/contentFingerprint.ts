import { createHash } from 'node:crypto';

import type { CompleteCanonicalRecipeV2 } from './domain.js';

export function catalogueContentHash(
  content: CompleteCanonicalRecipeV2['content'],
): string {
  return createHash('sha256').update(JSON.stringify(content), 'utf8').digest('hex');
}

