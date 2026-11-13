import { createHash } from 'node:crypto';
import { baseAmount, normalizeIngredient, normalizedName, shoppingName, safeGroupNames, type NamedIngredient } from '../shared/ingredientAmounts.js';
import { ingredientSourceKey } from './recipeInput.js';
import { foodKey, type Contribution, type Period, type Requirement } from './model.js';

export interface ShoppingRepairIssue { sourceId?: string; recipeId: string; reason: string }
export interface ShoppingRepairResult { period: Period; changed: boolean; issues: ShoppingRepairIssue[] }

/** Pure, repeatable repair. Infer historical scale from saved contributions, never today's plan. */
export function repairShoppingMeasurements(original: Period, recipes: Record<string, Record<string, any>>): ShoppingRepairResult {
  const period: Period = structuredClone(original);
  const issues: ShoppingRepairIssue[] = [];
  if (!period.shopping) return { period, changed: false, issues: [{ recipeId: '', reason: 'Only ongoing lists can be repaired.' }] };
  const savedSources = original.shopping!.sources;
  const issue = (c: Contribution, reason: string) => { issues.push({ sourceId: c.sourceId, recipeId: c.recipeId, reason }); };
  const repairContribution = (row: Requirement, c: Contribution, ordinal: number): Contribution => {
    if (c.sourceAmount) return c;
    const raw = recipes[c.recipeId];
    const content = raw?.schemaVersion === 2 ? raw.content : raw;
    if (!content) { issue(c, 'Source recipe unavailable'); return c; }
    let key: string | undefined;
    try { key = c.sourceId ? JSON.parse(c.sourceId)[2] : undefined; } catch { /* reported below */ }
    if (!key) { issue(c, 'Missing source identity'); return c; }
    const foods: NamedIngredient[] = content.ingredientGroups?.length
      ? content.ingredientGroups.flatMap((g: { ingredients: NamedIngredient[] }) => g.ingredients) : content.ingredients ?? [];
    const matches = foods.filter(food => ingredientSourceKey({ ...food, unit: food.unit ?? '', quantity: food.quantity ?? 0 }) === key);
    const saved = savedSources.flatMap(source => source.contributions.filter(candidate => candidate.sourceId === c.sourceId && candidate.recipeId === c.recipeId && candidate.mealId === c.mealId && Math.abs(candidate.quantity - c.quantity) < 1e-7).map(() => source));
    const source = saved[0];
    const candidate = matches[ordinal];
    if (!source || !candidate || saved.some(s => s.name !== source.name || s.unit !== source.unit)) {
      issue(c, 'Ambiguous source occurrence'); return c;
    }
    if (normalizedName(source.name) !== normalizedName(candidate.name)) {
      issue(c, 'Saved substitution or changed source; kept unchanged'); return c;
    }
    // Old rows used canonical volume/weight arithmetic, except malformed missing units.
    const oldAmount = baseAmount({ quantity: candidate.quantity, unit: candidate.unit ?? '' });
    if (oldAmount.unit !== row.unit && oldAmount.unit !== source.unit) {
      issue(c, 'Source measurement differs from saved requirement'); return c;
    }
    if (!(oldAmount.quantity > 0) && c.quantity !== 0) { issue(c, 'Cannot establish saved serving scale'); return c; }
    const scale = oldAmount.quantity > 0 ? c.quantity / oldAmount.quantity : 1;
    const normalized = normalizeIngredient({ ...candidate, unit: candidate.unit ?? '' });
    const sourceAmount = { ...normalized, quantity: normalized.quantity * scale };
    if (!Number.isFinite(sourceAmount.quantity) || sourceAmount.quantity < 0) { issue(c, 'Invalid recovered amount'); return c; }
    const servings = oldAmount.quantity > 0 ? Number(content.originalServings) * scale : undefined;
    return { ...c, quantity: baseAmount(sourceAmount).quantity, sourceAmount,
      ...(servings && Number.isFinite(servings) ? { servings } : {}) };
  };
  function repairRows<T extends Requirement>(rows: T[], semantic: boolean): T[] {
    return rows.flatMap(row => {
      if ('manual' in row && (row.manual || ('legacy' in row && row.legacy))) return [row];
      const ordinal = new Map<string, number>();
      const buckets = new Map<string, { name: string; unit: string; contributions: Contribution[] }>();
      for (const c of row.contributions) {
        const occurrence = JSON.stringify([c.mealId, c.recipeId, c.sourceId]);
        const index = ordinal.get(occurrence) ?? 0;
        ordinal.set(occurrence, index + 1);
        const next = repairContribution(row, c, index);
        const unit = next.sourceAmount ? baseAmount(next.sourceAmount).unit : row.unit;
        const name = next.sourceAmount ? (semantic ? safeGroupNames(row.name, [next.sourceAmount])[0] : shoppingName(next.sourceAmount)) : row.name;
        const key = JSON.stringify([name, unit]);
        const bucket = buckets.get(key) ?? { name, unit, contributions: [] };
        bucket.contributions.push(next); buckets.set(key, bucket);
      }
      if (!buckets.size) return [row];
      if ([...buckets.values()].some(bucket => bucket.contributions.some(c => !c.sourceAmount))) return [row];
      const values = [...buckets.entries()].map(([key, value], index) => ({ ...row, ...value,
        id: index ? `${row.id}:measure-${createHash('sha256').update(key).digest('hex').slice(0, 10)}` : row.id,
        quantity: value.contributions.reduce((sum, c) => sum + c.quantity, 0),
        sourceKeys: [...new Set([...(row.sourceKeys ?? [foodKey(row)]), foodKey({ name: value.name, unit: value.unit, quantity: 0 })])],
      } as T));
      const changed = JSON.stringify(values) !== JSON.stringify([row]);
      return values.map(value => changed && 'revision' in row ? { ...value, revision: Number(row.revision) + 1 } : value);
    });
  }
  period.shopping.sources = repairRows(period.shopping.sources, false);
  period.shopping.removed = repairRows(period.shopping.removed, true);
  period.items = repairRows(period.items, true);
  const changed = JSON.stringify(period) !== JSON.stringify(original);
  if (changed) { period.revision++; delete period.shoppingGrouping; }
  return { period, changed, issues: issues.filter((issue, index, all) => all.findIndex(other => JSON.stringify(other) === JSON.stringify(issue)) === index) };
}
