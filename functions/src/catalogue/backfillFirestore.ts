import { FieldPath, FieldValue, getFirestore } from 'firebase-admin/firestore';

import {
  CLASSIFIER_VERSION,
  evaluateSourceCanary,
  type ClassificationBackfillStore,
  type ClassificationBackfillSummary,
  type SourceBackfillState,
  type SourceCanaryOutcome,
} from './backfill.js';
import {
  validateReadyRecipe,
  type CompleteCanonicalRecipeV2,
} from './domain.js';
import { CatalogueParseError, parseCatalogueRecipe } from './parser.js';
import type { RecipeSourceAdapter } from './sourceAdapters.js';

const CHECKPOINT_COLLECTION = 'catalogueBackfillCheckpoints';
const SOURCE_COLLECTION = 'catalogueSourceBackfills';
const RUN_COLLECTION = 'catalogueBackfillRuns';
const RECIPE_SCAN_PAGE_SIZE = 500;

async function forEachV2Recipe(
  visitor: (document: FirebaseFirestore.QueryDocumentSnapshot) => void,
): Promise<number> {
  const db = getFirestore();
  let cursor: string | undefined;
  let total = 0;
  while (true) {
    let query = db.collection('recipes')
      .where('schemaVersion', '==', 2)
      .orderBy(FieldPath.documentId())
      .limit(RECIPE_SCAN_PAGE_SIZE);
    if (cursor) query = query.startAfter(cursor);
    const snapshot = await query.get();
    for (const document of snapshot.docs) {
      visitor(document);
      cursor = document.id;
      total += 1;
    }
    if (snapshot.size < RECIPE_SCAN_PAGE_SIZE) return total;
  }
}

function completeRecipe(value: unknown): value is CompleteCanonicalRecipeV2 {
  if (!value || typeof value !== 'object') return false;
  const recipe = value as Partial<CompleteCanonicalRecipeV2>;
  return recipe.schemaVersion === 2
    && (recipe.status === 'ready' || recipe.status === 'review')
    && typeof recipe.id === 'string';
}

function boundedReason(error: unknown): string {
  const name = error instanceof Error ? error.name : 'unknown';
  return name.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 64) || 'unknown';
}

export function firestoreClassificationBackfillStore(
  runId: string,
  mode: 'classify-backfill' | 'retry-failed' = 'classify-backfill',
): ClassificationBackfillStore {
  if (!runId) throw new Error('Phase 4 run ID is required');
  const db = getFirestore();
  const checkpoint = db.collection(CHECKPOINT_COLLECTION).doc('phase4');
  const run = db.collection(RUN_COLLECTION).doc(runId);
  return {
    async loadCursor() {
      const snapshot = await checkpoint.get();
      const cursor = snapshot.get('classifierCursorId');
      return typeof cursor === 'string' && cursor ? cursor : undefined;
    },
    async scan(afterId, limit) {
      const results: CompleteCanonicalRecipeV2[] = [];
      let rawCursor = afterId;
      while (results.length < limit) {
        let query = db.collection('recipes')
          .where('schemaVersion', '==', 2)
          .orderBy(FieldPath.documentId())
          .limit(Math.min(500, Math.max(limit, 100)));
        if (rawCursor) query = query.startAfter(rawCursor);
        const snapshot = await query.get();
        if (snapshot.empty) break;
        for (const document of snapshot.docs) {
          rawCursor = document.id;
          const value = document.data();
          if (completeRecipe(value)) results.push({ ...value, id: document.id });
          if (results.length >= limit) break;
        }
        if (snapshot.size < Math.min(500, Math.max(limit, 100))) break;
      }
      return results;
    },
    writeClassified(expected, updated) {
      const reference = db.collection('recipes').doc(expected.id);
      return db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(reference);
        if (!snapshot.exists || !completeRecipe(snapshot.data())) return 'concurrent';
        const currentVersion = snapshot.get('classification.classifierVersion');
        if (typeof currentVersion === 'number' && currentVersion >= CLASSIFIER_VERSION) {
          return 'already-current';
        }
        const currentHash = snapshot.get('ingestion.contentHash');
        if (expected.contentHash !== undefined && currentHash !== expected.contentHash) {
          return 'concurrent';
        }
        transaction.set(reference, updated);
        return 'written';
      });
    },
    async saveCursor(cursor) {
      await checkpoint.set({
        schemaVersion: 1,
        classifierVersion: CLASSIFIER_VERSION,
        classifierCursorId: cursor ?? null,
        updatedAt: new Date().toISOString(),
      }, { merge: true });
    },
    async recordError(_recipeId, reasonCode) {
      await run.set({
        lastErrorCode: reasonCode.slice(0, 64),
        errorCount: FieldValue.increment(1),
        updatedAt: new Date().toISOString(),
      }, { merge: true });
    },
    async summarize(summary) {
      await run.set({ schemaVersion: 1, mode, ...summary }, { merge: true });
    },
  };
}

export interface SourceCanarySummary {
  sourceKey: string;
  state: SourceBackfillState;
  tested: number;
  succeeded: number;
  transient: number;
  protected: number;
  invalid: number;
  reasonCodes: string[];
}

export function selectSourceCanaryUrls(
  displayable: readonly string[],
  priorFailures: readonly string[],
  sampleLimit: number,
): string[] {
  return [...displayable, ...priorFailures]
    .filter((url, index, all) => all.indexOf(url) === index)
    .slice(0, sampleLimit);
}

export async function runSourceRefreshCanaries(options: {
  adapters: RecipeSourceAdapter[];
  now: () => Date;
  samplesPerSource?: number;
  candidateMode?: 'unresolved' | 'any' | 'snapshot';
}): Promise<{ mode: 'refresh-canary'; bySource: Record<string, SourceCanarySummary> }> {
  const sampleLimit = options.samplesPerSource ?? 5;
  if (!Number.isInteger(sampleLimit) || sampleLimit < 1 || sampleLimit > 10) {
    throw new Error('Invalid source canary sample limit');
  }
  const db = getFirestore();
  const candidates = new Map<string, string[]>();
  const priorFailures = new Map<string, string[]>();
  await forEachV2Recipe((document) => {
    const status = document.get('status');
    if (options.candidateMode === 'snapshot'
      && status !== 'ready' && status !== 'review') {
      const sourceKey = document.get('source.key');
      const url = document.get('source.canonicalUrl');
      if (typeof sourceKey !== 'string' || typeof url !== 'string') return;
      const values = priorFailures.get(sourceKey) ?? [];
      if (values.length < sampleLimit) values.push(url);
      priorFailures.set(sourceKey, values);
      return;
    }
    if (options.candidateMode === 'any' || options.candidateMode === 'snapshot') {
      if (status !== 'ready' && status !== 'review') return;
    } else if (status !== 'review'
      || (document.get('classification.parserVersion') ?? 0) !== 0) {
      return;
    }
    const sourceKey = document.get('source.key');
    const url = document.get('source.canonicalUrl');
    if (typeof sourceKey !== 'string' || typeof url !== 'string') return;
    const values = candidates.get(sourceKey) ?? [];
    if (values.length < sampleLimit) values.push(url);
    candidates.set(sourceKey, values);
  });

  const bySource: Record<string, SourceCanarySummary> = {};
  for (const adapter of options.adapters) {
    const urls = selectSourceCanaryUrls(
      candidates.get(adapter.sourceKey) ?? [],
      priorFailures.get(adapter.sourceKey) ?? [],
      sampleLimit,
    );
    if (options.candidateMode === 'snapshot' && urls.length < sampleLimit) {
      try {
        for await (const discovered of adapter.discover()) {
          if (!urls.includes(discovered.url)) urls.push(discovered.url);
          if (urls.length >= sampleLimit) break;
        }
      } catch {
        // Existing samples can still establish whether public fallbacks work.
      }
    }
    const outcomes: SourceCanaryOutcome[] = [];
    const reasons = new Set<string>();
    for (const url of urls) {
      try {
        const fetched = await adapter.fetch(url);
        if (fetched.kind === 'ok') {
          try {
            try {
              parseCatalogueRecipe(fetched.html, url);
            } catch (initialError) {
              if (!adapter.render || initialError instanceof CatalogueParseError
                && initialError.reasonCode === 'non-recipe-page') {
                throw initialError;
              }
              const rendered = await adapter.render(url);
              if (!rendered) throw initialError;
              parseCatalogueRecipe(rendered, url);
            }
            outcomes.push('success');
          } catch (error) {
            outcomes.push('invalid');
            reasons.add(error instanceof CatalogueParseError
              ? error.reasonCode
              : `parse-${boundedReason(error)}`);
          }
        } else if (fetched.kind === 'unsupported') {
          outcomes.push('protected');
          reasons.add('protected-access');
        } else if (fetched.kind === 'retryable') {
          outcomes.push('transient');
          reasons.add('transient-fetch');
        } else {
          outcomes.push('invalid');
          reasons.add('permanent-fetch');
        }
      } catch (error) {
        outcomes.push('transient');
        reasons.add(`fetch-${boundedReason(error)}`);
      }
    }
    if (outcomes.length === 0) reasons.add('no-review-samples');
    const state = evaluateSourceCanary(outcomes);
    const summary: SourceCanarySummary = {
      sourceKey: adapter.sourceKey,
      state,
      tested: outcomes.length,
      succeeded: outcomes.filter((outcome) => outcome === 'success').length,
      transient: outcomes.filter((outcome) => outcome === 'transient').length,
      protected: outcomes.filter((outcome) => outcome === 'protected').length,
      invalid: outcomes.filter((outcome) => outcome === 'invalid').length,
      reasonCodes: [...reasons].slice(0, 10),
    };
    bySource[adapter.sourceKey] = summary;
    await db.collection(SOURCE_COLLECTION).doc(adapter.sourceKey).set({
      schemaVersion: 1,
      ...summary,
      checkedAt: options.now().toISOString(),
    });
  }
  return { mode: 'refresh-canary', bySource };
}

export async function loadEligibleSourceKeys(
  requested: readonly string[],
): Promise<string[]> {
  const db = getFirestore();
  const sourceStates = await db.collection(SOURCE_COLLECTION).get();
  const eligible = new Set(sourceStates.docs.flatMap((document) =>
    document.get('state') === 'eligible' ? [document.id] : []));
  return [...new Set(requested)].filter((sourceKey) => eligible.has(sourceKey));
}

export async function loadEligibleRefreshWork(
  maxPerSource = 250,
): Promise<{ sourceKeys: string[]; targetUrls?: Record<string, string[]> }> {
  if (!Number.isInteger(maxPerSource) || maxPerSource < 1 || maxPerSource > 250) {
    throw new Error('Invalid Phase 4 source fairness cap');
  }
  const db = getFirestore();
  const sourceStates = await db.collection(SOURCE_COLLECTION).get();
  const eligible = new Set(sourceStates.docs.flatMap((document) =>
    document.get('state') === 'eligible' ? [document.id] : []));
  if (eligible.size === 0) return { sourceKeys: [] };

  const targets: Record<string, string[]> = {};
  await forEachV2Recipe((document) => {
    const sourceKey = document.get('source.key');
    if (typeof sourceKey !== 'string' || !eligible.has(sourceKey)
      || document.get('status') !== 'review'
      || (document.get('classification.parserVersion') ?? 0) !== 0) return;
    const url = document.get('source.canonicalUrl');
    if (typeof url !== 'string') return;
    const values = targets[sourceKey] ?? [];
    if (values.length < maxPerSource) values.push(url);
    targets[sourceKey] = values;
  });
  const targetedSourceKeys = Object.keys(targets).sort();
  return targetedSourceKeys.length
    ? { sourceKeys: targetedSourceKeys, targetUrls: targets }
    : { sourceKeys: [...eligible].sort() };
}

export interface Phase4Inventory {
  mode: 'verify-backfill';
  totalV2: number;
  completeV2: number;
  operationalV2: number;
  classifierCurrent: number;
  classifierStale: number;
  ready: number;
  review: number;
  invalidReady: number;
  missingMealType: number;
  missingCuisine: number;
  missingTime: number;
  bySource: Record<string, { total: number; ready: number; review: number }>;
  byParserVersion: Record<string, number>;
  byClassifierVersion: Record<string, number>;
  parserVersion0BySource: Record<string, number>;
  sourceStates: Record<SourceBackfillState, number>;
}

export async function verifyPhase4Backfill(): Promise<Phase4Inventory> {
  const db = getFirestore();
  const sources = await db.collection(SOURCE_COLLECTION).get();
  const result: Phase4Inventory = {
    mode: 'verify-backfill',
    totalV2: 0,
    completeV2: 0,
    operationalV2: 0,
    classifierCurrent: 0,
    classifierStale: 0,
    ready: 0,
    review: 0,
    invalidReady: 0,
    missingMealType: 0,
    missingCuisine: 0,
    missingTime: 0,
    bySource: {},
    byParserVersion: {},
    byClassifierVersion: {},
    parserVersion0BySource: {},
    sourceStates: { eligible: 0, unsupported: 0, failed: 0 },
  };
  result.totalV2 = await forEachV2Recipe((document) => {
    const value = document.data();
    if (!completeRecipe(value)) {
      result.operationalV2 += 1;
      return;
    }
    const recipe = { ...value, id: document.id };
    result.completeV2 += 1;
    result[recipe.status] += 1;
    const classifierVersion = recipe.classification.classifierVersion ?? 0;
    const parserVersion = recipe.classification.parserVersion ?? 0;
    if (classifierVersion >= CLASSIFIER_VERSION) {
      result.classifierCurrent += 1;
    } else {
      result.classifierStale += 1;
    }
    if (recipe.status === 'ready' && validateReadyRecipe(recipe).length > 0) {
      result.invalidReady += 1;
    }
    if (recipe.effective.mealTypes.length === 0) result.missingMealType += 1;
    if (recipe.effective.cuisines.length === 0) result.missingCuisine += 1;
    if (recipe.effective.totalMinutes === undefined) result.missingTime += 1;
    const source = result.bySource[recipe.source.key]
      ?? { total: 0, ready: 0, review: 0 };
    source.total += 1;
    source[recipe.status] += 1;
    result.bySource[recipe.source.key] = source;
    result.byParserVersion[String(parserVersion)] =
      (result.byParserVersion[String(parserVersion)] ?? 0) + 1;
    result.byClassifierVersion[String(classifierVersion)] =
      (result.byClassifierVersion[String(classifierVersion)] ?? 0) + 1;
    if (parserVersion === 0) {
      result.parserVersion0BySource[recipe.source.key] =
        (result.parserVersion0BySource[recipe.source.key] ?? 0) + 1;
    }
  });
  for (const document of sources.docs) {
    const state = document.get('state');
    if (state === 'eligible' || state === 'unsupported' || state === 'failed') {
      result.sourceStates[state as SourceBackfillState] += 1;
    }
  }
  return result;
}

export function sanitizedClassificationSummary(summary: ClassificationBackfillSummary) {
  const { startCursor: _startCursor, endCursor: _endCursor, ...sanitized } = summary;
  return sanitized;
}

export async function recordPhase4Run(runId: string, value: object): Promise<void> {
  await getFirestore().collection(RUN_COLLECTION).doc(runId).set({
    schemaVersion: 1,
    ...value,
    updatedAt: new Date().toISOString(),
  }, { merge: true });
}
