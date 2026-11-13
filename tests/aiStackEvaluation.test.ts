import { describe, it, expect } from 'vitest';
import { parseEnvelope, cost, reservation, makeRequest, canReserve, redact, validateOutput, prf, pairs, verifyShopping, recipeCase, type Case } from '../scripts/lib/aiEvaluationCore';
import { balances, resumeDisposition } from '../scripts/evaluate-ai-stack';
import { callProvider } from '../scripts/lib/aiEvaluationProviders';
import { scoreRows } from '../scripts/lib/aiEvaluationReport';
import { request35, reserve35, cost35, jobs35 } from '../scripts/evaluate-gemini35';

const shopping: Case = { id: 's', task: 'shopping', recipeIds: [], input: [{ id: 0, name: 'onion', quantity: 2, unit: '' }, { id: 1, name: 'onions', quantity: 3, unit: '' }], prompt: 'Group ingredients. Return JSON array.', baselineMax: 5000, requirements: [
  { id: 'a', name: 'onion', quantity: 2, unit: '', category: 'Produce', contributions: [{ sourceId: 'one', mealId: 'm', recipeId: 'r', title: 'Recipe', quantity: 2 }] },
  { id: 'b', name: 'onions', quantity: 3, unit: '', category: 'Produce', contributions: [{ sourceId: 'two', mealId: 'm', recipeId: 'r', title: 'Recipe', quantity: 3 }] },
] };
describe('AI stack evaluation controls', () => {
  it('keeps the 3.5 extension request separate from the frozen Gemini baseline', () => {
    const baseline=makeRequest('gemini',shopping), before=JSON.stringify(baseline), extension=request35(shopping);
    expect(extension.url).toContain('gemini-3.5-flash-lite:generateContent');
    expect(extension.body.generationConfig.maxOutputTokens).toBe(16384);
    expect(extension.body.generationConfig.thinkingConfig.thinkingLevel).toBe('high');
    expect(JSON.stringify(makeRequest('gemini',shopping))).toBe(before);
    expect(()=>request35(shopping,'xhigh')).toThrow();
    expect(reserve35(extension)).toBeGreaterThan(.04096);
    expect(cost35({input:1000,cached:200,cacheWrite:0,output:2000,reasoning:1500})).toBeCloseTo(.005246,8);
  });
  it('uses the same fixed subset and cumulative Gemini budget for the extension', () => {
    const cs=Array.from({length:10},(_,i)=>({...shopping,id:String(i)}));
    expect(jobs35(cs,'pilot')).toHaveLength(3);
    expect(jobs35(cs,'repeat').map(j=>[j.c.id,j.repeat])).toEqual([['0',1],['0',2],['5',1],['5',2]]);
    const total=balances([{type:'settle',provider:'gemini',attemptId:'old',usd:.73},{type:'reserve',provider:'gemini',attemptId:'new',usd:3.75}]).gemini;
    expect(canReserve(total,.03)).toBe(false);
  });
  it('dispatches a prepared Gemini extension to its exact model endpoint', async () => {
    let url='';const req=request35(shopping);
    const r=await callProvider('gemini',shopping,'fake',[],undefined,(async(u:any)=>{url=u;return new Response(JSON.stringify({candidates:[{finishReason:'STOP',content:{parts:[{text:'[]'}]}}],usageMetadata:{promptTokenCount:10,candidatesTokenCount:5}}));})as typeof fetch,req);
    expect(url).toBe(req.url);expect(r.complete).toBe(true);
  });
  it('counts OpenAI reasoning once and caches at the discounted rate', () => {
    const p = parseEnvelope('openai', { status: 'completed', output: [{ type: 'reasoning', content: [{ text: 'secret thought' }] }, { type: 'message', content: [{ type: 'output_text', text: '{"x":1}' }] }], usage: { input_tokens: 1000, output_tokens: 2000, input_tokens_details: { cached_tokens: 200 }, output_tokens_details: { reasoning_tokens: 1500 } } });
    expect(p.text).toBe('{"x":1}'); expect(p.usage?.output).toBe(2000); expect(cost('gpt-6-luna', p.usage!)).toBeCloseTo(.001082, 8);
  });
  it('adds Gemini thinking and excludes thought parts from the answer', () => {
    const p = parseEnvelope('gemini', { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ thought: true, text: 'thinking' }, { text: '[]' }] } }], usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 20, thoughtsTokenCount: 100 } });
    expect(p.usage?.output).toBe(120); expect(p.text).toBe('[]'); expect(p.complete).toBe(false);
  });
  it('normalizes Anthropic cache read and write accounting', () => {
    const p = parseEnvelope('anthropic', { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: '{}' }], usage: { input_tokens: 100, output_tokens: 200, cache_read_input_tokens: 300, cache_creation_input_tokens: 400 } });
    expect(p.usage?.input).toBe(800); expect(cost('claude-haiku-5-5', p.usage!)).toBeCloseTo(.000163, 8);
  });
  it('does not treat absent usage as zero cost', () => expect(parseEnvelope('openai', {}).usage).toBeNull());
  it('reserves before dispatch and retains unknown interrupted charges on resume', () => {
    expect(canReserve(4.49, .02)).toBe(false);
    const j = [{ type: 'reserve', provider: 'openai', attemptId: 'a', usd: .02 }, { type: 'settle', provider: 'openai', attemptId: 'a', usd: .001 }, { type: 'reserve', provider: 'openai', attemptId: 'b', usd: .03 }];
    expect(balances(j).openai).toBeCloseTo(.031); expect(reservation(makeRequest('openai', shopping))).toBeGreaterThan(.008192);
  });
  it('uses a JSON array-compatible OpenAI request for shopping', () => expect(makeRequest('openai', shopping).body).not.toHaveProperty('text'));
  it('never redispatches completed or interrupted jobs when resuming', () => {
    const events = [{ type: 'reserve', jobId: 'pending' }, { type: 'settle', jobId: 'pending' }, { type: 'reserve', jobId: 'complete' }, { type: 'result', jobId: 'complete', valid: false }];
    expect(resumeDisposition(events, 'pending')).toBe('unresolved');
    expect(resumeDisposition(events, 'complete')).toBe('completed');
    expect(resumeDisposition(events, 'new')).toBe('new');
  });
  it('rejects missing, duplicated, and invented shopping identifiers', () => {
    for (const ids of [[0], [0, 0], [0, 2]]) expect(() => validateOutput(shopping, [{ canonicalName: 'onion', category: 'Produce', sourceIds: ids }])).toThrow();
  });
  it('enforces exactly three substitutions and rejects extra fields', () => {
    const c = { ...shopping, task: 'substitutions' } as Case;
    expect(() => validateOutput(c, { substitutions: [] })).toThrow();
    expect(() => validateOutput(c, { substitutions: Array(3).fill({ name: 'a', adjustment: '1:1', reason: 'Works', invented: true }) })).toThrow();
  });
  it('scores false merges and missed merges without counting true negatives', () => {
    const a = [{ sourceIds: [0, 1] }, { sourceIds: [2] }], b = [{ sourceIds: [0, 1, 2] }];
    expect(prf(pairs(a), pairs(b)).precision).toBeCloseTo(1 / 3); expect(prf(pairs(a), pairs(b)).recall).toBe(1);
    expect(prf(pairs(a), new Set()).f1).toBe(0);
  });
  it('preserves per-source quantities and contributions through actual shopping code', async () => {
    const r = await verifyShopping(shopping, [{ canonicalName: 'onion', category: 'Produce', sourceIds: [0, 1] }]);
    expect(r.conserved).toBe(true); expect(r.finalRequirements[0].quantity).toBe(5); expect(r.finalRequirements[0].contributions).toHaveLength(2);
  });
  it('redacts supplied secrets as well as recognizable key patterns', () => expect(redact('abc secret-value sk-ant-abcdefghijklmnop', ['secret-value'])).toBe('abc [REDACTED] [REDACTED]'));
  it('redacts provider error echoes and sends keys only in headers', async () => {
    let received: any;
    const response = await callProvider('openai', shopping, 'test-secret', ['test-secret'], undefined, (async (_url: any, init: any) => { received = init; return new Response(JSON.stringify({ error: { message: 'Rejected test-secret' } }), { status: 401 }); }) as typeof fetch);
    expect(received.headers.Authorization).toBe('Bearer test-secret'); expect(received.body).not.toContain('test-secret'); expect(response.error).toBe('Rejected [REDACTED]'); expect(response.usage).toBeNull();
  });
  it('keeps timeouts chargeable as unknown usage', async () => {
    const response = await callProvider('anthropic', shopping, 'fake', [], undefined, (async () => { throw new Error('timeout'); }) as typeof fetch);
    expect(response.httpStatus).toBe(0); expect(response.usage).toBeNull(); expect(response.complete).toBe(false);
  });
  it('counts invalid answers as exact-match failures even for all-false references', () => {
    const c = { ...shopping, task: 'reminders' } as Case;
    const m = scoreRows([c], { s: { expected: { needsDefrost: false, needsMarinate: false }, rationale: 'No raw protein or marinade', ambiguous: false } }, [{ caseId: 's', valid: false }]);
    expect(m.exactMatch).toBe(0);
  });
  it('counts negative tag cases in the per-label confusion matrix', () => {
    const cs = ['one', 'two'].map(id => ({ ...shopping, id, task: 'tags' } as Case));
    const refs = Object.fromEntries(cs.map(c => [c.id, { expected: { tags: ['Dinner'] }, rationale: 'Dinner only', ambiguous: false }]));
    const m = scoreRows(cs, refs, [{ caseId: 'one', valid: true, value: { tags: ['Dinner', 'Healthy'] } }, { caseId: 'two', valid: true, value: { tags: ['Dinner'] } }]);
    expect(m.perLabel.Healthy.falsePositiveRate).toBe(.5);
    expect(m.perLabel.Healthy.tn).toBe(1);
  });
});
