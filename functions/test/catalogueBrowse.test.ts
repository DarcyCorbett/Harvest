import { describe, expect, it, vi } from "vitest";
import {
  browseCatalogue,
  browseSchema,
  matchesBrowse,
} from "../src/catalogue/browse.js";
import { SOURCE_CONFIGS } from "../src/catalogue/sourceAdapters.js";

function fixture(count: number, exclude = false) {
  const first = SOURCE_CONFIGS[0];
  const settings = {
    sourceWeights: Object.fromEntries(
      SOURCE_CONFIGS.map((s) => [
        s.host.replace(/\./g, "_"),
        s === first ? 1 : 0,
      ]),
    ),
    excludedIngredients: exclude ? ["peanuts"] : [],
  };
  const docs = Array.from({ length: count }, (_, i) => ({
    id: `recipe-${String(i).padStart(3, "0")}`,
    data: () => ({
      schemaVersion: 2,
      status: "ready",
      source: { key: first.sourceKey },
      content: { title: `Meal ${i}` },
      effective: {
        mealTypes: ["dinner"],
        cuisines: ["italian"],
        totalMinutes: 20,
      },
      search: {
        randomKey: i,
        ingredientTokens: i < 125 ? ["peanut"] : ["tomato"],
        selectionKeys: ["dinner|any", "dinner|italian"],
      },
    }),
  }));
  let after = -1,
    maximum = 0;
  const query: any = {
    where: () => query,
    orderBy: () => query,
    select: () => query,
    limit: (n: number) => {
      maximum = n;
      return query;
    },
    startAfter: (key: number) => {
      after = key;
      return query;
    },
    get: vi.fn(async () => {
      const batch = docs
        .filter((d) => d.data().search.randomKey > after)
        .slice(0, maximum);
      after = -1;
      return { docs: batch, size: batch.length };
    }),
  };
  const preferences = { get: async () => ({ data: () => settings }) };
  const household = { collection: () => ({ doc: () => preferences }) };
  const db: any = {
    collection: (name: string) =>
      name === "recipes" ? query : { doc: () => household },
  };
  return { db, query, settings };
}
describe("bounded catalogue browsing", () => {
  it("validates limits and matches all selected filters and exclusions", () => {
    expect(
      browseSchema.safeParse({
        householdId: "h",
        mealType: "dinner",
        pageSize: 100,
      }).success,
    ).toBe(false);
    const candidate = {
      effective: { mealTypes: ["dinner"], cuisines: ["italian"] },
      search: { ingredientTokens: ["tomato", "rice"] },
    };
    expect(matchesBrowse(candidate, "dinner", "italian", ["tomato"], [])).toBe(
      true,
    );
    expect(matchesBrowse(candidate, "lunch", "italian", [], [])).toBe(false);
    expect(matchesBrowse(candidate, "dinner", "greek", [], [])).toBe(false);
    expect(matchesBrowse(candidate, "dinner", undefined, [], ["rice"])).toBe(
      false,
    );
  });
  it("continues from the last examined document without losing or duplicating matches", async () => {
    const { db } = fixture(25);
    const first = await browseCatalogue(
      { householdId: "h", mealType: "dinner", pageSize: 20 },
      db,
    );
    const second = await browseCatalogue(
      { householdId: "h", mealType: "dinner", cursor: first.nextCursor },
      db,
    );
    expect(first.recipes).toHaveLength(20);
    expect(second.recipes).toHaveLength(5);
    expect(
      new Set([...first.recipes, ...second.recipes].map((r) => r.id)).size,
    ).toBe(25);
    expect(second.nextCursor).toBeUndefined();
  });
  it("returns continuation after a bounded empty scan and finds later eligible recipes", async () => {
    const { db, query } = fixture(130, true);
    const first = await browseCatalogue(
      { householdId: "h", mealType: "dinner" },
      db,
    );
    expect(first.recipes).toEqual([]);
    expect(first.nextCursor).toBeTruthy();
    expect(query.get).toHaveBeenCalledTimes(3);
    const second = await browseCatalogue(
      { householdId: "h", mealType: "dinner", cursor: first.nextCursor },
      db,
    );
    expect(second.recipes).toHaveLength(5);
    expect(second.nextCursor).toBeUndefined();
  });
  it("binds continuation to household preferences and filters", async () => {
    const { db, settings } = fixture(50);
    const first = await browseCatalogue(
      { householdId: "h", mealType: "dinner" },
      db,
    );
    await expect(
      browseCatalogue(
        { householdId: "h", mealType: "lunch", cursor: first.nextCursor },
        db,
      ),
    ).rejects.toMatchObject({ code: "failed-precondition" });
    settings.excludedIngredients = ["tomato"];
    await expect(
      browseCatalogue(
        { householdId: "h", mealType: "dinner", cursor: first.nextCursor },
        db,
      ),
    ).rejects.toMatchObject({ code: "failed-precondition" });
  });
  it("does not query disabled sources and rejects malformed cursors", async () => {
    const { db, query, settings } = fixture(50);
    Object.keys(settings.sourceWeights).forEach(
      (k) => (settings.sourceWeights[k] = 0),
    );
    expect(
      await browseCatalogue({ householdId: "h", mealType: "dinner" }, db),
    ).toEqual({ recipes: [] });
    expect(query.get).not.toHaveBeenCalled();
    await expect(
      browseCatalogue(
        { householdId: "h", mealType: "dinner", cursor: "garbage" },
        db,
      ),
    ).rejects.toMatchObject({ code: "invalid-argument" });
  });
});
