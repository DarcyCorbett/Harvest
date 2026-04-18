// ============================================================
// Meal Wizard — Recipe Scraper Service (WPRM Edition)
//
// Strategy:
//   1. Search each trusted WPRM site via WordPress REST API
//      (server-side JSON — immune to JS-rendered search pages)
//   2. Fetch each candidate recipe page as raw HTML
//   3. Parse recipe fields directly from WP Recipe Maker plugin
//      HTML structure — pre-structured, no LLM needed
// ============================================================

import { getCachedRecipeByUrl, saveRecipe } from './firestoreService';
import type { CuisineStyle, HouseholdSettings, Ingredient, IngredientGroup, MealType, Recipe } from './types';

// ─── Configuration ───────────────────────────────────────────

const MAX_SITES_TO_TRY = 5;
const MAX_CANDIDATES_PER_SITE = 3;

// ─── Trusted Sites (WP Recipe Maker only) ────────────────────

export const TRUSTED_SITES = [
  'www.recipetineats.com',
  'www.budgetbytes.com',
  'thewoksoflife.com',
  'www.themediterraneandish.com',
  'www.spendwithpennies.com',
  'cafedelites.com',
  'www.skinnytaste.com',
] as const;

const SITE_SEARCH_URLS: Record<string, (q: string) => string> = {
  'www.recipetineats.com': (q) =>
    `https://www.recipetineats.com/wp-json/wp/v2/posts?search=${encodeURIComponent(q)}&per_page=10&_fields=link`,
  'www.budgetbytes.com': (q) =>
    `https://www.budgetbytes.com/wp-json/wp/v2/posts?search=${encodeURIComponent(q)}&per_page=10&_fields=link`,
  'thewoksoflife.com': (q) =>
    `https://thewoksoflife.com/wp-json/wp/v2/posts?search=${encodeURIComponent(q)}&per_page=10&_fields=link`,
  'www.themediterraneandish.com': (q) =>
    `https://www.themediterraneandish.com/wp-json/wp/v2/posts?search=${encodeURIComponent(q)}&per_page=10&_fields=link`,
  'www.spendwithpennies.com': (q) =>
    `https://www.spendwithpennies.com/wp-json/wp/v2/posts?search=${encodeURIComponent(q)}&per_page=10&_fields=link`,
  'cafedelites.com': (q) =>
    `https://cafedelites.com/wp-json/wp/v2/posts?search=${encodeURIComponent(q)}&per_page=10&_fields=link`,
  'www.skinnytaste.com': (q) =>
    `https://www.skinnytaste.com/wp-json/wp/v2/posts?search=${encodeURIComponent(q)}&per_page=10&_fields=link`,
};

const CUISINE_KEYWORDS: Record<CuisineStyle, string> = {
  'Quick & Easy': '30 minute',
  'Moderate': '',
  'Vegetarian': 'vegetarian',
  'Kid Friendly': 'kid friendly',
  'Asian': 'Asian',
  'Mexican': 'Mexican',
  'Mediterranean': 'Mediterranean',
  'Healthy': 'healthy',
  'Salad': 'salad',
  'Custom': '',
};

const FOOD_RESTRICTING_STYLES = new Set<CuisineStyle>(['Vegetarian', 'Kid Friendly']);

const DISH_VOCAB: Record<string, Record<MealType, readonly string[]>> = {
  Asian: {
    breakfast: ['rice', 'eggs', 'tofu', 'noodles', 'pork', 'congee'],
    lunch: ['noodles', 'rice', 'tofu', 'chicken', 'pork', 'beef', 'soup', 'dumplings', 'prawn'],
    dinner: ['chicken', 'beef', 'pork', 'noodles', 'tofu', 'prawn', 'rice', 'duck', 'salmon', 'lamb', 'bake', 'one pan', 'stir fry', 'curry'],
    side: ['rice', 'noodles', 'tofu', 'vegetables', 'salad', 'soup', 'dumplings'],
  },
  Mexican: {
    breakfast: ['eggs', 'beans', 'chorizo', 'avocado', 'cheese'],
    lunch: ['chicken', 'beef', 'beans', 'shrimp', 'pork', 'cheese'],
    dinner: ['chicken', 'beef', 'pork', 'shrimp', 'beans', 'chorizo', 'lamb', 'bake', 'one pan', 'wrap'],
    side: ['beans', 'rice', 'avocado', 'corn', 'salad', 'vegetables'],
  },
  Mediterranean: {
    breakfast: ['eggs', 'cheese', 'spinach', 'tomatoes', 'yoghurt'],
    lunch: ['chicken', 'fish', 'chickpeas', 'lentils', 'lamb', 'vegetables', 'cheese'],
    dinner: ['chicken', 'lamb', 'fish', 'chickpeas', 'eggplant', 'seafood', 'beef', 'vegetables', 'bake', 'one pan'],
    side: ['chickpeas', 'eggplant', 'salad', 'bread', 'vegetables', 'lentils', 'yoghurt'],
  },
  general: {
    breakfast: [
      'eggs', 'oats', 'pancakes', 'bacon', 'banana', 'yoghurt', 'avocado',
      'berries', 'sausage', 'tomatoes', 'spinach', 'granola', 'bread',
    ],
    lunch: [
      'chicken', 'soup', 'salad', 'tuna', 'eggs', 'lentils', 'rice', 'pasta',
      'tofu', 'chickpeas', 'salmon', 'vegetables', 'potato', 'cheese', 'wrap', 'sandwich',
    ],
    dinner: [
      'chicken', 'beef', 'pork', 'salmon', 'pasta', 'lamb', 'shrimp', 'fish',
      'potato', 'turkey', 'sausage', 'tofu', 'lentils', 'chickpeas', 'noodles',
      'steak', 'vegetables', 'prawn', 'rice', 'bake', 'one pan', 'stir fry', 'curry',
    ],
    side: [
      'potato', 'rice', 'salad', 'bread', 'vegetables', 'corn', 'coleslaw',
      'pasta', 'beans', 'broccoli', 'spinach', 'couscous',
    ],
  },
};

/**
 * Curated list of food ingredient seeds available for weighting in settings.
 * Keys match items in DISH_VOCAB so weighted selection applies automatically.
 */
export const SEED_INGREDIENT_OPTIONS: readonly string[] = [
  'avocado', 'bacon', 'banana', 'beans', 'beef', 'berries', 'bread',
  'cheese', 'chicken', 'chickpeas', 'chorizo', 'eggs', 'fish', 'lamb',
  'lentils', 'noodles', 'oats', 'pasta', 'pork', 'potato', 'prawn',
  'rice', 'salmon', 'sausage', 'shrimp', 'spinach', 'tofu', 'tomatoes',
  'tuna', 'turkey', 'yoghurt',
];

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
  const searchQuery = buildSearchQuery(request);
  console.log(`[RecipeScraper] Search query: "${searchQuery}"`);

  const sites = prioritiseSites(request.cuisineStyles, request.settings);

  let anyParseableTime = false;
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
            console.log(`[RecipeScraper] Cache hit: ${recipeUrl}`);
            return {
              recipe: applyServingScale(cached, request.requiredServings),
              recipeId: cached.id,
              fromCache: true,
            };
          }

          const rawHtml = await fetchRawHtml(recipeUrl);
          const recipe = parseRecipeFromWprm(rawHtml, recipeUrl);

          if (!isCourseCompatible(recipe.course, request.mealType, request.cuisineStyles)) {
            console.log(
              `[RecipeScraper] Skipping "${recipe.title}" — course [${recipe.course?.join(', ')}] incompatible with ${request.mealType}`
            );
            continue;
          }

          const timeCheck = checkTimeConstraint(recipe, request.cuisineStyles);

          if (timeCheck === 'fail') {
            anyParseableTime = true;
            console.log(`[RecipeScraper] Skipping "${recipe.title}" — time constraint not met`);
            continue;
          }

          if (timeCheck === 'unparseable') {
            console.log(`[RecipeScraper] Time unparseable for "${recipe.title}" — queued as fallback`);
            globalFallbacks.push({ recipe, recipeUrl });
            continue;
          }

          anyParseableTime = true;
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

  if (!anyParseableTime && globalFallbacks.length > 0) {
    const { recipe } = globalFallbacks[0];
    console.log(`[RecipeScraper] Using time-fallback: "${recipe.title}"`);
    const recipeId = await saveRecipe(recipe);
    return {
      recipe: applyServingScale({ ...recipe, id: recipeId }, request.requiredServings),
      recipeId,
      fromCache: false,
    };
  }

  throw new Error(
    'Could not find a recipe matching your criteria. Please try again or adjust your selections.'
  );
}

// ─── Search Query ─────────────────────────────────────────────

function buildSearchQuery(request: ScrapeRequest): string {
  const parts: string[] = [];
  const hasFoodRestriction = request.cuisineStyles.some((s) => FOOD_RESTRICTING_STYLES.has(s));

  for (const style of request.cuisineStyles) {
    const keyword = CUISINE_KEYWORDS[style];
    if (keyword) parts.push(keyword);
  }

  if (hasFoodRestriction) {
    parts.push(request.mealType);
  } else {
    const pool = getDishPool(request.cuisineStyles, request.mealType);
    parts.push(weightedRandomItem(pool, request.settings?.ingredientWeights ?? {}));
  }

  if (request.customInstructions?.trim()) {
    parts.push(request.customInstructions.trim());
  }

  return parts.join(' ');
}

function getDishPool(cuisineStyles: CuisineStyle[], mealType: MealType): readonly string[] {
  if (cuisineStyles.includes('Asian')) return DISH_VOCAB.Asian[mealType] ?? DISH_VOCAB.general[mealType];
  if (cuisineStyles.includes('Mexican')) return DISH_VOCAB.Mexican[mealType] ?? DISH_VOCAB.general[mealType];
  if (cuisineStyles.includes('Mediterranean')) return DISH_VOCAB.Mediterranean[mealType] ?? DISH_VOCAB.general[mealType];
  return DISH_VOCAB.general[mealType];
}

/** Return a weighted-random item from a pool. Items absent from weights default to weight 1. */
function weightedRandomItem(pool: readonly string[], weights: Record<string, number>): string {
  const w = pool.map((item) => Math.max(1, weights[item] ?? 1));
  const total = w.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < pool.length; i++) {
    r -= w[i];
    if (r <= 0) return pool[i];
  }
  return pool[pool.length - 1];
}

// ─── Site Prioritisation ──────────────────────────────────────

function prioritiseSites(cuisineStyles: CuisineStyle[], settings?: HouseholdSettings): string[] {
  const sourceWeights = settings?.sourceWeights ?? {};

  // Filter out disabled sites (weight === 0)
  const all = (TRUSTED_SITES as readonly string[]).filter((s) => (sourceWeights[s] ?? 1) > 0);

  const preferred: string[] = [];

  // Sites with weight ≥ 2 jump to the front of the queue
  for (const site of all) {
    if ((sourceWeights[site] ?? 1) >= 2) preferred.push(site);
  }

  // Cuisine-specific preferences (only if site is enabled and not already preferred)
  if (cuisineStyles.includes('Asian')) {
    for (const s of ['thewoksoflife.com', 'www.recipetineats.com']) {
      if (all.includes(s) && !preferred.includes(s)) preferred.push(s);
    }
  }
  if (cuisineStyles.includes('Mediterranean')) {
    for (const s of ['www.themediterraneandish.com', 'www.recipetineats.com']) {
      if (all.includes(s) && !preferred.includes(s)) preferred.push(s);
    }
  }

  const seen = new Set(preferred);
  const remainder = all.filter((s) => !seen.has(s));
  for (let i = remainder.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [remainder[i], remainder[j]] = [remainder[j], remainder[i]];
  }

  return [...preferred, ...remainder];
}

// ─── HTTP Helpers ─────────────────────────────────────────────

const FETCH_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Linux; Android 10; Mobile) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
};

async function fetchRawHtml(url: string): Promise<string> {
  const response = await fetch(url, { headers: FETCH_HEADERS });
  if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`);
  const html = await response.text();
  console.log(`[RecipeScraper] Fetched ${url} — raw size: ${html.length} chars`);
  return html;
}

async function fetchRestApiLinks(apiUrl: string): Promise<string[]> {
  const response = await fetch(apiUrl, {
    headers: { ...FETCH_HEADERS, Accept: 'application/json' },
  });
  if (!response.ok) {
    console.warn(`[RecipeScraper] REST API ${response.status} for ${apiUrl}`);
    return [];
  }
  let posts: unknown;
  try {
    posts = await response.json();
  } catch {
    console.warn(`[RecipeScraper] REST API JSON parse failed for ${apiUrl}`);
    return [];
  }
  if (!Array.isArray(posts)) return [];
  return posts
    .map((p) => (p as Record<string, unknown>).link)
    .filter((link): link is string => typeof link === 'string' && link.startsWith('http'));
}

// ─── HTML Utilities ───────────────────────────────────────────

/** Strip HTML tags and decode HTML entities to plain text. */
function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/p>/gi, ' ')
    .replace(/<\/li>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    // Core entities (order: &amp; must come first to avoid double-decoding)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    // Whitespace / punctuation
    .replace(/&nbsp;/g, ' ')
    .replace(/&ndash;/g, '–')
    .replace(/&mdash;/g, '—')
    .replace(/&hellip;/g, '…')
    .replace(/&middot;/g, '·')
    .replace(/&bull;/g, '•')
    .replace(/&deg;/g, '°')
    .replace(/&times;/g, '×')
    .replace(/&divide;/g, '÷')
    // Quotes
    .replace(/&rsquo;/g, '\u2019')
    .replace(/&lsquo;/g, '\u2018')
    .replace(/&rdquo;/g, '\u201D')
    .replace(/&ldquo;/g, '\u201C')
    .replace(/&raquo;/g, '»')
    .replace(/&laquo;/g, '«')
    // Fractions / maths
    .replace(/&frac12;/g, '½')
    .replace(/&frac14;/g, '¼')
    .replace(/&frac34;/g, '¾')
    .replace(/&Prime;/g, '″')
    .replace(/&prime;/g, '′')
    // Accented characters (common in recipe text: sauté, naïve, jalapeño, etc.)
    .replace(/&[Ee]acute;/g,  (m) => m[1] === 'E' ? 'É' : 'é')
    .replace(/&[Ee]grave;/g,  (m) => m[1] === 'E' ? 'È' : 'è')
    .replace(/&[Ee]circ;/g,   (m) => m[1] === 'E' ? 'Ê' : 'ê')
    .replace(/&[Aa]grave;/g,  (m) => m[1] === 'A' ? 'À' : 'à')
    .replace(/&[Aa]acute;/g,  (m) => m[1] === 'A' ? 'Á' : 'á')
    .replace(/&[Aa]circ;/g,   (m) => m[1] === 'A' ? 'Â' : 'â')
    .replace(/&[Aa]uml;/g,    (m) => m[1] === 'A' ? 'Ä' : 'ä')
    .replace(/&[Oo]acute;/g,  (m) => m[1] === 'O' ? 'Ó' : 'ó')
    .replace(/&[Oo]uml;/g,    (m) => m[1] === 'O' ? 'Ö' : 'ö')
    .replace(/&[Uu]acute;/g,  (m) => m[1] === 'U' ? 'Ú' : 'ú')
    .replace(/&[Uu]uml;/g,    (m) => m[1] === 'U' ? 'Ü' : 'ü')
    .replace(/&[Ii]acute;/g,  (m) => m[1] === 'I' ? 'Í' : 'í')
    .replace(/&[Cc]cedil;/g,  (m) => m[1] === 'C' ? 'Ç' : 'ç')
    .replace(/&[Nn]tilde;/g,  (m) => m[1] === 'N' ? 'Ñ' : 'ñ')
    .replace(/&szlig;/g, 'ß')
    // Symbols
    .replace(/&copy;/g, '©')
    .replace(/&reg;/g, '®')
    .replace(/&trade;/g, '™')
    // Numeric references: decimal &#123; and hex &#xAB;
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Starting from contentStart (right after an opening tag),
 * return the inner HTML up to the matching closing tag using depth tracking.
 */
function depthTrack(html: string, tagName: string, contentStart: number): string | null {
  const openTag = `<${tagName}`;
  const closeTag = `</${tagName}>`;
  let depth = 1;
  let pos = contentStart;

  while (pos < html.length && depth > 0) {
    const nextOpen = html.indexOf(openTag, pos);
    const nextClose = html.indexOf(closeTag, pos);

    if (nextClose === -1) return null;

    if (nextOpen !== -1 && nextOpen < nextClose) {
      const ch = html[nextOpen + openTag.length];
      if (ch === ' ' || ch === '>' || ch === '\n' || ch === '\t' || ch === '\r' || ch === '/') {
        depth++;
      }
      pos = nextOpen + 1;
    } else {
      depth--;
      if (depth === 0) return html.slice(contentStart, nextClose);
      pos = nextClose + closeTag.length;
    }
  }

  return null;
}

/**
 * Return the inner HTML of the first element whose class attribute
 * includes className as an exact word.
 */
function extractByClass(html: string, className: string): string | null {
  const marker = 'class="';
  let pos = 0;

  while (pos < html.length) {
    const idx = html.indexOf(marker, pos);
    if (idx === -1) break;

    const valStart = idx + marker.length;
    const valEnd = html.indexOf('"', valStart);
    if (valEnd === -1) break;

    const classes = html.slice(valStart, valEnd).split(/\s+/);
    if (classes.includes(className)) {
      const tagStart = html.lastIndexOf('<', idx);
      if (tagStart === -1) { pos = valEnd + 1; continue; }
      const tagMatch = /^<(\w+)/.exec(html.slice(tagStart));
      if (!tagMatch) { pos = valEnd + 1; continue; }

      const tagName = tagMatch[1].toLowerCase();
      const openEnd = html.indexOf('>', idx);
      if (openEnd === -1) break;
      if (html[openEnd - 1] === '/') { pos = openEnd + 1; continue; } // self-closing

      const inner = depthTrack(html, tagName, openEnd + 1);
      if (inner !== null) return inner;
    }

    pos = valEnd + 1;
  }

  return null;
}

/**
 * Return the inner HTML of every element whose class attribute
 * includes className as an exact word.
 */
function extractAllByClass(html: string, className: string): string[] {
  const results: string[] = [];
  const marker = 'class="';
  let pos = 0;

  while (pos < html.length) {
    const idx = html.indexOf(marker, pos);
    if (idx === -1) break;

    const valStart = idx + marker.length;
    const valEnd = html.indexOf('"', valStart);
    if (valEnd === -1) break;

    const classes = html.slice(valStart, valEnd).split(/\s+/);
    if (classes.includes(className)) {
      const tagStart = html.lastIndexOf('<', idx);
      if (tagStart === -1) { pos = valEnd + 1; continue; }
      const tagMatch = /^<(\w+)/.exec(html.slice(tagStart));
      if (!tagMatch) { pos = valEnd + 1; continue; }

      const tagName = tagMatch[1].toLowerCase();
      const openEnd = html.indexOf('>', idx);
      if (openEnd === -1) break;

      if (html[openEnd - 1] === '/') {
        results.push('');
        pos = openEnd + 1;
        continue;
      }

      const contentStart = openEnd + 1;
      const inner = depthTrack(html, tagName, contentStart);
      if (inner !== null) {
        results.push(inner);
        pos = contentStart + inner.length + `</${tagName}>`.length;
      } else {
        pos = valEnd + 1;
      }
    } else {
      pos = valEnd + 1;
    }
  }

  return results;
}

/** Get the plain-text content of the first element with the given class. */
function getFirstText(html: string, className: string): string {
  const inner = extractByClass(html, className);
  return inner !== null ? htmlToText(inner) : '';
}

/**
 * Return the inner HTML of every element of the given tag name.
 * Uses depthTrack so nested same-tag elements are handled correctly.
 */
function extractAllByTag(html: string, tagName: string): string[] {
  const results: string[] = [];
  const openTag = `<${tagName}`;
  let pos = 0;

  while (pos < html.length) {
    const idx = html.indexOf(openTag, pos);
    if (idx === -1) break;

    const ch = html[idx + openTag.length];
    if (ch !== ' ' && ch !== '>' && ch !== '\n' && ch !== '\t' && ch !== '\r' && ch !== '/') {
      pos = idx + 1;
      continue;
    }

    const openEnd = html.indexOf('>', idx);
    if (openEnd === -1) break;

    if (html[openEnd - 1] === '/') {
      results.push('');
      pos = openEnd + 1;
      continue;
    }

    const contentStart = openEnd + 1;
    const inner = depthTrack(html, tagName, contentStart);
    if (inner !== null) {
      results.push(inner);
      pos = contentStart + inner.length + `</${tagName}>`.length;
    } else {
      pos = idx + 1;
    }
  }

  return results;
}

// ─── WPRM Recipe Parsing ──────────────────────────────────────

/**
 * Parse a full Recipe from WP Recipe Maker HTML.
 * Throws if the page has no WPRM markup or required fields are absent.
 */
function parseRecipeFromWprm(rawHtml: string, sourceUrl: string): Recipe {
  if (!rawHtml.includes('wprm-recipe-container')) {
    throw new Error('No WPRM recipe container found on page');
  }

  const title = getFirstText(rawHtml, 'wprm-recipe-name').trim();
  if (!title) throw new Error('Could not extract recipe title from WPRM');

  const prepTime = buildTimeString(rawHtml, 'prep_time');
  const cookTime = buildTimeString(rawHtml, 'cook_time');

  const servingsText = getFirstText(rawHtml, 'wprm-recipe-servings');
  const servingsUnit = getFirstText(rawHtml, 'wprm-recipe-servings-unit').trim().toLowerCase();
  const originalServings = resolveOriginalServings(parseInt(servingsText, 10) || 4, servingsUnit);

  // WPRM sites vary: some put all courses comma-separated in one span,
  // others use a separate span per course. Handle both by collecting all
  // matching spans then splitting each on commas.
  const courseItems = extractAllByClass(rawHtml, 'wprm-recipe-course')
    .flatMap((inner) => htmlToText(inner).split(','))
    .map((s) => s.trim())
    .filter(Boolean);
  const course = courseItems.length > 0 ? courseItems : undefined;

  const wprmTotal = buildTimeString(rawHtml, 'total_time');
  const totalTime = wprmTotal !== 'N/A' ? wprmTotal : combineTimes(prepTime, cookTime);
  const description = getFirstText(rawHtml, 'wprm-recipe-summary').trim() || undefined;
  const cuisine = getFirstText(rawHtml, 'wprm-recipe-cuisine').trim() || undefined;
  const difficulty = getFirstText(rawHtml, 'wprm-recipe-difficulty').trim() || undefined;

  const { ingredients, ingredientGroups } = parseWprmIngredients(rawHtml);
  if (ingredients.length === 0) throw new Error('No ingredients found in WPRM recipe');

  const instructions = parseWprmInstructions(rawHtml);
  if (instructions.length === 0) throw new Error('No instructions found in WPRM recipe');

  const notes = parseWprmNotes(rawHtml);
  const nutrition = parseWprmNutrition(rawHtml);

  console.log(
    `[RecipeScraper] Parsed WPRM "${title}" — ${ingredients.length} ingredient(s), ${instructions.length} step(s)`
  );

  return {
    title,
    sourceUrl,
    prepTime,
    cookTime,
    ...(totalTime !== 'N/A' ? { totalTime } : {}),
    originalServings,
    ...(course ? { course } : {}),
    ...(description ? { description } : {}),
    ...(cuisine ? { cuisine } : {}),
    ...(difficulty ? { difficulty } : {}),
    ingredients,
    ingredientGroups: ingredientGroups.length > 0 ? ingredientGroups : undefined,
    instructions: instructions.map(convertInstructionUnits),
    notes,
    nutrition,
    scrapedAt: new Date(),
  };
}

// ─── Course Compatibility ─────────────────────────────────────

// Condiment/sauce courses are never a complete meal regardless of meal type.
const CONDIMENT_COURSES = new Set([
  'sauce', 'dip', 'dressing', 'condiment', 'marinade', 'rub',
  'spread', 'jam', 'jelly', 'syrup', 'gravy', 'relish', 'chutney',
  'salsa', 'aioli', 'hummus', 'tapenade', 'garnish', 'glaze',
]);

const COURSE_ALLOWED: Record<MealType, string[]> = {
  breakfast: ['breakfast', 'brunch'],
  lunch:     ['lunch', 'brunch', 'salad', 'soup', 'main'],
  // Salad is excluded from dinner by default — only added when 'Salad' cuisine style chosen.
  dinner:    ['dinner', 'main', 'mains'],
  // Side dishes — recipes tagged with main/dinner are also valid here (multi-tag recipes).
  side:      ['side', 'entree', 'starter', 'appetizer', 'snack', 'salad', 'soup'],
};

/**
 * Returns true if the recipe's course is compatible with the requested meal type.
 *
 * Rules:
 *  - No course set → always keep (most recipes don't tag a course).
 *  - All courses are condiment types (sauce/dip/etc.) → always skip.
 *  - For dinner: salad-only course is rejected unless 'Salad' was explicitly chosen.
 *  - Otherwise: keep if ANY course value matches ANY allowed substring for the meal type.
 */
function isCourseCompatible(
  course: string[] | undefined,
  mealType: MealType,
  cuisineStyles: CuisineStyle[],
): boolean {
  if (!course || course.length === 0) return true;

  const lower = course.map((c) => c.toLowerCase());

  // Block pure condiment recipes
  if (lower.every((c) => CONDIMENT_COURSES.has(c))) {
    return false;
  }

  // Build the allowed list, adding salad for dinner when explicitly requested
  const allowed = [...COURSE_ALLOWED[mealType]];
  if (mealType === 'dinner' && cuisineStyles.includes('Salad')) {
    allowed.push('salad');
  }

  return lower.some((c) => allowed.some((a) => c.includes(a)));
}

// Units that represent individual items rather than people served.
// When a recipe says "makes 24 cookies", we treat it as serving 4 people.
// "piece"/"pieces" excluded: too broadly matches savory portioning ("serves 4 pieces of chicken").
const ITEM_SERVINGS_UNITS = new Set([
  'cookie', 'cookies', 'skewer', 'skewers',
  'bar', 'bars', 'muffin', 'muffins', 'biscuit', 'biscuits',
  'ball', 'balls', 'bite', 'bites', 'pancake', 'pancakes',
  'waffle', 'waffles', 'cupcake', 'cupcakes', 'brownie', 'brownies',
  'scone', 'scones', 'truffle', 'truffles',
]);

/**
 * Convert raw WPRM servings count into a "people served" number for scaling.
 * Item-based units (e.g. "24 cookies") → default 4 people.
 * People-based units (e.g. "4 servings") → use the number directly.
 */
function resolveOriginalServings(rawCount: number, unit: string): number {
  if (ITEM_SERVINGS_UNITS.has(unit)) return 4;
  return rawCount || 4;
}

/**
 * Add two time strings (e.g. "20 min" + "30 min" → "50 min").
 * Returns 'N/A' if neither time is parseable.
 */
function combineTimes(t1: string, t2: string): string {
  const m1 = parseMinutes(t1) ?? 0;
  const m2 = parseMinutes(t2) ?? 0;
  const total = m1 + m2;
  if (!total) return 'N/A';
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h && m) return `${h} hr ${m} min`;
  return h ? `${h} hr` : `${m} min`;
}

/** Build a human-readable time string from WPRM hour/minute spans. */
function buildTimeString(html: string, timeType: string): string {
  const hoursText = getFirstText(html, `wprm-recipe-${timeType}-hours`);
  const minsText = getFirstText(html, `wprm-recipe-${timeType}-minutes`);
  const hours = parseInt(hoursText, 10) || 0;
  const mins = parseInt(minsText, 10) || 0;
  if (!hours && !mins) return 'N/A';
  if (hours && mins) return `${hours} hr ${mins} min`;
  return hours ? `${hours} hr` : `${mins} min`;
}

/**
 * Parse all WPRM ingredients.
 * Returns a flat list (for shopping list) and groups (for display).
 * When groups exist, the flat list is the concatenation of all group ingredients.
 */
function parseWprmIngredients(html: string): {
  ingredients: Ingredient[];
  ingredientGroups: IngredientGroup[];
} {
  const groupHtmls = extractAllByClass(html, 'wprm-recipe-ingredient-group');

  if (groupHtmls.length > 0) {
    const ingredientGroups: IngredientGroup[] = [];
    const allIngredients: Ingredient[] = [];

    for (const groupHtml of groupHtmls) {
      const groupName = htmlToText(
        extractByClass(groupHtml, 'wprm-recipe-ingredient-group-name') ?? ''
      );
      const liHtmls = extractAllByClass(groupHtml, 'wprm-recipe-ingredient');
      const groupIngredients = liHtmls
        .map(parseWprmIngredient)
        .filter((i) => i.name && i.name !== 'unknown');

      if (groupIngredients.length > 0) {
        ingredientGroups.push({ name: groupName, ingredients: groupIngredients });
        allIngredients.push(...groupIngredients);
      }
    }

    if (allIngredients.length > 0) {
      return { ingredients: allIngredients, ingredientGroups };
    }
  }

  // No groups — flat list
  const liHtmls = extractAllByClass(html, 'wprm-recipe-ingredient');
  const ingredients = liHtmls
    .map(parseWprmIngredient)
    .filter((i) => i.name && i.name !== 'unknown');
  return { ingredients, ingredientGroups: [] };
}

/** Parse a single WPRM ingredient <li> inner HTML into an Ingredient. */
function parseWprmIngredient(liHtml: string): Ingredient {
  const amountText = getFirstText(liHtml, 'wprm-recipe-ingredient-amount');
  const unitRaw = getFirstText(liHtml, 'wprm-recipe-ingredient-unit').trim();
  const nameText = getFirstText(liHtml, 'wprm-recipe-ingredient-name').trim();
  const notesRaw = getFirstText(liHtml, 'wprm-recipe-ingredient-notes').trim();

  let quantity = parseQuantityString(amountText);
  let unit = normalizeWprmUnit(unitRaw);

  // Convert oz/lb to metric
  const converted = convertIngredientWeight(quantity, unit);
  quantity = converted.quantity;
  unit = converted.unit;

  // Strip leading punctuation from notes (WPRM often includes ", minced")
  // Also strip Budget Bytes–style price annotations e.g. "$0.15"
  const notes = notesRaw
    .replace(/^[,;]\s*/, '')
    .replace(/\$[\d.]+\b/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return {
    name: nameText || 'unknown',
    quantity,
    unit,
    ...(notes ? { notes } : {}),
  };
}

/** Parse a WPRM quantity string, handling fractions and unicode fraction chars. */
function parseQuantityString(s: string): number {
  if (!s.trim()) return 0;

  s = s
    .replace(/¼/g, '1/4').replace(/½/g, '1/2').replace(/¾/g, '3/4')
    .replace(/⅓/g, '1/3').replace(/⅔/g, '2/3')
    .replace(/⅛/g, '1/8').replace(/⅜/g, '3/8').replace(/⅝/g, '5/8').replace(/⅞/g, '7/8')
    .trim();

  // Mixed number: "1 1/2"
  const mixed = s.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (mixed) {
    return parseInt(mixed[1], 10) + parseInt(mixed[2], 10) / parseInt(mixed[3], 10);
  }

  // Fraction: "1/2"
  const frac = s.match(/^(\d+)\/(\d+)$/);
  if (frac) return parseInt(frac[1], 10) / parseInt(frac[2], 10);

  return parseFloat(s) || 0;
}

/** Normalise WPRM unit strings to canonical lowercase abbreviations. */
function normalizeWprmUnit(unit: string): string {
  const u = unit.toLowerCase().trim();
  const MAP: Record<string, string> = {
    tablespoon: 'tbsp', tablespoons: 'tbsp',
    teaspoon: 'tsp', teaspoons: 'tsp',
    cup: 'cup', cups: 'cup',
    gram: 'g', grams: 'g',
    kilogram: 'kg', kilograms: 'kg',
    milliliter: 'ml', milliliters: 'ml', millilitre: 'ml', millilitres: 'ml',
    liter: 'l', liters: 'l', litre: 'l', litres: 'l',
    ounce: 'oz', ounces: 'oz',
    pound: 'lb', pounds: 'lb',
    'fluid ounce': 'fl oz', 'fluid ounces': 'fl oz',
    clove: 'clove', cloves: 'clove',
    slice: 'slice', slices: 'slice',
    piece: 'piece', pieces: 'piece',
    can: 'can', cans: 'can',
    jar: 'jar', jars: 'jar',
    bag: 'bag', bags: 'bag',
    bunch: 'bunch', bunches: 'bunch',
    stalk: 'stalk', stalks: 'stalk',
    sprig: 'sprig', sprigs: 'sprig',
    pinch: 'pinch', pinches: 'pinch',
    dash: 'dash', dashes: 'dash',
    handful: 'handful', handfuls: 'handful',
    pint: 'pint', pints: 'pint',
    quart: 'quart', quarts: 'quart',
  };
  return MAP[u] ?? u;
}

/** Convert oz → g and lb → g/kg. */
function convertIngredientWeight(quantity: number, unit: string): { quantity: number; unit: string } {
  if (unit === 'oz') {
    return { quantity: Math.round(quantity * 28.35), unit: 'g' };
  }
  if (unit === 'lb') {
    const grams = quantity * 453.6;
    if (grams >= 500) return { quantity: Math.round(grams / 100) / 10, unit: 'kg' };
    return { quantity: Math.round(grams), unit: 'g' };
  }
  return { quantity, unit };
}

/** Parse all WPRM instruction steps into plain text strings. */
function parseWprmInstructions(html: string): string[] {
  return extractAllByClass(html, 'wprm-recipe-instruction-text')
    .map(htmlToText)
    .filter((t) => t.length > 0);
}

/** Parse the WPRM notes container, numbering list items where present. */
function parseWprmNotes(html: string): string {
  const inner = extractByClass(html, 'wprm-recipe-notes-container');
  if (!inner) return '';

  // If the notes contain <li> items, extract and number them (1. 2. 3.)
  const liItems = extractAllByTag(inner, 'li')
    .map((li) => htmlToText(li).trim())
    .filter((t) => t.length > 0);

  if (liItems.length > 0) {
    return liItems.map((item, i) => `${i + 1}. ${item}`).join('\n');
  }

  // Fallback: convert to plain text, split by paragraph/line, number if multiple.
  // Use a sentinel (\x00) to preserve intended newlines through htmlToText's whitespace collapse.
  const marked = inner
    .replace(/<br\s*\/?>/gi, '\x00')
    .replace(/<\/p>/gi, '\x00');
  const plain = htmlToText(marked)   // strips tags + decodes ALL entities
    .replace(/\x00/g, '\n')          // restore newline sentinels
    .replace(/ *\n */g, '\n')        // trim spaces around newlines
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const lines = plain.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length > 1) {
    return lines.map((line, i) => `${i + 1}. ${line}`).join('\n');
  }

  return plain;
}

// ─── Nutrition Parsing ───────────────────────────────────────

/**
 * Extract a number from a Schema.org nutrition field value.
 * Handles strings like "320 calories", "25 g", "12", etc.
 */
function extractNutritionNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const m = String(value).match(/[\d.]+/);
  return m ? Math.round(parseFloat(m[0])) : 0;
}

/**
 * Parse nutrition from JSON-LD Schema.org structured data.
 *
 * Every WPRM site automatically emits a <script type="application/ld+json">
 * Recipe block for Google rich snippets — this is far more reliable than
 * scraping CSS classes because it's standardised and version-independent.
 *
 * Handles three JSON-LD shapes:
 *   - Root object:   { "@type": "Recipe", "nutrition": {...} }
 *   - Root array:    [{ "@type": "Recipe", ... }]
 *   - @graph wrap:   { "@graph": [{ "@type": "Recipe", ... }] }
 */
function parseJsonLdNutrition(html: string): Recipe['nutrition'] | null {
  const scriptRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;

  while ((match = scriptRe.exec(html)) !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[1]);
    } catch {
      continue; // malformed JSON — skip
    }

    // Flatten to a list of candidate objects
    const candidates: unknown[] = [];
    if (Array.isArray(parsed)) {
      candidates.push(...parsed);
    } else if (parsed && typeof parsed === 'object') {
      const graph = (parsed as Record<string, unknown>)['@graph'];
      if (Array.isArray(graph)) candidates.push(...graph);
      else candidates.push(parsed);
    }

    for (const obj of candidates) {
      if (!obj || typeof obj !== 'object') continue;
      const o = obj as Record<string, unknown>;

      // @type can be a string or an array (e.g. ["Recipe", "WebPage"])
      const types = Array.isArray(o['@type']) ? o['@type'] : [o['@type']];
      if (!types.includes('Recipe')) continue;

      const n = o['nutrition'];
      if (!n || typeof n !== 'object') continue;
      const nutrition = n as Record<string, unknown>;

      const calories = extractNutritionNumber(nutrition['calories']);
      const protein  = extractNutritionNumber(nutrition['proteinContent']);
      const carbs    = extractNutritionNumber(nutrition['carbohydrateContent']);
      const fat      = extractNutritionNumber(nutrition['fatContent']);

      if (calories > 0 || protein > 0 || carbs > 0 || fat > 0) {
        console.log(`[RecipeScraper] Nutrition from JSON-LD: ${calories} kcal, P${protein}g, C${carbs}g, F${fat}g`);
        return { calories, protein, carbs, fat };
      }
    }
  }

  return null;
}

/**
 * Parse WPRM nutrition via CSS classes.
 *
 * Three patterns observed in real WPRM HTML:
 *
 * Pattern A — container has nutrient suffix, value span is generic (RecipeTin Eats style):
 *   <span class="wprm-nutrition-label-text-nutrition-container-calories">
 *     <span class="wprm-nutrition-label-text-nutrition-value">362</span>
 *   </span>
 *
 * Pattern B — value span has nutrient suffix (WPRM Nutrition Label block):
 *   <span class="wprm-nutrition-label-text-nutrition-value-calories">320</span>
 *
 * Pattern C — legacy simple-text mode:
 *   <span class="wprm-nutrition-label-text-for-calories">320</span>
 *
 * Pattern D — compact per-serving strip:
 *   <span class="wprm-recipe-calories">320</span>
 */
function parseWprmNutritionByClass(html: string): Recipe['nutrition'] {
  // Pattern A: extract the per-nutrient container, then find the generic value span inside it.
  const fromContainer = (nutrient: string): number => {
    const container = extractByClass(html, `wprm-nutrition-label-text-nutrition-container-${nutrient}`);
    if (!container) return 0;
    const text = getFirstText(container, 'wprm-nutrition-label-text-nutrition-value');
    const m = text.match(/[\d.]+/);
    return m ? Math.round(parseFloat(m[0])) : 0;
  };

  // Patterns B / C / D: direct class on the value element.
  const fromClass = (...classes: string[]): number => {
    for (const cls of classes) {
      const text = getFirstText(html, cls);
      const m = text.match(/[\d.]+/);
      if (m) return Math.round(parseFloat(m[0]));
    }
    return 0;
  };

  const pick = (nutrient: string, ...fallbacks: string[]): number =>
    fromContainer(nutrient) ||
    fromClass(
      `wprm-nutrition-label-text-nutrition-value-${nutrient}`,
      ...fallbacks,
    );

  return {
    calories: pick('calories', 'wprm-nutrition-label-text-for-calories', 'wprm-recipe-calories'),
    protein:  pick('protein',  'wprm-nutrition-label-text-for-protein',  'wprm-recipe-protein'),
    carbs:    pick('carbohydrates', 'wprm-nutrition-label-text-for-carbohydrates', 'wprm-recipe-carbohydrates'),
    fat:      pick('fat',      'wprm-nutrition-label-text-for-fat',      'wprm-recipe-fat'),
  };
}

/** Parse nutrition: JSON-LD first (most reliable), CSS classes as fallback. */
function parseWprmNutrition(html: string): Recipe['nutrition'] {
  const fromJsonLd = parseJsonLdNutrition(html);
  if (fromJsonLd) return fromJsonLd;

  console.log('[RecipeScraper] No JSON-LD nutrition found — falling back to CSS class extraction');
  return parseWprmNutritionByClass(html);
}

// ─── Instruction Unit Conversion ──────────────────────────────

/**
 * Programmatically convert imperial measurements in instruction text.
 *   °F / degrees F / degrees Fahrenheit → °C  (rounded integer)
 *   X inch / X inches                   → Xcm (× 2.54, 1 decimal)
 */
function convertInstructionUnits(text: string): string {
  text = text.replace(
    /(\d+(?:\.\d+)?)\s*(?:°\s*F|degrees?\s+(?:Fahrenheit|F))\b/gi,
    (_, f) => `${Math.round((parseFloat(f) - 32) * 5 / 9)}°C`
  );
  text = text.replace(
    /(\d+(?:\.\d+)?)\s*inches?\b/gi,
    (_, i) => `${Math.round(parseFloat(i) * 2.54 * 10) / 10}cm`
  );
  return text;
}

// ─── Private Helpers ──────────────────────────────────────────

function applyServingScale(recipe: Recipe, requiredServings: number): Recipe {
  const factor = requiredServings / recipe.originalServings;
  const scaleIng = (ing: Ingredient): Ingredient => ({
    ...ing,
    quantity: Math.round(ing.quantity * factor * 100) / 100,
  });

  return {
    ...recipe,
    ingredients: recipe.ingredients.map(scaleIng),
    ingredientGroups: recipe.ingredientGroups?.map((group) => ({
      ...group,
      ingredients: group.ingredients.map(scaleIng),
    })),
  };
}

function shuffleArray<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function parseMinutes(timeStr: string): number | null {
  if (!timeStr || timeStr === 'N/A' || !timeStr.trim()) return null;
  let total = 0;
  let found = false;
  const hrMatch = timeStr.match(/(\d+(?:\.\d+)?)\s*(?:hr|hour|h)\b/i);
  const minMatch = timeStr.match(/(\d+(?:\.\d+)?)\s*(?:min|minute|m)\b/i);
  if (hrMatch) { total += parseFloat(hrMatch[1]) * 60; found = true; }
  if (minMatch) { total += parseFloat(minMatch[1]); found = true; }
  return found ? Math.round(total) : null;
}

type TimeCheckResult = 'pass' | 'fail' | 'unparseable';

function checkTimeConstraint(recipe: Recipe, cuisineStyles: CuisineStyle[]): TimeCheckResult {
  const isQuickEasy = cuisineStyles.includes('Quick & Easy');
  const isModerate = cuisineStyles.includes('Moderate');
  if (!isQuickEasy && !isModerate) return 'pass';

  const prepMins = parseMinutes(recipe.prepTime);
  const cookMins = parseMinutes(recipe.cookTime);
  if (prepMins === null && cookMins === null) return 'unparseable';

  const total = (prepMins ?? 0) + (cookMins ?? 0);
  if (isQuickEasy && total > 30) return 'fail';
  if (isModerate && total > 60) return 'fail';
  return 'pass';
}
