// ============================================================
// TEMPORARY Task 4 operator-only Gemini adapter.
// Keep this module outside every mobile import graph; Task 9 replaces it with Secret Manager.
// ============================================================

import type { Recipe, ShoppingCategory } from '../../services/types';

export const GEMINI_TAGGING_MODEL = 'gemini-3.1-flash-lite';
export const GEMINI_AGGREGATION_MODEL = 'gemini-3.5-flash';
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_API_KEY = process.env.EXPO_PUBLIC_GEMINI_API_KEY ?? '';

export function hasGeminiKey(): boolean {
  return GEMINI_API_KEY.length > 0;
}

/**
 * Shared Gemini call wrapper. Sends a single JSON-mode request and returns the
 * parsed payload. Throws on network / HTTP / MAX_TOKENS / parse errors so callers
 * can decide whether the failure is fatal or should fall back.
 */
export async function callGemini<T>(prompt: string, maxOutputTokens: number, modelOverride?: string): Promise<T> {
  if (!GEMINI_API_KEY) throw new Error('No Gemini API key');

  const model = modelOverride || GEMINI_TAGGING_MODEL;
  const url = `${GEMINI_API_BASE}/${model}:generateContent?key=${GEMINI_API_KEY}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens,
        responseMimeType: 'application/json',
      },
    }),
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw new Error(`Gemini API error ${response.status}: ${errBody.slice(0, 200)}`);
  }

  const data = await response.json();
  const finishReason: string | undefined = data?.candidates?.[0]?.finishReason;
  if (finishReason === 'MAX_TOKENS') throw new Error('Gemini response truncated (MAX_TOKENS)');

  const text: string | undefined = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned no text');

  return JSON.parse(text) as T;
}

/**
 * Ask Gemini to classify a batch of freshly scraped recipes in a single call.
 * Returns a Map of recipeId → tags. Returns an empty Map on any error
 * (non-fatal — recipes are still usable without Gemini tags).
 *
 * Batching the whole plan into one request saves ~70–85% of input tokens vs
 * one request per recipe (the ~2 KB rules block is sent once, not N times)
 * and trades N network round trips for one.
 */
export async function tagRecipesWithGemini(
  recipes: { recipeId: string; recipe: Recipe }[],
  modelOverride?: string
): Promise<Map<string, string[]>> {
  if (recipes.length === 0 || !GEMINI_API_KEY) return new Map();

  const input = recipes.map(({ recipeId, recipe }) => ({
    id: recipeId,
    title: recipe.title,
    totalMinutes: recipe.totalTime ? parseInt(recipe.totalTime) : null,
    ingredients: recipe.ingredients.map((i) => i.name),
    steps: recipe.instructions.map((s) => s.text.substring(0, 150)).join(' | '),
    existingTags: recipe.tags ?? [],
  }));

  const prompt = `You are given a list of freshly scraped recipes. Return JSON: { "results": [{ "id": string, "tags": string[] }] }. For each recipe, "tags" contains only tags from the allowed list that clearly apply.

Allowed tags:
- Course: "Breakfast", "Lunch", "Dinner", "Side", "Snack", "Salad"
- Cuisine: "Asian", "Mexican", "Mediterranean", "Italian", "Indian"
- Modifiers: "Healthy", "Vegetarian", "Kid Friendly"

Course rules:
- "Dinner" / "Lunch": substantial main meal only — never for snacks, dips, appetisers, finger foods, or small bites.
- "Snack": small/light, not a main meal (dips, wings, sliders, bliss balls).
- "Side": served alongside a main (roasted veg, rice, bread, side salads).
- "Breakfast": morning meal. "Salad": salad-based dish.
- Never combine: Snack+Dinner, Snack+Lunch (use Snack and/or Side). Never combine Breakfast with Lunch or Dinner (pick primary, or omit if ambiguous).
- Valid combinations: Side+Snack, Side+Salad, Lunch+Dinner, Salad+Lunch.

"Healthy" — tag only if MOST apply:
- Whole, minimally processed ingredients (whole grains, fresh produce, lean proteins, legumes).
- Added sugar <~10g/serving; saturated fat <~5g/serving; no trans fats; sodium <~600mg/serving.
- Contains a fibre source (veg, legumes, whole grains, fruit).
- Cooked by baking/roasting/steaming/grilling/light sautéing — not deep- or heavily pan-fried.
- Vegetables are a substantial share of the dish.

"Kid Friendly" — tag only if MOST apply:
- Mild: no chili heat, minimal black pepper, no raw onion/garlic.
- No pungent ingredients (blue cheese, anchovies, olives, capers, fish sauce, strong curry pastes) unless fully cooked and undetectable.
- Components identifiable and separated, not hidden in stew/casserole.
- Easy to eat: bite-sized or fork-friendly; no tough cuts or long unwieldy noodles.
- Visually approachable: no heavy char, minimal green flecks.
- Veg limited to kid-accepted ones (carrots, corn, peas, cucumber, cherry tomatoes, sweet peppers, broccoli, sweet potato).
- No alcohol, even if cooked off.

"Vegetarian" (lacto-ovo) — tag only if:
- No meat, poultry, fish, or seafood (including shellfish or any aquatic animal).
- Dairy and eggs are permitted.

General rules:
- Only include a tag when confident; omit anything borderline.
- Multiple cuisine tags allowed if the recipe genuinely spans cuisines.
- Do not repeat a tag that already appears in that recipe's existingTags.
- Every input recipe must appear exactly once in "results", preserving its input "id".
- Return only the JSON object — no markdown, no explanation.

Recipes:
${JSON.stringify(input)}`;

  // Output budget: worst-case per-recipe response is ~60–80 tokens (4 tags +
  // long Firestore ID + whitespace). 400 tokens/recipe gives ~5× slack.
  // maxOutputTokens is a truncation cap, not a billing amount — Gemini bills
  // only for tokens actually emitted, so raising the ceiling only prevents
  // truncation, it doesn't cost more per call.
  const maxOutputTokens = Math.min(32000, 4096 + recipes.length * 400);

  try {
    const parsed = await callGemini<{ results?: unknown }>(prompt, maxOutputTokens, modelOverride);
    if (!parsed || !Array.isArray(parsed.results)) {
      console.warn('[Tagger] Gemini batched response missing results array:', parsed);
      return new Map();
    }

    const out = new Map<string, string[]>();
    for (const entry of parsed.results as Record<string, unknown>[]) {
      const id = typeof entry?.id === 'string' ? entry.id : undefined;
      const tags = Array.isArray(entry?.tags)
        ? (entry.tags as unknown[]).filter((t): t is string => typeof t === 'string')
        : [];
      if (id) out.set(id, tags);
    }
    console.log(`[Tagger] Gemini batched tags for ${out.size}/${recipes.length} recipes`);
    return out;
  } catch (err) {
    console.error('[Tagger] Gemini batched tagging failed:', err);
    return new Map();
  }
}


export interface LegacyRawIngredient {
  id: number;
  name: string;
  quantity: number;
  unit: string;
}

export interface LegacyGeminiGroup {
  canonicalName: string;
  category: ShoppingCategory;
  sourceIds: number[];
  unit?: string;
}

/**
 * Ask Gemini to semantically group raw ingredients. Returns `[{canonicalName, category, sourceIds[]}]`
 * with every raw id placed into exactly one group.
 */
export async function getGeminiGroupings(rawIngredients: LegacyRawIngredient[], modelOverride?: string): Promise<LegacyGeminiGroup[]> {
  const prompt = `You are given a list of recipe ingredients as JSON. Group them into shopping list items.

Rules:
1. Group ingredients that refer to the same item despite different wording. Use the most natural canonical name (e.g. "garlic", not "minced garlic").
2. Prep-state differences done at home → merge into one group: "minced garlic" + "garlic" → "garlic"; "diced onion" + "onion" → "onion"; "chopped tomato" + "tomato" → "tomato".
3. Different cuts or forms of meat, poultry, and fish → ALWAYS keep as separate groups (they are sold separately): "chicken breast" ≠ "chicken thighs" ≠ "chicken mince"; "beef mince" ≠ "beef steak"; "salmon fillet" ≠ "smoked salmon".
4. "shredded chicken" with no whole-chicken ingredient → treat as "chicken breast". "shredded chicken" where a whole roast chicken ingredient also appears → merge into "whole chicken".
5. Every ingredient id must appear in exactly one group. If uncertain, create a single-item group.
6. Set the "category" field for each group using these rules:
   - Herbs & Spices: fresh/dried herbs, spices, spice blends
   - Oils, Sauces & Condiments: cooking oils, vinegar, soy sauce, fish sauce, oyster sauce, Worcestershire, sriracha, ketchup, mayo, mustard, miso, tahini, hoisin
   - Pantry & Dry Goods: stocks, broths, canned goods, pasta, rice, flour, sugar, honey, baking
   - Produce: fresh fruit and vegetables
   - Meat & Seafood: raw meat, fish, seafood
   - Dairy & Eggs: milk, cream, butter, cheese, yoghurt, eggs
   - Bread & Bakery: bread, wraps, rolls, tortillas
   - Frozen: anything frozen
   - Other: anything else
7. For dry pantry ingredients measured in ml (converted from cups/tbsp), note this in the canonicalName or leave as-is — the quantity conversion will be handled by the caller.
8. For groups whose natural shopping unit is a count (e.g. "chicken thighs", "eggs", "onions", "lemons"), set the "unit" field to the plural noun used when counting that item at the supermarket. Examples: "chicken thighs" → unit "thighs"; "eggs" → unit "eggs"; "onions" → unit "onions"; "lemons" → unit "lemons"; "bananas" → unit "bananas". A count-style group should always have a non-empty unit so the list reads "3 onions" not "3". Only leave unit as "" when the item is measured by weight or volume (e.g. flour, olive oil).

Return ONLY a valid JSON array — no markdown, no explanation:
[{"canonicalName": "...", "category": "...", "sourceIds": [0, 4, 7], "unit": ""}, ...]

Input:
${JSON.stringify(rawIngredients.map(({ id, name, quantity, unit }) => ({ id, name, quantity, unit })))}`;

  // Each group's JSON averages ~55–80 output tokens. Scale the ceiling with
  // ingredient count so large plans don't truncate while small plans stay cheap.
  // (maxOutputTokens is a truncation cap, not a billing amount — Gemini bills
  // only for tokens actually produced.)
  const maxOutputTokens = Math.min(65536, 4096 + rawIngredients.length * 200);
  const parsed = await callGemini<unknown>(prompt, maxOutputTokens, modelOverride || GEMINI_AGGREGATION_MODEL);

  if (!Array.isArray(parsed)) throw new Error('Gemini response is not an array');

  const coveredIds = new Set<number>();
  const groups = (parsed as Record<string, unknown>[]).map((g) => ({
    canonicalName: String(g.canonicalName ?? '').trim(),
    category: (g.category as ShoppingCategory) ?? 'Other',
    sourceIds: (g.sourceIds as number[]) ?? [],
    unit: g.unit != null ? String(g.unit) : undefined,
  }));
  groups.forEach((g) => g.sourceIds.forEach((id) => coveredIds.add(id)));

  for (const raw of rawIngredients) {
    if (!coveredIds.has(raw.id)) {
      groups.push({
        canonicalName: raw.name.trim(),
        category: categoriseIngredient(raw.name),
        sourceIds: [raw.id],
        unit: undefined,
      });
    }
  }

  return groups;
}

function categoriseIngredient(name: string): ShoppingCategory {
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
