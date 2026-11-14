import fs from 'node:fs';
import path from 'node:path';

import { SEED, canReserve, hash, labels, prf, recipeCase, redact, type Case, type Recipe } from './lib/aiEvaluationCore';
import {
  DECISION_ENDPOINT,
  DECISION_MODEL,
  DECISION_PRICE,
  supportsDecision1,
  type DecisionApiResponse,
} from './lib/aiEvaluationDecision1';
import {
  THRESHOLDS_V2,
  buildDecisionRequestV2,
  composeDecisionOutputV2,
} from './lib/aiEvaluationDecision1V2';
import { DIR, read, save } from './lib/aiEvaluationPrepare';
import { loadGeminiKey } from './lib/aiEvaluationProviders';
import { scoreRows } from './lib/aiEvaluationReport';
import { balances, journal, resumeDisposition, validateBenchmark } from './evaluate-ai-stack';
import { events35 } from './evaluate-gemini35';
import { costDecision1, eventsDecision1, reserveDecision1 } from './evaluate-decision1';

// gemini-decision-1 with the v2 question set. Kept apart from the frozen v1
// extension: own directory, ledger and manifest; v1 spend still counts toward
// the shared Gemini cap.
//
//   dev     tuning half only (question wording and cut-offs are chosen here)
//   run     freezes the manifest, then all cases plus two repeats of every fifth
//   fresh   cases from <SUBDIR>/fresh/dataset.json (recipes outside the benchmark)
//   try     "<title text>" [count]: label matching recipes from source-pool.json and print them
//   report  holdout-half scores are the headline; tuning-half scores are shown apart
export const SUBDIR_V2 = 'gemini-decision-1-v2';
const ledgerPath = () => path.join(DIR, SUBDIR_V2, 'ledger.jsonl');

export const eventsDecision1V2 = (): any[] =>
  fs.existsSync(ledgerPath())
    ? fs.readFileSync(ledgerPath(), 'utf8').trim().split('\n').filter(Boolean).map((x) => JSON.parse(x))
    : [];

/** Deterministic recipe-level split, so one recipe's three tasks stay together. */
export const isTuningCase = (c: Case): boolean =>
  parseInt(hash([SEED, 'decision-1-v2-split', c.recipeIds[0]]).slice(0, 8), 16) % 2 === 0;

/** A job is identified by the exact request, so unchanged requests are never re-billed. */
export const jobIdV2 = (c: Case, repeat: number): string => hash([hash(buildDecisionRequestV2(c)), c.id, repeat]);

const append = (row: unknown): void => {
  fs.mkdirSync(path.join(DIR, SUBDIR_V2), { recursive: true });
  const fd = fs.openSync(ledgerPath(), 'a');
  try {
    fs.writeSync(fd, `${JSON.stringify(row)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
};

async function call(body: unknown, key: string) {
  const start = performance.now();
  const failed = (httpStatus: number, error: string) => ({
    httpStatus, error, latencyMs: performance.now() - start, inputTokens: null as number | null, outputTokens: 0, answers: null,
  });
  try {
    const response = await fetch(DECISION_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
      redirect: 'error',
    });
    const text = await response.text();
    let parsed: DecisionApiResponse;
    try {
      parsed = JSON.parse(text) as DecisionApiResponse;
    } catch {
      return failed(response.status, 'Non-JSON provider envelope');
    }
    return {
      httpStatus: response.status,
      error: response.ok ? undefined : redact(String(parsed.error?.message ?? `HTTP ${response.status}`), [key]).slice(0, 600),
      latencyMs: performance.now() - start,
      inputTokens: typeof parsed.usage?.total_input_tokens === 'number' ? parsed.usage.total_input_tokens : null,
      outputTokens: parsed.usage?.total_output_tokens ?? 0,
      answers: parsed.answers ?? null,
    };
  } catch {
    return failed(0, 'Network failure or timeout; billing unknown');
  }
}

type Job = { c: Case; repeat: number };

async function runJobs(batch: Job[], phase: string) {
  const lock = path.join(DIR, 'run.lock');
  const fd = fs.openSync(lock, 'wx');
  fs.writeSync(fd, String(process.pid));
  fs.closeSync(fd);
  try {
    const earlier = [...journal(), ...events35(), ...eventsDecision1()];
    const events = eventsDecision1V2();
    const committed = () => balances([...earlier, ...events]).gemini;
    const key = await loadGeminiKey();
    let stopped = false;
    let completed = 0;

    async function worker(lane: number) {
      for (const job of batch.filter((_, i) => i % 2 === lane)) {
        const id = jobIdV2(job.c, job.repeat);
        if (stopped || resumeDisposition(events, id) !== 'new') continue;
        const request = buildDecisionRequestV2(job.c);
        const reserve = reserveDecision1(request);
        let last: Awaited<ReturnType<typeof call>> | undefined;
        let usd = 0;
        let latencyMs = 0;
        for (let attempt = 0; attempt < 2; attempt++) {
          if (!canReserve(committed(), reserve)) {
            stopped = true;
            break;
          }
          const attemptId = `${id}-${attempt}`;
          const reservation = { type: 'reserve', provider: 'gemini', jobId: id, attemptId, usd: reserve, at: new Date().toISOString() };
          append(reservation);
          events.push(reservation);
          last = await call(request, key);
          const amount = last.inputTokens !== null
            ? costDecision1(last.inputTokens)
            : [400, 401, 403, 404, 422, 429].includes(last.httpStatus) ? 0 : reserve;
          const settled = {
            type: 'settle', provider: 'gemini', jobId: id, attemptId, usd: amount, measured: last.inputTokens !== null,
            response: { ...last, answers: undefined }, at: new Date().toISOString(),
          };
          append(settled);
          events.push(settled);
          usd += amount;
          latencyMs += last.latencyMs;
          if (![0, 429, 500, 502, 503, 504, 529].includes(last.httpStatus) || attempt === 1) break;
          await new Promise((r) => setTimeout(r, 1500));
        }
        if (!last) continue;
        const result = {
          type: 'result', jobId: id, caseId: job.c.id, task: job.c.task, phase, repeat: job.repeat, model: DECISION_MODEL,
          requestHash: hash(request), answers: last.answers, error: last.error, latencyMs, usd,
          usage: last.inputTokens !== null ? { input: last.inputTokens, output: last.outputTokens } : null,
          at: new Date().toISOString(),
        };
        append(result);
        events.push(result);
        completed++;
        if (completed % 25 === 0 || last.error) {
          console.log(JSON.stringify({ phase, completed, task: job.c.task, error: last.error, committedGeminiUsd: committed() }));
        }
        if ([400, 401, 403, 404, 422].includes(last.httpStatus)) stopped = true;
      }
    }

    const workers = await Promise.allSettled([worker(0), worker(1)]);
    for (const w of workers) if (w.status === 'rejected') throw w.reason;
    const state = {
      phase,
      scheduled: batch.length,
      completed: batch.filter((j) => resumeDisposition(events, jobIdV2(j.c, j.repeat)) === 'completed').length,
      committedGeminiUsd: committed(),
      stopped,
      completedAt: new Date().toISOString(),
    };
    save(`${SUBDIR_V2}/phase-${phase}.json`, state);
    console.log(JSON.stringify(state));
    return state;
  } finally {
    fs.unlinkSync(lock);
  }
}

/** Rows for the current question set, composed with the current cut-offs. */
export function composedRows(cases: Case[], repeat = 0, thresholds = THRESHOLDS_V2): any[] {
  const byJob = new Map<string, any>();
  for (const e of eventsDecision1V2()) if (e.type === 'result') byJob.set(e.jobId, e);
  return cases.flatMap((c) => {
    if (!supportsDecision1(c.task)) return [];
    const r = byJob.get(jobIdV2(c, repeat));
    if (!r) return [];
    let value: unknown;
    let validationError: string | undefined;
    try {
      if (r.error || !r.answers) throw new Error(r.error ?? 'Missing answers');
      value = composeDecisionOutputV2(c, r.answers, thresholds[c.task as 'taxonomy' | 'tags' | 'reminders']);
    } catch (e) {
      validationError = e instanceof Error ? e.message.slice(0, 500) : 'Invalid output';
    }
    return [{ ...r, value, valid: !validationError, validationError }];
  });
}

const manifestOf = (cases: Case[]) => ({
  model: DECISION_MODEL,
  endpoint: DECISION_ENDPOINT,
  version: 2,
  datasetHash: hash(read('dataset.json')),
  benchmarkHash: hash(read('benchmark.json')),
  price: DECISION_PRICE,
  capUsd: 4.5,
  thresholds: THRESHOLDS_V2,
  split: 'recipe-level hash split; cut-offs and wording chosen on the tuning half only',
  requests: cases.filter((c) => supportsDecision1(c.task)).map((c) => ({ caseId: c.id, tuning: isTuningCase(c), hash: hash(buildDecisionRequestV2(c)) })),
});

const pct = (n: number | null | undefined) => (n == null ? '—' : `${(n * 100).toFixed(1)}%`);
const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const percentile = (a: number[], p: number) =>
  a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.ceil(p * a.length) - 1)] : null;

function report() {
  const dataset = read('dataset.json');
  const benchmark = read('benchmark.json');
  const cases = dataset.cases as Case[];
  const manifest = read(`${SUBDIR_V2}/manifest.json`);
  if (hash(manifest) !== hash(manifestOf(cases))) throw new Error('Frozen v2 settings changed');
  const v2 = composedRows(cases);
  const v2Repeats = [1, 2].flatMap((n) => composedRows(cases, n));
  const v1 = eventsDecision1().filter((r) => r.type === 'result' && r.repeat === 0);
  const fablePath = path.join(DIR, 'claude-fable-5-2', 'answers.json');
  const fable = fs.existsSync(fablePath) ? JSON.parse(fs.readFileSync(fablePath, 'utf8')) : null;
  const astraAll = Object.fromEntries(Object.entries(benchmark.references).map(([id, ref]: [string, any]) => [id, { ...ref, ambiguous: false }]));
  const fableRefs = fable
    ? Object.fromEntries(Object.entries(fable).filter(([, v]: [string, any]) => v.valid).map(([id, v]: [string, any]) => [id, { expected: v.value, ambiguous: false, rationale: 'claude-fable-5-2 chat-authored' }]))
    : null;

  const summary: any[] = [];
  for (const task of ['taxonomy', 'tags', 'reminders'] as const) {
    for (const half of ['holdout', 'tuning'] as const) {
      const ids = new Set(cases.filter((c) => c.task === task && isTuningCase(c) === (half === 'tuning')).map((c) => c.id));
      for (const [version, rows] of [['v1', v1], ['v2', v2]] as const) {
        const sub = rows.filter((r) => ids.has(r.caseId));
        const a = scoreRows(cases, astraAll as any, sub);
        const clear = scoreRows(cases, benchmark.references, sub);
        const f = fableRefs ? scoreRows(cases, fableRefs as any, sub.filter((r) => fableRefs[r.caseId])) : null;
        summary.push({
          task, half, version, cases: sub.length, valid: sub.filter((r) => r.valid).length,
          vsAstraAll: { macroF1: a.macroF1, exact: a.exactMatch },
          vsAstraClear: { n: clear.evaluatedUnambiguous, macroF1: clear.macroF1, exact: clear.exactMatch },
          vsFable: f && { macroF1: f.macroF1, exact: f.exactMatch, perLabel: f.perLabel },
        });
      }
    }
  }
  const base = v2.filter((r) => r.valid);
  const agreement = v2Repeats.map((r) => {
    const first = v2.find((x) => x.caseId === r.caseId);
    if (!first?.valid || !r.valid) return 0;
    const c = cases.find((x) => x.id === r.caseId)!;
    return Number(prf(new Set(labels(c, first.value)), new Set(labels(c, r.value))).exact);
  });
  const events = eventsDecision1V2();
  const out = {
    generatedAt: new Date().toISOString(),
    model: DECISION_MODEL,
    thresholds: THRESHOLDS_V2,
    measuredUsd: events.filter((e) => e.type === 'settle' && e.measured).reduce((s, e) => s + e.usd, 0),
    committedGeminiUsd: balances([...journal(), ...events35(), ...eventsDecision1(), ...events]).gemini,
    medianMs: percentile(base.map((r) => r.latencyMs), 0.5),
    p95Ms: percentile(base.map((r) => r.latencyMs), 0.95),
    inputTokensPerCase: avg(base.map((r) => r.usage?.input ?? 0)),
    repeatComparisons: agreement.length,
    repeatAgreement: avg(agreement),
    failures: v2.filter((r) => !r.valid).map((r) => ({ caseId: r.caseId, error: r.validationError })),
    summary,
  };
  save(`${SUBDIR_V2}/report.json`, out);
  const line = (r: any) =>
    `| ${r.task} | ${r.half} | ${r.version} | ${r.valid}/${r.cases} | ${pct(r.vsFable?.macroF1)} / ${pct(r.vsFable?.exact)} | ${pct(r.vsAstraAll.macroF1)} / ${pct(r.vsAstraAll.exact)} | ${pct(r.vsAstraClear.macroF1)} / ${pct(r.vsAstraClear.exact)} (n=${r.vsAstraClear.n}) |`;
  const md = [
    '# gemini-decision-1, v2 question set',
    '',
    'Question wording and cut-offs were chosen on the tuning half. The holdout half is the headline.',
    'Macro F1 / exact match. "Fable" is the claude-fable-5-2 chat-authored answer set; "Astra" is benchmark.json.',
    '',
    '| Task | Half | Questions | Valid | vs Fable | vs Astra, all cases | vs Astra, clear cases |',
    '|---|---|---|---:|---:|---:|---:|',
    ...summary.map(line),
    '',
    `Cut-offs: ${JSON.stringify(THRESHOLDS_V2)}`,
    `Repeat agreement: ${pct(out.repeatAgreement)} over ${out.repeatComparisons} comparisons. Median latency ${out.medianMs == null ? '—' : (out.medianMs / 1000).toFixed(2)} s.`,
    `v2 measured spend: $${out.measuredUsd.toFixed(4)}; combined Gemini committed $${out.committedGeminiUsd.toFixed(4)} of $4.50.`,
    '',
    '## Failures',
    '',
    ...(out.failures.length ? out.failures.map((f: any) => `- ${f.caseId}: ${f.error}`) : ['None.']),
    '',
  ].join('\n');
  fs.writeFileSync(path.join(DIR, SUBDIR_V2, 'report.md'), md);
  console.log(md);
}

async function main() {
  const stage = process.argv[2];
  if (stage === 'report') return report();
  if (stage === 'fresh') {
    const fresh = read(`${SUBDIR_V2}/fresh/dataset.json`).cases as Case[];
    await runJobs(fresh.filter((c) => supportsDecision1(c.task)).map((c) => ({ c, repeat: 0 })), 'fresh');
    return;
  }
  if (stage === 'try') {
    const query = (process.argv[3] ?? '').toLowerCase();
    const count = Math.min(10, Math.max(1, Number(process.argv[4] ?? 3)));
    if (!query) throw new Error('Use: try "<title text>" [count]');
    const matches = (read('source-pool.json') as Recipe[])
      .filter((r) => r.content.title.toLowerCase().includes(query) && r.content.ingredients.length && r.content.instructions.length)
      .slice(0, count);
    if (!matches.length) throw new Error('No recipe title in source-pool.json contains that text');
    const tried = matches.flatMap((r) => (['taxonomy', 'tags', 'reminders'] as const).map((task) => recipeCase(task, r)));
    await runJobs(tried.map((c) => ({ c, repeat: 0 })), 'try');
    const rows = composedRows(tried);
    for (const r of matches) {
      const of = (task: string) => {
        const c = tried.find((x) => x.id === `${task}-${r.id}`)!;
        const row = rows.find((x) => x.caseId === c.id);
        return row?.valid ? labels(c, row.value).join(', ') || '(none)' : `invalid: ${row?.validationError ?? 'no answer'}`;
      };
      console.log(`
${r.content.title}
  taxonomy:  ${of('taxonomy')}
  tags:      ${of('tags')}
  reminders: ${of('reminders')}`);
    }
    return;
  }
  const { dataset } = validateBenchmark();
  const cases = (dataset.cases as Case[]).filter((c) => supportsDecision1(c.task));
  const manifestPath = path.join(DIR, SUBDIR_V2, 'manifest.json');
  if (stage === 'dev') {
    if (fs.existsSync(manifestPath)) throw new Error('v2 is frozen; dev runs are closed');
    await runJobs(cases.filter(isTuningCase).map((c) => ({ c, repeat: 0 })), 'dev');
    return;
  }
  if (stage === 'run') {
    const manifest = manifestOf(dataset.cases);
    if (fs.existsSync(manifestPath) && hash(read(`${SUBDIR_V2}/manifest.json`)) !== hash(manifest)) {
      throw new Error('Frozen v2 settings changed');
    }
    save(`${SUBDIR_V2}/manifest.json`, manifest);
    const main = await runJobs(cases.map((c) => ({ c, repeat: 0 })), 'main');
    if (main.completed < main.scheduled) return;
    const repeats = cases.filter((c) => cases.filter((x) => x.task === c.task).findIndex((x) => x.id === c.id) % 5 === 0);
    await runJobs(repeats.flatMap((c) => [1, 2].map((repeat) => ({ c, repeat }))), 'repeat');
    return;
  }
  throw new Error('Use dev, run, fresh, try, or report');
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('/evaluate-decision1-v2.ts')) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : 'Evaluation failed');
    process.exitCode = 1;
  });
}
