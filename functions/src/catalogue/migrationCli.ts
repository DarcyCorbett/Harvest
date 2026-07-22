import { randomUUID } from 'node:crypto';

import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

import { assertSuccessfulMigrationResult, parseMigrationArguments } from './migrationCommand.js';
import { runRecipeMigration } from './migrationEngine.js';
import { firestoreRecipeMigrationScanner, firestoreRecipeMigrationStore } from './migrationFirestore.js';
import { firestoreReferenceMigrationStore, runReferenceMigration } from './migrationReferences.js';
import { createLeaseManager, firestoreCatalogueOpsDocuments } from './operations.js';

initializeApp();

async function assertLegacyMode(): Promise<void> {
  const config = await getFirestore().collection('appConfig').doc('catalogue').get();
  if (config.get('generationMode') !== 'legacy') throw new Error('Catalogue generation mode is not legacy');
}

async function recipeCommand(command: 'dry-run' | 'migrate-recipes' | 'reconcile', runId: string, maxWrites?: number) {
  const db = getFirestore();
  const operational = firestoreCatalogueOpsDocuments();
  return runRecipeMigration(command, {
    scanner: firestoreRecipeMigrationScanner(db),
    store: firestoreRecipeMigrationStore(db, runId),
    lease: createLeaseManager(operational.lease, { ownerId: runId, ttlMs: 5 * 60 * 1_000 }),
    now: () => new Date(),
  }, { runId, commandCap: maxWrites ?? 8_000, dailyLimit: 8_000 });
}

async function verificationSummary() {
  const db = getFirestore();
  const [config, checkpoint, recipes, mappings] = await Promise.all([
    db.collection('appConfig').doc('catalogue').get(),
    db.collection('catalogueMigrationCheckpoints').doc('phase3').get(),
    db.collection('recipes').count().get(),
    db.collection('catalogueRecipeMigrations').count().get(),
  ]);
  return {
    generationMode: config.get('generationMode'),
    checkpoint: checkpoint.exists ? {
      stage: checkpoint.get('stage'),
      epoch: checkpoint.get('epoch'),
      completedStages: checkpoint.get('completedStages'),
    } : null,
    recipeCount: recipes.data().count,
    mappingCount: mappings.data().count,
  };
}

async function main(): Promise<void> {
  const input = parseMigrationArguments(process.argv.slice(2));
  const runId = input.runId ?? randomUUID();
  await assertLegacyMode();
  let result: unknown;
  if (input.command === 'dry-run') {
    result = {
      recipes: await recipeCommand('dry-run', runId),
      references: await runReferenceMigration(
        firestoreReferenceMigrationStore(getFirestore(), { runId, now: () => new Date() }),
        { dryRun: true },
      ),
    };
  } else if (input.command === 'migrate-recipes' || input.command === 'reconcile') {
    result = await recipeCommand(input.command, runId, input.maxWrites);
  } else if (input.command === 'migrate-references') {
    result = await runReferenceMigration(
      firestoreReferenceMigrationStore(getFirestore(), { runId, now: () => new Date() }),
      { dryRun: false, maxReferences: input.maxReferences },
    );
  } else {
    result = await verificationSummary();
  }
  assertSuccessfulMigrationResult(input.command, result);
  await assertLegacyMode();
  console.log(JSON.stringify({ command: input.command, runId, result }));
}

main().catch((error: unknown) => {
  const code = error instanceof Error ? error.message : 'unknown';
  console.error(JSON.stringify({ severity: 'ERROR', message: 'catalogue_migration_failed', code }));
  process.exitCode = 1;
});
