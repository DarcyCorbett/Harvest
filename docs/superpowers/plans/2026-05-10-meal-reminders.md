# Meal Reminders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add scheduled local push notifications that remind every household member to defrost frozen proteins (morning-of) and to start marinating (evening-before), based on the confirmed meal plan, with Gemini-detected recipe flags.

**Architecture:** Detection runs inside `confirmMealPlan` via a new batched Gemini call; flags persist on `/recipes/{id}` so future confirms skip already-tagged recipes. A Firestore "lastConfirmedAt" marker triggers a per-device sync that schedules local `expo-notifications` using AsyncStorage-tracked IDs, so each household member's device schedules its own copy.

**Tech Stack:** React Native / Expo SDK, TypeScript, Firebase Firestore, `expo-notifications`, `@react-native-async-storage/async-storage` (already installed), Gemini API (existing wrapper).

**Spec:** [docs/superpowers/specs/2026-05-10-meal-reminders-design.md](docs/superpowers/specs/2026-05-10-meal-reminders-design.md)

**Project conventions:**
- No automated test framework in this project. Each task's `Verify` step is `npx tsc --noEmit` plus manual checks called out in the task.
- TodoWrite/commit cadence is one commit per task.

---

### Task 1: Schema additions — Recipe flags + HouseholdSettings.mealReminders

**Goal:** Extend the `Recipe` and `HouseholdSettings` interfaces with the new fields, plus a default-values constant for reminder settings.

**Files:**
- Modify: `services/types.ts` (add fields)
- Create: `services/mealRemindersConstants.ts` (defaults)

**Acceptance Criteria:**
- [ ] `Recipe` has `needsDefrost?: boolean` and `needsMarinate?: boolean`
- [ ] `HouseholdSettings` has `mealReminders?: { defrostEnabled, marinateEnabled, morningTime, eveningTime }`
- [ ] A `DEFAULT_MEAL_REMINDERS` constant exists exporting `{ defrostEnabled: true, marinateEnabled: true, morningTime: '07:30', eveningTime: '19:30' }`
- [ ] `tsc --noEmit` passes with no new errors

**Verify:** `npx tsc --noEmit` → no output

**Steps:**

- [ ] **Step 1: Add Recipe fields**

In `services/types.ts`, add to the `Recipe` interface (after `nutrition: Nutrition;`):

```ts
  /** True if recipe's main protein typically needs defrosting (Gemini-detected at confirm time). */
  needsDefrost?: boolean;
  /** True if recipe requires ≥30 min refrigerated marinating (Gemini-detected at confirm time). */
  needsMarinate?: boolean;
```

- [ ] **Step 2: Add HouseholdSettings field**

In `services/types.ts`, add to the `HouseholdSettings` interface (after `kidFriendly?: KidFriendlySettings;`):

```ts
  /** Per-household reminder preferences for defrost / marinate notifications. */
  mealReminders?: {
    defrostEnabled: boolean;
    marinateEnabled: boolean;
    /** "HH:MM" 24-hour, e.g. "07:30" */
    morningTime: string;
    /** "HH:MM" 24-hour, e.g. "19:30" */
    eveningTime: string;
  };
```

- [ ] **Step 3: Create constants file**

Create `services/mealRemindersConstants.ts`:

```ts
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

/** Firestore subcollection paths */
export const REMINDER_STATE_DOC = 'mealReminders';
export const REMINDER_STATE_COLLECTION = 'state';
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no output (no errors).

- [ ] **Step 5: Commit**

```bash
git add services/types.ts services/mealRemindersConstants.ts
git commit -m "Add meal-reminder schema fields and default constants"
```

---

### Task 2: Gemini detection — `getGeminiReminderFlags`

**Goal:** Add a new batched Gemini call that classifies each recipe with `needsDefrost` and `needsMarinate`.

**Files:**
- Modify: `services/gemini.ts` (add function at end of file)

**Acceptance Criteria:**
- [ ] Function signature: `getGeminiReminderFlags(recipes: { recipeId: string; recipe: Recipe }[]): Promise<Map<string, { needsDefrost: boolean; needsMarinate: boolean }>>`
- [ ] Returns empty map on error / missing API key (does NOT throw)
- [ ] Sends only `title`, `ingredients[].name`, and first 3 instruction step texts (token-saving)
- [ ] Prompt embeds strict criteria from the spec
- [ ] Uses the existing `callGemini` helper (same pattern as `tagRecipesWithGemini`)
- [ ] `tsc --noEmit` passes

**Verify:** `npx tsc --noEmit` → no output

**Steps:**

- [ ] **Step 1: Add the function at end of `services/gemini.ts`**

```ts
/**
 * Ask Gemini to flag each recipe with whether it needs a defrost reminder (frozen
 * protein-heavy) and/or a marinate reminder (≥30 min refrigerated marinade).
 *
 * Returns a Map keyed by recipeId. Missing entries = "Gemini didn't return a result";
 * the caller should leave the recipe's flags unchanged.
 */
export async function getGeminiReminderFlags(
  recipes: { recipeId: string; recipe: Recipe }[],
): Promise<Map<string, { needsDefrost: boolean; needsMarinate: boolean }>> {
  if (recipes.length === 0 || !GEMINI_API_KEY) return new Map();

  const input = recipes.map(({ recipeId, recipe }) => ({
    id: recipeId,
    title: recipe.title,
    ingredients: recipe.ingredients.map((i) => i.name),
    steps: recipe.instructions.slice(0, 3).map((s) => s.text.substring(0, 200)).join(' | '),
  }));

  const prompt = `You classify recipes for kitchen-prep reminders. Return JSON: { "results": [{ "id": string, "needsDefrost": boolean, "needsMarinate": boolean }] }.

For each recipe:

"needsDefrost" = TRUE only if the recipe's main protein is one typically bought frozen and needing several hours to defrost:
- INCLUDE: chicken breast/thigh/whole, ground/minced meat (beef/pork/lamb/turkey/chicken), beef cuts (steak, mince, stewing), pork chops, lamb cuts, large fish fillets (salmon, cod, snapper), prawns/shrimp.
- EXCLUDE (set FALSE): deli ham, sliced cured meats, bacon strips (small/thin defrost fast), smoked salmon, canned tuna/fish, eggs, tofu, paneer, halloumi, vegetarian/vegan dishes.

"needsMarinate" = TRUE only if the instructions clearly call for ≥30 minutes of REFRIGERATED marinating BEFORE cooking (the protein/veg sits in a marinade in the fridge).
- INCLUDE: "marinate for 30 minutes / overnight / 2 hours in the fridge", "let sit refrigerated in the marinade".
- EXCLUDE (set FALSE): quick 5–15 min marinades, "marinate while you prep" with no duration, "rest at room temperature", "tenderise" with no liquid, dry-rubs that don't sit in the fridge.

Rules:
- When uncertain, choose FALSE. False negatives are better than false positives — reminders should feel earned.
- Every input recipe must appear exactly once in "results", preserving its input "id".
- Return only the JSON object — no markdown, no explanation.

Recipes:
${JSON.stringify(input)}`;

  // ~30 tokens per recipe (id + 2 booleans + structure). 200/recipe gives slack.
  const maxOutputTokens = Math.min(8000, 1024 + recipes.length * 200);

  try {
    const parsed = await callGemini<{ results?: unknown }>(prompt, maxOutputTokens);
    if (!parsed || !Array.isArray(parsed.results)) {
      console.warn('[ReminderFlags] Gemini response missing results array:', parsed);
      return new Map();
    }

    const out = new Map<string, { needsDefrost: boolean; needsMarinate: boolean }>();
    for (const entry of parsed.results as Record<string, unknown>[]) {
      const id = typeof entry?.id === 'string' ? entry.id : undefined;
      const needsDefrost = typeof entry?.needsDefrost === 'boolean' ? entry.needsDefrost : false;
      const needsMarinate = typeof entry?.needsMarinate === 'boolean' ? entry.needsMarinate : false;
      if (id) out.set(id, { needsDefrost, needsMarinate });
    }
    console.log(`[ReminderFlags] Gemini classified ${out.size}/${recipes.length} recipes`);
    return out;
  } catch (err) {
    console.error('[ReminderFlags] Gemini call failed:', err);
    return new Map();
  }
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add services/gemini.ts
git commit -m "Add getGeminiReminderFlags for defrost/marinate detection"
```

---

### Task 3: Firestore service — recipe flags, reminder state, upcoming meal plan

**Goal:** Add the four Firestore helpers the confirm flow and sync subscription need.

**Files:**
- Modify: `services/firestoreService.ts` (append new functions)

**Acceptance Criteria:**
- [ ] `updateRecipeFlags(recipeId, flags)` writes `needsDefrost` / `needsMarinate` to `/recipes/{id}`
- [ ] `bumpMealReminderState(householdId)` writes `lastConfirmedAt: serverTimestamp()` to `households/{id}/state/mealReminders`
- [ ] `subscribeMealReminderState(householdId, cb)` returns an unsubscribe; calls `cb(lastConfirmedAt: Date)` on each change, also on initial subscribe if the doc exists
- [ ] `getUpcomingMealPlan(householdId)` returns `{ meals: MealPlanEntry[]; recipes: Map<string, Recipe> }` for meals whose `date >= today (local)`
- [ ] All recipe `scrapedAt` Date conversions match the existing pattern at line ~159
- [ ] `tsc --noEmit` passes

**Verify:** `npx tsc --noEmit` → no output

**Steps:**

- [ ] **Step 1: Add the four functions to `services/firestoreService.ts`**

Append at the end of the file (after `getStarredRecipes`):

```ts
// ─── Meal Reminder Helpers ───────────────────────────────────

/** Persist Gemini-detected reminder flags onto the cached recipe doc. */
export async function updateRecipeFlags(
  recipeId: string,
  flags: { needsDefrost?: boolean; needsMarinate?: boolean },
): Promise<void> {
  const update: Record<string, boolean> = {};
  if (typeof flags.needsDefrost === 'boolean') update.needsDefrost = flags.needsDefrost;
  if (typeof flags.needsMarinate === 'boolean') update.needsMarinate = flags.needsMarinate;
  if (Object.keys(update).length === 0) return;
  await updateDoc(doc(db, 'recipes', recipeId), update);
}

/** Bump the "last confirmed at" marker so every household device knows to re-sync reminders. */
export async function bumpMealReminderState(householdId: string): Promise<void> {
  await setDoc(
    doc(db, 'households', householdId, 'state', 'mealReminders'),
    { lastConfirmedAt: serverTimestamp() },
  );
}

/** Listen for changes to the household's meal-reminder state. Fires `cb` with the
 *  current `lastConfirmedAt` Date on each snapshot (and immediately if the doc exists). */
export function subscribeMealReminderState(
  householdId: string,
  cb: (lastConfirmedAt: Date | null) => void,
): () => void {
  return onSnapshot(
    doc(db, 'households', householdId, 'state', 'mealReminders'),
    (snap) => {
      if (!snap.exists()) {
        cb(null);
        return;
      }
      const ts = snap.data().lastConfirmedAt as Timestamp | undefined;
      cb(ts?.toDate?.() ?? null);
    },
  );
}

/** Fetch all upcoming meal plan entries (today onward) plus their recipes,
 *  used by per-device reminder sync. */
export async function getUpcomingMealPlan(
  householdId: string,
): Promise<{ meals: MealPlanEntry[]; recipes: Map<string, Recipe> }> {
  const todayISO = new Date().toISOString().slice(0, 10);
  const mealsSnap = await getDocs(
    query(
      collection(db, 'households', householdId, 'mealPlan'),
      where('date', '>=', todayISO),
    ),
  );
  const meals: MealPlanEntry[] = mealsSnap.docs.map((d) => ({ id: d.id, ...d.data() } as MealPlanEntry));

  const recipes = new Map<string, Recipe>();
  const uniqueIds = Array.from(new Set(meals.map((m) => m.recipeId)));
  await Promise.all(
    uniqueIds.map(async (id) => {
      const r = await getRecipe(id);
      if (r) recipes.set(id, r);
    }),
  );
  return { meals, recipes };
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add services/firestoreService.ts
git commit -m "Add Firestore helpers for meal reminders (flags, state, upcoming plan)"
```

---

### Task 4: Wire Gemini call + state bump into `confirmMealPlan`

**Goal:** After the shopping list is written, run Gemini on un-tagged recipes, persist flags, and bump the household reminder state.

**Files:**
- Modify: `services/generatorService.ts` (extend `confirmMealPlan` at the end)

**Acceptance Criteria:**
- [ ] After the existing `addShoppingItems` call, the function:
  - filters meals whose recipe has both flags already cached, calls Gemini only on the rest
  - persists newly-detected flags via `updateRecipeFlags`
  - calls `bumpMealReminderState(householdId)` unconditionally (so even all-cached confirms still re-sync devices that haven't scheduled yet)
- [ ] Gemini failures don't fail the confirm — they log and continue
- [ ] `tsc --noEmit` passes

**Verify:** `npx tsc --noEmit` → no output. Manual: confirm a meal plan; check Firestore for `needsDefrost` / `needsMarinate` on the recipe docs and `households/{id}/state/mealReminders.lastConfirmedAt`.

**Steps:**

- [ ] **Step 1: Add imports at the top of `services/generatorService.ts`**

Inside the existing `import { … } from './firestoreService';` block, add:

```ts
  bumpMealReminderState,
  updateRecipeFlags,
```

Add to the existing `import { … } from './gemini';` block:

```ts
import { getGeminiReminderFlags, tagRecipesWithGemini } from './gemini';
```

- [ ] **Step 2: Add reminder detection at the end of `confirmMealPlan`**

Replace the final `await addShoppingItems(householdId, items);` line with the following (keeps it but appends the new block after):

```ts
  await addShoppingItems(householdId, items);

  // ── Meal-reminder detection ──
  // Run Gemini only on recipes that don't already have both flags cached.
  const recipesNeedingFlags = meals
    .filter(
      (m) =>
        typeof m.recipe.needsDefrost !== 'boolean' ||
        typeof m.recipe.needsMarinate !== 'boolean',
    )
    .map((m) => ({ recipeId: m.recipeId, recipe: m.recipe }));

  if (recipesNeedingFlags.length > 0) {
    try {
      const flagMap = await getGeminiReminderFlags(recipesNeedingFlags);
      await Promise.all(
        Array.from(flagMap.entries()).map(([recipeId, flags]) =>
          updateRecipeFlags(recipeId, flags),
        ),
      );
      // Mutate the in-memory meals so the caller (BackgroundJobsContext) can
      // schedule reminders without a re-fetch.
      for (const meal of meals) {
        const flags = flagMap.get(meal.recipeId);
        if (flags) {
          meal.recipe.needsDefrost = flags.needsDefrost;
          meal.recipe.needsMarinate = flags.needsMarinate;
        }
      }
    } catch (err) {
      console.warn('[Generator] Reminder-flag detection failed; skipping:', err);
    }
  }

  // Bump the state marker so every household device re-syncs reminders.
  try {
    await bumpMealReminderState(householdId);
  } catch (err) {
    console.warn('[Generator] bumpMealReminderState failed:', err);
  }
}
```

(Removes the trailing brace of the original function — keep your editor diff focused on the addition.)

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add services/generatorService.ts
git commit -m "Detect defrost/marinate flags and bump reminder state on confirm"
```

---

### Task 5: Device-side scheduling module — `services/mealReminders.ts`

**Goal:** Create the per-device module that schedules / cancels local `expo-notifications`, grouping by (date, reminderType) to avoid notification spam.

**Files:**
- Create: `services/mealReminders.ts`

**Acceptance Criteria:**
- [ ] `scheduleMealReminders(householdId, meals, recipes, settings)` returns the array of newly-scheduled notification IDs and persists them to AsyncStorage
- [ ] `clearMealReminders(householdId)` cancels all stored IDs and clears the storage key
- [ ] Reminders are grouped by `(date, reminderType)` so two meals on the same date with `needsDefrost` produce ONE notification listing both titles
- [ ] Skips any reminder whose target time is in the past
- [ ] Respects `settings.mealReminders.defrostEnabled` and `marinateEnabled`
- [ ] Notification `data` payload is `{ navigateTo: 'cookbook', recipeIds: string[] }`
- [ ] `tsc --noEmit` passes

**Verify:** `npx tsc --noEmit` → no output. Manual: after the next task wires this in, use `Notifications.getAllScheduledNotificationsAsync()` in a dev console to confirm the IDs and trigger dates.

**Steps:**

- [ ] **Step 1: Create the file**

Create `services/mealReminders.ts`:

```ts
import * as Notifications from 'expo-notifications';
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
  const key = STORAGE_KEY_REMINDER_IDS(householdId);
  const raw = await AsyncStorage.getItem(key);
  const ids: string[] = raw ? (JSON.parse(raw) as string[]) : [];
  await Promise.all(
    ids.map((id) => Notifications.cancelScheduledNotificationAsync(id).catch(() => {})),
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
  const reminders = settings.mealReminders ?? DEFAULT_MEAL_REMINDERS;
  const morning = parseHHMM(reminders.morningTime) ?? parseHHMM(DEFAULT_MEAL_REMINDERS.morningTime)!;
  const evening = parseHHMM(reminders.eveningTime) ?? parseHHMM(DEFAULT_MEAL_REMINDERS.eveningTime)!;
  const now = Date.now();

  // Group slots by (triggerISO, type) so multiple meals collapse into one notification.
  const slotsByKey = new Map<string, ReminderSlot>();

  for (const meal of meals) {
    const recipe = recipes.get(meal.recipeId);
    if (!recipe) continue;

    if (recipe.needsDefrost && reminders.defrostEnabled) {
      const triggerDate = buildLocalDate(meal.date, morning);
      if (triggerDate.getTime() > now) {
        const key = `${meal.date}|defrost`;
        const slot = slotsByKey.get(key) ?? {
          type: 'defrost' as ReminderType,
          triggerDate,
          recipeIds: [],
          recipeTitles: [],
        };
        slot.recipeIds.push(meal.recipeId);
        slot.recipeTitles.push(recipe.title);
        slotsByKey.set(key, slot);
      }
    }

    if (recipe.needsMarinate && reminders.marinateEnabled) {
      const eveningDateISO = addDays(meal.date, -1);
      const triggerDate = buildLocalDate(eveningDateISO, evening);
      if (triggerDate.getTime() > now) {
        const key = `${eveningDateISO}|marinate`;
        const slot = slotsByKey.get(key) ?? {
          type: 'marinate' as ReminderType,
          triggerDate,
          recipeIds: [],
          recipeTitles: [],
        };
        slot.recipeIds.push(meal.recipeId);
        slot.recipeTitles.push(recipe.title);
        slotsByKey.set(key, slot);
      }
    }
  }

  const newIds: string[] = [];
  for (const slot of slotsByKey.values()) {
    const single = slot.recipeTitles.length === 1;
    const titleList = slot.recipeTitles.join(', ');
    const content: Notifications.NotificationContentInput =
      slot.type === 'defrost'
        ? {
            title: 'Defrost reminder',
            body: single
              ? `${slot.recipeTitles[0]} is on today's menu — take the protein out of the freezer`
              : `Defrost needed for today's meals: ${titleList}`,
            data: { navigateTo: 'cookbook', recipeIds: slot.recipeIds },
          }
        : {
            title: 'Start marinating tonight',
            body: single
              ? `${slot.recipeTitles[0]} is on tomorrow's menu — time to start marinating`
              : `Start marinating for tomorrow: ${titleList}`,
            data: { navigateTo: 'cookbook', recipeIds: slot.recipeIds },
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
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no output.

If the `SchedulableTriggerInputTypes` import errors out (some versions use a different name), use `trigger: { date: slot.triggerDate } as any` as a fallback while you check the installed SDK's actual export. Inspect `node_modules/expo-notifications/build/Notifications.types.d.ts` to confirm the correct trigger shape — the API was tightened in recent SDK versions.

- [ ] **Step 3: Commit**

```bash
git add services/mealReminders.ts
git commit -m "Add device-side meal reminder scheduling module"
```

---

### Task 6: BackgroundJobsContext — wire scheduling + per-device sync

**Goal:** On the device that confirmed, schedule reminders immediately. On every device, subscribe to `lastConfirmedAt` and re-sync when it changes.

**Files:**
- Modify: `contexts/BackgroundJobsContext.tsx`

**Acceptance Criteria:**
- [ ] `startConfirm` `.then()` handler reads household settings, schedules reminders, writes `lastConfirmedAt` to AsyncStorage
- [ ] A new `useEffect` subscribes to `subscribeMealReminderState`; when the snapshot's `lastConfirmedAt` is newer than the device's AsyncStorage cached value, it fetches the upcoming plan, clears existing reminders, schedules fresh ones, and updates the cached value
- [ ] The confirming device's subscription fires after its own bump but is a no-op because it already wrote the cached value
- [ ] Failures are logged with `console.warn`, never rethrown
- [ ] `tsc --noEmit` passes

**Verify:** `npx tsc --noEmit` → no output. Manual: confirm a meal plan on device A; on device B (logged into the same household) wait for the snapshot, then inspect AsyncStorage `mealReminderIds:{householdId}` and the OS notification schedule.

**Steps:**

- [ ] **Step 1: Add imports to `contexts/BackgroundJobsContext.tsx`**

Update the existing imports near the top of the file:

```ts
import {
  clearGenerationResult,
  getHouseholdSettings,
  getUpcomingMealPlan,
  loadGenerationResult,
  saveGenerationResult,
  subscribeMealReminderState,
} from '@/services/firestoreService';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { clearMealReminders, scheduleMealReminders } from '@/services/mealReminders';
import { STORAGE_KEY_LAST_SCHEDULED_AT } from '@/services/mealRemindersConstants';
```

- [ ] **Step 2: After confirm, schedule reminders on the confirming device**

In `startConfirm`'s `.then()` handler, BEFORE the existing notification dispatch, add:

```ts
          // Schedule reminders for the confirming device immediately, so the user
          // doesn't have to wait for the snapshot round-trip.
          if (householdId) {
            (async () => {
              try {
                const settings = await getHouseholdSettings(householdId);
                const recipes = new Map(args.meals.map((m) => [m.recipeId, m.recipe]));
                const mealEntries = args.meals.map((m) => ({
                  recipeId: m.recipeId,
                  date: m.date,
                  mealType: m.mealType,
                  servings: m.servings,
                }));
                await clearMealReminders(householdId);
                await scheduleMealReminders(householdId, mealEntries, recipes, settings);
                await AsyncStorage.setItem(
                  STORAGE_KEY_LAST_SCHEDULED_AT(householdId),
                  new Date().toISOString(),
                );
              } catch (err) {
                console.warn('[Confirm] meal reminder scheduling failed:', err);
              }
            })();
          }
```

Note: `args` is the `ConfirmStartArgs` already in scope (captured by closure). If the closure doesn't capture `args`, capture `args.meals` into a `const mealsRef` at the top of `startConfirm` before the call.

- [ ] **Step 3: Add the per-device sync `useEffect`**

Place this `useEffect` adjacent to the existing rehydration effect inside `BackgroundJobsProvider`:

```ts
  // Per-device meal reminder sync. When ANY household member confirms a plan,
  // this device sees the bumped `lastConfirmedAt` and reschedules its own copy.
  useEffect(() => {
    if (!householdId) return;
    return subscribeMealReminderState(householdId, async (lastConfirmedAt) => {
      if (!lastConfirmedAt) return;
      try {
        const cachedStr = await AsyncStorage.getItem(STORAGE_KEY_LAST_SCHEDULED_AT(householdId));
        const cached = cachedStr ? new Date(cachedStr) : null;
        if (cached && cached >= lastConfirmedAt) return;  // already in sync

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
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add contexts/BackgroundJobsContext.tsx
git commit -m "Schedule meal reminders on confirm + sync subscription per device"
```

---

### Task 7: Settings UI — toggles + time inputs in `SettingsModal`

**Goal:** Add a "Meal Reminders" section to `SettingsModal` with two toggles and two time inputs, persisting changes via `updateHouseholdSettings`.

**Files:**
- Modify: `components/SettingsModal.tsx`

**Acceptance Criteria:**
- [ ] A new section labeled "Meal Reminders" sits below existing sections
- [ ] Two `Switch` toggles: "Defrost reminders", "Marinate reminders"
- [ ] Two HH:MM time inputs. Use a controlled `TextInput` (`keyboardType="numeric"`, `maxLength={5}`, placeholder "HH:MM") with an inline regex validator — this avoids adding a new native dependency. Invalid input shows a red border and a "Use HH:MM (24-hour)" helper line.
- [ ] Changes write to Firestore via the existing `updateHouseholdSettings` call (same pattern as other settings in this modal)
- [ ] Defaults pulled from `DEFAULT_MEAL_REMINDERS` when `settings.mealReminders` is undefined
- [ ] `tsc --noEmit` passes

**Verify:** `npx tsc --noEmit` → no output. Manual: open SettingsModal, toggle defrost off, change morning time to "08:00", close modal → reopen, values persist. Check Firestore household settings doc.

**Steps:**

- [ ] **Step 1: Read the current SettingsModal structure**

Read `components/SettingsModal.tsx` to understand the existing pattern (how state is wired, how `updateHouseholdSettings` is called, how a section is laid out). Mirror that pattern exactly.

- [ ] **Step 2: Add the section**

Add (near the existing toggle pattern around line 238) a new section. Add local state at the top of the component:

```ts
import { DEFAULT_MEAL_REMINDERS } from '@/services/mealRemindersConstants';
// …
const reminders = settings.mealReminders ?? DEFAULT_MEAL_REMINDERS;
const [defrostEnabled, setDefrostEnabled] = useState(reminders.defrostEnabled);
const [marinateEnabled, setMarinateEnabled] = useState(reminders.marinateEnabled);
const [morningTime, setMorningTime] = useState(reminders.morningTime);
const [eveningTime, setEveningTime] = useState(reminders.eveningTime);

const isValidHHMM = (s: string) => /^([01]?\d|2[0-3]):[0-5]\d$/.test(s);

const saveReminders = useCallback(async (partial: Partial<NonNullable<HouseholdSettings['mealReminders']>>) => {
  const merged = { defrostEnabled, marinateEnabled, morningTime, eveningTime, ...partial };
  if (!isValidHHMM(merged.morningTime) || !isValidHHMM(merged.eveningTime)) return;
  await updateHouseholdSettings(householdId, { ...settings, mealReminders: merged });
}, [defrostEnabled, marinateEnabled, morningTime, eveningTime, settings, householdId]);
```

Add the section render (place inside the modal's ScrollView, after the existing sections):

```tsx
<Text style={styles.sectionHeader}>Meal Reminders</Text>
<View style={styles.row}>
  <View style={{ flex: 1 }}>
    <Text style={styles.rowTitle}>Defrost reminders</Text>
    <Text style={styles.rowSubtitle}>Reminds you the morning of a meal that uses frozen meat or fish.</Text>
  </View>
  <Switch
    value={defrostEnabled}
    onValueChange={(v) => { setDefrostEnabled(v); saveReminders({ defrostEnabled: v }); }}
  />
</View>
<View style={styles.row}>
  <View style={{ flex: 1 }}>
    <Text style={styles.rowTitle}>Marinate reminders</Text>
    <Text style={styles.rowSubtitle}>Reminds you the evening before a meal that needs marinating.</Text>
  </View>
  <Switch
    value={marinateEnabled}
    onValueChange={(v) => { setMarinateEnabled(v); saveReminders({ marinateEnabled: v }); }}
  />
</View>
<View style={styles.row}>
  <Text style={styles.rowTitle}>Morning reminder time</Text>
  <TextInput
    value={morningTime}
    onChangeText={setMorningTime}
    onBlur={() => isValidHHMM(morningTime) && saveReminders({ morningTime })}
    placeholder="07:30"
    keyboardType="numeric"
    maxLength={5}
    style={[styles.timeInput, !isValidHHMM(morningTime) && styles.timeInputInvalid]}
  />
</View>
<View style={styles.row}>
  <Text style={styles.rowTitle}>Evening reminder time</Text>
  <TextInput
    value={eveningTime}
    onChangeText={setEveningTime}
    onBlur={() => isValidHHMM(eveningTime) && saveReminders({ eveningTime })}
    placeholder="19:30"
    keyboardType="numeric"
    maxLength={5}
    style={[styles.timeInput, !isValidHHMM(eveningTime) && styles.timeInputInvalid]}
  />
</View>
{(!isValidHHMM(morningTime) || !isValidHHMM(eveningTime)) && (
  <Text style={styles.helperError}>Use HH:MM (24-hour)</Text>
)}
```

Add styles to the existing `StyleSheet.create`:

```ts
timeInput: { borderWidth: 1, borderColor: '#ccc', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, minWidth: 80, textAlign: 'center', fontSize: 16 },
timeInputInvalid: { borderColor: 'red' },
helperError: { color: 'red', fontSize: 12, marginTop: 4 },
```

(Reuse existing `row`, `rowTitle`, `rowSubtitle`, `sectionHeader` styles — they already exist in this file.)

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add components/SettingsModal.tsx
git commit -m "Add Meal Reminders section to SettingsModal"
```

---

### Task 8: Notification tap → cookbook navigation

**Goal:** Tapping a defrost / marinate notification opens the Cookbook tab.

**Files:**
- Modify: `hooks/useNotifications.ts`

**Acceptance Criteria:**
- [ ] The existing `addNotificationResponseReceivedListener` handler has a new branch for `data.navigateTo === 'cookbook'` that routes to `/(tabs)/cookbook`
- [ ] `tsc --noEmit` passes

**Verify:** `npx tsc --noEmit` → no output. Manual: schedule a test notification with `data: { navigateTo: 'cookbook' }`, tap it, app routes to Cookbook tab.

**Steps:**

- [ ] **Step 1: Update the tap handler**

In `hooks/useNotifications.ts`, change the existing tap branch:

```ts
const sub = Notifications.addNotificationResponseReceivedListener((response) => {
  const data = response.notification.request.content.data as Record<string, string>;
  if (data?.navigateTo === 'generate') router.push('/(tabs)/generate');
  else if (data?.navigateTo === 'shopping') router.push('/(tabs)/shopping');
  else if (data?.navigateTo === 'cookbook') router.push('/(tabs)/cookbook');
});
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add hooks/useNotifications.ts
git commit -m "Add cookbook branch to notification tap handler"
```

---

### Task 9: Manual end-to-end verification + production build

**Goal:** Run the verification scenarios from the spec on a real device, then publish to Play Console internal track.

**Files:** none (testing + build).

**Acceptance Criteria:**
- [ ] Confirm a meal plan containing a chicken recipe; Firestore shows `needsDefrost: true` on that recipe doc
- [ ] AsyncStorage `mealReminderIds:{householdId}` contains the expected IDs (inspect via dev menu)
- [ ] `Notifications.getAllScheduledNotificationsAsync()` shows trigger dates matching plan dates + configured times
- [ ] Set morning time to "T + 2 min", re-confirm — defrost notification fires
- [ ] Toggle defrost OFF in settings, re-confirm — no defrost notifications scheduled
- [ ] Confirm a plan whose morning slot is already past — no notification scheduled for that slot
- [ ] Re-confirm a second plan — `getAllScheduledNotificationsAsync().length` matches the new plan exactly (no double-up)
- [ ] Multi-device: confirm on device A, verify device B receives its own copy after snapshot fires
- [ ] EAS production build succeeds; AAB submitted to Play Console internal track

**Verify:** see Acceptance Criteria.

**Steps:**

- [ ] **Step 1: Add a temporary debug log to `useNotifications` to dump scheduled notifications on app start**

In `hooks/useNotifications.ts`, inside the permission `setup()` async function (after permission is granted), add:

```ts
if (__DEV__) {
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  console.log('[Notifications] scheduled:', JSON.stringify(scheduled, null, 2));
}
```

- [ ] **Step 2: Run a preview APK build for testing**

```bash
eas build --profile preview --platform android --non-interactive
```

Install the resulting APK on a test device. Run through every acceptance criterion above.

- [ ] **Step 3: Remove the temporary debug log**

Revert the `__DEV__` block from step 1.

```bash
git add hooks/useNotifications.ts
git commit -m "Remove dev log used for notification verification"
```

- [ ] **Step 4: Production build + submit**

```bash
eas build --profile production --platform android --non-interactive
```

Wait for the build to complete. Then submit using the build ID from the output:

```bash
eas submit --profile production --platform android --id <build-id> --non-interactive
```

Verify the submission lands in Play Console → Internal Testing.

---

## Notes for the implementing engineer

- **No automated tests in this repo.** Each task's verify step is `npx tsc --noEmit` plus the manual checks listed in Task 9. Run `npx tsc --noEmit` after every task to catch typing regressions before they compound.
- **Don't refactor existing code.** Stick to the additions described. The existing `confirmMealPlan` flow is fragile because of the Gemini-grouping fallback path — leave it alone.
- **AsyncStorage is already installed** (`@react-native-async-storage/async-storage": "2.2.0"` in `package.json`) — no new package needed for Tasks 5–7.
- **`expo-notifications` is already installed and configured** (channel `mealwizard-jobs` already registered in `useNotifications`). The new reminders reuse the same channel.
- **Skip-past-time logic matters more than it looks.** Without it, every re-confirm would silently fail to schedule any notification whose time has already passed today, but successfully schedule the future ones — leading to confusing "why didn't I get reminded?" complaints. Make sure Task 5's logic is correct.
- **Multi-device idempotency.** The confirming device writes its `lastConfirmedAt` to AsyncStorage immediately after scheduling. When the snapshot listener fires for the same device a moment later, it compares and skips. Don't refactor this to "schedule only inside the listener" — that would delay the confirming user's own reminders behind the snapshot round-trip.
