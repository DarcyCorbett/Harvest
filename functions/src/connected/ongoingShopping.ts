import { buildRequirements, foodKey, type Contribution, type ListItem, type Meal, type Period, type RecipeInput, type Requirement, type Workflow } from './model.js';

/** A contribution belongs to one cooking occasion, never to a date window. */
function represents(row: Requirement, source: Contribution): boolean {
  return row.contributions.some(c => c.mealId === source.mealId && (
    c.sourceId && source.sourceId ? JSON.parse(c.sourceId)[2] === JSON.parse(source.sourceId)[2] :
      !source.sourceId || (row.sourceKeys ?? [foodKey(row)]).includes(JSON.parse(source.sourceId)[2])
  ));
}

export function migrateShopping(period: Period): Period {
  if (period.shopping) return period;
  const sources = period.items.filter(i => !i.manual && !i.legacy).map(i => ({
    id: foodKey(i), name: i.name, quantity: i.quantity, unit: i.unit, category: i.category,
    contributions: i.contributions, sourceKeys: i.sourceKeys, approximate: i.approximate,
  }));
  return {
    ...period,
    items: period.items.filter(i => !i.dismissed).map(i => ({ ...i, review: false, obsolete: false })),
    shopping: {
      generation: `ongoing-${period.id}`, mealIds: [...new Set(sources.flatMap(r => r.contributions.map(c => c.mealId)))],
      sources, removed: period.items.filter(i => i.dismissed), purchaseSequence: 0,
    },
  };
}

export function prepareShopping(period: Period, meals: Meal[], recipes: Record<string, RecipeInput>, update?: Workflow['shoppingUpdate']): Period {
  const migrated = migrateShopping(period);
  const shopping = migrated.shopping!;
  const replacing = !!update?.replace;
  const base: Period = replacing ? { ...migrated, items: [], shopping: {
    generation: update!.generation, mealIds: update!.mealIds, sources: [], removed: [], purchaseSequence: 0,
  } } : migrated;
  const next = base.shopping!;
  const mealIds = new Set([...next.mealIds, ...(update?.mealIds ?? [])]);
  const changed = new Set(update?.changedMealIds ?? []);
  const frozen = [...base.items.filter(i => i.checked), ...next.removed];
  // Keep the saved amounts for checked sources. Only changed, enrolled meals are rebuilt.
  const retained = next.sources.flatMap(row => {
    const contributions = row.contributions.filter(c => !changed.has(c.mealId) || frozen.some(i => represents(i, c)));
    return contributions.length ? [{ ...row, contributions, quantity: contributions.reduce((n, c) => n + c.quantity, 0) }] : [];
  });
  const selected = meals.filter(m => mealIds.has(m.id) && changed.has(m.id));
  // Allocation validation is already performed against the whole plan by the command.
  const requirements = buildRequirements(selected.filter(m => m.kind === 'recipe'), recipes,
    { start: '0000-01-01', end: '9999-12-31' }, true);
  const added = requirements.flatMap(row => {
    const contributions = row.contributions.filter(c => !frozen.some(i => represents(i, c)));
    return contributions.length ? [{ ...row, contributions, quantity: contributions.reduce((n, c) => n + c.quantity, 0) }] : [];
  });
  return { ...base, shopping: { ...next, mealIds: [...mealIds], sources: [...retained, ...added] } };
}

export function outstandingRequirements(period: Period): Requirement[] {
  const frozen = [...period.items.filter(i => i.checked), ...period.shopping!.removed];
  const rows = new Map<string, Requirement>();
  for (const row of period.shopping!.sources) {
    const contributions = row.contributions.filter(c => !frozen.some(i => represents(i, c)));
    if (!contributions.length) continue;
    const id = foodKey(row);
    const before = rows.get(id);
    rows.set(id, { ...row, id, contributions: [...(before?.contributions ?? []), ...contributions],
      quantity: (before?.quantity ?? 0) + contributions.reduce((n, c) => n + c.quantity, 0) });
  }
  return [...rows.values()];
}

export function reconcileOngoingItems(period: Period, requirements: Requirement[], revision: number): ListItem[] {
  const old = period.items.filter(i => !i.checked && !i.manual && !i.legacy);
  const used = new Set<string>();
  const next = requirements.map(r => {
    const before = old.find(i => !used.has(i.id) && i.unit === r.unit && (
      foodKey(i) === r.id || (i.sourceKeys ?? [foodKey(i)]).some(k => (r.sourceKeys ?? [r.id]).includes(k))));
    if (before) used.add(before.id);
    const unchanged = before && JSON.stringify([before.name, before.quantity, before.contributions, before.category]) === JSON.stringify([r.name, r.quantity, r.contributions, r.category]);
    return { ...r, id: before?.id ?? `${period.shopping!.generation}:${revision}:${r.id}`,
      revision: before ? before.revision + (unchanged ? 0 : 1) : 1, checked: false, manual: false };
  });
  return [...next, ...period.items.filter(i => i.checked || i.manual || i.legacy)];
}

export function applyOngoingAction(period: Period, item: ListItem, action: 'check' | 'uncheck' | 'delete'): void {
  const shopping = period.shopping!;
  if (action === 'delete') {
    if (!item.manual && !item.legacy) shopping.removed.push(item);
    period.items = period.items.filter(i => i.id !== item.id);
    return;
  }
  item.checked = action === 'check';
  item.revision++;
  item.review = false;
  if (item.checked) item.purchasedOrder = ++shopping.purchaseSequence;
  else {
    delete item.purchasedOrder;
    // Preserve the saved purchase amount on return, including after its meal was edited.
    const other = period.items.find(i => i.id !== item.id && !i.checked && i.manual === item.manual
      && !!i.legacy === !!item.legacy && foodKey(i) === foodKey(item));
    if (other) {
      other.quantity += item.quantity;
      other.contributions.push(...item.contributions);
      other.sourceKeys = [...new Set([...(other.sourceKeys ?? [foodKey(other)]), ...(item.sourceKeys ?? [foodKey(item)])])];
      other.revision++;
      period.items = period.items.filter(i => i.id !== item.id);
    }
  }
}

/** Validate the complete card against one snapshot before touching any row. */
export function applyShoppingBatch(period: Period, entries: { itemId: string; expectedRevision: number }[], action: 'check' | 'uncheck' | 'delete'): void {
  if (!period.shopping || !entries.length || new Set(entries.map(e => e.itemId)).size !== entries.length) throw new Error('Invalid shopping batch.');
  const targets = entries.map(entry => period.items.find(item => item.id === entry.itemId));
  if (targets.some((item, i) => !item || item.revision !== entries[i].expectedRevision)) throw new Error('Shopping item changed.');
  for (const item of targets) {
    // Earlier unchecks can merge into an already outstanding selected row.
    if (item && period.items.includes(item)) applyOngoingAction(period, item, action);
  }
}

export const SHOPPING_RETENTION_DAYS = 14;

/**
 * Drop finished history so the list document cannot grow without bound.
 * A meal is finished once it is older than the retention window (or no longer
 * planned) and nothing from it is still waiting to be bought. Its purchased
 * rows, removed rows and saved sources are then forgotten together; a later
 * edit to that old meal no longer touches the list. Meals in the update
 * being applied are never pruned.
 */
export function pruneShopping(period: Period, meals: Meal[], cutoffDate: string, inProgress: string[] = []): Period {
  const shopping = period.shopping;
  if (!shopping) return period;
  const dates = new Map(meals.filter(m => m.status !== 'removed').map(m => [m.id, m.date]));
  const outstanding = new Set([...inProgress, ...period.items.filter(i => !i.checked).flatMap(i => i.contributions.map(c => c.mealId))]);
  const referenced = new Set([
    ...shopping.mealIds,
    ...shopping.sources.flatMap(r => r.contributions.map(c => c.mealId)),
    ...shopping.removed.flatMap(r => r.contributions.map(c => c.mealId)),
    ...period.items.flatMap(i => i.contributions.map(c => c.mealId)),
  ]);
  const finished = new Set([...referenced].filter(id => !outstanding.has(id) && (dates.get(id) ?? '') < cutoffDate));
  if (!finished.size) return period;
  const trim = <T extends Requirement>(rows: T[]): T[] => rows.flatMap(row => {
    if (!row.contributions.some(c => finished.has(c.mealId))) return [row];
    const contributions = row.contributions.filter(c => !finished.has(c.mealId));
    return contributions.length
      ? [{ ...row, contributions, quantity: contributions.reduce((n, c) => n + c.quantity, 0) }]
      : [];
  });
  return {
    ...period,
    // Manual and legacy rows have no meal; they stay until the household removes them.
    items: [...trim(period.items.filter(i => i.contributions.length)), ...period.items.filter(i => !i.contributions.length)],
    shopping: {
      ...shopping,
      mealIds: shopping.mealIds.filter(id => !finished.has(id)),
      sources: trim(shopping.sources),
      removed: trim(shopping.removed),
    },
  };
}
