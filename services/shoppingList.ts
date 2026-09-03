// ============================================================
// Shopping list aggregation — merges ingredients across recipes,
// categorises them, and optionally uses Gemini for semantic grouping.
// ============================================================

import { aiClient, canonicalizeHouseholdId, type ShoppingIngredientAiInput } from './aiClient';
import type { Ingredient, Recipe, ShoppingCategory, ShoppingItem } from './types';

// ─── Public Types ─────────────────────────────────────────────

/** Input row for the aggregator — decoupled from GeneratedMeal to avoid circular imports. */
export interface MealForShopping {
  recipeId: string;
  recipe: Recipe;
  servings: number;
}

// ─── Unit Conversion Primitives ───────────────────────────────

// Volume conversion factors → ml
const VOLUME_TO_ML: Record<string, number> = {
  tsp: 4.92892,
  tbsp: 14.7868,
  cup: 236.588,
  ml: 1,
  l: 1000,
  pinch: 0.3083,
  dash: 0.6166,
  smidgen: 0.1542,
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

/**
 * Convert a base ml amount to a display quantity+unit, applying the category-aware
 * formatting rules shared by both aggregators:
 *   - Herbs & Spices → tsp/tbsp
 *   - Liquid preferred (oils/sauces, or originally expressed in ml/l) → ml or l
 *   - Everything else → tsp/tbsp/cup (cup-scale)
 */
function formatVolumeOutput(
  baseMl: number,
  category: ShoppingCategory,
  liquidPreferred: boolean
): { quantity: number; unit: string } {
  if (category === 'Herbs & Spices') return fromBaseVolume(baseMl);
  if (liquidPreferred) {
    return baseMl >= 1000
      ? { quantity: Math.round(baseMl / 10) / 100, unit: 'l' }
      : { quantity: Math.round(baseMl), unit: 'ml' };
  }
  return fromBaseVolume(baseMl);
}

function fromBaseVolume(ml: number): { quantity: number; unit: string } {
  if (ml < VOLUME_TO_ML.tsp * 0.75) return { quantity: ml / VOLUME_TO_ML.tsp, unit: 'tsp' };
  if (ml < VOLUME_TO_ML.tbsp * 3) return { quantity: ml / VOLUME_TO_ML.tsp, unit: 'tsp' };
  if (ml < VOLUME_TO_ML.cup) return { quantity: ml / VOLUME_TO_ML.tbsp, unit: 'tbsp' };
  return { quantity: ml / VOLUME_TO_ML.cup, unit: 'cup' };
}

function fromBaseWeight(g: number): { quantity: number; unit: string } {
  if (g >= 1000) return { quantity: g / 1000, unit: 'kg' };
  return { quantity: g, unit: 'g' };
}

// ─── Density / Standard-Weight Tables ─────────────────────────

const DRY_GOODS_G_PER_CUP: Record<string, number> = {
  rice: 200, flour: 120, oats: 90, breadcrumbs: 115, sugar: 200,
  pasta: 85, lentils: 190, chickpeas: 200, cornstarch: 120,
  cocoa: 100, 'cocoa powder': 100, 'icing sugar': 120, 'brown sugar': 200,
  'almond meal': 100, 'almond flour': 100, 'desiccated coconut': 90,
  quinoa: 170, couscous: 170, polenta: 160, 'rolled oats': 90,
};

function lookupDryDensity(name: string): number | null {
  const n = name.toLowerCase().trim();
  for (const [key, gPerCup] of Object.entries(DRY_GOODS_G_PER_CUP)) {
    if (n.includes(key) || key.includes(n)) return gPerCup / VOLUME_TO_ML.cup;
  }
  return null;
}

const STANDARD_WEIGHTS_G: Record<string, number> = {
  'chicken thigh': 150, 'chicken thighs': 150,
  'chicken breast': 200, 'chicken breasts': 200,
  'chicken drumstick': 100, 'chicken drumsticks': 100,
  'chicken wing': 90, 'chicken wings': 90,
  'chicken leg': 250, 'chicken legs': 250,
  'chicken maryland': 300, 'chicken marylands': 300,
  'chicken': 150,
  'duck breast': 200, 'duck leg': 300,
  'turkey breast': 500,
  'egg': 55, 'eggs': 55,
  'onion': 150, 'onions': 150,
  'shallot': 30, 'shallots': 30,
  'spring onion': 15, 'spring onions': 15,
  'green onion': 15, 'green onions': 15,
  'scallion': 15, 'scallions': 15,
  'garlic clove': 5, 'garlic cloves': 5, 'garlic': 5,
  'leek': 150, 'leeks': 150,
  'potato': 150, 'potatoes': 150,
  'sweet potato': 200, 'sweet potatoes': 200,
  'carrot': 80, 'carrots': 80,
  'beetroot': 150, 'parsnip': 100, 'parsnips': 100,
  'turnip': 120, 'radish': 15, 'radishes': 15,
  'broccoli': 300,
  'broccoli floret': 20, 'broccoli florets': 20,
  'cauliflower': 600, 'cabbage': 500,
  'tomato': 120, 'tomatoes': 120,
  'cherry tomato': 15, 'cherry tomatoes': 15,
  'capsicum': 150, 'bell pepper': 150, 'bell peppers': 150,
  'zucchini': 200, 'courgette': 200,
  'eggplant': 350, 'aubergine': 350,
  'cucumber': 300,
  'corn cob': 250, 'corn': 250,
  'celery stalk': 50, 'celery stalks': 50, 'celery': 50,
  'fennel': 250, 'avocado': 200,
  'jalapeño': 15, 'jalapeno': 15, 'chilli': 15, 'chili': 15,
  'asparagus spear': 20, 'asparagus spears': 20, 'asparagus': 20,
  'mushroom': 35, 'mushrooms': 35,
  'lemon': 85, 'lemons': 85,
  'lime': 65, 'limes': 65,
  'orange': 180, 'oranges': 180,
  'apple': 180, 'apples': 180,
  'banana': 120, 'bananas': 120,
  'pear': 170, 'pears': 170,
  'mango': 300, 'mangoes': 300,
  'kiwi': 75, 'kiwis': 75, 'kiwifruit': 75,
  'peach': 150, 'peaches': 150,
  'plum': 80, 'plums': 80,
  'fig': 50, 'figs': 50,
  'date': 24, 'dates': 24,
  'strawberry': 18, 'strawberries': 18,
  'passionfruit': 55,
  'sausage': 80, 'sausages': 80,
  'bacon rasher': 25, 'bacon rashers': 25,
  'bread slice': 30, 'bread slices': 30,
  'tortilla': 45, 'tortillas': 45,
  'pita': 60, 'pita bread': 60,
  'naan': 90,
  'bread roll': 60, 'bread rolls': 60,
};

const SIZE_WORDS = /^(extra\s+|very\s+)?(large|small|medium|big)\s+/;

function lookupWeight(name: string): number | null {
  const n = name.toLowerCase().trim();
  if (STANDARD_WEIGHTS_G[n] !== undefined) return STANDARD_WEIGHTS_G[n];
  const stripped = n.replace(SIZE_WORDS, '');
  if (stripped !== n && STANDARD_WEIGHTS_G[stripped] !== undefined) return STANDARD_WEIGHTS_G[stripped];
  const words = stripped.split(' ');
  for (let len = words.length - 1; len >= 1; len--) {
    const partial = words.slice(0, len).join(' ');
    if (STANDARD_WEIGHTS_G[partial] !== undefined) return STANDARD_WEIGHTS_G[partial];
  }
  return null;
}

// Approximate volume for count-style units, used when a group's target family
// is volume but it has count members (e.g. "1 bunch basil" + "2 tbsp basil").
const COUNT_UNIT_ML: Record<string, number> = {
  bunch: 120,
  sprig: 5,
  leaf: 1,
  slice: 15,
  clove: 5,
  head: 200,
  stalk: 30,
};

// ─── Raw / Group Internal Types ───────────────────────────────

export interface RawIngredient {
  id: number;
  name: string;
  quantity: number;
  unit: string;
  source: { id: string; title: string; servings: number };
}

export interface GeminiGroup {
  canonicalName: string;
  category: ShoppingCategory;
  sourceIds: number[];
  /** Natural unit word for count items, e.g. "thighs", "eggs". Empty string if none. */
  unit?: string;
}

function ingredientSignature(ingredient: Ingredient): string {
  return JSON.stringify([
    ingredient.name.trim().toLowerCase(),
    Number.isFinite(ingredient.quantity) ? ingredient.quantity : 0,
    ingredient.unit.trim().toLowerCase(),
    ingredient.notes?.trim().toLowerCase() ?? '',
  ]);
}

/**
 * Return the complete flat ingredient list for shopping. Root ingredients are
 * authoritative, but some historical documents stored extra rows only inside
 * ingredientGroups. Treat the grouped rows as a multiset and append only the
 * occurrences not already represented at the root.
 */
export function completeRecipeIngredients(recipe: Recipe): Ingredient[] {
  const root = [...recipe.ingredients];
  const grouped = recipe.ingredientGroups?.flatMap((group) => group.ingredients) ?? [];
  if (grouped.length === 0) return root;

  const unmatchedRoot = new Map<string, number>();
  for (const ingredient of root) {
    const key = ingredientSignature(ingredient);
    unmatchedRoot.set(key, (unmatchedRoot.get(key) ?? 0) + 1);
  }

  const groupedOnly: Ingredient[] = [];
  for (const ingredient of grouped) {
    const key = ingredientSignature(ingredient);
    const remaining = unmatchedRoot.get(key) ?? 0;
    if (remaining > 0) {
      unmatchedRoot.set(key, remaining - 1);
    } else {
      groupedOnly.push(ingredient);
    }
  }
  return [...root, ...groupedOnly];
}

/**
 * Build an owned shopping snapshot. Schema-v2 recipes are stored at their
 * original serving size, while the legacy generator already returns scaled
 * recipes. Scaling here therefore restores catalogue parity without changing
 * units or mutating the recipe used by the UI/meal plan.
 */
export function prepareMealsForShopping(meals: MealForShopping[]): MealForShopping[] {
  return meals.map((meal) => {
    const originalServings = meal.recipe.originalServings;
    const factor = meal.recipe.schemaVersion === 2
      && Number.isFinite(originalServings)
      && originalServings > 0
      && Number.isFinite(meal.servings)
      && meal.servings > 0
      ? meal.servings / originalServings
      : 1;
    const ingredients = completeRecipeIngredients(meal.recipe).map((ingredient) => ({
      ...ingredient,
      quantity: Math.round(
        Math.max(0, Number.isFinite(ingredient.quantity) ? ingredient.quantity : 0)
          * factor
          * 100,
      ) / 100,
    }));
    return {
      ...meal,
      recipe: { ...meal.recipe, ingredients },
    };
  });
}

// ─── Programmatic Aggregator (fallback) ───────────────────────

/**
 * Merge all ingredients across meals into a deduplicated shopping list.
 * Items with the same normalized name are grouped (regardless of unit), then
 * folded into a single ShoppingItem via the same target-family logic used by
 * the Gemini-guided path.
 */
export function aggregateIngredients(
  meals: MealForShopping[]
): Omit<ShoppingItem, 'id'>[] {
  interface FallbackGroup {
    canonicalName: string;
    category: ShoppingCategory;
    members: { quantity: number; unit: string }[];
    sources: { id: string; title: string; servings?: number }[];
  }
  const grouped = new Map<string, FallbackGroup>();

  for (const meal of meals) {
    const source = { id: meal.recipeId, title: meal.recipe.title, servings: meal.servings };
    for (const ing of meal.recipe.ingredients) {
      const normName = normalizeIngredientName(ing.name) || ing.name.trim();
      const existing = grouped.get(normName);
      if (existing) {
        existing.members.push({ quantity: ing.quantity, unit: ing.unit });
        if (!existing.sources.some((s) => s.id === source.id)) {
          existing.sources.push(source);
        }
      } else {
        grouped.set(normName, {
          canonicalName: normName,
          category: categoriseIngredient(ing.name),
          members: [{ quantity: ing.quantity, unit: ing.unit }],
          sources: [source],
        });
      }
    }
  }

  const result: Omit<ShoppingItem, 'id'>[] = [];
  for (const g of grouped.values()) {
    result.push(...collapseGroupToItems(
      g.canonicalName,
      g.category,
      undefined,
      g.members,
      g.sources,
    ));
  }
  return result;
}

/**
 * Best-effort singular/plural selection for a count-style unit derived from
 * an item name (e.g. "carrot" + qty 1 → "carrot"; qty 3 → "carrots").
 * Handles the common English cases only — ambiguous inputs round-trip unchanged.
 */
function pluralizeUnit(name: string, quantity: number): string {
  const n = name.trim();
  if (!n) return '';
  const singular = quantity <= 1;

  const lower = n.toLowerCase();
  const endsWithS = /s$/.test(lower);

  if (singular) {
    // Naive de-pluralise for simple cases.
    if (/(ies)$/.test(lower)) return n.slice(0, -3) + 'y';
    if (/(ses|xes|zes|ches|shes)$/.test(lower)) return n.slice(0, -2);
    if (endsWithS && !/ss$/.test(lower)) return n.slice(0, -1);
    return n;
  }

  if (endsWithS) return n;
  if (/(s|x|z|ch|sh)$/.test(lower)) return n + 'es';
  if (/[^aeiou]y$/.test(lower)) return n.slice(0, -1) + 'ies';
  return n + 's';
}

// ─── Single-Entry Collapse ────────────────────────────────────

interface CollapseMember {
  quantity: number;
  unit: string;
}

/**
 * Collapse a group's members into a primary ShoppingItem plus lossless
 * residual rows when unit families cannot be converted safely.
 * Members may span weight / volume / count families; this picks one target
 * family then folds the others in via density / standard-weight / count-volume
 * bridges. Qualitative ingredients are retained as unsized rows instead of
 * disappearing, and unconvertible positive amounts keep their original unit.
 */
function collapseGroupToItems(
  canonicalName: string,
  category: ShoppingCategory,
  groupUnit: string | undefined,
  members: CollapseMember[],
  sources: { id: string; title: string; servings?: number }[]
): Omit<ShoppingItem, 'id'>[] {
  // Ignore zero-quantity members for family voting — they contribute nothing
  // to the total and can mislead the target selector (e.g. "more coconut milk"
  // parsed as qty 0 count should not override a real 1.25 cup volume member).
  const votingMembers = members.filter((m) => m.quantity > 0);
  const families = votingMembers.map((m) => getUnitFamily(normalizeUnit(m.unit)));
  const hasWeightMember = families.some((f) => f === 'weight');
  const hasVolumeMember = families.some((f) => f === 'volume');
  const hasCountMember = families.some((f) => f === 'other');
  const hasMetricVolume = votingMembers.some((m) => {
    const n = normalizeUnit(m.unit);
    return n === 'ml' || n === 'l';
  });
  const stdWeight = lookupWeight(canonicalName);
  const dryDensity = lookupDryDensity(canonicalName);

  // Preserve the supermarket-style count unit (Gemini's plural noun, falling
  // back to the first count member's original unit string).
  let countUnit = groupUnit?.trim() ?? '';
  if (!countUnit) {
    const firstCount = members.find((m) => getUnitFamily(normalizeUnit(m.unit)) === 'other');
    if (firstCount) countUnit = firstCount.unit.trim().toLowerCase();
  }

  // Pick the single target family. The category-based volume rule only fires
  // when there's actually a volume member to anchor on — otherwise lone count
  // items like "0.5 leaves bay leaf" stay as count.
  let target: 'weight' | 'volume' | 'count';
  if (hasWeightMember) {
    target = 'weight';
  } else if (stdWeight !== null && hasCountMember) {
    target = 'count';
  } else if (hasMetricVolume) {
    target = 'volume';
  } else if (
    hasVolumeMember &&
    (category === 'Herbs & Spices' || category === 'Oils, Sauces & Condiments')
  ) {
    target = 'volume';
  } else if (hasCountMember) {
    target = 'count';
  } else if (hasVolumeMember) {
    target = 'volume';
  } else {
    target = 'count';
  }

  let baseG = 0;
  let baseMl = 0;
  let baseCount = 0;
  const residuals = new Map<string, { quantity: number; unit: string }>();
  const retainResidual = (member: CollapseMember) => {
    if (!(member.quantity > 0)) return;
    const unit = normalizeUnit(member.unit);
    const key = unit || '__count__';
    const existing = residuals.get(key);
    if (existing) existing.quantity += member.quantity;
    else residuals.set(key, { quantity: member.quantity, unit });
  };

  for (const m of members) {
    const normUnit = normalizeUnit(m.unit);
    const family = getUnitFamily(normUnit);
    const baseInOwnFamily =
      family === 'weight' || family === 'volume' ? toBase(m.quantity, normUnit) : m.quantity;

    if (target === 'weight') {
      if (family === 'weight') {
        baseG += baseInOwnFamily;
      } else if (family === 'volume') {
        baseG += baseInOwnFamily * (dryDensity ?? 1);
      } else if (stdWeight !== null) {
        baseG += m.quantity * stdWeight;
      } else {
        retainResidual(m);
      }
    } else if (target === 'volume') {
      if (family === 'volume') {
        baseMl += baseInOwnFamily;
      } else if (family === 'weight') {
        baseMl += baseInOwnFamily / (dryDensity ?? 1);
      } else {
        const ml = COUNT_UNIT_ML[normUnit];
        if (ml !== undefined) {
          baseMl += m.quantity * ml;
        } else if (stdWeight !== null) {
          baseMl += m.quantity * stdWeight; // 1 g ≈ 1 ml fallback
        } else {
          retainResidual(m);
        }
      }
    } else {
      // target === 'count'
      if (family === 'other') {
        baseCount += m.quantity;
      } else if (stdWeight !== null) {
        const grams = family === 'weight' ? baseInOwnFamily : baseInOwnFamily * (dryDensity ?? 1);
        baseCount += grams / stdWeight;
      } else {
        const countUnitMl = COUNT_UNIT_ML[normalizeUnit(countUnit)];
        if (family === 'volume' && countUnitMl !== undefined) {
          baseCount += baseInOwnFamily / countUnitMl;
        } else {
          retainResidual(m);
        }
      }
    }
  }

  const result: Omit<ShoppingItem, 'id'>[] = [];
  const item = (quantity: number, unit: string): Omit<ShoppingItem, 'id'> => ({
    name: canonicalName,
    quantity: Math.round(quantity * 100) / 100,
    unit,
    category,
    checked: false,
    manual: false,
    sources,
  });

  if (target === 'weight' && baseG > 0) {
    const r = fromBaseWeight(baseG);
    result.push(item(r.quantity, r.unit));
  }
  if (target === 'volume' && baseMl > 0) {
    const liquidPreferred = category === 'Oils, Sauces & Condiments' || hasMetricVolume;
    const { quantity, unit } = formatVolumeOutput(baseMl, category, liquidPreferred);
    result.push(item(quantity, unit));
  }
  if (target === 'count' && baseCount > 0) {
    const qty = Math.round(baseCount * 100) / 100;
    const finalCountUnit = countUnit || pluralizeUnit(canonicalName, qty);
    result.push(item(qty, finalCountUnit));
  }

  for (const residual of residuals.values()) {
    result.push(item(residual.quantity, residual.unit));
  }

  // A qualitative ingredient such as "salt to taste" has no numeric amount,
  // but it is still a required shopping-list row.
  if (result.length === 0 && members.length > 0) {
    result.push(item(0, ''));
  }

  return result;
}

// ─── Gemini-Guided Aggregator ─────────────────────────────────

/**
 * Given a flat list of raw ingredients and Gemini's groupings,
 * sum each group's quantities in base units then convert to display units.
 */
export function aggregateByGeminiGroups(
  rawIngredients: RawIngredient[],
  groups: GeminiGroup[]
): Omit<ShoppingItem, 'id'>[] {
  const rawById = new Map(rawIngredients.map((r) => [r.id, r]));
  const result: Omit<ShoppingItem, 'id'>[] = [];

  for (const group of groups) {
    const members = group.sourceIds
      .map((id) => rawById.get(id))
      .filter((r): r is RawIngredient => r !== undefined);

    if (members.length === 0) continue;

    const sources: { id: string; title: string; servings: number }[] = [];
    const seenSourceIds = new Set<string>();
    for (const m of members) {
      if (!seenSourceIds.has(m.source.id)) {
        seenSourceIds.add(m.source.id);
        sources.push(m.source);
      }
    }

    const category = group.category;

    result.push(...collapseGroupToItems(
      group.canonicalName,
      category,
      group.unit,
      members,
      sources,
    ));
  }

  return result;
}

/**
 * Ask the authenticated regional callable to semantically group raw ingredients.
 * Rows that cannot be sent, exceed the callable cap, or are omitted by the AI
 * are preserved through the existing local categorisation fallback.
 */
export async function getGeminiGroupings(
  householdId: string,
  rawIngredients: RawIngredient[],
): Promise<GeminiGroup[]> {
  const household = canonicalizeHouseholdId(householdId);
  if (rawIngredients.length === 0) return [];

  const allIds = new Set<number>();
  for (const raw of rawIngredients) {
    if (allIds.has(raw.id)) throw new Error('Duplicate shopping ingredient IDs');
    allIds.add(raw.id);
  }

  const candidates: ShoppingIngredientAiInput[] = [];
  for (const raw of rawIngredients) {
    if (!Number.isInteger(raw.id) || raw.id < 0 || raw.id > 9_999) continue;
    const name = raw.name.trim().slice(0, 120);
    if (!name) continue;
    const finiteQuantity = Number.isFinite(raw.quantity) ? raw.quantity : 0;
    candidates.push({
      id: raw.id,
      name,
      quantity: Math.min(1_000_000, Math.max(0, finiteQuantity)),
      unit: raw.unit.trim().slice(0, 40),
    });
    if (candidates.length === 500) break;
  }

  const groups: GeminiGroup[] =
    candidates.length > 0 ? await aiClient.shoppingGroups(household, candidates) : [];
  const sentIds = new Set(candidates.map(({ id }) => id));
  const coveredIds = new Set<number>();
  const normalizedGroups: GeminiGroup[] = [];

  for (const group of groups) {
    const sourceIds = group.sourceIds.filter((id) => {
      if (!sentIds.has(id) || coveredIds.has(id)) return false;
      coveredIds.add(id);
      return true;
    });
    if (sourceIds.length === 0) continue;
    normalizedGroups.push({
      canonicalName: group.canonicalName,
      category: group.category,
      sourceIds,
      unit: group.unit,
    });
  }

  for (const raw of rawIngredients) {
    if (coveredIds.has(raw.id)) continue;
    coveredIds.add(raw.id);
    const canonicalName = raw.name.trim().slice(0, 120) || 'Ingredient';
    normalizedGroups.push({
      canonicalName,
      category: categoriseIngredient(canonicalName),
      sourceIds: [raw.id],
      unit: undefined,
    });
  }

  return normalizedGroups;
}

// ─── Name / Unit Normalisation ────────────────────────────────

/**
 * Normalise an ingredient name for deduplication.
 * Examples:
 *   "garlic, minced"               → "garlic"
 *   "garlic cloves"                → "garlic"
 *   "spring onion, thinly sliced"  → "spring onion"
 */
function normalizeIngredientName(name: string): string {
  let n = name.toLowerCase().trim();
  n = n.replace(/,.*$/, '').trim();
  n = n.replace(/\s+or\s+\S+\s*$/, '').trim();
  n = n.replace(/\(.*?\)/g, '').trim();
  n = n.replace(/\b(cloves?|heads?|stalks?|sprigs?)\b/g, '');
  n = n.replace(
    /\b(finely|roughly|coarsely|thinly|freshly|lightly|well|extra|very)\b/g,
    ''
  );
  n = n.replace(
    /\b(chopped|minced|diced|sliced|crushed|grated|peeled|trimmed|halved|quartered|shredded|torn|whole|fresh|dried|ground|powdered|frozen|toasted|roasted|cooked|raw|large|small|medium|big)\b/g,
    ''
  );
  return n.replace(/\s{2,}/g, ' ').trim();
}

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
    bunches: 'bunch',
    leaves: 'leaf',
    heads: 'head',
    cans: 'can',
    jars: 'jar',
    bags: 'bag',
  };
  return MAP[u] ?? u;
}

// ─── Categorisation ───────────────────────────────────────────

export function categoriseIngredient(name: string): ShoppingCategory {
  const n = name.toLowerCase();

  const isDried = /\b(dried|ground|powdered|dehydrated)\b/.test(n);
  const isHerb = /\b(basil|parsley|coriander|cilantro|mint|thyme|rosemary|dill|oregano|sage|tarragon|chive|bay\s+lea|lemongrass|kaffir|galangal|chervil|marjoram|lovage|sorrel)\b/.test(n);

  if (isHerb && isDried) return 'Herbs & Spices';

  if (
    /\b(cumin|paprika|turmeric|cinnamon|cardamom|nutmeg|clove|allspice|star\s+anise|fennel\s+seed|caraway|coriander\s+seed|mustard\s+seed|fenugreek|sumac|za.atar|ras\s+el\s+hanout|garam\s+masala|curry\s+powder|five\s+spice|chinese\s+five|cajun|chili\s+powder|cayenne|smoked\s+paprika|sweet\s+paprika|onion\s+powder|garlic\s+powder|celery\s+salt|mixed\s+spice|mixed\s+herb|italian\s+season|herbes?\s+de\s+provence|baharat|dukkah|harissa\s+spice)\b/.test(n) ||
    /\bspice\b/.test(n)
  )
    return 'Herbs & Spices';

  if (
    /\b(olive\s+oil|vegetable\s+oil|canola\s+oil|sunflower\s+oil|coconut\s+oil|sesame\s+oil|avocado\s+oil|peanut\s+oil|grapeseed\s+oil|neutral\s+oil|cooking\s+oil)\b/.test(n) ||
    /\b(?<!coconut\s)oil\b/.test(n) ||
    /\b(vinegar|balsamic|rice\s+wine\s+vinegar|apple\s+cider\s+vinegar|white\s+wine\s+vinegar|red\s+wine\s+vinegar|sherry\s+vinegar)\b/.test(n) ||
    /\b(soy\s+sauce|fish\s+sauce|oyster\s+sauce|hoisin|teriyaki|worcestershire|sriracha|hot\s+sauce|tabasco|ketchup|mayo|mayonnaise|mustard|dijon|relish|chutney|miso|tahini|nam\s+pla|ponzu|tamari|liquid\s+aminos)\b/.test(n)
  )
    return 'Oils, Sauces & Condiments';

  if (
    /\b(stock|broth|bouillon|jus)\b/.test(n) ||
    /\b(coconut\s+milk|coconut\s+cream|coconut\s+water)\b/.test(n) ||
    /\boat\s+milk\b|\balmond\s+milk\b|\brice\s+milk\b|\bsoy\s+milk\b/.test(n) ||
    /\b(tomato\s+paste|tomato\s+puree|tomato\s+sauce|tomato\s+can|canned\s+tomato|crushed\s+tomato|diced\s+tomato|sun.dried\s+tomato)\b/.test(n) ||
    /\b(pasta|noodle|rice|flour|sugar|salt|honey|maple|syrup|jam|paste|powder|seasoning|extract|baking|yeast|stock\s+cube|bouillon\s+cube|tinned|canned)\b/.test(n)
  )
    return 'Pantry & Dry Goods';

  if (
    /\b(chicken|beef|pork|lamb|fish|salmon|tuna|cod|trout|shrimp|prawn|turkey|bacon|sausage|mince|steak|fillet|duck|veal|crab|anchov|seafood|pancetta|chorizo|salami|ham|venison|brisket|ribs)\b/.test(n)
  )
    return 'Meat & Seafood';

  if (
    /\b(milk|cream|butter|cheese|yogurt|yoghurt|egg|eggs|parmesan|mozzarella|cheddar|feta|ricotta|brie|haloumi|sour\s+cream|creme\s+fraiche|ghee|quark|gouda|gruyere|pecorino|cream\s+cheese|cottage\s+cheese)\b/.test(n)
  )
    return 'Dairy & Eggs';

  if (
    /\b(bread|bun|wrap|pita|pitta|roll|loaf|tortilla|naan|bagel|croissant|brioche|sourdough|crumpet|muffin|flatbread)\b/.test(n)
  )
    return 'Bread & Bakery';

  if (/\bfrozen\b/.test(n)) return 'Frozen';

  if (
    isHerb ||
    /\b(onion|garlic|tomato|potato|carrot|cucumber|lettuce|spinach|mushroom|pepper|capsicum|broccoli|celery|ginger|lemon|lime|orange|apple|banana|avocado|chilli|chili|spring\s+onion|zucchini|courgette|eggplant|aubergine|cabbage|kale|asparagus|leek|fennel|beetroot|radish|pumpkin|sweet\s+potato|corn|pea|bean|green\s+bean|snow\s+pea|bok\s+choy|pak\s+choi|shallot|scallion|rocket|arugula|silverbeet|broccolini|chard|watercress|endive|witlof|sprout|mango|pineapple|strawberr|blueberr|raspberr|grape|peach|plum|pear|kiwi|melon|pomegranate|fig|date|cherry|passionfruit|mandarin|grapefruit|zest|rind)\b/.test(n)
  )
    return 'Produce';

  return 'Pantry & Dry Goods';
}
