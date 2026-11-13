import {
  normaliseMeal,
  shiftDate,
  validateAllocations,
  type Meal,
  type Draft,
  type Contribution,
} from "../functions/src/connected/model";

export const MAX_MEAL_CHANGES = 62;
export type MealChange = { meal: Meal; expectedRevision: number };
export type Replacement = { id: string; revision: number };
export const mealLabel = (meal: Meal, recipeTitle?: string) =>
  [
    meal.customLabel,
    meal.kind === "eating-out"
      ? "Eating out"
      : `${meal.kind === "leftover" ? "Leftovers · " : ""}${recipeTitle ?? "Recipe unavailable"}`,
  ]
    .filter(Boolean)
    .join(" · ");
export const hasMeal = (meals: Meal[], date: string, type: string) =>
  meals.some(
    (m) =>
      m.date === date &&
      m.mealType === type &&
      !["removed", "skipped"].includes(m.status),
  );

/** A reviewed snapshot, not a fresh revision lookup, determines replacement writes. */
export function reviewedChanges(
  proposed: Meal[],
  replacements: Record<string, Replacement>,
  current: Meal[],
): MealChange[] {
  if (!proposed.length || proposed.length > MAX_MEAL_CHANGES)
    throw new Error(`Choose between 1 and ${MAX_MEAL_CHANGES} meals.`);
  const ids = new Map(
    proposed.map((m) => [m.id, replacements[m.id]?.id ?? m.id]),
  );
  if (new Set(ids.values()).size !== proposed.length)
    throw new Error("Each existing meal can only be replaced once.");
  const changes = proposed.map((m) => {
    const replacement = replacements[m.id];
    const old = current.find((x) => x.id === (replacement?.id ?? m.id));
    if (
      replacement &&
      (!old ||
        old.revision !== replacement.revision ||
        old.status !== "planned" ||
        old.date !== m.date ||
        old.mealType !== m.mealType)
    )
      throw new Error(
        "A replacement meal changed. Select it again after reviewing the current plan.",
      );
    if (!replacement && old)
      throw new Error(
        "This meal was already added. Refresh the plan before trying again.",
      );
    return {
      meal: {
        ...m,
        id: ids.get(m.id)!,
        revision: replacement?.revision ?? 0,
        status: "planned" as const,
        ...(m.sourceMealId
          ? { sourceMealId: ids.get(m.sourceMealId) ?? m.sourceMealId }
          : {}),
      },
      expectedRevision: replacement?.revision ?? 0,
    };
  });
  const merged = new Map(current.map((m) => [m.id, m]));
  changes.forEach((c) => merged.set(c.meal.id, c.meal));
  validateAllocations([...merged.values()]);
  return changes;
}

export function templateMeals(
  meals: Meal[],
  from: string,
  to: string,
  newId: () => string,
): Meal[] {
  const selected = meals.filter(
    (m) => !["removed", "skipped"].includes(m.status),
  );
  const ids = new Map(selected.map((m) => [m.id, newId()]));
  const delta = Math.round(
    (Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) /
      86400000,
  );
  return selected.map((m) => {
    if (m.sourceMealId && !ids.has(m.sourceMealId))
      throw new Error(
        "This template has leftovers from outside its week. Include the source meal in a new template.",
      );
    return {
      ...m,
      id: ids.get(m.id)!,
      date: shiftDate(m.date, delta),
      revision: 0,
      status: "planned",
      ...(m.sourceMealId ? { sourceMealId: ids.get(m.sourceMealId)! } : {}),
    };
  });
}

/** Legacy draft IDs are mapped only at review; the saved draft remains resumable. */
export function draftMeals(draft: Draft, newId: () => string): Meal[] {
  const slots = draft.slots.filter(
    (s) => !s.removed && s.status === "ready" && s.recipeId,
  );
  const ids = new Map(
    slots.map((s) => [
      s.id,
      /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(s.id) ? s.id : newId(),
    ]),
  );
  return slots.map((s) => {
    if (s.sourceMealId && !ids.has(s.sourceMealId))
      throw new Error(
        "Include the source meal before confirming these leftovers.",
      );
    return normaliseMeal(ids.get(s.id)!, {
      recipeId: s.recipeId!,
      date: s.date,
      mealType: s.mealType,
      servings: s.servings,
      adults: draft.config.adults,
      children: draft.config.children,
      kind: s.sourceMealId ? "leftover" : "recipe",
      ...(s.sourceMealId ? { sourceMealId: ids.get(s.sourceMealId)! } : {}),
      allocatedPortions: slots
        .filter((x) => x.sourceMealId === s.id)
        .reduce((n, x) => n + x.servings, 0),
    });
  });
}

export function distinctRecipeContributions(
  contributions: Contribution[],
): Contribution[] {
  const seen = new Set<string>();
  return contributions.filter((c) => {
    if (seen.has(c.recipeId)) return false;
    seen.add(c.recipeId);
    return true;
  });
}
