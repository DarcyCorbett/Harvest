import { createRequire } from 'node:module';

const requireFunctionsDependency = createRequire(
  new URL('../functions/package.json', import.meta.url),
);
const { applicationDefault, initializeApp } = requireFunctionsDependency('firebase-admin/app');
const { getFirestore } = requireFunctionsDependency('firebase-admin/firestore');

const projectIndex = process.argv.indexOf('--project');
const projectId = projectIndex >= 0 ? process.argv[projectIndex + 1] : undefined;
if (!projectId || !/^[a-z][a-z0-9-]{4,29}$/.test(projectId)) {
  throw new Error('Invalid or missing --project');
}

initializeApp({ credential: applicationDefault(), projectId });
const db = getFirestore();
const [snapshot, ...budgetSnapshots] = await Promise.all([
  db.collection('catalogueTaxonomyRetagState').doc('taxonomy-v2').get(),
  db.collection('catalogueBudgets').doc('2026-08-24').get(),
  db.collection('catalogueBudgets').doc('2026-08-25').get(),
]);
if (!snapshot.exists) throw new Error('No taxonomy-v2 retag state exists');
const state = snapshot.data();
console.log(JSON.stringify({
  runId: state.runId,
  phase: state.phase,
  recipeCount: state.recipeCount,
  budgets: budgetSnapshots.map((budget) => budget.exists ? budget.data() : null),
  shards: (state.shards ?? []).map((shard) => ({
    index: shard.index,
    status: shard.status,
    recipeCount: shard.recipeCount,
    retryCount: shard.retryCount ?? 0,
    valid: shard.valid ?? 0,
    invalid: shard.invalid ?? 0,
    failed: shard.failed ?? 0,
    applyCursor: shard.applyCursor ?? 0,
    applied: shard.applied ?? 0,
    stale: shard.stale ?? 0,
    writeFailed: shard.writeFailed ?? 0,
    jobName: shard.jobName,
  })),
}));
