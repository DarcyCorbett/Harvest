import { describe, expect, it } from "vitest";
import {
  buildRequirements,
  normaliseMeal,
  reconcileItems,
  setItemAction,
  weekRange,
  type RecipeInput,
  type ListItem,
} from "../src/connected/model.js";
const meal = normaliseMeal("2026-09-07_dinner", {
  date: "2026-09-07",
  mealType: "dinner",
  recipeId: "chicken",
  servings: 2,
});
const recipe: RecipeInput = {
  id: "chicken",
  title: "Chicken",
  originalServings: 2,
  ingredients: [{ name: "Chicken stock", quantity: 1, unit: "cup" }],
};
const period = { start: "2026-09-07", end: "2026-09-13" };
const requirements = () =>
  buildRequirements([meal], { chicken: recipe }, period);
describe("connected shopping requirements", () => {
  it("scales contributions and preserves compatible unit conversion", () => {
    const rows = buildRequirements(
      [meal, { ...meal, id: "2026-09-08_dinner", date: "2026-09-08" }],
      { chicken: recipe },
      period,
    );
    expect(rows[0].quantity).toBeCloseTo(473.176);
    expect(rows[0].contributions).toHaveLength(2);
  });
  it("does not infer stock when purchased requirements increase", () => {
    const old = setItemAction(reconcileItems([], requirements())[0], "check");
    const next = reconcileItems(
      [old],
      buildRequirements(
        [{ ...meal, servings: 4 }],
        { chicken: recipe },
        period,
      ),
    )[0];
    expect(next.checked).toBe(true);
    expect(next.review).toBe(true);
    expect(next.reviewedQuantity).toBe(old.quantity);
    expect(setItemAction(next, "check").review).toBe(false);
  });
  it("removes obsolete unpurchased requirements and preserves purchases and manual goods", () => {
    const rows = reconcileItems([], requirements());
    const manual = { ...rows[0], id: "manual", manual: true } as ListItem;
    expect(reconcileItems([...rows, manual], [])).toEqual([manual]);
    const checked = setItemAction(rows[0], "check");
    expect(reconcileItems([checked], [])[0].obsolete).toBe(true);
  });
  it("keeps not-needed decisions until quantity changes", () => {
    const old = setItemAction(reconcileItems([], requirements())[0], "dismiss");
    expect(reconcileItems([old], requirements())[0].dismissed).toBe(true);
    expect(
      reconcileItems(
        [old],
        buildRequirements(
          [{ ...meal, servings: 3 }],
          { chicken: recipe },
          period,
        ),
      )[0].dismissed,
    ).toBe(false);
  });
  it("counts reserved leftovers only once and rejects over-allocation", () => {
    const source = { ...meal, allocatedPortions: 2 };
    const leftover = {
      ...meal,
      id: "2026-09-08_lunch",
      date: "2026-09-08",
      mealType: "lunch",
      kind: "leftover" as const,
      sourceMealId: meal.id,
    };
    expect(
      buildRequirements([source, leftover], { chicken: recipe }, period)[0]
        .quantity,
    ).toBeCloseTo(473.176);
    expect(() =>
      buildRequirements([meal, leftover], { chicken: recipe }, period),
    ).toThrow("exceed");
    expect(() =>
      buildRequirements(
        [{ ...source, status: "removed" }, leftover],
        { chicken: recipe },
        period,
      ),
    ).toThrow("earlier");
  });
  it("uses overrides only for their occurrence and keeps incompatible units separate", () => {
    const r = {
      ...recipe,
      ingredients: [
        ...recipe.ingredients,
        { name: "Chicken stock", quantity: 20, unit: "g" },
      ],
    };
    expect(buildRequirements([meal], { chicken: r }, period)).toHaveLength(2);
    const changed = {
      ...meal,
      overrides: [
        {
          recipeId: "chicken",
          ingredientIndex: 0,
          replacement: { name: "Vegetable stock", quantity: 500, unit: "ml" },
          adjustment: "Use instead",
        },
      ],
    };
    expect(
      buildRequirements([changed], { chicken: recipe }, period)[0].name,
    ).toBe("vegetable stock");
    expect(recipe.ingredients[0].name).toBe("Chicken stock");
  });
  it("uses local Monday–Sunday periods across year boundaries", () =>
    expect(weekRange("2027-01-01")).toEqual({
      start: "2026-12-28",
      end: "2027-01-03",
    }));
  it("rescales meal-specific substitutions after resizing without changing the source", () => {
    const replacement = {
      recipeId: "chicken",
      ingredientIndex: 0,
      replacement: { name: "Vegetable stock", quantity: 300, unit: "ml" },
      adjustment: "Same method",
      forServings: 2,
    };
    const rows = buildRequirements(
      [{ ...meal, servings: 4, overrides: [replacement] }],
      { chicken: recipe },
      period,
    );
    expect(rows[0].quantity).toBe(600);
    expect(recipe.ingredients[0].quantity).toBe(1);
  });
  it("does not invalidate shopping edits for unchanged contributions", () => {
    const previous = reconcileItems([], requirements());
    expect(reconcileItems(previous, requirements())[0].revision).toBe(
      previous[0].revision,
    );
  });
  it("flags a changed leftover recipe source", () => {
    const source = { ...meal, recipeId: "new", allocatedPortions: 2 };
    const leftover = {
      ...meal,
      id: "2026-09-08_dinner",
      date: "2026-09-08",
      kind: "leftover" as const,
      sourceMealId: meal.id,
    };
    expect(() =>
      buildRequirements([source, leftover], { chicken: recipe }, period),
    ).toThrow("source recipe changed");
  });
  it("transitions legacy 'of ' prefixed keys and preserves checked and revision state", () => {
    const legacyItem: ListItem = {
      id: "of%20white%20pepper%7Cdash",
      name: "of white pepper",
      quantity: 1,
      unit: "dash",
      category: "Herbs & Spices",
      checked: true,
      manual: false,
      revision: 3,
      contributions: [],
    };
    const req = {
      id: "white%20pepper%7Cdash",
      name: "white pepper",
      quantity: 1,
      unit: "dash",
      category: "Herbs & Spices",
      contributions: [{ mealId: "m1", recipeId: "r1", title: "R1", quantity: 1 }],
    };
    const result = reconcileItems([legacyItem], [req]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "white%20pepper%7Cdash",
      name: "white pepper",
      checked: true,
      revision: 4,
      obsolete: false,
    });
  });
  it("handles collision when both legacy and normalized keys exist", () => {
    const legacyItem: ListItem = {
      id: "of%20white%20pepper%7Cdash",
      name: "of white pepper",
      quantity: 1,
      unit: "dash",
      category: "Herbs & Spices",
      checked: true,
      manual: false,
      revision: 2,
      contributions: [],
    };
    const exactItem: ListItem = {
      id: "white%20pepper%7Cdash",
      name: "white pepper",
      quantity: 1,
      unit: "dash",
      category: "Herbs & Spices",
      checked: false,
      manual: false,
      revision: 1,
      contributions: [],
    };
    const req = {
      id: "white%20pepper%7Cdash",
      name: "white pepper",
      quantity: 2,
      unit: "dash",
      category: "Herbs & Spices",
      contributions: [{ mealId: "m1", recipeId: "r1", title: "R1", quantity: 2 }],
    };
    const result = reconcileItems([legacyItem, exactItem], [req]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "white%20pepper%7Cdash",
      name: "white pepper",
      checked: true,
      revision: 3,
      obsolete: false,
    });

    // Idempotent on subsequent reconciliation
    const secondPass = reconcileItems(result, [req]);
    expect(secondPass).toHaveLength(1);
    expect(secondPass[0].revision).toBe(result[0].revision);
  });
});
