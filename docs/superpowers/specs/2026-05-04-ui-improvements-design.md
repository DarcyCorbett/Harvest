# Design: Four UI Improvements

**Date:** 2026-05-04
**Scope:** Theme switch, recipe serving-size adjuster, recipe star toggle, shopping-list manual indicator.

## Context

Four user-facing improvements bundled into one spec because each is small and they share no dependencies:

1. Users want to override the OS theme — pick light or dark explicitly, or follow the system.
2. The recipe modal currently hides the household-derived serving count entirely, with no way to scale ingredients on the fly. Users want an inline stepper (adults + children) that re-scales ingredients live, with an explicit Save action to commit to the meal plan.
3. The cookbook supports favourites already, but there's no way to star a recipe directly from the modal — users have to navigate to the cookbook tab first.
4. The shopping-list "manual" badge sits inline next to each item's name, pushing long names onto a second line. This needs to move to a non-flowing position.

All four are intentionally lightweight; together they are still a single implementation cycle.

---

## 1. Theme switch (System / Light / Dark)

### Architecture

A new context provides the resolved colour scheme to every screen and lets the user override the OS preference.

- **Context:** [contexts/ThemeContext.tsx](contexts/ThemeContext.tsx) (new). Exposes:
  - `mode: 'system' | 'light' | 'dark'` — the user's stored preference
  - `effectiveScheme: 'light' | 'dark'` — what to actually render
  - `setMode(mode)` — persists and updates
- **Persistence:** AsyncStorage, key `themeMode`. Per-device, not synced through Firestore (a household member's theme choice on their phone shouldn't affect anyone else).
- **Provider placement:** wrapped at the root in [app/_layout.tsx](app/_layout.tsx), inside the existing `AuthProvider`.
- **Hook:** `useTheme()` returns `{ mode, effectiveScheme, colors, setMode }` where `colors = Colors[effectiveScheme]`. This becomes the single read path for components.
- **Live OS sync:** while `mode === 'system'`, the context subscribes to React Native's `Appearance.addChangeListener` so an OS theme flip propagates immediately.

### Migration

Seventeen files currently call `useColorScheme()` from `react-native` (or via the local `hooks/use-color-scheme*.ts` re-export) and resolve `Colors[colorScheme]` themselves. Each file is mechanically migrated to `const { colors } = useTheme();`.

[components/SettingsModal.tsx](components/SettingsModal.tsx) is also pinned to `Colors.light` at the top of the file via `const colors = Colors.light;`. This is replaced with a hook call inside the component, plus moving the `StyleSheet.create({...})` usages of `colors` to `useMemo` where necessary.

The two `hooks/use-color-scheme*.ts` files become thin wrappers that call `useTheme().effectiveScheme` (so any third-party code reaching for the old hook still works).

### UI

A new "Preferences" section in [app/(tabs)/profile.tsx](app/(tabs)/profile.tsx), placed above the sign-out button. Three-segment pill toggle styled like the existing weight chips (rounded pill, `primaryLight` background when active, `primary` text):

```
[ System ] [ Light ] [ Dark ]
```

Tapping a segment immediately calls `setMode()`; the toggle is the source of truth, no separate Save button.

### Edge cases

- First launch: AsyncStorage is empty → default to `'system'`.
- Storage corruption / read failure: log and default to `'system'`. Don't block the app.

---

## 2. Recipe serving-size adjuster

### Schema change

[services/types.ts](services/types.ts) — extend `MealPlanEntry`:

```ts
export interface MealPlanEntry {
  id?: string;
  recipeId: string;
  date: string;
  mealType: MealType;
  servings?: number;   // existing — kept for back-compat & display math
  adults?: number;     // new
  children?: number;   // new
}
```

When `adults`/`children` are absent on an existing record, fall back to treating `servings` as a single "adults" count (so old plans still produce a usable stepper default).

### Generator

[services/generatorService.ts](services/generatorService.ts) currently writes only `servings` on each entry. Update so every new entry carries all three (`adults`, `children`, `servings`), using the same `calculateRequiredServings(adults, children)` formula already in [services/recipeScraperService.ts:78](services/recipeScraperService.ts#L78). No change to the generation algorithm — only the persistence shape.

### UI in [components/RecipeDetailModal.tsx](components/RecipeDetailModal.tsx)

A new section just above the existing Ingredients section. Layout is **inline** (two stepper rows side-by-side, no stacking) — vertically:

```
┌───────────────────────────────────────────────────┐
│  Adults                       Children            │
│  [−]  3  [+]                  [−]  1  [+]         │
│  Servings: 3.5  (was 2.5)        [ Save Changes ] │
└───────────────────────────────────────────────────┘
```

- Two `Stepper` cells, equal width, separated by a divider or gap. **No emoji or icon in the labels** — plain text "Adults" / "Children".
- `[−]` and `[+]` are tappable buttons; the count between is non-editable text.
- Both clamped to `[0, 12]`.
- Below them: a small read-out `Servings: X (was Y)` showing `calculateRequiredServings(currentAdults, currentChildren)` and the original value when dirty (when not dirty, just `Servings: X`).
- Ingredients re-scale live as either stepper changes, via the existing `applyServingScale(recipe, newServings)`. The recipe passed into the modal is now the **unscaled** original — callers must stop pre-scaling (see "Caller migration" below).

### Save Changes CTA

Single button labelled **"Save Changes"**. Hidden by default; appears when `(currentAdults, currentChildren) !== (defaultAdults, defaultChildren)`.

Tapping it persists `adults`, `children`, and the recomputed `servings` to **only the specific `MealPlanEntry`** the modal was opened from (Reading A — not all occurrences of the recipe in the week).

The shopping list is **not** re-aggregated. The change affects future-display only — the user can manually regenerate the shopping list if they want fresh quantities. (Auto-rebuild deferred for complexity reasons; see the cross-cutting "Out of scope" section.)

### New service function

[services/firestoreService.ts](services/firestoreService.ts) — add:

```ts
export async function updateMealPlanServings(
  householdId: string,
  entryId: string,
  adults: number,
  children: number,
  servings: number
): Promise<void>
```

Single-doc `updateDoc` write. Used only by the CTA.

### Modal props change

```ts
interface RecipeDetailModalProps {
  recipe: Recipe;                  // now expected unscaled (was: pre-scaled)
  visible: boolean;
  onClose: () => void;
  onCourseUpdate?: ...;            // existing
  // — new —
  mealPlanEntry?: {
    id: string;
    adults?: number;
    children?: number;
    servings?: number;
  };
  defaultServings?: number;        // for non-meal-plan contexts (cookbook, etc.)
}
```

CTA appears only when `mealPlanEntry?.id` is set. Without it, the stepper still works as a preview but Save is hidden.

### Caller migration

Every caller that currently does `applyServingScale(recipe, servings)` before passing in must instead pass the unscaled recipe + a `defaultServings` (or `mealPlanEntry`):

- [app/(tabs)/index.tsx](app/(tabs)/index.tsx) — meal-plan tap → pass `mealPlanEntry: { id, adults, children, servings }`
- [app/(tabs)/shopping.tsx](app/(tabs)/shopping.tsx) — `handleRecipePress` (line 181) → look up the meal plan entry by recipeId+source; pass `mealPlanEntry` if found, else just `defaultServings`
- [app/(tabs)/generate.tsx](app/(tabs)/generate.tsx) — results-screen card tap → no meal plan entry yet, pass `defaultServings: meal.servings`
- [app/(tabs)/cookbook.tsx](app/(tabs)/cookbook.tsx) — pass `defaultServings: recipe.originalServings`

### Edge cases

- Stepper at 0/0: Save is disabled (zero servings makes no sense). The read-out shows `Servings: 0`.
- Same `recipeId` in the meal plan twice: the modal opens for one specific entry (the one tapped) and updates only that. The other instance is untouched.
- Modal opened from cookbook / generate-results: stepper works for live preview, no Save shown, no Firestore writes.

---

## 3. Star toggle in RecipeDetailModal header

### UI

Add an Ionicons star button in the modal header, positioned to the **left of the close button**:

- `name="star"` when starred, color `colors.warning`
- `name="star-outline"` otherwise, color `colors.textTertiary`
- Tappable hit-slop matches the close button

### State and wiring

The modal accepts two new props:

```ts
starred?: boolean;
onStarToggle?: () => void;
```

When both are provided, the button renders. Tapping calls `onStarToggle()` synchronously; the parent owns the optimistic state update and the Firestore call.

The button is hidden when `starred === undefined` (preserves backward compat for any caller that doesn't wire it up yet).

### Caller wiring

For each surface that opens the modal:

- [app/(tabs)/cookbook.tsx](app/(tabs)/cookbook.tsx) — already has `entry.starred`; pass that and call existing `toggleStarred()` on tap. No new code needed beyond plumbing.
- [app/(tabs)/index.tsx](app/(tabs)/index.tsx), [app/(tabs)/shopping.tsx](app/(tabs)/shopping.tsx) — these recipes are already in the cookbook (auto-added via [services/generatorService.ts:541](services/generatorService.ts#L541)). Read the cookbook entry's `starred` for the recipe; on toggle call `toggleStarred(householdId, recipeId, !starred)`.
- [app/(tabs)/generate.tsx](app/(tabs)/generate.tsx) — pre-confirm, the recipe may not yet be in the cookbook. On first tap: `addToCookbook(householdId, recipeId)` then `toggleStarred(householdId, recipeId, true)`. On subsequent taps: just `toggleStarred`.

### Edge cases

- Recipe with no `id` (theoretical — every saved recipe has one): button hidden.
- Network failure during toggle: the parent rolls back the optimistic update and shows a brief toast/alert. (Same pattern Cookbook already uses, which is "fire and forget" — keep that for parity.)

---

## 4. Shopping-list manual indicator → corner dot

### Change

In [app/(tabs)/shopping.tsx](app/(tabs)/shopping.tsx) `CompactShoppingItem` (line 408):

- Remove the inline `manualBadge` / `manualText` element and the surrounding `<View>` wrapper that splits name and badge.
- The item name now occupies the full available row width (`flex: 1, numberOfLines: 2`).
- Add a 6×6 px coloured dot, absolutely positioned at the top-right of the card, ~8px from the top and right edges, only rendered when `item.manual === true`.
  - `position: 'absolute'`, `top: 8`, `right: 8`, `width: 6`, `height: 6`, `borderRadius: 3`, `backgroundColor: colors.accent`.

### Cleanup

Remove the now-unused styles `manualBadge` and `manualText` from the StyleSheet at the bottom of the same file.

### Edge cases

- Selection mode: the corner dot doesn't conflict with the selection circle (selection circle lives in the top-left checkbox slot).
- Card with no quantity, no sources, name + manual: the dot still anchors to the top-right corner regardless of card content height.

---

## Out of scope

- **Shopping list re-aggregation on serving change.** Mentioned in section 2; deferred because preserving manual items + check-states + handling unit-family rebucketing is a meaningful chunk of work on its own. Future spec.
- **Per-user theme sync across devices.** Would require a user-level Firestore document (current schema has only `users/{uid}` with `email` and `householdId`). Deferred.
- **Star button on cards in index.tsx, generate.tsx, shopping.tsx.** The user explicitly scoped this to the modal header only. Card-level stars deferred.
- **Bulk serving change for all instances of a recipe in the week** (Reading B from earlier). Deferred — scope confirmed as Reading A.

---

## Verification

End-to-end checks after implementation:

1. **Theme:**
   - Toggle System → Light → Dark in Profile; every screen flips colour scheme without a reload.
   - With System selected, change OS theme via device settings; app updates live.
   - Kill and relaunch the app; the previously-selected mode persists.
   - Open SettingsModal — colours match the active scheme (no longer pinned to light).

2. **Servings:**
   - Open a recipe from the week view (Calendar tab); steppers reflect the entry's adults/children. For an old entry with only `servings`, the steppers show `(servings, 0)`.
   - Increment Adults +1; ingredient quantities scale up live; "Save Changes" appears.
   - Tap Save Changes; Firestore `mealPlanEntries/{id}` document gets `adults`, `children`, `servings` updated. Reopen the recipe → the new values are now the defaults.
   - Open the same recipe from Cookbook → no Save button shown.
   - Open from Generate results → no Save button shown.

3. **Star:**
   - Open a recipe from any surface; star icon visible in header.
   - Tap to toggle; cookbook tab "Favourites" filter reflects the change.
   - For a generate-results recipe (pre-confirm), tapping star adds it to the cookbook and stars it.

4. **Manual dot:**
   - Add a manual shopping item with a long name (e.g. "Italian sundried tomatoes in olive oil"); the name now fills both lines of the card without a "manual" pill in the way.
   - A small accent-coloured dot appears in the top-right corner.
   - Auto-aggregated items have no dot.

---

## Files touched (summary)

| Path | Action | Reason |
|---|---|---|
| `contexts/ThemeContext.tsx` | new | Theme provider |
| `app/_layout.tsx` | edit | Wrap with ThemeProvider |
| `hooks/use-color-scheme.ts` + `.web.ts` | edit | Re-route through useTheme |
| `app/(tabs)/profile.tsx` | edit | Add Preferences section |
| `components/SettingsModal.tsx` | edit | Un-hardcode `Colors.light` |
| ~7 other files using `useColorScheme()` (`app/login.tsx`, `app/register.tsx`, `app/(tabs)/_layout.tsx`, `components/PastelCard.tsx`, `components/parallax-scroll-view.tsx`, `components/ui/collapsible.tsx`, `hooks/use-theme-color.ts`) | edit | Mechanical migration to `useTheme` |
| `services/types.ts` | edit | Add adults/children to MealPlanEntry |
| `services/generatorService.ts` | edit | Write adults/children on new entries |
| `services/firestoreService.ts` | edit | Add `updateMealPlanServings` |
| `components/RecipeDetailModal.tsx` | edit | Stepper + Save CTA + star button + unscaled-recipe contract |
| `app/(tabs)/index.tsx` | edit | Pass mealPlanEntry & wire star |
| `app/(tabs)/shopping.tsx` | edit | Pass mealPlanEntry, wire star, replace inline badge with corner dot |
| `app/(tabs)/generate.tsx` | edit | Pass defaultServings, wire star (with auto-addToCookbook) |
| `app/(tabs)/cookbook.tsx` | edit | Pass starred + onStarToggle into modal |
