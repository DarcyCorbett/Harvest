import fs from 'node:fs';
import path from 'node:path';
import { buildRequirements, type Meal, type RecipeInput } from '../../functions/src/connected/model';
import { classifyCatalogueDeterministically } from '../../functions/src/catalogue/classifier';
import { SEED, hash, recipeCase, buildShoppingGroupsPrompt, type Recipe, type Case } from './aiEvaluationCore';

export const DIR = path.resolve('artifacts/ai-stack-evaluation');
export const read = (name: string) => JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8'));
export function save(name: string, value: unknown) { fs.mkdirSync(DIR, { recursive: true }); const dest = path.join(DIR, name); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest + '.tmp', JSON.stringify(value, null, 2)); fs.renameSync(dest + '.tmp', dest); }
const order = <T extends { id: string }>(rows: T[]) => [...rows].sort((a, b) => hash([SEED, a.id]).localeCompare(hash([SEED, b.id])));
function balanced(rows: Recipe[], count: number): Recipe[] {
  const sources = [...new Set(rows.map(r => r.source.key))].sort();
  const buckets = sources.map(s => order(rows.filter(r => r.source.key === s)));
  const selected: Recipe[] = [];
  while (selected.length < count && buckets.some(b => b.length)) for (const b of buckets) { if (b.length && selected.length < count) selected.push(b.shift()!); }
  return selected;
}
export function prepare() {
  if (fs.existsSync(path.join(DIR, 'dataset.json'))) throw new Error('Dataset exists; refusing to replace frozen inputs');
  const unique = new Map<string, Recipe>();
  const contents = new Set<string>();
  for (const r of read('source-pool.json') as Recipe[]) {
    if (!r.source.canonicalUrl || r.content.ingredients.length < 4 || r.content.ingredients.length > 45 || r.content.instructions.length === 0 || !r.content.originalServings) continue;
    const content = { title: r.content.title, description: r.content.description, originalServings: r.content.originalServings, ingredients: r.content.ingredients.map(({ name, quantity, unit, notes }) => ({ name, quantity, unit, notes })), instructions: r.content.instructions.map(({ text }) => ({ text })), nutrition: r.content.nutrition };
    const key = hash([content.ingredients, content.instructions]);
    if (contents.has(key)) continue;
    contents.add(key);
    unique.set(r.source.canonicalUrl.replace(/\/$/, ''), { ...r, content });
  }
  const pool = [...unique.values()];
  const excludes = /\b(breakfast|pancake|waffle|cookie|cake|muffin|smoothie|cocktail|dip|sauce|stock|broth|dressing|marinade|rub|wings|bites|nuggets|sandwich|omelet|omelette|toast|french toast|salad|appetizer|grilled cheese|salsa|nachos)\b/i;
  const main = pool.filter(r => !excludes.test(r.content.title) && /\b(chicken|beef|pork|lamb|salmon|cod|fish|shrimp|prawn|turkey|tofu|pasta|spaghetti|lasagna|lasagne|chili|curry|stew|risotto|casserole|meatballs|bolognese|gnocchi|enchiladas|burrito|tacos|lentil|stir.fry)\b/i.test(r.content.title));
  const mainIds = new Set(main.map(r => r.id));
  const boundary = pool.filter(r => !mainIds.has(r.id) && /\b(salad|dip|sauce|dressing|wings|potatoes|carrots|broccoli|slaw|asparagus|salsa|hummus)\b/i.test(r.content.title) && !/\b(cake|cookie|dessert|fruit|chocolate)\b/i.test(r.content.title));
  const recipes = [...balanced(main, 80), ...balanced(boundary, 20)].map((r, i) => ({ ...r, sampleKey: `R${String(i + 1).padStart(3, '0')}`, stratum: i < 80 ? 'dinner-main-candidate' : 'dinner-boundary' }));
  if (recipes.length !== 100) throw new Error(`Insufficient recipes: ${recipes.length}`);
  const subset = balanced(recipes.slice(0, 80), 48).concat(balanced(recipes.slice(80), 12));
  const cuisine = balanced(recipes.filter(r => !classifyCatalogueDeterministically(r.content, r.sourceMetadata ?? {}).metadata.cuisines?.length), 30);
  const subs = balanced(recipes.slice(0, 80), 50);
  const cases: Case[] = [...recipes.map(r => recipeCase('taxonomy', r)), ...cuisine.map(r => recipeCase('cuisine', r)), ...subset.map(r => recipeCase('tags', r)), ...subset.map(r => recipeCase('reminders', r)), ...subs.map((r, j) => {
    const candidates = r.content.ingredients.map((x, i) => ({ x, i })).filter(({ x }) => !/^(?:water|salt|pepper|kosher salt|black pepper|freshly ground black pepper|olive oil)$/i.test(x.name));
    return recipeCase('substitutions', r, candidates[j % Math.min(5, candidates.length)]?.i ?? 0);
  })];
  for (let i = 0; i < 30; i++) {
    const size = [3, 5, 7][Math.floor(i / 10)];
    const mains = order(recipes.slice(0, 80).map(r => ({ ...r, id: r.id }))).filter((_, j) => j >= (i * 7) % 65).slice(0, size - 1);
    const selected = [...mains, recipes[80 + (i % 20)]];
    const inputs: Record<string, RecipeInput> = Object.fromEntries(selected.map(r => [r.id, { id: r.id, title: r.content.title, originalServings: r.content.originalServings, ingredients: r.content.ingredients.map((x, index) => ({ name: x.name, quantity: x.quantity ?? 0, unit: x.unit ?? '', ...(x.notes ? { notes: x.notes } : {}), sourceKey: `${r.id}:${index}` })) }]));
    const meals: Meal[] = selected.map((r, j) => ({ id: `meal-${i}-${j}`, recipeId: r.id, date: '2026-10-10', mealType: 'dinner', servings: r.content.originalServings * [.5, 1, 1.5][(i + j) % 3], revision: 1, kind: 'recipe', status: 'planned' }));
    const requirements = buildRequirements(meals, inputs, { start: '2026-10-10', end: '2026-10-10' }, true).sort((a, b) => a.id.localeCompare(b.id));
    const input = requirements.map((r, id) => { const notes = [...new Set([r.notes, ...r.contributions.map(c => c.sourceAmount?.notes)].filter(Boolean))].join('; ').slice(0, 1000); return { id, name: r.name, quantity: r.quantity, unit: r.unit, ...(notes ? { notes } : {}) }; });
    cases.push({ id: `shopping-${String(i + 1).padStart(2, '0')}`, task: 'shopping', recipeIds: selected.map(r => r.id), input, prompt: buildShoppingGroupsPrompt(input), requirements, baselineMax: Math.min(65536, 4096 + input.length * 200) });
  }
  const dataset = { version: 1, seed: SEED, constructedShopping: true, createdAt: new Date().toISOString(), recipes, cases, counts: Object.fromEntries([...new Set(cases.map(c => c.task))].map(t => [t, cases.filter(c => c.task === t).length])) };
  save('dataset.json', dataset);
  save('dataset.sha256.json', { sha256: hash(dataset) });
  // Authoring packets deliberately exclude existing tags and provider predictions.
  for (let i = 0; i < recipes.length; i += 10) save(`authoring/recipes-${i / 10 + 1}.json`, recipes.slice(i, i + 10).map(r => ({ sampleKey: r.sampleKey, id: r.id, ...r.content })));
  save('authoring/substitutions.json', cases.filter(c => c.task === 'substitutions').map(c => ({ id: c.id, ...c.input })));
  save('authoring/shopping.json', cases.filter(c => c.task === 'shopping').map(c => ({ id: c.id, input: c.input })));
  console.log(JSON.stringify({ recipes: recipes.length, counts: dataset.counts, hash: hash(dataset) }));
}
