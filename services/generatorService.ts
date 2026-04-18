// ============================================================
// Meal Wizard — Generator Service
// Orchestrates meal plan generation: smart favourites injection,
// recipe scraping per slot, shopping list aggregation, and
// saving confirmed meals to Firestore.
// ============================================================

import {
  scrapeRecipe,
  calculateRequiredServings,
  type ScrapeRequest,
} from './recipeScraperService';
import {
  getStarredRecipes,
  getRecipe,
  addMealPlanEntry,
  addShoppingItems,
  addToCookbook,
} from './firestoreService';
import type {
  HouseholdSettings,
  Recipe,
  MealType,
  CuisineStyle,
  ShoppingItem,
  ShoppingCategory,
} from './types';

// ─── Gemini config (shopping list combining only) ─────────────

const GEMINI_MODEL = 'gemini-3-flash-preview';
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_API_KEY = process.env.EXPO_PUBLIC_GEMINI_API_KEY ?? '';

// ─── Public Types ─────────────────────────────────────────────

export interface GeneratedMeal {
  recipe: Recipe;
  recipeId: string;
  /** ISO date string: "2025-07-14" */
  date: string;
  mealType: MealType;
  isFromFavourites: boolean;
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

// ─── Date Utilities ───────────────────────────────────────────

/**
 * Returns the next Monday strictly after today.
 * If today is already Monday, returns the following Monday.
 */
export function getNextMonday(): Date {
  const today = new Date();
  const day = today.getDay(); // 0 = Sun, 1 = Mon, …, 6 = Sat
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

const LOADING_MESSAGES = [
  'Searching for the perfect recipes…',
  'Scraping and reading recipes…',
  'Adjusting portions for your family…',
  'Building your meal plan…',
];

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

  // ── Smart Favourites ─────────────────────────────────────
  // Maps slot index → recipeId for slots that will use a starred recipe.
  const favouriteSlotMap = new Map<number, string>();
  try {
    const starred = await getStarredRecipes(householdId);
    if (starred.length > 10) {
      const count = 1 + Math.floor(Math.random() * 3); // 1, 2, or 3
      const shuffledStarred = [...starred]
        .sort(() => Math.random() - 0.5)
        .slice(0, Math.min(count, total));
      const shuffledSlotIndices = slots
        .map((_, i) => i)
        .sort(() => Math.random() - 0.5);
      shuffledStarred.forEach((entry, i) => {
        favouriteSlotMap.set(shuffledSlotIndices[i], entry.recipeId);
      });
    }
  } catch {
    // Non-fatal — continue without smart favourites
  }

  // ── Generate each slot ────────────────────────────────────
  const results: GeneratedMeal[] = [];
  const usedRecipeIds: string[] = [];

  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    const current = i + 1;
    const msgIndex = Math.min(Math.floor((i / total) * LOADING_MESSAGES.length), LOADING_MESSAGES.length - 1);
    onProgress(LOADING_MESSAGES[msgIndex], current, total);

    const favouriteRecipeId = favouriteSlotMap.get(i);
    if (favouriteRecipeId && !usedRecipeIds.includes(favouriteRecipeId)) {
      try {
        onProgress('Loading a favourite recipe…', current, total);
        const recipe = await getRecipe(favouriteRecipeId);
        if (recipe) {
          results.push({
            recipe,
            recipeId: favouriteRecipeId,
            date: formatDateISO(slot.date),
            mealType: slot.mealType,
            isFromFavourites: true,
          });
          usedRecipeIds.push(favouriteRecipeId);
          continue;
        }
      } catch {
        // Fall through to scraping
      }
    }

    const request: ScrapeRequest = {
      mealType: slot.mealType,
      cuisineStyles: config.cuisineStyles,
      customInstructions: config.customInstructions,
      requiredServings,
      excludeRecipeIds: [...usedRecipeIds],
      settings: config.settings,
    };

    const scraped = await scrapeRecipe(request);
    usedRecipeIds.push(scraped.recipeId);
    results.push({
      recipe: scraped.recipe,
      recipeId: scraped.recipeId,
      date: formatDateISO(slot.date),
      mealType: slot.mealType,
      isFromFavourites: false,
    });
  }

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

  // Start with IDs of meals we are keeping (not regenerating) as the exclude set,
  // then accumulate newly generated IDs to prevent duplicates within the regen batch.
  const excludeIds: string[] = meals
    .filter((_, i) => !indicesToRegenerate.includes(i))
    .map((m) => m.recipeId);

  for (let i = 0; i < indicesToRegenerate.length; i++) {
    const idx = indicesToRegenerate[i];
    const meal = meals[idx];
    onProgress(`Regenerating recipe ${i + 1} of ${total}…`, i + 1, total);

    const result = await scrapeRecipe({
      mealType: meal.mealType,
      cuisineStyles: config.cuisineStyles,
      customInstructions: config.customInstructions,
      requiredServings,
      excludeRecipeIds: [...excludeIds],
      settings: config.settings,
    });

    excludeIds.push(result.recipeId);
    updated[idx] = {
      recipe: result.recipe,
      recipeId: result.recipeId,
      date: meal.date,
      mealType: meal.mealType,
      isFromFavourites: false,
    };
  }

  return updated;
}

/**
 * Confirm a reviewed meal plan: save every meal to mealPlan + cookbook,
 * then aggregate all ingredients into the household shopping list.
 */
export async function confirmMealPlan(
  meals: GeneratedMeal[],
  householdId: string
): Promise<void> {
  for (const meal of meals) {
    await addMealPlanEntry(householdId, {
      recipeId: meal.recipeId,
      date: meal.date,
      mealType: meal.mealType,
    });
    await addToCookbook(householdId, meal.recipeId);
  }

  const rawItems = aggregateIngredients(meals);
  if (rawItems.length === 0) return;

  console.log('\n[ShoppingList] ── Raw aggregated ingredients ─────────────────────');
  rawItems.forEach((i) =>
    console.log(`  [${i.category.padEnd(20)}]  ${String(i.quantity).padStart(6)} ${i.unit.padEnd(5)}  ${i.name}`)
  );
  console.log(`[ShoppingList] Total: ${rawItems.length} items\n`);

  // Use Gemini to intelligently merge semantically equivalent ingredients
  // (e.g. "chopped onion" + "onion" → "onion") and round up produce counts.
  let items = rawItems;
  try {
    items = await combineIngredientsWithGemini(rawItems);

    console.log('\n[ShoppingList] ── After Gemini consolidation ────────────────────');
    items.forEach((i) =>
      console.log(`  [${i.category.padEnd(20)}]  ${String(i.quantity).padStart(6)} ${i.unit.padEnd(5)}  ${i.name}`)
    );
    console.log(`[ShoppingList] Total: ${items.length} items (was ${rawItems.length})\n`);

    // Quantity sanity check — flag items where Gemini changed the amount
    // beyond what simple rounding or unit conversion can explain.
    const rawByName = new Map(rawItems.map((r) => [r.name.toLowerCase(), r]));
    items.forEach((gi) => {
      const orig = rawByName.get(gi.name.toLowerCase());
      if (!orig || orig.unit !== gi.unit) return; // skip name-changed or unit-changed items
      const ratio = gi.quantity / (orig.quantity || 1);
      if (ratio < 0.5 || ratio > 2) {
        console.warn(
          `[ShoppingList] ⚠️  Quantity change flagged: "${gi.name}" ` +
          `${orig.quantity} ${orig.unit} → ${gi.quantity} ${gi.unit} (×${ratio.toFixed(2)})`
        );
      }
    });
  } catch (err) {
    console.warn('[Generator] Gemini ingredient combining failed — using raw aggregation:', err);
  }

  await addShoppingItems(householdId, items);
}

// ─── Ingredient Aggregation ───────────────────────────────────

// Volume conversion factors → ml
const VOLUME_TO_ML: Record<string, number> = {
  tsp: 4.92892,
  tbsp: 14.7868,
  cup: 236.588,
  ml: 1,
  l: 1000,
};
// Weight conversion factors → g
const WEIGHT_TO_G: Record<string, number> = {
  g: 1,
  kg: 1000,
  oz: 28.3495,
  lb: 453.592,
};

function getUnitFamily(unit: string): 'volume' | 'weight' | 'other' {
  if (unit in VOLUME_TO_ML) return 'volume';
  if (unit in WEIGHT_TO_G) return 'weight';
  return 'other';
}

function toBase(quantity: number, unit: string): number {
  return (VOLUME_TO_ML[unit] ?? WEIGHT_TO_G[unit] ?? 1) * quantity;
}

/** Convert a base-unit amount back to the most readable volume unit. */
function fromBaseVolume(ml: number): { quantity: number; unit: string } {
  if (ml < VOLUME_TO_ML.tsp * 0.75) return { quantity: ml / VOLUME_TO_ML.tsp, unit: 'tsp' };
  if (ml < VOLUME_TO_ML.tbsp * 3)   return { quantity: ml / VOLUME_TO_ML.tsp, unit: 'tsp' };
  if (ml < VOLUME_TO_ML.cup)        return { quantity: ml / VOLUME_TO_ML.tbsp, unit: 'tbsp' };
  return { quantity: ml / VOLUME_TO_ML.cup, unit: 'cup' };
}

/** Convert a base-unit amount back to the most readable weight unit. */
function fromBaseWeight(g: number): { quantity: number; unit: string } {
  if (g >= 1000) return { quantity: g / 1000, unit: 'kg' };
  return { quantity: g, unit: 'g' };
}

/** Internal map value for aggregation */
interface AggEntry {
  baseQty: number;
  family: 'volume' | 'weight' | 'other';
  displayUnit: string;
  name: string;
  category: ShoppingCategory;
  sources: { id: string; title: string }[];
}

/**
 * Merge all ingredients across meals into a deduplicated shopping list.
 * Items with the same normalized name and unit family are combined —
 * quantities are summed in a common base unit (ml / g) then converted back
 * to the most practical display unit. This handles e.g. "0.75 tsp lemon juice"
 * + "1 tbsp lemon juice" → a single merged item.
 */
function aggregateIngredients(
  meals: GeneratedMeal[]
): Omit<ShoppingItem, 'id'>[] {
  const merged = new Map<string, AggEntry>();

  for (const meal of meals) {
    const source = { id: meal.recipeId, title: meal.recipe.title };
    for (const ing of meal.recipe.ingredients) {
      const normName = normalizeIngredientName(ing.name);
      const normUnit = normalizeUnit(ing.unit);
      const family = getUnitFamily(normUnit);
      // Key by name + unit family so tsp and tbsp merge together
      const key = `${normName}|${family === 'other' ? normUnit : family}`;

      const existing = merged.get(key);
      if (existing) {
        existing.baseQty += toBase(ing.quantity, normUnit);
        if (!existing.sources.some((s) => s.id === source.id)) {
          existing.sources.push(source);
        }
      } else {
        merged.set(key, {
          baseQty: toBase(ing.quantity, normUnit),
          family,
          displayUnit: normUnit || ing.unit.trim(),
          name: normName || ing.name.trim(),
          // Pass the original name so qualifiers like "dried" are visible
          category: categoriseIngredient(ing.name),
          sources: [source],
        });
      }
    }
  }

  return Array.from(merged.values()).map(({ baseQty, family, displayUnit, name, category, sources }) => {
    let finalQty: number;
    let finalUnit: string;

    if (family === 'volume') {
      const r = fromBaseVolume(baseQty);
      finalQty = r.quantity;
      finalUnit = r.unit;
    } else if (family === 'weight') {
      const r = fromBaseWeight(baseQty);
      finalQty = r.quantity;
      finalUnit = r.unit;
    } else {
      finalQty = baseQty;
      finalUnit = displayUnit;
    }

    return {
      name,
      quantity: Math.round(finalQty * 100) / 100,
      unit: finalUnit,
      category,
      checked: false,
      manual: false,
      sources,
    };
  });
}

/**
 * Send the aggregated shopping list to Gemini for smart combining.
 *
 * Gemini handles cases our normalization misses:
 *  - "chopped onion" + "onion" → "onion"
 *  - "pepper" + "black pepper" → "pepper"
 *  - 1 tsp pepper + 1g pepper → single entry
 *  - 1.2 carrots → 2 carrots (whole produce rounded up)
 *
 * Sources are stripped before sending (they inflate the payload past the token
 * limit) and re-attached afterward via name matching.
 *
 * Falls back to the raw aggregated list if the API call fails.
 */
async function combineIngredientsWithGemini(
  items: Omit<ShoppingItem, 'id'>[]
): Promise<Omit<ShoppingItem, 'id'>[]> {
  if (!GEMINI_API_KEY) return items;

  // Strip sources before sending — they inflate the payload and can push the
  // response past maxOutputTokens, truncating the JSON.
  const prompt = `You are given a shopping list as JSON. Your job is to clean it up:

1. Combine items that refer to the same ingredient even if worded differently.
   Examples: "chopped onion" + "onion" → "onion"; "black pepper" + "pepper" → "pepper"; "spring onion" and "scallion" → "spring onion".
2. When combining items with different units, convert to the most practical unit and sum the quantities (e.g. 1 tsp + 1 g pepper → keep tsp or g, whichever is more useful).
3. For whole produce items (fruits and vegetables sold individually — e.g. carrots, lemons, onions, potatoes, apples), round the final quantity UP to the nearest whole number (e.g. 1.2 carrots → 2, 0.5 lemon → 1).
4. Keep quantities for weight/volume units (g, kg, ml, l, cup, tbsp, tsp, oz) as-is — do NOT round those.
5. Review and correct the "category" field if it is wrong.
   Valid values: "Produce", "Meat & Seafood", "Dairy & Eggs", "Herbs & Spices", "Oils, Sauces & Condiments", "Pantry & Dry Goods", "Frozen", "Bread & Bakery", "Other".
   Rules:
   - Fresh or dried herbs (basil, parsley, thyme, rosemary…) and any spice or spice blend (cumin, paprika, garam masala, curry powder…) → "Herbs & Spices"
   - Any cooking oil, vinegar, liquid sauce, or table condiment (soy sauce, fish sauce, oyster sauce, Worcestershire, sriracha, ketchup, mayo, mustard, miso, tahini, hoisin) → "Oils, Sauces & Condiments"
   - Stocks, broths, canned/tinned goods, pasta, rice, flour, sugar, honey, baking ingredients → "Pantry & Dry Goods"
   - Fresh fruit and vegetables → "Produce"
   - Raw meat, fish, seafood → "Meat & Seafood"
   - Dairy products and eggs → "Dairy & Eggs"
   - Bread, wraps, rolls, tortillas → "Bread & Bakery"

Return ONLY a valid JSON array — no markdown, no explanation:
[{"name": "...", "quantity": 0, "unit": "...", "category": "..."}, ...]

Input:
${JSON.stringify(items.map(({ name, quantity, unit, category }) => ({ name, quantity, unit, category })))}`;

  const url = `${GEMINI_API_BASE}/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 16384,
        // Force plain JSON output — no markdown fences, no explanatory text.
        responseMimeType: 'application/json',
        // Disable thinking tokens so they don't eat into the output budget.
        thinkingConfig: { thinkingBudget: 0 },
      },
    }),
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw new Error(`Gemini API error ${response.status}: ${errBody.slice(0, 200)}`);
  }

  const data = await response.json();
  const finishReason: string | undefined = data?.candidates?.[0]?.finishReason;
  const text: string | undefined = data?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (finishReason === 'MAX_TOKENS') {
    throw new Error('Gemini response truncated (MAX_TOKENS) — shopping list may be too large');
  }
  if (!text) throw new Error('Gemini returned no text');

  // With responseMimeType: application/json the model returns raw JSON,
  // but strip fences as a safety net in case an older model ignores the flag.
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  const jsonStr = fenceMatch ? fenceMatch[1] : text.trim();
  const parsed: unknown = JSON.parse(jsonStr);

  if (!Array.isArray(parsed)) throw new Error('Gemini response is not an array');

  // Re-attach sources: for each combined item, union sources from any original
  // item whose name overlaps with the Gemini output name.
  return (parsed as Record<string, unknown>[]).map((item) => {
    const combinedName = String(item.name ?? '').trim().toLowerCase();
    const matchedSources: { id: string; title: string }[] = [];
    const seenIds = new Set<string>();

    for (const orig of items) {
      const origName = orig.name.toLowerCase();
      // Match if either name contains the other (handles "onion" ↔ "chopped onion")
      if (combinedName === origName || combinedName.includes(origName) || origName.includes(combinedName)) {
        for (const s of orig.sources ?? []) {
          if (!seenIds.has(s.id)) {
            seenIds.add(s.id);
            matchedSources.push(s);
          }
        }
      }
    }

    return {
      name: String(item.name ?? '').trim(),
      quantity: Number(item.quantity) || 0,
      unit: String(item.unit ?? '').trim(),
      category: (item.category as ShoppingCategory) ?? 'Pantry & Dry Goods',
      checked: false,
      manual: false,
      sources: matchedSources.length > 0 ? matchedSources : undefined,
    };
  });
}

/**
 * Normalise an ingredient name for deduplication.
 *
 * Examples:
 *   "garlic, minced"               → "garlic"
 *   "garlic cloves"                → "garlic"
 *   "garlic finely chopped or minced" → "garlic"
 *   "spring onion, thinly sliced"  → "spring onion"
 */
function normalizeIngredientName(name: string): string {
  let n = name.toLowerCase().trim();

  // Drop post-comma prep instructions: "garlic, minced" → "garlic"
  n = n.replace(/,.*$/, '').trim();

  // Drop "or X" alternatives at end: "chopped or minced" → handled by verb strip below
  n = n.replace(/\s+or\s+\S+\s*$/, '').trim();

  // Strip parenthetical content
  n = n.replace(/\(.*?\)/g, '').trim();

  // Strip measurement-unit words that bleed into names: "garlic cloves" → "garlic"
  n = n.replace(/\b(cloves?|heads?|stalks?|sprigs?)\b/g, '');

  // Strip descriptive adverbs
  n = n.replace(
    /\b(finely|roughly|coarsely|thinly|freshly|lightly|well|extra|very)\b/g,
    ''
  );

  // Strip prep verbs and state/size descriptors
  n = n.replace(
    /\b(chopped|minced|diced|sliced|crushed|grated|peeled|trimmed|halved|quartered|shredded|torn|whole|fresh|dried|ground|powdered|frozen|toasted|roasted|cooked|raw|large|small|medium|big)\b/g,
    ''
  );

  return n.replace(/\s{2,}/g, ' ').trim();
}

/**
 * Normalise unit strings for deduplication.
 * Collapses common plural/abbreviation variants to a canonical singular form.
 */
function normalizeUnit(unit: string): string {
  const u = unit.toLowerCase().trim();
  const MAP: Record<string, string> = {
    cloves: 'clove',
    cups: 'cup',
    tablespoons: 'tbsp',
    tablespoon: 'tbsp',
    teaspoons: 'tsp',
    teaspoon: 'tsp',
    grams: 'g',
    gram: 'g',
    kilograms: 'kg',
    kilogram: 'kg',
    millilitres: 'ml',
    milliliters: 'ml',
    millilitre: 'ml',
    milliliter: 'ml',
    litres: 'l',
    liters: 'l',
    litre: 'l',
    liter: 'l',
    ounces: 'oz',
    ounce: 'oz',
    pounds: 'lb',
    pound: 'lb',
    slices: 'slice',
    pieces: 'piece',
    stalks: 'stalk',
    sprigs: 'sprig',
    cans: 'can',
    jars: 'jar',
    bags: 'bag',
  };
  return MAP[u] ?? u;
}

function categoriseIngredient(name: string): ShoppingCategory {
  const n = name.toLowerCase();

  // ── 1. Herbs & Spices ────────────────────────────────────────
  // Rule: pure spices (always dried) → always Herbs & Spices.
  //       herbs → Herbs & Spices only when explicitly dried/ground/powdered;
  //               fresh herbs (no qualifier) fall through to Produce below.
  const isDried = /\b(dried|ground|powdered|dehydrated)\b/.test(n);
  const isHerb  = /\b(basil|parsley|coriander|cilantro|mint|thyme|rosemary|dill|oregano|sage|tarragon|chive|bay\s+lea|lemongrass|kaffir|galangal|chervil|marjoram|lovage|sorrel)\b/.test(n);

  // Dried/ground herb → Herbs & Spices
  if (isHerb && isDried) return 'Herbs & Spices';

  // Pure spices (these are always dried; no fresh qualifier needed)
  if (
    /\b(cumin|paprika|turmeric|cinnamon|cardamom|nutmeg|clove|allspice|star\s+anise|fennel\s+seed|caraway|coriander\s+seed|mustard\s+seed|fenugreek|sumac|za.atar|ras\s+el\s+hanout|garam\s+masala|curry\s+powder|five\s+spice|chinese\s+five|cajun|chili\s+powder|cayenne|smoked\s+paprika|sweet\s+paprika|onion\s+powder|garlic\s+powder|celery\s+salt|mixed\s+spice|mixed\s+herb|italian\s+season|herbes?\s+de\s+provence|baharat|dukkah|harissa\s+spice)\b/.test(n) ||
    /\bspice\b/.test(n)
  )
    return 'Herbs & Spices';

  // ── 2. Oils, Sauces & Condiments ────────────────────────────
  // Must run before Pantry so oils and sauces aren't lost to the generic catch-all.
  if (
    /\b(olive\s+oil|vegetable\s+oil|canola\s+oil|sunflower\s+oil|coconut\s+oil|sesame\s+oil|avocado\s+oil|peanut\s+oil|grapeseed\s+oil|neutral\s+oil|cooking\s+oil)\b/.test(n) ||
    /\b(?<!coconut\s)oil\b/.test(n) ||   // generic "oil" but not "coconut oil" (already above)
    /\b(vinegar|balsamic|rice\s+wine\s+vinegar|apple\s+cider\s+vinegar|white\s+wine\s+vinegar|red\s+wine\s+vinegar|sherry\s+vinegar)\b/.test(n) ||
    /\b(soy\s+sauce|fish\s+sauce|oyster\s+sauce|hoisin|teriyaki|worcestershire|sriracha|hot\s+sauce|tabasco|ketchup|mayo|mayonnaise|mustard|dijon|relish|chutney|miso|tahini|nam\s+pla|ponzu|tamari|liquid\s+aminos)\b/.test(n)
  )
    return 'Oils, Sauces & Condiments';

  // ── 3. Pantry exclusions ─────────────────────────────────────
  // Words that would match meat/dairy/produce patterns but are shelf-stable.
  // Also catches remaining pantry staples not covered above.
  if (
    /\b(stock|broth|bouillon|jus)\b/.test(n) ||
    /\b(coconut\s+milk|coconut\s+cream|coconut\s+water)\b/.test(n) ||
    /\boat\s+milk\b|\balmond\s+milk\b|\brice\s+milk\b|\bsoy\s+milk\b/.test(n) ||
    /\b(tomato\s+paste|tomato\s+puree|tomato\s+sauce|tomato\s+can|canned\s+tomato|crushed\s+tomato|diced\s+tomato|sun.dried\s+tomato)\b/.test(n) ||
    /\b(pasta|noodle|rice|flour|sugar|salt|honey|maple|syrup|jam|paste|powder|seasoning|extract|baking|yeast|stock\s+cube|bouillon\s+cube|tinned|canned)\b/.test(n)
  )
    return 'Pantry & Dry Goods';

  // ── 4. Meat & Seafood ────────────────────────────────────────
  if (
    /\b(chicken|beef|pork|lamb|fish|salmon|tuna|cod|trout|shrimp|prawn|turkey|bacon|sausage|mince|steak|fillet|duck|veal|crab|anchov|seafood|pancetta|chorizo|salami|ham|venison|brisket|ribs)\b/.test(n)
  )
    return 'Meat & Seafood';

  // ── 5. Dairy & Eggs ──────────────────────────────────────────
  if (
    /\b(milk|cream|butter|cheese|yogurt|yoghurt|egg|eggs|parmesan|mozzarella|cheddar|feta|ricotta|brie|haloumi|sour\s+cream|creme\s+fraiche|ghee|quark|gouda|gruyere|pecorino|cream\s+cheese|cottage\s+cheese)\b/.test(n)
  )
    return 'Dairy & Eggs';

  // ── 6. Bread & Bakery ────────────────────────────────────────
  if (
    /\b(bread|bun|wrap|pita|pitta|roll|loaf|tortilla|naan|bagel|croissant|brioche|sourdough|crumpet|muffin|flatbread)\b/.test(n)
  )
    return 'Bread & Bakery';

  // ── 7. Frozen ────────────────────────────────────────────────
  if (/\bfrozen\b/.test(n)) return 'Frozen';

  // ── 8. Produce ───────────────────────────────────────────────
  // Fresh herbs (no "dried" qualifier) are included here alongside veg and fruit.
  // Dried herbs were already caught by block 1.
  if (
    isHerb ||   // fresh herb names without a dried qualifier
    /\b(onion|garlic|tomato|potato|carrot|cucumber|lettuce|spinach|mushroom|pepper|capsicum|broccoli|celery|ginger|lemon|lime|orange|apple|banana|avocado|chilli|chili|spring\s+onion|zucchini|courgette|eggplant|aubergine|cabbage|kale|asparagus|leek|fennel|beetroot|radish|pumpkin|sweet\s+potato|corn|pea|bean|green\s+bean|snow\s+pea|bok\s+choy|pak\s+choi|shallot|scallion|rocket|arugula|silverbeet|broccolini|chard|watercress|endive|witlof|sprout|mango|pineapple|strawberr|blueberr|raspberr|grape|peach|plum|pear|kiwi|melon|pomegranate|fig|date|cherry|passionfruit|mandarin|grapefruit|zest|rind)\b/.test(n)
  )
    return 'Produce';

  return 'Pantry & Dry Goods';
}
