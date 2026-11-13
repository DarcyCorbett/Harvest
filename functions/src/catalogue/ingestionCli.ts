import { randomUUID } from 'node:crypto';

import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

import { requestGeminiJson } from '../ai/geminiProvider.js';
import {
  DEFAULT_GEMINI_CALL_CAP,
  DEFAULT_PHASE4_WRITE_CAP,
  GeminiCallCapError,
  createClassificationBackfillEngine,
} from './backfill.js';
import {
  firestoreClassificationBackfillStore,
  loadEligibleSourceKeys,
  loadEligibleRefreshWork,
  loadContentEnrichmentWork,
  loadNutritionRefreshWork,
  recordPhase4Run,
  runSourceRefreshCanaries,
  sanitizedClassificationSummary,
  verifyPhase4Backfill,
  verifyNutritionBackfill,
} from './backfillFirestore.js';
import {
  classifyCatalogueDeterministically,
  createCatalogueClassifier,
} from './classifier.js';
import {
  CatalogueIngestionStageError,
  cloudStorageManifestStore,
  createCatalogueIngestionEngine,
  firestoreCatalogueRecipeStore,
  firestoreCatalogueRunStore,
} from './ingestion.js';
import {
  collectGeminiTagBatch,
  createGeminiBatchApi,
  prepareGeminiTagBatch,
  submitNextGeminiTagBatch,
  tagWeeklyNewRecipes,
} from './geminiBatch.js';
import {
  parseIngestionArguments,
  sanitizedIngestionFailureReason,
  sanitizedIngestionFailureSource,
  sanitizedIngestionFailureStage,
} from './ingestionCommand.js';
import {
  createBudgetManager,
  createLeaseManager,
  firestoreCatalogueOpsDocuments,
} from './operations.js';
import { runNutritionCanaries } from './nutritionBackfill.js';
import {
  WORDPRESS_SOURCE_KEYS,
  createTrustedSourceAdapters,
  inventorySourceDiscovery,
} from './sourceAdapters.js';
import {
  buildSnapshotInventory,
  cloudStorageSnapshotStore,
  inventoryTargets,
  newAvailableInventoryTargets,
  newInventoryTargets,
  nextReconciliation,
} from './snapshot.js';
import {
  snapshotReconciliationTargets,
  verifySnapshotInventory,
} from './snapshotFirestore.js';
import { CATALOGUE_PARSER_VERSION, CATALOGUE_TAXONOMY_VERSION } from './version.js';
import {
  applyStagedTaxonomyRetag,
  prepareTaxonomyRetagBatch,
  stageNextTaxonomyRetagBatch,
  submitNextTaxonomyRetagBatch,
  verifyTaxonomyRetag,
} from './taxonomyRetagBatch.js';

initializeApp();

type GenerationMode = 'legacy' | 'catalogue';

async function readGenerationMode(): Promise<GenerationMode> {
  let config;
  try {
    config = await getFirestore().collection('appConfig').doc('catalogue').get();
  } catch (error) {
    throw new CatalogueIngestionStageError('generation-mode-read', error);
  }
  const mode = config.get('generationMode');
  if (mode !== 'legacy' && mode !== 'catalogue') {
    throw new Error('Catalogue generation mode is invalid');
  }
  return mode;
}

async function assertGenerationMode(expected: GenerationMode): Promise<void> {
  if (await readGenerationMode() !== expected) {
    throw new CatalogueIngestionStageError(
      'generation-mode-check',
      new Error('Catalogue generation mode changed during ingestion'),
    );
  }
}

function sanitizedIngestionSummary<T extends {
  bySource: Record<string, { sampleRecipeIds?: string[] }>;
}>(summary: T): T {
  return {
    ...summary,
    bySource: Object.fromEntries(Object.entries(summary.bySource).map(([sourceKey, source]) => [
      sourceKey,
      { ...source, sampleRecipeIds: [] },
    ])),
  };
}

async function main(): Promise<void> {
  const command = parseIngestionArguments(process.argv.slice(2));
  const runId = command.runId ?? randomUUID();
  const initialGenerationMode = await readGenerationMode();
  const secret = process.env.GEMINI_API_KEY?.trim() ?? '';
  const operational = firestoreCatalogueOpsDocuments();
  const geminiCallCap = command.geminiCallCap ?? DEFAULT_GEMINI_CALL_CAP;
  const gemini = {
    calls: 0,
    promptTokenCount: 0,
    candidatesTokenCount: 0,
    totalTokenCount: 0,
  };
  const classifier = createCatalogueClassifier({
    requestJson(prompt, responseJsonSchema, maxOutputTokens = 512) {
      if (gemini.calls >= geminiCallCap) throw new GeminiCallCapError();
      gemini.calls += 1;
      return requestGeminiJson({
        apiKey: secret,
        model: 'gemini-3.1-flash-lite',
        prompt,
        maxOutputTokens,
        responseJsonSchema,
        thinkingLevel: 'minimal',
        onUsage(usage) {
          gemini.promptTokenCount += usage.promptTokenCount;
          gemini.candidatesTokenCount += usage.candidatesTokenCount;
          gemini.totalTokenCount += usage.totalTokenCount;
        },
      });
    },
  });
  const adapters = createTrustedSourceAdapters();
  const phase4WriteCap = command.writeCap ?? DEFAULT_PHASE4_WRITE_CAP;
  const wordpressSourceKeys = command.sourceKeys ?? [...WORDPRESS_SOURCE_KEYS];
  const wordpressAdapters = adapters.filter((adapter) =>
    wordpressSourceKeys.includes(adapter.sourceKey));
  const selectedAdapters = adapters.filter((adapter) =>
    !command.sourceKeys || command.sourceKeys.includes(adapter.sourceKey));
  const snapshotStore = cloudStorageSnapshotStore(process.env.CATALOGUE_MANIFEST_BUCKET);
  const deterministicCrawlEngine = (
    crawlAdapters: typeof adapters,
    manifestPrefix: string,
    writeCap: number,
    terminalParserVersion?: number,
  ) => createCatalogueIngestionEngine({
    adapters: crawlAdapters,
    manifests: cloudStorageManifestStore(
      process.env.CATALOGUE_MANIFEST_BUCKET,
      manifestPrefix,
    ),
    recipes: firestoreCatalogueRecipeStore({ terminalParserVersion }),
    runs: firestoreCatalogueRunStore(),
    lease: createLeaseManager(operational.lease, {
      ownerId: runId,
      ttlMs: 5 * 60 * 1_000,
    }),
    budget: createBudgetManager(operational.budget, {
      limit: 18_000,
      commandCap: writeCap,
    }),
    classify: async (content, sourceMetadata) =>
      classifyCatalogueDeterministically(content, sourceMetadata),
    now: () => new Date(),
    random: Math.random,
    getTelemetry: () => ({
      gemini: {
        calls: 0,
        promptTokenCount: 0,
        candidatesTokenCount: 0,
        totalTokenCount: 0,
      },
    }),
  });

  if (command.mode === 'nutrition-canary') {
    const work = await loadNutritionRefreshWork(5, command.sourceKeys);
    const lease = createLeaseManager(operational.lease, {
      ownerId: runId,
      ttlMs: 5 * 60 * 1_000,
    });
    if (!(await lease.acquire())) throw new Error('Catalogue ingestion lease unavailable');
    try {
      const summary = await runNutritionCanaries({
        adapters: selectedAdapters.filter((adapter) => work.sourceKeys.includes(adapter.sourceKey)),
        targetUrls: work.targetUrls,
      });
      await recordPhase4Run(runId, summary);
      await assertGenerationMode(initialGenerationMode);
      console.log(JSON.stringify({ runId, candidates: work.candidates, ...summary }));
      return;
    } finally {
      await lease.release();
    }
  }

  if (command.mode === 'verify-nutrition') {
    const summary = await verifyNutritionBackfill();
    await recordPhase4Run(runId, summary);
    await assertGenerationMode(initialGenerationMode);
    console.log(JSON.stringify({ runId, ...summary }));
    return;
  }

  if (command.mode === 'nutrition-backfill') {
    const work = await loadNutritionRefreshWork(
      Math.min(command.maxPerSource ?? 250, 250),
      command.sourceKeys,
    );
    if (work.sourceKeys.length === 0) {
      const summary = { mode: 'nutrition-backfill', status: 'complete', candidates: 0 };
      await recordPhase4Run(runId, summary);
      await assertGenerationMode(initialGenerationMode);
      console.log(JSON.stringify({ runId, ...summary }));
      return;
    }
    const writeCap = command.writeCap ?? 8_000;
    const summary = await deterministicCrawlEngine(
      selectedAdapters.filter((adapter) => work.sourceKeys.includes(adapter.sourceKey)),
      'nutrition-backfill-manifests',
      writeCap,
      CATALOGUE_PARSER_VERSION,
    ).run({
      runId,
      sourceKeys: work.sourceKeys,
      targetUrls: work.targetUrls,
      writeCap,
      maxPerSource: Math.min(command.maxPerSource ?? 250, 250),
      maxConsecutiveFailures: 25,
      manifestCheckpointInterval: 25,
      parserVersion: CATALOGUE_PARSER_VERSION,
      taxonomyVersion: CATALOGUE_TAXONOMY_VERSION,
    });
    await assertGenerationMode(initialGenerationMode);
    console.log(JSON.stringify({
      runId,
      mode: 'nutrition-backfill',
      candidates: work.candidates,
      ...sanitizedIngestionSummary(summary),
    }));
    return;
  }

  if (command.mode === 'snapshot-inventory') {
    const inventory = await buildSnapshotInventory({
      adapters: selectedAdapters,
      snapshotId: runId,
      now: () => new Date(),
    });
    await snapshotStore.saveImmutable(inventory);
    const inventoryComplete = Object.values(inventory.bySource)
      .every(({ status }) => status === 'complete');
    if (inventoryComplete) await snapshotStore.setLatest(inventory.snapshotId);
    await assertGenerationMode(initialGenerationMode);
    console.log(JSON.stringify({
      runId,
      mode: 'snapshot-inventory',
      snapshotId: inventory.snapshotId,
      hash: inventory.hash,
      total: inventory.total,
      inventoryComplete,
      bySource: Object.fromEntries(Object.entries(inventory.bySource)
        .map(([sourceKey, source]) => [sourceKey, {
          status: source.status,
          count: source.count,
          hash: source.hash,
          ...(source.reasonCode ? { reasonCode: source.reasonCode } : {}),
        }])),
    }));
    return;
  }

  if (command.mode === 'snapshot-canary') {
    const lease = createLeaseManager(operational.lease, {
      ownerId: runId,
      ttlMs: 5 * 60 * 1_000,
    });
    if (!(await lease.acquire())) throw new Error('Catalogue ingestion lease unavailable');
    const stopHeartbeat = lease.startHeartbeat(60_000);
    for (const adapter of selectedAdapters) {
      adapter.setHeartbeat?.(async () => {
        if (!(await lease.renew())) throw new Error('Catalogue ingestion lease was lost');
      });
    }
    try {
      const summary = await runSourceRefreshCanaries({
        adapters: selectedAdapters,
        now: () => new Date(),
        samplesPerSource: 10,
        candidateMode: 'snapshot',
      });
      await recordPhase4Run(runId, { ...summary, mode: 'snapshot-canary' });
      await assertGenerationMode(initialGenerationMode);
      console.log(JSON.stringify({ ...summary, mode: 'snapshot-canary' }));
      return;
    } finally {
      stopHeartbeat();
      await lease.release();
    }
  }

  if (command.mode === 'snapshot-crawl') {
    const inventory = await snapshotStore.loadLatest();
    const targets = inventoryTargets(inventory, command.sourceKeys);
    const sourceKeys = Object.keys(targets);
    const crawlWriteCap = command.writeCap ?? 18_000;
    const summary = await deterministicCrawlEngine(
      selectedAdapters,
      `snapshot-crawl-manifests/${inventory.snapshotId}`,
      crawlWriteCap,
    ).run({
      runId,
      sourceKeys,
      targetUrls: targets,
      writeCap: crawlWriteCap,
      maxPerSource: command.maxPerSource,
      maxConsecutiveFailures: 25,
      manifestCheckpointInterval: 25,
      parserVersion: CATALOGUE_PARSER_VERSION,
      taxonomyVersion: CATALOGUE_TAXONOMY_VERSION,
      snapshotMode: true,
    });
    await assertGenerationMode(initialGenerationMode);
    console.log(JSON.stringify({
      runId,
      mode: 'snapshot-crawl',
      snapshotId: inventory.snapshotId,
      ...sanitizedIngestionSummary(summary),
    }));
    return;
  }

  if (command.mode === 'snapshot-reconcile') {
    const inventory = await snapshotStore.loadLatest();
    const targets = await snapshotReconciliationTargets(inventory, {
      sourceKeys: command.sourceKeys,
    });
    const sourceKeys = Object.keys(targets);
    if (sourceKeys.length === 0) {
      const summary = {
        runId,
        mode: 'snapshot-reconcile',
        status: 'complete',
        snapshotId: inventory.snapshotId,
        targets: 0,
      };
      await recordPhase4Run(runId, summary);
      await assertGenerationMode(initialGenerationMode);
      console.log(JSON.stringify(summary));
      return;
    }
    const reconcileWriteCap = command.writeCap ?? 18_000;
    const summary = await deterministicCrawlEngine(
      selectedAdapters,
      `snapshot-reconcile-manifests/${inventory.snapshotId}`,
      reconcileWriteCap,
    ).run({
      runId,
      sourceKeys,
      targetUrls: targets,
      forceRefresh: true,
      writeCap: reconcileWriteCap,
      maxPerSource: command.maxPerSource,
      maxConsecutiveFailures: 25,
      manifestCheckpointInterval: 25,
      parserVersion: CATALOGUE_PARSER_VERSION,
      taxonomyVersion: CATALOGUE_TAXONOMY_VERSION,
      snapshotMode: true,
    });
    await assertGenerationMode(initialGenerationMode);
    console.log(JSON.stringify({
      runId,
      mode: 'snapshot-reconcile',
      snapshotId: inventory.snapshotId,
      targets: Object.values(targets).reduce((sum, urls) => sum + urls.length, 0),
      ...sanitizedIngestionSummary(summary),
    }));
    return;
  }

  if (command.mode === 'snapshot-verify') {
    const inventory = await buildSnapshotInventory({
      adapters: selectedAdapters,
      snapshotId: runId,
      now: () => new Date(),
    });
    await snapshotStore.saveImmutable(inventory);
    const inventoryComplete = Object.values(inventory.bySource)
      .every(({ status }) => status === 'complete');
    if (!inventoryComplete) {
      const summary = {
        runId,
        mode: 'snapshot-verify',
        status: 'discovery-incomplete',
        snapshotId: inventory.snapshotId,
        hash: inventory.hash,
        total: inventory.total,
        failedSources: Object.entries(inventory.bySource)
          .filter(([, source]) => source.status === 'failed')
          .map(([sourceKey]) => sourceKey),
      };
      await recordPhase4Run(runId, summary);
      await assertGenerationMode(initialGenerationMode);
      console.log(JSON.stringify(summary));
      return;
    }
    await snapshotStore.setLatest(inventory.snapshotId);
    const verification = await verifySnapshotInventory(inventory);
    const reconciliation = nextReconciliation(
      await snapshotStore.loadReconciliation(),
      inventory,
    );
    const frozen = reconciliation.frozen && verification.complete;
    await snapshotStore.saveReconciliation({
      ...reconciliation,
      snapshotId: inventory.snapshotId,
      frozen,
      updatedAt: new Date().toISOString(),
    });
    await recordPhase4Run(runId, { ...verification, reconciliation, frozen });
    await assertGenerationMode(initialGenerationMode);
    console.log(JSON.stringify({ runId, ...verification, reconciliation, frozen }));
    return;
  }

  if (command.mode === 'tag-batch-prepare') {
    const reconciliation = await snapshotStore.loadReconciliation();
    if (!reconciliation.frozen) {
      throw new Error('Snapshot verification must be complete and stable before batch preparation');
    }
    const summary = await prepareGeminiTagBatch({
      runId,
      bucketName: process.env.CATALOGUE_MANIFEST_BUCKET,
      now: () => new Date(),
    });
    await assertGenerationMode(initialGenerationMode);
    console.log(JSON.stringify(summary));
    return;
  }

  if (command.mode === 'tag-batch-submit') {
    const summary = await submitNextGeminiTagBatch({
      api: createGeminiBatchApi({ apiKey: secret }),
      bucketName: process.env.CATALOGUE_MANIFEST_BUCKET,
      now: () => new Date(),
    });
    await assertGenerationMode(initialGenerationMode);
    console.log(JSON.stringify(summary));
    return;
  }

  if (command.mode === 'tag-batch-collect') {
    const summary = await collectGeminiTagBatch({
      api: createGeminiBatchApi({ apiKey: secret }),
      budget: createBudgetManager(operational.budget, {
        limit: 18_000,
        commandCap: 5_000,
      }),
      bucketName: process.env.CATALOGUE_MANIFEST_BUCKET,
      now: () => new Date(),
    });
    await assertGenerationMode(initialGenerationMode);
    console.log(JSON.stringify(summary));
    return;
  }

  if (command.mode?.startsWith('taxonomy-retag-') && initialGenerationMode !== 'catalogue') {
    throw new Error('Taxonomy-v2 retag requires catalogue generation mode');
  }

  if (command.mode === 'taxonomy-retag-prepare') {
    const summary = await prepareTaxonomyRetagBatch({
      runId,
      bucketName: process.env.CATALOGUE_MANIFEST_BUCKET,
      now: () => new Date(),
    });
    await assertGenerationMode(initialGenerationMode);
    console.log(JSON.stringify(summary));
    return;
  }

  if (command.mode === 'taxonomy-retag-submit') {
    const summary = await submitNextTaxonomyRetagBatch({
      api: createGeminiBatchApi({ apiKey: secret }),
      bucketName: process.env.CATALOGUE_MANIFEST_BUCKET,
      now: () => new Date(),
    });
    await assertGenerationMode(initialGenerationMode);
    console.log(JSON.stringify(summary));
    return;
  }

  if (command.mode === 'taxonomy-retag-stage') {
    const summary = await stageNextTaxonomyRetagBatch({
      api: createGeminiBatchApi({ apiKey: secret }),
      bucketName: process.env.CATALOGUE_MANIFEST_BUCKET,
      now: () => new Date(),
    });
    await assertGenerationMode(initialGenerationMode);
    console.log(JSON.stringify(summary));
    return;
  }

  if (command.mode === 'taxonomy-retag-apply') {
    const summary = await applyStagedTaxonomyRetag({
      budget: createBudgetManager(operational.budget, {
        limit: 18_000,
        commandCap: command.writeCap ?? 18_000,
      }),
      bucketName: process.env.CATALOGUE_MANIFEST_BUCKET,
      now: () => new Date(),
    });
    await assertGenerationMode(initialGenerationMode);
    console.log(JSON.stringify(summary));
    return;
  }

  if (command.mode === 'taxonomy-retag-verify') {
    const summary = await verifyTaxonomyRetag();
    await assertGenerationMode(initialGenerationMode);
    console.log(JSON.stringify(summary));
    return;
  }

  if (command.mode === 'weekly-new') {
    const reconciliation = await snapshotStore.loadReconciliation();
    if (!reconciliation.frozen || !reconciliation.snapshotId) {
      throw new Error('Completed snapshot baseline is required for weekly maintenance');
    }
    const baseline = await snapshotStore.load(reconciliation.snapshotId);
    const current = await buildSnapshotInventory({
      adapters: selectedAdapters,
      snapshotId: runId,
      now: () => new Date(),
    });
    await snapshotStore.saveImmutable(current);
    const discoveryFailures = Object.entries(current.bySource)
      .filter(([, source]) => source.status !== 'complete')
      .map(([sourceKey, source]) => ({
        sourceKey,
        reasonCode: source.reasonCode ?? 'discovery-failed',
      }));
    const targets = newAvailableInventoryTargets(baseline, current);
    const sourceKeys = Object.entries(targets)
      .filter(([, urls]) => urls.length > 0)
      .map(([sourceKey]) => sourceKey);
    if (sourceKeys.length === 0) {
      if (discoveryFailures.length === 0) {
        await snapshotStore.saveReconciliation({
          lastHash: current.hash,
          stableCount: 2,
          snapshotId: current.snapshotId,
          frozen: true,
          updatedAt: new Date().toISOString(),
        });
      }
      await assertGenerationMode(initialGenerationMode);
      console.log(JSON.stringify({
        runId,
        mode: 'weekly-new',
        status: discoveryFailures.length === 0 ? 'complete' : 'partial',
        discoveredNew: 0,
        fetched: 0,
        tagged: 0,
        discoveryFailures,
      }));
      return;
    }
    const weeklyWriteCap = command.writeCap ?? 17_500;
    const crawlSummary = await deterministicCrawlEngine(
      selectedAdapters.filter((adapter) => sourceKeys.includes(adapter.sourceKey)),
      'weekly-new-manifests',
      weeklyWriteCap,
    ).run({
      runId,
      sourceKeys,
      targetUrls: targets,
      writeCap: weeklyWriteCap,
      maxPerSource: command.maxPerSource,
      maxConsecutiveFailures: 25,
      manifestCheckpointInterval: 25,
      parserVersion: CATALOGUE_PARSER_VERSION,
      taxonomyVersion: CATALOGUE_TAXONOMY_VERSION,
      snapshotMode: true,
    });
    const newRecipeIds = Object.entries(current.bySource).flatMap(([sourceKey, source]) => {
      const selected = new Set(targets[sourceKey] ?? []);
      return source.items.filter(({ url }) => selected.has(url)).map(({ id }) => id);
    });
    const tagging = await tagWeeklyNewRecipes({
      recipeIds: newRecipeIds,
      classify: classifier,
      callCap: command.geminiCallCap ?? 500,
    });
    if (discoveryFailures.length === 0 && crawlSummary.status === 'complete'
      && tagging.failed === 0 && tagging.overflow === 0) {
      await snapshotStore.saveReconciliation({
        lastHash: current.hash,
        stableCount: 2,
        snapshotId: current.snapshotId,
        frozen: true,
        updatedAt: new Date().toISOString(),
      });
    }
    await assertGenerationMode(initialGenerationMode);
    console.log(JSON.stringify({
      runId,
      mode: 'weekly-new',
      discoveredNew: newRecipeIds.length,
      discoveryFailures,
      crawl: sanitizedIngestionSummary(crawlSummary),
      tagging,
    }));
    return;
  }

  if (command.mode === 'crawl-inventory') {
    const summary = await inventorySourceDiscovery(wordpressAdapters);
    await assertGenerationMode(initialGenerationMode);
    console.log(JSON.stringify({ runId, ...summary }));
    return;
  }

  if (command.mode === 'crawl-canary') {
    const lease = createLeaseManager(operational.lease, {
      ownerId: runId,
      ttlMs: 5 * 60 * 1_000,
    });
    if (!(await lease.acquire())) throw new Error('Catalogue ingestion lease unavailable');
    try {
      const summary = await runSourceRefreshCanaries({
        adapters: wordpressAdapters,
        now: () => new Date(),
        candidateMode: 'any',
      });
      await recordPhase4Run(runId, { ...summary, mode: 'crawl-canary' });
      await assertGenerationMode(initialGenerationMode);
      console.log(JSON.stringify({ ...summary, mode: 'crawl-canary' }));
      return;
    } finally {
      await lease.release();
    }
  }

  if (command.mode === 'classify-backfill' || command.mode === 'retry-failed') {
    const engine = createClassificationBackfillEngine({
      store: firestoreClassificationBackfillStore(runId, command.mode),
      lease: createLeaseManager(operational.lease, {
        ownerId: runId,
        ttlMs: 5 * 60 * 1_000,
      }),
      budget: createBudgetManager(operational.budget, {
        limit: 18_000,
        commandCap: phase4WriteCap,
      }),
      classify: classifier,
      getGeminiCalls: () => gemini.calls,
      now: () => new Date(),
    });
    const summary = await engine.run({
      runId,
      writeCap: phase4WriteCap,
      geminiCallCap,
      resetCursor: command.mode === 'retry-failed',
    });
    await assertGenerationMode(initialGenerationMode);
    console.log(JSON.stringify(sanitizedClassificationSummary(summary)));
    return;
  }

  if (command.mode === 'refresh-canary') {
    const lease = createLeaseManager(operational.lease, {
      ownerId: runId,
      ttlMs: 5 * 60 * 1_000,
    });
    if (!(await lease.acquire())) throw new Error('Catalogue ingestion lease unavailable');
    try {
      const summary = await runSourceRefreshCanaries({ adapters, now: () => new Date() });
      await recordPhase4Run(runId, summary);
      await assertGenerationMode(initialGenerationMode);
      console.log(JSON.stringify(summary));
      return;
    } finally {
      await lease.release();
    }
  }

  if (command.mode === 'verify-backfill') {
    const summary = await verifyPhase4Backfill();
    await recordPhase4Run(runId, summary);
    await assertGenerationMode(initialGenerationMode);
    console.log(JSON.stringify(summary));
    return;
  }

  if (command.mode === 'crawl-backfill') {
    const eligibleSourceKeys = await loadEligibleSourceKeys(wordpressSourceKeys);
    const ineligible = wordpressSourceKeys.filter((sourceKey) =>
      !eligibleSourceKeys.includes(sourceKey));
    if (ineligible.length > 0) {
      throw new Error('WordPress crawl source has not passed its canary');
    }
    const crawlWriteCap = command.writeCap ?? 18_000;
    const crawlEngine = createCatalogueIngestionEngine({
      adapters: wordpressAdapters,
      manifests: cloudStorageManifestStore(
        process.env.CATALOGUE_MANIFEST_BUCKET,
        'wordpress-crawl-manifests',
      ),
      recipes: firestoreCatalogueRecipeStore(),
      runs: firestoreCatalogueRunStore(),
      lease: createLeaseManager(operational.lease, {
        ownerId: runId,
        ttlMs: 5 * 60 * 1_000,
      }),
      budget: createBudgetManager(operational.budget, {
        limit: 18_000,
        commandCap: crawlWriteCap,
      }),
      classify: async (content, sourceMetadata) =>
        classifyCatalogueDeterministically(content, sourceMetadata),
      now: () => new Date(),
      random: Math.random,
      getTelemetry: () => ({
        gemini: {
          calls: 0,
          promptTokenCount: 0,
          candidatesTokenCount: 0,
          totalTokenCount: 0,
        },
      }),
    });
    const summary = await crawlEngine.run({
      runId,
      sourceKeys: eligibleSourceKeys,
      writeCap: crawlWriteCap,
      maxPerSource: command.maxPerSource,
      maxConsecutiveFailures: 25,
      manifestCheckpointInterval: 25,
      parserVersion: CATALOGUE_PARSER_VERSION,
      taxonomyVersion: CATALOGUE_TAXONOMY_VERSION,
    });
    await assertGenerationMode(initialGenerationMode);
    console.log(JSON.stringify({
      runId,
      mode: 'crawl-backfill',
      ...sanitizedIngestionSummary(summary),
    }));
    return;
  }

  if (command.mode === 'content-enrichment-canary'
    || command.mode === 'content-enrichment-backfill') {
    const perSource = command.mode === 'content-enrichment-canary'
      ? Math.min(command.maxPerSource ?? 10, 10)
      : Math.min(command.maxPerSource ?? 250, 5_000);
    const work = await loadContentEnrichmentWork(perSource, command.sourceKeys);
    if (work.candidates === 0) {
      console.log(JSON.stringify({ runId, mode: command.mode, status: 'complete', candidates: 0 }));
      return;
    }
    const requestedWriteCap = command.writeCap ?? (command.mode === 'content-enrichment-canary' ? 100 : 18_000);
    const recipeAttemptCap = Math.floor(requestedWriteCap / 2);
    const enrichmentEngine = createCatalogueIngestionEngine({
      adapters: selectedAdapters,
      manifests: cloudStorageManifestStore(
        process.env.CATALOGUE_MANIFEST_BUCKET,
        'content-enrichment-manifests',
      ),
      recipes: firestoreCatalogueRecipeStore({
        enrichmentOnly: true,
        enrichmentRunId: runId,
        terminalParserVersion: CATALOGUE_PARSER_VERSION,
      }),
      runs: firestoreCatalogueRunStore(),
      lease: createLeaseManager(operational.lease, { ownerId: runId, ttlMs: 5 * 60 * 1_000 }),
      budget: createBudgetManager(operational.budget, {
        limit: 18_000,
        commandCap: recipeAttemptCap,
      }),
      classify: async (content, sourceMetadata) =>
        classifyCatalogueDeterministically(content, sourceMetadata),
      now: () => new Date(),
      random: Math.random,
      getTelemetry: () => ({ gemini: { calls: 0, promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 } }),
    });
    const summary = await enrichmentEngine.run({
      runId,
      sourceKeys: work.sourceKeys,
      targetUrls: work.targetUrls,
      forceRefresh: true,
      refreshOutdatedParser: true,
      maxPerSource: perSource,
      writeCap: recipeAttemptCap,
      parserVersion: CATALOGUE_PARSER_VERSION,
      taxonomyVersion: CATALOGUE_TAXONOMY_VERSION,
    });
    await assertGenerationMode(initialGenerationMode);
    console.log(JSON.stringify({
      runId, mode: command.mode, candidates: work.candidates,
      writeCap: requestedWriteCap, ...sanitizedIngestionSummary(summary),
    }));
    return;
  }

  let refreshWork: Awaited<ReturnType<typeof loadEligibleRefreshWork>> | undefined;
  if (command.mode === 'refresh-backfill') {
    refreshWork = await loadEligibleRefreshWork(Math.min(command.maxPerSource ?? 250, 250));
    if (refreshWork.sourceKeys.length === 0) {
      const summary = {
        mode: 'refresh-backfill',
        status: 'complete',
        reasonCode: 'no-eligible-sources',
      };
      await recordPhase4Run(runId, summary);
      await assertGenerationMode(initialGenerationMode);
      console.log(JSON.stringify(summary));
      return;
    }
  }

  const engine = createCatalogueIngestionEngine({
    adapters,
    manifests: cloudStorageManifestStore(process.env.CATALOGUE_MANIFEST_BUCKET),
    recipes: firestoreCatalogueRecipeStore(),
    runs: firestoreCatalogueRunStore(),
    lease: createLeaseManager(operational.lease, {
      ownerId: runId,
      ttlMs: 5 * 60 * 1_000,
    }),
    budget: createBudgetManager(
      operational.budget,
      command.mode === 'refresh-backfill'
        ? { limit: 18_000, commandCap: phase4WriteCap }
        : { limit: 18_000 },
    ),
    classify: classifier,
    now: () => new Date(),
    random: Math.random,
    getTelemetry: () => ({ gemini: { ...gemini } }),
  });

  const summary = await engine.run({
    ...command,
    ...(refreshWork ? {
      sourceKeys: refreshWork.sourceKeys,
      targetUrls: refreshWork.targetUrls,
      forceRefresh: true,
      maxPerSource: Math.min(command.maxPerSource ?? 250, 250),
      writeCap: phase4WriteCap,
    } : {}),
    runId,
    parserVersion: CATALOGUE_PARSER_VERSION,
    taxonomyVersion: CATALOGUE_TAXONOMY_VERSION,
  });
  await assertGenerationMode(initialGenerationMode);
  console.log(JSON.stringify(command.mode === 'refresh-backfill'
    ? { runId, mode: command.mode, ...sanitizedIngestionSummary(summary) }
    : { runId, ...summary }));
}

main().catch((error: unknown) => {
  const code = error instanceof Error ? error.name : 'unknown';
  console.error(JSON.stringify({
    severity: 'ERROR',
    message: 'catalogue_ingestion_failed',
    code,
    reasonCode: sanitizedIngestionFailureReason(error),
    sourceKey: sanitizedIngestionFailureSource(error),
    stage: sanitizedIngestionFailureStage(error),
  }));
  process.exitCode = 1;
});
