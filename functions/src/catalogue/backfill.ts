import {
  buildEffectiveMetadata,
  buildSearchFields,
  validateReadyRecipe,
  type CompleteCanonicalRecipeV2,
  type RecipeMetadata,
} from './domain.js';
import {
  mergeOperationalFailure,
  type CatalogueBudget,
  type CatalogueClassification,
  type CatalogueLease,
} from './ingestion.js';

export { mergeOperationalFailure };

export const CLASSIFIER_VERSION = 1;
export const DEFAULT_PHASE4_WRITE_CAP = 8_000;
export const MAX_PHASE4_WRITE_CAP = 18_000;
export const DEFAULT_GEMINI_CALL_CAP = 500;
export const MAX_GEMINI_CALL_CAP = 500;

export class GeminiCallCapError extends Error {
  constructor() {
    super('Phase 4 Gemini call cap exhausted');
    this.name = 'GeminiCallCapError';
  }
}

export type StoredRecipeClassifier = (
  content: CompleteCanonicalRecipeV2['content'],
  sourceMetadata: RecipeMetadata,
) => Promise<CatalogueClassification>;

function manualClassificationSources(
  recipe: CompleteCanonicalRecipeV2,
  sources: CatalogueClassification['sources'],
): CompleteCanonicalRecipeV2['classification']['sources'] {
  return {
    ...recipe.classification.sources,
    ...sources,
    ...(recipe.manualOverrides?.mealTypes === null
      || recipe.manualOverrides?.mealTypes === undefined
      ? {}
      : { mealTypes: 'manual' as const }),
    ...(recipe.manualOverrides?.cuisines === null
      || recipe.manualOverrides?.cuisines === undefined
      ? {}
      : { cuisines: 'manual' as const }),
    ...(recipe.manualOverrides?.modifiers === null
      || recipe.manualOverrides?.modifiers === undefined
      ? {}
      : { modifiers: 'manual' as const }),
  };
}

export async function classifyStoredRecipe(
  recipe: CompleteCanonicalRecipeV2,
  classify: StoredRecipeClassifier,
): Promise<CompleteCanonicalRecipeV2> {
  const classification = await classify(recipe.content, recipe.sourceMetadata);
  const effective = buildEffectiveMetadata(classification.metadata, recipe.manualOverrides);
  const complete = effective.mealTypes.length > 0 && effective.cuisines.length > 0;
  const updated: CompleteCanonicalRecipeV2 = {
    ...recipe,
    status: 'ready',
    sourceMetadata: classification.metadata,
    effective,
    search: buildSearchFields(
      effective,
      recipe.content.ingredients.map((ingredient) => ingredient.name),
      recipe.search.randomKey,
    ),
    classification: {
      ...recipe.classification,
      classifierVersion: CLASSIFIER_VERSION,
      taxonomyVersion: 1,
      sources: manualClassificationSources(recipe, classification.sources),
      complete,
    },
  };
  if (validateReadyRecipe(updated).length > 0) updated.status = 'review';
  return updated;
}

export type ClassificationWriteOutcome = 'written' | 'already-current' | 'concurrent';

export interface ClassificationBackfillStore {
  loadCursor(): Promise<string | undefined>;
  scan(afterId: string | undefined, limit: number): Promise<CompleteCanonicalRecipeV2[]>;
  writeClassified(
    expected: { id: string; classifierVersion: number; contentHash?: string },
    updated: CompleteCanonicalRecipeV2,
  ): Promise<ClassificationWriteOutcome>;
  saveCursor(cursor: string | undefined): Promise<void>;
  recordError(recipeId: string, reasonCode: string): Promise<void>;
  summarize(summary: ClassificationBackfillSummary): Promise<void>;
}

export interface ClassificationBackfillSummary {
  runId: string;
  status: 'complete' | 'write-cap-exhausted' | 'provider-cap-exhausted' | 'lease-unavailable';
  quotaDate?: string;
  scanned: number;
  skippedCurrent: number;
  written: number;
  ready: number;
  review: number;
  failed: number;
  concurrent: number;
  geminiCalls: number;
  startCursor?: string;
  endCursor?: string;
  startedAt: string;
  completedAt: string;
}

export function createClassificationBackfillEngine(dependencies: {
  store: ClassificationBackfillStore;
  lease: CatalogueLease;
  budget: CatalogueBudget;
  classify: StoredRecipeClassifier;
  getGeminiCalls: () => number;
  now: () => Date;
}) {
  return {
    async run(options: {
      runId: string;
      writeCap?: number;
      geminiCallCap?: number;
      resetCursor?: boolean;
      pageSize?: number;
    }): Promise<ClassificationBackfillSummary> {
      const writeCap = options.writeCap ?? DEFAULT_PHASE4_WRITE_CAP;
      const geminiCallCap = options.geminiCallCap ?? DEFAULT_GEMINI_CALL_CAP;
      const pageSize = options.pageSize ?? 100;
      if (!options.runId
        || !Number.isInteger(writeCap) || writeCap < 0 || writeCap > MAX_PHASE4_WRITE_CAP
        || !Number.isInteger(geminiCallCap) || geminiCallCap < 0 || geminiCallCap > MAX_GEMINI_CALL_CAP
        || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) {
        throw new Error('Invalid Phase 4 classification options');
      }

      const startedAt = dependencies.now();
      const startCursor = options.resetCursor ? undefined : await dependencies.store.loadCursor();
      let cursor = startCursor;
      let status: ClassificationBackfillSummary['status'] = 'complete';
      let quotaDate: string | undefined;
      let allowance = 0;
      const counts = {
        scanned: 0,
        skippedCurrent: 0,
        written: 0,
        ready: 0,
        review: 0,
        failed: 0,
        concurrent: 0,
      };

      if (!(await dependencies.lease.acquire(startedAt.getTime()))) {
        status = 'lease-unavailable';
      } else {
        try {
          const reservation = await dependencies.budget.reserve(writeCap, startedAt);
          quotaDate = reservation.quotaDate;
          allowance = reservation.granted;
          let stop = false;
          while (!stop) {
            const page = await dependencies.store.scan(cursor, pageSize);
            if (page.length === 0) break;
            for (const recipe of page) {
              counts.scanned += 1;
              if ((recipe.classification.classifierVersion ?? 0) >= CLASSIFIER_VERSION) {
                counts.skippedCurrent += 1;
                cursor = recipe.id;
                continue;
              }
              if (counts.written >= allowance) {
                status = 'write-cap-exhausted';
                stop = true;
                break;
              }
              try {
                const updated = await classifyStoredRecipe(recipe, dependencies.classify);
                if (dependencies.getGeminiCalls() > geminiCallCap) throw new GeminiCallCapError();
                const outcome = await dependencies.store.writeClassified({
                  id: recipe.id,
                  classifierVersion: recipe.classification.classifierVersion ?? 0,
                  ...(recipe.ingestion.contentHash
                    ? { contentHash: recipe.ingestion.contentHash }
                    : {}),
                }, updated);
                if (outcome === 'written') {
                  counts.written += 1;
                  counts[updated.status] += 1;
                } else if (outcome === 'already-current') {
                  counts.skippedCurrent += 1;
                } else {
                  counts.concurrent += 1;
                }
                cursor = recipe.id;
              } catch (error) {
                if (error instanceof GeminiCallCapError) {
                  status = 'provider-cap-exhausted';
                  stop = true;
                  break;
                }
                counts.failed += 1;
                await dependencies.store.recordError(recipe.id, 'classification-failed');
                cursor = recipe.id;
              }
            }
            await dependencies.store.saveCursor(cursor);
            if (stop || page.length < pageSize) break;
            if (!(await dependencies.lease.renew(dependencies.now().getTime()))) {
              throw new Error('Catalogue ingestion lease was lost');
            }
          }
        } finally {
          await dependencies.lease.release();
        }
      }

      const summary: ClassificationBackfillSummary = {
        runId: options.runId,
        status,
        ...(quotaDate ? { quotaDate } : {}),
        ...counts,
        geminiCalls: dependencies.getGeminiCalls(),
        ...(startCursor ? { startCursor } : {}),
        ...(cursor ? { endCursor: cursor } : {}),
        startedAt: startedAt.toISOString(),
        completedAt: dependencies.now().toISOString(),
      };
      await dependencies.store.summarize(summary);
      return summary;
    },
  };
}

export type SourceCanaryOutcome = 'success' | 'transient' | 'protected' | 'invalid';
export type SourceBackfillState = 'eligible' | 'unsupported' | 'failed';

export function evaluateSourceCanary(outcomes: readonly SourceCanaryOutcome[]): SourceBackfillState {
  const protectedCount = outcomes.filter((outcome) => outcome === 'protected').length;
  if (protectedCount >= 2) return 'unsupported';
  const transientCount = outcomes.filter((outcome) => outcome === 'transient').length;
  const successCount = outcomes.filter((outcome) => outcome === 'success').length;
  if (successCount === outcomes.length && outcomes.length > 0) return 'eligible';
  if (outcomes.length === 5 && successCount >= 4 && transientCount <= 1) return 'eligible';
  return 'failed';
}
