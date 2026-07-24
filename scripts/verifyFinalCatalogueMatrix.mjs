import { performance } from 'node:perf_hooks';
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
const expectedMode = argument('--expected-mode') ?? 'legacy';
if (!projectId || !/^[a-z][a-z0-9-]{4,29}$/.test(projectId)) {
  throw new Error('Invalid or missing --project');
}
if (expectedMode !== 'legacy' && expectedMode !== 'catalogue') {
  throw new Error('Invalid --expected-mode');
}

initializeApp({ credential: applicationDefault(), projectId });
const db = getFirestore();
const [
  { normalizeIngredientTokens, validateReadyRecipe },
  {
    firestoreCatalogueSelectionStore,
    selectCatalogueRecipes,
  },
  { SOURCE_CONFIGS },
] = await Promise.all([
  import('../functions/lib/catalogue/domain.js'),
  import('../functions/lib/catalogue/selection.js'),
  import('../functions/lib/catalogue/sourceAdapters.js'),
]);

const config = await db.collection('appConfig').doc('catalogue').get();
if (config.get('generationMode') !== expectedMode) {
  throw new Error(`Expected generation mode ${expectedMode}`);
}

const firestoreStore = firestoreCatalogueSelectionStore(db);
const equalWeights = Object.fromEntries(SOURCE_CONFIGS.map((source) => [source.sourceKey, 1]));
const store = {
  async getSourceWeights() {
    return equalWeights;
  },
  queryCandidates: firestoreStore.queryCandidates,
};

const base = {
  date: '2026-08-03',
  mealType: 'dinner',
  cuisines: [],
  modifiers: [],
  ingredients: { must: [], prefer: [], exclude: [] },
};
const selectedCases = [
  ...['breakfast', 'lunch', 'dinner', 'side'].map((mealType) => ({
    name: `broad-${mealType}`,
    slot: { ...base, mealType },
  })),
  ...['asian', 'mexican', 'mediterranean', 'italian', 'indian'].map((cuisine) => ({
    name: `cuisine-${cuisine}`,
    slot: { ...base, cuisines: [cuisine] },
  })),
  ...['vegetarian', 'healthy', 'kid-friendly', 'salad'].map((modifier) => ({
    name: `modifier-${modifier}`,
    slot: { ...base, modifiers: [modifier] },
  })),
  { name: 'quick-30', slot: { ...base, maxTotalMinutes: 30 } },
  { name: 'moderate-45', slot: { ...base, maxTotalMinutes: 45 } },
  {
    name: 'preferred-ingredient',
    slot: { ...base, ingredients: { must: [], prefer: ['lemon'], exclude: [] } },
  },
  {
    name: 'must-ingredient',
    slot: { ...base, ingredients: { must: ['chicken'], prefer: [], exclude: [] } },
  },
  {
    name: 'excluded-ingredient',
    slot: { ...base, ingredients: { must: [], prefer: [], exclude: ['chicken'] } },
  },
];

function containsAll(values, required) {
  const set = new Set(values);
  return required.every((value) => set.has(value));
}

function assertHardConstraints(recipe, slot) {
  if (recipe.schemaVersion !== 2 || recipe.status !== 'ready') {
    throw new Error('Matrix selected a non-ready recipe');
  }
  if (validateReadyRecipe(recipe).length > 0) {
    throw new Error('Matrix selected an invalid ready recipe');
  }
  if (!recipe.effective.mealTypes.includes(slot.mealType)
    || !containsAll(recipe.effective.cuisines, slot.cuisines)
    || !containsAll(recipe.effective.modifiers, slot.modifiers)) {
    throw new Error('Matrix selected a taxonomy mismatch');
  }
  if (slot.maxTotalMinutes !== undefined
    && (!(recipe.effective.totalMinutes > 0) || recipe.effective.totalMinutes > slot.maxTotalMinutes)) {
    throw new Error('Matrix selected a time mismatch');
  }
  const tokens = new Set(recipe.search.ingredientTokens);
  const must = normalizeIngredientTokens(slot.ingredients.must);
  const excluded = normalizeIngredientTokens(slot.ingredients.exclude);
  if (!must.every((token) => tokens.has(token))
    || excluded.some((token) => tokens.has(token))) {
    throw new Error('Matrix selected an ingredient mismatch');
  }
}

const latencies = [];
let selectedCount = 0;
let priorSelectedId;
for (const testCase of selectedCases) {
  const startedAt = performance.now();
  const response = await selectCatalogueRecipes({
    householdId: 'operator-matrix',
    slots: [testCase.slot],
    currentPlanRecipeIds: [],
    recentRecipeIds: [],
  }, store);
  latencies.push(performance.now() - startedAt);
  const outcome = response.slots[0];
  if (outcome?.status !== 'selected') {
    throw new Error(`Expected a selection for ${testCase.name}`);
  }
  const snapshot = await db.collection('recipes').doc(outcome.recipeId).get();
  if (!snapshot.exists) throw new Error('Selected matrix recipe is missing');
  assertHardConstraints({ ...snapshot.data(), id: snapshot.id }, testCase.slot);
  priorSelectedId ??= outcome.recipeId;
  selectedCount += 1;
}

const duplicateStartedAt = performance.now();
const duplicateResponse = await selectCatalogueRecipes({
  householdId: 'operator-matrix',
  slots: [
    { ...base, date: '2026-08-04' },
    { ...base, date: '2026-08-05' },
  ],
  currentPlanRecipeIds: [priorSelectedId],
  recentRecipeIds: [priorSelectedId],
}, store);
latencies.push(performance.now() - duplicateStartedAt);
const duplicateIds = duplicateResponse.slots.flatMap((slot) =>
  slot.status === 'selected' ? [slot.recipeId] : []);
if (duplicateIds.length !== 2
  || new Set(duplicateIds).size !== 2
  || duplicateIds.includes(priorSelectedId)) {
  throw new Error('Duplicate/recent-use matrix gate failed');
}
selectedCount += duplicateIds.length;

const noMatchStartedAt = performance.now();
const noMatchResponse = await selectCatalogueRecipes({
  householdId: 'operator-matrix',
  slots: [{
    ...base,
    ingredients: {
      must: ['ingredient-that-does-not-exist-zzzz'],
      prefer: [],
      exclude: [],
    },
  }],
  currentPlanRecipeIds: [],
  recentRecipeIds: [],
}, store);
latencies.push(performance.now() - noMatchStartedAt);
const noMatch = noMatchResponse.slots[0];
if (noMatch?.status !== 'no-match'
  || !noMatch.relaxations.some((relaxation) =>
    relaxation.filter === 'mustIngredient'
    && relaxation.value === 'ingredient-that-does-not-exist-zzzz'
    && relaxation.matchCount > 0)) {
  throw new Error('Intentional no-match diagnostic gate failed');
}

const sortedLatencies = [...latencies].sort((left, right) => left - right);
const p95Ms = sortedLatencies[Math.ceil(sortedLatencies.length * 0.95) - 1] ?? 0;
if (p95Ms > 2_000) throw new Error(`Selector p95 exceeded gate: ${p95Ms.toFixed(1)}ms`);

console.log(JSON.stringify({
  mode: expectedMode,
  cases: selectedCases.length + 2,
  selected: selectedCount,
  intentionalNoMatch: 1,
  duplicateGate: 'passed',
  hardConstraintGate: 'passed',
  p95Ms: Number(p95Ms.toFixed(1)),
  firestoreWrites: 0,
  externalRecipeRequests: 0,
}));
