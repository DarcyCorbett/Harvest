import { initializeApp } from 'firebase-admin/app';

import { runLegacyContentRecovery } from './contentEnrichment.js';
import { parseContentEnrichmentArguments } from './contentEnrichmentCommand.js';
import {
  firestoreContentEnrichmentStore,
  repairContentEnrichmentRunMetadata,
  runContentCoverageAudit,
  verifyContentEnrichmentRun,
} from './contentEnrichmentFirestore.js';

initializeApp();

async function main(): Promise<void> {
  const command = parseContentEnrichmentArguments(process.argv.slice(2));
  const summary = command.mode === 'audit'
    ? await runContentCoverageAudit(undefined, command.sourceKeys, command.maxPerSource)
    : command.mode === 'verify-run'
      ? await verifyContentEnrichmentRun(command.runId)
    : command.mode === 'repair-run'
      ? await repairContentEnrichmentRunMetadata(command.runId)
    : await runLegacyContentRecovery({
      runId: command.runId,
      store: firestoreContentEnrichmentStore(undefined, command.sourceKeys),
      dryRun: command.dryRun,
      sourceKeys: command.sourceKeys,
      maxPerSource: command.maxPerSource,
      writeCap: command.writeCap,
      pageSize: command.pageSize,
      startAfter: command.startAfter,
    });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((error: unknown) => {
  const reason = error instanceof Error ? error.name : 'UnknownError';
  process.stderr.write(`${JSON.stringify({ status: 'failed', reason })}\n`);
  process.exitCode = 1;
});
