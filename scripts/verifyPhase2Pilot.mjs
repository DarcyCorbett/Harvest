import { performance } from 'node:perf_hooks';

import { applicationDefault, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

import {
  buildSearchFields,
  validateReadyRecipe,
} from '../functions/lib/catalogue/domain.js';
import {
  firestoreCatalogueSelectionStore,
  selectCatalogueRecipes,
} from '../functions/lib/catalogue/selection.js';
import {
  sanitizeCataloguePilotRun,
  validateCataloguePilotEvidence,
} from './cataloguePilotValidation.mjs';

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requiredArgument(name, pattern) {
  const value = argument(name);
  if (!value || !pattern.test(value)) throw new Error(`Invalid or missing ${name}`);
  return value;
}

const projectId = requiredArgument('--project', /^[a-z][a-z0-9-]{4,29}$/);
const discoveryRunId = requiredArgument('--discovery-run', /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const firstRunId = requiredArgument('--first-run', /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const secondRunId = requiredArgument('--second-run', /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const schedulerState = requiredArgument('--scheduler-state', /^[A-Z]+$/);
const writeCap = Number(argument('--write-cap') ?? 40);
if (!Number.isInteger(writeCap) || writeCap < 1 || writeCap > 40) {
  throw new Error('Invalid --write-cap');
}

initializeApp({ credential: applicationDefault(), projectId });
const db = getFirestore();
const [discoverySnapshot, firstSnapshot, secondSnapshot, configSnapshot] = await Promise.all([
  db.collection('catalogueRuns').doc(discoveryRunId).get(),
  db.collection('catalogueRuns').doc(firstRunId).get(),
  db.collection('catalogueRuns').doc(secondRunId).get(),
  db.collection('appConfig').doc('catalogue').get(),
]);
if (!discoverySnapshot.exists || !firstSnapshot.exists || !secondSnapshot.exists) {
  throw new Error('Phase 2 pilot run evidence is missing');
}
if (!configSnapshot.exists) throw new Error('Catalogue configuration evidence is missing');

const discovery = sanitizeCataloguePilotRun(discoverySnapshot.data());
const first = sanitizeCataloguePilotRun(firstSnapshot.data());
const second = sanitizeCataloguePilotRun(secondSnapshot.data());
const generationMode = configSnapshot.get('generationMode');

const sampleRecipeIds = [...new Set(
  Object.values(first.bySource ?? {}).flatMap((source) =>
    Array.isArray(source?.sampleRecipeIds) ? source.sampleRecipeIds : []),
)].slice(0, 40);
const recipeSnapshots = sampleRecipeIds.length === 0
  ? []
  : await db.getAll(...sampleRecipeIds.map((id) => db.collection('recipes').doc(id)));

const audit = {
  sampledDocuments: 0,
  readyRecipeTin: 0,
  readySeriousEats: 0,
  reviewDocuments: 0,
  disabledSeriousEats: 0,
  seriousEatsReasonCodes: [],
  invalidReady: 0,
  searchMismatches: 0,
  missingTime: 0,
  missingTaxonomy: 0,
  estimatedDocumentBytes: 0,
};

for (const snapshot of recipeSnapshots) {
  if (!snapshot.exists) continue;
  const recipe = snapshot.data();
  audit.sampledDocuments += 1;
  audit.estimatedDocumentBytes += Buffer.byteLength(JSON.stringify(recipe), 'utf8');
  const sourceKey = recipe.source?.key;

  if (recipe.status === 'ready') {
    if (sourceKey === 'recipetineats') audit.readyRecipeTin += 1;
    if (sourceKey === 'seriouseats') audit.readySeriousEats += 1;
    const errors = validateReadyRecipe(recipe);
    if (errors.length > 0) audit.invalidReady += 1;
    if (errors.includes('search')) audit.searchMismatches += 1;
    if (!(recipe.effective?.totalMinutes > 0)) audit.missingTime += 1;
    if (!recipe.classification?.complete
      || !Array.isArray(recipe.effective?.mealTypes)
      || recipe.effective.mealTypes.length === 0
      || !Array.isArray(recipe.effective?.cuisines)
      || recipe.effective.cuisines.length === 0) {
      audit.missingTaxonomy += 1;
    }

    const expectedSearch = buildSearchFields(
      recipe.effective,
      recipe.content.ingredients.map((ingredient) => ingredient.name),
      recipe.search.randomKey,
    );
    if (JSON.stringify(expectedSearch) !== JSON.stringify(recipe.search)
      && !errors.includes('search')) {
      audit.searchMismatches += 1;
    }
  } else if (recipe.status === 'review') {
    audit.reviewDocuments += 1;
  } else if (sourceKey === 'seriouseats' && recipe.status === 'disabled') {
    audit.disabledSeriousEats += 1;
    if (typeof recipe.reasonCode === 'string') audit.seriousEatsReasonCodes.push(recipe.reasonCode);
  }
}
audit.seriousEatsReasonCodes = [...new Set(audit.seriousEatsReasonCodes)].sort();

const firestoreStore = firestoreCatalogueSelectionStore();
let selectionQueryCalls = 0;
let candidateReads = 0;
const measuredStore = {
  getSourceWeights: async () => ({ recipetineats: 1, seriouseats: 1 }),
  async queryCandidates(sourceKey, slot, pageToken) {
    selectionQueryCalls += 1;
    const page = await firestoreStore.queryCandidates(sourceKey, slot, pageToken);
    candidateReads += page.candidates.length;
    return page;
  },
};
const selectionRequest = {
  householdId: 'phase2-pilot',
  slots: [{
    date: '2026-07-20',
    mealType: 'dinner',
    cuisines: [],
    modifiers: [],
    ingredients: { must: [], prefer: [], exclude: [] },
  }],
  currentPlanRecipeIds: [],
  recentRecipeIds: [],
};
const latencies = [];
let selected = 0;
let noMatch = 0;
for (let iteration = 0; iteration < 10; iteration += 1) {
  const startedAt = performance.now();
  const result = await selectCatalogueRecipes(selectionRequest, measuredStore, () => 0.5);
  latencies.push(performance.now() - startedAt);
  if (result.slots[0].status === 'selected') selected += 1;
  else noMatch += 1;
}
latencies.sort((left, right) => left - right);
const p95Index = Math.ceil(latencies.length * 0.95) - 1;
const selection = {
  iterations: 10,
  p95Ms: Number(latencies[p95Index].toFixed(2)),
  maxMs: Number(latencies.at(-1).toFixed(2)),
  candidateReads,
  selected,
  noMatch,
};

const evidence = {
  schedulerState,
  generationMode,
  writeCap,
  discovery,
  first,
  second,
  audit,
  selection,
  firestoreReads: {
    runDocuments: 3,
    configDocuments: 1,
    sampleDocuments: recipeSnapshots.length,
    selectionQueryCalls,
    selectionCandidateDocuments: candidateReads,
  },
};

validateCataloguePilotEvidence(evidence);
console.log(JSON.stringify(evidence, null, 2));
