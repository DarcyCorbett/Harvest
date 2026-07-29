// ============================================================
// Trusted sites, cuisine keywords, dish vocab, search query builder,
// and site prioritisation — the "what do we search for, and where" layer.
// ============================================================

import type { CuisineStyle, HouseholdSettings, MealType } from '../types';

// ─── Trusted Sites ──────────────────────────────────────────
// The scraper now uses Schema.org JSON-LD as its primary data source, so any
// site that ships a <script type="application/ld+json"> Recipe block is
// fair game — no longer limited to WP Recipe Maker plugin sites.

export const TRUSTED_SITES = [
  'www.recipetineats.com',
  'www.budgetbytes.com',
  'thewoksoflife.com',
  'www.themediterraneandish.com',
  'www.spendwithpennies.com',
  'cafedelites.com',
  'www.skinnytaste.com',
  'pinchofyum.com',
  'natashaskitchen.com',
  'akispetretzikis.com',
  'cooking.nytimes.com',
  'www.americastestkitchen.com',
] as const;

// Sites whose URL discovery goes through the offline-built /recipeIndex Firestore
// pool with lazy Gemini tagging at generation time, instead of the WP REST API.
// recipeScraperService.scrapeRecipe dispatches to fetchIndexedCandidates for these.
export const INDEXED_SITES: readonly string[] = [
  'akispetretzikis.com',
  'cooking.nytimes.com',
  'www.americastestkitchen.com',
];

export const SITE_SEARCH_URLS: Record<string, (q: string) => string> = {
  'www.recipetineats.com': (q) =>
    `https://www.recipetineats.com/wp-json/wp/v2/posts?search=${encodeURIComponent(q)}&per_page=25&_fields=link`,
  'www.budgetbytes.com': (q) =>
    `https://www.budgetbytes.com/wp-json/wp/v2/posts?search=${encodeURIComponent(q)}&per_page=25&_fields=link`,
  'thewoksoflife.com': (q) =>
    `https://thewoksoflife.com/wp-json/wp/v2/posts?search=${encodeURIComponent(q)}&per_page=25&_fields=link`,
  'www.themediterraneandish.com': (q) =>
    `https://www.themediterraneandish.com/wp-json/wp/v2/posts?search=${encodeURIComponent(q)}&per_page=25&_fields=link`,
  'www.spendwithpennies.com': (q) =>
    `https://www.spendwithpennies.com/wp-json/wp/v2/posts?search=${encodeURIComponent(q)}&per_page=25&_fields=link`,
  'cafedelites.com': (q) =>
    `https://cafedelites.com/wp-json/wp/v2/posts?search=${encodeURIComponent(q)}&per_page=25&_fields=link`,
  'www.skinnytaste.com': (q) =>
    `https://www.skinnytaste.com/wp-json/wp/v2/posts?search=${encodeURIComponent(q)}&per_page=25&_fields=link`,
  'pinchofyum.com': (q) =>
    `https://pinchofyum.com/wp-json/wp/v2/posts?search=${encodeURIComponent(q)}&per_page=25&_fields=link`,
  'natashaskitchen.com': (q) =>
    `https://natashaskitchen.com/wp-json/wp/v2/posts?search=${encodeURIComponent(q)}&per_page=25&_fields=link`,
};

// ─── Cuisine Keywords ────────────────────────────────────────

const CUISINE_KEYWORDS: Record<CuisineStyle, string> = {
  'Quick & Easy': '',
  'Moderate': '',
  'Vegetarian': 'vegetarian',
  'Kid Friendly': '',
  'Healthy': '',
  'Asian': 'Asian',
  'Mexican': 'Mexican',
  'Mediterranean': 'Mediterranean',
  'Italian': 'Italian',
  'Indian': 'Indian',
  'Salad': 'salad',
  'Custom': '',
};

const CUISINE_KEYWORD_VARIANTS: Partial<Record<CuisineStyle, string[]>> = {
  'Healthy': [
    'healthy', 'light', 'low calorie', 'low cal', 'wholesome',
    'clean eating', 'lean', 'high protein', 'low fat', 'guilt free',
    'lightened up', 'nourishing',
  ],
  'Kid Friendly': [
    'family', 'kid friendly', 'kids', 'easy', 'simple',
    'weeknight', 'family dinner', 'picky eater', 'mild',
    'crowd pleaser', 'family friendly', 'comfort food',
  ],
};

const FOOD_RESTRICTING_STYLES = new Set<CuisineStyle>(['Vegetarian']);

// ─── Dish Vocabulary ─────────────────────────────────────────

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
  Italian: {
    breakfast: ['eggs', 'bread', 'cheese', 'prosciutto', 'frittata'],
    lunch: ['pasta', 'chicken', 'fish', 'salad', 'mozzarella', 'prosciutto', 'vegetables'],
    dinner: ['pasta', 'chicken', 'beef', 'fish', 'lamb', 'pork', 'risotto', 'bake', 'one pan'],
    side: ['pasta', 'salad', 'bread', 'vegetables', 'risotto', 'polenta'],
  },
  Indian: {
    breakfast: ['eggs', 'bread', 'yoghurt', 'lentils', 'potato'],
    lunch: ['chicken', 'lamb', 'lentils', 'chickpeas', 'rice', 'paneer', 'vegetables'],
    dinner: ['chicken', 'lamb', 'beef', 'fish', 'lentils', 'chickpeas', 'paneer', 'prawn', 'curry', 'rice', 'bake'],
    side: ['rice', 'lentils', 'bread', 'vegetables', 'yoghurt', 'chickpeas'],
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

// ─── Search Query Builder ────────────────────────────────────

export interface SearchQueryContext {
  mealType: MealType;
  cuisineStyles: CuisineStyle[];
  customInstructions?: string;
  settings?: HouseholdSettings;
  forceSeed?: string;
}

export function buildSearchQuery(ctx: SearchQueryContext): string {
  const parts: string[] = [];
  const hasFoodRestriction = ctx.cuisineStyles.some((s) => FOOD_RESTRICTING_STYLES.has(s));

  for (const style of ctx.cuisineStyles) {
    const variants = CUISINE_KEYWORD_VARIANTS[style];
    const keyword = variants
      ? variants[Math.floor(Math.random() * variants.length)]
      : CUISINE_KEYWORDS[style];
    if (keyword) parts.push(keyword);
  }

  if (hasFoodRestriction) {
    if (ctx.forceSeed) {
      console.log(`[RecipeScraper] forceSeed="${ctx.forceSeed}" BYPASSED — hasFoodRestriction=true (cuisineStyles: ${ctx.cuisineStyles.join(', ')})`);
    }
    parts.push(ctx.mealType);
  } else {
    const pool = getDishPool(ctx.cuisineStyles, ctx.mealType);
    const foodItem = ctx.forceSeed ?? weightedRandomItem(pool, ctx.settings?.ingredientWeights ?? {});
    if (ctx.forceSeed) {
      console.log(`[RecipeScraper] forceSeed="${ctx.forceSeed}" APPLIED to query`);
    }
    parts.push(foodItem);
  }

  if (ctx.customInstructions?.trim()) {
    parts.push(ctx.customInstructions.trim());
  }

  return parts.join(' ');
}

/**
 * Tag form of a search query for the indexed-pool Firestore lookup. Returns
 * canonical tag strings matching the taxonomy used by `tagRecipesWithGemini`
 * in services/gemini.ts:
 *   - Course (Title case):   "Breakfast" | "Lunch" | "Dinner" | "Side" | "Snack" | "Salad"
 *   - Cuisine:               "Asian" | "Mexican" | "Mediterranean" | "Italian" | "Indian"
 *   - Modifiers:             "Healthy" | "Vegetarian" | "Kid Friendly"
 *
 * `forceSeed` (an ingredient like "chicken") is intentionally NOT a tag —
 * ingredients aren't in the Gemini taxonomy. Seed-based filtering happens
 * client-side against the `ingredients` field of the index doc, in
 * fetchIndexedCandidates after the array-contains-any pull.
 */
export function buildQueryTags(ctx: SearchQueryContext): string[] {
  const tags: string[] = [];
  // 'Quick & Easy', 'Moderate', and 'Custom' aren't in the Gemini taxonomy.
  // 'Salad', 'Vegetarian', 'Healthy', 'Kid Friendly', and the cuisines are.
  const skip = new Set<CuisineStyle>(['Quick & Easy', 'Moderate', 'Custom']);
  for (const style of ctx.cuisineStyles) {
    if (!skip.has(style)) tags.push(style);
  }
  // mealType is lowercase ('dinner'); tag form is title-case ('Dinner').
  tags.push(ctx.mealType.charAt(0).toUpperCase() + ctx.mealType.slice(1));
  return tags;
}

export function getDishPool(cuisineStyles: CuisineStyle[], mealType: MealType): readonly string[] {
  if (cuisineStyles.includes('Asian')) return DISH_VOCAB.Asian[mealType] ?? DISH_VOCAB.general[mealType];
  if (cuisineStyles.includes('Mexican')) return DISH_VOCAB.Mexican[mealType] ?? DISH_VOCAB.general[mealType];
  if (cuisineStyles.includes('Mediterranean')) return DISH_VOCAB.Mediterranean[mealType] ?? DISH_VOCAB.general[mealType];
  return DISH_VOCAB.general[mealType];
}

/** Return a weighted-random item from a pool. Items absent from weights default to weight 1. */
export function weightedRandomItem(pool: readonly string[], weights: Record<string, number>): string {
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

export function prioritiseSites(cuisineStyles: CuisineStyle[], settings?: HouseholdSettings): string[] {
  const sourceWeights = settings?.sourceWeights ?? {};

  // Filter out disabled sites (weight === 0)
  const all = (TRUSTED_SITES as readonly string[]).filter((s) => (sourceWeights[s] ?? 1) > 0);
  if (all.length === 0) return [];

  // Weighted random pick for the starting site — purely user-controlled weights
  const weights = all.map((s) => Math.max(1, sourceWeights[s] ?? 1));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  let pickedIndex = all.length - 1;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r <= 0) { pickedIndex = i; break; }
  }

  const picked = all[pickedIndex];
  const rest = all.filter((_, i) => i !== pickedIndex);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }

  return [picked, ...rest];
}
