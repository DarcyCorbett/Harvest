// ============================================================
// Recipe eligibility filters — dietary, course, time, and seed checks.
// Pure predicates over `Recipe` — no HTTP, no I/O.
// ============================================================

import type { CuisineStyle, HouseholdSettings, KidFriendlySettings, MealType, Recipe } from '../types';
import { parseMinutes } from './parse';

// ─── Course Tag Values ────────────────────────────────────────

/** Tags that encode a course assignment — shared by the scraper and the UI. */
export const COURSE_TAG_VALUES = new Set([
  'Breakfast', 'Lunch', 'Dinner', 'Side', 'Snack', 'Salad',
] as const);

// ─── Kid Friendly Filter ──────────────────────────────────────

const SPICY_TITLE_WORDS = [
  'spicy', 'fiery', 'hot and', 'extra hot', 'buffalo',
  'inferno', 'sriracha', 'jalapeño', 'habanero',
];

export const KID_FRIENDLY_DEFAULTS = {
  hotIngredients: [
    'chilli', 'chili', 'cayenne', 'sriracha', 'hot sauce', 'jalapeño', 'jalapeno',
    'habanero', 'scotch bonnet', 'tabasco', 'sambal', 'gochujang',
    'chilli flakes', 'red pepper flakes',
  ],
  adultFlavours: [
    'anchovy', 'anchovies', 'caper', 'capers', 'blue cheese', 'gorgonzola',
    'stilton', 'roquefort', 'liver', 'pâté', 'pate',
  ],
  alcohol: [
    'wine', 'beer', 'lager', 'ale', 'bourbon', 'brandy', 'cognac',
    'rum', 'whisky', 'whiskey', 'vodka', 'gin', 'sherry',
  ],
} as const;

// Cooking ingredients that technically contain an alcohol word but cook off
// and are universally used in kid-eaten dishes. When an ingredient name
// includes one of these, the alcohol category of the block list is skipped.
const KID_SAFE_COOKING_ALCOHOLS = [
  'rice wine', 'cooking wine', 'shaoxing', 'mirin', 'sake', 'vanilla extract',
];

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whole-word match (case-insensitive) with tolerance for regular plurals.
 * Prevents substring false positives like:
 *   - "ginger" matching "gin", "crumbs" matching "rum", "collard" matching "lard"
 *   - "virgin" olive oil triggering alcohol checks
 *   - "lamb's lettuce" / "beefsteak tomato" triggering meat checks
 * Still matches regular plurals ("prawns" for term "prawn", "anchovies"
 * is handled by callers listing both "anchovy" and "anchovies" explicitly).
 */
export function matchesWord(name: string, term: string): boolean {
  return new RegExp(`\\b${escapeRegex(term)}(?:s|es)?\\b`, 'i').test(name);
}

function checkKidFriendly(
  recipe: Recipe,
  settings?: KidFriendlySettings
): { ok: boolean; reason?: string } {
  const maxIng = settings?.maxIngredients ?? 20;
  if (recipe.ingredients.length > maxIng)
    return { ok: false, reason: `too many ingredients (${recipe.ingredients.length} > ${maxIng})` };

  const titleLower = recipe.title.toLowerCase();
  const descLower = (recipe.description ?? '').toLowerCase();
  const spicyWord = SPICY_TITLE_WORDS.find((w) => matchesWord(titleLower, w) || matchesWord(descLower, w));
  if (spicyWord) return { ok: false, reason: `spicy title/desc word "${spicyWord}"` };

  const exceptions = new Set((settings?.allowedExceptions ?? []).map((s) => s.toLowerCase()));
  const extras = (settings?.excludedIngredients ?? []).map((s) => s.toLowerCase());
  const alcoholSet = new Set((KID_FRIENDLY_DEFAULTS.alcohol as readonly string[]).map((s) => s.toLowerCase()));

  const fullBlockList = [
    ...KID_FRIENDLY_DEFAULTS.hotIngredients,
    ...KID_FRIENDLY_DEFAULTS.adultFlavours,
    ...KID_FRIENDLY_DEFAULTS.alcohol,
  ]
    .filter((term) => !exceptions.has(term.toLowerCase()))
    .map((s) => s.toLowerCase())
    .concat(extras);

  for (const ing of recipe.ingredients) {
    const name = ing.name.toLowerCase();
    if ((ing.notes ?? '').toLowerCase().includes('optional')) continue;

    const isCookingAlcohol = KID_SAFE_COOKING_ALCOHOLS.some((s) => name.includes(s));
    const applicableBlocks = isCookingAlcohol
      ? fullBlockList.filter((t) => !alcoholSet.has(t))
      : fullBlockList;

    const hit = applicableBlocks.find((term) => matchesWord(name, term));
    if (hit) return { ok: false, reason: `ingredient "${ing.name}" matches "${hit}"` };
  }
  return { ok: true };
}

export function isKidFriendly(recipe: Recipe, settings?: KidFriendlySettings): boolean {
  return checkKidFriendly(recipe, settings).ok;
}

function kidFriendlyBlocker(recipe: Recipe, settings?: KidFriendlySettings): string {
  return checkKidFriendly(recipe, settings).reason ?? 'unknown';
}

// ─── Healthy Filter ──────────────────────────────────────────

const DEEP_FRY_RE = /\bdeep.?fri(ed|es|ing)\b|\bdeep.?fry\b/i;

const HEAVY_CREAM_TERMS = [
  'heavy cream', 'double cream', 'thickened cream', 'whipping cream', 'full cream',
];

const UNHEALTHY_FAT_INGREDIENTS = ['lard', 'shortening', 'suet', 'duck fat', 'goose fat'];

function checkHealthy(recipe: Recipe): { ok: boolean; reason?: string } {
  if (DEEP_FRY_RE.test(recipe.instructions.join(' ')))
    return { ok: false, reason: 'deep frying detected in instructions' };
  if (recipe.nutrition.calories > 0 && recipe.nutrition.calories > 800)
    return { ok: false, reason: `calories ${recipe.nutrition.calories} > 800` };

  const ingNames = recipe.ingredients.map((i) => i.name.toLowerCase());
  let penalties = 0;
  let lastReason = 'unknown';

  const heavyCream = HEAVY_CREAM_TERMS.find((t) => ingNames.some((n) => matchesWord(n, t)));
  if (heavyCream) { penalties++; lastReason = `heavy cream ingredient "${heavyCream}"`; }

  const unhealthyFat = UNHEALTHY_FAT_INGREDIENTS.find((t) => ingNames.some((n) => matchesWord(n, t)));
  if (unhealthyFat) { penalties++; lastReason = `unhealthy fat "${unhealthyFat}"`; }

  if (recipe.nutrition.fat > 0 && recipe.nutrition.fat > 40) {
    penalties++;
    lastReason = `fat ${recipe.nutrition.fat}g > 40g`;
  }

  return penalties > 1 ? { ok: false, reason: lastReason } : { ok: true };
}

export function isHealthy(recipe: Recipe): boolean {
  return checkHealthy(recipe).ok;
}

function healthyBlocker(recipe: Recipe): string {
  return checkHealthy(recipe).reason ?? 'unknown';
}

// ─── Vegetarian Filter ────────────────────────────────────────

export const MEAT_INGREDIENTS = [
  'beef', 'steak', 'mince', 'ground beef', 'brisket', 'short rib', 'veal',
  'pork', 'bacon', 'ham', 'prosciutto', 'pancetta', 'chorizo', 'salami', 'lard',
  'lamb', 'mutton',
  'chicken', 'turkey', 'duck', 'quail',
  'fish', 'salmon', 'tuna', 'cod', 'snapper', 'barramundi', 'tilapia',
  'shrimp', 'prawn', 'crab', 'lobster', 'oyster', 'clam', 'mussel',
  'anchovy', 'anchovies', 'sardine', 'sardines', 'squid', 'octopus', 'scallop',
  'venison', 'rabbit',
] as const;

function checkVegetarian(recipe: Recipe): { ok: boolean; reason?: string } {
  for (const ing of recipe.ingredients) {
    const name = ing.name.toLowerCase();
    if ((ing.notes ?? '').toLowerCase().includes('optional')) continue;
    const hit = (MEAT_INGREDIENTS as readonly string[]).find((m) => matchesWord(name, m));
    if (hit) return { ok: false, reason: `ingredient "${ing.name}" matches "${hit}"` };
  }
  return { ok: true };
}

export function isVegetarian(recipe: Recipe): boolean {
  return checkVegetarian(recipe).ok;
}

function vegetarianBlocker(recipe: Recipe): string {
  return checkVegetarian(recipe).reason ?? 'unknown';
}

// ─── Seed Synonym Matching ────────────────────────────────────

export const SEED_SYNONYMS: Record<string, string[]> = {
  'fish': ['salmon', 'cod', 'tuna', 'snapper', 'barramundi', 'tilapia', 'trout',
    'halibut', 'bream', 'perch', 'flounder', 'haddock', 'pollock', 'mahi',
    'swordfish', 'bass', 'mackerel', 'sardine', 'anchovy'],
  'seafood': ['prawn', 'shrimp', 'crab', 'lobster', 'squid', 'octopus',
    'scallop', 'mussel', 'clam', 'oyster'],
  'meat': ['beef', 'pork', 'lamb', 'chicken', 'turkey', 'duck', 'veal', 'venison',
    'sausage', 'bacon', 'ham', 'chorizo'],
  'beef': ['steak', 'mince', 'brisket', 'short rib', 'ground beef'],
  'pork': ['bacon', 'ham', 'prosciutto', 'pancetta', 'chorizo', 'salami'],
  'lamb': ['mutton'],
};

const CONDIMENT_DISQUALIFIERS = new Set([
  'sauce', 'stock', 'broth', 'powder', 'paste', 'extract', 'bouillon',
  'flavoring', 'flavour', 'seasoning', 'flakes', 'cube', 'cubes', 'gravy',
  'marinade', 'dressing', 'glaze', 'rub', 'oil',
]);

function ingredientMatchesTerm(ingredientName: string, term: string): boolean {
  const lower = ingredientName.toLowerCase();
  if (!matchesWord(lower, term)) return false;
  const words = lower.split(/[\s,]+/);
  return !words.some((w) => CONDIMENT_DISQUALIFIERS.has(w));
}

export function seedMatchesRecipe(seed: string, recipe: Recipe): boolean {
  const terms = [seed.toLowerCase(), ...(SEED_SYNONYMS[seed.toLowerCase()] ?? [])];
  return (
    terms.some((t) => matchesWord(recipe.title, t)) ||
    recipe.ingredients.some((ing) => terms.some((t) => ingredientMatchesTerm(ing.name, t)))
  );
}

// ─── Course Compatibility ─────────────────────────────────────

const CONDIMENT_COURSES = new Set([
  'sauce', 'dip', 'dressing', 'condiment', 'marinade', 'rub',
  'spread', 'jam', 'jelly', 'syrup', 'gravy', 'relish', 'chutney',
  'salsa', 'aioli', 'hummus', 'tapenade', 'garnish', 'glaze',
]);

const COURSE_ALLOWED: Record<MealType, string[]> = {
  breakfast: ['breakfast', 'brunch'],
  lunch: ['lunch', 'brunch', 'salad', 'soup', 'main', 'sandwich', 'sandwiches', 'burger'],
  dinner: ['dinner', 'main', 'mains', 'noodles', 'pasta', 'soup', 'soups', 'bbq', 'bake', 'burger'],
  side: ['side', 'entree', 'starter', 'appetizer', 'snack', 'salad'],
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
export function isCourseCompatible(
  course: string[] | undefined,
  mealType: MealType,
  cuisineStyles: CuisineStyle[],
): boolean {
  if (!course || course.length === 0) return true;

  const lower = course.map((c) => c.toLowerCase());

  if (lower.every((c) => CONDIMENT_COURSES.has(c))) {
    return false;
  }

  const allowed = [...COURSE_ALLOWED[mealType]];
  if (mealType === 'dinner' && cuisineStyles.includes('Salad')) {
    allowed.push('salad');
  }

  return lower.some((c) => allowed.some((a) => c.includes(a)));
}

// ─── Time Constraint ──────────────────────────────────────────

export type TimeCheckResult = 'pass' | 'fail' | 'unparseable';

export function checkTimeConstraint(recipe: Recipe, cuisineStyles: CuisineStyle[]): TimeCheckResult {
  const isQuickEasy = cuisineStyles.includes('Quick & Easy');
  const isModerate = cuisineStyles.includes('Moderate');
  if (!isQuickEasy && !isModerate) return 'pass';

  const prepMins = parseMinutes(recipe.prepTime);
  const cookMins = parseMinutes(recipe.cookTime);
  if (prepMins === null && cookMins === null) return 'unparseable';

  const total = (prepMins ?? 0) + (cookMins ?? 0);
  if (isQuickEasy && total > 30) return 'fail';
  if (isModerate && total > 45) return 'fail';
  return 'pass';
}

// ─── Combined Eligibility ─────────────────────────────────────

export interface EvaluateContext {
  mealType: MealType;
  cuisineStyles: CuisineStyle[];
  settings?: HouseholdSettings;
}

/**
 * Run the shared eligibility checks (course, dietary filters) for a recipe against a
 * scrape request. Returns `{ ok: true }` or `{ ok: false, reason }`.
 *
 * Time constraint and seed checks are intentionally excluded — they have
 * different branching behaviour in the cache vs fresh-scrape paths.
 */
export function evaluateRecipeForRequest(
  recipe: Recipe,
  ctx: EvaluateContext
): { ok: true } | { ok: false; reason: string } {
  if (!isCourseCompatible(recipe.course, ctx.mealType, ctx.cuisineStyles)) {
    return { ok: false, reason: `course [${recipe.course?.join(', ') ?? 'none'}] incompatible with ${ctx.mealType}` };
  }

  // Tag-based course check covers Gemini-assigned courses on cached recipes.
  // Fresh recipes only carry Cuisine tags at this point, so this is a no-op for them.
  const tagCourses = (recipe.tags ?? []).filter((t) => COURSE_TAG_VALUES.has(t as 'Breakfast'));
  if (tagCourses.length > 0 && !isCourseCompatible(tagCourses, ctx.mealType, ctx.cuisineStyles)) {
    return { ok: false, reason: `tag courses [${tagCourses.join(', ')}] incompatible with ${ctx.mealType}` };
  }

  if (ctx.cuisineStyles.includes('Kid Friendly') && !isKidFriendly(recipe, ctx.settings?.kidFriendly)) {
    return { ok: false, reason: `not kid friendly: ${kidFriendlyBlocker(recipe, ctx.settings?.kidFriendly)}` };
  }

  if (ctx.cuisineStyles.includes('Vegetarian') && !isVegetarian(recipe)) {
    return { ok: false, reason: `contains meat: ${vegetarianBlocker(recipe)}` };
  }

  if (ctx.cuisineStyles.includes('Healthy') && !isHealthy(recipe)) {
    return { ok: false, reason: `not healthy: ${healthyBlocker(recipe)}` };
  }

  return { ok: true };
}
