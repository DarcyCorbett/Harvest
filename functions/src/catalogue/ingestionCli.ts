import { randomUUID } from 'node:crypto';

import { initializeApp } from 'firebase-admin/app';

import { requestGeminiJson } from '../ai/geminiProvider.js';
import { createCatalogueClassifier } from './classifier.js';
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
import { createTrustedSourceAdapters } from './sourceAdapters.js';

initializeApp();

async function main(): Promise<void> {
  const command = parseIngestionArguments(process.argv.slice(2));
  const runId = command.runId ?? randomUUID();
  const secret = process.env.GEMINI_API_KEY?.trim() ?? '';
  const operational = firestoreCatalogueOpsDocuments();
  const classifier = createCatalogueClassifier({
    requestJson(prompt) {
      return requestGeminiJson({
        apiKey: secret,
        model: 'gemini-3.1-flash-lite',
        prompt,
        maxOutputTokens: 512,
      });
    },
  });
  const engine = createCatalogueIngestionEngine({
    adapters: createTrustedSourceAdapters(),
    manifests: cloudStorageManifestStore(process.env.CATALOGUE_MANIFEST_BUCKET),
    recipes: firestoreCatalogueRecipeStore(),
    runs: firestoreCatalogueRunStore(),
    lease: createLeaseManager(operational.lease, {
      ownerId: runId,
      ttlMs: 5 * 60 * 1_000,
    }),
    budget: createBudgetManager(operational.budget, { limit: 18_000 }),
    classify: classifier,
    now: () => new Date(),
    random: Math.random,
  });

  const summary = await engine.run({
    ...command,
    runId,
    parserVersion: 1,
    taxonomyVersion: 1,
  });
  console.log(JSON.stringify({ runId, ...summary }));
}

main().catch((error: unknown) => {
  const code = error instanceof Error ? error.name : 'unknown';
  console.error(JSON.stringify({ severity: 'ERROR', message: 'catalogue_ingestion_failed', code }));
  process.exitCode = 1;
});
