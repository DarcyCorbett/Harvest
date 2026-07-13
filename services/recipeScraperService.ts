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
import { applyServingScale, parseMinutes, parseRecipe } from './scraper/parse';
import { fetchIndexedCandidates } from './scraper/recipeIndex';
import {
  buildQueryTags,
  buildSearchQuery,
  INDEXED_SITES,
  SITE_SEARCH_URLS,
  prioritiseSites,
  getDishPool,
  weightedRandomItem,
} from './scraper/sites';
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
  const maxRetries = 3;
  let lastError: Error | null = null;
  const triedSeeds = new Set<string>();

  if (request.forceSeed) {
    triedSeeds.add(request.forceSeed.toLowerCase());
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      let currentSeed = request.forceSeed;

      if (attempt > 1) {
        if (request.settings?.selectedSeeds && request.settings.selectedSeeds.length > 0) {
          const untried = request.settings.selectedSeeds.filter(s => !triedSeeds.has(s.toLowerCase()));
          if (untried.length > 0) {
            currentSeed = untried[Math.floor(Math.random() * untried.length)];
            triedSeeds.add(currentSeed.toLowerCase());
            console.log(`[RecipeScraper] Retry attempt ${attempt}: Using alternative user-selected seed "${currentSeed}"`);
          } else {
            const pool = getDishPool(request.cuisineStyles, request.mealType);
            const untriedPool = pool.filter(s => !triedSeeds.has(s.toLowerCase()));
            if (untriedPool.length > 0) {
              currentSeed = weightedRandomItem(untriedPool, request.settings?.ingredientWeights ?? {});
              triedSeeds.add(currentSeed.toLowerCase());
              console.log(`[RecipeScraper] Retry attempt ${attempt}: All user seeds tried. Using random pool seed "${currentSeed}"`);
            } else {
              currentSeed = undefined;
              console.log(`[RecipeScraper] Retry attempt ${attempt}: All seeds exhausted. Retrying without seed restriction`);
            }
          }
        } else {
          const pool = getDishPool(request.cuisineStyles, request.mealType);
          const untriedPool = pool.filter(s => !triedSeeds.has(s.toLowerCase()));
          if (untriedPool.length > 0) {
            currentSeed = weightedRandomItem(untriedPool, request.settings?.ingredientWeights ?? {});
            triedSeeds.add(currentSeed.toLowerCase());
            console.log(`[RecipeScraper] Retry attempt ${attempt}: Using alternative pool seed "${currentSeed}"`);
          } else {
            currentSeed = undefined;
            console.log(`[RecipeScraper] Retry attempt ${attempt}: Pool seeds exhausted. Retrying without seed restriction`);
          }
        }
      }

      const queryCtx = {
        mealType: request.mealType,
        cuisineStyles: request.cuisineStyles,
        customInstructions: request.customInstructions,
        settings: request.settings,
        forceSeed: currentSeed,
      };
      const searchQuery = buildSearchQuery(queryCtx);
      const queryTags = buildQueryTags(queryCtx);
      console.log(`[RecipeScraper] (Attempt ${attempt}/${maxRetries}) Search query: "${searchQuery}"`);
      console.log(`[RecipeScraper] Query tags (for indexed sites): [${queryTags.join(', ')}]`);

      const sites = prioritiseSites(request.cuisineStyles, request.settings);
      const globalFallbacks: Array<{ recipe: Recipe; recipeUrl: string }> = [];

      // Greatly increase the number of sites to search (up to 10)
      const sitesToTry = Math.max(10, MAX_SITES_TO_TRY);

      for (const site of sites.slice(0, sitesToTry)) {
        const isIndexed = INDEXED_SITES.includes(site);
        const searchUrl = isIndexed ? null : SITE_SEARCH_URLS[site]?.(searchQuery);
        if (!isIndexed && !searchUrl) continue;

        try {
          let candidateUrls: string[];
          if (isIndexed) {
            console.log(`[RecipeScraper] ${site} uses indexed-pool path`);
            candidateUrls = await fetchIndexedCandidates(site, queryTags);
          } else {
            console.log(`[RecipeScraper] Searching ${site}...`);
            candidateUrls = await fetchRestApiLinks(searchUrl!);
          }

          console.log(
            `[RecipeScraper] ${candidateUrls.length} candidate(s) on ${site}:`,
            candidateUrls
          );

          if (candidateUrls.length === 0) {
            console.warn(`[RecipeScraper] No recipe links found for ${site}`);
            continue;
          }

          shuffleArray(candidateUrls);

          // Greatly increase candidates checked per site (up to 8)
          const candidatesToTry = Math.max(8, MAX_CANDIDATES_PER_SITE);

          for (const recipeUrl of candidateUrls.slice(0, candidatesToTry)) {
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
                if (currentSeed && !seedMatchesRecipe(currentSeed, cached)) {
                  console.log(`[RecipeScraper] Skipping cached "${cached.title}" — seed="${currentSeed}"`);
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
              const recipe = parseRecipe(rawHtml, recipeUrl);

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

              if (currentSeed) {
                if (!seedMatchesRecipe(currentSeed, recipe)) {
                  const ingNames = recipe.ingredients.map((ing) => ing.name).join(', ');
                  const terms = [currentSeed, ...(SEED_SYNONYMS[currentSeed.toLowerCase()] ?? [])];
                  console.log(`[RecipeScraper] Seed MISS "${recipe.title}" — none of [${terms.join(', ')}] in title or ingredients: [${ingNames}]`);
                  continue;
                }
                console.log(`[RecipeScraper] Seed HIT "${recipe.title}" — seed="${currentSeed}"`);
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

      if (globalFallbacks.length > 0) {
        const kfActive = request.cuisineStyles.includes('Kid Friendly');
        const healthyActive = request.cuisineStyles.includes('Healthy');
        let validFallbacks = globalFallbacks.filter(({ recipe }) => {
          if (kfActive && !isKidFriendly(recipe, request.settings?.kidFriendly)) return false;
          if (healthyActive && !isHealthy(recipe)) return false;
          return true;
        });
        if (currentSeed) {
          const seed = currentSeed.toLowerCase();
          const seedFiltered = validFallbacks.filter(({ recipe }) =>
            recipe.title.toLowerCase().includes(seed) ||
            recipe.ingredients.some((ing) => ing.name.toLowerCase().includes(seed))
          );
          console.log(`[RecipeScraper] Fallback seed filter: ${seedFiltered.length}/${validFallbacks.length} pass seed="${currentSeed}"`);
          if (seedFiltered.length > 0) validFallbacks = seedFiltered;
        }
        const { recipe: fallbackRecipe } = (validFallbacks[0] ?? globalFallbacks[0]);
        console.log(`[RecipeScraper] All candidates filtered — using fallback: "${fallbackRecipe.title}"`);
        const recipeId = await saveRecipe(fallbackRecipe);
        return {
          recipe: applyServingScale({ ...fallbackRecipe, id: recipeId }, request.requiredServings),
          recipeId,
          fromCache: false,
        };
      }

      throw new Error(`No matching recipes found on any of the attempted sites for seed "${currentSeed ?? 'none'}"`);
    } catch (err) {
      console.warn(`[RecipeScraper] Attempt ${attempt} failed:`, err instanceof Error ? err.message : err);
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  const activeFilters: string[] = [];
  if (request.cuisineStyles.includes('Quick & Easy')) activeFilters.push('Quick & Easy (≤30 min)');
  if (request.cuisineStyles.includes('Moderate')) activeFilters.push('Moderate (≤45 min)');
  if (request.cuisineStyles.includes('Kid Friendly')) activeFilters.push('Kid Friendly');
  if (request.forceSeed) activeFilters.push(`seed "${request.forceSeed}"`);
  const filterDetail = activeFilters.length > 0 ? ` with filters: ${activeFilters.join(', ')}` : '';
  throw new Error(
    `No matching recipe found for ${request.mealType}${filterDetail} after multiple retries across different sites and seeds. Try broadening your criteria.`
  );
}

function shuffleArray<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}
