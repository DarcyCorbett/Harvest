import { initializeApp } from 'firebase-admin/app';

import { runUnitBackfill } from './unitBackfill.js';
import { parseUnitBackfillArguments } from './unitBackfillCommand.js';
import { firestoreUnitBackfillStore } from './unitBackfillFirestore.js';

initializeApp();

async function main(): Promise<void> {
  const command = parseUnitBackfillArguments(process.argv.slice(2));
  const summary = await runUnitBackfill({
    runId: command.runId,
    store: firestoreUnitBackfillStore(),
    apply: command.apply,
    writeCap: command.writeCap,
    pageSize: command.pageSize,
    sourceKeys: command.sourceKeys,
    startAfter: command.startAfter,
  });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((error: unknown) => {
  const name = error instanceof Error ? error.name : 'UnknownError';
  process.stderr.write(`${JSON.stringify({ status: 'failed', reason: name })}\n`);
  process.exitCode = 1;
});

