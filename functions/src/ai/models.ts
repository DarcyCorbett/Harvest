/**
 * Every Gemini model the backend calls, in one place.
 *
 * Check https://ai.google.dev/gemini-api/docs/deprecations before changing.
 * gemini-3.1-flash-lite is scheduled to shut down on 7 May 2027; Google's
 * named replacement is gemini-3.5-flash-lite. Re-run the evaluation in
 * docs/ai-stack-evaluation.md before switching.
 */
export const RECIPE_MODEL = 'gemini-3.1-flash-lite';
export const SHOPPING_MODEL = 'gemini-3.8-flash';

/** Models that reject an explicit temperature setting. */
export function acceptsTemperature(model: string): boolean {
  return model !== SHOPPING_MODEL;
}
