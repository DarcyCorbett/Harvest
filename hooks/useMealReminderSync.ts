import { useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { useAuth } from '@/contexts/AuthContext';
import { useConnected } from '@/contexts/ConnectedContext';
import {
  getHouseholdSettings,
  getUpcomingMealPlan,
  subscribeMealReminderState,
  updateRecipeFlags,
} from '@/services/firestoreService';
import { getGeminiReminderFlags } from '@/services/gemini';
import { clearMealReminders, scheduleMealReminders } from '@/services/mealReminders';
import { STORAGE_KEY_LAST_SCHEDULED_AT } from '@/services/mealRemindersConstants';
import { ensureReminderFlags } from '@/services/reminderFlags';
import { logEvent } from '@/services/devLog';

/**
 * Keeps this device's defrost and marinate reminders in step with the
 * household plan. When any member changes the plan, the server bumps
 * `lastConfirmedAt`; each device sees that and reschedules its own copy.
 * Leaving the household (sign-out or switch) cancels its reminders here.
 */
export function useMealReminderSync(): void {
  const { householdId } = useAuth();
  const { refreshRecipes } = useConnected();

  useEffect(() => {
    if (!householdId) return;
    let active = true;
    let initialSync = true;
    let queue = Promise.resolve();
    const unsubscribe = subscribeMealReminderState(householdId, (lastConfirmedAt) => {
      queue = queue.then(async () => {
        if (!active) return;
        try {
          const cachedStr = await AsyncStorage.getItem(STORAGE_KEY_LAST_SCHEDULED_AT(householdId));
          const cached = cachedStr ? new Date(cachedStr) : null;
          // Always reconcile once on launch, including plans previously synced
          // without flags. Failed classification must remain retryable.
          if (!initialSync && lastConfirmedAt && cached && cached >= lastConfirmedAt) return;

          const [{ meals, recipes }, settings] = await Promise.all([
            getUpcomingMealPlan(householdId),
            getHouseholdSettings(householdId),
          ]);
          if (!active) return;
          refreshRecipes(recipes);
          await ensureReminderFlags(
            recipes,
            (missing) => getGeminiReminderFlags(householdId, missing),
            (id, flags) => updateRecipeFlags(householdId, id, flags),
          );
          if (!active) return;
          refreshRecipes(recipes);
          await clearMealReminders(householdId);
          if (!active) return;
          await scheduleMealReminders(householdId, meals, recipes, settings);
          await AsyncStorage.setItem(
            STORAGE_KEY_LAST_SCHEDULED_AT(householdId),
            (lastConfirmedAt ?? new Date()).toISOString(),
          );
          initialSync = false;
        } catch (err) {
          logEvent('warn', 'ReminderSync', 'failed:', err);
        }
      });
    });
    return () => {
      active = false;
      unsubscribe();
      // After any in-flight sync settles, remove this household's reminders.
      queue = queue
        .then(() => clearMealReminders(householdId))
        .catch((err) => logEvent('warn', 'ReminderSync', 'clear failed:', err));
    };
  }, [householdId, refreshRecipes]);
}
