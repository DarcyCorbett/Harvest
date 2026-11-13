import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';

import {
  buildEffectiveMetadata,
  buildSearchFields,
  canonicalRecipeId,
  validateReadyRecipe,
  type CanonicalRecipeV2,
  type CompleteCanonicalRecipeV2,
  type OperationalCanonicalRecipeV2,
  type RecipeMetadata,
} from './domain.js';
import { catalogueContentHash } from './contentFingerprint.js';
import {
  shouldRefreshManifestEntry,
  type CatalogueManifest,
  type CatalogueManifestEntry,
} from './operations.js';
import {
  CatalogueParseError,
  parseCatalogueRecipe,
  type EnrichmentAvailability,
  type EnrichmentField,
} from './parser.js';
import { classifyCatalogueDeterministically } from './classifier.js';
import { hasDisplayContent } from './snapshotFirestore.js';
import { CATALOGUE_PARSER_VERSION } from './version.js';
import type { DiscoveredUrl, RecipeSourceAdapter } from './sourceAdapters.js';

export type CatalogueIngestionFailureStage =
  | 'budget-reserve'
  | 'lease-acquire'
  | 'lease-renew'
  | 'lease-release'
  | 'manifest-load'
  | 'manifest-save'
  | 'source-fetch'
  | 'recipe-recover'
  | 'recipe-write-complete'
  | 'recipe-write-operational'
  | 'run-checkpoint'
  | 'run-summarize'
  | 'generation-mode-read'
  | 'generation-mode-check';

export class CatalogueIngestionStageError extends Error {
  readonly stage: CatalogueIngestionFailureStage;
  readonly cause: unknown;
  readonly sourceKey?: string;

  constructor(stage: CatalogueIngestionFailureStage, cause: unknown, sourceKey?: string) {
    super(`Catalogue ingestion failed during ${stage}`);
    this.name = 'CatalogueIngestionStageError';
    this.stage = stage;
    this.cause = cause;
    this.sourceKey = sourceKey;
  }
}

async function atIngestionStage<T>(
  stage: CatalogueIngestionFailureStage,
  operation: () => Promise<T>,
  attempts = 1,
  sourceKey?: string,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof CatalogueIngestionStageError) throw error;
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
      }
    }
  }
  throw new CatalogueIngestionStageError(stage, lastError, sourceKey);
}

export interface CatalogueManifestStore {
  load(sourceKey: string): Promise<CatalogueManifest>;
  save(manifest: CatalogueManifest): Promise<void>;
}

export interface CatalogueRecipeStore {
  writeComplete(recipe: CompleteCanonicalRecipeV2, enrichment?: EnrichmentAvailability): Promise<void>;
  writeOperational(record: OperationalCanonicalRecipeV2): Promise<void>;
  recoverManifestEntry?(recipeId: string): Promise<CatalogueManifestEntry | null>;
}

export interface CatalogueRunStore {
  checkpoint(
    runId: string,
    sourceKey: string,
    cursor: string | undefined,
    metrics: CatalogueRunMetrics,
  ): Promise<void>;
  summarize(runId: string, summary: CatalogueRunSummary): Promise<void>;
}

export interface CatalogueLease {
  acquire(nowMs?: number): Promise<boolean>;
  renew(nowMs?: number): Promise<boolean>;
  release(): Promise<void>;
  startHeartbeat?(intervalMs?: number, onLost?: () => void): () => void;
}

export interface CatalogueBudget {
  limit: number;
  reserve(requested: number, now?: Date): Promise<{
    quotaDate: string;
    granted: number;
    used: number;
  }>;
}

export interface CatalogueClassification {
  metadata: RecipeMetadata;
  sources: Record<string, 'source' | 'rule' | 'ai'>;
  complete: boolean;
  classifierVersion?: number;
}

export interface CatalogueIngestionDependencies {
  adapters: RecipeSourceAdapter[];
  manifests: CatalogueManifestStore;
  recipes: CatalogueRecipeStore;
  runs: CatalogueRunStore;
  lease: CatalogueLease;
  budget: CatalogueBudget;
  now: () => Date;
  random: () => number;
  classify?: (
    content: CompleteCanonicalRecipeV2['content'],
    sourceMetadata: RecipeMetadata,
  ) => Promise<CatalogueClassification>;
  getTelemetry?: () => CatalogueRunTelemetry;
}

export interface CatalogueRunMetrics {
  discovered: number;
  unchanged: number;
  fetched: number;
  parsed: number;
  classified: number;
  written: number;
  review: number;
  retryable: number;
  permanentSkipped: number;
  failed: number;
}

export interface CatalogueSourceRunMetrics extends CatalogueRunMetrics {
  recipeReads: number;
  documentWrites: number;
  estimatedDocumentBytes: number;
  sampleRecipeIds: string[];
}

export interface CatalogueRunTelemetry {
  gemini: {
    calls: number;
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
  };
}

export interface CatalogueRunSummary {
  status: 'complete' | 'budget-exhausted' | 'provider-cap-exhausted'
    | 'source-cap-exhausted' | 'source-failure-exhausted' | 'lease-unavailable';
  quotaDate?: string;
  reservedWrites: number;
  consumedWrites: number;
  metrics: CatalogueRunMetrics;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  bySource: Record<string, CatalogueSourceRunMetrics>;
  telemetry?: CatalogueRunTelemetry;
}

export interface CatalogueIngestionOptions {
  runId: string;
  sourceKeys?: string[];
  dryRun?: boolean;
  forceRefresh?: boolean;
  refreshOutdatedParser?: boolean;
  writeCap?: number;
  maxPerSource?: number;
  maxConsecutiveFailures?: number;
  manifestCheckpointInterval?: number;
  targetUrls?: Record<string, string[]>;
  parserVersion?: number;
  taxonomyVersion?: number;
  snapshotMode?: boolean;
}

type RecipeContent = CompleteCanonicalRecipeV2['content'];

function normalizedStepText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function mergeInstructionEnrichment(
  existing: RecipeContent['instructions'],
  incoming: RecipeContent['instructions'],
): RecipeContent['instructions'] {
  const existingSteps = existing.filter((step) => !step.isHeader);
  const incomingSteps = incoming.filter((step) => !step.isHeader);
  if (existingSteps.length !== incomingSteps.length
    || incomingSteps.some((step, index) => (
      normalizedStepText(step.text) !== normalizedStepText(existingSteps[index].text)
    ))) return incoming;

  let stepIndex = 0;
  const structuralSource = incoming.some((step) => step.isHeader) ? incoming : existing;
  return structuralSource.map((structuralStep) => {
    if (structuralStep.isHeader) return structuralStep;
    const prior = existingSteps[stepIndex];
    const current = incomingSteps[stepIndex++];
    return {
      ...current,
      ...(!current.title && prior.title ? { title: prior.title } : {}),
      ...(!current.sourceUrl && prior.sourceUrl ? { sourceUrl: prior.sourceUrl } : {}),
      ...(!current.imageUrl && prior.imageUrl ? { imageUrl: prior.imageUrl } : {}),
      ...(!current.videoEmbedUrl && prior.videoEmbedUrl
        ? { videoEmbedUrl: prior.videoEmbedUrl }
        : {}),
    };
  });
}

/** Preserve optional enrichment when a refresh path cannot supply it. */
export function mergeRecipeContent(
  existing: RecipeContent,
  incoming: RecipeContent,
  availability: EnrichmentAvailability = {},
): RecipeContent {
  const preserve = (field: EnrichmentField): boolean => availability[field] !== 'confirmed-absent';
  return {
    ...incoming,
    ...(!incoming.imageUrl && existing.imageUrl && preserve('imageUrl') ? { imageUrl: existing.imageUrl } : {}),
    ...(incoming.imageUrls === undefined && existing.imageUrls && preserve('imageUrls')
      ? { imageUrls: existing.imageUrls }
      : {}),
    ...(!incoming.videoEmbedUrl && existing.videoEmbedUrl && preserve('videoEmbedUrl')
      ? { videoEmbedUrl: existing.videoEmbedUrl }
      : {}),
    ...(!incoming.description && existing.description && preserve('description')
      ? { description: existing.description }
      : {}),
    ...(incoming.attribution || (existing.attribution && preserve('attribution')) ? {
      attribution: { ...existing.attribution, ...incoming.attribution },
    } : {}),
    ...(incoming.sourceRating === undefined && existing.sourceRating && preserve('sourceRating')
      ? { sourceRating: existing.sourceRating }
      : {}),
    ...(incoming.equipment === undefined && existing.equipment && preserve('equipment')
      ? { equipment: existing.equipment }
      : {}),
    ...(incoming.additionalTimes === undefined && existing.additionalTimes && preserve('additionalTimes')
      ? { additionalTimes: existing.additionalTimes }
      : {}),
    ...(incoming.noteSections === undefined && existing.noteSections && preserve('noteSections')
      ? { noteSections: existing.noteSections }
      : {}),
    ...(!incoming.notes && existing.notes && preserve('notes') ? { notes: existing.notes } : {}),
    ...(incoming.dietaryClaims === undefined && existing.dietaryClaims && preserve('dietaryClaims')
      ? { dietaryClaims: existing.dietaryClaims }
      : {}),
    ...(incoming.cookingMethods === undefined && existing.cookingMethods && preserve('cookingMethods')
      ? { cookingMethods: existing.cookingMethods }
      : {}),
    ...(incoming.sourceCategories === undefined && existing.sourceCategories && preserve('sourceCategories')
      ? { sourceCategories: existing.sourceCategories }
      : {}),
    ...(incoming.sourceCuisines === undefined && existing.sourceCuisines && preserve('sourceCuisines')
      ? { sourceCuisines: existing.sourceCuisines }
      : {}),
    ...(incoming.sourceKeywords === undefined && existing.sourceKeywords && preserve('sourceKeywords')
      ? { sourceKeywords: existing.sourceKeywords }
      : {}),
    ...(incoming.estimatedCost === undefined && existing.estimatedCost && preserve('estimatedCost')
      ? { estimatedCost: existing.estimatedCost }
      : {}),
    ...(incoming.ingredientGroups === undefined && existing.ingredientGroups && preserve('ingredientGroups')
      ? { ingredientGroups: existing.ingredientGroups }
      : {}),
    ...(incoming.nutrition || (existing.nutrition && preserve('nutrition')) ? {
      nutrition: { ...(preserve('nutrition') ? existing.nutrition : {}), ...incoming.nutrition },
    } : {}),
    instructions: preserve('instructionEnrichment')
      ? mergeInstructionEnrichment(existing.instructions, incoming.instructions)
      : incoming.instructions,
  };
}

function emptyMetrics(): CatalogueRunMetrics {
  return {
    discovered: 0,
    unchanged: 0,
    fetched: 0,
    parsed: 0,
    classified: 0,
    written: 0,
    review: 0,
    retryable: 0,
    permanentSkipped: 0,
    failed: 0,
  };
}

function emptySourceMetrics(): CatalogueSourceRunMetrics {
  return {
    ...emptyMetrics(),
    recipeReads: 0,
    documentWrites: 0,
    estimatedDocumentBytes: 0,
    sampleRecipeIds: [],
  };
}

export function mergeIngestedRecipe(
  existing: CompleteCanonicalRecipeV2 | undefined,
  incoming: CompleteCanonicalRecipeV2,
  availability?: EnrichmentAvailability,
): CompleteCanonicalRecipeV2 {
  if (!existing) return incoming;
  const content = mergeRecipeContent(existing.content, incoming.content, availability);
  const contentChanged = catalogueContentHash(existing.content) !== catalogueContentHash(content);
  const preserveClassification = existing.classification.complete;
  const preserveClassificationVersion = preserveClassification
    && !contentChanged
    && existing.classification.taxonomyVersion >= 2
    && (existing.classification.classifierVersion ?? 0) >= 2;
  const sourceMetadata: RecipeMetadata = preserveClassification ? {
    ...incoming.sourceMetadata,
    ...(existing.sourceMetadata.mealTypes
      ? { mealTypes: existing.sourceMetadata.mealTypes }
      : {}),
    ...(existing.sourceMetadata.cuisines
      ? { cuisines: existing.sourceMetadata.cuisines }
      : {}),
    ...(existing.sourceMetadata.modifiers
      ? { modifiers: existing.sourceMetadata.modifiers }
      : {}),
  } : incoming.sourceMetadata;
  const effective = buildEffectiveMetadata(sourceMetadata, existing.manualOverrides);
  const randomKey = existing.search.randomKey;
  const merged: CompleteCanonicalRecipeV2 = {
    ...incoming,
    content,
    source: {
      ...incoming.source,
      key: existing.source.key,
      canonicalUrl: existing.source.canonicalUrl,
      originalUrl: existing.source.originalUrl,
    },
    ...(existing.manualOverrides ? { manualOverrides: existing.manualOverrides } : {}),
    sourceMetadata,
    effective,
    search: buildSearchFields(
      effective,
      content.ingredients.map((ingredient) => ingredient.name),
      randomKey,
    ),
    ingestion: {
      ...incoming.ingestion,
      contentHash: catalogueContentHash(content),
      ...(existing.ingestion.firstIngestedAt === undefined
        ? {}
        : { firstIngestedAt: existing.ingestion.firstIngestedAt }),
      ...(!contentChanged && existing.ingestion.lastChangedAt !== undefined
        ? { lastChangedAt: existing.ingestion.lastChangedAt }
        : {}),
    },
    classification: {
      ...incoming.classification,
      sources: {
        ...(preserveClassification
          ? existing.classification.sources
          : incoming.classification.sources),
        ...(existing.manualOverrides?.mealTypes === null
          || existing.manualOverrides?.mealTypes === undefined
          ? {}
          : { mealTypes: 'manual' }),
        ...(existing.manualOverrides?.cuisines === null
          || existing.manualOverrides?.cuisines === undefined
          ? {}
          : { cuisines: 'manual' }),
        ...(existing.manualOverrides?.modifiers === null
          || existing.manualOverrides?.modifiers === undefined
          ? {}
          : { modifiers: 'manual' }),
      },
      ...(preserveClassificationVersion && existing.classification.classifierVersion !== undefined
        ? { classifierVersion: existing.classification.classifierVersion }
        : {}),
      complete: effective.mealTypes.length > 0 && effective.cuisines.length > 0,
    },
  };
  if (merged.status === 'ready' && validateReadyRecipe(merged).length) {
    merged.status = 'review';
  }
  return merged;
}

export function mergeOperationalFailure(
  existing: CompleteCanonicalRecipeV2,
  failure: CompleteCanonicalRecipeV2['ingestion'],
): CompleteCanonicalRecipeV2 {
  const {
    contentHash: _contentHash,
    firstIngestedAt: _firstIngestedAt,
    lastChangedAt: _lastChangedAt,
    ...safeFailure
  } = failure;
  return {
    ...existing,
    ingestion: {
      ...existing.ingestion,
      ...safeFailure,
    },
  };
}

export function shouldPersistEnrichmentRecipe(
  existing: CompleteCanonicalRecipeV2,
  merged: CompleteCanonicalRecipeV2,
): boolean {
  return catalogueContentHash(merged.content) !== catalogueContentHash(existing.content)
    || merged.classification.parserVersion !== existing.classification.parserVersion;
}

export function markEnrichmentParserChecked(
  existing: CompleteCanonicalRecipeV2,
  parserVersion: number,
): CompleteCanonicalRecipeV2 {
  return {
    ...existing,
    classification: {
      ...existing.classification,
      parserVersion,
    },
  };
}

export function mergeStoredOperationalRecipe(
  existing: CompleteCanonicalRecipeV2,
  record: OperationalCanonicalRecipeV2,
  terminalParserVersion?: number,
): CompleteCanonicalRecipeV2 {
  const merged = mergeOperationalFailure(existing, record.ingestion);
  const terminal = record.status === 'disabled'
    || (record.status === 'invalid' && [
      'non-recipe-page',
      'protected-access',
      'unsupported-markup',
      'missing-recipe-markup',
      'missing-display-content',
    ].includes(record.reasonCode));
  return terminal && terminalParserVersion !== undefined
    ? {
      ...merged,
      classification: {
        ...merged.classification,
        parserVersion: terminalParserVersion,
      },
    }
    : merged;
}

function manifestEntry(
  prior: CatalogueManifestEntry | undefined,
  options: {
    sourceLastModified?: string;
    parserVersion: number;
    now: string;
    state: CatalogueManifestEntry['state'];
  },
): CatalogueManifestEntry {
  return {
    urlHash: prior?.urlHash ?? '',
    ...(options.sourceLastModified ? { sourceLastModified: options.sourceLastModified } : {}),
    parserVersion: options.parserVersion,
    lastFetchedAt: options.now,
    state: options.state,
    ...(prior?.retryCount === undefined ? {} : { retryCount: prior.retryCount }),
  };
}

export function createCatalogueIngestionEngine(dependencies: CatalogueIngestionDependencies) {
  return {
    async run(options: CatalogueIngestionOptions): Promise<CatalogueRunSummary> {
      const startedAtDate = dependencies.now();
      const metrics = emptyMetrics();
      const parserVersion = options.parserVersion ?? CATALOGUE_PARSER_VERSION;
      const taxonomyVersion = options.taxonomyVersion ?? 1;
      const adapters = dependencies.adapters.filter((adapter) =>
        !options.sourceKeys || options.sourceKeys.includes(adapter.sourceKey));
      if (adapters.length === 0) throw new Error('No catalogue sources selected');
      const bySource = Object.fromEntries(adapters.map((adapter) => [
        adapter.sourceKey,
        emptySourceMetrics(),
      ])) as Record<string, CatalogueSourceRunMetrics>;
      const increment = (sourceKey: string, field: keyof CatalogueRunMetrics): void => {
        metrics[field] += 1;
        bySource[sourceKey][field] += 1;
      };
      const recordDocument = (sourceKey: string, recipeId: string, value: unknown): void => {
        const source = bySource[sourceKey];
        source.documentWrites += 1;
        source.estimatedDocumentBytes += Buffer.byteLength(JSON.stringify(value), 'utf8');
        if (source.sampleRecipeIds.length < 20 && !source.sampleRecipeIds.includes(recipeId)) {
          source.sampleRecipeIds.push(recipeId);
        }
      };
      const finishSummary = (
        summary: Pick<CatalogueRunSummary,
          'status' | 'quotaDate' | 'reservedWrites' | 'consumedWrites' | 'metrics'>,
      ): CatalogueRunSummary => {
        const completedAtDate = dependencies.now();
        return {
          ...summary,
          startedAt: startedAtDate.toISOString(),
          completedAt: completedAtDate.toISOString(),
          durationMs: Math.max(0, completedAtDate.getTime() - startedAtDate.getTime()),
          bySource,
          ...(dependencies.getTelemetry ? { telemetry: dependencies.getTelemetry() } : {}),
        };
      };

      const requestedWrites = options.writeCap ?? dependencies.budget.limit;
      if (!Number.isInteger(requestedWrites)
        || requestedWrites < 0
        || requestedWrites > dependencies.budget.limit) {
        throw new Error('Write cap can only reduce the configured ingestion budget');
      }
      if (options.maxPerSource !== undefined
        && (!Number.isInteger(options.maxPerSource) || options.maxPerSource < 1)) {
        throw new Error('Maximum recipes per source must be a positive integer');
      }
      if (options.maxConsecutiveFailures !== undefined
        && (!Number.isInteger(options.maxConsecutiveFailures)
          || options.maxConsecutiveFailures < 3
          || options.maxConsecutiveFailures > 100)) {
        throw new Error('Invalid consecutive source failure cap');
      }
      if (options.manifestCheckpointInterval !== undefined
        && (!Number.isInteger(options.manifestCheckpointInterval)
          || options.manifestCheckpointInterval < 1
          || options.manifestCheckpointInterval > 100)) {
        throw new Error('Invalid manifest checkpoint interval');
      }

      if (requestedWrites === 0) {
        return finishSummary({
          status: 'budget-exhausted',
          reservedWrites: 0,
          consumedWrites: 0,
          metrics,
        });
      }
      const reservation = await atIngestionStage('budget-reserve', () =>
        dependencies.budget.reserve(Math.min(250, requestedWrites), dependencies.now()));
      let totalReserved = reservation.granted;
      let quotaDate = reservation.quotaDate;
      let remaining = Math.max(0, reservation.granted - 1); // budget transaction
      const acquired = remaining > 0 && await atIngestionStage('lease-acquire', () =>
        dependencies.lease.acquire(dependencies.now().getTime()));
      if (remaining === 0 || !acquired) {
        return finishSummary({
          status: remaining === 0 ? 'budget-exhausted' : 'lease-unavailable',
          quotaDate: reservation.quotaDate,
          reservedWrites: totalReserved,
          consumedWrites: totalReserved - remaining,
          metrics,
        });
      }
      remaining -= 1; // lease acquisition
      let leaseLost = false;
      const stopHeartbeat = dependencies.lease.startHeartbeat?.(60_000, () => {
        leaseLost = true;
      });
      for (const adapter of adapters) {
        adapter.setHeartbeat?.(async () => {
          if (!(await atIngestionStage('lease-renew', () =>
            dependencies.lease.renew(dependencies.now().getTime())))) {
            leaseLost = true;
            throw new Error('Catalogue ingestion lease was lost');
          }
        });
      }

      const manifests = new Map<string, CatalogueManifest>();
      const iterators = new Map<string, AsyncIterator<DiscoveredUrl>>();
      for (const adapter of adapters) {
        const manifest = await atIngestionStage('manifest-load', () =>
          dependencies.manifests.load(adapter.sourceKey));
        manifests.set(adapter.sourceKey, manifest);
        const targets = options.targetUrls?.[adapter.sourceKey];
        const discovery = targets
          ? (async function* targetedDiscovery() {
            // Target inventories are rebuilt from Firestore for every command.
            // A cursor from an earlier inventory therefore cannot safely index
            // into the new list: completed recipes have already disappeared
            // from it, and resuming by position would skip fresh candidates.
            for (let index = 0; index < targets.length; index += 1) {
              yield {
                url: adapter.canonicalize(targets[index]),
                cursor: `target-${index}`,
              };
            }
          })()
          : adapter.discover(manifest.cursor);
        iterators.set(adapter.sourceKey, discovery[Symbol.asyncIterator]());
      }

      // Reserve writes for release, summary, and one durable checkpoint/source.
      const closingWrites = 2 + adapters.length;
      let processingWrites = Math.max(0, remaining - closingWrites);
      const active = new Set(adapters.map((adapter) => adapter.sourceKey));
      const consecutiveFailures = new Map<string, number>();
      const processedBySource = new Map<string, number>();
      const unsavedManifestChanges = new Map<string, number>();
      const manifestCheckpointInterval = options.manifestCheckpointInterval ?? 1;
      const saveManifestProgress = async (
        manifest: CatalogueManifest,
        force = false,
      ): Promise<void> => {
        const changes = (unsavedManifestChanges.get(manifest.sourceKey) ?? 0) + 1;
        if (force || changes >= manifestCheckpointInterval) {
          // Replacing the same manifest object is idempotent. Retry a bounded
          // number of times because Cloud Storage can acknowledge the object
          // while the client receives a transient/ambiguous response.
          await atIngestionStage(
            'manifest-save',
            () => dependencies.manifests.save(manifest),
            3,
          );
          unsavedManifestChanges.set(manifest.sourceKey, 0);
        } else {
          unsavedManifestChanges.set(manifest.sourceKey, changes);
        }
      };
      let providerCapExhausted = false;
      let sourceCapExhausted = false;
      let sourceFailureExhausted = false;
      let operationError: unknown;

      try {
        while (active.size > 0) {
          if (!options.dryRun && processingWrites <= 0) {
            const commandRemaining = requestedWrites - totalReserved;
            if (commandRemaining <= 0) break;
            const nextReservation = await atIngestionStage('budget-reserve', () =>
              dependencies.budget.reserve(Math.min(250, commandRemaining), dependencies.now()));
            totalReserved += nextReservation.granted;
            quotaDate = nextReservation.quotaDate;
            processingWrites += Math.max(0, nextReservation.granted - 1);
            if (nextReservation.granted <= 1) break;
          }
          let progressed = false;
          for (const adapter of adapters) {
            if (!active.has(adapter.sourceKey)) continue;
            const iterator = iterators.get(adapter.sourceKey) as AsyncIterator<{
              url: string;
              lastModified?: string;
              cursor?: string;
            }>;
            let next: IteratorResult<DiscoveredUrl>;
            try {
              next = await iterator.next();
            } catch {
              increment(adapter.sourceKey, 'failed');
              active.delete(adapter.sourceKey);
              continue;
            }
            if (next.done) {
              active.delete(adapter.sourceKey);
              continue;
            }
            progressed = true;
            const discovered = next.value;
            const manifest = manifests.get(adapter.sourceKey) as CatalogueManifest;
            increment(adapter.sourceKey, 'discovered');
            if (leaseLost) throw new Error('Catalogue ingestion lease was lost');
            const recipeId = canonicalRecipeId(discovered.url);
            let prior: CatalogueManifestEntry | undefined = manifest.entries[recipeId];
            if (!prior && dependencies.recipes.recoverManifestEntry) {
              bySource[adapter.sourceKey].recipeReads += 1;
              prior = await atIngestionStage('recipe-recover', () =>
                dependencies.recipes.recoverManifestEntry!(recipeId)) ?? undefined;
              if (prior) manifest.entries[recipeId] = prior;
            }
            if (!shouldRefreshManifestEntry(prior, {
              discoveredLastModified: discovered.lastModified,
              parserVersion,
              refreshOutdatedParser: options.refreshOutdatedParser,
              force: options.forceRefresh,
              preserveReady: options.snapshotMode,
              now: dependencies.now(),
            })) {
              increment(adapter.sourceKey, 'unchanged');
              manifest.cursor = discovered.cursor;
              manifest.updatedAt = dependencies.now().toISOString();
              await saveManifestProgress(manifest);
              continue;
            }
            if (options.dryRun) continue;
            if (processingWrites <= 0) break;

            const fetched = await atIngestionStage(
              'source-fetch',
              () => adapter.fetch(discovered.url),
              1,
              adapter.sourceKey,
            );
            increment(adapter.sourceKey, 'fetched');
            const now = dependencies.now().toISOString();
            let wrote = false;
            if (fetched.kind === 'ok') {
              try {
                let parsed;
                try {
                  parsed = parseCatalogueRecipe(fetched.html, discovered.url);
                } catch (initialError) {
                  if (!adapter.render || initialError instanceof CatalogueParseError
                    && initialError.reasonCode === 'non-recipe-page') {
                    throw initialError;
                  }
                  const rendered = await adapter.render(discovered.url);
                  if (!rendered) throw initialError;
                  parsed = parseCatalogueRecipe(rendered, discovered.url);
                }
                increment(adapter.sourceKey, 'parsed');
                if (parsed.content.sourceRating && !parsed.content.sourceRating.capturedAt) {
                  parsed.content.sourceRating = {
                    ...parsed.content.sourceRating,
                    capturedAt: now,
                  };
                }
                const classification = dependencies.classify
                  ? await dependencies.classify(parsed.content, parsed.sourceMetadata)
                  : classifyCatalogueDeterministically(parsed.content, parsed.sourceMetadata);
                increment(adapter.sourceKey, 'classified');
                const effective = buildEffectiveMetadata(classification.metadata);
                const recipe: CompleteCanonicalRecipeV2 = {
                  schemaVersion: 2,
                  id: recipeId,
                  status: 'ready',
                  source: {
                    key: adapter.sourceKey,
                    canonicalUrl: discovered.url,
                    originalUrl: discovered.url,
                    ...(discovered.lastModified
                      ? { sourceLastModified: discovered.lastModified }
                      : {}),
                  },
                  content: parsed.content,
                  sourceMetadata: classification.metadata,
                  effective,
                  search: buildSearchFields(
                    effective,
                    parsed.content.ingredients.map((ingredient) => ingredient.name),
                    dependencies.random(),
                  ),
                  classification: {
                    parserVersion,
                    classifierVersion: classification.classifierVersion ?? 1,
                    taxonomyVersion,
                    sources: classification.sources,
                    complete: classification.complete,
                  },
                  ingestion: {
                    contentHash: catalogueContentHash(parsed.content),
                    firstIngestedAt: now,
                    lastChangedAt: now,
                  },
                };
                if (validateReadyRecipe(recipe).length) {
                  recipe.status = 'review';
                  increment(adapter.sourceKey, 'review');
                }
                await atIngestionStage('recipe-write-complete', () =>
                  dependencies.recipes.writeComplete(recipe, parsed.enrichment));
                increment(adapter.sourceKey, 'written');
                recordDocument(adapter.sourceKey, recipeId, recipe);
                wrote = true;
                manifest.entries[recipeId] = {
                  ...manifestEntry(prior, {
                    sourceLastModified: discovered.lastModified,
                    parserVersion,
                    now,
                    state: 'ready',
                  }),
                  urlHash: recipeId,
                };
                consecutiveFailures.set(adapter.sourceKey, 0);
              } catch (error) {
                if (error instanceof CatalogueIngestionStageError) throw error;
                if (error instanceof Error && error.name === 'GeminiCallCapError') {
                  providerCapExhausted = true;
                  active.clear();
                  break;
                }
                const record: OperationalCanonicalRecipeV2 = {
                  schemaVersion: 2,
                  id: recipeId,
                  status: 'invalid',
                  reasonCode: error instanceof CatalogueParseError
                    ? error.reasonCode
                    : 'unsupported-markup',
                  source: {
                    key: adapter.sourceKey,
                    canonicalUrl: discovered.url,
                    originalUrl: discovered.url,
                  },
                  ingestion: { lastAttemptAt: now, lastErrorCode: 'invalid' },
                };
                await atIngestionStage('recipe-write-operational', () =>
                  dependencies.recipes.writeOperational(record));
                increment(adapter.sourceKey, 'failed');
                recordDocument(adapter.sourceKey, recipeId, record);
                wrote = true;
                const terminalParseFailure = error instanceof CatalogueParseError;
                manifest.entries[recipeId] = {
                  ...manifestEntry(prior, {
                    parserVersion,
                    now,
                    state: terminalParseFailure ? 'permanent-skip' : 'invalid',
                  }),
                  urlHash: recipeId,
                };
              }
            } else {
              const permanent = fetched.kind === 'permanent' || fetched.kind === 'unsupported';
              const retryCount = (prior?.retryCount ?? 0) + 1;
              const reasonCode = fetched.kind === 'unsupported'
                ? 'protected-access'
                : fetched.kind === 'permanent'
                  ? 'non-recipe-page'
                  : fetched.status === 429
                    ? 'rate-limited'
                    : 'fetch-retryable';
              const record: OperationalCanonicalRecipeV2 = {
                schemaVersion: 2,
                id: recipeId,
                status: fetched.kind === 'unsupported'
                  ? 'disabled'
                  : permanent ? 'invalid' : 'retryable',
                reasonCode,
                source: {
                  key: adapter.sourceKey,
                  canonicalUrl: discovered.url,
                  originalUrl: discovered.url,
                },
                ingestion: {
                  lastAttemptAt: now,
                  retryCount,
                  lastErrorCode: `${fetched.status}`,
                  ...(!permanent ? {
                    nextRetryAt: new Date(
                      dependencies.now().getTime() + Math.min(24 * 60 * 60 * 1_000, 60_000 * 2 ** retryCount),
                    ).toISOString(),
                  } : {}),
                },
              };
              await atIngestionStage('recipe-write-operational', () =>
                dependencies.recipes.writeOperational(record));
              recordDocument(adapter.sourceKey, recipeId, record);
              wrote = true;
              if (permanent) increment(adapter.sourceKey, 'permanentSkipped');
              else increment(adapter.sourceKey, 'retryable');
              manifest.entries[recipeId] = {
                ...manifestEntry(prior, {
                  sourceLastModified: discovered.lastModified,
                  parserVersion,
                  now,
                  state: permanent ? 'permanent-skip' : 'retryable',
                }),
                urlHash: recipeId,
                retryCount,
                ...(!permanent ? { nextRetryAt: record.ingestion.nextRetryAt as string } : {}),
              };
              const failures = (consecutiveFailures.get(adapter.sourceKey) ?? 0) + 1;
              consecutiveFailures.set(adapter.sourceKey, failures);
              if (failures >= (options.maxConsecutiveFailures ?? 3)) {
                sourceFailureExhausted = true;
                active.delete(adapter.sourceKey);
              }
            }

            if (wrote) processingWrites -= 1;
            if (wrote) {
              const processed = (processedBySource.get(adapter.sourceKey) ?? 0) + 1;
              processedBySource.set(adapter.sourceKey, processed);
              if (options.maxPerSource !== undefined && processed >= options.maxPerSource) {
                sourceCapExhausted = true;
                active.delete(adapter.sourceKey);
              }
            }
            manifest.cursor = discovered.cursor;
            manifest.updatedAt = now;
            await saveManifestProgress(manifest);
            if (processingWrites <= 0) break;
          }
          if (!progressed) break;
        }

        for (const adapter of adapters) {
          const manifest = manifests.get(adapter.sourceKey) as CatalogueManifest;
          if ((unsavedManifestChanges.get(adapter.sourceKey) ?? 0) > 0) {
            await saveManifestProgress(manifest, true);
          }
          await atIngestionStage('run-checkpoint', () => dependencies.runs.checkpoint(
            options.runId, adapter.sourceKey, manifest.cursor, metrics));
          remaining -= 1;
        }
        const status = providerCapExhausted
          ? 'provider-cap-exhausted'
          : sourceFailureExhausted
            ? 'source-failure-exhausted'
            : sourceCapExhausted
              ? 'source-cap-exhausted'
              : active.size > 0 && !options.dryRun ? 'budget-exhausted' : 'complete';
        const consumedWrites = totalReserved - Math.max(0, processingWrites);
        const summary = finishSummary({
          status,
          quotaDate,
          reservedWrites: totalReserved,
          consumedWrites,
          metrics,
        });
        await atIngestionStage('run-summarize', () =>
          dependencies.runs.summarize(options.runId, summary));
        remaining -= 1;
        return summary;
      } catch (error) {
        operationError = error;
        throw error;
      } finally {
        stopHeartbeat?.();
        try {
          await atIngestionStage('lease-release', () => dependencies.lease.release());
        } catch (releaseError) {
          // Preserve the actionable primary stage if cleanup also fails.
          if (!operationError) throw releaseError;
        }
      }
    },
  };
}

export function cloudStorageManifestStore(
  bucketName?: string,
  prefix = 'manifests',
): CatalogueManifestStore {
  if (!/^[a-z0-9][a-z0-9/-]{0,127}$/.test(prefix)) {
    throw new Error('Invalid catalogue manifest prefix');
  }
  const bucket = bucketName ? getStorage().bucket(bucketName) : getStorage().bucket();
  return {
    async load(sourceKey) {
      const file = bucket.file(`${prefix}/${sourceKey}.json`);
      const [exists] = await file.exists();
      if (!exists) return { sourceKey, entries: {}, updatedAt: new Date(0).toISOString() };
      const [contents] = await file.download();
      const parsed = JSON.parse(contents.toString('utf8')) as CatalogueManifest;
      if (parsed.sourceKey !== sourceKey || !parsed.entries || typeof parsed.entries !== 'object') {
        throw new Error('Invalid catalogue manifest');
      }
      return parsed;
    },
    async save(manifest) {
      await saveVerifiedManifestObject(
        bucket.file(`${prefix}/${manifest.sourceKey}.json`),
        JSON.stringify(manifest),
      );
    },
  };
}

export interface ManifestObjectFile {
  save(
    contents: Buffer,
    options: { contentType: string; resumable: boolean },
  ): Promise<unknown>;
  download(): Promise<[Buffer, ...unknown[]]>;
}

export async function saveVerifiedManifestObject(
  file: ManifestObjectFile,
  serializedManifest: string,
): Promise<void> {
  const contents = Buffer.from(serializedManifest, 'utf8');
  try {
    await file.save(contents, {
      contentType: 'application/json',
      resumable: contents.byteLength >= 1_000_000,
    });
  } catch (saveError) {
    try {
      const [stored] = await file.download();
      if (stored.equals(contents)) return;
    } catch {
      // Preserve the original save failure for stage classification/retry.
    }
    throw saveError;
  }
}

export function firestoreCatalogueRecipeStore(options: {
  terminalParserVersion?: number;
  enrichmentOnly?: boolean;
  enrichmentRunId?: string;
} = {}): CatalogueRecipeStore {
  const db = getFirestore();
  return {
    writeComplete(incoming, enrichment) {
      const reference = db.collection('recipes').doc(incoming.id);
      return db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(reference);
        const existing = snapshot.exists && snapshot.get('schemaVersion') === 2
          && ['ready', 'review'].includes(snapshot.get('status'))
          ? snapshot.data() as CompleteCanonicalRecipeV2
          : undefined;
        if (options.enrichmentOnly && existing) {
          const existingCore = {
            title: existing.content.title,
            originalServings: existing.content.originalServings,
            ingredients: existing.content.ingredients,
            instructions: existing.content.instructions.filter((step) => !step.isHeader)
              .map((step) => step.text),
          };
          const incomingCore = {
            title: incoming.content.title,
            originalServings: incoming.content.originalServings,
            ingredients: incoming.content.ingredients,
            instructions: incoming.content.instructions.filter((step) => !step.isHeader)
              .map((step) => step.text),
          };
          if (JSON.stringify(existingCore) !== JSON.stringify(incomingCore)) {
            const runId = options.enrichmentRunId ?? 'unscoped';
            const run = db.collection('catalogueContentEnrichmentRuns').doc(runId);
            const backup = run.collection('backups').doc(incoming.id);
            const backupSnapshot = await transaction.get(backup);
            if (!backupSnapshot.exists) transaction.create(backup, snapshot.data()!);
            transaction.set(run.collection('coreChangeReview').doc(incoming.id), {
              sourceKey: existing.source.key,
              existingIngredientCount: existing.content.ingredients.length,
              incomingIngredientCount: incoming.content.ingredients.length,
              existingInstructionCount: existingCore.instructions.length,
              incomingInstructionCount: incomingCore.instructions.length,
              detectedAt: new Date().toISOString(),
            });
            transaction.set(reference, markEnrichmentParserChecked(
              existing,
              incoming.classification.parserVersion,
            ));
            return;
          }
          const safeIncoming = {
            ...incoming,
            content: {
              ...incoming.content,
              title: existing.content.title,
              originalServings: existing.content.originalServings,
              ingredients: existing.content.ingredients,
              instructions: incoming.content.instructions,
            },
          };
          const enriched = mergeIngestedRecipe(existing, safeIncoming, enrichment);
          const merged: CompleteCanonicalRecipeV2 = {
            ...enriched,
            status: existing.status,
            sourceMetadata: existing.sourceMetadata,
            ...(existing.manualOverrides ? { manualOverrides: existing.manualOverrides } : {}),
            effective: existing.effective,
            search: existing.search,
            classification: {
              ...existing.classification,
              parserVersion: incoming.classification.parserVersion,
            },
          };
          if (!shouldPersistEnrichmentRecipe(existing, merged)) return;
          const runId = options.enrichmentRunId ?? 'unscoped';
          const backup = db.collection('catalogueContentEnrichmentRuns').doc(runId)
            .collection('backups').doc(incoming.id);
          const backupSnapshot = await transaction.get(backup);
          if (!backupSnapshot.exists) transaction.create(backup, snapshot.data()!);
          transaction.set(reference, merged);
          return;
        }
        transaction.set(reference, mergeIngestedRecipe(existing, incoming, enrichment));
      });
    },
    writeOperational(record) {
      const reference = db.collection('recipes').doc(record.id);
      return db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(reference);
        const existing = snapshot.exists
          && snapshot.get('schemaVersion') === 2
          && ['ready', 'review'].includes(snapshot.get('status'))
          && hasDisplayContent(snapshot.data())
          ? snapshot.data() as CompleteCanonicalRecipeV2
          : undefined;
        if (!existing) {
          transaction.set(reference, record);
          return;
        }
        const merged = mergeStoredOperationalRecipe(
          existing,
          record,
          options.terminalParserVersion,
        );
        if (options.enrichmentOnly) {
          const runId = options.enrichmentRunId ?? 'unscoped';
          const backup = db.collection('catalogueContentEnrichmentRuns').doc(runId)
            .collection('backups').doc(record.id);
          const backupSnapshot = await transaction.get(backup);
          if (!backupSnapshot.exists) transaction.create(backup, snapshot.data()!);
        }
        transaction.set(reference, merged);
      });
    },
    async recoverManifestEntry(recipeId) {
      const snapshot = await db.collection('recipes').doc(recipeId).get();
      if (!snapshot.exists || snapshot.get('schemaVersion') !== 2) return null;
      const status = snapshot.get('status');
      const reasonCode = snapshot.get('reasonCode');
      const displayable = hasDisplayContent(snapshot.data());
      const parserVersion = snapshot.get('classification.parserVersion');
      const lastFetched = snapshot.get('ingestion.lastAttemptAt')
        ?? snapshot.get('ingestion.lastChangedAt')
        ?? snapshot.get('ingestion.firstIngestedAt');
      const lastFetchedAt = typeof lastFetched === 'string'
        ? lastFetched
        : typeof lastFetched?.toDate === 'function'
          ? lastFetched.toDate().toISOString()
          : new Date(0).toISOString();
      const state: CatalogueManifestEntry['state'] =
        (status === 'ready' || status === 'review') && displayable
        ? 'ready'
        : status === 'retryable'
          ? 'retryable'
          : typeof reasonCode === 'string'
            && [
              'non-recipe-page',
              'protected-access',
              'unsupported-markup',
              'missing-recipe-markup',
              'missing-display-content',
            ].includes(reasonCode)
            ? 'permanent-skip'
            : 'invalid';
      return {
        urlHash: recipeId,
        parserVersion: typeof parserVersion === 'number' ? parserVersion : 0,
        lastFetchedAt,
        state,
        ...(typeof snapshot.get('source.sourceLastModified') === 'string'
          ? { sourceLastModified: snapshot.get('source.sourceLastModified') as string }
          : {}),
        ...(typeof snapshot.get('ingestion.retryCount') === 'number'
          ? { retryCount: snapshot.get('ingestion.retryCount') as number }
          : {}),
      };
    },
  };
}

export function firestoreCatalogueRunStore(): CatalogueRunStore {
  const db = getFirestore();
  return {
    async checkpoint(runId, sourceKey, cursor, metrics) {
      await db.collection('catalogueRuns').doc(runId).set({
        checkpoints: { [sourceKey]: { cursor: cursor ?? null, metrics } },
        updatedAt: new Date().toISOString(),
      }, { merge: true });
    },
    async summarize(runId, summary) {
      await db.collection('catalogueRuns').doc(runId).set(summary, { merge: true });
    },
  };
}

export function isCompleteRecipe(recipe: CanonicalRecipeV2): recipe is CompleteCanonicalRecipeV2 {
  return recipe.status === 'ready' || recipe.status === 'review';
}
