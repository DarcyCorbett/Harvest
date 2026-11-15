import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  addCookingTimer,
  backgroundTimers,
  cookingTimerId,
  durationChoices,
  finishCooking,
  remainingSeconds,
  resetCookingTimer,
  type CookingSession,
} from "../services/cookingSession";
describe("cooking progress", () => {
  it("prevents duplicate starts and resets to an idle timer without changing progress", () => {
    const initial: CookingSession = {
      activeRecipeId: "main",
      steps: { main: 2 },
      checked: { main: [0] },
      timers: [],
    };
    const timer = {
      id: cookingTimerId("main", 2, 0),
      label: "15 minutes",
      endsAt: 900000,
    };
    const started = addCookingTimer(initial, timer);
    expect(addCookingTimer(started, { ...timer, endsAt: 950000 })).toBe(
      started,
    );
    const restored = JSON.parse(JSON.stringify(started));
    expect(remainingSeconds(restored.timers[0], 890000)).toBe(10);
    expect(resetCookingTimer(restored, timer.id)).toEqual(initial);
    expect(cookingTimerId("side", 2, 0)).not.toBe(timer.id);
    expect(cookingTimerId("main", 3, 0)).not.toBe(timer.id);
  });
  it("finds useful timers without rewriting the source instruction", () => {
    const text = "Bake for 20–25 minutes, then rest 1 hour.";
    expect(durationChoices(text)).toEqual([
      { label: "20–25 minutes", seconds: 1500 },
      { label: "1 hour", seconds: 3600 },
    ]);
  });
  it("restores remaining time from a deadline instead of restarting", () => {
    const restored = JSON.parse(
      JSON.stringify({ id: "timer", label: "Bake", endsAt: 100000 }),
    );
    expect(remainingSeconds(restored, 95000)).toBe(5);
    expect(remainingSeconds(restored, 105000)).toBe(0);
  });
  it("parses common duration abbreviations without matching words like minced", () => {
    expect(durationChoices("Simmer 10 mins, rest 5 min, bake 1 hr, sear 30 secs.")).toEqual([
      { label: "10 mins", seconds: 600 },
      { label: "5 min", seconds: 300 },
      { label: "1 hr", seconds: 3600 },
      { label: "30 secs", seconds: 30 },
    ]);
    expect(durationChoices("Add 2 minced garlic cloves and 3 mint leaves.")).toEqual([]);
  });
  it("keeps running timers visible after moving to another step", () => {
    const session: CookingSession = {
      activeRecipeId: "main",
      steps: { main: 2 },
      checked: {},
      timers: [
        { id: cookingTimerId("main", 1, 0), label: "15 minutes", endsAt: 1, recipeId: "main", step: 1 },
        { id: cookingTimerId("main", 2, 0), label: "5 minutes", endsAt: 1, recipeId: "main", step: 2 },
        { id: cookingTimerId("side", 0, 0), label: "10 minutes", endsAt: 1, recipeId: "side", step: 0 },
        { id: "legacy", label: "Rest", endsAt: 1 },
      ],
    };
    // Step 3 (index 2) shows its own timer inline, so only the others are listed.
    expect(backgroundTimers(session, "main", 2).map((t) => [t.id, t.displayLabel])).toEqual([
      ["main:1:0", "Step 2 · 15 minutes"],
      ["side:0:0", "10 minutes"],
      ["legacy", "Rest"],
    ]);
    expect(backgroundTimers(session, "main", 1).map((t) => t.id)).toContain("main:2:0");
  });
  it("returns to the first step when cooking is finished, keeping timers", () => {
    const session: CookingSession = {
      activeRecipeId: "main",
      steps: { main: 4, side: 1 },
      checked: {},
      timers: [{ id: "t", label: "Rest", endsAt: 1 }],
    };
    expect(finishCooking(session, "main")).toEqual({ ...session, steps: { main: 0, side: 1 } });
  });
});
describe("cooking route exit", () => {
  it("offers Mark cooked after the last step, and closes /cook instead of leaving the recipe modal behind", () => {
    const modal = readFileSync("components/RecipeDetailModal.tsx", "utf8");
    expect(modal).toContain("onDone={() => { finishedCooking.current = true; }}");
    expect(modal).toMatch(/finishedCooking\.current && !!recipe\.id && recipe\.id === plannedMeal\?\.recipeId && plannedMeal\.status !== 'cooked'\) \{ setRecipeActions\(true\); return; \}/);
    expect(modal).toContain("if (initiallyCooking) onClose();");
    const drawer = readFileSync("components/connected/CookingDrawer.tsx", "utf8");
    expect(drawer).toMatch(/update\(\(s\) => finishCooking\(s, id\)\);\s*onDone\?\.\(\);\s*close\(\);/);
  });
});
