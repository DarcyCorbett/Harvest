import { createHash } from 'node:crypto';

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
import {
  shouldRefreshManifestEntry,
  type CatalogueManifest,
  type CatalogueManifestEntry,
} from './operations.js';
import { parseCatalogueRecipe } from './parser.js';
import type { DiscoveredUrl, RecipeSourceAdapter } from './sourceAdapters.js';

export interface CatalogueManifestStore {
  load(sourceKey: string): Promise<CatalogueManifest>;
  save(manifest: CatalogueManifest): Promise<void>;
}

export interface CatalogueRecipeStore {
  writeComplete(recipe: CompleteCanonicalRecipeV2): Promise<void>;
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
  status: 'complete' | 'budget-exhausted' | 'lease-unavailable';
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
  writeCap?: number;
  maxPerSource?: number;
  targetUrls?: Record<string, string[]>;
  parserVersion?: number;
  taxonomyVersion?: number;
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

function deterministicClassification(sourceMetadata: RecipeMetadata): CatalogueClassification {
  const mealTypes = sourceMetadata.mealTypes ?? [];
  const cuisines = sourceMetadata.cuisines ?? [];
  return {
    metadata: sourceMetadata,
    sources: {
      mealTypes: mealTypes.length ? 'source' : 'rule',
      cuisines: cuisines.length ? 'source' : 'rule',
      modifiers: sourceMetadata.modifiers?.length ? 'source' : 'rule',
    },
    complete: mealTypes.length > 0 && cuisines.length > 0,
  };
}

function contentHash(content: CompleteCanonicalRecipeV2['content']): string {
  return createHash('sha256').update(JSON.stringify(content), 'utf8').digest('hex');
}

export function mergeIngestedRecipe(
  existing: CompleteCanonicalRecipeV2 | undefined,
  incoming: CompleteCanonicalRecipeV2,
): CompleteCanonicalRecipeV2 {
  if (!existing?.manualOverrides) return incoming;
  const effective = buildEffectiveMetadata(incoming.sourceMetadata, existing.manualOverrides);
  const merged: CompleteCanonicalRecipeV2 = {
    ...incoming,
    manualOverrides: existing.manualOverrides,
    effective,
    search: buildSearchFields(
      effective,
      incoming.content.ingredients.map((ingredient) => ingredient.name),
      incoming.search.randomKey,
    ),
  };
  if (merged.status === 'ready' && validateReadyRecipe(merged).length) {
    merged.status = 'review';
  }
  return merged;
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
      const parserVersion = options.parserVersion ?? 1;
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

      if (requestedWrites === 0) {
        return finishSummary({
          status: 'budget-exhausted',
          reservedWrites: 0,
          consumedWrites: 0,
          metrics,
        });
      }
      const reservation = await dependencies.budget.reserve(
        Math.min(250, requestedWrites),
        dependencies.now(),
      );
      let totalReserved = reservation.granted;
      let quotaDate = reservation.quotaDate;
      let remaining = Math.max(0, reservation.granted - 1); // budget transaction
      if (remaining === 0 || !(await dependencies.lease.acquire(dependencies.now().getTime()))) {
        return finishSummary({
          status: remaining === 0 ? 'budget-exhausted' : 'lease-unavailable',
          quotaDate: reservation.quotaDate,
          reservedWrites: totalReserved,
          consumedWrites: totalReserved - remaining,
          metrics,
        });
      }
      remaining -= 1; // lease acquisition

      const manifests = new Map<string, CatalogueManifest>();
      const iterators = new Map<string, AsyncIterator<DiscoveredUrl>>();
      for (const adapter of adapters) {
        const manifest = await dependencies.manifests.load(adapter.sourceKey);
        manifests.set(adapter.sourceKey, manifest);
        const targets = options.targetUrls?.[adapter.sourceKey];
        const discovery = targets
          ? (async function* targetedDiscovery() {
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
      let discoveriesSinceLeaseCheck = 0;

      try {
        while (active.size > 0) {
          if (!options.dryRun && processingWrites <= 0) {
            const commandRemaining = requestedWrites - totalReserved;
            if (commandRemaining <= 0) break;
            const nextReservation = await dependencies.budget.reserve(
              Math.min(250, commandRemaining),
              dependencies.now(),
            );
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
            manifest.cursor = discovered.cursor;
            increment(adapter.sourceKey, 'discovered');
            discoveriesSinceLeaseCheck += 1;
            if (discoveriesSinceLeaseCheck >= 100) {
              if (!(await dependencies.lease.renew(dependencies.now().getTime()))) {
                throw new Error('Catalogue ingestion lease was lost');
              }
              discoveriesSinceLeaseCheck = 0;
              processingWrites = Math.max(0, processingWrites - 1);
            }
            const recipeId = canonicalRecipeId(discovered.url);
            let prior: CatalogueManifestEntry | undefined = manifest.entries[recipeId];
            if (!prior && dependencies.recipes.recoverManifestEntry) {
              bySource[adapter.sourceKey].recipeReads += 1;
              prior = await dependencies.recipes.recoverManifestEntry(recipeId) ?? undefined;
              if (prior) manifest.entries[recipeId] = prior;
            }
            if (!shouldRefreshManifestEntry(prior, {
              discoveredLastModified: discovered.lastModified,
              parserVersion,
              force: options.forceRefresh,
              now: dependencies.now(),
            })) {
              increment(adapter.sourceKey, 'unchanged');
              manifest.updatedAt = dependencies.now().toISOString();
              await dependencies.manifests.save(manifest);
              continue;
            }
            if (options.dryRun) continue;
            if (processingWrites <= 0) break;

            const fetched = await adapter.fetch(discovered.url);
            increment(adapter.sourceKey, 'fetched');
            const now = dependencies.now().toISOString();
            let wrote = false;
            if (fetched.kind === 'ok') {
              try {
                const parsed = parseCatalogueRecipe(fetched.html, discovered.url);
                increment(adapter.sourceKey, 'parsed');
                const classification = dependencies.classify
                  ? await dependencies.classify(parsed.content, parsed.sourceMetadata)
                  : deterministicClassification(parsed.sourceMetadata);
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
                    taxonomyVersion,
                    sources: classification.sources,
                    complete: classification.complete,
                  },
                  ingestion: {
                    contentHash: contentHash(parsed.content),
                    firstIngestedAt: now,
                    lastChangedAt: now,
                  },
                };
                if (validateReadyRecipe(recipe).length) {
                  recipe.status = 'review';
                  increment(adapter.sourceKey, 'review');
                }
                await dependencies.recipes.writeComplete(recipe);
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
              } catch {
                const record: OperationalCanonicalRecipeV2 = {
                  schemaVersion: 2,
                  id: recipeId,
                  status: 'invalid',
                  reasonCode: 'parse-or-classification-invalid',
                  source: {
                    key: adapter.sourceKey,
                    canonicalUrl: discovered.url,
                    originalUrl: discovered.url,
                  },
                  ingestion: { lastAttemptAt: now, lastErrorCode: 'invalid' },
                };
                await dependencies.recipes.writeOperational(record);
                increment(adapter.sourceKey, 'failed');
                recordDocument(adapter.sourceKey, recipeId, record);
                wrote = true;
                manifest.entries[recipeId] = {
                  ...manifestEntry(prior, { parserVersion, now, state: 'invalid' }),
                  urlHash: recipeId,
                };
              }
            } else {
              const permanent = fetched.kind === 'permanent' || fetched.kind === 'unsupported';
              const retryCount = (prior?.retryCount ?? 0) + 1;
              const record: OperationalCanonicalRecipeV2 = {
                schemaVersion: 2,
                id: recipeId,
                status: fetched.kind === 'unsupported'
                  ? 'disabled'
                  : permanent ? 'invalid' : 'retryable',
                reasonCode: `${fetched.kind}-${fetched.status}`,
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
              await dependencies.recipes.writeOperational(record);
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
              if (failures >= 3) active.delete(adapter.sourceKey);
            }

            if (wrote) processingWrites -= 1;
            if (wrote) {
              const processed = (processedBySource.get(adapter.sourceKey) ?? 0) + 1;
              processedBySource.set(adapter.sourceKey, processed);
              if (options.maxPerSource !== undefined && processed >= options.maxPerSource) {
                active.delete(adapter.sourceKey);
              }
            }
            manifest.updatedAt = now;
            await dependencies.manifests.save(manifest);
            if (processingWrites <= 0) break;
          }
          if (!progressed) break;
        }

        for (const adapter of adapters) {
          const manifest = manifests.get(adapter.sourceKey) as CatalogueManifest;
          await dependencies.runs.checkpoint(
            options.runId,
            adapter.sourceKey,
            manifest.cursor,
            metrics,
          );
          remaining -= 1;
        }
        const status = active.size > 0 && !options.dryRun ? 'budget-exhausted' : 'complete';
        const consumedWrites = totalReserved - Math.max(0, processingWrites);
        const summary = finishSummary({
          status,
          quotaDate,
          reservedWrites: totalReserved,
          consumedWrites,
          metrics,
        });
        await dependencies.runs.summarize(options.runId, summary);
        remaining -= 1;
        return summary;
      } finally {
        await dependencies.lease.release();
      }
    },
  };
}

export function cloudStorageManifestStore(bucketName?: string): CatalogueManifestStore {
  const bucket = bucketName ? getStorage().bucket(bucketName) : getStorage().bucket();
  return {
    async load(sourceKey) {
      const file = bucket.file(`manifests/${sourceKey}.json`);
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
      await bucket.file(`manifests/${manifest.sourceKey}.json`).save(
        JSON.stringify(manifest),
        { contentType: 'application/json', resumable: false },
      );
    },
  };
}

export function firestoreCatalogueRecipeStore(): CatalogueRecipeStore {
  const db = getFirestore();
  return {
    writeComplete(incoming) {
      const reference = db.collection('recipes').doc(incoming.id);
      return db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(reference);
        const existing = snapshot.exists && snapshot.get('schemaVersion') === 2
          && ['ready', 'review'].includes(snapshot.get('status'))
          ? snapshot.data() as CompleteCanonicalRecipeV2
          : undefined;
        transaction.set(reference, mergeIngestedRecipe(existing, incoming));
      });
    },
    async writeOperational(record) {
      await db.collection('recipes').doc(record.id).set(record);
    },
    async recoverManifestEntry(recipeId) {
      const snapshot = await db.collection('recipes').doc(recipeId).get();
      if (!snapshot.exists || snapshot.get('schemaVersion') !== 2) return null;
      const status = snapshot.get('status');
      const reasonCode = snapshot.get('reasonCode');
      const parserVersion = snapshot.get('classification.parserVersion');
      const lastFetched = snapshot.get('ingestion.lastAttemptAt')
        ?? snapshot.get('ingestion.lastChangedAt')
        ?? snapshot.get('ingestion.firstIngestedAt');
      const lastFetchedAt = typeof lastFetched === 'string'
        ? lastFetched
        : typeof lastFetched?.toDate === 'function'
          ? lastFetched.toDate().toISOString()
          : new Date(0).toISOString();
      const state: CatalogueManifestEntry['state'] = status === 'ready' || status === 'review'
        ? 'ready'
        : status === 'retryable'
          ? 'retryable'
          : typeof reasonCode === 'string'
            && (reasonCode.startsWith('permanent-') || reasonCode.startsWith('unsupported-'))
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
      await db.collection('catalogueRuns').doc(runId).set({
        ...summary,
        completedAt: new Date().toISOString(),
      }, { merge: true });
    },
  };
}

export function isCompleteRecipe(recipe: CanonicalRecipeV2): recipe is CompleteCanonicalRecipeV2 {
  return recipe.status === 'ready' || recipe.status === 'review';
}
