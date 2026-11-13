import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { applicationDefault, cert, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { repairShoppingMeasurements } from '../functions/src/connected/shoppingRepair';
import type { Period } from '../functions/src/connected/model';
import { shoppingDisplayGroups } from '../services/shoppingPresentation';

const args = process.argv.slice(2);
const option = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const apply = args.includes('--apply');
const householdId = option('--household');
const output = option('--out') ?? 'artifacts/shopping-measurements/audit.json';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function main() {
  if (!householdId || householdId.includes('/')) throw new Error('Specify --household <id>. Default mode is read-only.');
  if (apply && !option('--reviewed-hash')) throw new Error('Apply requires --reviewed-hash from the dry-run report.');
  const credentials = process.env.GOOGLE_APPLICATION_CREDENTIALS ?? 'service-account.json';
  initializeApp({ credential: fs.existsSync(credentials) ? cert(JSON.parse(fs.readFileSync(credentials, 'utf8'))) : applicationDefault() });
  const db = getFirestore();
  try {
    const household = db.collection('households').doc(householdId);
    const stateRef = household.collection('connected').doc('state');
    const state = (await stateRef.get()).data();
    if (!state?.periodId || state.status !== 'ready') throw new Error('Wait for the household workflow to be ready.');
    const ref = household.collection('shoppingPeriods').doc(state.periodId);
    const before = (await ref.get()).data() as Period;
    if (!before?.shopping) throw new Error('The active list is not an ongoing list.');
    const recipeIds = [...new Set([...before.items, ...before.shopping.sources, ...before.shopping.removed].flatMap(row => row.contributions.map(c => c.recipeId)))];
    const documents = recipeIds.length ? await db.getAll(...recipeIds.map(id => db.collection('recipes').doc(id))) : [];
    const recipes = Object.fromEntries(documents.filter(d => d.exists).map(d => [d.id, d.data()!]));
    const result = repairShoppingMeasurements(before, recipes);
    const snapshotHash = hash({ state, before, recipes });
    const view = (period: Period) => [false, true].flatMap(checked => shoppingDisplayGroups(period.items.filter(i => i.checked === checked), checked).map(group => ({
      name: group.name, purchased: checked, amount: group.label, entries: group.items.length,
    })));
    const report = { householdId, periodId: before.id, snapshotHash, revision: before.revision, changed: result.changed,
      issues: result.issues, before: before.items.map(item => ({ name: item.name, purchased: item.checked, amount: `${item.quantity} ${item.unit}`.trim(), entries: 1 })), after: view(result.period), applied: false };
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(report, null, 2));
    const fixturePath = option('--fixture');
    if (fixturePath) {
      const recipeMap = Object.fromEntries(recipeIds.map((id, i) => [id, `recipe-${i + 1}`]));
      const mealIds = [...new Set([...before.items, ...before.shopping.sources, ...before.shopping.removed].flatMap(row => row.contributions.map(c => c.mealId)))];
      const mealMap = Object.fromEntries(mealIds.map((id, i) => [id, `meal-${i + 1}`]));
      const fixture: Period = structuredClone(before);
      fixture.id = 'list'; fixture.shopping!.generation = 'generation'; fixture.shopping!.mealIds = mealIds.map(id => mealMap[id]);
      delete fixture.shoppingGrouping;
      for (const rows of [fixture.items, fixture.shopping!.sources, fixture.shopping!.removed]) rows.forEach((row, index) => {
        row.id = `row-${index}`;
        row.contributions.forEach(c => {
          if (c.sourceId) { const key = JSON.parse(c.sourceId); c.sourceId = JSON.stringify([mealMap[key[0]], recipeMap[key[1]], key[2]]); }
          c.mealId = mealMap[c.mealId]; c.recipeId = recipeMap[c.recipeId];
        });
      });
      const publicRecipes = Object.fromEntries(Object.entries(recipes).map(([id, recipe]) => {
        const c = recipe.schemaVersion === 2 ? recipe.content : recipe;
        return [recipeMap[id], { title: c.title, originalServings: c.originalServings, ingredients: c.ingredients, ...(c.ingredientGroups ? { ingredientGroups: c.ingredientGroups } : {}) }];
      }));
      fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
      fs.writeFileSync(fixturePath, JSON.stringify({ period: fixture, recipes: publicRecipes }, null, 2));
    }
    if (apply && result.changed) {
      if (option('--reviewed-hash') !== snapshotHash) throw new Error('The reviewed snapshot changed. Review the new dry-run report before applying.');
      if (Buffer.byteLength(JSON.stringify(result.period)) > 800000) throw new Error('Repaired list exceeds the supported document size.');
      await db.runTransaction(async tx => {
        const [latest, workflow, ...latestRecipes] = await tx.getAll(ref, stateRef, ...documents.map(d => d.ref));
        const currentRecipes = Object.fromEntries(latestRecipes.filter(d => d.exists).map(d => [d.id, d.data()]));
        if (hash({ state: workflow.data(), before: latest.data(), recipes: currentRecipes }) !== snapshotHash) throw new Error('The household changed during repair. Run a new dry run.');
        tx.create(household.collection('shoppingMeasurementBackups').doc(`${before.id}-${before.revision}`), { before, snapshotHash });
        tx.set(ref, JSON.parse(JSON.stringify(result.period)));
      });
      report.applied = true; fs.writeFileSync(output, JSON.stringify(report, null, 2));
    }
    console.log(JSON.stringify({ report: path.resolve(output), changed: result.changed, issues: result.issues.length, beforeCards: report.before.length, afterCards: report.after.length, applied: report.applied, snapshotHash }));
  } finally { await db.terminate(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
