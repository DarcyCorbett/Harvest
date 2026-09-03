import { createRequire } from 'node:module';

const requireFunctionsDependency = createRequire(
  new URL('../functions/package.json', import.meta.url),
);
const { applicationDefault, initializeApp } = requireFunctionsDependency('firebase-admin/app');
const { getFirestore } = requireFunctionsDependency('firebase-admin/firestore');

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const projectId = argument('--project');
const shardIndex = Number(argument('--shard'));
const confirmedEmpty = process.argv.includes('--confirm-no-provider-artifacts');
const providerFile = argument('--provider-file');
const providerJob = argument('--provider-job');
if (!projectId || !/^[a-z][a-z0-9-]{4,29}$/.test(projectId)) {
  throw new Error('Invalid or missing --project');
}
if (!Number.isInteger(shardIndex) || shardIndex < 0
  || (!confirmedEmpty && !(providerFile && providerJob))) {
  throw new Error('A valid shard and either empty-artifact confirmation or provider IDs are required');
}

initializeApp({ credential: applicationDefault(), projectId });
const db = getFirestore();
const reference = db.collection('catalogueTaxonomyRetagState').doc('taxonomy-v2');
await db.runTransaction(async (transaction) => {
  const snapshot = await transaction.get(reference);
  if (!snapshot.exists) throw new Error('No taxonomy-v2 retag state exists');
  const state = snapshot.data();
  const shard = state.shards?.find((value) => value.index === shardIndex);
  if (state.phase !== 'submitting' || shard?.status !== 'submitting') {
    throw new Error('Checkpoint is not an indeterminate submission');
  }
  if (shard.fileName || shard.jobName) {
    throw new Error('Checkpoint contains provider identifiers and cannot be reset');
  }
  if (providerFile && providerJob) {
    if (!/^files\/[a-zA-Z0-9_-]+$/.test(providerFile)
      || !/^batches\/[a-zA-Z0-9_-]+$/.test(providerJob)) {
      throw new Error('Invalid provider identifiers');
    }
    shard.fileName = providerFile;
    shard.jobName = providerJob;
    shard.status = 'submitted';
    state.phase = 'submitted';
  } else {
    shard.status = 'prepared';
    state.phase = 'prepared';
  }
  state.updatedAt = new Date().toISOString();
  transaction.set(reference, state);
});
console.log(JSON.stringify(providerFile && providerJob
  ? { shard: shardIndex, status: 'submitted', providerFile, providerJob }
  : { shard: shardIndex, status: 'prepared', providerArtifacts: 0 }));
