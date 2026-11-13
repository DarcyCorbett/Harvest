import { describe, expect, it } from "vitest";
import { QUICK_ADD_BY_CATEGORY, QUICK_ADD_ITEMS } from "../constants/shoppingQuickAdd";

describe("shopping quick-add catalogue", () => {
  it("keeps categories unique and includes spice and frozen starters", () => {
    expect(new Set(QUICK_ADD_ITEMS.map((section) => section.category)).size).toBe(QUICK_ADD_ITEMS.length);
    expect(QUICK_ADD_BY_CATEGORY["Herbs & Spices"]).toContain("Ginger");
    expect(QUICK_ADD_BY_CATEGORY.Frozen).toContain("Frozen peas");
  });
});
