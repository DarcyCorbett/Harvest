import { describe, expect, it } from "vitest";
import {
  addCookingTimer,
  cookingTimerId,
  durationChoices,
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
});
