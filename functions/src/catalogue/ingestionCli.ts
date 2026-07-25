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
  recordPhase4Run,
  runSourceRefreshCanaries,
  sanitizedClassificationSummary,
  verifyPhase4Backfill,
} from './backfillFirestore.js';
import {
  classifyCatalogueDeterministically,
  createCatalogueClassifier,
} from './classifier.js';
import {
  cloudStorageManifestStore,
  createCatalogueIngestionEngine,
  firestoreCatalogueRecipeStore,
  firestoreCatalogueRunStore,
} from './ingestion.js';
import { parseIngestionArguments } from './ingestionCommand.js';
import {
  createBudgetManager,
  createLeaseManager,
  firestoreCatalogueOpsDocuments,
} from './operations.js';
import {
  WORDPRESS_SOURCE_KEYS,
  createTrustedSourceAdapters,
  inventorySourceDiscovery,
} from './sourceAdapters.js';

initializeApp();

type GenerationMode = 'legacy' | 'catalogue';

async function readGenerationMode(): Promise<GenerationMode> {
  const config = await getFirestore().collection('appConfig').doc('catalogue').get();
  const mode = config.get('generationMode');
  if (mode !== 'legacy' && mode !== 'catalogue') {
    throw new Error('Catalogue generation mode is invalid');
  }
  return mode;
}

async function assertGenerationMode(expected: GenerationMode): Promise<void> {
  if (await readGenerationMode() !== expected) {
    throw new Error('Catalogue generation mode changed during ingestion');
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
    requestJson(prompt) {
      if (gemini.calls >= geminiCallCap) throw new GeminiCallCapError();
      gemini.calls += 1;
      return requestGeminiJson({
        apiKey: secret,
        model: 'gemini-3.1-flash-lite',
        prompt,
        maxOutputTokens: 512,
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
      manifests: cloudStorageManifestStore(process.env.CATALOGUE_MANIFEST_BUCKET),
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
      parserVersion: 1,
      taxonomyVersion: 1,
    });
    await assertGenerationMode(initialGenerationMode);
    console.log(JSON.stringify({
      runId,
      mode: 'crawl-backfill',
      ...sanitizedIngestionSummary(summary),
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
    parserVersion: 1,
    taxonomyVersion: 1,
  });
  await assertGenerationMode(initialGenerationMode);
  console.log(JSON.stringify(command.mode === 'refresh-backfill'
    ? { runId, mode: command.mode, ...sanitizedIngestionSummary(summary) }
    : { runId, ...summary }));
}

main().catch((error: unknown) => {
  const code = error instanceof Error ? error.name : 'unknown';
  console.error(JSON.stringify({ severity: 'ERROR', message: 'catalogue_ingestion_failed', code }));
  process.exitCode = 1;
});
