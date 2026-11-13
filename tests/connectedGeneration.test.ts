import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from 'node:crypto';
const mocks = vi.hoisted(() => ({
  mode: vi.fn(),
  recipe: vi.fn(),
  select: vi.fn(),
  scrape: vi.fn(),
  save: vi.fn(),
}));
vi.mock("../services/firestoreService", () => ({
  getCatalogueGenerationMode: mocks.mode,
  getRecipe: mocks.recipe,
  getGenerationRecipeHistory: async () => ({
    currentPlanRecipeIds: [],
    recentRecipeIds: [],
  }),
}));
vi.mock("../services/connectedClient", async () => ({
  ...(await import("../functions/src/connected/model")),
  requestId: () => randomUUID(),
  workflowCommand: mocks.save,
}));
vi.mock("../services/catalogueClient", () => ({
  catalogueClient: { select: mocks.select },
  buildCatalogueSelectionRequestForSlots: (
    config: any,
    householdId: string,
    slots: any[],
  ) => ({
    householdId,
    slots: slots.map((s) => ({
      ...s,
      ingredients: config.ingredientFilters,
      cuisines: [],
    })),
  }),
}));
vi.mock("../services/recipeScraperService", () => ({
  scrapeRecipe: mocks.scrape,
  isVegetarian: () => true,
  isHealthy: () => true,
  isKidFriendly: () => true,
  isCourseCompatible: () => true,
  matchesWord: (value: string, term: string) => value.includes(term),
}));
import {
  createDraft,
  fillDraft,
  matchesDraftSlot,
} from "../services/connectedGeneration";
import type { Recipe } from "../services/types";
const recipe = (id: string): Recipe => ({
  id,
  schemaVersion: 2,
  catalogueStatus: "ready",
  title: id,
  sourceUrl: "https://www.recipetineats.com/soup/",
  ingredients: [{ name: "tomato", quantity: 1, unit: "g" }],
  originalServings: 2,
  prepTime: "10 min",
  cookTime: "10 min",
  instructions: [{ text: "Cook." }],
  notes: "",
  scrapedAt: new Date(),
  course: ["Dinner"],
});
const config = {
  adults: 2,
  children: 0,
  styles: [],
  prefer: [],
  exclude: [],
  must: [],
  mustScope: "plan" as const,
  favouriteCount: 0,
  leftovers: false,
};
const settings = { sourceWeights: {}, ingredientWeights: {} };
const draft = () =>
  createDraft(
    Array.from({ length: 5 }, (_, i) => ({
      date: `2026-09-${14 + i}`,
      mealType: "dinner",
      maxMinutes: 30 as const,
    })),
    config,
    [],
  );
beforeEach(() => {
  vi.clearAllMocks();
  mocks.mode.mockResolvedValue("catalogue");
  mocks.recipe.mockImplementation(async (id: string) => recipe(id));
  mocks.save.mockImplementation(async (_h: string, { draft }: any) => ({
    draft: JSON.parse(
      JSON.stringify({ ...draft, revision: draft.revision + 1 }),
    ),
  }));
  mocks.select.mockImplementation(async (request: any) => ({
    slots: [
      {
        ...request.slots[0],
        status: "selected",
        recipeId: request.slots[0].date,
      },
    ],
  }));
});
describe("persisted connected generation", () => {
  it("uses stars for recipe preferences and ignores retired make-again feedback", async () => {
    const cookbook = [
      { recipeId: "favourite", starred: true, makeAgain: false },
      { recipeId: "old-positive", starred: false, makeAgain: true },
      { recipeId: "old-negative", starred: false, makeAgain: false },
      { recipeId: "high-effort", starred: false, effort: "too much" },
    ].map((entry) => ({ ...entry, addedAt: new Date() }));
    await fillDraft(draft(), "home", settings, cookbook, () => {});
    const ranking = mocks.select.mock.calls[0][0].ranking;
    expect(ranking.preferredRecipeIds).toEqual(["favourite"]);
    expect(ranking.depreferredRecipeIds).toEqual(["high-effort"]);
  });

  it("retains four successful meals and a failed slot through a serialized restart", async () => {
    mocks.select.mockImplementation(async (request: any) => {
      if (request.slots[0].date === "2026-09-16")
        throw Error("Source unavailable");
      return {
        slots: [
          {
            ...request.slots[0],
            status: "selected",
            recipeId: request.slots[0].date,
          },
        ],
      };
    });
    const saved = await fillDraft(draft(), "home", settings, [], () => {});
    const restored = JSON.parse(JSON.stringify(saved));
    expect(
      restored.slots.filter((s: any) => s.status === "ready"),
    ).toHaveLength(4);
    expect(restored.slots[2].status).toBe("failed");
    expect(mocks.save).toHaveBeenCalledTimes(5);
  });
  it("retries only the failed slot and never calls the legacy engine", async () => {
    const input = draft();
    input.slots = input.slots.map((s, i) => ({
      ...s,
      status: i === 2 ? "failed" : "ready",
      recipeId: i === 2 ? undefined : `r${i}`,
    }));
    const saved = await fillDraft(input, "home", settings, [], () => {}, [
      input.slots[2].id,
    ]);
    expect(mocks.select).toHaveBeenCalledTimes(1);
    expect(mocks.scrape).not.toHaveBeenCalled();
    expect(saved.slots[0].recipeId).toBe("r0");
  });
  it("omits an Any time limit and clears cuisine preferences for one retry", async () => {
    const input = createDraft(
      [{ date: "2026-09-14", mealType: "dinner" }],
      { ...config, styles: ["Italian"] },
      [],
    );
    input.slots[0].allowAnyCuisine = true;
    await fillDraft(input, "home", settings, [], () => {}, [input.slots[0].id]);
    const request = mocks.select.mock.calls[0][0];
    expect(request.slots[0]).not.toHaveProperty("maxTotalMinutes");
    expect(request.slots[0].cuisines).toEqual([]);
  });
  it("preserves keep locks and removed slots during bulk regeneration", async () => {
    const input = draft();
    input.slots[0] = {
      ...input.slots[0],
      locked: true,
      status: "ready",
      recipeId: "kept",
    };
    input.slots[1].removed = true;
    const saved = await fillDraft(input, "home", settings, [], () => {});
    expect(mocks.select).toHaveBeenCalledTimes(3);
    expect(saved.slots[0].recipeId).toBe("kept");
    expect(saved.slots[1].removed).toBe(true);
  });
  it("keeps household exclusions in requests and in favourite eligibility", async () => {
    await fillDraft(
      draft(),
      "home",
      { ...settings, excludedIngredients: ["nuts"] },
      [],
      () => {},
    );
    expect(mocks.select.mock.calls[0][0].slots[0].ingredients.exclude).toEqual([
      "nuts",
    ]);
    expect(
      matchesDraftSlot(recipe("a"), draft().slots[0], config, {
        ...settings,
        excludedIngredients: ["tomato"],
      }),
    ).toBe(false);
  });
  it("preserves the operator-controlled legacy boundary on failure", async () => {
    mocks.mode.mockResolvedValue("legacy");
    mocks.scrape.mockRejectedValue(Error("Unavailable"));
    const saved = await fillDraft(draft(), "home", settings, [], () => {});
    expect(saved.slots.every((s) => s.status === "failed")).toBe(true);
    expect(mocks.select).not.toHaveBeenCalled();
  });
  it("defaults required ingredients to somewhere, while every-recipe applies each term to all slots", () => {
    const slots = draft().slots;
    const somewhere = createDraft(
      slots,
      { ...config, must: ["tomato", "lemon"] },
      [],
    );
    expect(somewhere.slots.flatMap((s) => s.must ?? [])).toEqual([
      "tomato",
      "lemon",
    ]);
    const every = createDraft(
      slots,
      { ...config, must: ["tomato"], mustScope: "recipe" },
      [],
    );
    expect(every.slots.every((s) => s.must?.includes("tomato"))).toBe(true);
  });
});
