/**
 * Every AI model the backend calls, in one place.
 *
 * Check https://ai.google.dev/gemini-api/docs/deprecations before changing.
 * gemini-3.1-flash-lite is scheduled to shut down on 7 May 2027; Google's
 * named replacement is gemini-3.5-flash-lite. Re-run the evaluation in
 * docs/ai-stack-evaluation.md before switching.
 */
export const RECIPE_MODEL = 'gemini-3.1-flash-lite';
export const SHOPPING_MODEL = 'gemini-4-hydrogen';
/** Yes/no and choice decisions only; it returns no text. Used for recipe labels. */
export const DECISION_MODEL = 'gemini-decision-1';
/** OpenAI Responses API. Used for ingredient substitutions. */
export const SUBSTITUTION_MODEL = 'gpt-6-luna';
export const SUBSTITUTION_REASONING_EFFORT = 'medium';

/**
 * Which engine labels recipes (tags, reminders, catalogue taxonomy).
 * 'decision' asks DECISION_MODEL one question per label and falls back to the
 * RECIPE_MODEL prompt if that call fails. 'gemini' uses the prompt only.
 */
export const RECIPE_LABEL_ENGINE: 'decision' | 'gemini' = 'decision';

/** Models that reject or ignore an explicit temperature setting. */
export function acceptsTemperature(model: string): boolean {
  return model !== SHOPPING_MODEL && model !== 'gemini-3.8-flash';
}

/**
 * Gemini 4 Hydrogen defaults to high thinking and rejects 'minimal'. Shopping
 * grouping is matching and sorting, so it runs at the level chosen in
 * docs/ai-stack-evaluation.md. Other models keep their own default.
 */
export function thinkingLevelFor(model: string): 'low' | 'medium' | 'high' | undefined {
  return model === SHOPPING_MODEL ? 'low' : undefined;
}
