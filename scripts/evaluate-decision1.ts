import fs from 'node:fs';
import path from 'node:path';

import {
  canReserve,
  hash,
  labels,
  prf,
  type Case,
} from './lib/aiEvaluationCore';
import {
  buildDecisionRequest,
  composeDecisionOutput,
  DECISION_ENDPOINT,
  DECISION_MODEL,
  DECISION_PRICE,
  supportsDecision1,
  type DecisionApiResponse,
} from './lib/aiEvaluationDecision1';
import { DIR, read, save } from './lib/aiEvaluationPrepare';
import { loadGeminiKey, redact } from './lib/aiEvaluationProviders';
import { scoreRows } from './lib/aiEvaluationReport';
import { balances, journal, resumeDisposition, validateBenchmark } from './evaluate-ai-stack';
import { events35 } from './evaluate-gemini35';

export const SUBDIR = 'gemini-decision-1';

export const eventsDecision1 = (): any[] => {
  const file = path.join(DIR, SUBDIR, 'ledger.jsonl');
  return fs.existsSync(file)
    ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((x) => JSON.parse(x))
    : [];
};

export const costDecision1 = (inputTokens: number): number =>
  (inputTokens * DECISION_PRICE.input) / 1e6;

export function reserveDecision1(body: unknown): number {
  const bytes = Buffer.byteLength(JSON.stringify(body), 'utf8') + 2_048;
  if (bytes > 95_000) throw new Error('Request exceeds conservative context bound');
  return costDecision1(bytes);
}

export function jobsDecision1(cases: Case[], phase: string) {
  return cases.flatMap((c) => {
    if (!supportsDecision1(c.task)) return [];
    const same = cases.filter((x) => x.task === c.task);
    const i = same.findIndex((x) => x.id === c.id);
    if (phase === 'pilot' && i >= 3) return [];
    if (phase === 'repeat' && i % 5 !== 0) return [];
    return (phase === 'repeat' ? [1, 2] : [0]).map((repeat) => ({ c, repeat }));
  });
}

const append = (row: unknown): void => {
  fs.mkdirSync(path.join(DIR, SUBDIR), { recursive: true });
  const fd = fs.openSync(path.join(DIR, SUBDIR, 'ledger.jsonl'), 'a');
  try {
    fs.writeSync(fd, `${JSON.stringify(row)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
};

async function callDecision1(body: unknown, key: string) {
  const start = performance.now();
  try {
    const response = await fetch(DECISION_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': key,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
      redirect: 'error',
    });
    const text = await response.text();
    let parsed: DecisionApiResponse;
    try {
      parsed = JSON.parse(text) as DecisionApiResponse;
    } catch {
      return {
        httpStatus: response.status,
        error: 'Non-JSON provider envelope',
        latencyMs: performance.now() - start,
        inputTokens: null as number | null,
        outputTokens: 0,
        answers: null,
      };
    }
    const inputTokens = typeof parsed.usage?.total_input_tokens === 'number'
      ? parsed.usage.total_input_tokens
      : null;
    return {
      httpStatus: response.status,
      error: response.ok
        ? undefined
        : redact(String(parsed.error?.message ?? `HTTP ${response.status}`), [key]).slice(0, 600),
      latencyMs: performance.now() - start,
      inputTokens,
      outputTokens: parsed.usage?.total_output_tokens ?? 0,
      answers: parsed.answers ?? null,
    };
  } catch {
    return {
      httpStatus: 0,
      error: 'Network failure or timeout; billing unknown',
      latencyMs: performance.now() - start,
      inputTokens: null as number | null,
      outputTokens: 0,
      answers: null,
    };
  }
}

async function run(phase: string) {
  const { dataset, benchmark } = validateBenchmark();
  const lock = path.join(DIR, 'run.lock');
  const fd = fs.openSync(lock, 'wx');
  fs.writeSync(fd, String(process.pid));
  fs.closeSync(fd);
  try {
    const supportedCases = (dataset.cases as Case[]).filter((c) => supportsDecision1(c.task));
    const manifest = {
      model: DECISION_MODEL,
      endpoint: DECISION_ENDPOINT,
      datasetHash: hash(dataset),
      benchmarkHash: hash(benchmark),
      originalManifestHash: hash(read('run-manifest.json')),
      price: DECISION_PRICE,
      capUsd: 4.5,
      settings: 'v1beta/decisions; taxonomy (23 atomic noul/choice questions -> deriveTaxonomyV2, prose dropped); tags (14 parallel noul + course mutual exclusion); reminders (2 noul); threshold=0.5',
      requests: supportedCases.map((c) => ({
        caseId: c.id,
        hash: hash(buildDecisionRequest(c)),
      })),
    };
    const manifestPath = path.join(DIR, SUBDIR, 'manifest.json');
    if (fs.existsSync(manifestPath) && hash(read(`${SUBDIR}/manifest.json`)) !== hash(manifest)) {
      throw new Error('Frozen extension settings changed');
    }
    save(`${SUBDIR}/manifest.json`, manifest);

    const old = journal();
    const old35 = events35();
    const events = eventsDecision1();
    const batch = jobsDecision1(dataset.cases, phase);
    const key = await loadGeminiKey();
    const jobId = (j: typeof batch[number]) => hash([hash(manifest), j.c.id, j.repeat]);
    let stopped = false;
    let completed = 0;
    const committed = () => balances([...old, ...old35, ...events]).gemini;

    async function worker(lane: number) {
      for (const job of batch.filter((_, i) => i % 2 === lane)) {
        const id = jobId(job);
        if (stopped || resumeDisposition(events, id) !== 'new') continue;
        const request = buildDecisionRequest(job.c);
        const reserve = reserveDecision1(request);
        let last: Awaited<ReturnType<typeof callDecision1>> | undefined;
        let usd = 0;
        let latencyMs = 0;
        for (let attempt = 0; attempt < 2; attempt++) {
          if (!canReserve(committed(), reserve)) {
            stopped = true;
            break;
          }
          const attemptId = `${id}-${attempt}`;
          const reservation = {
            type: 'reserve',
            provider: 'gemini',
            jobId: id,
            attemptId,
            usd: reserve,
            at: new Date().toISOString(),
          };
          append(reservation);
          events.push(reservation);
          save(`${SUBDIR}/requests/${id}.json`, {
            jobId: id,
            caseId: job.c.id,
            phase,
            repeat: job.repeat,
            model: DECISION_MODEL,
            body: request,
          });
          last = await callDecision1(request, key);
          const amount = last.inputTokens !== null
            ? costDecision1(last.inputTokens)
            : [400, 401, 403, 404, 422, 429].includes(last.httpStatus)
              ? 0
              : reserve;
          const settled = {
            type: 'settle',
            provider: 'gemini',
            jobId: id,
            attemptId,
            usd: amount,
            measured: last.inputTokens !== null,
            response: last,
            at: new Date().toISOString(),
          };
          append(settled);
          events.push(settled);
          usd += amount;
          latencyMs += last.latencyMs;
          if (![0, 429, 500, 502, 503, 504, 529].includes(last.httpStatus) || attempt === 1) break;
          await new Promise((r) => setTimeout(r, 1500));
        }
        if (!last) continue;

        let value: unknown;
        let validationError: string | undefined;
        try {
          if (last.error || !last.answers) throw new Error(last.error ?? 'Missing answers');
          value = composeDecisionOutput(job.c, last.answers, 0.5);
        } catch (e) {
          validationError = e instanceof Error ? e.message.slice(0, 500) : 'Invalid output';
        }
        const result = {
          type: 'result',
          jobId: id,
          caseId: job.c.id,
          task: job.c.task,
          phase,
          repeat: job.repeat,
          model: DECISION_MODEL,
          value,
          answers: last.answers,
          valid: !validationError,
          validationError,
          latencyMs,
          usd,
          usage: last.inputTokens !== null ? { input: last.inputTokens, output: last.outputTokens } : null,
          at: new Date().toISOString(),
        };
        append(result);
        events.push(result);
        completed++;
        if (completed % 20 === 0 || !result.valid) {
          console.log(JSON.stringify({
            phase,
            completed,
            task: job.c.task,
            valid: result.valid,
            committedGeminiUsd: committed(),
            error: validationError,
          }));
        }
        if ([400, 401, 403, 404, 422].includes(last.httpStatus)) stopped = true;
      }
    }

    const workers = await Promise.allSettled([worker(0), worker(1)]);
    for (const w of workers) {
      if (w.status === 'rejected') throw w.reason;
    }
    const state = {
      scheduled: batch.length,
      completed: batch.filter((j) => resumeDisposition(events, jobId(j)) === 'completed').length,
      committedGeminiUsd: committed(),
      stopped,
      completedAt: new Date().toISOString(),
    };
    save(`${SUBDIR}/phase-${phase}.json`, state);
    console.log(JSON.stringify(state));
  } finally {
    fs.unlinkSync(lock);
  }
}

const percentile = (a: number[], p: number) =>
  a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.ceil(p * a.length) - 1)] : null;
const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const pct = (n: number | null | undefined) => (n == null ? '—' : `${(n * 100).toFixed(1)}%`);

function computeCalibrationEce(
  rows: any[],
  cases: Case[],
  refs: Record<string, any>,
): { ece: number | null; nPredictions: number; meanConfidence: number | null } {
  const bins = Array.from({ length: 10 }, () => ({ count: 0, confSum: 0, accSum: 0 }));
  let total = 0;
  let confTotal = 0;

  for (const row of rows) {
    if (!row.valid || !row.answers) continue;
    const c = cases.find((x) => x.id === row.caseId)!;
    const ref = refs[c.id];
    if (ref.ambiguous) continue;
    const expected = new Set(labels(c, ref.expected));

    const record = (conf: number, correct: boolean) => {
      const clamped = Math.min(0.999999, Math.max(0.5, conf));
      const idx = Math.min(9, Math.floor((clamped - 0.5) * 20));
      bins[idx].count += 1;
      bins[idx].confSum += conf;
      bins[idx].accSum += correct ? 1 : 0;
      total += 1;
      confTotal += conf;
    };

    if (c.task === 'reminders') {
      for (const k of ['needsDefrost', 'needsMarinate'] as const) {
        const ans = row.answers[k];
        if (!ans || ans.type !== 'noul') continue;
        const pred = ans.noul >= 0.5;
        const conf = pred ? ans.noul : 1 - ans.noul;
        record(conf, pred === expected.has(k));
      }
    } else if (c.task === 'tags') {
      for (const [k, ans] of Object.entries<any>(row.answers)) {
        if (ans?.type !== 'noul') continue;
        const pred = ans.noul >= 0.5;
        const conf = pred ? ans.noul : 1 - ans.noul;
        record(conf, pred === expected.has(k));
      }
    } else if (c.task === 'taxonomy') {
      for (const k of ['healthy', 'kid-friendly'] as const) {
        const pred = Boolean(row.value?.[k === 'healthy' ? 'healthy' : 'kidFriendly']);
        // Approximate confidence from minimum governing signal probability when positive
        const ans = k === 'healthy'
          ? row.answers.healthy_limitedSugarRefinedStarchRichness
          : row.answers.kid_broadChildAppeal;
        if (ans?.type === 'noul') {
          const conf = Math.max(ans.noul, 1 - ans.noul);
          record(conf, pred === expected.has(k));
        }
      }
    }
  }

  if (total === 0) return { ece: null, nPredictions: 0, meanConfidence: null };
  const ece = bins.reduce((sum, b) => (b.count ? sum + (b.count / total) * Math.abs(b.accSum / b.count - b.confSum / b.count) : sum), 0);
  return { ece, nPredictions: total, meanConfidence: confTotal / total };
}

function reportDecision1() {
  const dataset = read('dataset.json');
  const benchmark = read('benchmark.json');
  const manifest = read(`${SUBDIR}/manifest.json`);
  const cases = dataset.cases as Case[];
  if (hash(dataset) !== manifest.datasetHash || hash(benchmark) !== manifest.benchmarkHash) {
    throw new Error('Frozen inputs changed');
  }
  const events = eventsDecision1();
  const rows = events.filter((r) => r.type === 'result');
  for (const r of rows) {
    if (r.jobId !== hash([hash(manifest), r.caseId, r.repeat])) {
      throw new Error('Extension result belongs to a different configuration');
    }
  }

  const oldReport = read('report.json');
  const report35 = fs.existsSync(path.join(DIR, 'gemini-3.5-flash-lite', 'report.json'))
    ? read('gemini-3.5-flash-lite/report.json')
    : null;
  const old = journal();
  const old35 = events35();
  const measured = events.filter((e) => e.type === 'settle' && e.measured).reduce((s, e) => s + e.usd, 0);
  const committed = balances([...old, ...old35, ...events]).gemini;

  const summaries: any[] = [];
  const thresholdSweeps: any[] = [];
  for (const task of ['taxonomy', 'tags', 'reminders'] as const) {
    const base = rows.filter((r) => r.task === task && r.repeat === 0);
    const repeated = rows.filter((r) => r.task === task && r.phase === 'repeat');
    const metrics = scoreRows(cases, benchmark.references, base);
    const allCaseMetrics = scoreRows(
      cases,
      Object.fromEntries(
        Object.entries(benchmark.references).map(([id, ref]: [string, any]) => [
          id,
          { ...ref, ambiguous: false },
        ]),
      ),
      base,
    );
    const agreement = repeated.map((r) => {
      const first = base.find((x) => x.caseId === r.caseId);
      if (!first?.valid || !r.valid) return 0;
      const c = cases.find((x) => x.id === r.caseId)!;
      return Number(prf(new Set(labels(c, first.value)), new Set(labels(c, r.value))).exact);
    });
    const inputTokens = base.reduce((s, r) => s + (r.usage?.input ?? 0), 0);
    const ece = computeCalibrationEce(base, cases, benchmark.references);

    summaries.push({
      task,
      provider: 'gemini-decision',
      model: DECISION_MODEL,
      effort: 'default (0 output)',
      attempted: base.length,
      commonCases: base.length,
      planned: cases.filter((c) => c.task === task).length,
      valid: base.filter((r) => r.valid).length,
      invalidRate: avg(base.map((r) => Number(!r.valid))),
      medianMs: percentile(base.map((r) => r.latencyMs), 0.5),
      p95Ms: percentile(base.map((r) => r.latencyMs), 0.95),
      usd: base.reduce((s, r) => s + r.usd, 0),
      usdPer1000Attempts: base.length ? (base.reduce((s, r) => s + r.usd, 0) / base.length) * 1000 : null,
      inputTokens,
      outputTokens: 0,
      repeatComparisons: agreement.length,
      repeatAgreement: avg(agreement),
      calibration: ece,
      ...metrics,
      allCaseMetrics,
    });

    for (const threshold of [0.35, 0.45, 0.5, 0.6, 0.7, 0.8]) {
      const recomposed = base.map((r) => {
        const c = cases.find((x) => x.id === r.caseId)!;
        if (!r.answers) return { ...r, valid: false };
        try {
          return { ...r, valid: true, value: composeDecisionOutput(c, r.answers, threshold) };
        } catch {
          return { ...r, valid: false };
        }
      });
      const scored = scoreRows(cases, benchmark.references, recomposed);
      thresholdSweeps.push({
        task,
        threshold,
        macroF1: scored.macroF1,
        exactMatch: scored.exactMatch,
      });
    }
  }

  const comparison = [
    ...(oldReport.summary ?? []).filter((r: any) => ['taxonomy', 'tags', 'reminders'].includes(r.task)),
    ...(report35?.summary ?? []).filter((r: any) => ['taxonomy', 'tags', 'reminders'].includes(r.task)),
    ...summaries,
  ].sort((a, b) => a.task.localeCompare(b.task) || (b.macroF1 ?? 0) - (a.macroF1 ?? 0));

  const disagreements = rows
    .filter((r) => r.valid && r.repeat === 0)
    .flatMap((r) => {
      const c = cases.find((x) => x.id === r.caseId)!;
      const ref = benchmark.references[c.id];
      return prf(new Set(labels(c, ref.expected)), new Set(labels(c, r.value))).exact
        ? []
        : [{
            caseId: c.id,
            task: c.task,
            title: dataset.recipes.find((x: any) => x.id === c.recipeIds[0])?.content.title,
            ambiguous: ref.ambiguous,
            expected: ref.expected,
            actual: r.value,
            rationale: ref.rationale,
          }];
    });

  const report = {
    generatedAt: new Date().toISOString(),
    model: DECISION_MODEL,
    price: DECISION_PRICE,
    datasetHash: hash(dataset),
    benchmarkHash: hash(benchmark),
    extensionMeasuredUsd: measured,
    totalGeminiCommittedUsd: committed,
    geminiCapUsd: 4.5,
    summary: summaries,
    comparison,
    thresholdSweeps,
    disagreements,
    failures: rows.filter((r) => !r.valid).map((r) => ({
      caseId: r.caseId,
      task: r.task,
      phase: r.phase,
      error: r.validationError,
    })),
  };
  save(`${SUBDIR}/report.json`, report);

  const table = [
    '| Task | Model | Effort / Mode | Cases | Primary n | Macro F1 | Exact | Invalid | Median / p95 (s) | Cost / 1,000 |',
    '|---|---|---|---:|---:|---:|---:|---:|---:|---:|',
    ...comparison.map((r) =>
      `| ${r.task} | ${r.model} | ${r.effort ?? (r.provider === 'gemini' ? 'existing' : 'medium')} | ${r.attempted} | ${r.evaluatedUnambiguous} | ${pct(r.macroF1)} | ${pct(r.exactMatch)} | ${pct(r.invalidRate)} | ${r.medianMs == null ? '—' : (r.medianMs / 1000).toFixed(2)} / ${r.p95Ms == null ? '—' : (r.p95Ms / 1000).toFixed(2)} | $${r.usdPer1000Attempts?.toFixed(3) ?? '—'} |`),
  ].join('\n');

  const md = [
    '# Gemini Decision 1 (`gemini-decision-1`) benchmark extension',
    '',
    'Evaluated on the same frozen 100-recipe dataset (`taxonomy`: 100, `tags`: 60, `reminders`: 60) with Astra-authored references (`substitutions` and `shopping` are excluded because `gemini-decision-1` outputs 0 text tokens).',
    '',
    '## Comparison vs. high-level Astra-benchmarked models & Flash-Lite models',
    '',
    table,
    '',
    '## Threshold sensitivity (computed offline from calibrated probabilities)',
    '',
    '| Task | Threshold | Macro F1 | Exact |',
    '|---|---:|---:|---:|',
    ...thresholdSweeps.map((t) => `| ${t.task} | ${t.threshold.toFixed(2)} | ${pct(t.macroF1)} | ${pct(t.exactMatch)} |`),
    '',
    '## Cost & Calibration',
    '',
    `- Extension measured spend: $${measured.toFixed(6)}`,
    `- Combined Gemini committed spend (3.1/3.8 + 3.5 + decision-1): $${committed.toFixed(6)} / $4.50 cap`,
    ...summaries.map((s) =>
      `- ${s.task}: ${s.inputTokens} input tokens, 0 output tokens, repeat agreement ${pct(s.repeatAgreement)}, ECE ${s.calibration.ece == null ? '—' : s.calibration.ece.toFixed(4)} (n=${s.calibration.nPredictions})`),
    '',
    '## Failures',
    '',
    ...(report.failures.length ? report.failures.map((f: any) => `- ${f.caseId} / ${f.phase}: ${f.error}`) : ['None.']),
    '',
  ].join('\n');
  fs.writeFileSync(path.join(DIR, SUBDIR, 'report.md'), md);
  console.log(JSON.stringify({
    measuredUsd: measured,
    committedGeminiUsd: committed,
    summaries: summaries.map((s) => ({
      task: s.task,
      valid: s.valid,
      attempted: s.attempted,
      evaluatedUnambiguous: s.evaluatedUnambiguous,
      macroF1: s.macroF1,
      exactMatch: s.exactMatch,
      allCaseMacroF1: s.allCaseMetrics?.macroF1,
      allCaseExact: s.allCaseMetrics?.exactMatch,
      medianMs: s.medianMs,
      p95Ms: s.p95Ms,
      usdPer1000Attempts: s.usdPer1000Attempts,
      repeatAgreement: s.repeatAgreement,
      ece: s.calibration?.ece,
    })),
  }, null, 2));
}

async function main() {
  const stage = process.argv[2];
  if (stage === 'preflight') {
    const key = await loadGeminiKey();
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${DECISION_MODEL}`, {
      headers: { 'x-goog-api-key': key },
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await r.json()) as any;
    const result = {
      available: r.ok,
      status: r.status,
      model: body.name,
      inputTokenLimit: body.inputTokenLimit,
      outputTokenLimit: body.outputTokenLimit,
      price: DECISION_PRICE,
    };
    save(`${SUBDIR}/preflight.json`, result);
    console.log(JSON.stringify(result));
    if (!r.ok) process.exitCode = 1;
    return;
  }
  if (stage === 'pilot') return run('pilot');
  if (stage === 'run') {
    for (const phase of ['main', 'repeat']) {
      await run(phase);
      const s = read(`${SUBDIR}/phase-${phase}.json`);
      if (s.completed < s.scheduled) break;
    }
    return;
  }
  if (stage === 'report') return reportDecision1();
  throw new Error('Use preflight, pilot, run, or report');
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('/evaluate-decision1.ts')) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : 'Evaluation failed');
    process.exitCode = 1;
  });
}
