import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const requireFunctionsDependency = createRequire(new URL('../functions/package.json', import.meta.url));
const { applicationDefault, initializeApp } = requireFunctionsDependency('firebase-admin/app');
const { FieldPath, getFirestore } = requireFunctionsDependency('firebase-admin/firestore');
const { getStorage } = requireFunctionsDependency('firebase-admin/storage');

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const projectId = argument('--project');
if (!projectId || !/^[a-z][a-z0-9-]{4,29}$/.test(projectId)) {
  throw new Error('Invalid or missing --project');
}

initializeApp({ credential: applicationDefault(), projectId });
const db = getFirestore();
const [{ applyTaxonomyV2Evidence }, { validateReadyRecipe }] = await Promise.all([
  import('../functions/lib/catalogue/taxonomyRetagBatch.js'),
  import('../functions/lib/catalogue/domain.js'),
]);
const snapshot = await db.collection('catalogueTaxonomyRetagState').doc('taxonomy-v2').get();
if (!snapshot.exists) throw new Error('No taxonomy-v2 retag state exists');
const state = snapshot.data();
if (state.phase !== 'staged') throw new Error(`Expected staged state; observed ${state.phase}`);

const evidenceById = new Map();
const bucket = getStorage().bucket(process.env.CATALOGUE_MANIFEST_BUCKET
  ?? `${projectId}-catalogue-manifests`);
for (const shard of state.shards) {
  if (shard.status !== 'staged' || !shard.stagedPath || shard.invalid || shard.failed) {
    throw new Error(`Shard ${shard.index} is not fully valid and staged`);
  }
  const [buffer] = await bucket.file(shard.stagedPath).download();
  for (const line of buffer.toString('utf8').split(/\r?\n/).filter(Boolean)) {
    const entry = JSON.parse(line);
    if (evidenceById.has(entry.key)) throw new Error(`Duplicate staged recipe ${entry.key}`);
    evidenceById.set(entry.key, entry.evidence);
  }
}
if (evidenceById.size !== state.recipeCount) {
  throw new Error(`Staged evidence count mismatch: ${evidenceById.size}/${state.recipeCount}`);
}

const mealTypes = ['breakfast', 'lunch', 'dinner', 'side', 'snack', 'dessert', 'component'];
const modifiers = ['kid-friendly', 'healthy'];
const emptyCounts = () => Object.fromEntries([...mealTypes, ...modifiers].map((key) => [key, 0]));
const global = { before: emptyCounts(), after: emptyCounts(), added: emptyCounts(), removed: emptyCounts() };
const bySource = {};
const overlaps = { before: {}, after: {} };
let changedRecipes = 0;
let unchangedRecipes = 0;
let invalidProjected = 0;
let cursor;
while (true) {
  let query = db.collection('recipes').where('schemaVersion', '==', 2)
    .orderBy(FieldPath.documentId()).limit(500);
  if (cursor) query = query.startAfter(cursor);
  const page = await query.get();
  for (const document of page.docs) {
    cursor = document.id;
    const recipe = { ...document.data(), id: document.id };
    const evidence = evidenceById.get(document.id);
    if (!evidence) continue;
    const projected = applyTaxonomyV2Evidence(recipe, evidence);
    if (validateReadyRecipe(projected).length > 0) invalidProjected += 1;
    const source = recipe.source.key;
    bySource[source] ??= {
      recipes: 0, before: emptyCounts(), after: emptyCounts(),
      added: emptyCounts(), removed: emptyCounts(),
    };
    bySource[source].recipes += 1;
    const beforeLabels = new Set([
      ...recipe.effective.mealTypes,
      ...recipe.effective.modifiers.filter((value) => modifiers.includes(value)),
    ]);
    const afterLabels = new Set([
      ...projected.effective.mealTypes,
      ...projected.effective.modifiers.filter((value) => modifiers.includes(value)),
    ]);
    for (const label of [...mealTypes, ...modifiers]) {
      if (beforeLabels.has(label)) { global.before[label] += 1; bySource[source].before[label] += 1; }
      if (afterLabels.has(label)) { global.after[label] += 1; bySource[source].after[label] += 1; }
      if (!beforeLabels.has(label) && afterLabels.has(label)) {
        global.added[label] += 1; bySource[source].added[label] += 1;
      }
      if (beforeLabels.has(label) && !afterLabels.has(label)) {
        global.removed[label] += 1; bySource[source].removed[label] += 1;
      }
    }
    const beforeOverlap = [...recipe.effective.mealTypes].sort().join('+');
    const afterOverlap = [...projected.effective.mealTypes].sort().join('+');
    overlaps.before[beforeOverlap] = (overlaps.before[beforeOverlap] ?? 0) + 1;
    overlaps.after[afterOverlap] = (overlaps.after[afterOverlap] ?? 0) + 1;
    const changed = beforeOverlap !== afterOverlap
      || beforeLabels.has('kid-friendly') !== afterLabels.has('kid-friendly')
      || beforeLabels.has('healthy') !== afterLabels.has('healthy');
    if (changed) changedRecipes += 1;
    else unchangedRecipes += 1;
  }
  if (page.size < 500) break;
}

const actualInputTokens = state.shards.reduce((sum, shard) => sum + (shard.actualInputTokens ?? 0), 0);
const actualOutputTokens = state.shards.reduce((sum, shard) => sum + (shard.actualOutputTokens ?? 0), 0);
const report = {
  runId: state.runId,
  promptHash: state.promptHash,
  model: state.model,
  recipes: state.recipeCount,
  stagedEvidence: evidenceById.size,
  invalidProjected,
  changedRecipes,
  unchangedRecipes,
  global,
  bySource: Object.fromEntries(Object.entries(bySource).sort(([a], [b]) => a.localeCompare(b))),
  overlaps,
  usage: {
    actualInputTokens,
    actualOutputTokens,
    actualCostUsd: Number((actualInputTokens / 1_000_000 * 0.125
      + actualOutputTokens / 1_000_000 * 0.75).toFixed(4)),
  },
  firestoreWrites: 0,
  externalRecipeRequests: 0,
};
const directory = resolve('artifacts/catalogue-taxonomy-v2-production');
await mkdir(directory, { recursive: true });
const outputPath = resolve(directory, 'transition-report.json');
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({
  outputPath, recipes: report.recipes, invalidProjected,
  changedRecipes, unchangedRecipes, usage: report.usage, global: report.global,
}));
