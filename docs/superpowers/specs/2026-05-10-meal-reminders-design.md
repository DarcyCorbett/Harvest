# Meal Reminders — Design Spec

**Date:** 2026-05-10
**Status:** Approved, awaiting implementation plan

## Context

Cooking dinners that use frozen proteins requires the cook to remember to take the protein out hours in advance, and recipes that benefit from a long marinade need that prep started the evening before. We already deliver push notifications when a meal-plan generation or shopping list confirmation completes (via `expo-notifications` + the `BackgroundJobsContext` we added in the previous build). This spec extends that infrastructure with **scheduled** local notifications that fire on the day a meal needs defrosting, or the evening before a meal needs marinating.

The reminders fire on every household member's device, not just the device that confirmed the plan, so any cook in the household gets a heads-up regardless of who tapped Add to Calendar.

## Approach summary

1. **Detection at confirm time** — when `confirmMealPlan` runs, send the meal plan's recipes to Gemini in one batched call. Gemini returns `{ recipeId, needsDefrost, needsMarinate }` per recipe. These flags persist on the `/recipes/{id}` doc so future confirms can skip the call for already-tagged recipes.
2. **Settings stored in `HouseholdSettings`** — toggle each reminder type on/off and customise the morning + evening fire times. Defaults: defrost ON, marinate ON, morning 07:30, evening 19:30.
3. **Scheduling per device** — local `expo-notifications` are scheduled per device. A Firestore "last confirmed at" marker triggers a sync subscription so every household member's device schedules its own copy.
4. **Cancellation tracked in AsyncStorage** — scheduled notification IDs live in `AsyncStorage` (per device, since `expo-notifications` is local). Each re-confirm wipes prior IDs and reschedules.

## Components

### 1. Recipe schema additions

[services/types.ts](services/types.ts) — add two optional flags to `Recipe`:

```ts
needsDefrost?: boolean;    // has a frozen-typically protein needing defrost
needsMarinate?: boolean;   // requires ≥30 minutes refrigerated marinating
```

Undefined = "not yet tagged" (legacy recipes; tagged the next time they appear in a confirmed plan).

### 2. Settings additions

[services/types.ts](services/types.ts) — extend `HouseholdSettings`:

```ts
mealReminders?: {
  defrostEnabled: boolean;     // default true
  marinateEnabled: boolean;    // default true
  morningTime: string;         // "HH:MM" 24h, default "07:30"
  eveningTime: string;         // "HH:MM" 24h, default "19:30"
};
```

Defaults applied in code — undefined `mealReminders` is treated as the default object.

### 3. Gemini detection

New function in [services/gemini.ts](services/gemini.ts):

```ts
getGeminiReminderFlags(
  recipes: Array<{ id: string; title: string; ingredients: Ingredient[]; instructions: InstructionStep[] }>
): Promise<Array<{ recipeId: string; needsDefrost: boolean; needsMarinate: boolean }>>
```

The prompt embeds strict criteria so Gemini doesn't over-flag:

- **needsDefrost = TRUE** only if the recipe's main protein is one typically bought frozen (chicken breast, ground meat, beef cuts, large fish fillets, prawns/shrimp). Fresh/same-day items (deli ham, eggs, cured bacon, smoked salmon) → FALSE.
- **needsMarinate = TRUE** only if instructions call for ≥30 minutes of refrigerated marinating. "Quick 15-min marinade" or "rest at room temperature" → FALSE.

To save tokens, only the first ~3 instruction steps are sent (the marinating instruction is almost always near the top).

### 4. Confirm-flow integration

In [services/generatorService.ts](services/generatorService.ts) `confirmMealPlan`:

1. (existing) Save meal plan entries.
2. (existing) Aggregate shopping list.
3. (existing) Add to cookbook.
4. **NEW:** Filter recipes whose `needsDefrost` and `needsMarinate` are both already defined (cached); call `getGeminiReminderFlags` only on the rest.
5. **NEW:** For each newly-tagged recipe, call `updateRecipeFlags(recipeId, flags)` to persist on Firestore.
6. **NEW:** Bump `households/{id}/state/mealReminders.lastConfirmedAt` via `serverTimestamp()`.
7. **NEW:** On the device that confirmed, call `scheduleMealReminders(meals, settings)` immediately (don't wait for the snapshot to fire on the same device).

A new function in [services/firestoreService.ts](services/firestoreService.ts):

```ts
updateRecipeFlags(recipeId: string, flags: { needsDefrost?: boolean; needsMarinate?: boolean }): Promise<void>
subscribeMealReminderState(householdId, cb: (lastConfirmedAt: Date) => void): () => void
bumpMealReminderState(householdId): Promise<void>
getUpcomingMealPlan(householdId): Promise<{ meals: MealPlanEntry[]; recipes: Map<string, Recipe> }>
```

### 5. Device-side scheduling module

New file `services/mealReminders.ts`:

```ts
scheduleMealReminders(meals, settings): Promise<string[]>
clearMealReminders(): Promise<void>
getStoredReminderIds(): Promise<string[]>
```

**Storage:** AsyncStorage keys are scoped by household to avoid cross-household leakage when a user switches:
- `mealReminderIds:{householdId}` → `string[]` — currently-scheduled notification IDs
- `mealReminderLastScheduledAt:{householdId}` → ISO string — the `lastConfirmedAt` value this device has already scheduled for

Add `@react-native-async-storage/async-storage` to dependencies if not already transitively present.

**Scheduling rules:**
- For each meal, look up the recipe's flags.
- If `needsDefrost && settings.defrostEnabled`: target = meal.date at `settings.morningTime`. Skip if target ≤ now.
- If `needsMarinate && settings.marinateEnabled`: target = (meal.date − 1 day) at `settings.eveningTime`. Skip if target ≤ now.
- Group meals on the same (date, reminderType) into one notification (see Notification copy below).
- Call `Notifications.scheduleNotificationAsync({ content, trigger: { type: 'date', date: target } })` and collect the returned ID.
- Write the new ID array to AsyncStorage.

**`clearMealReminders`:** read existing IDs, call `Notifications.cancelScheduledNotificationAsync` for each, clear the storage key.

### 6. Per-device sync subscription

In [contexts/BackgroundJobsContext.tsx](contexts/BackgroundJobsContext.tsx), add a new `useEffect` alongside the rehydration effect:

```ts
useEffect(() => {
  if (!householdId) return;
  return subscribeMealReminderState(householdId, async (lastConfirmedAt) => {
    const lastScheduled = await readLastScheduledForFromAsyncStorage();
    if (lastConfirmedAt <= lastScheduled) return;  // up to date
    const { meals, recipes } = await getUpcomingMealPlan(householdId);
    const settings = await getHouseholdSettings(householdId);
    await clearMealReminders();
    await scheduleMealReminders(decorateMealsWithRecipeFlags(meals, recipes), settings);
    await writeLastScheduledForToAsyncStorage(lastConfirmedAt);
  });
}, [householdId]);
```

Idempotency: the device that confirmed writes `lastConfirmedAt` to its own AsyncStorage immediately after scheduling, so the snapshot fires for it but is a no-op.

### 7. Settings UI

New section in [components/SettingsModal.tsx](components/SettingsModal.tsx), below the existing sections:

```
─── Meal Reminders ─────────────────────
🥩 Defrost reminders            [ON ●]
   Reminds you the morning of a meal
   that uses frozen meat or fish.

🍶 Marinate reminders           [ON ●]
   Reminds you the evening before a
   meal that needs marinating.

Morning reminder time     [ 07:30 ]
Evening reminder time     [ 19:30 ]
────────────────────────────────────────
```

Time picker pattern matches existing implementation (check the codebase for the existing pattern — `@react-native-community/datetimepicker` if present, otherwise a small wheel modal). Toggles re-use existing toggle styling.

Settings changes only take effect on the *next* confirm — already-scheduled notifications keep their original fire times.

### 8. Notification copy

| Reminder | Title | Body (single meal) | Body (grouped) |
|---|---|---|---|
| Defrost | "Defrost reminder" | "{recipe.title} is on tonight's menu — take the protein out of the freezer" | "Defrost needed for today's meals: {title 1}, {title 2}" |
| Marinate | "Start marinating tonight" | "{recipe.title} is on tomorrow's menu — time to start marinating" | "Start marinating for tomorrow: {title 1}, {title 2}" |

Both carry `data: { navigateTo: 'cookbook', recipeIds: [...] }`. Existing `useNotifications` tap handler gets a third branch for `cookbook`.

## Edge cases

- **Gemini call fails:** the recipes stay `needsDefrost === undefined`. Scheduler skips them silently. Next confirm retries.
- **Settings disabled:** scheduler skips that reminder type entirely; AsyncStorage IDs only contain enabled types.
- **Plan confirmed mid-day:** skip-past-time logic ensures we don't schedule for already-past slots.
- **Second confirm:** prior IDs wiped, new IDs scheduled — no double-fire.
- **Member B never opens the app between confirm and the reminder date:** that member doesn't get reminded for that meal. Accepted limitation in v1.
- **Household switch:** the `lastScheduledFor` AsyncStorage key is keyed by householdId (e.g. `mealReminderIds:{householdId}`) so switching households doesn't leak reminders between them.

## Out of scope (future)

- Cloud Function + Expo Push for server-side push to all members regardless of app-open state.
- Tagging `needsDefrost` / `needsMarinate` at scrape time (so legacy recipes don't need a re-tag pass on confirm).
- Per-user (rather than per-household) reminder preferences.
- Smart "earlier" defrost reminders for larger cuts (e.g. roast joints need 24 h, not 12 h).

## Verification

1. Confirm a meal plan containing a chicken recipe. Wait briefly for Gemini. Inspect Firestore: the recipe doc has `needsDefrost: true`.
2. Inspect AsyncStorage `mealReminderIds` — one ID per scheduled reminder.
3. Use `Notifications.getAllScheduledNotificationsAsync()` (via a dev-mode debug button or temporary console log) to confirm trigger dates align with the meal-plan dates + configured times.
4. Set morning time to "T + 2 min", re-confirm, wait — defrost notification fires.
5. Multi-device: confirm on device A, observe reminder appears on device B after its snapshot fires.
6. Toggle defrost OFF, re-confirm — no defrost notifications scheduled.
7. Confirm a plan whose morning slot is already past — no notification scheduled for that slot.
8. Re-confirm a second plan — `getAllScheduledNotificationsAsync().length` matches the new plan, no double-up.

## Critical files

- [services/types.ts](services/types.ts) — schema additions
- [services/gemini.ts](services/gemini.ts) — `getGeminiReminderFlags`
- [services/firestoreService.ts](services/firestoreService.ts) — `updateRecipeFlags`, `subscribeMealReminderState`, `bumpMealReminderState`, `getUpcomingMealPlan`
- [services/generatorService.ts](services/generatorService.ts) — wire Gemini call + scheduling into `confirmMealPlan`
- [services/mealReminders.ts](services/mealReminders.ts) — new file, device-side scheduling
- [contexts/BackgroundJobsContext.tsx](contexts/BackgroundJobsContext.tsx) — sync subscription
- [components/SettingsModal.tsx](components/SettingsModal.tsx) — UI section
- [hooks/useNotifications.ts](hooks/useNotifications.ts) — add `cookbook` tap branch
