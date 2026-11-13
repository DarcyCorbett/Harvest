import { describe, expect, it } from 'vitest';
import { normaliseMeal, type Meal, type Period, type RecipeInput } from '../src/connected/model.js';
import { pruneShopping, migrateShopping, prepareShopping, outstandingRequirements, reconcileOngoingItems, applyOngoingAction } from '../src/connected/ongoingShopping.js';

const recipe: RecipeInput = { id: 'soup', title: 'Soup', originalServings: 2, ingredients: [{ name: 'onion', quantity: 100, unit: 'g' }] };
const meal = (id: string, patch: Partial<Meal> = {}) => normaliseMeal(id, { recipeId: 'soup', date: '2026-09-07', servings: 2, ...patch });
const empty = () => migrateShopping({ id: 'list', start: '2026-09-01', end: '2026-09-07', items: [], revision: 1 });
function update(period: Period, meals: Meal[], changed: string[], added: string[] = [], replace = false) {
  const prepared = prepareShopping(period, meals, { soup: recipe }, { mealIds: added, changedMealIds: changed, replace, generation: 'replacement' });
  prepared.items = reconcileOngoingItems(prepared, outstandingRequirements(prepared), period.revision + 1);
  prepared.revision++;
  return prepared;
}

describe('ongoing shopping list', () => {
  it('includes enrolled meals on any date, consolidates quantities and ignores other meals', () => {
    const meals = [meal('a'), meal('b', { date: '2028-10-01' }), meal('outside')];
    const list = update(empty(), meals, ['a','b'], ['a','b']);
    expect(list.items).toHaveLength(1);
    expect(list.items[0].quantity).toBe(200);
    expect(list.items[0].contributions.map(c => c.mealId)).toEqual(['a', 'b']);
  });
  it('freezes purchases on edits while new meals create a separate outstanding entry', () => {
    let list = update(empty(), [meal('a')], ['a'], ['a']);
    applyOngoingAction(list, list.items[0], 'check');
    const bought = structuredClone(list.items[0]);
    list = update(list, [meal('a', { servings: 6 })], ['a']);
    expect(list.items).toEqual([bought]);
    list = update(list, [meal('a', { servings: 6 }), meal('b')], ['b'], ['b']);
    expect(list.items.find(i => !i.checked)?.quantity).toBe(100);
    expect(list.items.find(i => i.checked)).toEqual(bought);
    applyOngoingAction(list, list.items.find(i => i.checked)!, 'uncheck');
    expect(list.items).toHaveLength(1);
    expect(list.items[0].quantity).toBe(200);
    list = update(list, [meal('a', { servings: 6 }), meal('b')], []);
    expect(list.items[0].quantity).toBe(200);
    expect(new Set(list.items[0].contributions.map(c => c.sourceId)).size).toBe(2);
  });
  it('keeps removed contributions excluded across edits but allows new meals', () => {
    let list = update(empty(), [meal('a')], ['a'], ['a']);
    applyOngoingAction(list, list.items[0], 'delete');
    list = update(list, [meal('a', { servings: 4 })], ['a']);
    expect(list.items).toEqual([]);
    list = update(list, [meal('a'), meal('b')], ['b'], ['b']);
    expect(list.items[0].quantity).toBe(100);
    expect(list.items[0].contributions[0].mealId).toBe('b');
  });
  it('updates outstanding substitutions using the stable original source identity', () => {
    let list = update(empty(), [meal('a')], ['a'], ['a']);
    const changed = meal('a', { overrides: [{ recipeId: 'soup', ingredientIndex: 0, replacement: { name: 'leek', quantity: 200, unit: 'g' }, adjustment: 'Swap' }] });
    list = update(list, [changed], ['a']);
    expect(list.items[0]).toMatchObject({ name: 'leek', quantity: 200 });
    applyOngoingAction(list, list.items[0], 'check');
    list = update(list, [meal('a')], ['a']);
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ checked: true, name: 'leek', quantity: 200 });
  });
  it('replaces manual and purchased items and never revives excluded old meals', () => {
    let list = update(empty(), [meal('a')], ['a'], ['a']);
    applyOngoingAction(list, list.items[0], 'check');
    list.items.push({ ...list.items[0], id: 'manual', name: 'soap', manual: true, contributions: [] });
    const original = structuredClone(list);
    list = update(list, [meal('a'), meal('b')], ['b'], ['b'], true);
    expect(original.items).toHaveLength(2);
    expect(list.items).toHaveLength(1);
    expect(list.shopping?.generation).toBe('replacement');
    expect(list.items[0]).toMatchObject({ checked: false, quantity: 100 });
    list = update(list, [meal('a', { servings: 6 }), meal('b')], ['a']);
    expect(list.items[0].quantity).toBe(100);
  });
  it('migrates active rows without importing archived trips and excludes dismissed entries', () => {
    const row = { id: 'old', name: 'onion', quantity: 100, unit: 'g', category: 'Produce', revision: 3, checked: true, manual: false, contributions: [{ mealId: 'a', recipeId: 'soup', title: 'Soup', quantity: 100 }] };
    let list = migrateShopping({ id: 'old-list', revision: 8, start: '2020-01-01', end: '2020-01-07', items: [row, { ...row, id: 'dismissed', checked: false, dismissed: true, contributions: [{ ...row.contributions[0], mealId: 'b' }] }] });
    expect(list.items).toHaveLength(1);
    expect(list.items[0].id).toBe('old');
    list = update(list, [meal('a', { servings: 5 }), meal('b', { servings: 5 })], ['a', 'b']);
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ id: 'old', checked: true, quantity: 100 });
    expect(migrateShopping(list)).toBe(list);
  });
  it('updates only unpurchased sources of a shared row and preserves purchase sequence', () => {
    let list = update(empty(), [meal('a')], ['a'], ['a']);
    applyOngoingAction(list, list.items[0], 'check');
    expect(list.items[0].purchasedOrder).toBe(1);
    list = update(list, [meal('a'), meal('b')], ['b'], ['b']);
    list = update(list, [meal('a', { servings: 8 }), meal('b', { servings: 4 })], ['a','b']);
    expect(list.items.find(i => !i.checked)?.quantity).toBe(200);
    expect(list.items.find(i => i.checked)?.quantity).toBe(100);
    applyOngoingAction(list, list.items.find(i => !i.checked)!, 'check');
    expect(list.items.map(i => i.purchasedOrder).sort()).toEqual([1,2]);
  });
  it('keeps reserved leftover portions in the source meal once', () => {
    const meals = [meal('a', { allocatedPortions: 2 }), meal('b', { kind: 'leftover', sourceMealId: 'a', date: '2026-09-08' })];
    const list = update(empty(), meals, ['a', 'b'], ['a']);
    expect(list.items[0].quantity).toBe(200);
    expect(list.items[0].contributions).toHaveLength(1);
  });
  it('does not re-add a purchased ingredient when its meal changes to another recipe', () => {
    let list = update(empty(), [meal('a')], ['a'], ['a']);
    applyOngoingAction(list, list.items[0], 'check');
    const bought = structuredClone(list.items[0]);
    const other = { ...recipe, id: 'other', title: 'Other soup', ingredients: [...recipe.ingredients, { name: 'carrot', quantity: 50, unit: 'g' }] };
    list = prepareShopping(list, [meal('a', { recipeId: 'other' })], { other }, { mealIds: [], changedMealIds: ['a'], replace: false, generation: list.shopping!.generation });
    list.items = reconcileOngoingItems(list, outstandingRequirements(list), 3);
    expect(list.items.find(i => i.checked)).toEqual(bought);
    expect(list.items.filter(i => !i.checked).map(i => i.name)).toEqual(['carrot']);
  });
  it('forgets finished old meals but keeps anything still to buy, recent meals and manual rows', () => {
    const meals = [meal('old', { date: '2026-08-01' }), meal('oldOpen', { date: '2026-08-02' }), meal('recent', { date: '2026-09-07' })];
    let list = update(empty(), meals, ['old'], ['old']);
    applyOngoingAction(list, list.items[0], 'check');
    list = update(list, meals, ['oldOpen'], ['oldOpen']);
    list = update(list, meals, ['recent'], ['recent']);
    list.items.push({ id: 'manual-1', name: 'Soap', quantity: 1, unit: '', category: 'Other', manual: true, checked: true, revision: 1, contributions: [] });
    const before = JSON.stringify(list).length;
    const pruned = pruneShopping(list, meals, '2026-08-24');
    const mealsLeft = (rows: { contributions: { mealId: string }[] }[]) => new Set(rows.flatMap(r => r.contributions.map(c => c.mealId)));
    expect(mealsLeft(pruned.items).has('old')).toBe(false);
    expect(mealsLeft(pruned.shopping!.sources).has('old')).toBe(false);
    expect(pruned.shopping!.mealIds).not.toContain('old');
    expect(pruned.items.some(i => i.id === 'manual-1')).toBe(true);
    expect(JSON.stringify(pruned).length).toBeLessThan(before);
    // Everything not finished is untouched and still reconciles to the same outstanding rows.
    for (const id of mealsLeft(list.items)) if (id !== 'old') expect(mealsLeft(pruned.items).has(id)).toBe(true);
    expect(outstandingRequirements(pruned)).toEqual(outstandingRequirements(list));
    expect(pruneShopping(pruned, meals, '2026-08-24')).toBe(pruned);
    expect(pruneShopping(list, meals, '2026-08-24', ['old'])).toBe(list);
  });
  it('does not prune a list with nothing old', () => {
    const list = update(empty(), [meal('a')], ['a'], ['a']);
    expect(pruneShopping(list, [meal('a')], '2026-08-24')).toBe(list);
  });

});
