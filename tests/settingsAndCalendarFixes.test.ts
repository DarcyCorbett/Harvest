import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');

describe('settings fixes', () => {
  it('asks before closing Settings with unsaved edits, from the X and from hardware back', () => {
    const settings = read('components/SettingsModal.tsx');
    expect(settings).toContain("title: 'Discard changes?'");
    expect(settings).toContain('onRequestClose={() => { void requestClose(); }}');
    expect(settings).toMatch(/onPress=\{\(\) => \{ void requestClose\(\); \}\}\s*accessibilityRole="button"\s*accessibilityLabel="Close settings"/);
    // Save writes exactly what the dirty check compares.
    expect(settings).toContain('mergeCatalogueSettings(loadedSettings, draft)');
  });

  it('reschedules meal reminders when reminder settings change', () => {
    const hook = read('hooks/useMealReminderSync.ts');
    expect(hook).toContain('const reminderSettings = JSON.stringify(settings.mealReminders ?? null);');
    expect(hook).toContain('}, [householdId, refreshRecipes, reminderSettings]);');
  });

  it('keeps time picker rows the height getItemLayout assumes', () => {
    const picker = read('components/TimePickerModal.tsx');
    expect(picker).toContain('export const ITEM_HEIGHT = 48;');
    expect(picker).toContain('height: ITEM_HEIGHT - 4,');
    expect(picker).toMatch(/height: ITEM_HEIGHT - 4,[\s\S]*?marginVertical: 2,/);
    expect(picker).not.toContain('length: 48, offset: 48 * index');
  });
});

describe('calendar navigation', () => {
  it('moves the selected day with the month so Week shows the month being viewed', async () => {
    const { shiftMonth } = await import('../services/planning');
    expect(shiftMonth('2026-11-01', 1, '2026-11-15')).toEqual({ start: '2026-12-01', selectedDate: '2026-12-01' });
    expect(shiftMonth('2026-12-01', -1, '2026-11-15')).toEqual({ start: '2026-11-01', selectedDate: '2026-11-15' });
    expect(shiftMonth('2026-12-01', 1, '2026-11-15')).toEqual({ start: '2027-01-01', selectedDate: '2027-01-01' });
    const calendar = read('components/connected/ClassicCalendar.tsx');
    expect(calendar).toContain('setSelectedDate(next.selectedDate);');
    expect(calendar).toContain('if (mode === "week") setStart(weekRange(selectedDate).start);');
  });

  it('opens reminder deep links on the meal\'s week', () => {
    const plan = read('components/connected/PlanScreen.tsx');
    expect(plan).toMatch(/setStart\(weekRange\(m\.date\)\.start\);\s*setSelectedDate\(m\.date\);\s*setPreview\(m\);/);
  });
});

describe('servings split', () => {
  const meal = { id: 'm', recipeId: 'main', date: '2026-11-16', mealType: 'dinner', servings: 3, adults: 2, children: 2, revision: 1, kind: 'recipe', status: 'planned', sides: [{ recipeId: 'side', servings: 2 }] } as never;
  it('passes the adults/children split for mains and only servings for sides', async () => {
    const { mealEntryFor } = await import('../services/planning');
    expect(mealEntryFor(meal, 'main')).toEqual({ id: 'm', servings: 3, adults: 2, children: 2 });
    expect(mealEntryFor(meal, 'side')).toEqual({ id: 'm', servings: 2 });
    expect(read('app/cook.tsx')).toContain('mealPlanEntry={meal ? mealEntryFor(meal, id) : undefined}');
    expect(read('components/connected/ShoppingScreen.tsx')).toContain('mealEntryFor(previewMeal, preview.id)');
  });
  it('drops a split that no longer matches edited servings, and records it for new meals', async () => {
    const { withServings } = await import('../services/planning');
    expect(withServings({ servings: 3, adults: 2, children: 2 }, 3)).toEqual({ servings: 3, adults: 2, children: 2 });
    expect(withServings({ servings: 3, adults: 2, children: 2 }, 4)).toEqual({ servings: 4 });
    expect(withServings({ servings: 3 }, 5)).toEqual({ servings: 5 });
    expect(read('components/connected/PlanScreen.tsx')).toContain('adults: c.settings.defaultAdults ?? 2,');
  });
});
