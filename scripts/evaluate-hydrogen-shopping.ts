import fs from 'node:fs';
import path from 'node:path';

import { requestGeminiJson, type GeminiUsage } from '../functions/src/ai/geminiProvider';
import { SHOPPING_MODEL } from '../functions/src/ai/models';
import { canReserve, hash, pairs, prf, validateOutput, verifyShopping, type Case } from './lib/aiEvaluationCore';
import { DIR, read, save } from './lib/aiEvaluationPrepare';
import { loadGeminiKey } from './lib/aiEvaluationProviders';
import { balances, journal } from './evaluate-ai-stack';
import { events35 } from './evaluate-gemini35';
import { eventsDecision1 } from './evaluate-decision1';

// Thinking-level check for the shopping model on the frozen shopping lists,
// using the production request path (requestGeminiJson). Every fifth list by
// default, the same subset the original effort sweep used.
//
//   node node_modules/tsx/dist/cli.mjs scripts/evaluate-hydrogen-shopping.ts run low medium [--all]
//   node node_modules/tsx/dist/cli.mjs scripts/evaluate-hydrogen-shopping.ts report
const SUBDIR = 'gemini-4-hydrogen';
const PRICE = { input: 1.5, output: 7.5, checkedOn: '2026-11-14', source: 'https://aistudio.google.com/docs/whats-new-gemini-4-hydrogen' };
const MAX_OUTPUT_TOKENS = 65_536;
const ledgerPath = path.join(DIR, SUBDIR, 'ledger.jsonl');
const lines = (file: string): any[] =>
  fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((x) => JSON.parse(x)) : [];
const events = () => lines(ledgerPath);
const otherDecisionEvents = () =>
  fs.readdirSync(DIR).filter((d) => /^gemini-decision-1-v\d+$/.test(d)).flatMap((d) => lines(path.join(DIR, d, 'ledger.jsonl')));
const append = (row: unknown) => {
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.appendFileSync(ledgerPath, `${JSON.stringify(row)}\n`);
};
const usd = (u: GeminiUsage) => (u.promptTokenCount * PRICE.input + Math.max(0, u.totalTokenCount - u.promptTokenCount) * PRICE.output) / 1e6;

async function run(levels: string[], all: boolean) {
  const dataset = read('dataset.json');
  const cases = (dataset.cases as Case[]).filter((c) => c.task === 'shopping').filter((_, i) => all || i % 5 === 0);
  const key = await loadGeminiKey();
  const committed = () => balances([...journal(), ...events35(), ...eventsDecision1(), ...otherDecisionEvents(), ...events()]).gemini;
  for (const level of levels) {
    if (!['low', 'medium', 'high'].includes(level)) throw new Error(`Unsupported thinking level ${level}`);
    for (const c of cases) {
      const jobId = hash([SHOPPING_MODEL, level, c.id, hash(c.prompt)]);
      if (events().some((e) => e.type === 'result' && e.jobId === jobId)) continue;
      const reserve = (Buffer.byteLength(c.prompt, 'utf8') * PRICE.input + MAX_OUTPUT_TOKENS * PRICE.output) / 1e6;
      if (!canReserve(committed(), reserve)) {
        console.log(JSON.stringify({ stopped: 'spend cap', committedGeminiUsd: committed() }));
        return;
      }
      const attemptId = `${jobId}-0`;
      append({ type: 'reserve', provider: 'gemini', jobId, attemptId, usd: reserve, at: new Date().toISOString() });
      const started = performance.now();
      let usage: GeminiUsage | undefined;
      let value: unknown;
      let shopping: unknown;
      let error: string | undefined;
      try {
        const raw = await requestGeminiJson({
          apiKey: key, model: SHOPPING_MODEL, prompt: c.prompt, maxOutputTokens: MAX_OUTPUT_TOKENS,
          thinkingLevel: level as 'low' | 'medium' | 'high', timeoutMs: 180_000, onUsage: (u) => { usage = u; },
        });
        value = validateOutput(c, raw);
        shopping = await verifyShopping(c, value as any[]);
      } catch (e) {
        error = e instanceof Error ? e.message.slice(0, 300) : 'failed';
      }
      const latencyMs = performance.now() - started;
      // Unknown usage keeps the reservation unless the call was rejected outright.
      const amount = usage ? usd(usage) : /provider-http-4/.test(error ?? '') ? 0 : reserve;
      append({ type: 'settle', provider: 'gemini', jobId, attemptId, usd: amount, measured: !!usage, at: new Date().toISOString() });
      append({ type: 'result', jobId, caseId: c.id, task: 'shopping', level, model: SHOPPING_MODEL, valid: !error, validationError: error, value, shopping, latencyMs, usd: amount, usage, at: new Date().toISOString() });
      console.log(JSON.stringify({ level, caseId: c.id, valid: !error, error, seconds: +(latencyMs / 1000).toFixed(1), usd: +amount.toFixed(4), committedGeminiUsd: +committed().toFixed(4) }));
    }
  }
}

function report() {
  const benchmark = read('benchmark.json');
  const fablePath = path.join(DIR, 'claude-fable-5-2', 'answers.json');
  const fable = fs.existsSync(fablePath) ? JSON.parse(fs.readFileSync(fablePath, 'utf8')) : null;
  const baseline = journal().filter((r) => r.type === 'result' && r.task === 'shopping' && r.provider === 'gemini' && r.repeat === 0 && ['main', 'pilot'].includes(r.phase));
  const rows = events().filter((e) => e.type === 'result');
  const summarize = (label: string, list: any[]) => {
    const f1 = (r: any, expected: any[]) => (r.valid ? prf(pairs(expected), pairs(r.value)).f1 : 0);
    const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
    const sorted = list.map((r) => r.latencyMs).sort((a, b) => a - b);
    return {
      label, lists: list.length, valid: list.filter((r) => r.valid).length,
      pairF1VsAstra: avg(list.map((r) => f1(r, benchmark.references[r.caseId].expected))),
      pairF1VsFable: fable ? avg(list.map((r) => f1(r, fable[r.caseId].value))) : null,
      conserved: avg(list.map((r) => Number(!!r.shopping?.conserved))),
      medianSeconds: sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] / 1000 : null,
      maxSeconds: sorted.length ? sorted[sorted.length - 1] / 1000 : null,
      usdPer1000: avg(list.map((r) => r.usd)) === null ? null : avg(list.map((r) => r.usd))! * 1000,
    };
  };
  const out: any[] = [];
  for (const level of [...new Set(rows.map((r) => r.level))]) {
    const mine = rows.filter((r) => r.level === level);
    const ids = new Set(mine.map((r) => r.caseId));
    out.push(summarize(`${SHOPPING_MODEL} ${level}`, mine));
    out.push(summarize(`gemini-3.8-flash (previous model, same ${ids.size} lists)`, baseline.filter((r) => ids.has(r.caseId))));
  }
  save(`${SUBDIR}/report.json`, { generatedAt: new Date().toISOString(), price: PRICE, summary: out });
  const pct = (n: number | null) => (n === null ? '—' : `${(n * 100).toFixed(1)}%`);
  console.log('| Model and level | Lists | Valid | Pair F1 vs Astra | Pair F1 vs Fable | Conserved | Median / max s | Cost / 1,000 |');
  console.log('|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const r of out) console.log(`| ${r.label} | ${r.lists} | ${r.valid} | ${pct(r.pairF1VsAstra)} | ${pct(r.pairF1VsFable)} | ${pct(r.conserved)} | ${r.medianSeconds?.toFixed(1)} / ${r.maxSeconds?.toFixed(1)} | $${r.usdPer1000?.toFixed(2)} |`);
}

const [stage, ...rest] = process.argv.slice(2);
(async () => {
  if (stage === 'run') await run(rest.filter((x) => !x.startsWith('--')), rest.includes('--all'));
  else if (stage === 'report') report();
  else throw new Error('Use run <levels...> [--all] or report');
})().catch((e) => {
  console.error(e instanceof Error ? e.message : 'Evaluation failed');
  process.exitCode = 1;
});
