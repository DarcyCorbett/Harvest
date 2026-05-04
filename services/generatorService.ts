// ============================================================
// Meal Wizard — Generator Service (orchestrator)
// Orchestrates meal plan generation: smart favourites injection,
// recipe scraping per slot, shopping list aggregation, and
// saving confirmed meals to Firestore.
//
// Implementation split:
//   - services/gemini.ts        — callGemini + tagRecipesWithGemini
//   - services/shoppingList.ts  — aggregateIngredients + getGeminiGroupings
//   - services/scraper/*        — recipe fetching + filtering
// ============================================================

import {
  addMealPlanEntry,
  addShoppingItems,
  addToCookbook,
  clearAllShoppingItems,
  getRecipe,
  getStarredRecipes,
  updateRecipeTags,
} from './firestoreService';
import { tagRecipesWithGemini } from './gemini';
import {
  calculateRequiredServings,
  checkTimeConstraint,
  COURSE_TAG_VALUES,
  isCourseCompatible,
  isHealthy,
  isKidFriendly,
  isVegetarian,
  matchesWord,
  MEAT_INGREDIENTS,
  scrapeRecipe,
  seedMatchesRecipe,
  type ScrapeRequest,
} from './recipeScraperService';
import {
  aggregateByGeminiGroups,
  aggregateIngredients,
  getGeminiGroupings,
  type RawIngredient,
} from './shoppingList';
import type {
  CuisineStyle,
  HouseholdSettings,
  MealType,
  Recipe,
  ShoppingItem,
} from './types';

// ─── Public Types ─────────────────────────────────────────────

export interface GeneratedMeal {
  recipe: Recipe;
  recipeId: string;
  /** ISO date string: "2025-07-14" */
  date: string;
  mealType: MealType;
  isFromFavourites: boolean;
  servings: number;
}

export interface GenerateConfig {
  /** First day of the plan (should be the next Monday). */
  startDate: Date;
  numberOfDays: number;
  adults: number;
  children: number;
  mealTypes: MealType[];
  cuisineStyles: CuisineStyle[];
  customInstructions?: string;
  settings?: HouseholdSettings;
}

export type ProgressCallback = (
  message: string,
  current: number,
  total: number
) => void;

// ─── Helpers ──────────────────────────────────────────────────

function shuffleArray<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// ─── Date Utilities ───────────────────────────────────────────

/**
 * Returns the next Monday strictly after today.
 * If today is already Monday, returns the following Monday.
 */
export function getNextMonday(): Date {
  const today = new Date();
  const day = today.getDay();
  const daysUntilMonday = day === 1 ? 7 : (8 - day) % 7;
  const monday = new Date(today);
  monday.setDate(today.getDate() + daysUntilMonday);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

/** Format a Date to "YYYY-MM-DD" for Firestore keys. */
export function formatDateISO(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Format an ISO date string to a human-readable form: "Mon 14 Jul". */
export function formatDateDisplay(dateStr: string): string {
  const [year, month, day] = dateStr.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return date.toLocaleDateString('en-AU', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

/** Add n days to a Date, returning a new Date. */
export function addDays(date: Date, n: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + n);
  return result;
}

// ─── Meal Plan Generation ─────────────────────────────────────

const MEAL_ORDER: MealType[] = ['breakfast', 'lunch', 'dinner', 'side'];

// Cuisine styles that have dedicated dish vocabularies — selected one-per-slot via round-robin.
const CUISINE_STYLES = new Set<CuisineStyle>(['Asian', 'Mexican', 'Mediterranean', 'Italian', 'Indian']);

// Modifier tags that must appear on every recipe if the user selected them.
const MODIFIER_TAGS = ['Vegetarian', 'Kid Friendly', 'Healthy'] as const;

export interface MealMismatch {
  index: number;
  reasons: string[];
}

/**
 * Return the indices of meals whose Gemini tags don't satisfy the originally
 * selected cuisine/modifier criteria. Used by the "Auto Fix" button.
 *
 * Rules:
 *  - Recipes with no tags are skipped (Gemini may have been unavailable).
 *  - Modifier tags (Vegetarian, Kid Friendly, Healthy): ALL selected must be present.
 *  - Regional cuisine tags (Asian, Mexican, etc.): at least ONE selected must match.
 *  - Course: existing isCourseCompatible check.
 *  - Time-based styles (Quick & Easy, Moderate): skipped — already enforced by scraper.
 */
export function findMismatchedMeals(
  meals: GeneratedMeal[],
  cuisineStyles: CuisineStyle[]
): MealMismatch[] {
  const requiredModifiers = MODIFIER_TAGS.filter((m) =>
    cuisineStyles.includes(m as CuisineStyle)
  );
  const requiredCuisines = cuisineStyles.filter((s) => CUISINE_STYLES.has(s));

  const out: MealMismatch[] = [];
  meals.forEach((meal, index) => {
    const tags = meal.recipe.tags ?? [];
    if (tags.length === 0) return;

    const reasons: string[] = [];

    const tagCourses = tags.filter((t) => COURSE_TAG_VALUES.has(t as 'Breakfast'));
    if (tagCourses.length > 0 && !isCourseCompatible(tagCourses, meal.mealType, cuisineStyles)) {
      reasons.push(`course [${tagCourses.join(', ')}] incompatible with ${meal.mealType}`);
    }

    for (const mod of requiredModifiers) {
      if (!tags.includes(mod)) reasons.push(`missing "${mod}" tag`);
    }

    if (requiredCuisines.length > 0 && !requiredCuisines.some((c) => tags.includes(c))) {
      reasons.push(`no selected cuisine (${requiredCuisines.join('/')}) in tags`);
    }

    if (reasons.length > 0) out.push({ index, reasons });
  });

  return out;
}

const LOADING_MESSAGES = [
  'Searching for the perfect recipes…',
  'Scraping and reading recipes…',
  'Adjusting portions for your family…',
  'Building your meal plan…',
];

/**
 * Run the post-loop Gemini tagging pass for freshly scraped meals.
 * Mutates each fresh meal's `recipe.tags` in place and persists to Firestore.
 * Non-fatal — tagging errors are logged and skipped.
 */
async function applyGeminiTagsToFreshMeals(
  meals: GeneratedMeal[],
  freshRecipeIds: Set<string>
): Promise<void> {
  const freshMeals = meals.filter((m) => freshRecipeIds.has(m.recipeId));
  if (freshMeals.length === 0) return;

  const tagsByRecipeId = await tagRecipesWithGemini(
    freshMeals.map((m) => ({ recipeId: m.recipeId, recipe: m.recipe }))
  );

  for (const meal of freshMeals) {
    const geminiTags = tagsByRecipeId.get(meal.recipeId) ?? [];
    if (geminiTags.length === 0) continue;
    const courseSet = new Set((meal.recipe.course ?? []).map((c) => c.toLowerCase()));
    const merged = [
      ...new Set([
        ...(meal.recipe.tags ?? []),
        ...geminiTags.filter((t) => !courseSet.has(t.toLowerCase())),
      ]),
    ];
    try {
      await updateRecipeTags(meal.recipeId, merged);
      meal.recipe.tags = merged;
    } catch (err) {
      console.warn('[Tagger] Firestore tag update failed (non-fatal):', err);
    }
  }
}

/**
 * Generate a full meal plan from config.
 *
 * Calls onProgress for each recipe fetched so the UI can show descriptive
 * loading messages. Returns GeneratedMeal[] for user review before saving.
 *
 * Smart Favourites: if the household has more than 10 starred recipes,
 * 1–3 of them are randomly woven into the plan alongside new scrapes.
 */
export async function generateMealPlan(
  config: GenerateConfig,
  householdId: string,
  onProgress: ProgressCallback
): Promise<GeneratedMeal[]> {
  const requiredServings = calculateRequiredServings(
    config.adults,
    config.children
  );

  // Build all (date, mealType) slots in the requested range
  const slots: Array<{ date: Date; mealType: MealType }> = [];
  for (let day = 0; day < config.numberOfDays; day++) {
    const date = addDays(config.startDate, day);
    const orderedTypes = [...config.mealTypes].sort(
      (a, b) => MEAL_ORDER.indexOf(a) - MEAL_ORDER.indexOf(b)
    );
    for (const mealType of orderedTypes) {
      slots.push({ date, mealType });
    }
  }
  const total = slots.length;

  // ── Cuisine round-robin setup ─────────────────────────────
  const selectedCuisines = config.cuisineStyles.filter((s) => CUISINE_STYLES.has(s));
  const modifierStyles = config.cuisineStyles.filter((s) => !CUISINE_STYLES.has(s));

  // ── Seed round-robin setup ────────────────────────────────
  const isVegetarianPlan = config.cuisineStyles.includes('Vegetarian');
  const rawSeeds = config.settings?.selectedSeeds ?? [];
  const filteredSeeds = isVegetarianPlan
    ? rawSeeds.filter((s) => !(MEAT_INGREDIENTS as readonly string[]).some((m) => matchesWord(s, m)))
    : rawSeeds;
  if (isVegetarianPlan && filteredSeeds.length < rawSeeds.length) {
    console.log(`[Generator] Dropped ${rawSeeds.length - filteredSeeds.length} meat seed(s) for Vegetarian plan`);
  }
  const seedQueue = [...filteredSeeds];
  shuffleArray(seedQueue);

  // Pre-compute per-slot cuisine + seed so each parallel task is independent of
  // shared round-robin cursors. Cursor mutation under Promise.all would be racy.
  const slotConfigs = slots.map((slot, i) => {
    const slotCuisine = selectedCuisines.length > 0
      ? selectedCuisines[i % selectedCuisines.length]
      : undefined;
    const slotCuisineStyles = slotCuisine ? [slotCuisine, ...modifierStyles] : config.cuisineStyles;
    const forceSeed = seedQueue.length > 0 ? seedQueue[i % seedQueue.length] : undefined;
    return { slot, slotCuisineStyles, forceSeed, index: i };
  });

  // ── Smart Favourites ─────────────────────────────────────
  let starredEntries: { recipeId: string }[] = [];
  try {
    const starred = await getStarredRecipes(householdId);
    if (starred.length > 10) starredEntries = starred;
  } catch {
    // Non-fatal — continue without smart favourites
  }
  const favouriteProbability = Math.min(0.4, 3 / total);

  // ── Generate slots (chunked concurrency) ──────────────────
  const CONCURRENCY = 3;
  const results: GeneratedMeal[] = new Array(slotConfigs.length);
  const usedRecipeIds: string[] = [];
  const freshRecipeIds = new Set<string>();
  const reservedFavourites = new Set<string>();

  for (let chunkStart = 0; chunkStart < slotConfigs.length; chunkStart += CONCURRENCY) {
    const chunk = slotConfigs.slice(chunkStart, chunkStart + CONCURRENCY);
    const chunkExcludeSnapshot = [...usedRecipeIds];

    const chunkResults = await Promise.all(
      chunk.map(async (cfg) => {
        const { slot, slotCuisineStyles, forceSeed, index } = cfg;
        const current = index + 1;
        const msgIndex = Math.min(Math.floor((index / total) * LOADING_MESSAGES.length), LOADING_MESSAGES.length - 1);
        onProgress(LOADING_MESSAGES[msgIndex], current, total);
        console.log(`[Generator] Slot ${current}/${total}: mealType=${slot.mealType} cuisines=[${slotCuisineStyles.join(',')}] forceSeed=${forceSeed ?? 'none'}`);

        // ── Attempt favourite injection ───────────────────
        if (starredEntries.length > 0 && Math.random() < favouriteProbability) {
          const shuffled = [...starredEntries].sort(() => Math.random() - 0.5);
          for (const entry of shuffled) {
            if (chunkExcludeSnapshot.includes(entry.recipeId)) continue;
            if (reservedFavourites.has(entry.recipeId)) continue;
            reservedFavourites.add(entry.recipeId);
            try {
              const recipe = await getRecipe(entry.recipeId);
              const passes = recipe
                && isCourseCompatible(recipe.course, slot.mealType, slotCuisineStyles)
                && (!slotCuisineStyles.includes('Vegetarian') || isVegetarian(recipe))
                && (!slotCuisineStyles.includes('Kid Friendly') || isKidFriendly(recipe, config.settings?.kidFriendly))
                && (!slotCuisineStyles.includes('Healthy') || isHealthy(recipe))
                && checkTimeConstraint(recipe, slotCuisineStyles) !== 'fail'
                && (!forceSeed || seedMatchesRecipe(forceSeed, recipe));
              if (!passes || !recipe) {
                reservedFavourites.delete(entry.recipeId);
                continue;
              }
              onProgress('Loading a favourite recipe…', current, total);
              return {
                cfg,
                meal: {
                  recipe,
                  recipeId: entry.recipeId,
                  date: formatDateISO(slot.date),
                  mealType: slot.mealType,
                  isFromFavourites: true,
                  servings: requiredServings,
                } as GeneratedMeal,
                fromCache: true,
              };
            } catch {
              reservedFavourites.delete(entry.recipeId);
            }
          }
        }

        // ── Fresh scrape ──────────────────────────────────
        const request: ScrapeRequest = {
          mealType: slot.mealType,
          cuisineStyles: slotCuisineStyles,
          customInstructions: config.customInstructions,
          requiredServings,
          excludeRecipeIds: [...chunkExcludeSnapshot, ...reservedFavourites],
          settings: config.settings,
          forceSeed,
        };
        const scraped = await scrapeRecipe(request);
        return {
          cfg,
          meal: {
            recipe: scraped.recipe,
            recipeId: scraped.recipeId,
            date: formatDateISO(slot.date),
            mealType: slot.mealType,
            isFromFavourites: false,
            servings: requiredServings,
          } as GeneratedMeal,
          fromCache: scraped.fromCache,
        };
      })
    );

    for (const r of chunkResults) {
      let meal = r.meal;
      let fromCache = r.fromCache;
      if (usedRecipeIds.includes(meal.recipeId)) {
        console.log(`[Generator] Duplicate ${meal.recipeId} within chunk — re-scraping slot ${r.cfg.index + 1} serially`);
        const { slot, slotCuisineStyles, forceSeed } = r.cfg;
        const reScraped = await scrapeRecipe({
          mealType: slot.mealType,
          cuisineStyles: slotCuisineStyles,
          customInstructions: config.customInstructions,
          requiredServings,
          excludeRecipeIds: [...usedRecipeIds],
          settings: config.settings,
          forceSeed,
        });
        meal = {
          recipe: reScraped.recipe,
          recipeId: reScraped.recipeId,
          date: formatDateISO(slot.date),
          mealType: slot.mealType,
          isFromFavourites: false,
          servings: requiredServings,
        };
        fromCache = reScraped.fromCache;
      }
      if (!fromCache && !meal.isFromFavourites) freshRecipeIds.add(meal.recipeId);
      results[r.cfg.index] = meal;
      usedRecipeIds.push(meal.recipeId);
    }
  }

  // Phase 2: add Gemini modifier tags to freshly scraped recipes (one batched call)
  await applyGeminiTagsToFreshMeals(results, freshRecipeIds);

  onProgress('Building your meal plan…', total, total);
  return results;
}

/**
 * Re-scrape a subset of an existing generated meal plan.
 * Used when the user checks some recipes and taps "Regenerate Selected".
 */
export async function regenerateMeals(
  meals: GeneratedMeal[],
  indicesToRegenerate: number[],
  config: Pick<GenerateConfig, 'cuisineStyles' | 'customInstructions' | 'adults' | 'children' | 'settings'>,
  onProgress: ProgressCallback
): Promise<GeneratedMeal[]> {
  const updated = [...meals];
  const total = indicesToRegenerate.length;
  const requiredServings = calculateRequiredServings(config.adults, config.children);

  const isVegetarianPlan = config.cuisineStyles.includes('Vegetarian');
  const rawSeeds = config.settings?.selectedSeeds ?? [];
  const filteredSeeds = isVegetarianPlan
    ? rawSeeds.filter((s) => !(MEAT_INGREDIENTS as readonly string[]).some((m) => matchesWord(s, m)))
    : rawSeeds;

  const regenSelectedCuisines = config.cuisineStyles.filter((s) => CUISINE_STYLES.has(s));
  const regenModifierStyles = config.cuisineStyles.filter((s) => !CUISINE_STYLES.has(s));

  const excludeIds: string[] = meals
    .filter((_, i) => !indicesToRegenerate.includes(i))
    .map((m) => m.recipeId);
  const freshRecipeIds = new Set<string>();

  const regenSlotConfigs = indicesToRegenerate.map((idx) => {
    const meal = meals[idx];
    const slotCuisine = regenSelectedCuisines.length > 0
      ? regenSelectedCuisines[Math.floor(Math.random() * regenSelectedCuisines.length)]
      : undefined;
    const slotCuisineStyles = slotCuisine ? [slotCuisine, ...regenModifierStyles] : config.cuisineStyles;
    const forceSeed = filteredSeeds.length > 0
      ? filteredSeeds[Math.floor(Math.random() * filteredSeeds.length)]
      : undefined;
    return { idx, meal, slotCuisineStyles, forceSeed };
  });

  const CONCURRENCY = 3;
  for (let chunkStart = 0; chunkStart < regenSlotConfigs.length; chunkStart += CONCURRENCY) {
    const chunk = regenSlotConfigs.slice(chunkStart, chunkStart + CONCURRENCY);
    const chunkExcludeSnapshot = [...excludeIds];

    const chunkResults = await Promise.all(
      chunk.map(async (cfg, j) => {
        const globalIdx = chunkStart + j;
        onProgress(`Regenerating recipe ${globalIdx + 1} of ${total}…`, globalIdx + 1, total);
        const result = await scrapeRecipe({
          mealType: cfg.meal.mealType,
          cuisineStyles: cfg.slotCuisineStyles,
          customInstructions: config.customInstructions,
          requiredServings,
          excludeRecipeIds: [...chunkExcludeSnapshot],
          settings: config.settings,
          forceSeed: cfg.forceSeed,
        });
        return { cfg, result };
      })
    );

    for (const { cfg, result } of chunkResults) {
      let finalResult = result;
      if (excludeIds.includes(result.recipeId)) {
        console.log(`[Regenerate] Duplicate ${result.recipeId} within chunk — re-scraping slot ${cfg.idx} serially`);
        finalResult = await scrapeRecipe({
          mealType: cfg.meal.mealType,
          cuisineStyles: cfg.slotCuisineStyles,
          customInstructions: config.customInstructions,
          requiredServings,
          excludeRecipeIds: [...excludeIds],
          settings: config.settings,
          forceSeed: cfg.forceSeed,
        });
      }
      if (!finalResult.fromCache) freshRecipeIds.add(finalResult.recipeId);
      excludeIds.push(finalResult.recipeId);
      updated[cfg.idx] = {
        recipe: finalResult.recipe,
        recipeId: finalResult.recipeId,
        date: cfg.meal.date,
        mealType: cfg.meal.mealType,
        isFromFavourites: false,
        servings: requiredServings,
      };
    }
  }

  await applyGeminiTagsToFreshMeals(updated, freshRecipeIds);

  return updated;
}

/**
 * Confirm a reviewed meal plan: save every meal to mealPlan + cookbook,
 * then aggregate all ingredients into the household shopping list.
 *
 * `shoppingListMode` controls how the new aggregation interacts with any
 * existing items on the list:
 *   - 'add'     (default): append new items alongside existing ones
 *   - 'replace':           wipe the entire shopping list first
 */
export async function confirmMealPlan(
  meals: GeneratedMeal[],
  householdId: string,
  shoppingListMode: 'add' | 'replace' = 'add',
  household?: { adults: number; children: number }
): Promise<void> {
  for (const meal of meals) {
    await addMealPlanEntry(householdId, {
      recipeId: meal.recipeId,
      date: meal.date,
      mealType: meal.mealType,
      servings: meal.servings,
      adults: household?.adults,
      children: household?.children,
    });
    await addToCookbook(householdId, meal.recipeId);
  }

  if (shoppingListMode === 'replace') {
    await clearAllShoppingItems(householdId);
  }

  const rawIngredients: RawIngredient[] = [];
  for (const meal of meals) {
    const source = { id: meal.recipeId, title: meal.recipe.title, servings: meal.servings };
    for (const ing of meal.recipe.ingredients) {
      rawIngredients.push({ id: rawIngredients.length, name: ing.name, quantity: ing.quantity, unit: ing.unit, source });
    }
  }

  if (rawIngredients.length === 0) return;

  console.log(`\n[ShoppingList] ${rawIngredients.length} raw ingredients across ${meals.length} meals`);

  let items: Omit<ShoppingItem, 'id'>[];
  try {
    const groups = await getGeminiGroupings(rawIngredients);
    console.log(`[ShoppingList] Gemini produced ${groups.length} groups`);
    items = aggregateByGeminiGroups(rawIngredients, groups);

    console.log('\n[ShoppingList] ── After Gemini-guided aggregation ────────────────');
    items.forEach((i) =>
      console.log(`  [${i.category.padEnd(20)}]  ${String(i.quantity).padStart(6)} ${i.unit.padEnd(5)}  ${i.name}`)
    );
    console.log(`[ShoppingList] Total: ${items.length} items\n`);
  } catch (err) {
    console.warn('[Generator] Gemini grouping failed — falling back to programmatic aggregation:', err);
    items = aggregateIngredients(
      meals.map((m) => ({ recipeId: m.recipeId, recipe: m.recipe, servings: m.servings }))
    );

    console.log('\n[ShoppingList] ── Fallback programmatic aggregation ────────────────');
    items.forEach((i) =>
      console.log(`  [${i.category.padEnd(20)}]  ${String(i.quantity).padStart(6)} ${i.unit.padEnd(5)}  ${i.name}`)
    );
    console.log(`[ShoppingList] Total: ${items.length} items\n`);
  }

  await addShoppingItems(householdId, items);
}
