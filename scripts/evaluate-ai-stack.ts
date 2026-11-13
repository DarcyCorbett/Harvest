import fs from 'node:fs';
import path from 'node:path';
import { TASKS, PROVIDERS, hash, config, makeRequest, reservation, canReserve, cost, validateOutput, verifyShopping, PRICING_SOURCES, PRICES, type Case, type Reference, type Provider } from './lib/aiEvaluationCore';
import { DIR, read, save, prepare } from './lib/aiEvaluationPrepare';
import { loadKeys, preflight, callProvider } from './lib/aiEvaluationProviders';
import { renderReport } from './lib/aiEvaluationReport';

const args = process.argv.slice(2), stage = args[0];
const arg = (name: string, fallback: string) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const journalPath = path.join(DIR, 'ledger.jsonl');
export function journal() { return fs.existsSync(journalPath) ? fs.readFileSync(journalPath, 'utf8').trim().split('\n').filter(Boolean).map(s => JSON.parse(s)) : []; }
function append(row: any) { const fd = fs.openSync(journalPath, 'a'); try { fs.writeSync(fd, JSON.stringify(row) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
export function balances(events: any[]) {
  const amounts = new Map<string, any>();
  for (const e of events) if (e.type === 'reserve' || e.type === 'settle') amounts.set(e.attemptId, e);
  return Object.fromEntries(PROVIDERS.map(p => [p, [...amounts.values()].filter(e => e.provider === p).reduce((n, e) => n + e.usd, 0)])) as Record<Provider, number>;
}
export function resumeDisposition(events: any[], jobId: string): 'completed' | 'unresolved' | 'new' {
  if (events.some(e => e.type === 'result' && e.jobId === jobId)) return 'completed';
  return events.some(e => e.type === 'reserve' && e.jobId === jobId) ? 'unresolved' : 'new';
}
export function validateBenchmark() {
  const dataset = read('dataset.json'), benchmark = read('benchmark.json');
  if (hash(dataset) !== read('dataset.sha256.json').sha256 || benchmark.datasetHash !== hash(dataset)) throw new Error('Dataset hash mismatch');
  if (benchmark.authoring !== 'chat' || benchmark.apiCalls !== 0 || !benchmark.reviewedAt) throw new Error('Benchmark authoring/review incomplete');
  for (const c of dataset.cases as Case[]) {
    const ref = benchmark.references[c.id] as Reference;
    if (!ref || !ref.rationale || typeof ref.ambiguous !== 'boolean') throw new Error(`Missing reference: ${c.id}`);
    if (c.task === 'shopping') validateOutput(c, ref.expected);
    else if (c.task === 'substitutions') { if (!ref.rubric?.acceptable?.length || !ref.rubric?.avoid?.length) throw new Error(`Missing substitution rubric: ${c.id}`); }
    else if (!ref.expected) throw new Error(`Missing expected answer: ${c.id}`);
  }
  const frozen = path.join(DIR, 'benchmark.sha256.json');
  if (fs.existsSync(frozen) && read('benchmark.sha256.json').sha256 !== hash(benchmark)) throw new Error('Frozen benchmark changed');
  save('benchmark.sha256.json', { sha256: hash(benchmark), datasetHash: hash(dataset) });
  return { dataset, benchmark };
}
function jobs(cases: Case[], phase: string) {
  const result: { c: Case; provider: Provider; repeat: number; effort?: string }[] = [];
  for (const task of TASKS) {
    const all = cases.filter(c => c.task === task);
    const selected = phase === 'pilot' ? all.slice(0, 3) : phase === 'main' ? all : all.filter((_, i) => i % 5 === 0);
    for (const c of selected) for (const repeat of phase === 'repeat' ? [1, 2] : [0]) for (const provider of PROVIDERS) {
      if (phase !== 'sweep') result.push({ c, provider, repeat });
      else if (provider !== 'gemini') for (const effort of task === 'shopping' ? ['medium', 'xhigh'] : ['cuisine', 'reminders'].includes(task) ? ['low'] : []) result.push({ c, provider, repeat, effort });
    }
  }
  return result;
}
async function run(phase: string) {
  const { dataset, benchmark } = validateBenchmark();
  const lock = path.join(DIR, 'run.lock');
  const fd = fs.openSync(lock, 'wx'); fs.writeSync(fd, String(process.pid)); fs.closeSync(fd);
  try {
    const keys = await loadKeys(arg('--keys-file', 'C:/Users/User/OneDrive/Desktop/keys.txt'));
    const manifest = { datasetHash: hash(dataset), benchmarkHash: hash(benchmark), requests: (dataset.cases as Case[]).flatMap(c => PROVIDERS.map(p => ({ caseId: c.id, ...config(p, c), requestHash: hash(makeRequest(p, c).body) }))), prices: PRICES, pricingSources: PRICING_SOURCES };
    if (fs.existsSync(path.join(DIR, 'run-manifest.json')) && hash(read('run-manifest.json')) !== hash(manifest)) {
      if (phase !== 'pilot' || !args.includes('--revise-pilot') || journal().some(e => e.type === 'result' && e.phase !== 'pilot')) throw new Error('Frozen run configuration changed');
      save(`pilot-history/manifest-${hash(read('run-manifest.json')).slice(0,12)}.json`, read('run-manifest.json'));
    }
    save('run-manifest.json', manifest);
    const events = journal(), done = new Set(events.filter(e => e.type === 'result').map(e => e.jobId));
    const suspended = new Set<Provider>();
    const phaseJobs = jobs(dataset.cases, phase);
    let completed = 0;
    async function worker(batch: typeof phaseJobs) { for (const job of batch) {
      const { c, provider, repeat, effort } = job;
      const cfg = config(provider, c, effort);
      // Pilot uses the same job identity as main and is not billed a second time.
      const jobId = hash([hash(manifest), c.id, provider, repeat, cfg.effort]);
      if (done.has(jobId) || suspended.has(provider)) continue;
      if (resumeDisposition(events, jobId) !== 'new') { console.log(JSON.stringify({ jobId, skipped: 'Unresolved previous request; reserved cost retained' })); continue; }
      const request = makeRequest(provider, c, effort), amount = reservation(request);
      let last: any, totalCost = 0, totalLatency = 0, measuredCost = 0;
      for (let attempt = 0; attempt < 2; attempt++) {
        if (!canReserve(balances(events)[provider], amount)) { suspended.add(provider); console.log(JSON.stringify({ provider, stopped: 'spend cap', committedUsd: balances(events)[provider] })); break; }
        const attemptId = `${jobId}-${attempt}`;
        const reserved = { type: 'reserve', attemptId, jobId, provider, usd: amount, at: new Date().toISOString() }; append(reserved); events.push(reserved);
        save(`requests/${jobId}.json`, { jobId, caseId: c.id, phase, repeat, ...cfg, body: request.body });
        last = await callProvider(provider, c, keys[provider], Object.values(keys), effort);
        const usd = last.usage ? cost(cfg.model, last.usage) : [400, 401, 403, 404, 422, 429].includes(last.httpStatus) ? 0 : amount;
        const settled = { type: 'settle', attemptId, jobId, provider, usd, measured: !!last.usage, response: last, at: new Date().toISOString() }; append(settled); events.push(settled);
        totalCost += usd; measuredCost += last.usage ? usd : 0; totalLatency += last.latencyMs;
        if (![0, 429, 500, 502, 503, 504, 529].includes(last.httpStatus) || attempt === 1) break;
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
      if (!last) continue;
      let validated: any, shopping: any, validationError: string | undefined;
      try { if (last.error || !last.complete) throw new Error(last.error ?? 'Incomplete output'); validated = validateOutput(c, JSON.parse(last.text)); if (c.task === 'shopping') shopping = await verifyShopping(c, validated); } catch (e) { validationError = e instanceof SyntaxError ? 'Invalid JSON' : e instanceof Error ? e.message.slice(0, 500) : 'Invalid output'; }
      const row = { type: 'result', jobId, caseId: c.id, task: c.task, phase, repeat, ...cfg, valid: !validationError, validationError, value: validated, shopping, latencyMs: totalLatency, usd: totalCost, measuredUsd: measuredCost, usage: last.usage, at: new Date().toISOString() };
      append(row); events.push(row); done.add(jobId); completed++;
      console.log(JSON.stringify({ task: c.task, provider, phase, completed, valid: row.valid, usd: balances(events)[provider], ...(last.error ? { error: last.error } : {}) }));
      if ([401, 403, 404].includes(last.httpStatus)) suspended.add(provider);
    } }
    const workers = await Promise.allSettled(PROVIDERS.flatMap(p => [0, 1].map(lane => worker(phaseJobs.filter(j => j.provider === p).filter((_, i) => i % 2 === lane)))));
    const failed = workers.find(w => w.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    save(`phase-${phase}.json`, { completedAt: new Date().toISOString(), scheduled: phaseJobs.length, completed: phaseJobs.filter(j => done.has(hash([hash(manifest), j.c.id, j.provider, j.repeat, config(j.provider, j.c, j.effort).effort]))).length, balances: balances(events), suspended: [...suspended] });
  } finally { fs.unlinkSync(lock); }
}
async function main() {
  if (stage === 'prepare') return prepare();
  if (stage === 'validate-benchmark') { const { dataset } = validateBenchmark(); console.log(JSON.stringify({ valid: true, cases: dataset.cases.length })); return; }
  if (stage === 'preflight') { const result = await preflight(await loadKeys(arg('--keys-file', 'C:/Users/User/OneDrive/Desktop/keys.txt'))); save('preflight.json', result); console.log(JSON.stringify(result)); return; }
  if (stage === 'pilot') return run('pilot');
  if (stage === 'run') { for (const phase of ['main', 'repeat', 'sweep']) { await run(phase); const state = read(`phase-${phase}.json`); if (state.completed < state.scheduled) break; } return; }
  if (stage === 'report') return renderReport(read('dataset.json'), read('benchmark.json'), journal());
  throw new Error('Use prepare, validate-benchmark, preflight, pilot, run, or report');
}
if (process.argv[1]?.replace(/\\/g, '/').endsWith('/evaluate-ai-stack.ts')) main().catch(e => { console.error(e instanceof Error ? e.message : 'Evaluation failed'); process.exitCode = 1; });
