import { weekRange, shiftDate } from "../functions/src/connected/model";
export type TripPreset = "This Week" | "Next Week" | "Next 2 Weeks";
export function tripRange(preset: TripPreset, today?: string) {
  const current = weekRange(today);
  if (preset === "This Week") return current;
  const start = shiftDate(current.start, 7);
  return { start, end: shiftDate(start, preset === "Next Week" ? 6 : 13) };
}
