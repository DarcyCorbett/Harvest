export interface CookingTimer {
  id: string;
  label: string;
  endsAt: number;
  notificationId?: string;
  recipeId?: string;
  step?: number;
}
export function cookingTimerId(
  recipeId: string,
  step: number,
  durationIndex: number,
) {
  return `${recipeId}:${step}:${durationIndex}`;
}
export function addCookingTimer(
  session: CookingSession,
  timer: CookingTimer,
): CookingSession {
  return session.timers.some((t) => t.id === timer.id)
    ? session
    : { ...session, timers: [...session.timers, timer] };
}
export function resetCookingTimer(
  session: CookingSession,
  id: string,
): CookingSession {
  return { ...session, timers: session.timers.filter((t) => t.id !== id) };
}
export interface CookingSession {
  activeRecipeId: string;
  steps: Record<string, number>;
  checked: Record<string, number[]>;
  timers: CookingTimer[];
}
export function durationChoices(
  text: string,
): { label: string; seconds: number }[] {
  const matches = [
    ...text.matchAll(
      /\b(\d+(?:\.\d+)?)\s*(?:[-–]\s*(\d+(?:\.\d+)?)\s*)?(seconds?|secs?|minutes?|mins?|hours?|hrs?)\b/gi,
    ),
  ];
  return matches
    .map((m) => ({
      label: m[0],
      seconds:
        Number(m[2] ?? m[1]) *
        (/^h/i.test(m[3])
          ? 3600
          : /^m/i.test(m[3])
            ? 60
            : 1),
    }))
    .filter((t) => t.seconds > 0 && t.seconds <= 604800);
}
export function remainingSeconds(
  timer: CookingTimer,
  now = Date.now(),
): number {
  return Math.max(0, Math.ceil((timer.endsAt - now) / 1000));
}

/**
 * Running timers that are not shown as inline chips on the current step:
 * timers from other steps, from a side recipe in the same session, or
 * legacy timers saved without a recipe. They stay visible on every step.
 */
export function backgroundTimers(
  session: CookingSession,
  recipeId: string,
  step: number,
): (CookingTimer & { displayLabel: string })[] {
  return session.timers
    .filter((t) => !(t.recipeId === recipeId && t.step === step))
    .map((t) => ({
      ...t,
      displayLabel:
        t.recipeId === recipeId && typeof t.step === "number"
          ? `Step ${t.step + 1} · ${t.label}`
          : t.label,
    }));
}
/** Finishing returns the recipe to its first step for the next cook; timers keep running. */
export function finishCooking(
  session: CookingSession,
  recipeId: string,
): CookingSession {
  return { ...session, steps: { ...session.steps, [recipeId]: 0 } };
}
