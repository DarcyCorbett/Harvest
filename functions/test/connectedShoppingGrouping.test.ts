import { describe, expect, it, vi } from 'vitest';
import { groupShoppingRequirements } from '../src/connected/shoppingGrouping.js';
import { buildRequirements, foodKey, normaliseMeal, reconcileItems, setItemAction, type Requirement } from '../src/connected/model.js';

const row = (name: string, quantity: number, unit = 'g'): Requirement => ({
  id: foodKey({ name, quantity, unit }), name, quantity, unit, category: 'Produce',
  contributions: [{ mealId: name, recipeId: name, title: name, quantity }],
});
const group = vi.fn(async (_household: string, inputs: { id: number }[]) => [
  { canonicalName: 'onion', category: 'Produce', sourceIds: inputs.map(i => i.id), unit: 'kg' },
]);

describe('connected Gemini grouping', () => {
  it('uses AI identity and code totals, preserving sources and incompatible units', async () => {
    const result = await groupShoppingRequirements('home', [row('diced onion', 100), row('onions', 200), row('onion', 2, 'piece')], group);
    expect(result.requirements).toHaveLength(2);
    const grams = result.requirements.find(r => r.unit === 'g')!;
    expect(grams).toMatchObject({ name: 'onion', quantity: 300, category: 'Produce' });
    expect(grams.contributions).toHaveLength(2);
    expect(result.requirements.find(r => r.unit === 'piece')?.quantity).toBe(2);
  });

  it('reuses grouping for serving changes, reorders safely, and regroups changed ingredients', async () => {
    group.mockClear();
    const first = await groupShoppingRequirements('home', [row('onions', 100), row('diced onion', 50)], group);
    const second = await groupShoppingRequirements('home', [row('diced onion', 100), row('onions', 200)], group, first.cache);
    expect(group).toHaveBeenCalledTimes(1);
    expect(second.requirements[0].quantity).toBe(300);
    expect(second.requirements[0].id).toBe(first.requirements[0].id);
    await groupShoppingRequirements('home', [row('onions', 100), row('red onion', 50)], group, first.cache);
    expect(group).toHaveBeenCalledTimes(2);
  });

  it.each([[0], [0, 0], [0, 9]])('rejects missing, repeated or invented source IDs: %j', async (...sourceIds) => {
    await expect(groupShoppingRequirements('home', [row('a', 1), row('b', 2)], async () => [
      { canonicalName: 'onion', category: 'Produce', sourceIds },
    ])).rejects.toThrow();
  });

  it('preserves checked quantities and flags a partly purchased merged group for review', async () => {
    const sources = [row('diced onion', 100), row('onions', 200)];
    const previous = reconcileItems([], sources);
    previous[0] = setItemAction(previous[0], 'check');
    const grouped = await groupShoppingRequirements('home', sources, group);
    const next = reconcileItems(previous, grouped.requirements);
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ checked: true, quantity: 300, reviewedQuantity: 100, review: true });
    expect(reconcileItems(next, grouped.requirements)[0].revision).toBe(next[0].revision);
  });

  it('converts and scales in code before AI groups', async () => {
    const meal = normaliseMeal('meal', { recipeId: 'recipe', date: '2026-09-20', servings: 4 });
    const requirements = buildRequirements([meal], { recipe: { id: 'recipe', title: 'Soup', originalServings: 2,
      ingredients: [{ name: 'diced onion', quantity: 1, unit: 'kg' }, { name: 'onions', quantity: 100, unit: 'g' }] } },
    { start: '2026-09-20', end: '2026-09-20' });
    const result = await groupShoppingRequirements('home', requirements, group);
    expect(result.requirements[0]).toMatchObject({ quantity: 2200, unit: 'g' });
    expect(result.requirements[0].contributions.reduce((sum, c) => sum + c.quantity, 0)).toBe(2200);
  });
});
