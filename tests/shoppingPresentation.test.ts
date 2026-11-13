import { describe, expect, it } from 'vitest';
import { purchasedItems, shoppingIsUpdating, shoppingDisplayGroups, commandHasItem } from '../services/shoppingPresentation';
import type { ListItem, PendingCheck, Period, Workflow } from '../services/connectedClient';
const item = (id: string, order?: number): ListItem => ({ id, name: id, quantity: 1, unit: '', category: 'Other', revision: 1, checked: true, manual: true, contributions: [], purchasedOrder: order });
const pending = (id: string, action = 'check'): PendingCheck => ({ id, command: { periodId: 'list', itemId: id, action } });
describe('purchase order', () => {
  it('waits for the matching item snapshot even if the ready state arrives first', () => {
    const state: Workflow = { version: 2, revision: 3, periodId: 'list', status: 'ready', minShoppingClientVersion: 4 };
    const period = { id: 'list', completedWorkflowRevision: 2, shopping: {} } as Period;
    expect(shoppingIsUpdating(state, period)).toBe(true);
    expect(shoppingIsUpdating(state, null)).toBe(true);
    expect(shoppingIsUpdating(state, { ...period, completedWorkflowRevision: 3 })).toBe(false);
    expect(shoppingIsUpdating({ ...state, status: 'pending' }, period)).toBe(true);
    expect(shoppingIsUpdating({ ...state, status: 'error' }, period)).toBe(false);
  });
  it('sorts by checking order and preserves legacy order beneath new purchases', () => {
    const items = [item('z'), item('a'), item('b', 1), item('x', 3), item('c', 2)];
    expect(purchasedItems(items, [], 'list').map(i => i.id)).toEqual(['x','c','b','z','a']);
  });
  it('shows offline checks immediately in tap order and removes unchecked/deleted items', () => {
    const items = [item('old', 1), { ...item('first'), checked: false }, { ...item('second'), checked: false }];
    expect(purchasedItems(items, [pending('first'), pending('second')], 'list').map(i => i.id)).toEqual(['second', 'first', 'old']);
    expect(purchasedItems(items, [pending('old', 'uncheck')], 'list')).toEqual([]);
    expect(purchasedItems(items, [pending('old', 'delete')], 'list')).toEqual([]);
    expect(purchasedItems(items, [{ ...pending('first'), error: 'conflict' }], 'list').map(i => i.id)).toEqual(['old']);
  });
  it('ignores queued checks from another list', () => {
    expect(purchasedItems([{ ...item('a'), checked: false }], [pending('a')], 'other')).toEqual([]);
  });
  it('overlays a grouped card check or removal for every member without crossing list boundaries', () => {
    const items = [{ ...item('a'), name: 'butter', checked: false }, { ...item('b'), name: 'butter', checked: false }];
    const entry: PendingCheck = { id: 'batch', command: { operation: 'shoppingBatch', periodId: 'list', action: 'check', items: [{ itemId: 'a', expectedRevision: 1 }, { itemId: 'b', expectedRevision: 1 }] } };
    expect(commandHasItem(entry.command, 'b')).toBe(true);
    expect(commandHasItem(entry.command, 'other')).toBe(false);
    const bought = purchasedItems(items, [entry], 'list');
    expect(bought).toHaveLength(2);
    expect(shoppingDisplayGroups(bought, true)).toHaveLength(1);
    expect(purchasedItems(items, [entry], 'other')).toEqual([]);
    expect(purchasedItems(items, [{ ...entry, error: 'stale' }], 'list')).toEqual([]);
    expect(purchasedItems(items.map(i => ({ ...i, checked: true })), [{ ...entry, command: { ...(entry.command as object), action: 'delete' } }], 'list')).toEqual([]);
  });
});
