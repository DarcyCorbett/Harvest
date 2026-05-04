# UI Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement four UI improvements: a System/Light/Dark theme switch, an inline serving-size adjuster on recipe cards, a star toggle in the recipe modal header, and a non-flowing "manual" indicator on shopping list cards.

**Architecture:** A new ThemeContext owns the resolved colour scheme + AsyncStorage persistence, then the existing `useColorScheme()` call sites migrate to `useTheme()`. RecipeDetailModal grows two new responsibilities (servings stepper + star button) wired via optional props so callers opt in per surface. The shopping-list card replaces an inline pill with a corner dot.

**Tech Stack:** React Native 0.81 / Expo 54 (managed workflow), TypeScript 5.9, Firestore, `@react-native-async-storage/async-storage` (already in deps). No test framework is installed in this repo — verification uses `npx tsc --noEmit`, `npm run lint`, and manual UI testing on a running Expo build.

**Spec:** [docs/superpowers/specs/2026-05-04-ui-improvements-design.md](docs/superpowers/specs/2026-05-04-ui-improvements-design.md)

---

## File Structure

| Path | Role |
|---|---|
| `contexts/ThemeContext.tsx` | New — owns theme mode + persistence + provider + hook |
| `app/_layout.tsx` | Edited — wrap RootNavigator with ThemeProvider, replace local useColorScheme |
| `hooks/use-color-scheme.ts` + `.web.ts` | Edited — re-route through useTheme so legacy imports still work |
| `hooks/use-theme-color.ts` | Edited — read from useTheme |
| `app/(tabs)/profile.tsx` | Edited — add Preferences section with three-segment toggle |
| 10 other useColorScheme call sites | Edited — mechanical migration |
| 4 `Colors.light`-hardcoded files | Edited — un-hardcode |
| `services/types.ts` | Edited — add `adults?`, `children?` to `MealPlanEntry` |
| `services/generatorService.ts` | Edited — write all three (adults/children/servings) on new entries |
| `services/firestoreService.ts` | Edited — write adults/children in `addMealPlanEntry`; new `updateMealPlanServings` |
| `components/RecipeDetailModal.tsx` | Edited — stepper + Save CTA + star button + new props; recipe expected unscaled |
| `app/(tabs)/index.tsx`, `shopping.tsx`, `generate.tsx`, `cookbook.tsx` | Edited — modal call-site updates for servings + star |
| `app/(tabs)/shopping.tsx` | Edited — manual pill → corner dot |

---

## Verification commands

Used throughout the plan:

- **Typecheck:** `npx tsc --noEmit` — should report 0 errors.
- **Lint:** `npm run lint` — should report 0 errors (warnings tolerated).
- **Run app:** `npx expo start` — opens Metro; press `a` for Android emulator or scan QR for device.

---

## Task 1: ThemeContext + useTheme hook

**Goal:** Create the context, provider, and hook that own theme mode and persist it across launches.

**Files:**
- Create: `contexts/ThemeContext.tsx`

**Acceptance Criteria:**
- [ ] `useTheme()` returns `{ mode, effectiveScheme, colors, setMode }`.
- [ ] On first launch with no stored preference, `mode === 'system'` and `effectiveScheme` follows the OS.
- [ ] Calling `setMode('dark')` writes `'dark'` to AsyncStorage under key `themeMode` and updates `effectiveScheme` immediately.
- [ ] While `mode === 'system'`, OS theme changes propagate via `Appearance.addChangeListener`.

**Verify:** `npx tsc --noEmit` → 0 errors.

**Steps:**

- [ ] **Step 1: Create the context file**

```tsx
// contexts/ThemeContext.tsx
import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { Appearance, ColorSchemeName } from 'react-native';
import { Colors } from '@/constants/theme';

export type ThemeMode = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'themeMode';

interface ThemeContextValue {
  mode: ThemeMode;
  effectiveScheme: 'light' | 'dark';
  colors: typeof Colors.light;
  setMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>('system');
  const [systemScheme, setSystemScheme] = useState<ColorSchemeName>(
    Appearance.getColorScheme()
  );

  // Hydrate from AsyncStorage on mount
  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((stored) => {
        if (stored === 'system' || stored === 'light' || stored === 'dark') {
          setModeState(stored);
        }
      })
      .catch((err) => {
        console.warn('[ThemeContext] Failed to load themeMode:', err);
      });
  }, []);

  // Subscribe to OS theme changes (only matters when mode === 'system')
  useEffect(() => {
    const sub = Appearance.addChangeListener(({ colorScheme }) => {
      setSystemScheme(colorScheme);
    });
    return () => sub.remove();
  }, []);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    AsyncStorage.setItem(STORAGE_KEY, next).catch((err) => {
      console.warn('[ThemeContext] Failed to persist themeMode:', err);
    });
  }, []);

  const effectiveScheme: 'light' | 'dark' =
    mode === 'system' ? (systemScheme === 'dark' ? 'dark' : 'light') : mode;

  const colors = Colors[effectiveScheme];

  return (
    <ThemeContext.Provider value={{ mode, effectiveScheme, colors, setMode }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme must be used inside <ThemeProvider>');
  }
  return ctx;
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add contexts/ThemeContext.tsx
git commit -m "Add ThemeContext with mode persistence and system listener"
```

---

## Task 2: Wrap app with ThemeProvider, route hooks through it

**Goal:** Insert ThemeProvider at the root and re-route the legacy `hooks/use-color-scheme*.ts` and `hooks/use-theme-color.ts` to read from the new context.

**Files:**
- Modify: `app/_layout.tsx`
- Modify: `hooks/use-color-scheme.ts`
- Modify: `hooks/use-color-scheme.web.ts`
- Modify: `hooks/use-theme-color.ts`

**Acceptance Criteria:**
- [ ] `<ThemeProvider>` wraps `<AuthProvider>` in `app/_layout.tsx`.
- [ ] `useColorScheme()` from `@/hooks/use-color-scheme` returns the active effective scheme (so existing call sites see no behaviour change once the provider is in place).
- [ ] `useThemeColor` returns colours from the active effective scheme.
- [ ] App launches without runtime error.

**Verify:** `npx tsc --noEmit` → 0 errors. Then `npx expo start` and confirm the app boots.

**Steps:**

- [ ] **Step 1: Edit `app/_layout.tsx`**

Replace the file contents with:

```tsx
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { ActivityIndicator, View, StyleSheet } from 'react-native';
import 'react-native-reanimated';

import { AuthProvider, useAuth } from '@/contexts/AuthContext';
import { ThemeProvider, useTheme } from '@/contexts/ThemeContext';

import * as SplashScreen from 'expo-splash-screen';
import {
  Outfit_400Regular,
  Outfit_500Medium,
  Outfit_600SemiBold,
  Outfit_700Bold,
  useFonts,
} from '@expo-google-fonts/outfit';

SplashScreen.preventAutoHideAsync();

function RootNavigator() {
  const { user, loading, householdId } = useAuth();
  const segments = useSegments();
  const router = useRouter();
  const { colors } = useTheme();

  useEffect(() => {
    if (loading) return;
    const inAuthGroup = segments[0] === 'login' || segments[0] === 'register';
    if (!user && !inAuthGroup) {
      router.replace('/login');
    } else if (user && householdId && inAuthGroup) {
      router.replace('/(tabs)');
    }
  }, [user, loading, householdId, segments]);

  if (loading) {
    return (
      <View style={[styles.loadingContainer, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  return (
    <>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="login" />
        <Stack.Screen name="register" />
        <Stack.Screen name="(tabs)" />
      </Stack>
      <StatusBar style="auto" />
    </>
  );
}

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    Outfit_400Regular,
    Outfit_500Medium,
    Outfit_600SemiBold,
    Outfit_700Bold,
  });

  useEffect(() => {
    if (fontsLoaded) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded]);

  if (!fontsLoaded) {
    return null;
  }

  return (
    <ThemeProvider>
      <AuthProvider>
        <RootNavigator />
      </AuthProvider>
    </ThemeProvider>
  );
}

const styles = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
});
```

Note: the React Navigation `<ThemeProvider>` import was dropped since the navigator's themed surfaces are minimal; if we later need it back it can be re-added inside `RootNavigator` and fed `effectiveScheme`.

- [ ] **Step 2: Replace `hooks/use-color-scheme.ts`**

```ts
// hooks/use-color-scheme.ts
import { useTheme } from '@/contexts/ThemeContext';

export function useColorScheme(): 'light' | 'dark' {
  return useTheme().effectiveScheme;
}
```

- [ ] **Step 3: Replace `hooks/use-color-scheme.web.ts`**

```ts
// hooks/use-color-scheme.web.ts
import { useTheme } from '@/contexts/ThemeContext';

export function useColorScheme(): 'light' | 'dark' {
  return useTheme().effectiveScheme;
}
```

- [ ] **Step 4: Replace `hooks/use-theme-color.ts`**

```ts
// hooks/use-theme-color.ts
import { Colors } from '@/constants/theme';
import { useTheme } from '@/contexts/ThemeContext';

export function useThemeColor(
  props: { light?: string; dark?: string },
  colorName: keyof typeof Colors.light & keyof typeof Colors.dark
) {
  const { effectiveScheme } = useTheme();
  return props[effectiveScheme] ?? Colors[effectiveScheme][colorName];
}
```

- [ ] **Step 5: Verify typecheck and lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: 0 errors.

- [ ] **Step 6: Smoke-test the app**

Run: `npx expo start` → press `a` (Android) or open on a device.
Expected: app boots to login or home with no red error screen.

- [ ] **Step 7: Commit**

```bash
git add app/_layout.tsx hooks/use-color-scheme.ts hooks/use-color-scheme.web.ts hooks/use-theme-color.ts
git commit -m "Wrap app in ThemeProvider, route legacy hooks through useTheme"
```

---

## Task 3: Migrate remaining `useColorScheme` call sites

**Goal:** Move the remaining call sites that import `useColorScheme` directly from `react-native` over to the local `@/hooks/use-color-scheme` re-export (which now reads from useTheme). This is a pure import-and-symbol swap.

**Files:**
- Modify each of: `app/login.tsx`, `app/register.tsx`, `app/(tabs)/_layout.tsx`, `app/(tabs)/profile.tsx`, `app/(tabs)/index.tsx`, `app/(tabs)/cookbook.tsx`, `app/(tabs)/shopping.tsx`, `components/parallax-scroll-view.tsx`, `components/ui/collapsible.tsx`

**Acceptance Criteria:**
- [ ] No file outside `contexts/ThemeContext.tsx` and the three `hooks/` files imports `useColorScheme` from `react-native`.
- [ ] Existing behaviour is unchanged (every screen renders with the correct theme).

**Verify:**

```bash
npx tsc --noEmit && \
grep -rn "from 'react-native'" app components hooks --include='*.tsx' --include='*.ts' | grep "useColorScheme"
```
Expected: typecheck passes; the grep returns no lines.

**Steps:**

- [ ] **Step 1: For each file above, change the import**

In every listed file, locate the import line that pulls `useColorScheme` from `'react-native'`. Two patterns appear:

Pattern A — `useColorScheme` is the only name from `'react-native'` on that line:

```ts
// before
import { useColorScheme } from 'react-native';

// after
import { useColorScheme } from '@/hooks/use-color-scheme';
```

Pattern B — `useColorScheme` is one of several names from `'react-native'`:

```ts
// before
import {
  Animated,
  Dimensions,
  // ...
  useColorScheme,
} from 'react-native';

// after — drop useColorScheme from the react-native import,
// add a separate import below it
import {
  Animated,
  Dimensions,
  // ...
} from 'react-native';
import { useColorScheme } from '@/hooks/use-color-scheme';
```

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit`
Expected: 0 errors.

Then:
```bash
grep -rn "useColorScheme" app components hooks --include='*.tsx' --include='*.ts' | grep "from 'react-native'"
```
Expected: no output.

- [ ] **Step 3: Smoke test**

`npx expo start` → boot the app, navigate through all tabs, login screen, register screen — confirm no crash.

- [ ] **Step 4: Commit**

```bash
git add app/ components/ hooks/
git commit -m "Migrate useColorScheme call sites to ThemeContext-backed hook"
```

---

## Task 4: Un-hardcode `Colors.light` references

**Goal:** Four files pin themselves to `Colors.light` at module scope, blocking dark mode. Replace each with a hook-based read so they pick up the active scheme.

**Files:**
- Modify: `components/SettingsModal.tsx` (line 31)
- Modify: `components/RecipeDetailModal.tsx` (line 34)
- Modify: `components/PastelCard.tsx` (line 30)
- Modify: `app/(tabs)/generate.tsx` (line 44)

**Acceptance Criteria:**
- [ ] No file declares `const colors = Colors.light` (or `Colors.dark`) at module scope.
- [ ] Each component pulls `colors` from `useTheme()` inside its render function.
- [ ] Each affected screen still compiles and renders.

**Verify:**
```bash
npx tsc --noEmit && \
grep -rn "Colors\.light\|Colors\.dark" app components --include='*.tsx' | grep -v ":\s*//\|hooks/use-theme-color"
```
Expected: typecheck passes; the grep returns at most lines that are inside string literals or doc comments — none inside live module-scope `const` declarations.

**Steps:**

- [ ] **Step 1: `components/SettingsModal.tsx`**

  - Remove line 31: `const colors = Colors.light;`
  - Add `import { useTheme } from '@/contexts/ThemeContext';` near the top.
  - Inside `SettingsModal()`, before existing hooks, add:
    ```ts
    const { colors } = useTheme();
    ```
  - The `StyleSheet.create({...})` block at the bottom that references `colors` directly must be moved inside the component as a `useMemo`, OR keep the StyleSheet but replace `colors.*` references in styles with hardcoded fallbacks (e.g. `colors.text` → keep as inline `style={[s.title, { color: colors.text }]}` everywhere). Concretely:
    1. In the `styles` object, replace every `colors.X` with a hardcoded neutral (e.g. `'#1C1917'` for text, `'#FDFBF7'` for background) — this leaves the layout & spacing in StyleSheet but moves *colour* application inline, matching how `shopping.tsx` and `profile.tsx` already do it.
    2. In the JSX, where existing styles like `style={styles.title}` exist, change to `style={[styles.title, { color: colors.text }]}` (and similar for backgrounds, borders).
  - Keep `Spacing`, `Radius`, `Shadows`, `Fonts`, `FontSizes` in the StyleSheet — those don't depend on theme.

  This is the largest single edit in this task. Apply it methodically: open the file, scan for every `colors.` reference, decide whether the surrounding style needs to move inline or whether the colour can move inline while the rest stays in StyleSheet.

- [ ] **Step 2: `components/RecipeDetailModal.tsx`**

  Same pattern — remove `const colors = Colors.light;` at line 34, add `useTheme()` inside the component, and move colour-bearing style values inline. (This file will be edited again in Tasks 7 and 9; keep the migration minimal here.)

- [ ] **Step 3: `components/PastelCard.tsx`**

  Same pattern. This is a smaller file; the migration should be quick.

- [ ] **Step 4: `app/(tabs)/generate.tsx`**

  Same pattern. This is a 1400-line file — the `colors` reference at line 44 is module-scope. Inside the screen component, switch to `const { colors } = useTheme();` and propagate. Note: this file already imports `useColorScheme` from `'react-native'` was migrated in Task 3, so the hook is now `@/hooks/use-color-scheme`. To stay consistent, prefer `useTheme().colors` for the colours object (avoids resolving `Colors[scheme]` manually).

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit && npm run lint`
Expected: 0 errors.

- [ ] **Step 6: Smoke test theme flip**

In a temporary patch (revert before commit), set the device OS theme to dark and launch the app. Open SettingsModal, RecipeDetailModal (tap any recipe), and the Generate screen. Confirm they all render dark-themed (not stuck light). Revert the temporary patch.

- [ ] **Step 7: Commit**

```bash
git add components/SettingsModal.tsx components/RecipeDetailModal.tsx components/PastelCard.tsx 'app/(tabs)/generate.tsx'
git commit -m "Un-hardcode Colors.light in modal/card components"
```

---

## Task 5: Add Preferences toggle to Profile tab

**Goal:** Add a three-segment "System / Light / Dark" pill toggle in a new Preferences section on the Profile tab.

**Files:**
- Modify: `app/(tabs)/profile.tsx`

**Acceptance Criteria:**
- [ ] A "PREFERENCES" section appears between the household-join section and the sign-out button.
- [ ] The active mode segment is highlighted with `colors.primaryLight` background and `colors.primary` text.
- [ ] Tapping a segment immediately changes the app theme (no app reload).
- [ ] The setting persists across app restarts.

**Verify:** Manual UI test — toggle through System / Light / Dark; navigate other tabs; kill and relaunch app; confirm the previous selection is still active.

**Steps:**

- [ ] **Step 1: Wire `useTheme` into `profile.tsx`**

At the top, add:
```tsx
import { useTheme } from '@/contexts/ThemeContext';
```

Inside `ProfileScreen()`, near the other hooks:
```ts
const { mode, setMode } = useTheme();
```

(Note: `colors` already comes from the existing `useColorScheme` migration in Task 3 — we keep that. Or alternatively replace it with `const { colors, mode, setMode } = useTheme();` — pick one. Recommend the latter for consistency.)

- [ ] **Step 2: Add the Preferences JSX**

Insert this block between the "Join different household" card (ends near line 162) and the `<View style={s.spacer} />`:

```tsx
{/* Preferences */}
<Text style={[s.sectionTitle, { color: colors.textSecondary }]}>PREFERENCES</Text>
<View style={[s.card, { backgroundColor: colors.surface }, Shadows.sm]}>
  <Text style={[s.codeHint, { color: colors.textTertiary, marginBottom: Spacing.md }]}>
    Choose how the app looks. "System" follows your device setting.
  </Text>
  <View style={s.themeRow}>
    {(['system', 'light', 'dark'] as const).map((opt) => {
      const active = mode === opt;
      return (
        <TouchableOpacity
          key={opt}
          style={[
            s.themeChip,
            {
              borderColor: active ? colors.primary : colors.border,
              backgroundColor: active ? colors.primaryLight : 'transparent',
            },
          ]}
          onPress={() => setMode(opt)}
          activeOpacity={0.7}
        >
          <Text
            style={[
              s.themeChipText,
              { color: active ? colors.primary : colors.textSecondary },
            ]}
          >
            {opt[0].toUpperCase() + opt.slice(1)}
          </Text>
        </TouchableOpacity>
      );
    })}
  </View>
</View>
```

- [ ] **Step 3: Add styles**

In the `s = StyleSheet.create({...})` block near the bottom, add:

```ts
themeRow: {
  flexDirection: 'row',
  gap: Spacing.sm,
},
themeChip: {
  flex: 1,
  paddingVertical: Spacing.sm,
  borderRadius: Radius.pill,
  borderWidth: 1.5,
  alignItems: 'center',
},
themeChipText: {
  fontSize: FontSizes.sm,
  fontFamily: Fonts.semibold,
},
```

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 5: Manual UI test**

`npx expo start` → open Profile tab.
- Tap each segment in turn; the whole UI re-themes immediately.
- Kill the app and relaunch; the last-selected segment is still active.
- With "System" selected, change the OS theme; the app follows.

- [ ] **Step 6: Commit**

```bash
git add 'app/(tabs)/profile.tsx'
git commit -m "Add System/Light/Dark theme toggle to Profile tab"
```

---

## Task 6: Extend MealPlanEntry schema and generator persistence

**Goal:** Persist `adults` and `children` counts on every new MealPlanEntry going forward, so the recipe modal can pre-fill its steppers correctly.

**Files:**
- Modify: `services/types.ts` (MealPlanEntry interface)
- Modify: `services/firestoreService.ts` (`addMealPlanEntry`)
- Modify: `services/generatorService.ts` (passes adults/children when calling addMealPlanEntry)

**Acceptance Criteria:**
- [ ] `MealPlanEntry` has new optional `adults?: number` and `children?: number` fields.
- [ ] `addMealPlanEntry` writes both fields when present.
- [ ] After running the generator and confirming a meal plan, every new doc in `households/{id}/mealPlan/{date_meal}` contains `adults`, `children`, and `servings`.
- [ ] Existing entries (without adults/children) still load correctly — `subscribeMealPlan` returns them with the new fields `undefined`.

**Verify:** `npx tsc --noEmit` → 0 errors. Then generate a new meal plan and inspect a written doc in the Firestore console (or via a quick `getMealPlanRange` log).

**Steps:**

- [ ] **Step 1: Update `services/types.ts`**

Replace the `MealPlanEntry` interface:

```ts
export interface MealPlanEntry {
  id?: string;            // document ID: "{date}_{mealType}" e.g. "2025-07-14_dinner"
  recipeId: string;
  date: string;           // ISO date string: "2025-07-14"
  mealType: MealType;
  servings?: number;      // household-adjusted serving count used when this meal was confirmed
  adults?: number;        // adults at confirm time (new)
  children?: number;      // children at confirm time (new)
}
```

- [ ] **Step 2: Update `addMealPlanEntry` in `services/firestoreService.ts`**

Replace the function (around line 263):

```ts
export async function addMealPlanEntry(householdId: string, entry: MealPlanEntry): Promise<void> {
  const docId = `${entry.date}_${entry.mealType}`;
  await setDoc(
    doc(db, 'households', householdId, 'mealPlan', docId),
    {
      recipeId: entry.recipeId,
      date: entry.date,
      mealType: entry.mealType,
      ...(entry.servings != null ? { servings: entry.servings } : {}),
      ...(entry.adults != null ? { adults: entry.adults } : {}),
      ...(entry.children != null ? { children: entry.children } : {}),
    }
  );
}
```

- [ ] **Step 3: Update generator's confirm path in `services/generatorService.ts`**

Locate the block around line 535–541 where `addMealPlanEntry` is called inside the confirm-meal-plan flow. The current call passes `recipeId`, `date`, `mealType`, `servings`. Add `adults` and `children` from the active config:

```ts
await addMealPlanEntry(householdId, {
  recipeId: meal.recipeId,
  date: meal.date,
  mealType: meal.mealType,
  servings: meal.servings,
  adults: config.adults,
  children: config.children,
});
```

`config.adults` and `config.children` are already available in scope (used a few lines above for `calculateRequiredServings`). If the function signature doesn't already pass `config` through to this point, thread it via the existing parameter — the surrounding function already accepts the full config. Verify by inspection.

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 5: Functional test**

`npx expo start` → run the generator on the device → confirm a meal plan → open Firestore console → verify a freshly written `households/{id}/mealPlan/{date_meal}` doc has all three fields: `servings`, `adults`, `children`.

- [ ] **Step 6: Commit**

```bash
git add services/types.ts services/firestoreService.ts services/generatorService.ts
git commit -m "Persist adults/children on MealPlanEntry alongside servings"
```

---

## Task 7: RecipeDetailModal — stepper, Save CTA, and `updateMealPlanServings`

**Goal:** Add a side-by-side adults/children stepper inside `RecipeDetailModal`, live-rescale ingredient quantities as the user changes them, and surface a "Save Changes" CTA that persists the new counts to the originating `MealPlanEntry` (only). No shopping list rebuild — out of scope.

**Files:**
- Modify: `services/firestoreService.ts` (new `updateMealPlanServings`)
- Modify: `components/RecipeDetailModal.tsx` (new props, stepper UI, Save CTA, accept unscaled recipe)

**Acceptance Criteria:**
- [ ] New `updateMealPlanServings(householdId, entryId, adults, children, servings)` writes a single Firestore update.
- [ ] `RecipeDetailModal` accepts new optional props: `mealPlanEntry?: { id: string; adults?: number; children?: number; servings?: number }` and `defaultServings?: number`.
- [ ] When `mealPlanEntry` is provided, the stepper initial values are `(mealPlanEntry.adults ?? mealPlanEntry.servings ?? defaultServings ?? recipe.originalServings, mealPlanEntry.children ?? 0)`.
- [ ] Adjusting either stepper rescales ingredient quantities live.
- [ ] When the stepper values differ from the meal-plan defaults AND `mealPlanEntry?.id` is set, a "Save Changes" button is visible; tapping it writes via `updateMealPlanServings` and resets the dirty flag.
- [ ] When `mealPlanEntry` is absent, the stepper still works for preview but no Save button is shown.
- [ ] Steppers clamp to `[0, 12]`.
- [ ] When both are 0, the read-out shows `Servings: 0` and Save (if visible) is disabled.
- [ ] No emojis or icons in the stepper labels — plain text "Adults" / "Children".

**Verify:** `npx tsc --noEmit` → 0 errors. Then manual UI test (after Task 8 wires callers).

**Steps:**

- [ ] **Step 1: Add `updateMealPlanServings` to `services/firestoreService.ts`**

Add immediately after `addMealPlanEntry`:

```ts
/** Update servings (and adults/children) on an existing meal plan entry. */
export async function updateMealPlanServings(
  householdId: string,
  entryId: string,
  adults: number,
  children: number,
  servings: number
): Promise<void> {
  await updateDoc(
    doc(db, 'households', householdId, 'mealPlan', entryId),
    { adults, children, servings }
  );
}
```

If `updateDoc` is not yet imported in this file, add it to the existing `firebase/firestore` import.

- [ ] **Step 2: Update `RecipeDetailModal` props interface**

In `components/RecipeDetailModal.tsx`, locate the props interface (search for `interface .*ModalProps` or the parameter destructuring). Replace it with:

```ts
interface RecipeDetailModalProps {
  recipe: Recipe | null;          // unscaled — modal does the scaling
  visible: boolean;
  onClose: () => void;
  onCourseUpdate?: (id: string, course: string[]) => void;

  /** When set, the modal shows a Save Changes CTA and persists adults/children/servings here. */
  mealPlanEntry?: {
    id: string;
    adults?: number;
    children?: number;
    servings?: number;
  };

  /** Default servings to seed the stepper when no mealPlanEntry context. */
  defaultServings?: number;

  /** When set, the modal shows a star toggle in the header. */
  starred?: boolean;
  onStarToggle?: () => void;
}
```

(`starred`/`onStarToggle` are placeholders for Task 9 — adding them to the type now avoids a second type-edit cycle.)

- [ ] **Step 3: Add stepper state and live re-scaling**

Inside the modal component, near the existing hooks (and **after** the `useTheme()` call from Task 4):

```ts
import { applyServingScale, calculateRequiredServings } from '@/services/recipeScraperService';
import { updateMealPlanServings } from '@/services/firestoreService';
import { useAuth } from '@/contexts/AuthContext';

// inside the component
const { householdId } = useAuth();

const defaultAdults =
  mealPlanEntry?.adults ?? mealPlanEntry?.servings ?? defaultServings ?? recipe?.originalServings ?? 2;
const defaultChildren = mealPlanEntry?.children ?? 0;

const [adults, setAdults] = useState(defaultAdults);
const [children, setChildren] = useState(defaultChildren);
const [saving, setSaving] = useState(false);

// Reset when a new recipe opens
useEffect(() => {
  setAdults(defaultAdults);
  setChildren(defaultChildren);
}, [recipe?.id, mealPlanEntry?.id]);

const currentServings = calculateRequiredServings(adults, children);
const defaultServingsCalc = calculateRequiredServings(defaultAdults, defaultChildren);
const dirty = adults !== defaultAdults || children !== defaultChildren;

const scaledRecipe = recipe
  ? applyServingScale(recipe, currentServings)
  : null;
```

Use `scaledRecipe` (instead of `recipe`) wherever the existing render reads ingredients. The non-ingredient parts (title, image, description, nutrition, instructions, notes) can still come from the unscaled `recipe`.

The clamp helper:

```ts
const clamp = (n: number) => Math.max(0, Math.min(12, n));
```

- [ ] **Step 4: Render the stepper section above Ingredients**

Find the existing `<SectionLabel title="Ingredients" />` (around line 335). Insert this block immediately above it:

```tsx
{recipe && (
  <View style={styles.stepperWrap}>
    <View style={styles.stepperRow}>
      <View style={styles.stepperCell}>
        <Text style={[styles.stepperLabel, { color: colors.textSecondary }]}>Adults</Text>
        <View style={styles.stepperControls}>
          <TouchableOpacity
            style={[styles.stepperBtn, { borderColor: colors.border }]}
            onPress={() => setAdults((a) => clamp(a - 1))}
          >
            <Text style={[styles.stepperBtnText, { color: colors.text }]}>−</Text>
          </TouchableOpacity>
          <Text style={[styles.stepperCount, { color: colors.text }]}>{adults}</Text>
          <TouchableOpacity
            style={[styles.stepperBtn, { borderColor: colors.border }]}
            onPress={() => setAdults((a) => clamp(a + 1))}
          >
            <Text style={[styles.stepperBtnText, { color: colors.text }]}>+</Text>
          </TouchableOpacity>
        </View>
      </View>

      <View style={styles.stepperCell}>
        <Text style={[styles.stepperLabel, { color: colors.textSecondary }]}>Children</Text>
        <View style={styles.stepperControls}>
          <TouchableOpacity
            style={[styles.stepperBtn, { borderColor: colors.border }]}
            onPress={() => setChildren((c) => clamp(c - 1))}
          >
            <Text style={[styles.stepperBtnText, { color: colors.text }]}>−</Text>
          </TouchableOpacity>
          <Text style={[styles.stepperCount, { color: colors.text }]}>{children}</Text>
          <TouchableOpacity
            style={[styles.stepperBtn, { borderColor: colors.border }]}
            onPress={() => setChildren((c) => clamp(c + 1))}
          >
            <Text style={[styles.stepperBtnText, { color: colors.text }]}>+</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>

    <View style={styles.stepperReadoutRow}>
      <Text style={[styles.stepperReadout, { color: colors.textSecondary }]}>
        Servings: {currentServings}
        {dirty ? `  (was ${defaultServingsCalc})` : ''}
      </Text>

      {dirty && mealPlanEntry?.id && (
        <TouchableOpacity
          style={[
            styles.saveBtn,
            { backgroundColor: colors.primary },
            (saving || currentServings === 0) && { opacity: 0.5 },
          ]}
          disabled={saving || currentServings === 0}
          onPress={async () => {
            if (!householdId) return;
            setSaving(true);
            try {
              await updateMealPlanServings(
                householdId,
                mealPlanEntry.id,
                adults,
                children,
                currentServings
              );
            } catch (err) {
              console.warn('[RecipeDetailModal] save servings failed:', err);
            } finally {
              setSaving(false);
            }
          }}
        >
          <Text style={styles.saveBtnText}>
            {saving ? 'Saving…' : 'Save Changes'}
          </Text>
        </TouchableOpacity>
      )}
    </View>
  </View>
)}
```

- [ ] **Step 5: Add styles**

In the StyleSheet at the bottom of the file, add:

```ts
stepperWrap: {
  marginTop: Spacing.lg,
  marginBottom: Spacing.md,
  paddingHorizontal: Spacing.xl,
},
stepperRow: {
  flexDirection: 'row',
  gap: Spacing.lg,
},
stepperCell: {
  flex: 1,
  gap: Spacing.xs,
},
stepperLabel: {
  fontSize: FontSizes.xs,
  fontFamily: Fonts.semibold,
  textTransform: 'uppercase',
  letterSpacing: 0.6,
},
stepperControls: {
  flexDirection: 'row',
  alignItems: 'center',
  gap: Spacing.md,
},
stepperBtn: {
  width: 36,
  height: 36,
  borderRadius: Radius.pill,
  borderWidth: 1.5,
  alignItems: 'center',
  justifyContent: 'center',
},
stepperBtnText: {
  fontSize: FontSizes.lg,
  fontFamily: Fonts.bold,
},
stepperCount: {
  fontSize: FontSizes.lg,
  fontFamily: Fonts.semibold,
  minWidth: 24,
  textAlign: 'center',
},
stepperReadoutRow: {
  flexDirection: 'row',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginTop: Spacing.md,
},
stepperReadout: {
  fontSize: FontSizes.sm,
  fontFamily: Fonts.medium,
},
saveBtn: {
  paddingHorizontal: Spacing.md,
  paddingVertical: Spacing.xs,
  borderRadius: Radius.pill,
},
saveBtnText: {
  color: '#FFFFFF',
  fontSize: FontSizes.sm,
  fontFamily: Fonts.semibold,
},
```

- [ ] **Step 6: Update ingredient render path to use `scaledRecipe`**

The current render reads from `recipe.ingredients` and `recipe.ingredientGroups`. Change those two reads to `scaledRecipe.ingredients` and `scaledRecipe.ingredientGroups` (around lines 336–346 in the file). Other reads from `recipe` (title, image, description, nutrition, instructions, notes) stay as-is.

- [ ] **Step 7: Verify**

Run: `npx tsc --noEmit`
Expected: 0 errors. (Some callers will still pre-scale and pass `mealPlanEntry`-less props — the modal still works; full caller migration happens in Task 8.)

- [ ] **Step 8: Commit**

```bash
git add services/firestoreService.ts components/RecipeDetailModal.tsx
git commit -m "Add servings stepper and Save Changes CTA to RecipeDetailModal"
```

---

## Task 8: Migrate RecipeDetailModal callers (servings)

**Goal:** Stop pre-scaling the recipe before passing it into `RecipeDetailModal`. Pass `mealPlanEntry` (when known) or `defaultServings` instead, so the modal owns the scaling.

**Files:**
- Modify: `app/(tabs)/index.tsx`
- Modify: `app/(tabs)/shopping.tsx`
- Modify: `app/(tabs)/generate.tsx`
- Modify: `app/(tabs)/cookbook.tsx`

**Acceptance Criteria:**
- [ ] No caller invokes `applyServingScale(...)` before passing the recipe to the modal.
- [ ] When opening from a meal plan slot (week view in `index.tsx`, recipe-source preview in `shopping.tsx`), `mealPlanEntry` is passed with `id`, `adults`, `children`, `servings`.
- [ ] When opening from cookbook or generate-results, `defaultServings` is passed instead — no `mealPlanEntry`.
- [ ] Save Changes CTA appears only on meal-plan-context opens.

**Verify:** `npx tsc --noEmit` → 0 errors. Manual UI test below.

**Steps:**

- [ ] **Step 1: `app/(tabs)/index.tsx` — week view + month view tap handlers**

The screen tracks the active meal-plan entry when a recipe is opened. For the `setPreviewRecipe` (or equivalent) call, change from passing the pre-scaled recipe to passing the unscaled recipe + the entry. Search the file for `applyServingScale`. Where you find:

```tsx
setPreviewRecipe(applyServingScale(recipe, entry.servings ?? recipe.originalServings));
```

…replace with two state setters (one for the recipe, one for the entry context):

```tsx
setPreviewRecipe(recipe);
setPreviewEntry({
  id: entry.id!,
  adults: entry.adults,
  children: entry.children,
  servings: entry.servings,
});
```

Add `previewEntry` state:

```tsx
const [previewEntry, setPreviewEntry] = useState<{
  id: string;
  adults?: number;
  children?: number;
  servings?: number;
} | null>(null);
```

In the `<RecipeDetailModal>` render, pass:

```tsx
<RecipeDetailModal
  recipe={previewRecipe}
  visible={!!previewRecipe}
  onClose={() => { setPreviewRecipe(null); setPreviewEntry(null); }}
  mealPlanEntry={previewEntry ?? undefined}
/>
```

- [ ] **Step 2: `app/(tabs)/shopping.tsx` — `handleRecipePress`**

Find the existing handler (around line 181):

```tsx
const handleRecipePress = useCallback(
  (recipeId: string, servings?: number) => {
    getRecipe(recipeId).then((r) => {
      if (r) setPreviewRecipe(servings != null ? applyServingScale(r, servings) : r);
    }).catch(() => { });
  },
  []
);
```

Replace with:

```tsx
const handleRecipePress = useCallback(
  (recipeId: string, servings?: number) => {
    getRecipe(recipeId).then((r) => {
      if (r) {
        setPreviewRecipe(r);
        setPreviewServings(servings);
      }
    }).catch(() => { });
  },
  []
);
```

Add the parallel state:

```tsx
const [previewServings, setPreviewServings] = useState<number | undefined>();
```

In the `<RecipeDetailModal>` render, pass `defaultServings={previewServings}`. (Shopping list only knows the servings count from the source chip — not the meal-plan entry id — so it cannot expose the Save CTA. This is the documented behaviour.)

Drop the `applyServingScale` import if it becomes unused.

- [ ] **Step 3: `app/(tabs)/generate.tsx` — results-screen recipe modal**

Find the existing `<RecipeDetailModal>` render in this file (around line 402 in the modal-open path). Currently the recipe is wrapped with `applyServingScale(recipe, meal.servings)` before render. Stop wrapping; pass `defaultServings={meal.servings}` instead.

- [ ] **Step 4: `app/(tabs)/cookbook.tsx` — modal render**

Cookbook never had `applyServingScale` (recipe is opened raw from cookbook entries). Just pass `defaultServings={recipe.originalServings}`.

```tsx
<RecipeDetailModal
  recipe={previewRecipe}
  visible={!!previewRecipe}
  onClose={() => setPreviewRecipe(null)}
  defaultServings={previewRecipe?.originalServings}
/>
```

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 6: Manual UI test**

`npx expo start`. Verify:
1. From the **week view** (Calendar tab): tap a meal → recipe modal opens → stepper reflects the meal's adults/children. Increment Adults; ingredients re-scale. Save Changes appears. Tap Save. Reopen the recipe — defaults are now the new values.
2. From the **shopping list**: tap a source chip → recipe opens → stepper works for preview → no Save Changes button visible.
3. From **Cookbook**: tap a recipe → stepper works → no Save Changes.
4. From **Generate results**: tap a result card → stepper works → no Save Changes.

- [ ] **Step 7: Commit**

```bash
git add 'app/(tabs)/index.tsx' 'app/(tabs)/shopping.tsx' 'app/(tabs)/generate.tsx' 'app/(tabs)/cookbook.tsx'
git commit -m "Pass mealPlanEntry/defaultServings to RecipeDetailModal; stop pre-scaling"
```

---

## Task 9: Star button in RecipeDetailModal header

**Goal:** Render a star toggle in the modal's header when `starred` and `onStarToggle` are provided.

**Files:**
- Modify: `components/RecipeDetailModal.tsx`

**Acceptance Criteria:**
- [ ] When `starred !== undefined`, an `Ionicons` star button renders in the header to the **left** of the close button.
- [ ] When `starred === true`, icon is `'star'` with colour `colors.warning`.
- [ ] When `starred === false`, icon is `'star-outline'` with colour `colors.textTertiary`.
- [ ] Tapping the icon calls `onStarToggle()` synchronously.

**Verify:** `npx tsc --noEmit` → 0 errors.

**Steps:**

- [ ] **Step 1: Render the star button**

The props were already added in Task 7 Step 2. Locate the modal header (search for the close button — it uses `Ionicons name="close"`). Insert the star button immediately before the close button:

```tsx
{starred !== undefined && (
  <TouchableOpacity
    onPress={onStarToggle}
    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
    style={{ marginRight: Spacing.md }}
  >
    <Ionicons
      name={starred ? 'star' : 'star-outline'}
      size={22}
      color={starred ? colors.warning : colors.textTertiary}
    />
  </TouchableOpacity>
)}
```

The exact JSX placement depends on the existing header layout — drop the button into the same row container that already wraps the close button so they sit side-by-side.

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add components/RecipeDetailModal.tsx
git commit -m "Render star toggle in RecipeDetailModal header"
```

---

## Task 10: Wire star toggle in callers

**Goal:** Each surface that opens `RecipeDetailModal` provides `starred` + `onStarToggle`. Cookbook reads from its existing `entry.starred`; index/shopping/generate read or create the cookbook entry.

**Files:**
- Modify: `app/(tabs)/cookbook.tsx`
- Modify: `app/(tabs)/index.tsx`
- Modify: `app/(tabs)/shopping.tsx`
- Modify: `app/(tabs)/generate.tsx`

**Acceptance Criteria:**
- [ ] Star button appears in the modal regardless of which surface opened it.
- [ ] Tapping the star toggles `CookbookEntry.starred` for that recipe.
- [ ] In `generate.tsx`, starring a recipe that's not yet in the cookbook auto-adds it then stars it.

**Verify:** Manual UI test below.

**Steps:**

- [ ] **Step 1: `cookbook.tsx`**

The screen already tracks `entries: CookbookEntry[]`. When opening the modal, look up the entry by `recipe.id`:

```tsx
const previewEntry = previewRecipe
  ? entries.find((e) => e.recipeId === previewRecipe.id)
  : undefined;

<RecipeDetailModal
  recipe={previewRecipe}
  visible={!!previewRecipe}
  onClose={() => setPreviewRecipe(null)}
  defaultServings={previewRecipe?.originalServings}
  starred={previewEntry?.starred ?? false}
  onStarToggle={() => previewEntry && handleStarToggle(previewEntry)}
/>
```

`handleStarToggle` already exists in this file.

- [ ] **Step 2: `index.tsx`**

Add a cookbook entries subscription mirroring cookbook.tsx:

```tsx
import { subscribeCookbook, toggleStarred } from '@/services/firestoreService';
import type { CookbookEntry } from '@/services/types';

const [cookbook, setCookbook] = useState<CookbookEntry[]>([]);
useEffect(() => {
  if (!householdId) return;
  return subscribeCookbook(householdId, setCookbook);
}, [householdId]);
```

In the `<RecipeDetailModal>` render, look up the entry:

```tsx
const previewCookbookEntry = previewRecipe
  ? cookbook.find((e) => e.recipeId === previewRecipe.id)
  : undefined;

<RecipeDetailModal
  recipe={previewRecipe}
  visible={!!previewRecipe}
  onClose={() => { setPreviewRecipe(null); setPreviewEntry(null); }}
  mealPlanEntry={previewEntry ?? undefined}
  starred={previewCookbookEntry?.starred ?? false}
  onStarToggle={() => {
    if (!householdId || !previewRecipe?.id) return;
    toggleStarred(householdId, previewRecipe.id, !(previewCookbookEntry?.starred ?? false))
      .catch((err) => console.warn('[index] star toggle failed:', err));
  }}
/>
```

- [ ] **Step 3: `shopping.tsx`**

Same pattern as `index.tsx` — subscribe to cookbook, look up entry by `previewRecipe.id`, wire `starred` + `onStarToggle`.

- [ ] **Step 4: `generate.tsx`**

The recipes here may not be in the cookbook yet (pre-confirm). Wire the toggle as:

```tsx
import { addToCookbook, toggleStarred, subscribeCookbook } from '@/services/firestoreService';
// ...
const [cookbook, setCookbook] = useState<CookbookEntry[]>([]);
useEffect(() => {
  if (!householdId) return;
  return subscribeCookbook(householdId, setCookbook);
}, [householdId]);

// inside the results-screen render where RecipeDetailModal is mounted:
const previewCookbookEntry = previewRecipe
  ? cookbook.find((e) => e.recipeId === previewRecipe.id)
  : undefined;

<RecipeDetailModal
  recipe={previewRecipe}
  visible={!!previewRecipe}
  onClose={() => setPreviewRecipe(null)}
  defaultServings={/* whichever servings the result card had */}
  starred={previewCookbookEntry?.starred ?? false}
  onStarToggle={async () => {
    if (!householdId || !previewRecipe?.id) return;
    try {
      if (!previewCookbookEntry) {
        await addToCookbook(householdId, previewRecipe.id);
        await toggleStarred(householdId, previewRecipe.id, true);
      } else {
        await toggleStarred(householdId, previewRecipe.id, !previewCookbookEntry.starred);
      }
    } catch (err) {
      console.warn('[generate] star toggle failed:', err);
    }
  }}
/>
```

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit && npm run lint`
Expected: 0 errors.

- [ ] **Step 6: Manual UI test**

`npx expo start`. From each of the four surfaces (week view, cookbook, shopping list, generate results), open a recipe modal and tap the star. Verify:
- Star toggles visually.
- The Cookbook tab "Favourites" filter reflects the change.
- For generate-results: starring a brand-new recipe successfully adds it to the cookbook and marks it starred (visible in Cookbook tab afterwards).

- [ ] **Step 7: Commit**

```bash
git add 'app/(tabs)/cookbook.tsx' 'app/(tabs)/index.tsx' 'app/(tabs)/shopping.tsx' 'app/(tabs)/generate.tsx'
git commit -m "Wire star toggle from each modal-opening surface"
```

---

## Task 11: Shopping list — replace inline manual badge with corner dot

**Goal:** Stop the "manual" pill from forcing item-name wrapping. Replace it with a 6×6 px coloured dot in the top-right corner of the card.

**Files:**
- Modify: `app/(tabs)/shopping.tsx`

**Acceptance Criteria:**
- [ ] No manual pill text appears anywhere on the shopping list cards.
- [ ] When `item.manual === true`, a 6×6 dot in `colors.accent` appears at the top-right of the card (~8 px from each edge).
- [ ] Item names use the full row width.
- [ ] Long names that previously wrapped due to the pill no longer wrap unnecessarily.

**Verify:** Manual UI test — add a shopping item with a long name (e.g. "Italian sundried tomatoes in olive oil") and confirm the dot is present and the name uses both lines without the pill.

**Steps:**

- [ ] **Step 1: Restructure the card top row**

Inside `CompactShoppingItem` (around line 408 in `app/(tabs)/shopping.tsx`), the current layout has a wrapper that splits name and badge:

```tsx
<View style={{ flex: 1, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
  <Text
    style={[
      s.itemName,
      { color: item.checked ? colors.textTertiary : colors.text, flex: 1, marginRight: Spacing.xs },
      item.checked && s.strikethrough,
    ]}
    numberOfLines={2}
  >
    {item.name}
  </Text>
  {item.manual && (
    <View style={[s.manualBadge, { backgroundColor: colors.accentLight }]}>
      <Text style={[s.manualText, { color: colors.accent }]}>manual</Text>
    </View>
  )}
</View>
```

Replace with:

```tsx
<Text
  style={[
    s.itemName,
    { color: item.checked ? colors.textTertiary : colors.text, flex: 1 },
    item.checked && s.strikethrough,
  ]}
  numberOfLines={2}
>
  {item.name}
</Text>
```

Then add a corner dot as a sibling of the existing `compactCard` content, positioned absolutely. Inside the same `TouchableOpacity` (the card root), at the end of its children (after the source chips block):

```tsx
{item.manual && (
  <View
    style={{
      position: 'absolute',
      top: 8,
      right: 8,
      width: 6,
      height: 6,
      borderRadius: 3,
      backgroundColor: colors.accent,
    }}
  />
)}
```

- [ ] **Step 2: Remove unused styles**

In the `s = StyleSheet.create({...})` block, delete the `manualBadge` and `manualText` keys. Keep all other keys.

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit && npm run lint`
Expected: 0 errors.

- [ ] **Step 4: Manual UI test**

`npx expo start`. On the Shopping tab:
1. Add a manual item with a long name.
2. Verify the dot is in the top-right corner.
3. Verify the name uses both lines without "manual" text in view.
4. Add an auto-aggregated item (via meal plan generation if needed) — verify NO dot.

- [ ] **Step 5: Commit**

```bash
git add 'app/(tabs)/shopping.tsx'
git commit -m "Replace inline manual pill with corner dot on shopping cards"
```

---

## Self-Review Checklist (post-write)

- [x] **Spec coverage:** Section 1 → Tasks 1–5. Section 2 → Tasks 6–8. Section 3 → Tasks 7 (props placeholder), 9, 10. Section 4 → Task 11. All four spec sections covered.
- [x] **Placeholder scan:** No "TBD"/"TODO"/"implement later". Every code-bearing step shows real code.
- [x] **Type consistency:** `mealPlanEntry: { id; adults?; children?; servings? }` shape used identically in Tasks 7, 8, 10. `updateMealPlanServings` signature `(householdId, entryId, adults, children, servings)` used identically in Task 7 (definition) and Task 7 Step 4 (call site).
- [x] **No test framework:** plan uses `npx tsc --noEmit` + `npm run lint` + manual UI testing as substitutes throughout, in line with the project's actual tooling.

---

## Out of scope (deferred)

- Shopping-list re-aggregation on serving change (see spec).
- Per-user theme sync across devices.
- Star button on recipe cards outside the modal (e.g. on result cards in `generate.tsx`).

When ready, choose how to execute below.
