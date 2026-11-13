import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { baseAmount, combineAmounts, formatAmount, normalizeIngredient, safeGroupNames } from '../src/shared/ingredientAmounts.js';
import { repairShoppingMeasurements } from '../src/connected/shoppingRepair.js';
import { recipeInput } from '../src/connected/recipeInput.js';
import { buildRequirements, normaliseMeal, type Period } from '../src/connected/model.js';
import { shoppingDisplayGroups } from '../../services/shoppingPresentation';
import { applyShoppingBatch, prepareShopping, outstandingRequirements, reconcileOngoingItems } from '../src/connected/ongoingShopping.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/shopping-week-2026-10-05.json', import.meta.url), 'utf8')) as { period: Period; recipes: Record<string, any> };

describe('shared measurements', () => {
  it('does not replace a package count with a weight embedded in its name', () => {
    const packaged = { name: '340.19 g bag chocolate chips', quantity: 1, unit: '' };
    expect(normalizeIngredient(packaged)).toEqual(packaged);
  });
  it.each(['tbs', 'tbs.', 'tablespoons', 'tbsp'])('repairs explicit %s measurements and preserves a fractional serving scale', unit => {
    expect(normalizeIngredient({ name: `${unit} lemon juice`, quantity: 1.6, unit: '' })).toMatchObject({ name: 'lemon juice', quantity: 1.6, unit: 'tbsp' });
  });
  it('repairs encoded ranges consistently before scaling', () => {
    const recipe = recipeInput('lemon', { title: 'Risotto', originalServings: 5, ingredients: [], ingredientGroups: [{ ingredients: [{ name: '&ndash; 3 tbsp lemon juice', quantity: 2, unit: '' }] }] });
    const rows = buildRequirements([normaliseMeal('meal', { recipeId: 'lemon', date: '2026-10-05', servings: 4 })], { lemon: recipe }, { start: '2026-10-05', end: '2026-10-11' }, true);
    expect(rows[0].contributions[0].sourceAmount).toMatchObject({ name: 'lemon juice', quantity: 1.6, unit: 'tbsp' });
    expect(rows[0].quantity).toBeCloseTo(baseAmount({ quantity: 1.6, unit: 'tbsp' }).quantity);
    expect(rows[0].contributions[0].sourceId).toContain('%26ndash');
  });
  it('combines within dimensions, keeps source kitchen measures, and never guesses densities', () => {
    const parts = combineAmounts([{ quantity: 200, unit: 'g' }, { quantity: 1, unit: 'cup' }, { quantity: 2, unit: 'pinches' }]);
    expect(parts.map(formatAmount)).toEqual(['200 g', '1 cup', '2 pinches']);
    const metric = combineAmounts([{ quantity: 1, unit: 'cup' }, { quantity: 100, unit: 'ml' }])[0];
    expect(metric.unit).toBe('ml'); expect(metric.quantity).toBeCloseTo(336.588);
  });
  it('rounds counts only after summing and keeps tiny positive measurements visible', () => {
    expect(combineAmounts([{ quantity: 2 / 3, unit: '' }, { quantity: 1 / 3, unit: '' }], true)[0].quantity).toBe(1);
    expect(combineAmounts([{ quantity: 5.667, unit: '' }], true)[0].quantity).toBe(6);
    expect(formatAmount({ quantity: 0.001, unit: 'tsp' })).toBe('0.001 tsp');
  });
  it('recognizes explicit count words without converting heads to cloves', () => {
    expect(normalizeIngredient({ name: 'garlic cloves', quantity: 2, unit: '' })).toMatchObject({ name: 'garlic', unit: 'clove' });
    expect(normalizeIngredient({ name: 'cloves', quantity: 2, unit: '' }).name).toBe('cloves');
    expect(combineAmounts([{ quantity: 1, unit: 'head' }, { quantity: 2, unit: 'cloves' }])).toHaveLength(2);
  });
  it('retains product forms even when the model over-merges or strips qualifiers', () => {
    expect(safeGroupNames('stock', [{ name: 'stock' }, { name: 'stock powder' }])).toEqual(['stock', 'stock powder']);
    expect(safeGroupNames('shrimp', [{ name: 'shrimp', notes: 'cooked and peeled' }])).toEqual(['shrimp (cooked)']);
    expect(safeGroupNames('parsley', [{ name: 'fresh parsley' }, { name: 'dried parsley' }])).toEqual(['fresh parsley', 'dried parsley']);
  });
});

describe('current-week saved list repair', () => {
  it('repairs all 58 entries without losing a contribution or purchase and is idempotent', () => {
    const before = structuredClone(fixture.period);
    const result = repairShoppingMeasurements(before, fixture.recipes);
    expect(before).toEqual(fixture.period);
    expect(result.issues).toEqual([]);
    const signatures = (p: Period, checked: boolean) => p.items.filter(i => i.checked === checked).flatMap(i => i.contributions.map(c => c.sourceId)).sort();
    expect(signatures(result.period, true)).toEqual(signatures(before, true));
    expect(signatures(result.period, false)).toEqual(signatures(before, false));
    expect(repairShoppingMeasurements(result.period, fixture.recipes)).toMatchObject({ changed: false, issues: [] });
    const groups = [false, true].flatMap(checked => shoppingDisplayGroups(result.period.items.filter(i => i.checked === checked), checked));
    expect(groups.find(g => g.name === 'cauliflower florets')?.label).toBe('2 cups');
    expect(groups.find(g => g.name === 'lemon juice')?.label).toBe('1.6 tbsp');
    expect(groups.filter(g => g.name === 'salt')).toHaveLength(1);
    expect(groups.filter(g => g.name === 'black pepper')).toHaveLength(1);
    expect(groups.find(g => g.name === 'garlic')?.label).toBe('10 cloves');
    expect(groups.find(g => g.name === 'butter')?.label).toBe('48 g + 3 tbsp');
    expect(groups.find(g => g.name === 'eggs')?.label).toBe('6');
    const stocks = groups.filter(g => /stock/.test(g.name));
    expect(stocks).toHaveLength(2);
    expect(stocks.some(g => g.label === '1 tsp')).toBe(true);
    expect(stocks.some(g => g.label === '3.2 cups')).toBe(true);
  });
  it('leaves unavailable and ambiguous evidence unchanged and reports it', () => {
    const result = repairShoppingMeasurements(fixture.period, {});
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.period.items.map(i => [i.name, i.quantity, i.unit, i.checked])).toEqual(fixture.period.items.map(i => [i.name, i.quantity, i.unit, i.checked]));
  });
  it('checks a whole mixed-measure card atomically and rejects stale revisions', () => {
    const period = repairShoppingMeasurements(fixture.period, fixture.recipes).period;
    const targets = period.items.filter(i => i.name === 'butter');
    const entries = targets.map(i => ({ itemId: i.id, expectedRevision: i.revision }));
    const original = structuredClone(period);
    expect(() => applyShoppingBatch(period, [{ ...entries[0], expectedRevision: -1 }, entries[1]], 'uncheck')).toThrow();
    expect(period).toEqual(original);
    applyShoppingBatch(period, entries, 'uncheck');
    expect(period.items.filter(i => i.name === 'butter').every(i => !i.checked)).toBe(true);
    expect(() => applyShoppingBatch(period, entries, 'uncheck')).toThrow();
  });
  it('retains repaired frozen purchases when servings change and when new meals need more', () => {
    const period = repairShoppingMeasurements(fixture.period, fixture.recipes).period;
    const bought = period.items.filter(i => i.checked);
    const recipes = Object.fromEntries(Object.entries(fixture.recipes).map(([id, value]) => [id, recipeInput(id, value)]));
    const occasions = new Map(period.shopping!.sources.flatMap(row => row.contributions.map(c => [c.mealId, c.recipeId] as const)));
    const meals = [...occasions].map(([id, recipeId]) => normaliseMeal(id, { recipeId, date: '2026-10-05', servings: 8 }));
    const extra = normaliseMeal('new-meal', { recipeId: meals[0].recipeId, date: '2026-10-06', servings: 4 });
    const prepared = prepareShopping(period, [...meals, extra], recipes, { mealIds: ['new-meal'], changedMealIds: [...occasions.keys(), 'new-meal'], replace: false, generation: period.shopping!.generation });
    prepared.items = reconcileOngoingItems(prepared, outstandingRequirements(prepared), period.revision + 1);
    expect(prepared.items.filter(i => i.checked)).toEqual(bought);
    expect(prepared.items.some(i => !i.checked && i.contributions.some(c => c.mealId === 'new-meal'))).toBe(true);
    const oldPurchasedIds = new Set(bought.flatMap(i => i.contributions.map(c => c.sourceId)));
    expect(prepared.items.filter(i => !i.checked).flatMap(i => i.contributions).some(c => oldPurchasedIds.has(c.sourceId))).toBe(false);
  });
});
