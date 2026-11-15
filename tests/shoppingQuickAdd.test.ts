import { describe, expect, it } from "vitest";
import { QUICK_ADD_BY_CATEGORY, QUICK_ADD_ITEMS } from "../constants/shoppingQuickAdd";

describe("shopping quick-add catalogue", () => {
  it("keeps categories unique and includes spice and frozen starters", () => {
    expect(new Set(QUICK_ADD_ITEMS.map((section) => section.category)).size).toBe(QUICK_ADD_ITEMS.length);
    expect(QUICK_ADD_BY_CATEGORY["Herbs & Spices"]).toContain("Ginger");
    expect(QUICK_ADD_BY_CATEGORY.Frozen).toContain("Frozen peas");
  });
});

describe("quick-add choices", () => {
  it("shows an aisle's own staples, and common staples from every aisle on Other", async () => {
    const { quickAddChoices } = await import("../constants/shoppingQuickAdd");
    expect(quickAddChoices("Produce")).toEqual({ title: "Quick add from Produce", items: ["Bananas", "Apples", "Pears", "Cucumbers"].map((name) => ({ name, category: "Produce" })) });
    const other = quickAddChoices("Other");
    expect(other.title).toBe("Quick add staples");
    expect(other.items).toContainEqual({ name: "Milk", category: "Dairy & Eggs" });
    expect(other.items).toContainEqual({ name: "Bread", category: "Bread & Bakery" });
    expect(new Set(other.items.map((i) => i.category)).size).toBe(QUICK_ADD_ITEMS.length);
  });
});
