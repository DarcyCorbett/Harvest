import { beforeEach, describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({
  records: new Map<string, any>(),
  transaction: vi.fn(),
}));
vi.mock("@/config/firebase", () => ({ db: {} }));
vi.mock("../services/connectedClient", () => ({ workflowCommand: vi.fn() }));
vi.mock("../services/legacyRecipeClient", () => ({ legacyRecipeClient: {} }));
vi.mock("../services/devLog", () => ({ logEvent: vi.fn() }));
vi.mock("firebase/firestore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("firebase/firestore")>()),
  doc: (_db: unknown, ...path: string[]) => path.join("/"),
  getDoc: async (ref: string) => ({
    exists: () => fixture.records.has(ref),
    data: () => fixture.records.get(ref),
  }),
  serverTimestamp: () => 123,
  setDoc: async (ref: string, data: any, options?: any) =>
    fixture.records.set(
      ref,
      options?.merge ? { ...fixture.records.get(ref), ...data } : data,
    ),
  runTransaction: async (_db: unknown, fn: any) => {
    fixture.transaction();
    return fn({
      get: async (ref: string) => ({ exists: () => fixture.records.has(ref) }),
      set: (ref: string, data: any) => fixture.records.set(ref, data),
      update: (ref: string, data: any) =>
        fixture.records.set(ref, { ...fixture.records.get(ref), ...data }),
    });
  },
}));
import {
  getHouseholdSettings,
  saveHouseholdSettings,
  toggleStarred,
  updateCookbookDetails,
} from "../services/firestoreService";
beforeEach(() => {
  fixture.records.clear();
  fixture.transaction.mockClear();
});
describe("cookbook writes", () => {
  it("creates a starred entry transactionally then retains it when unstarred", async () => {
    await toggleStarred("home", "new", true);
    expect(fixture.records.get("households/home/cookbook/new")).toEqual({
      recipeId: "new",
      starred: true,
      addedAt: 123,
    });
    await toggleStarred("home", "new", false);
    expect(fixture.records.get("households/home/cookbook/new").starred).toBe(
      false,
    );
    expect(fixture.transaction).toHaveBeenCalledTimes(2);
  });
  it("preserves notes, collection data and cooking history across favourites and notes edits", async () => {
    const ref = "households/home/cookbook/soup";
    fixture.records.set(ref, {
      recipeId: "soup",
      notes: "old",
      collections: ["Guests"],
      lastCookedAt: "2026-09-14",
    });
    await toggleStarred("home", "soup", true);
    await updateCookbookDetails("home", "soup", { notes: "new" });
    expect(fixture.records.get(ref)).toEqual({
      recipeId: "soup",
      starred: true,
      notes: "new",
      collections: ["Guests"],
      lastCookedAt: "2026-09-14",
    });
  });
});
describe("nutrition preferences persistence", () => {
  it("round trips active and inactive diner targets and survives an unrelated settings save", async () => {
    const nutritionTargets = {
      enabled: true,
      adults: [
        { calories: 2000, protein: 80 },
        { calories: 2200, protein: 90 },
        { calories: 1800, protein: 70 },
      ],
      children: [{ calories: 1200, protein: 30 }],
    };
    await saveHouseholdSettings("home", {
      sourceWeights: {},
      ingredientWeights: {},
      defaultAdults: 2,
      defaultChildren: 1,
      nutritionTargets,
    });
    const loaded = await getHouseholdSettings("home");
    expect(loaded.nutritionTargets).toEqual(nutritionTargets);
    await saveHouseholdSettings("home", {
      ...loaded,
      excludedIngredients: ["peanut"],
    });
    expect((await getHouseholdSettings("home")).nutritionTargets).toEqual(
      nutritionTargets,
    );
  });
});
