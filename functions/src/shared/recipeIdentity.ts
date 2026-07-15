import { createHash } from 'node:crypto';

export function normalizeLegacySourceUrl(sourceUrl: string): string {
  const normalized = new URL(sourceUrl);
  normalized.hash = '';
  return normalized.toString();
}

export function deterministicLegacyRecipeId(
  normalizedSourceUrl: string,
): string {
  const digest = createHash('sha256')
    .update(normalizedSourceUrl, 'utf8')
    .digest('hex');
  return `legacy_${digest}`;
}
