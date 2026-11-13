// Local-only integration. Start auth/firestore/functions emulators and seedConnectedEmulator.mjs first.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { initializeApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, signInWithEmailAndPassword } from 'firebase/auth';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'firebase/functions';
import { initializeApp as adminApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
const projectId = 'demo-meal-wizard-rules';
adminApp({ projectId });
const db = getFirestore(), householdId = `qa-ongoing-${randomUUID()}`;
const root = db.doc(`households/${householdId}`);
await root.set({ members: ['qa-one','qa-two'] });
const [one, two] = await Promise.all(['one','two'].map(async name => {
  const app = initializeApp({ apiKey: 'demo-key', projectId }, name);
  const auth = getAuth(app); connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  await signInWithEmailAndPassword(auth, `${name}@mealwizard.test`, 'Local-testing-2026!');
  const functions = getFunctions(app, 'europe-west1'); connectFunctionsEmulator(functions, '127.0.0.1', 5001);
  return async (command, requestId = randomUUID(), clientVersion = 4) => (await httpsCallable(functions, 'connectedCommand', { timeout: 30000 })({ householdId, clientVersion, requestId, command })).data;
}));
const state = async () => (await root.collection('connected').doc('state').get()).data();
const list = async () => (await root.collection('shoppingPeriods').doc((await state()).periodId).get()).data();
async function ready(minRevision = 1) {
  for (let i = 0; i < 150; i++) {
    const s = await state(), l = await list();
    if (s.status === 'error') throw new Error(s.error);
    if (s.status === 'ready' && s.revision >= minRevision && l.completedWorkflowRevision >= s.revision) return l;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Shopping did not finish');
}
const meal = (recipeId, date) => ({ id: randomUUID(), recipeId, date, mealType: 'dinner', servings: 2, revision: 0, kind: 'recipe', status: 'planned' });
const command = async (m, mode = 'keep') => { const l = await list(); return { operation: 'mutate', changes: [{ meal: m, expectedRevision: 0 }], shopping: { mode, mealIds: [m.id], expectedRevision: l.revision, generation: l.shopping.generation } }; };
const itemAction = async (client, item, action = 'check', id) => { const l = await list(); return client({ operation: 'shopping', periodId: l.id, generation: l.shopping.generation, itemId: item.id, expectedRevision: item.revision, action }, id); };
await one({ operation: 'initialise', start: '2026-09-07', end: '2026-09-13' });
const first = meal('qa-chicken', '2030-01-01'), second = meal('qa-pasta', '2020-01-01');
const addFirst = await command(first), addId = randomUUID();
await one(addFirst, addId); await one(addFirst, addId); let l = await ready(2);
assert.equal(l.items.find(i => i.name === 'chicken').quantity, 400);
await itemAction(two, l.items.find(i => i.name === 'chicken'));
l = await list(); await itemAction(one, l.items.find(i => i.name === 'lemon'));
l = await list(); assert.ok(l.items.find(i => i.name === 'lemon').purchasedOrder > l.items.find(i => i.name === 'chicken').purchasedOrder);
await one({ operation: 'mutate', changes: [{ meal: { ...first, servings: 8 }, expectedRevision: 1 }] });
l = await ready(3); assert.equal(l.items.find(i => i.name === 'chicken').quantity, 400);
await one(await command(second)); l = await ready(4);
assert.equal(l.items.find(i => i.name === 'lemon' && !i.checked).quantity, 1);
assert.equal(l.items.find(i => i.name === 'lemon' && i.checked).quantity, 1);
await one({ operation: 'manual', name: 'Soap', quantity: 1, unit: '', category: 'Other', generation: l.shopping.generation });
const third = meal('qa-rice', '2028-07-01'), stale = await command(third, 'replace');
l = await list(); const oldItem = l.items.find(i => i.name === 'pasta');
await itemAction(two, oldItem);
await assert.rejects(one(stale), e => e.code === 'functions/aborted');
const before = await list(), replace = await command(third, 'replace'), replaceId = randomUUID();
await one(replace, replaceId); l = await ready(5); await one(replace, replaceId);
assert.equal(l.shopping.generation, replaceId); assert.ok(l.items.every(i => !i.checked && !i.manual));
await assert.rejects(two({ operation: 'shopping', periodId: before.id, generation: before.shopping.generation, itemId: oldItem.id, expectedRevision: oldItem.revision, action: 'uncheck' }), e => e.code === 'functions/aborted');
await assert.rejects(one({ operation: 'period', start: '2026-01-01', end: '2026-01-07', newPeriod: true, expectedRevision: l.revision }, randomUUID(), 3), e => e.code === 'functions/failed-precondition');
await one({ operation: 'mutate', changes: [{ meal: { ...first, servings: 10 }, expectedRevision: 2 }] });
l = await ready(6); assert.ok(!l.items.some(i => i.name === 'chicken'));
console.log('PASS: two-user ongoing list, dates ignored, retries, frozen purchases, new requirements, purchase order, reviewed replacement conflicts, stale offline checks, excluded old meals and old-client gate.');
process.exit(0);
