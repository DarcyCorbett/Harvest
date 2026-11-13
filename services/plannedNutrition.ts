import type { Meal } from "../functions/src/connected/model";
import type {
  HouseholdSettings,
  Nutrition,
  NutritionTargets,
  Recipe,
} from "./types";

export function normaliseTargets(value: unknown): NutritionTargets {
  const raw =
    value && typeof value === "object"
      ? (value as Partial<NutritionTargets>)
      : {};
  const slots = (v: unknown) =>
    Array.isArray(v)
      ? v.slice(0, 20).map((t) => ({
          ...(typeof t?.calories === "number" &&
          Number.isFinite(t.calories) &&
          t.calories > 0
            ? { calories: t.calories }
            : {}),
          ...(typeof t?.protein === "number" &&
          Number.isFinite(t.protein) &&
          t.protein > 0
            ? { protein: t.protein }
            : {}),
        }))
      : [];
  return {
    enabled: raw.enabled === true,
    adults: slots(raw.adults),
    children: slots(raw.children),
  };
}
export function householdTargets(settings: HouseholdSettings) {
  const targets = normaliseTargets(settings.nutritionTargets);
  const adults = Math.min(
    20,
    Math.max(0, Math.trunc(settings.defaultAdults ?? 2)),
  );
  const children = Math.min(
    20,
    Math.max(0, Math.trunc(settings.defaultChildren ?? 2)),
  );
  const slots = [
    ...Array.from({ length: adults }, (_, i) => targets.adults[i]),
    ...Array.from({ length: children }, (_, i) => targets.children[i]),
  ];
  const complete =
    slots.length > 0 && slots.every((t) => !!t?.calories && !!t?.protein);
  return {
    enabled: targets.enabled,
    complete,
    adults,
    children,
    calories: complete ? slots.reduce((n, t) => n + t.calories!, 0) : undefined,
    protein: complete ? slots.reduce((n, t) => n + t.protein!, 0) : undefined,
  };
}
export function plannedNutrition(
  meals: Meal[],
  recipes: Record<string, Recipe>,
  allMeals: Meal[] = meals,
  basis: 'household' | 'per-serving' = 'household',
) {
  const totals: Nutrition = {};
  let incomplete = false,
    estimated = false,
    contributingRecipes = 0;
  const active = meals.filter(
    (m) => m.status === "planned" || m.status === "cooked",
  );
  for (const meal of active) {
    const divisor = basis === 'per-serving' ? meal.servings : 1;
    if (!Number.isFinite(divisor) || divisor <= 0) {
      incomplete = true;
      continue;
    }
    if (meal.kind === "eating-out") {
      incomplete = true;
      continue;
    }
    const source = meal.kind === "leftover"
      ? allMeals.find((candidate) => candidate.id === meal.sourceMealId)
      : undefined;
    if (meal.overrides?.length || source?.overrides?.length) estimated = true;
    for (const part of [
      { recipeId: meal.recipeId, servings: meal.servings },
      ...(meal.sides ?? []),
    ]) {
      const nutrition = recipes[part.recipeId]?.nutrition;
      let contributed = false;
      for (const key of ["calories", "protein", "carbs", "fat"] as const) {
        const n = nutrition?.[key];
        if (typeof n !== "number" || !Number.isFinite(n) || n < 0) {
          incomplete = true;
          continue;
        }
        totals[key] = (totals[key] ?? 0) + n * part.servings / divisor;
        contributed = true;
      }
      if (contributed) contributingRecipes++;
    }
  }
  return {
    ...totals,
    incomplete,
    estimated,
    contributingRecipes,
    meals: active.length,
  };
}
