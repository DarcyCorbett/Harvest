import {
  buildSearchFields,
  type CompleteCanonicalRecipeV2,
} from './domain.js';
import { catalogueContentHash } from './contentFingerprint.js';
import {
  normalizeCatalogueContent,
  type CatalogueUnitNormalizationIssue,
} from './unitNormalization.js';
import { CATALOGUE_PARSER_VERSION } from './version.js';

export interface UnitBackfillPage {
  recipes: CompleteCanonicalRecipeV2[];
  nextCursor?: string;
  exhausted: boolean;
}

export type UnitBackfillWriteResult = 'written' | 'concurrent' | 'already-current';

export interface UnitBackfillStore {
  loadCursor(runId: string): Promise<string | undefined>;
  scan(afterId: string | undefined, limit: number): Promise<UnitBackfillPage>;
  write(
    runId: string,
    expectedContentHash: string,
    recipe: CompleteCanonicalRecipeV2,
  ): Promise<UnitBackfillWriteResult>;
  saveCursor(runId: string, cursor: string | undefined): Promise<void>;
  summarize(runId: string, summary: UnitBackfillSummary): Promise<void>;
}

export interface UnitBackfillSummary {
  mode: 'unit-backfill';
  apply: boolean;
  parserVersion: number;
  scanned: number;
  candidates: number;
  unchanged: number;
  ambiguous: number;
  written: number;
  concurrent: number;
  estimatedRecipeWrites: number;
  estimatedBackupWrites: number;
  issueCounts: Record<string, number>;
  ambiguousSamples: Array<{
    recipeId: string;
    sourceKey: string;
    reasons: string[];
  }>;
  complete: boolean;
  nextCursor?: string;
}

export type UnitBackfillTransform = {
  status: 'unchanged';
} | {
  status: 'ambiguous';
  issues: CatalogueUnitNormalizationIssue[];
} | {
  status: 'candidate';
  expectedContentHash: string;
  recipe: CompleteCanonicalRecipeV2;
};

export function normalizeRecipeForUnitBackfill(
  recipe: CompleteCanonicalRecipeV2,
  now = new Date().toISOString(),
): UnitBackfillTransform {
  const normalized = normalizeCatalogueContent(recipe.content);
  if (normalized.issues.length > 0) {
    return { status: 'ambiguous', issues: normalized.issues };
  }

  const expectedContentHash = catalogueContentHash(recipe.content);
  const nextSearch = buildSearchFields(
    recipe.effective,
    normalized.content.ingredients.map(({ name }) => name),
    recipe.search.randomKey,
  );
  const next: CompleteCanonicalRecipeV2 = {
    ...recipe,
    content: normalized.content,
    ingestion: {
      ...recipe.ingestion,
      contentHash: catalogueContentHash(normalized.content),
      ...(normalized.changed ? { lastChangedAt: now } : {}),
    },
    search: nextSearch,
    classification: {
      ...recipe.classification,
      parserVersion: CATALOGUE_PARSER_VERSION,
    },
  };
  return JSON.stringify(next) === JSON.stringify(recipe)
    ? { status: 'unchanged' }
    : { status: 'candidate', expectedContentHash, recipe: next };
}

export async function runUnitBackfill(options: {
  runId: string;
  store: UnitBackfillStore;
  apply?: boolean;
  writeCap?: number;
  pageSize?: number;
  sourceKeys?: readonly string[];
  startAfter?: string;
  now?: () => string;
}): Promise<UnitBackfillSummary> {
  const apply = options.apply ?? false;
  const writeCap = options.writeCap ?? 1_000;
  const pageSize = options.pageSize ?? 250;
  if (!options.runId || !Number.isInteger(writeCap) || writeCap < 0 || writeCap > 18_000
    || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) {
    throw new Error('Invalid unit backfill options');
  }

  const sourceKeys = options.sourceKeys ? new Set(options.sourceKeys) : undefined;
  let cursor = options.startAfter
    ?? (apply ? await options.store.loadCursor(options.runId) : undefined);
  let exhausted = false;
  const summary: UnitBackfillSummary = {
    mode: 'unit-backfill',
    apply,
    parserVersion: CATALOGUE_PARSER_VERSION,
    scanned: 0,
    candidates: 0,
    unchanged: 0,
    ambiguous: 0,
    written: 0,
    concurrent: 0,
    estimatedRecipeWrites: 0,
    estimatedBackupWrites: 0,
    issueCounts: {},
    ambiguousSamples: [],
    complete: false,
  };

  while (!exhausted) {
    const page = await options.store.scan(cursor, pageSize);
    if (page.nextCursor === cursor && !page.exhausted) {
      throw new Error('Unit backfill scan did not advance');
    }
    const pageStartCursor = cursor;
    let processedCursor = pageStartCursor;
    let capped = false;
    exhausted = page.exhausted;
    for (const recipe of page.recipes) {
      summary.scanned += 1;
      if (sourceKeys && !sourceKeys.has(recipe.source.key)) {
        processedCursor = recipe.id;
        continue;
      }
      const transformed = normalizeRecipeForUnitBackfill(recipe, options.now?.());
      if (transformed.status === 'unchanged') {
        summary.unchanged += 1;
        processedCursor = recipe.id;
        continue;
      }
      if (transformed.status === 'ambiguous') {
        summary.ambiguous += 1;
        for (const issue of transformed.issues) {
          summary.issueCounts[issue.reason] = (summary.issueCounts[issue.reason] ?? 0) + 1;
        }
        if (summary.ambiguousSamples.length < 20) {
          summary.ambiguousSamples.push({
            recipeId: recipe.id,
            sourceKey: recipe.source.key,
            reasons: [...new Set(transformed.issues.map(({ reason }) => reason))],
          });
        }
        processedCursor = recipe.id;
        continue;
      }

      summary.candidates += 1;
      summary.estimatedRecipeWrites += 1;
      summary.estimatedBackupWrites += 1;
      if (!apply) {
        processedCursor = recipe.id;
        continue;
      }
      if ((summary.written + 1) * 2 > writeCap) {
        capped = true;
        break;
      }
      const result = await options.store.write(
        options.runId,
        transformed.expectedContentHash,
        transformed.recipe,
      );
      if (result === 'written') summary.written += 1;
      else if (result === 'concurrent') summary.concurrent += 1;
      else summary.unchanged += 1;
      processedCursor = recipe.id;
    }
    cursor = capped ? processedCursor : page.nextCursor;
    if (capped) exhausted = false;
    if (apply) await options.store.saveCursor(options.runId, cursor);
    if (capped) break;
  }

  summary.complete = exhausted;
  if (cursor) summary.nextCursor = cursor;
  if (apply) await options.store.summarize(options.runId, summary);
  return summary;
}
