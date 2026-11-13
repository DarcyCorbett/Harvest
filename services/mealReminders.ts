import { notifications as Notifications } from '@/services/notifications';
import type * as NotificationTypes from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { HouseholdSettings, MealPlanEntry, Recipe } from './types';
import {
  DEFAULT_MEAL_REMINDERS,
  STORAGE_KEY_REMINDER_IDS,
} from './mealRemindersConstants';

type ReminderType = 'defrost' | 'marinate';

interface ReminderSlot {
  type: ReminderType;
  triggerDate: Date;
  recipeIds: string[];
  recipeTitles: string[];
  mealIds: string[];
}
/** Parse "HH:MM" into { hour, minute }. Returns null if malformed. */
function parseHHMM(s: string): { hour: number; minute: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

/** Build a local Date at the given date (YYYY-MM-DD) and HH:MM. */
function buildLocalDate(dateISO: string, time: { hour: number; minute: number }): Date {
  const [y, mo, d] = dateISO.split('-').map(Number);
  return new Date(y, mo - 1, d, time.hour, time.minute, 0, 0);
}

/** Add `days` to a YYYY-MM-DD date string; returns YYYY-MM-DD. */
function addDays(dateISO: string, days: number): string {
  const [y, mo, d] = dateISO.split('-').map(Number);
  const dt = new Date(y, mo - 1, d);
  dt.setDate(dt.getDate() + days);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

/** Cancel all stored reminders for this household and clear the storage key. */
export async function clearMealReminders(householdId: string): Promise<void> {
  if (!Notifications) return;
  const key = STORAGE_KEY_REMINDER_IDS(householdId);
  const raw = await AsyncStorage.getItem(key);
  const ids: string[] = raw ? (JSON.parse(raw) as string[]) : [];
  await Promise.all(
    ids.map((id) => Notifications?.cancelScheduledNotificationAsync(id).catch(() => {})),
  );
  await AsyncStorage.removeItem(key);
}

/** Schedule local notifications for upcoming meals; returns the new IDs. */
export async function scheduleMealReminders(
  householdId: string,
  meals: MealPlanEntry[],
  recipes: Map<string, Recipe>,
  settings: HouseholdSettings,
): Promise<string[]> {
  if (!Notifications) return [];
  const reminders = settings.mealReminders ?? DEFAULT_MEAL_REMINDERS;
  const morning = parseHHMM(reminders.morningTime) ?? parseHHMM(DEFAULT_MEAL_REMINDERS.morningTime)!;
  const evening = parseHHMM(reminders.eveningTime) ?? parseHHMM(DEFAULT_MEAL_REMINDERS.eveningTime)!;
  // 1s buffer — expo-notifications rejects triggers that are not strictly in the future.
  const cutoff = Date.now() + 1000;

  const slotsByKey = new Map<string, ReminderSlot>();

  for (const meal of meals) {
    const recipe = recipes.get(meal.recipeId);
    if (!recipe) continue;

    if (recipe.needsDefrost && reminders.defrostEnabled) {
      const triggerDate = buildLocalDate(meal.date, morning);
      if (triggerDate.getTime() > cutoff) {
        const key = `${meal.date}|defrost`;
        const slot = slotsByKey.get(key) ?? {
          type: 'defrost' as ReminderType,
          triggerDate,
          recipeIds: [],
          recipeTitles: [],
          mealIds: [],
        };
        slot.recipeIds.push(meal.recipeId);
        slot.mealIds.push(meal.id ?? `${meal.date}_${meal.mealType}`);
        slot.recipeTitles.push(recipe.title);
        slotsByKey.set(key, slot);
      }
    }

    if (recipe.needsMarinate && reminders.marinateEnabled) {
      const eveningDateISO = addDays(meal.date, -1);
      const triggerDate = buildLocalDate(eveningDateISO, evening);
      if (triggerDate.getTime() > cutoff) {
        const key = `${eveningDateISO}|marinate`;
        const slot = slotsByKey.get(key) ?? {
          type: 'marinate' as ReminderType,
          triggerDate,
          recipeIds: [],
          recipeTitles: [],
          mealIds: [],
        };
        slot.recipeIds.push(meal.recipeId);
        slot.mealIds.push(meal.id ?? `${meal.date}_${meal.mealType}`);
        slot.recipeTitles.push(recipe.title);
        slotsByKey.set(key, slot);
      }
    }
  }

  const newIds: string[] = [];
  for (const slot of slotsByKey.values()) {
    const single = slot.recipeTitles.length === 1;
    const titleList = slot.recipeTitles.join(', ');
    const content: NotificationTypes.NotificationContentInput =
      slot.type === 'defrost'
        ? {
            title: 'Defrost reminder',
            body: single
              ? `${slot.recipeTitles[0]} is on today's menu — take the protein out of the freezer`
              : `Defrost needed for today's meals: ${titleList}`,
            data: { navigateTo: 'plan', householdId, mealId: slot.mealIds[0], recipeIds: slot.recipeIds },
          }
        : {
            title: 'Start marinating tonight',
            body: single
              ? `${slot.recipeTitles[0]} is on tomorrow's menu — time to start marinating`
              : `Start marinating for tomorrow: ${titleList}`,
            data: { navigateTo: 'plan', householdId, mealId: slot.mealIds[0], recipeIds: slot.recipeIds },
          };

    const id = await Notifications.scheduleNotificationAsync({
      content,
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: slot.triggerDate },
    });
    newIds.push(id);
  }

  await AsyncStorage.setItem(STORAGE_KEY_REMINDER_IDS(householdId), JSON.stringify(newIds));
  return newIds;
}
