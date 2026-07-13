// ============================================================
// Ingredient substitution generator — powered by Gemini.
// Keeps the same exported interface so all callers are unchanged.
// ============================================================

import { callGemini, GEMINI_TAGGING_MODEL } from './gemini';

export interface SubstitutionResult {
  name: string;       // e.g. "Coconut cream"
  adjustment: string; // e.g. "Use 1:1 ratio"
  reason: string;     // e.g. "Provides similar rich texture and fat content"
}

// Simple in-memory cache to store substitutions during the active session.
// Key format: "recipeTitle|ingredientName"
const substitutionCache = new Map<string, SubstitutionResult[]>();

/** Always returns true — Gemini key is shared with the rest of the app. */
export function hasDeepSeekKey(): boolean {
  return true;
}

/**
 * Fetch 3 contextual substitutions for an ingredient using Gemini gemini-3.1-flash-lite.
 */
export async function getIngredientSubstitutions(
  ingredientName: string,
  ingredientUnit: string,
  recipeTitle: string,
  allIngredients: string[]
): Promise<SubstitutionResult[]> {
  const cacheKey = `${recipeTitle.trim().toLowerCase()}|${ingredientName.trim().toLowerCase()}`;
  if (substitutionCache.has(cacheKey)) {
    console.log(`[Substitution] Cache hit for "${ingredientName}" in "${recipeTitle}"`);
    return substitutionCache.get(cacheKey)!;
  }

  console.log(`[Substitution] Requesting via Gemini (${GEMINI_TAGGING_MODEL}) for "${ingredientName}" in "${recipeTitle}"`);

  const prompt = `You are a professional culinary assistant. Suggest exactly 3 suitable ingredient replacements for a specific ingredient in the context of the provided recipe.

Recipe Title: ${recipeTitle}
All Recipe Ingredients:
${allIngredients.map(i => `- ${i}`).join('\n')}

Target Ingredient to substitute: ${ingredientName}${ingredientUnit ? ` (unit: ${ingredientUnit})` : ''}

Return JSON matching this exact schema — no markdown, no extra fields:
{
  "substitutions": [
    {
      "name": "name of substitute ingredient",
      "adjustment": "quantity or ratio adjustment, e.g. '1:1 ratio' or 'Use 1/2 cup per cup'",
      "reason": "one short sentence explaining why it works in this recipe"
    }
  ]
}`;

  try {
    const parsed = await callGemini<{ substitutions?: SubstitutionResult[] }>(
      prompt,
      600,
      GEMINI_TAGGING_MODEL
    );

    const substitutions = parsed.substitutions;
    if (!Array.isArray(substitutions) || substitutions.length === 0) {
      throw new Error('Empty or invalid substitution response from Gemini.');
    }

    substitutionCache.set(cacheKey, substitutions);
    return substitutions;
  } catch (err) {
    console.error('[Substitution] Gemini call failed:', err);
    throw err;
  }
}
