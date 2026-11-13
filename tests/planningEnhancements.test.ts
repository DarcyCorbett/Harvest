import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { normaliseMeal, type Draft } from "../functions/src/connected/model";
import {
  distinctRecipeContributions,
  draftMeals,
  hasMeal,
  reviewedChanges,
  templateMeals,
} from "../services/planning";
import { tripRange } from "../services/shoppingDates";
import {
  householdTargets,
  normaliseTargets,
  plannedNutrition,
} from "../services/plannedNutrition";
import type { Recipe } from "../services/types";
const meal = (id: string = randomUUID(), patch = {}) =>
  normaliseMeal(id, {
    date: "2026-09-18",
    mealType: "dinner",
    recipeId: "soup",
    servings: 2,
    ...patch,
  });
const recipe = {
  nutrition: { calories: 200, protein: 10, carbs: 20, fat: 5 },
} as Recipe;

describe("stable planning and reviewed replacement", () => {
  it("adds two dinners without targeting an existing dinner", () => {
    const old = meal("2026-09-18_dinner", { revision: 4 });
    const additions = [meal(), meal()];
    expect(
      reviewedChanges(additions, {}, [old]).map((c) => c.expectedRevision),
    ).toEqual([0, 0]);
    expect(hasMeal([old], old.date, old.mealType)).toBe(true);
    expect(
      hasMeal([{ ...old, status: "skipped" }], old.date, old.mealType),
    ).toBe(false);
  });
  it("replaces only the explicitly reviewed meal and rejects stale or duplicate targets", () => {
    const old = meal("legacy", { revision: 4 }),
      proposed = [meal(), meal()];
    const replacement = { id: old.id, revision: 4 };
    expect(
      reviewedChanges(proposed, { [proposed[0].id]: replacement }, [old])[0],
    ).toMatchObject({ meal: { id: "legacy" }, expectedRevision: 4 });
    expect(() =>
      reviewedChanges(
        proposed,
        { [proposed[0].id]: { ...replacement, revision: 3 } },
        [old],
      ),
    ).toThrow("changed");
    expect(() =>
      reviewedChanges(
        proposed,
        Object.fromEntries(proposed.map((m) => [m.id, replacement])),
        [old],
      ),
    ).toThrow("once");
  });
  it("maps template leftovers by identity with multiple source meals of the same type", () => {
    const source = meal("a", { allocatedPortions: 2 }),
      other = meal("b"),
      leftover = meal("c", {
        date: "2026-09-19",
        kind: "leftover",
        sourceMealId: "a",
      });
    const copied = templateMeals(
      [source, other, leftover],
      "2026-09-14",
      "2026-09-21",
      randomUUID,
    );
    expect(new Set(copied.map((m) => m.id)).size).toBe(3);
    expect(copied[2].sourceMealId).toBe(copied[0].id);
    expect(copied[0].date).toBe("2026-09-25");
    expect(copied[2].date).toBe("2026-09-26");
    expect(() =>
      templateMeals([leftover], "2026-09-14", "2026-09-21", randomUUID),
    ).toThrow("outside");
  });
  it("maps leftovers onto explicitly replaced source IDs and checks allocation integrity", () => {
    const old = meal("old", { revision: 2 }),
      source = meal("source", { allocatedPortions: 2 });
    const leftover = meal("leftover", {
      date: "2026-09-19",
      kind: "leftover",
      sourceMealId: "source",
    });
    const changes = reviewedChanges(
      [source, leftover],
      { source: { id: "old", revision: 2 } },
      [old],
    );
    expect(changes[1].meal.sourceMealId).toBe("old");
    expect(() =>
      reviewedChanges([{ ...source, allocatedPortions: 0 }, leftover], {}, []),
    ).toThrow("exceed");
  });
  it("converts legacy draft slots without replacing existing meals or changing saved preferences", () => {
    const draft = {
      config: { adults: 2, children: 0 },
      slots: [
        {
          id: "2026-09-18_dinner",
          date: "2026-09-18",
          mealType: "dinner",
          status: "ready",
          recipeId: "soup",
          servings: 2,
          expectedRevision: 7,
        },
        {
          id: "2026-09-19_dinner",
          date: "2026-09-19",
          mealType: "dinner",
          status: "ready",
          recipeId: "soup",
          servings: 2,
          sourceMealId: "2026-09-18_dinner",
        },
      ],
    } as Draft;
    const snapshot = JSON.stringify(draft),
      proposed = draftMeals(draft, randomUUID);
    expect(proposed[0].id).not.toBe(draft.slots[0].id);
    expect(proposed[1].sourceMealId).toBe(proposed[0].id);
    expect(proposed[0].allocatedPortions).toBe(2);
    expect(JSON.stringify(draft)).toBe(snapshot);
  });
  it("rejects oversized mutations before sending or splitting them", () => {
    expect(() =>
      reviewedChanges(
        Array.from({ length: 63 }, () => meal()),
        {},
        [],
      ),
    ).toThrow("62");
  });
});
describe("shopping shortcuts", () => {
  it.each([
    ["This Week", "2026-09-20", "2026-09-14", "2026-09-20"],
    ["Next Week", "2026-12-31", "2027-01-04", "2027-01-10"],
    ["Next 2 Weeks", "2024-02-25", "2024-02-26", "2024-03-10"],
    ["This Week", "2026-03-29", "2026-03-23", "2026-03-29"],
    ["Next Week", "2026-10-25", "2026-10-26", "2026-11-01"],
  ] as const)(
    "%s at %s uses local calendar boundaries",
    (preset, today, start, end) =>
      expect(tripRange(preset, today)).toEqual({ start, end }),
  );
  it("keeps one pill per recipe in first-contribution order", () => {
    const sources = [
      { mealId: "a", recipeId: "soup", title: "Soup", quantity: 1 },
      { mealId: "b", recipeId: "rice", title: "Rice", quantity: 2 },
      { mealId: "c", recipeId: "soup", title: "Soup", quantity: 3 },
    ];
    expect(distinctRecipeContributions(sources)).toEqual(sources.slice(0, 2));
    expect(sources).toHaveLength(3);
  });
});
describe("planned household nutrition", () => {
  it('adds one serving of each daily meal and proportional sides', () => {
    const meals = [meal('lunch', { recipeId: 'lunch', servings: 4 }), meal('dinner', { recipeId: 'dinner', servings: 2 })];
    const recipes = {
      lunch: { ...recipe, nutrition: { calories: 400, protein: 20, carbs: 30, fat: 10 } },
      dinner: { ...recipe, nutrition: { calories: 500, protein: 30, carbs: 40, fat: 15 } },
    };
    expect(plannedNutrition(meals, recipes, meals, 'per-serving')).toMatchObject({ calories: 900, protein: 50, carbs: 70, fat: 25 });
    expect(plannedNutrition(meals, recipes).calories).toBe(2600);
    meals[0].sides = [{ recipeId: 'dinner', servings: 2 }];
    expect(plannedNutrition(meals, recipes, meals, 'per-serving').calories).toBe(1150);
  });
  it("combines four adult target slots and child slots without halving child targets", () => {
    const targets = {
      enabled: true,
      adults: Array.from({ length: 4 }, () => ({
        calories: 2000,
        protein: 90,
      })),
      children: [{ calories: 1200, protein: 40 }],
    };
    expect(
      householdTargets({
        sourceWeights: {},
        ingredientWeights: {},
        defaultAdults: 4,
        defaultChildren: 1,
        nutritionTargets: targets,
      }),
    ).toMatchObject({ complete: true, calories: 9200, protein: 400 });
    const reduced = householdTargets({
      sourceWeights: {},
      ingredientWeights: {},
      defaultAdults: 2,
      defaultChildren: 0,
      nutritionTargets: targets,
    });
    expect(reduced.calories).toBe(4000);
    expect(targets.adults).toHaveLength(4);
    expect(
      householdTargets({
        sourceWeights: {},
        ingredientWeights: {},
        defaultAdults: 5,
        defaultChildren: 1,
        nutritionTargets: targets,
      }).complete,
    ).toBe(false);
  });
  it("rejects invalid targets and defaults to disabled", () => {
    expect(normaliseTargets(undefined)).toEqual({
      enabled: false,
      adults: [],
      children: [],
    });
    expect(
      normaliseTargets({
        enabled: true,
        adults: [{ calories: Infinity, protein: -1 }],
        children: [],
      }),
    ).toMatchObject({ adults: [{}] });
  });
  it("counts eaten servings and sides, reserves extras for the leftover day, excludes skipped meals", () => {
    const cooking = meal("a", {
      servings: 4,
      allocatedPortions: 2,
      sides: [{ recipeId: "soup", servings: 1 }],
    });
    expect(
      plannedNutrition([cooking, meal("b", { status: "skipped" })], {
        soup: recipe,
      }),
    ).toMatchObject({ calories: 1000, protein: 50, incomplete: false });
    const leftover = meal("c", {
      kind: "leftover",
      sourceMealId: "a",
      status: "cooked",
    });
    expect(plannedNutrition([leftover], { soup: recipe }).calories).toBe(400);
    expect(plannedNutrition([leftover], { soup: recipe }, [
      meal("a", { overrides: [{}] }), leftover,
    ]).estimated).toBe(true);
  });
  it("keeps missing values unknown and marks eating out and substitutions", () => {
    expect(plannedNutrition([meal()], {})).toMatchObject({ incomplete: true });
    expect(plannedNutrition([meal()], {}).calories).toBeUndefined();
    expect(
      plannedNutrition([meal("a", { kind: "eating-out" })], {}).incomplete,
    ).toBe(true);
    expect(
      plannedNutrition([meal("a", { overrides: [{}] })], { soup: recipe })
        .estimated,
    ).toBe(true);
  });
});
