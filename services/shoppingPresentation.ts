import type { ListItem, PendingCheck, Period, Workflow } from './connectedClient';
import { combineAmounts, formatAmount, normalizedName, productForm, type DisplayAmount } from '../functions/src/shared/ingredientAmounts';

export function commandHasItem(command: unknown, itemId: string): boolean {
  const value = command as { itemId?: string; items?: { itemId: string }[] };
  return value.itemId === itemId || !!value.items?.some(item => item.itemId === itemId);
}

export interface ShoppingDisplayGroup {
  id: string;
  name: string;
  category: string;
  checked: boolean;
  items: ListItem[];
  contributions: ListItem['contributions'];
  amounts: DisplayAmount[];
  label: string;
}

export function shoppingDisplayGroups(items: ListItem[], checked: boolean): ShoppingDisplayGroup[] {
  const groups = new Map<string, ShoppingDisplayGroup>();
  for (const item of items) {
    const id = JSON.stringify([normalizedName(item.name), productForm(item), checked]);
    const group = groups.get(id) ?? { id, name: item.name, category: item.category, checked, items: [], contributions: [], amounts: [], label: '' };
    group.items.push(item);
    group.contributions.push(...item.contributions);
    groups.set(id, group);
  }
  for (const group of groups.values()) {
    const amounts = group.items.flatMap(item => item.contributions.length && item.contributions.every(c => c.sourceAmount)
      ? item.contributions.map(c => c.sourceAmount!)
      : [{ name: item.name, quantity: item.quantity, unit: item.unit, notes: item.notes }]);
    group.amounts = combineAmounts(amounts, true);
    group.label = group.amounts.map(formatAmount).join(' + ');
  }
  return [...groups.values()];
}

/** Name for comparison only: case, punctuation, app-added form tags like "(dried)" and simple plurals are ignored. */
function comparableName(name: string): string {
  return normalizedName(name).replace(/\([^)]*\)/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
    .split(' ').map(word => word.replace(/ies$/, 'y').replace(/oes$/, 'o').replace(/s$/, '')).join(' ');
}

/**
 * The recipe's own wording for a merged shopping item, when it differs from the item's name
 * (e.g. "hot or Italian sausages" under "sausages"). Undefined when every name matches.
 */
export function sourceNameNote(itemName: string, contributions: ListItem['contributions']): string | undefined {
  const target = comparableName(itemName);
  const names = new Map<string, string>();
  for (const contribution of contributions) {
    const original = contribution.sourceAmount?.name?.trim();
    if (!original) continue;
    const key = comparableName(original);
    if (key && key !== target && !names.has(key)) names.set(key, original);
  }
  return names.size ? [...names.values()].join('; ') : undefined;
}

export function shoppingIsUpdating(state: Workflow | null, period: Period | null): boolean {
  return state?.status === 'pending' || (!!state && state.minShoppingClientVersion === 4 && state.status !== 'error'
    && (!period?.shopping || period.id !== state.periodId || (period.completedWorkflowRevision ?? 0) < state.revision));
}

export function purchasedItems(items: ListItem[], pending: PendingCheck[], periodId?: string): ListItem[] {
  const commands = pending.filter(p => !p.error && (p.command as { periodId?: string }).periodId === periodId);
  const action = (item: ListItem) => commands.find(p => commandHasItem(p.command, item.id));
  return items.filter(item => {
    const entry = action(item);
    const value = (entry?.command as { action?: string } | undefined)?.action;
    return value === 'check' || (item.checked && value !== 'uncheck' && value !== 'delete');
  }).sort((a, b) => {
    const ap = action(a), bp = action(b);
    if (ap || bp) return (bp ? commands.indexOf(bp) + 1 : 0) - (ap ? commands.indexOf(ap) + 1 : 0);
    return (b.purchasedOrder ?? 0) - (a.purchasedOrder ?? 0);
  });
}

/** The server names manual items after the request that created them (functions/src/connected/service.ts). */
export function manualItemId(requestId: string): string {
  return `manual-${requestId}`;
}
