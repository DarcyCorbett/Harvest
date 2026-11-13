import { createHash } from 'node:crypto';
import { z } from '../../functions/node_modules/zod/index.js';
import { buildTagRecipesPrompt, buildReminderFlagsPrompt, buildSubstitutionsPrompt, buildShoppingGroupsPrompt } from '../../functions/src/ai/prompts';
import { tagRecipesResponse, reminderFlagsResponse, substitutionsResponse, shoppingGroupsResponse } from '../../functions/src/ai/contracts';
import { buildTaxonomyV2Prompt, TAXONOMY_V2_RESPONSE_JSON_SCHEMA, parseAndDeriveTaxonomyV2 } from '../../functions/src/catalogue/taxonomyV2';
import { CUISINES, type CompleteCanonicalRecipeV2, type RecipeMetadata } from '../../functions/src/catalogue/domain';
import { groupShoppingRequirements } from '../../functions/src/connected/shoppingGrouping';
import type { Requirement } from '../../functions/src/connected/model';

export const SEED = 'mealwizard-ai-stack-2026-10-10-v1';
export const TASKS = ['taxonomy', 'cuisine', 'tags', 'reminders', 'substitutions', 'shopping'] as const;
export type Task = typeof TASKS[number];
export type Provider = 'gemini' | 'openai' | 'anthropic';
export const PROVIDERS: Provider[] = ['gemini', 'anthropic', 'openai'];
export const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface Recipe { id: string; source: { key: string; canonicalUrl: string }; content: CompleteCanonicalRecipeV2['content']; sourceMetadata?: RecipeMetadata; }
export interface Case { id: string; task: Task; recipeIds: string[]; input: any; prompt: string; schema?: object; baselineMax: number; requirements?: Requirement[]; }
export interface Reference { expected?: any; acceptable?: any[]; rationale: string; ambiguous: boolean; rubric?: any; }
export interface Usage { input: number; cached: number; cacheWrite: number; output: number; reasoning: number; }
export const PRICES = {
  'gpt-6-luna': { input: .10, cached: .01, cacheWrite: .125, output: .50 },
  'claude-haiku-5-5': { input: .10, cached: .01, cacheWrite: .125, output: .50 },
  'gemini-3.1-flash-lite': { input: .25, cached: .025, cacheWrite: .25, output: 1.50 },
  'gemini-3.8-flash': { input: .75, cached: .075, cacheWrite: .75, output: 3.75 },
};
export type Model = keyof typeof PRICES;
export const PRICING_SOURCES = { checkedOn: '2026-10-10', openai: 'https://developers.openai.com/api/docs/pricing', anthropic: 'https://www.anthropic.com/claude-haiku-5-5', gemini: 'https://ai.google.dev/gemini-api/docs/pricing' };
export function cost(model: Model, usage: Usage) {
  const p = PRICES[model];
  // Normalized input includes cache hits/writes; output already includes reasoning.
  return (Math.max(0, usage.input - usage.cached - usage.cacheWrite) * p.input + usage.cached * p.cached + usage.cacheWrite * p.cacheWrite + usage.output * p.output) / 1e6;
}
export function config(provider: Provider, c: Case, effort?: string) {
  const model: Model = provider === 'openai' ? 'gpt-6-luna' : provider === 'anthropic' ? 'claude-haiku-5-5' : c.task === 'shopping' ? 'gemini-3.8-flash' : 'gemini-3.1-flash-lite';
  return { provider, model, effort: effort ?? (provider === 'gemini' ? ['taxonomy', 'cuisine'].includes(c.task) ? 'minimal' : 'default' : c.task === 'shopping' ? 'high' : 'medium'), maxOutputTokens: provider === 'gemini' ? c.baselineMax : c.task === 'shopping' ? 16384 : 8192 };
}
export function makeRequest(provider: Provider, c: Case, effort?: string) {
  const cfg = config(provider, c, effort);
  const prompt = provider === 'gemini' ? c.prompt : `${c.prompt}${c.schema ? `\nRequired JSON schema:\n${JSON.stringify(c.schema)}` : ''}\nReturn only raw JSON. No Markdown, code fences, or commentary.`;
  if (provider === 'openai') return { cfg, url: 'https://api.openai.com/v1/responses', body: { model: cfg.model, input: prompt, reasoning: { effort: cfg.effort }, max_output_tokens: cfg.maxOutputTokens, store: false, service_tier: 'default', ...(c.task === 'shopping' ? {} : { text: { format: { type: 'json_object' } } }) } };
  if (provider === 'anthropic') return { cfg, url: 'https://api.anthropic.com/v1/messages', body: { model: cfg.model, max_tokens: cfg.maxOutputTokens, thinking: { type: 'adaptive' }, output_config: { effort: cfg.effort }, messages: [{ role: 'user', content: prompt }] } };
  return { cfg, url: `https://generativelanguage.googleapis.com/v1beta/models/${cfg.model}:generateContent`, body: { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { ...(c.task === 'shopping' ? {} : { temperature: 0 }), maxOutputTokens: cfg.maxOutputTokens, responseMimeType: 'application/json', ...(c.schema ? { responseJsonSchema: c.schema } : {}), ...(cfg.effort !== 'default' ? { thinkingConfig: { thinkingLevel: cfg.effort } } : {}) } } };
}
export function reservation(request: ReturnType<typeof makeRequest>) {
  // A UTF-8 byte upper bound plus framing allowance, no cache discount.
  const bytes = Buffer.byteLength(JSON.stringify(request.body), 'utf8') + 4096;
  if (bytes > 95_000) throw new Error('Request exceeds conservative short-context budget');
  return cost(request.cfg.model, { input: bytes, cached: 0, cacheWrite: 0, output: request.cfg.maxOutputTokens, reasoning: 0 });
}
export function canReserve(spent: number, amount: number, cap = 4.5) { return Number.isFinite(amount) && amount > 0 && spent + amount <= cap; }
const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
export function parseEnvelope(provider: Provider, body: any): { text: string; usage: Usage | null; complete: boolean; returnedModel?: string; requestId?: string } {
  if (provider === 'openai') {
    const u = body.usage;
    return { text: (body.output ?? []).filter((o: any) => o.type === 'message').flatMap((o: any) => o.content ?? []).filter((p: any) => p.type === 'output_text').map((p: any) => p.text).join(''), usage: u && typeof u.input_tokens === 'number' && typeof u.output_tokens === 'number' ? { input: num(u.input_tokens), cached: num(u.input_tokens_details?.cached_tokens), cacheWrite: 0, output: num(u.output_tokens), reasoning: num(u.output_tokens_details?.reasoning_tokens) } : null, complete: body.status === 'completed', returnedModel: body.model, requestId: body.id };
  }
  if (provider === 'anthropic') {
    const u = body.usage;
    return { text: (body.content ?? []).filter((p: any) => p.type === 'text').map((p: any) => p.text).join(''), usage: u && typeof u.input_tokens === 'number' && typeof u.output_tokens === 'number' ? { input: num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens), cached: num(u.cache_read_input_tokens), cacheWrite: num(u.cache_creation_input_tokens), output: num(u.output_tokens), reasoning: 0 } : null, complete: body.stop_reason === 'end_turn', returnedModel: body.model, requestId: body.id };
  }
  const u = body.usageMetadata;
  return { text: (body.candidates?.[0]?.content?.parts ?? []).filter((p: any) => typeof p.text === 'string' && p.thought !== true).map((p: any) => p.text).join(''), usage: u && typeof u.promptTokenCount === 'number' && typeof u.candidatesTokenCount === 'number' ? { input: num(u.promptTokenCount), cached: num(u.cachedContentTokenCount), cacheWrite: 0, output: num(u.candidatesTokenCount) + num(u.thoughtsTokenCount), reasoning: num(u.thoughtsTokenCount) } : null, complete: body.candidates?.[0]?.finishReason === 'STOP', returnedModel: body.modelVersion, requestId: body.responseId };
}
export function redact(text: string, secrets: string[] = []) {
  for (const secret of secrets.filter(Boolean)) text = text.split(secret).join('[REDACTED]');
  return text.replace(/sk-(?:ant-)?[A-Za-z0-9_-]{12,}/g, '[REDACTED]').replace(/AIza[A-Za-z0-9_-]{20,}/g, '[REDACTED]');
}
export function validateOutput(c: Case, value: any): any {
  if (c.task === 'taxonomy') return parseAndDeriveTaxonomyV2(value).derived;
  if (c.task === 'cuisine') return z.object({ cuisines: z.array(z.enum(CUISINES)).min(1).max(CUISINES.length) }).strict().parse(value);
  if (c.task === 'substitutions') return substitutionsResponse.parse(value);
  if (c.task === 'shopping') {
    const groups = shoppingGroupsResponse.parse(value);
    const ids = groups.flatMap(g => g.sourceIds).sort((a, b) => a - b);
    if (JSON.stringify(ids) !== JSON.stringify(c.input.map((x: any) => x.id).sort((a: number, b: number) => a - b))) throw new Error('Ingredient ID coverage mismatch');
    return groups;
  }
  const parsed = c.task === 'tags' ? tagRecipesResponse.parse(value) : reminderFlagsResponse.parse(value);
  if (parsed.results.length !== 1 || parsed.results[0].id !== c.input[0].recipeId) throw new Error('Recipe ID coverage mismatch');
  return parsed.results[0];
}
export function labels(c: Case, value: any): string[] {
  if (c.task === 'taxonomy') return [...value.mealTypes, ...(value.healthy ? ['healthy'] : []), ...(value.kidFriendly ? ['kid-friendly'] : [])];
  if (c.task === 'cuisine') return value.cuisines;
  if (c.task === 'tags') return value.tags;
  if (c.task === 'reminders') return ['needsDefrost', 'needsMarinate'].filter(k => value[k]);
  return [];
}
export function pairs(groups: any[]) {
  const result = new Set<string>();
  for (const g of groups) for (const a of g.sourceIds) for (const b of g.sourceIds) if (a < b) result.add(`${a}:${b}`);
  return result;
}
export function prf(expected: Set<string>, actual: Set<string>) {
  const tp = [...actual].filter(x => expected.has(x)).length, fp = actual.size - tp, fn = expected.size - tp;
  const precision = actual.size ? tp / actual.size : expected.size ? 0 : 1;
  const recall = expected.size ? tp / expected.size : 1;
  return { tp, fp, fn, precision, recall, f1: precision + recall ? 2 * precision * recall / (precision + recall) : 0, exact: fp === 0 && fn === 0 };
}
export async function verifyShopping(c: Case, groups: any[]) {
  const result = await groupShoppingRequirements('local-evaluation', c.requirements!, async () => groups);
  const contributions = (rows: Requirement[]) => rows.flatMap(r => r.contributions).map(x => JSON.stringify(x)).sort();
  const conserved = JSON.stringify(contributions(c.requirements!)) === JSON.stringify(contributions(result.requirements));
  const totalByUnit = (rows: Requirement[]) => rows.reduce<Record<string, number>>((out, r) => { out[r.unit] = (out[r.unit] ?? 0) + r.quantity; return out; }, {});
  const a = totalByUnit(c.requirements!), b = totalByUnit(result.requirements);
  const quantities = Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => Math.abs(a[k] - b[k]) <= 1e-8 * Math.max(1, a[k]));
  return { conserved: conserved && quantities, finalRequirements: result.requirements };
}
export function recipeInput(r: Recipe) {
  return { recipeId: r.id, title: r.content.title.slice(0, 160), totalMinutes: null, ingredients: r.content.ingredients.slice(0, 100).map(i => i.name.slice(0, 200)), steps: r.content.instructions.slice(0, 40).map(s => s.text.slice(0, 300)), existingTags: [] };
}
export function recipeCase(task: Task, r: Recipe, index = 0): Case {
  const common = { id: `${task}-${r.id}`, task, recipeIds: [r.id] };
  const input = recipeInput(r);
  if (task === 'taxonomy') return { ...common, input: r.content, prompt: buildTaxonomyV2Prompt(r.content), schema: TAXONOMY_V2_RESPONSE_JSON_SCHEMA, baselineMax: 2048 };
  if (task === 'tags') return { ...common, input: [input], prompt: buildTagRecipesPrompt([input]), baselineMax: 4496 };
  if (task === 'reminders') { const { totalMinutes, existingTags, ...reminder } = input; return { ...common, input: [reminder], prompt: buildReminderFlagsPrompt([reminder]), baselineMax: 1224 }; }
  if (task === 'cuisine') return { ...common, input: { title: r.content.title, ingredients: input.ingredients }, prompt: ['Classify only the cuisine of this recipe using the allowed JSON values.', `cuisines: ${CUISINES.join(', ')}`, `Title: ${r.content.title.slice(0, 200)}`, `Ingredients: ${r.content.ingredients.map(i => i.name).join(', ').slice(0, 2000)}`, 'Return JSON with a cuisines array containing at least one value and no other fields.'].join('\n'), schema: { type: 'object', additionalProperties: false, required: ['cuisines'], properties: { cuisines: { type: 'array', minItems: 1, items: { type: 'string', enum: CUISINES } } } }, baselineMax: 256 };
  const i = r.content.ingredients[index];
  const sub = { ingredientName: i.name.slice(0, 120), ingredientUnit: (i.unit ?? '').slice(0, 40), recipeTitle: r.content.title.slice(0, 200), allIngredients: r.content.ingredients.slice(0, 100).map(x => x.name.slice(0, 120)) };
  return { ...common, input: sub, prompt: buildSubstitutionsPrompt(sub), baselineMax: 600 };
}
export { buildShoppingGroupsPrompt };
