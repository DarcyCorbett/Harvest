import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { needsPlanReview } from '../services/planning';

const read = (path: string) => readFileSync(path, 'utf8');
const meal = (id: string, date: string, mealType = 'dinner', status = 'planned') =>
  ({ id, recipeId: 'r', date, mealType, servings: 2, revision: 1, kind: 'recipe', status }) as never;

describe('shopping keep/replace is chosen by callers, not the transport', () => {
  it('has no dialog in ConnectedContext.run()', () => {
    const context = read('contexts/ConnectedContext.tsx');
    expect(context).not.toContain('Alert.alert');
    expect(context).not.toContain('ShoppingChoice');
    expect(context).toContain("const mode: 'keep' | 'replace' = submitted.shoppingMode === 'replace' && list.items.length ? 'replace' : 'keep';");
    expect(context).toContain('delete submitted.shoppingMode;');
    expect(existsSync('components/connected/ShoppingChoice.tsx')).toBe(false);
  });

  it('offers Add to existing / Replace list inside PlanReview, defaulting to keep', () => {
    const review = read('components/connected/PlanReview.tsx');
    expect(review).toContain('useState<ShoppingMode>("keep")');
    expect(review).toContain('label="Add to existing"');
    expect(review).toContain('label="Replace list"');
    expect(review).toContain('await onApply(receipt.current.changes, receipt.current.id, mode);');
    expect(read('components/connected/PlanScreen.tsx')).toContain("c.run({operation:'mutate', changes, shoppingMode, shoppingMealIds:");
    expect(read('components/connected/GenerateScreen.tsx')).toContain("c.run({operation:'mutate', changes, shoppingMode, shoppingMealIds:");
  });

  it('only asks for review when there is a slot clash or a list to keep or replace', () => {
    const planned = [meal('a', '2026-11-16'), meal('b', '2026-11-17', 'dinner', 'removed')];
    expect(needsPlanReview([meal('n1', '2026-11-18')], planned, false)).toBe(false);
    expect(needsPlanReview([meal('n2', '2026-11-17')], planned, false)).toBe(false);
    expect(needsPlanReview([meal('n3', '2026-11-16')], planned, false)).toBe(true);
    expect(needsPlanReview([meal('n4', '2026-11-16', 'lunch')], planned, false)).toBe(false);
    expect(needsPlanReview([meal('n5', '2026-11-18')], planned, true)).toBe(true);
  });

  it('lets the shopping-updating notice open the Shopping tab', () => {
    const notice = read('components/connected/classic.tsx');
    expect(notice).toContain('"Plan saved · updating shopping list · View"');
    expect(notice).toContain('else if (failedNotice || shoppingNotice) router.push("/shopping");');
  });
});
