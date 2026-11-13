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
      /\b(\d+(?:\.\d+)?)\s*(?:[-–]\s*(\d+(?:\.\d+)?)\s*)?(seconds?|minutes?|hours?)\b/gi,
    ),
  ];
  return matches
    .map((m) => ({
      label: m[0],
      seconds:
        Number(m[2] ?? m[1]) *
        (m[3].toLowerCase().startsWith("hour")
          ? 3600
          : m[3].toLowerCase().startsWith("minute")
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
