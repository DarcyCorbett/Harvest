import {
  buildCatalogueSelectionRequestForSlots,
  catalogueClient,
  type CatalogueMealSlot,
} from "./catalogueClient";
import {
  getCatalogueGenerationMode,
  getGenerationRecipeHistory,
  getRecipe,
} from "./firestoreService";
import {
  scrapeRecipe,
  isVegetarian,
  isHealthy,
  isKidFriendly,
  isCourseCompatible,
  matchesWord,
} from "./recipeScraperService";
import { parseMinutes } from "./scraper/parse";
import {
  requestId,
  workflowCommand,
  type Draft,
  type DraftSlot,
  type Meal,
} from "./connectedClient";
import type {
  Recipe,
  CuisineStyle,
  MealType,
  HouseholdSettings,
  CookbookEntry,
} from "./types";

export function createDraft(
  slots: { date: string; mealType: string; maxMinutes?: 30 | 45 }[],
  config: Draft["config"],
  meals: Meal[],
): Draft {
  if (!slots.length || slots.length > 31)
    throw new Error("Choose between 1 and 31 meal slots.");
  if (config.must.some((i) => config.exclude.includes(i)))
    throw new Error("An ingredient cannot be required and excluded.");
  return {
    id: requestId(),
    revision: 0,
    config,
    slots: slots.map((s, i) => ({
      ...s,
      id: requestId(),
      expectedRevision: 0,
      servings: config.adults + config.children * 0.5,
      status: "failed",
      message: "Ready to generate",
      locked: false,
      removed: false,
      must:
        config.mustScope === "recipe"
          ? config.must
          : config.must.filter((_, n) => n % slots.length === i),
    })),
  };
}
export function matchesDraftSlot(
  recipe: Recipe,
  slot: DraftSlot,
  config: Draft["config"],
  settings: HouseholdSettings,
): boolean {
  const ingredients = recipe.ingredients.map((i) => i.name);
  const labels = [...(recipe.tags ?? []), ...(recipe.course ?? [])].map((t) =>
    t.toLowerCase(),
  );
  if (
    [...config.exclude, ...(settings.excludedIngredients ?? [])].some((term) =>
      ingredients.some((i) => matchesWord(i, term)),
    )
  )
    return false;
  if (settings.sourceWeights[new URL(recipe.sourceUrl).hostname] === 0)
    return false;
  if (
    (slot.must ?? []).some(
      (term) => !ingredients.some((i) => matchesWord(i, term)),
    )
  )
    return false;
  const time =
    parseMinutes(recipe.totalTime ?? "") ||
    (parseMinutes(recipe.prepTime) ?? 0) + (parseMinutes(recipe.cookTime) ?? 0);
  if (slot.maxMinutes && (!time || time > slot.maxMinutes)) return false;
  if (
    !labels.includes(slot.mealType) &&
    !isCourseCompatible(
      recipe.course,
      slot.mealType as MealType,
      config.styles as CuisineStyle[],
    )
  )
    return false;
  if (config.styles.includes("Vegetarian") && !isVegetarian(recipe))
    return false;
  if (config.styles.includes("Healthy") && !isHealthy(recipe)) return false;
  if (
    config.styles.includes("Kid Friendly") &&
    !isKidFriendly(recipe, settings.kidFriendly)
  )
    return false;
  if (config.styles.includes("Salad") && !labels.includes("salad"))
    return false;
  const cuisines = config.styles.filter((s) =>
    ["Asian", "Mexican", "Mediterranean", "Italian", "Indian"].includes(s),
  );
  return (
    !!slot.allowAnyCuisine ||
    !cuisines.length ||
    cuisines.some((s) => labels.includes(s.toLowerCase()))
  );
}
export async function fillDraft(
  input: Draft,
  householdId: string,
  settings: HouseholdSettings,
  cookbook: CookbookEntry[],
  onSave: (draft: Draft) => void,
  onlyIds?: string[],
  cancelled: () => boolean = () => false,
  /** Lets the caller serve recipes it already holds instead of re-reading them. */
  loadRecipe: (id: string) => Promise<Recipe | null> = getRecipe,
): Promise<Draft> {
  const mode = await getCatalogueGenerationMode();
  let draft = JSON.parse(JSON.stringify(input)) as Draft;
  const earliest = draft.slots.map((s) => s.date).sort()[0];
  const history = await getGenerationRecipeHistory(
    householdId,
    new Date(`${earliest}T12:00:00`),
  );
  const used = new Set([
    ...history.currentPlanRecipeIds,
    ...draft.slots.flatMap((s) => (s.recipeId ? [s.recipeId] : [])),
  ]);
  draft.config.exclude = [
    ...new Set([
      ...draft.config.exclude,
      ...(settings.excludedIngredients ?? []),
    ]),
  ];
  const favouriteIds = cookbook
    .filter((c) => c.starred)
    .sort(
      (a, b) =>
        Number(a.effort === "too much") -
        Number(b.effort === "too much"),
    )
    .map((c) => c.recipeId);
  let favouritesRemaining =
    draft.config.favouriteCount -
    draft.slots.filter(
      (s) => s.locked && s.recipeId && favouriteIds.includes(s.recipeId),
    ).length;
  const sharedIngredients = new Set<string>();
  for (const existing of draft.slots.filter((s) => s.locked && s.recipeId)) {
    const r = await loadRecipe(existing.recipeId!);
    r?.ingredients.forEach((i) => sharedIngredients.add(i.name.toLowerCase()));
  }
  for (let i = 0; i < draft.slots.length; i++) {
    if (cancelled()) break;
    let slot = draft.slots[i];
    if (
      slot.locked ||
      slot.removed ||
      slot.sourceMealId ||
      (onlyIds && !onlyIds.includes(slot.id))
    )
      continue;
    try {
      let selected: Recipe | null = null;
      let favourite = false;
      if (favouritesRemaining > 0)
        for (const id of favouriteIds) {
          if (used.has(id)) continue;
          const recipe = await loadRecipe(id);
          if (
            recipe &&
            matchesDraftSlot(recipe, slot, draft.config, settings) &&
            (mode !== "catalogue" ||
              (recipe.schemaVersion === 2 &&
                recipe.catalogueStatus === "ready"))
          ) {
            selected = recipe;
            favourite = true;
            favouritesRemaining--;
            break;
          }
        }
      if (!selected && mode === "catalogue") {
        const config = {
          cuisineStyles: draft.config.styles as CuisineStyle[],
          ingredientFilters: {
            must: slot.must ?? [],
            prefer: [...draft.config.prefer, ...sharedIngredients].slice(0, 20),
            exclude: draft.config.exclude,
          },
          settings,
        };
        const request = buildCatalogueSelectionRequestForSlots(
          config,
          householdId,
          [{ date: slot.date, mealType: slot.mealType as MealType }],
          [...used].slice(0, 500),
          history.recentRecipeIds,
        );
        if (slot.maxMinutes) request.slots[0].maxTotalMinutes = slot.maxMinutes;
        request.ranking = {
          recentProteins: [
            "chicken",
            "beef",
            "pork",
            "lamb",
            "turkey",
            "salmon",
            "tuna",
            "tofu",
            "lentils",
            "chickpeas",
          ].filter((p) =>
            [...sharedIngredients].some((i) => matchesWord(i, p)),
          ),
          preferredRecipeIds: cookbook
            .filter((c) => c.starred)
            .map((c) => c.recipeId)
            .slice(0, 500),
          depreferredRecipeIds: cookbook
            .filter((c) => c.effort === "too much")
            .map((c) => c.recipeId)
            .slice(0, 500),
        };
        const cuisineStyles = draft.config.styles.filter((s) =>
          ["Asian", "Mexican", "Mediterranean", "Italian", "Indian"].includes(
            s,
          ),
        );
        request.slots[0].cuisines =
          !slot.allowAnyCuisine && cuisineStyles.length
            ? [
                cuisineStyles[
                  i % cuisineStyles.length
                ].toLowerCase() as CatalogueMealSlot["cuisines"][number],
              ]
            : [];
        const response = await catalogueClient.select(request);
        const result = response.slots[0];
        if (result.status === "no-match") {
          const optional = result.relaxations.filter(
            (r) => r.filter === "maxTotalMinutes" || r.filter === "cuisine",
          );
          slot = {
            ...slot,
            status: "unmatched",
            recipeId: undefined,
            message: optional.length
              ? "No match for this slot. Try 45 minutes or change its optional preferences."
              : "No match. Adjust optional preferences; ingredient exclusions stay in place.",
          };
        } else {
          selected = await getRecipe(result.recipeId);
          if (!selected)
            throw new Error("Selected recipe is unavailable. Retry this slot.");
        }
      } else if (!selected) {
        if (!["breakfast", "lunch", "dinner", "side"].includes(slot.mealType))
          throw new Error("This meal type needs catalogue generation.");
        const styles = [
          ...draft.config.styles.filter(
            (s) =>
              s !== "Quick & Easy" &&
              s !== "Moderate" &&
              !(
                slot.allowAnyCuisine &&
                [
                  "Asian",
                  "Mexican",
                  "Mediterranean",
                  "Italian",
                  "Indian",
                ].includes(s)
              ),
          ),
          ...(slot.maxMinutes === 30
            ? ["Quick & Easy"]
            : slot.maxMinutes === 45
              ? ["Moderate"]
              : []),
        ] as CuisineStyle[];
        for (let attempt = 0; attempt < 3 && !selected; attempt++) {
          const result = await scrapeRecipe({
            householdId,
            mealType: slot.mealType as MealType,
            cuisineStyles: styles,
            requiredServings: slot.servings,
            excludeRecipeIds: [...used],
            settings,
            forceSeed: slot.must?.[0] ?? draft.config.prefer[0],
          });
          used.add(result.recipeId);
          if (matchesDraftSlot(result.recipe, slot, draft.config, settings))
            selected = result.recipe;
        }
        if (!selected)
          slot = {
            ...slot,
            status: "unmatched",
            recipeId: undefined,
            message:
              "No eligible recipe found. Adjust optional preferences and retry.",
          };
      }
      if (selected) {
        const overlap = selected.ingredients.filter((ing) =>
          sharedIngredients.has(ing.name.toLowerCase()),
        ).length;
        selected.ingredients.forEach((ing) =>
          sharedIngredients.add(ing.name.toLowerCase()),
        );
        used.add(selected.id!);
        slot = {
          ...slot,
          status: "ready",
          recipeId: selected.id,
          message: undefined,
          reasons: [
            ...(favourite ? ["Household favourite"] : []),
            ...(slot.maxMinutes ? [`Within ${slot.maxMinutes} minutes`] : []),
            ...(overlap
              ? [
                  `Shares ${overlap} ingredient${overlap === 1 ? "" : "s"} with this plan`,
                ]
              : []),
          ],
        };
      }
    } catch (error) {
      slot = {
        ...slot,
        status: "failed",
        message:
          error instanceof Error
            ? error.message
            : "Could not find this meal. Retry.",
        recipeId: undefined,
      };
    }
    draft = {
      ...draft,
      slots: draft.slots.map((s, n) => (n === i ? slot : s)),
    };
    const saved = await workflowCommand<{ draft: Draft }>(householdId, {
      operation: "draft",
      draft,
    });
    draft = saved.draft;
    onSave(draft);
  }
  return draft;
}
