import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Crypto from "expo-crypto";
import { httpsCallable } from "firebase/functions";
import { functions } from "@/config/firebase";
export type {
  Meal,
  Workflow,
  Period,
  ListItem,
  Draft,
  DraftSlot,
} from "../functions/src/connected/model";
export {
  isoDate,
  shiftDate,
  weekRange,
  slotId,
  normaliseMeal,
} from "../functions/src/connected/model";

export function requestId(): string {
  return Crypto.randomUUID();
}
export async function workflowCommand<T = { ok: boolean }>(
  householdId: string,
  command: unknown,
  id = requestId(),
): Promise<T> {
  const response = await httpsCallable<unknown, T>(
    functions,
    "connectedCommand",
    { timeout: 120000 },
  )(
    JSON.parse(
      JSON.stringify({ householdId, requestId: id, clientVersion: 4, command }),
    ),
  );
  return response.data;
}
export const cacheKey = (household: string, user: string, name: string) =>
  `connected:v2:${household}:${user}:${name}`;
export interface PendingCheck {
  queuedAt?: number;
  id: string;
  command: unknown;
  error?: string;
  acknowledgedRevision?: number;
}
export async function readChecks(
  household: string,
  user: string,
): Promise<PendingCheck[]> {
  try {
    return JSON.parse(
      (await AsyncStorage.getItem(cacheKey(household, user, "checks"))) ?? "[]",
    );
  } catch {
    return [];
  }
}
export async function writeChecks(
  household: string,
  user: string,
  checks: PendingCheck[],
): Promise<void> {
  await AsyncStorage.setItem(
    cacheKey(household, user, "checks"),
    JSON.stringify(checks),
  );
}
