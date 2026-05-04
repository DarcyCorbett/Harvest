// ============================================================
// Gemini client + batched per-recipe tagging.
// Centralises model ID, API key, JSON-mode config, and response parsing.
// ============================================================

import type { Recipe } from './types';

const GEMINI_MODEL = 'gemini-3.1-pro-preview';
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
export async function callGemini<T>(prompt: string, maxOutputTokens: number): Promise<T> {
  if (!GEMINI_API_KEY) throw new Error('No Gemini API key');

  const url = `${GEMINI_API_BASE}/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
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
  recipes: { recipeId: string; recipe: Recipe }[]
): Promise<Map<string, string[]>> {
  if (recipes.length === 0 || !GEMINI_API_KEY) return new Map();

  const input = recipes.map(({ recipeId, recipe }) => ({
    id: recipeId,
    title: recipe.title,
    totalMinutes: recipe.totalTime ? parseInt(recipe.totalTime) : null,
    ingredients: recipe.ingredients.map((i) => i.name),
    steps: recipe.instructions.map((s) => s.substring(0, 150)).join(' | '),
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
    const parsed = await callGemini<{ results?: unknown }>(prompt, maxOutputTokens);
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
