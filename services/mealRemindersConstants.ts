import type { HouseholdSettings } from './types';

export const DEFAULT_MEAL_REMINDERS: NonNullable<HouseholdSettings['mealReminders']> = {
  defrostEnabled: true,
  marinateEnabled: true,
  morningTime: '07:30',
  eveningTime: '19:30',
};

/** AsyncStorage key prefixes — scoped by householdId so multi-household users don't leak. */
export const STORAGE_KEY_REMINDER_IDS = (householdId: string) => `mealReminderIds:${householdId}`;
export const STORAGE_KEY_LAST_SCHEDULED_AT = (householdId: string) => `mealReminderLastScheduledAt:${householdId}`;
