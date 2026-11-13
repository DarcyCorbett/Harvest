import { describe, expect, it } from "vitest";
import {
  ingredientOccurrences,
  ingredientsForStep,
} from "../services/stepIngredients";
import type { Recipe } from "../services/types";
import type { Meal } from "../services/connectedClient";

const carrots = { name: "carrots", quantity: 2, unit: "whole" };
const sauceCarrots = { name: "carrots", quantity: 100, unit: "g" };
const onions = { name: "onions", quantity: 1, unit: "whole" };
const powder = { name: "onion powder", quantity: 1, unit: "tsp" };
const recipe = {
  id: "dish",
  originalServings: 2,
  ingredients: [carrots, sauceCarrots, onions, powder],
  ingredientGroups: [
    { name: "Main", ingredients: [carrots, onions] },
    { name: "Sauce", ingredients: [sauceCarrots, powder] },
  ],
} as Recipe;

describe("explicit step ingredients", () => {
  it("preserves both carrot occurrences and groups with scaled quantities", () => {
    const matches = ingredientsForStep(
      "Chop the carrots.",
      ingredientOccurrences(recipe, 4),
    );
    expect(
      matches.map((m) => [
        m.index,
        m.group,
        m.ingredient.quantity,
        m.ingredient.unit,
      ]),
    ).toEqual([
      [0, "Main", 4, "whole"],
      [1, "Sauce", 200, "g"],
    ]);
  });
  it("matches singular forms without finding unrelated ingredients", () => {
    expect(
      ingredientsForStep(
        "Chop the onion.",
        ingredientOccurrences(recipe, 2),
      ).map((i) => i.index),
    ).toEqual([2, 3]);
    expect(
      ingredientsForStep("Preheat the oven.", ingredientOccurrences(recipe, 2)),
    ).toEqual([]);
  });
  it("shows all whole-word ingredient matches without matching substrings", () => {
    expect(
      ingredientsForStep(
        "Add onion powder.",
        ingredientOccurrences(recipe, 2),
      ).map((i) => i.index),
    ).toEqual([2, 3]);
    expect(
      ingredientsForStep(
        "Stir the scallions.",
        ingredientOccurrences(recipe, 2),
      ),
    ).toEqual([]);
  });
  it("matches a shorter step name to a qualified ingredient", () => {
    const ginger = {
      ...recipe,
      ingredients: [{ name: "ground ginger", quantity: 1, unit: "tsp" }],
      ingredientGroups: undefined,
    };
    expect(
      ingredientsForStep("Add the cumin, garlic powder and ginger.", ingredientOccurrences(ginger, 2)),
    ).toHaveLength(1);
  });
  it("matches original instruction names but displays only the selected occurrence override", () => {
    const meal = {
      overrides: [
        {
          recipeId: "dish",
          ingredientIndex: 1,
          forServings: 4,
          replacement: { name: "parsnips", quantity: 300, unit: "g" },
          adjustment: "Slice thinly",
        },
      ],
    } as Meal;
    const matches = ingredientsForStep(
      "Stir the carrots.",
      ingredientOccurrences(recipe, 2, meal),
    );
    expect(
      matches.map((m) => [m.ingredient.name, m.ingredient.quantity]),
    ).toEqual([
      ["carrots", 2],
      ["parsnips", 150],
    ]);
    expect(matches[1].ingredient.notes).toContain("Slice thinly");
    expect(recipe.ingredients[1]).toEqual(sauceCarrots);
  });
  it("keeps identical duplicate occurrences distinct", () => {
    const same = {
      ...recipe,
      ingredients: [carrots, { ...carrots }],
      ingredientGroups: [
        { name: "A", ingredients: [carrots] },
        { name: "B", ingredients: [{ ...carrots }] },
      ],
    };
    expect(ingredientOccurrences(same, 2).map((o) => o.index)).toEqual([0, 1]);
  });
  it("displays only grouped ingredients and does not guess an unknown index", () => {
    const partial = {
      ...recipe,
      ingredientGroups: [
        {
          name: "Main",
          ingredients: [
            carrots,
            { name: "pepper", quantity: 1, unit: "pinch" },
          ],
        },
      ],
    };
    expect(ingredientOccurrences(partial, 2).map((o) => o.index)).toEqual([
      0, -1,
    ]);
  });
  it("does not invent half-step quantities", () => {
    const matches = ingredientsForStep(
      "Add half the carrots.",
      ingredientOccurrences(recipe, 2),
    );
    expect(matches.map((m) => m.ingredient.quantity)).toEqual([2, 100]);
  });
  it("handles preparation qualifiers and common irregular plurals", () => {
    const tomatoes = {
      ...recipe,
      ingredients: [{ name: "fresh tomatoes, diced", quantity: 3, unit: "" }],
      ingredientGroups: undefined,
    };
    expect(
      ingredientsForStep(
        "Slice the tomato.",
        ingredientOccurrences(tomatoes, 2),
      ),
    ).toHaveLength(1);
  });
  it("reserves exact matches before weaker matches even when a weaker candidate appears first", () => {
    const root = [
      { name: "salt", quantity: 1, unit: "tsp", notes: "kosher" },
      { name: "salt", quantity: 1, unit: "tsp", notes: "table" },
    ];
    const grouped = [
      {
        name: "Main",
        ingredients: [
          { name: "salt", quantity: 1, unit: "tsp", notes: "fine table salt" }, // weaker match for root[1]
          { name: "salt", quantity: 1, unit: "tsp", notes: "kosher" }, // exact match for root[0]
        ],
      },
    ];
    const rec = { ...recipe, ingredients: root, ingredientGroups: grouped };
    const occurrences = ingredientOccurrences(rec, 2);
    expect(occurrences.map((o) => o.index)).toEqual([1, 0]);
  });
  it("preserves root indices and meal substitutions when groups are reordered", () => {
    const root = [carrots, sauceCarrots, onions, powder];
    const reorderedGroups = [
      { name: "Sauce", ingredients: [sauceCarrots, powder] },
      { name: "Main", ingredients: [carrots, onions] },
    ];
    const meal = {
      overrides: [
        {
          recipeId: "dish",
          ingredientIndex: 1, // sauceCarrots
          forServings: 2,
          replacement: { name: "parsnips", quantity: 100, unit: "g" },
          adjustment: "Substitute for sauce",
        },
      ],
    } as Meal;
    const occurrences = ingredientOccurrences(
      { ...recipe, ingredients: root, ingredientGroups: reorderedGroups },
      2,
      meal,
    );
    expect(occurrences.map((o) => o.index)).toEqual([1, 3, 0, 2]);
    expect(occurrences[0].ingredient.name).toBe("parsnips");
    expect(occurrences[2].ingredient.name).toBe("carrots");
  });
  it("uses grouped ingredients when equal-length lists contain different ingredients", () => {
    const rec = {
      ...recipe,
      ingredients: [
        { name: "salt", quantity: 1, unit: "pinch" },
        { name: "pepper", quantity: 1, unit: "pinch" },
      ],
      ingredientGroups: [
        {
          name: "Main",
          ingredients: [
            { name: "salt", quantity: 1, unit: "pinch" },
            { name: "oil", quantity: 1, unit: "tbsp" },
          ],
        },
      ],
    };
    const occurrences = ingredientOccurrences(rec, 2);
    // Salt keeps its substitution index; grouped oil is displayed and flat-only pepper is ignored.
    expect(occurrences.map((o) => [o.index, o.original.name, o.group])).toEqual([
      [0, "salt", "Main"],
      [-1, "oil", "Main"],
    ]);
  });
  it("keeps ambiguous candidate matches separate without inventing a correspondence", () => {
    const rec = {
      ...recipe,
      ingredients: [
        { name: "salt", quantity: 1, unit: "tsp", notes: "for boiling" },
        { name: "salt", quantity: 1, unit: "tsp", notes: "for seasoning" },
      ],
      ingredientGroups: [
        {
          name: "A",
          ingredients: [
            { name: "salt", quantity: 1, unit: "tsp", notes: "note A" },
          ],
        },
        {
          name: "B",
          ingredients: [
            { name: "salt", quantity: 1, unit: "tsp", notes: "note B" },
          ],
        },
      ],
    };
    const occurrences = ingredientOccurrences(rec, 2);
    // 2 in root and 2 in grouped, but all notes differ -> ambiguous! Neither should be matched.
    expect(occurrences.map((o) => o.index)).toEqual([-1, -1]);
  });
  it("reconciles Egg Foo Young fixture without duplicating prawn or pork at the bottom", () => {
    const rootIngredients = [
      { name: "cornflour / corn starch", quantity: 4, unit: "tsp" },
      { name: "light soy sauce", quantity: 1.5, unit: "tbsp", notes: "or all purpose (Note 2)" },
      { name: "Oyster Sauce", quantity: 2, unit: "tsp" },
      { name: "Chinese Cooking Wine", quantity: 1, unit: "tbsp", notes: "shaoxing wine; OR Mirin (Note 3)" },
      { name: "sesame oil", quantity: 0.5, unit: "tsp" },
      { name: "water", quantity: 250, unit: "ml" },
      { name: "white pepper", quantity: 0, unit: "dash" },
      { name: "eggs", quantity: 6, unit: "" },
      { name: "bean sprouts", quantity: 2, unit: "cup", notes: "just eyeball it" },
      { name: "shallots/green onions", quantity: 4, unit: "", notes: "white part only, sliced" },
      { name: "Salt and white pepper", quantity: 0, unit: "" },
      { name: "vegetable oil", quantity: 2, unit: "tbsp" },
      { name: "sesame oil", quantity: 1, unit: "tsp" },
      { name: "garlic", quantity: 1, unit: "clove", notes: "finely chopped" },
      { name: "ONE Filling of Choice", quantity: 0, unit: "", notes: "below (Prawn or Pork)" },
      { name: "chopped raw small prawns/shrimp", quantity: 100, unit: "g", notes: "peeled and deveined (Note 4)" },
      { name: "ground/mince pork", quantity: 100, unit: "g", notes: "or chicken, turkey, beef or veal" },
      { name: "EACH soy sauce and Oyster Sauce", quantity: 0.5, unit: "tsp" },
      { name: "sugar", quantity: 0.25, unit: "tsp" },
      { name: "sesame oil", quantity: 0, unit: "dash" },
      { name: "Sesame seeds", quantity: 0, unit: "", notes: "sliced green onion" },
    ];
    const domGroups = [
      {
        name: "Sauce",
        ingredients: [
          { name: "cornflour / corn starch", quantity: 4, unit: "tsp" },
          { name: "light soy sauce", quantity: 1.5, unit: "tbsp", notes: "or all purpose (Note 2)" },
          { name: "Oyster Sauce", quantity: 2, unit: "tsp" },
          { name: "Chinese Cooking Wine", quantity: 1, unit: "tbsp", notes: "shaoxing wine; Note 3" },
          { name: "sesame oil", quantity: 0.5, unit: "tsp" },
          { name: "water", quantity: 250, unit: "ml" },
          { name: "white pepper", quantity: 0, unit: "dash" },
        ],
      },
      {
        name: "Omelette",
        ingredients: [
          { name: "eggs", quantity: 6, unit: "" },
          { name: "bean sprouts", quantity: 2, unit: "cup", notes: "just eyeball it" },
          { name: "shallots/green onions", quantity: 4, unit: "", notes: "white part only, sliced" },
          { name: "Salt and white pepper", quantity: 0, unit: "" },
          { name: "vegetable oil", quantity: 2, unit: "tbsp" },
          { name: "sesame oil", quantity: 1, unit: "tsp" },
          { name: "garlic", quantity: 1, unit: "clove", notes: "finely chopped" },
          { name: "ONE Filling of Choice", quantity: 0, unit: "", notes: "below (Prawn or Pork)" },
        ],
      },
      {
        name: "Option 1: For Prawn /Shrimp Egg Foo Young",
        ingredients: [
          { name: "chopped raw small prawns/shrimp", quantity: 100, unit: "g", notes: "Note 4; peeled and deveined" },
        ],
      },
      {
        name: "Option 2: For Pork Egg Foo Young",
        ingredients: [
          { name: "ground/mince pork", quantity: 100, unit: "g", notes: "or chicken, turkey, beef or veal" },
          { name: "EACH soy sauce and Oyster Sauce", quantity: 0.5, unit: "tsp" },
          { name: "sugar", quantity: 0.25, unit: "tsp" },
          { name: "sesame oil", quantity: 0, unit: "dash" },
        ],
      },
      {
        name: "Garnish",
        ingredients: [
          { name: "Sesame seeds", quantity: 0, unit: "", notes: "sliced green onion" },
        ],
      },
    ];

    const efyRecipe = {
      ...recipe,
      ingredients: rootIngredients,
      ingredientGroups: domGroups,
      originalServings: 4,
    };
    const occurrences = ingredientOccurrences(efyRecipe, 4);
    expect(occurrences).toHaveLength(21);
    expect(occurrences.every((o) => o.group !== "")).toBe(true);
    expect(occurrences.every((o) => o.index >= 0)).toBe(true);

    const prawn = occurrences.find((o) => o.ingredient.name.includes("prawns"));
    expect(prawn?.group).toBe("Option 1: For Prawn /Shrimp Egg Foo Young");
    expect(prawn?.index).toBe(15);

    const pork = occurrences.find((o) => o.ingredient.name.includes("pork"));
    expect(pork?.group).toBe("Option 2: For Pork Egg Foo Young");
    expect(pork?.index).toBe(16);
  });
});
