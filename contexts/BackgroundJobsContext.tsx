// ============================================================
// BackgroundJobsContext
//
// Holds long-running async work (meal-plan generation, "Add to
// Calendar" confirmation) so the UI can fire the work and immediately
// return the user to a usable screen. Destination screens read job
// state to render in-progress placeholders or completed results.
//
// On completion, JobToast (mounted at the root) slides in and offers
// a tap-to-navigate shortcut to the relevant tab.
// ============================================================

import {
  confirmMealPlan,
  generateMealPlan,
  type GenerateConfig,
  type GeneratedMeal,
} from '@/services/generatorService';
import {
  clearGenerationResult,
  getHouseholdSettings,
  getUpcomingMealPlan,
  loadGenerationResult,
  saveGenerationResult,
  subscribeMealReminderState,
} from '@/services/firestoreService';
import { useAuth } from '@/contexts/AuthContext';
import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { clearMealReminders, scheduleMealReminders } from '@/services/mealReminders';
import { STORAGE_KEY_LAST_SCHEDULED_AT } from '@/services/mealRemindersConstants';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';

type GenerationProgress = { msg: string; current: number; total: number };

export type GenerationJob =
  | { status: 'idle' }
  | { status: 'running'; config: GenerateConfig; progress: GenerationProgress }
  | { status: 'done'; meals: GeneratedMeal[]; config: GenerateConfig; acknowledged: boolean }
  | { status: 'error'; error: string; config: GenerateConfig; acknowledged: boolean };

export type ConfirmJob =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'done'; acknowledged: boolean }
  | { status: 'error'; error: string; acknowledged: boolean };

interface ConfirmStartArgs {
  meals: GeneratedMeal[];
  householdId: string;
  mode: 'add' | 'replace';
  adults: number;
  children: number;
}

interface BackgroundJobsContextValue {
  generation: GenerationJob;
  confirm: ConfirmJob;

  /** Begin a meal-plan generation. No-op if one is already running. */
  startGeneration: (config: GenerateConfig, householdId: string) => boolean;
  /** Replace the meals of a 'done' generation (e.g. after the user edits tags
   *  on a recipe in the results screen, or after a regenerate). Accepts a
   *  value or an updater function (React-style). */
  setGenerationMeals: (next: GeneratedMeal[] | ((prev: GeneratedMeal[]) => GeneratedMeal[])) => void;
  /** Reset generation back to idle. Called from the results screen after the
   *  user has consumed the result (e.g. tapped "Add to Calendar" or "Back"). */
  clearGeneration: () => void;
  /** Hide the toast for a finished generation but keep the meals around so
   *  the Generate screen still renders the results phase on next visit. */
  acknowledgeGeneration: () => void;

  /** Begin an Add-to-Calendar confirmation. No-op if one is already running. */
  startConfirm: (args: ConfirmStartArgs) => boolean;
  acknowledgeConfirm: () => void;
  clearConfirm: () => void;
}

const BackgroundJobsContext = createContext<BackgroundJobsContextValue | null>(null);

export function useBackgroundJobs(): BackgroundJobsContextValue {
  const ctx = useContext(BackgroundJobsContext);
  if (!ctx) throw new Error('useBackgroundJobs must be used within BackgroundJobsProvider');
  return ctx;
}

export function BackgroundJobsProvider({ children }: { children: React.ReactNode }) {
  const { householdId } = useAuth();
  const [generation, setGeneration] = useState<GenerationJob>({ status: 'idle' });
  const [confirm, setConfirm] = useState<ConfirmJob>({ status: 'idle' });

  // Latest generation epoch — protects against stale completion handlers
  // overwriting a newer job (e.g. user starts gen 1, dismisses, starts gen 2).
  const generationEpoch = useRef(0);
  const confirmEpoch = useRef(0);

  // ── Rehydrate persisted generation result on startup ──
  const hasRehydrated = useRef(false);
  useEffect(() => {
    if (!householdId || hasRehydrated.current) return;
    hasRehydrated.current = true;
    loadGenerationResult(householdId)
      .then((result) => {
        if (!result) return;
        setGeneration((prev) =>
          prev.status !== 'idle'
            ? prev
            : { status: 'done', meals: result.meals, config: result.config, acknowledged: false },
        );
      })
      .catch(console.warn);
  }, [householdId]);

  // Per-device meal reminder sync. When ANY household member confirms a plan,
  // this device sees the bumped `lastConfirmedAt` and reschedules its own copy.
  useEffect(() => {
    if (!householdId) return;
    return subscribeMealReminderState(householdId, async (lastConfirmedAt) => {
      if (!lastConfirmedAt) return;
      try {
        const cachedStr = await AsyncStorage.getItem(STORAGE_KEY_LAST_SCHEDULED_AT(householdId));
        const cached = cachedStr ? new Date(cachedStr) : null;
        // Tolerance window: the confirming device writes `lastScheduledAt` from its
        // client clock, but the snapshot fires with a Firestore serverTimestamp().
        // Clock skew between client and server is bounded in practice — treat any
        // pair within 60 s as "already in sync" to avoid a redundant re-schedule.
        if (cached && Math.abs(cached.getTime() - lastConfirmedAt.getTime()) < 60_000) return;
        if (cached && cached >= lastConfirmedAt) return;

        const [{ meals, recipes }, settings] = await Promise.all([
          getUpcomingMealPlan(householdId),
          getHouseholdSettings(householdId),
        ]);
        await clearMealReminders(householdId);
        await scheduleMealReminders(householdId, meals, recipes, settings);
        await AsyncStorage.setItem(
          STORAGE_KEY_LAST_SCHEDULED_AT(householdId),
          lastConfirmedAt.toISOString(),
        );
      } catch (err) {
        console.warn('[ReminderSync] failed:', err);
      }
    });
  }, [householdId]);

  const startGeneration = useCallback(
    (config: GenerateConfig, householdId: string): boolean => {
      if (generation.status === 'running') return false;
      const epoch = ++generationEpoch.current;
      setGeneration({
        status: 'running',
        config,
        progress: { msg: 'Searching for the perfect recipes…', current: 0, total: config.numberOfDays * config.mealTypes.length },
      });

      generateMealPlan(config, householdId, (msg, current, total) => {
        if (generationEpoch.current !== epoch) return;
        setGeneration((prev) =>
          prev.status === 'running' ? { ...prev, progress: { msg, current, total } } : prev,
        );
      })
        .then((meals) => {
          if (generationEpoch.current !== epoch) return;
          setGeneration({ status: 'done', meals, config, acknowledged: false });
          if (householdId) saveGenerationResult(householdId, meals, config).catch(console.warn);
          if (AppState.currentState !== 'active') {
            Notifications.scheduleNotificationAsync({
              content: {
                title: 'Recipes ready',
                body: `Your ${meals.length}-meal plan is ready to review`,
                data: { navigateTo: 'generate' },
              },
              trigger: null,
            }).catch(console.warn);
          }
        })
        .catch((err: unknown) => {
          if (generationEpoch.current !== epoch) return;
          const msg = err instanceof Error ? err.message : 'Something went wrong. Please try again.';
          setGeneration({ status: 'error', error: msg, config, acknowledged: false });
        });

      return true;
    },
    [generation.status],
  );

  const setGenerationMeals = useCallback(
    (next: GeneratedMeal[] | ((prev: GeneratedMeal[]) => GeneratedMeal[])) => {
      setGeneration((prev) => {
        if (prev.status !== 'done') return prev;
        const meals = typeof next === 'function' ? next(prev.meals) : next;
        return { ...prev, meals };
      });
    },
    [],
  );

  const clearGeneration = useCallback(() => {
    generationEpoch.current++;
    setGeneration({ status: 'idle' });
    if (householdId) clearGenerationResult(householdId).catch(console.warn);
  }, [householdId]);

  const acknowledgeGeneration = useCallback(() => {
    setGeneration((prev) =>
      prev.status === 'done' || prev.status === 'error' ? { ...prev, acknowledged: true } : prev,
    );
  }, []);

  const startConfirm = useCallback(
    (args: ConfirmStartArgs): boolean => {
      if (confirm.status === 'running') return false;
      const epoch = ++confirmEpoch.current;
      setConfirm({ status: 'running' });

      confirmMealPlan(args.meals, args.householdId, args.mode, {
        adults: args.adults,
        children: args.children,
      })
        .then(() => {
          if (confirmEpoch.current !== epoch) return;
          setConfirm({ status: 'done', acknowledged: false });
          // Schedule meal reminders on the confirming device immediately. Other
          // household devices will pick this up via the subscribeMealReminderState
          // listener below.
          if (householdId) {
            (async () => {
              try {
                const settings = await getHouseholdSettings(householdId);
                const recipesMap = new Map(args.meals.map((m) => [m.recipeId, m.recipe]));
                const mealEntries = args.meals.map((m) => ({
                  recipeId: m.recipeId,
                  date: m.date,
                  mealType: m.mealType,
                  servings: m.servings,
                }));
                await clearMealReminders(householdId);
                await scheduleMealReminders(householdId, mealEntries, recipesMap, settings);
                await AsyncStorage.setItem(
                  STORAGE_KEY_LAST_SCHEDULED_AT(householdId),
                  new Date().toISOString(),
                );
              } catch (err) {
                console.warn('[Confirm] meal reminder scheduling failed:', err);
              }
            })();
          }
          if (AppState.currentState !== 'active') {
            Notifications.scheduleNotificationAsync({
              content: {
                title: 'Shopping list ready',
                body: 'Your ingredients have been added to the shopping list',
                data: { navigateTo: 'shopping' },
              },
              trigger: null,
            }).catch(console.warn);
          }
        })
        .catch((err: unknown) => {
          if (confirmEpoch.current !== epoch) return;
          const msg = err instanceof Error ? err.message : 'Please try again.';
          setConfirm({ status: 'error', error: msg, acknowledged: false });
        });

      return true;
    },
    [confirm.status, householdId],
  );

  const acknowledgeConfirm = useCallback(() => {
    setConfirm((prev) =>
      prev.status === 'done' || prev.status === 'error' ? { ...prev, acknowledged: true } : prev,
    );
  }, []);

  const clearConfirm = useCallback(() => {
    confirmEpoch.current++;
    setConfirm({ status: 'idle' });
  }, []);

  const value = useMemo<BackgroundJobsContextValue>(
    () => ({
      generation,
      confirm,
      startGeneration,
      setGenerationMeals,
      clearGeneration,
      acknowledgeGeneration,
      startConfirm,
      acknowledgeConfirm,
      clearConfirm,
    }),
    [generation, confirm, startGeneration, setGenerationMeals, clearGeneration, acknowledgeGeneration, startConfirm, acknowledgeConfirm, clearConfirm],
  );

  return <BackgroundJobsContext.Provider value={value}>{children}</BackgroundJobsContext.Provider>;
}
