// ============================================================
// Meal Wizard — Recipe Scraper Orchestrator (WPRM Edition)
//
// Strategy:
//   1. Search each trusted WPRM site via WordPress REST API
//      (server-side JSON — immune to JS-rendered search pages)
//   2. Fetch each candidate recipe page as raw HTML
//   3. Parse recipe fields directly from WP Recipe Maker plugin
//      HTML structure — pre-structured, no LLM needed
//
// Implementation is split across services/scraper/*:
//   - http.ts     — fetchRawHtml, fetchRestApiLinks
//   - parse.ts    — WPRM HTML → Recipe
//   - sites.ts    — trusted sites + search query builder
//   - filters.ts  — eligibility filters + course compat + time check
// ============================================================

import { getCachedRecipeByUrl, saveRecipe } from './firestoreService';
import { fetchRawHtml, fetchRestApiLinks } from './scraper/http';
import { applyServingScale, parseMinutes, parseRecipeFromWprm } from './scraper/parse';
import { buildSearchQuery, SITE_SEARCH_URLS, prioritiseSites } from './scraper/sites';
import {
  checkTimeConstraint,
  evaluateRecipeForRequest,
  isHealthy,
  isKidFriendly,
  SEED_SYNONYMS,
  seedMatchesRecipe,
} from './scraper/filters';
import type { CuisineStyle, HouseholdSettings, MealType, Recipe } from './types';

// ─── Re-exports (barrel) ─────────────────────────────────────
// External consumers (generator, UI) continue to import from this module
// so the split stays invisible to them.
export { applyServingScale } from './scraper/parse';
export { SEED_INGREDIENT_OPTIONS, TRUSTED_SITES } from './scraper/sites';
export {
  COURSE_TAG_VALUES,
  KID_FRIENDLY_DEFAULTS,
  MEAT_INGREDIENTS,
  checkTimeConstraint,
  isCourseCompatible,
  isHealthy,
  isKidFriendly,
  isVegetarian,
  matchesWord,
  seedMatchesRecipe,
} from './scraper/filters';

// ─── Configuration ───────────────────────────────────────────

const MAX_SITES_TO_TRY = 5;
const MAX_CANDIDATES_PER_SITE = 5;

// ─── Public Types ─────────────────────────────────────────────

export interface ScrapeRequest {
  mealType: MealType;
  cuisineStyles: CuisineStyle[];
  customInstructions?: string;
  requiredServings: number;
  /** Recipe IDs already used in this generation — skip them to avoid duplicates. */
  excludeRecipeIds?: string[];
  /** Per-household source and ingredient weight settings. */
  settings?: HouseholdSettings;
  /** If set, use this ingredient as the food seed instead of random weighted selection. */
  forceSeed?: string;
}

export interface ScrapeResult {
  recipe: Recipe;
  recipeId: string;
  fromCache: boolean;
}

// ─── Public API ───────────────────────────────────────────────

export function calculateRequiredServings(adults: number, children: number): number {
  const raw = adults + children * 0.5;
  return Math.ceil(raw * 2) / 2;
}

export async function scrapeRecipe(request: ScrapeRequest): Promise<ScrapeResult> {
  const searchQuery = buildSearchQuery({
    mealType: request.mealType,
    cuisineStyles: request.cuisineStyles,
    customInstructions: request.customInstructions,
    settings: request.settings,
    forceSeed: request.forceSeed,
  });
  console.log(`[RecipeScraper] Search query: "${searchQuery}"`);

  const sites = prioritiseSites(request.cuisineStyles, request.settings);

  const globalFallbacks: Array<{ recipe: Recipe; recipeUrl: string }> = [];

  for (const site of sites.slice(0, MAX_SITES_TO_TRY)) {
    const searchUrl = SITE_SEARCH_URLS[site]?.(searchQuery);
    if (!searchUrl) continue;

    try {
      console.log(`[RecipeScraper] Searching ${site}...`);
      const candidateUrls = await fetchRestApiLinks(searchUrl);

      console.log(
        `[RecipeScraper] ${candidateUrls.length} candidate(s) on ${site}:`,
        candidateUrls
      );

      if (candidateUrls.length === 0) {
        console.warn(`[RecipeScraper] No recipe links found for ${site}`);
        continue;
      }

      shuffleArray(candidateUrls);

      for (const recipeUrl of candidateUrls.slice(0, MAX_CANDIDATES_PER_SITE)) {
        try {
          const cached = await getCachedRecipeByUrl(recipeUrl);
          if (cached?.id) {
            if (request.excludeRecipeIds?.includes(cached.id)) {
              console.log(`[RecipeScraper] Skipping duplicate (cached): ${recipeUrl}`);
              continue;
            }
            const cacheFilter = evaluateRecipeForRequest(cached, request);
            if (!cacheFilter.ok) {
              console.log(`[RecipeScraper] Skipping cached "${cached.title}" — ${cacheFilter.reason}`);
              continue;
            }
            const cachedTimeCheck = checkTimeConstraint(cached, request.cuisineStyles);
            if (cachedTimeCheck === 'fail') {
              const prepM = parseMinutes(cached.prepTime) ?? 0;
              const cookM = parseMinutes(cached.cookTime) ?? 0;
              const limit = request.cuisineStyles.includes('Quick & Easy') ? 30 : 45;
              console.log(`[RecipeScraper] Skipping cached "${cached.title}" — ${prepM + cookM} min total exceeds ${limit} min limit`);
              continue;
            }
            if (request.forceSeed && !seedMatchesRecipe(request.forceSeed, cached)) {
              console.log(`[RecipeScraper] Seed MISS (cached) "${cached.title}" — seed="${request.forceSeed}"`);
              continue;
            }
            console.log(`[RecipeScraper] Cache hit: ${recipeUrl}`);
            return {
              recipe: applyServingScale(cached, request.requiredServings),
              recipeId: cached.id,
              fromCache: true,
            };
          }

          const rawHtml = await fetchRawHtml(recipeUrl);
          const recipe = parseRecipeFromWprm(rawHtml, recipeUrl);

          const freshFilter = evaluateRecipeForRequest(recipe, request);
          if (!freshFilter.ok) {
            console.log(`[RecipeScraper] Skipping "${recipe.title}" — ${freshFilter.reason}`);
            continue;
          }

          const timeCheck = checkTimeConstraint(recipe, request.cuisineStyles);

          if (timeCheck === 'fail') {
            const prepM = parseMinutes(recipe.prepTime) ?? 0;
            const cookM = parseMinutes(recipe.cookTime) ?? 0;
            const limit = request.cuisineStyles.includes('Quick & Easy') ? 30 : 45;
            console.log(`[RecipeScraper] Skipping "${recipe.title}" — ${prepM + cookM} min total exceeds ${limit} min limit`);
            continue;
          }

          if (timeCheck === 'unparseable') {
            console.log(`[RecipeScraper] Time unparseable for "${recipe.title}" — queued as fallback`);
            globalFallbacks.push({ recipe, recipeUrl });
            continue;
          }

          if (request.forceSeed) {
            if (!seedMatchesRecipe(request.forceSeed, recipe)) {
              const ingNames = recipe.ingredients.map((ing) => ing.name).join(', ');
              const terms = [request.forceSeed, ...(SEED_SYNONYMS[request.forceSeed.toLowerCase()] ?? [])];
              console.log(`[RecipeScraper] Seed MISS "${recipe.title}" — none of [${terms.join(', ')}] in title or ingredients: [${ingNames}]`);
              continue;
            }
            console.log(`[RecipeScraper] Seed HIT "${recipe.title}" — seed="${request.forceSeed}"`);
          }

          console.log(`[RecipeScraper] Accepted "${recipe.title}" from ${site}`);
          const recipeId = await saveRecipe(recipe);
          if (request.excludeRecipeIds?.includes(recipeId)) {
            console.log(`[RecipeScraper] Skipping duplicate (fresh): ${recipeUrl}`);
            continue;
          }
          return {
            recipe: applyServingScale({ ...recipe, id: recipeId }, request.requiredServings),
            recipeId,
            fromCache: false,
          };
        } catch (err) {
          console.warn(
            `[RecipeScraper] Failed on ${recipeUrl}:`,
            err instanceof Error ? err.message : err
          );
        }
      }
    } catch (err) {
      console.warn(
        `[RecipeScraper] Search on ${site} failed:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  // Use time-unparseable fallbacks when all other candidates were exhausted.
  // Previously only activated when !anyParseableTime, but that skips fallbacks when
  // parseable recipes exist but all fail the time constraint (e.g. Kid Friendly + Quick & Easy).
  if (globalFallbacks.length > 0) {
    const kfActive = request.cuisineStyles.includes('Kid Friendly');
    const healthyActive = request.cuisineStyles.includes('Healthy');
    let validFallbacks = globalFallbacks.filter(({ recipe }) => {
      if (kfActive && !isKidFriendly(recipe, request.settings?.kidFriendly)) return false;
      if (healthyActive && !isHealthy(recipe)) return false;
      return true;
    });
    if (request.forceSeed) {
      const seed = request.forceSeed.toLowerCase();
      const seedFiltered = validFallbacks.filter(({ recipe }) =>
        recipe.title.toLowerCase().includes(seed) ||
        recipe.ingredients.some((ing) => ing.name.toLowerCase().includes(seed))
      );
      console.log(`[RecipeScraper] Fallback seed filter: ${seedFiltered.length}/${validFallbacks.length} pass seed="${request.forceSeed}"`);
      if (seedFiltered.length > 0) validFallbacks = seedFiltered;
    }
    const { recipe: fallbackRecipe } = (validFallbacks[0] ?? globalFallbacks[0]);
    console.log(`[RecipeScraper] All candidates filtered — using time-unparseable fallback: "${fallbackRecipe.title}"`);
    const recipeId = await saveRecipe(fallbackRecipe);
    return {
      recipe: applyServingScale({ ...fallbackRecipe, id: recipeId }, request.requiredServings),
      recipeId,
      fromCache: false,
    };
  }

  const activeFilters: string[] = [];
  if (request.cuisineStyles.includes('Quick & Easy')) activeFilters.push('Quick & Easy (≤30 min)');
  if (request.cuisineStyles.includes('Moderate')) activeFilters.push('Moderate (≤45 min)');
  if (request.cuisineStyles.includes('Kid Friendly')) activeFilters.push('Kid Friendly');
  if (request.forceSeed) activeFilters.push(`seed "${request.forceSeed}"`);
  const filterDetail = activeFilters.length > 0 ? ` with filters: ${activeFilters.join(', ')}` : '';
  throw new Error(
    `No matching recipe found for ${request.mealType}${filterDetail}. Try broadening your criteria.`
  );
}

function shuffleArray<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}
