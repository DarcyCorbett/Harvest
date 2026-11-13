import type { Ingredient, Recipe } from "./types";
import type { Meal } from "./connectedClient";
import { reconcileOccurrences } from "./ingredientReconciliation";

export interface IngredientOccurrence {
  index: number;
  group: string;
  groupIndex: number;
  original: Ingredient;
  ingredient: Ingredient;
}

/** Display groups when present; use the flat list only as an index map for saved overrides. */
export function ingredientOccurrences(
  recipe: Recipe,
  servings: number,
  meal?: Meal,
): IngredientOccurrence[] {
  const groups = recipe.ingredientGroups?.length
    ? recipe.ingredientGroups
    : [{ name: "", ingredients: recipe.ingredients }];

  const flatGrouped: { group: string; groupIndex: number; original: Ingredient }[] = [];
  for (let g = 0; g < groups.length; g++) {
    for (const item of groups[g].ingredients) {
      flatGrouped.push({ group: groups[g].name, groupIndex: g, original: item });
    }
  }

  const reconciliation = reconcileOccurrences(
    recipe.ingredients,
    flatGrouped.map((g) => g.original),
  );

  const occurrences: IngredientOccurrence[] = flatGrouped.map((g, idx) => {
    const index = reconciliation.matchedGroupedToRoot[idx];
    const original = g.original;
    const override =
      index >= 0
        ? meal?.overrides?.find(
            (o) => o.recipeId === recipe.id && o.ingredientIndex === index,
          )
        : undefined;
    const ingredient = override
      ? {
          ...override.replacement,
          quantity:
            (override.replacement.quantity * servings) /
            (override.forServings ?? servings),
          notes: [`Instead of ${original.name}`, override.adjustment]
            .filter(Boolean)
            .join(" · "),
        }
      : {
          ...original,
          quantity:
            (original.quantity * servings) / (recipe.originalServings || 1),
        };
    return { index, group: g.group, groupIndex: g.groupIndex, original, ingredient };
  });

  return occurrences;
}
const singular = (word: string) =>
  ({ tomatoes: "tomato", potatoes: "potato", leaves: "leaf", halves: "half" })[
    word
  ] ??
  (word.endsWith("ies")
    ? word.slice(0, -3) + "y"
    : word.endsWith("s") && !word.endsWith("ss")
      ? word.slice(0, -1)
      : word);
const words = (s: string) =>
  (
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .match(/[a-z]+/g) ?? []
  ).map(singular);
const prep = new Set([
  "fresh",
  "ground",
  "powder",
  "chopped",
  "diced",
  "sliced",
  "peeled",
  "grated",
  "minced",
  "finely",
  "roughly",
  "large",
  "small",
  "medium",
  "and",
  "or",
  "the",
  "of",
  "to",
  "for",
]);
const phrase = (name: string) =>
  words(name.split(/[,(]/)[0]).filter((w) => !prep.has(w));

/** Show every ingredient that shares a meaningful whole word with the step. */
export function ingredientsForStep(
  text: string,
  ingredients: IngredientOccurrence[],
): IngredientOccurrence[] {
  const tokens = words(text);
  const mentioned = new Set(tokens.filter((token) => !prep.has(token)));
  return ingredients.filter((occurrence) =>
    [occurrence.original.name, occurrence.ingredient.name].some((name) =>
      phrase(name).some((word) => mentioned.has(word)),
    ),
  );
}
