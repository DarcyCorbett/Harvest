import { describe, expect, it, vi } from 'vitest';

import {
  DECISION_ENDPOINT,
  REMINDER_QUESTIONS,
  TAG_QUESTIONS,
  TAXONOMY_QUESTIONS,
  buildTagDecisionInput,
  composeReminders,
  composeTags,
  composeTaxonomyEvidence,
  mapInParallel,
  requestDecisions,
  type DecisionAnswer,
  type DecisionAnswers,
} from '../src/ai/decision.js';
import { createAiService, type JsonRequester } from '../src/ai/service.js';
import { requestOpenAiJson } from '../src/ai/openaiProvider.js';
import { createCatalogueClassifier } from '../src/catalogue/classifier.js';
import { deriveTaxonomyV2 } from '../src/catalogue/taxonomyV2.js';

const noul = (p: number): DecisionAnswer => ({ type: 'noul', noul: p, confidence: Math.max(p, 1 - p) });
const choice = (c: string): DecisionAnswer => ({ type: 'choice', choice: c, probabilities: { [c]: 1 }, confidence: 1 });

/** A plain, healthy, kid-friendly dinner main; individual answers are overridden per test. */
function taxonomyAnswers(overrides: DecisionAnswers = {}): DecisionAnswers {
  const answers: DecisionAnswers = {};
  for (const [key, spec] of Object.entries(TAXONOMY_QUESTIONS)) {
    if (spec.type === 'choice') answers[key] = choice(key === 'mealType_mode' ? 'dish' : 'none');
    else if (/_block_/.test(key) || /role_(breakfast|lunch|side|snack|dessert)$/.test(key) || key === 'healthy_clearlyHealthierVersion') answers[key] = noul(0.02);
    else answers[key] = noul(0.95);
  }
  return { ...answers, ...overrides };
}
const tagAnswers = (overrides: DecisionAnswers = {}): DecisionAnswers =>
  ({ ...Object.fromEntries(Object.keys(TAG_QUESTIONS).map((key) => [key, noul(0.01)])), ...overrides });
const derive = (answers: DecisionAnswers) => deriveTaxonomyV2(composeTaxonomyEvidence(answers));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('decision answer composition', () => {
  it('labels a clean main as a healthy, kid-friendly dinner', () => {
    expect(derive(taxonomyAnswers())).toEqual({ mealTypes: ['dinner'], kidFriendly: true, healthy: true });
  });

  it('resolves a low lunch/dinner near-tie to dinner instead of lunch only', () => {
    expect(derive(taxonomyAnswers({ mealType_role_lunch: noul(0.4), mealType_role_dinner: noul(0.35) })).mealTypes).toEqual(['dinner']);
    expect(derive(taxonomyAnswers({ mealType_role_lunch: noul(0.45), mealType_role_dinner: noul(0.1) })).mealTypes).toEqual(['lunch']);
  });

  it('keeps dessert apart from lunch, dinner and side', () => {
    const answers = taxonomyAnswers({ mealType_role_dessert: noul(0.9), mealType_role_snack: noul(0.9) });
    expect(derive(answers).mealTypes).toEqual(['snack', 'dessert']);
  });

  it('applies a kid blocker only when its own question says yes', () => {
    expect(derive(taxonomyAnswers({ kid_block_alcohol: noul(0.3) })).kidFriendly).toBe(true);
    expect(derive(taxonomyAnswers({ kid_block_alcohol: noul(0.8) })).kidFriendly).toBe(false);
  });

  it('fails healthy when any one restraint gate or blocker fails', () => {
    for (const key of ['healthy_addedSugarRestrained', 'healthy_refinedStarchRestrained', 'healthy_richnessRestrained']) {
      expect(derive(taxonomyAnswers({ [key]: noul(0.3) })).healthy).toBe(false);
    }
    expect(derive(taxonomyAnswers({ healthy_block_fried: noul(0.9) })).healthy).toBe(false);
  });

  it('treats a component as exclusive and never kid friendly', () => {
    const answers = taxonomyAnswers({
      mealType_mode: choice('component'),
      mealType_componentKind: { type: 'choice', choice: 'sauce-condiment', probabilities: { 'sauce-condiment': 0.9, none: 0.1 }, confidence: 0.9 },
    });
    expect(derive(answers)).toMatchObject({ mealTypes: ['component'], kidFriendly: false });
  });

  it('keeps Snack apart from Lunch and Dinner by probability', () => {
    expect(composeTags(tagAnswers({ Snack: noul(0.9), Dinner: noul(0.6), Kid_Friendly: noul(0.9) }))).toEqual(['Snack', 'Kid Friendly']);
    expect(composeTags(tagAnswers({ Snack: noul(0.6), Dinner: noul(0.9) }))).toEqual(['Dinner']);
  });

  it('refuses to guess when an answer is missing', () => {
    expect(() => composeReminders({ needsDefrost: noul(0.9) })).toThrow('Missing decision for needsMarinate');
  });
});

describe('requestDecisions', () => {
  const questions = REMINDER_QUESTIONS;
  const answers = { needsDefrost: noul(0.9), needsMarinate: noul(0.1) };

  it('sends one input with every question and keeps the key in a header', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json({ answers, usage: { total_input_tokens: 321 } }));
    const onUsage = vi.fn();
    await expect(requestDecisions({ apiKey: 'secret-key', input: 'Recipe', questions, fetchImpl, onUsage })).resolves.toEqual(answers);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(DECISION_ENDPOINT);
    expect(JSON.parse(String(init?.body))).toEqual({ model: 'gemini-decision-1', input: 'Recipe', questions });
    expect(String(init?.body)).not.toContain('secret-key');
    expect(onUsage).toHaveBeenCalledWith({ inputTokens: 321 });
  });

  it('retries rate limits and server errors, then succeeds', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({}, 429))
      .mockResolvedValueOnce(json({}, 503))
      .mockResolvedValueOnce(json({ answers }));
    const sleep = vi.fn(async () => undefined);
    await expect(requestDecisions({ apiKey: 'k', input: 'Recipe', questions, fetchImpl, sleep })).resolves.toEqual(answers);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('does not retry a rejected request and reports a bounded code', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json({ error: { message: 'bad' } }, 400));
    await expect(requestDecisions({ apiKey: 'k', input: 'Recipe', questions, fetchImpl })).rejects.toThrow('provider-http-400');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('rejects a response that skips a question', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json({ answers: { needsDefrost: noul(0.9) } }));
    await expect(requestDecisions({ apiKey: 'k', input: 'Recipe', questions, fetchImpl })).rejects.toThrow('provider-missing-answer');
  });
});

describe('mapInParallel', () => {
  it('preserves order and never exceeds the lane count', async () => {
    let active = 0;
    let peak = 0;
    const result = await mapInParallel([1, 2, 3, 4, 5, 6, 7], 3, async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return value * 2;
    });
    expect(result).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(peak).toBeLessThanOrEqual(3);
  });
});

describe('AI service provider routing', () => {
  const recipe = (recipeId: string, existingTags: string[] = []) => ({
    recipeId, title: 'Chicken tacos', totalMinutes: 20, ingredients: ['Chicken', 'Tortillas'], steps: ['Cook', 'Fill'], existingTags,
  });
  const substitutionInput = { ingredientName: 'Butter', ingredientUnit: 'g', recipeTitle: 'Cake', allIngredients: ['Butter', 'Flour'] };
  const substitutions = { substitutions: [1, 2, 3].map((n) => ({ name: `Option ${n}`, adjustment: '1:1', reason: 'Works.' })) };

  it('labels each recipe with its own decision request and skips existing tags', async () => {
    const provider: JsonRequester = {
      requestJson: vi.fn(),
      requestDecisions: vi.fn(async () => tagAnswers({ Dinner: noul(0.9), Mexican: noul(0.9) })),
    };
    const result = await createAiService(provider).tagRecipes([recipe('a'), recipe('b', ['Mexican'])]);
    expect(result).toEqual({ results: [{ id: 'a', tags: ['Dinner', 'Mexican'] }, { id: 'b', tags: ['Dinner'] }] });
    expect(provider.requestDecisions).toHaveBeenCalledTimes(2);
    expect(provider.requestDecisions).toHaveBeenCalledWith(buildTagDecisionInput(recipe('a')), TAG_QUESTIONS);
    expect(provider.requestJson).not.toHaveBeenCalled();
  });

  it('falls back to the prompt model when a decision request fails', async () => {
    const onFallback = vi.fn();
    const provider: JsonRequester = {
      requestJson: vi.fn(async () => ({ results: [{ id: 'a', needsDefrost: true, needsMarinate: false }] })),
      requestDecisions: vi.fn(async () => { throw new Error('provider-http-503'); }),
      onFallback,
    };
    const { recipeId, title, ingredients, steps } = recipe('a');
    const result = await createAiService(provider).reminderFlags([{ recipeId, title, ingredients, steps }]);
    expect(result).toEqual({ results: [{ id: 'a', needsDefrost: true, needsMarinate: false }] });
    expect(provider.requestJson).toHaveBeenCalledOnce();
    expect(onFallback).toHaveBeenCalledWith('reminderFlags', 'provider-http-503');
  });

  it('sends substitutions to the substitution model and falls back if it fails', async () => {
    const preferred: JsonRequester = { requestJson: vi.fn(), requestSubstitutionJson: vi.fn(async () => substitutions) };
    await expect(createAiService(preferred).substitutions(substitutionInput)).resolves.toEqual(substitutions);
    expect(preferred.requestJson).not.toHaveBeenCalled();

    const failing: JsonRequester = {
      requestJson: vi.fn(async () => substitutions),
      requestSubstitutionJson: vi.fn(async () => ({ substitutions: [] })),
      onFallback: vi.fn(),
    };
    await expect(createAiService(failing).substitutions(substitutionInput)).resolves.toEqual(substitutions);
    expect(failing.requestJson).toHaveBeenCalledWith('gemini-3.1-flash-lite', expect.any(String), 600);
    expect(failing.onFallback).toHaveBeenCalledWith('substitutions', 'provider-output-invalid');
  });
});

describe('requestOpenAiJson', () => {
  const completed = (text: string) => json({
    status: 'completed',
    output: [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'output_text', text }] }],
    usage: { input_tokens: 10, output_tokens: 20 },
  });

  it('asks the Responses API for a JSON object at the given effort', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(completed('{"ok":true}'));
    await expect(requestOpenAiJson({ apiKey: 'sk-test', model: 'gpt-6-luna', prompt: 'Return JSON.', maxOutputTokens: 4096, reasoningEffort: 'medium', fetchImpl })).resolves.toEqual({ ok: true });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: 'gpt-6-luna', reasoning: { effort: 'medium' }, max_output_tokens: 4096, store: false, text: { format: { type: 'json_object' } },
    });
    expect(String(init?.body)).not.toContain('sk-test');
  });

  it('reports bounded codes for failures', async () => {
    const call = (fetchImpl: typeof fetch, apiKey = 'k') =>
      requestOpenAiJson({ apiKey, model: 'gpt-6-luna', prompt: 'p', maxOutputTokens: 100, reasoningEffort: 'medium', fetchImpl });
    await expect(call(vi.fn<typeof fetch>(), ' ')).rejects.toThrow('provider-secret-missing');
    await expect(call(vi.fn<typeof fetch>().mockResolvedValue(json({}, 401)))).rejects.toThrow('provider-http-401');
    await expect(call(vi.fn<typeof fetch>().mockResolvedValue(json({ status: 'incomplete', output: [] })))).rejects.toThrow('provider-incomplete');
    await expect(call(vi.fn<typeof fetch>().mockResolvedValue(completed('not json')))).rejects.toThrow('provider-invalid-json');
  });
});

describe('catalogue classifier with decision evidence', () => {
  const content = {
    title: 'Chicken tacos', originalServings: 4,
    ingredients: [{ name: 'chicken', quantity: 500, unit: 'g' }],
    instructions: [{ text: 'Cook and fill.' }],
  } as never;
  const metadata = { cuisines: ['mexican'] } as never;

  it('prefers decision evidence and never calls the prompt model', async () => {
    const requestJson = vi.fn();
    const classify = createCatalogueClassifier({
      requestJson,
      requestTaxonomyEvidence: async () => composeTaxonomyEvidence(taxonomyAnswers({ mealType_role_lunch: noul(0.9) })),
    });
    const result = await classify(content, metadata);
    expect(result.metadata.mealTypes).toEqual(['lunch', 'dinner']);
    expect(result.metadata.modifiers).toEqual(expect.arrayContaining(['kid-friendly', 'healthy']));
    expect(requestJson).not.toHaveBeenCalled();
  });

  it('falls back to the prompt when the decision request fails', async () => {
    const promptEvidence = composeTaxonomyEvidence(taxonomyAnswers());
    const requestJson = vi.fn(async () => promptEvidence);
    const classify = createCatalogueClassifier({
      requestJson,
      requestTaxonomyEvidence: async () => { throw new Error('provider-network'); },
    });
    expect((await classify(content, metadata)).metadata.mealTypes).toEqual(['dinner']);
    expect(requestJson).toHaveBeenCalledOnce();
  });
});
