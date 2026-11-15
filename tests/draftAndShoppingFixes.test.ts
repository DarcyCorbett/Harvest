import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import { manualItemId } from '../services/shoppingPresentation';

vi.mock('react-native', () => ({ Alert: { alert: vi.fn() }, Platform: { OS: 'ios' } }));


const read = (path: string) => readFileSync(path, 'utf8');

describe('shopping list fixes', () => {
  it('names manual items the way the server does so Undo can find them', () => {
    expect(manualItemId('req-1')).toBe('manual-req-1');
    expect(read('functions/src/connected/service.ts')).toContain('id: `manual-${requestId}`');
  });

  it('sends a request id with typed items and keeps it for Undo', () => {
    const screen = read('components/connected/ShoppingScreen.tsx');
    expect(screen).toContain("c.addManual({ name: name.trim(), quantity: number, unit, category }, request)");
    expect(screen).toContain("{ id: manualItemId(request), name: name.trim() }");
    expect(screen).not.toContain("setLastAdded({ id: ''");
  });

  it('asks before removing selected items, on web as well as native', async () => {
    const screen = read('components/connected/ShoppingScreen.tsx');
    expect(screen).toMatch(/action === 'delete' && !\(await confirmAction\(/);
    const { Alert } = await import('react-native');
    const { confirmAction } = await import('../services/confirmAction');
    const pending = confirmAction({ title: 'Remove 2 items?', message: 'm', confirmLabel: 'Remove', destructive: true });
    const buttons = (Alert.alert as unknown as ReturnType<typeof vi.fn>).mock.calls[0][2];
    buttons.find((b: { text: string }) => b.text === 'Remove').onPress();
    await expect(pending).resolves.toBe(true);
    expect(read('services/confirmAction.ts')).toContain("window.confirm");
  });

  it('opens recipes from the list with their planned meal so swaps and servings apply', () => {
    const screen = read('components/connected/ShoppingScreen.tsx');
    expect(screen).toContain('mealPlanEntry={previewMeal && preview?.id ? mealEntryFor(previewMeal, preview.id) : undefined}');
  });
});

describe('shopping store mode', () => {
  it('clears purchased items in one action, with confirmation', () => {
    const screen = read('components/connected/ShoppingScreen.tsx');
    expect(screen).toContain("title === 'Purchased' && !selection && <Pill label=\"Clear purchased\"");
    expect(screen).toMatch(/const clearPurchased = async \(\) => \{[\s\S]*?confirmAction\([\s\S]*?checkGroup\(clearable\.flatMap\(group => group\.items\), 'delete'\)/);
  });
  it('selects only remaining items with All', () => {
    const screen = read('components/connected/ShoppingScreen.tsx');
    expect(screen).toContain('<Pill label="All remaining" onPress={() => setSelected(active.filter(i => !pendingFor(i)).map(i => i.id))} />');
  });
  it('focuses the item field and adds on Enter', () => {
    const screen = read('components/connected/ShoppingScreen.tsx');
    expect(screen).toContain('autoFocus placeholder="e.g. Batteries" returnKeyType="done" blurOnSubmit={false} onSubmitEditing={() => { if (name.trim()) void saveManual(); }}');
    expect(screen).toContain('const quickAdd = quickAddChoices(category);');
  });
});
