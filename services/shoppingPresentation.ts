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
