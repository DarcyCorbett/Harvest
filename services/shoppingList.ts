// ============================================================
// Shopping list aggregation — merges ingredients across recipes,
// categorises them, and optionally uses Gemini for semantic grouping.
// ============================================================

import { aiClient, canonicalizeHouseholdId, type ShoppingIngredientAiInput } from './aiClient';
import type { Ingredient, Recipe, ShoppingCategory, ShoppingItem } from './types';
import { combineAmounts, normalizeIngredient, shoppingName, safeGroupNames } from '../functions/src/shared/ingredientAmounts';

// ─── Public Types ─────────────────────────────────────────────

/** Input row for the aggregator — decoupled from GeneratedMeal to avoid circular imports. */
export interface MealForShopping {
  recipeId: string;
  recipe: Recipe;
  servings: number;
}

// ─── Raw / Group Internal Types ───────────────────────────────

export interface RawIngredient {
  id: number;
  name: string;
  quantity: number;
  unit: string;
  notes?: string;
  source: { id: string; title: string; servings: number };
}

export interface GeminiGroup {
  canonicalName: string;
  category: ShoppingCategory;
  sourceIds: number[];
  /** Natural unit word for count items, e.g. "thighs", "eggs". Empty string if none. */
  unit?: string;
}

/**
 * Use the same authoritative ingredient listing as the recipe card.
 */
export function completeRecipeIngredients(recipe: Recipe): Ingredient[] {
  return recipe.ingredientGroups?.length
    ? recipe.ingredientGroups.flatMap(group => group.ingredients)
    : [...recipe.ingredients];
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
    const ingredients = completeRecipeIngredients(meal.recipe).map(normalizeIngredient).map((ingredient) => ({
      ...ingredient,
      quantity: Math.max(0, Number.isFinite(ingredient.quantity) ? ingredient.quantity : 0) * factor,
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
    members: { quantity: number; unit: string; notes?: string }[];
    sources: { id: string; title: string; servings?: number }[];
  }
  const grouped = new Map<string, FallbackGroup>();

  for (const meal of meals) {
    const source = { id: meal.recipeId, title: meal.recipe.title, servings: meal.servings };
    for (const raw of meal.recipe.ingredients) {
      const ing = normalizeIngredient(raw);
      const normName = shoppingName(ing);
      const existing = grouped.get(normName);
      if (existing) {
        existing.members.push({ quantity: ing.quantity, unit: ing.unit, notes: ing.notes });
        if (!existing.sources.some((s) => s.id === source.id)) {
          existing.sources.push(source);
        }
      } else {
        grouped.set(normName, {
          canonicalName: normName,
          category: categoriseIngredient(ing.name),
          members: [{ quantity: ing.quantity, unit: ing.unit, notes: ing.notes }],
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

interface CollapseMember { quantity: number; unit: string; notes?: string }
function collapseGroupToItems(
  canonicalName: string, category: ShoppingCategory, _groupUnit: string | undefined,
  members: CollapseMember[], sources: { id: string; title: string; servings?: number }[],
): Omit<ShoppingItem, 'id'>[] {
  return combineAmounts(members).map(amount => ({
    name: canonicalName, quantity: amount.quantity, unit: amount.unit,
    category, checked: false, manual: false, sources,
  }));
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
  const ids = groups.flatMap(group => group.sourceIds);
  if (ids.length !== rawIngredients.length || new Set(ids).size !== ids.length || ids.some(id => !rawById.has(id))) {
    throw new Error('Invalid shopping grouping coverage');
  }
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

    const names = safeGroupNames(group.canonicalName, members);
    const products = new Map<string, RawIngredient[]>();
    members.forEach((member, index) => products.set(names[index], [...(products.get(names[index]) ?? []), member]));
    for (const [name, product] of products) {
      result.push(...collapseGroupToItems(name, group.category, undefined, product.map(normalizeIngredient),
        sources.filter(source => product.some(member => member.source.id === source.id))));
    }
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
      ...(raw.notes ? { notes: raw.notes.slice(0, 1000) } : {}),
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
