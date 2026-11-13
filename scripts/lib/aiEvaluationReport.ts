import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { DIR, save } from './aiEvaluationPrepare';
import { TASKS, PROVIDERS, labels, pairs, prf, hash, config, type Case, type Reference } from './aiEvaluationCore';
import { legacyTag } from '../../functions/src/ai/contracts';

const percentile = (a: number[], p: number) => a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.ceil(p * a.length) - 1)] : null;
const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export function scoreRows(cases: Case[], refs: Record<string, Reference>, rows: any[]) {
  const perLabel: Record<string, { tp: number; fp: number; fn: number; tn: number }> = {};
  let exact = 0, count = 0, ambiguous = 0;
  for (const row of rows) {
    const c = cases.find(c => c.id === row.caseId)!; const ref = refs[c.id];
    if (ref.ambiguous) { ambiguous++; continue; }
    if (['shopping', 'substitutions'].includes(c.task)) continue;
    count++;
    const expected = new Set(labels(c, ref.expected));
    const actual = new Set<string>(row.valid ? labels(c, row.value) : []);
    const possible = c.task === 'taxonomy' ? ['breakfast', 'lunch', 'dinner', 'side', 'snack', 'dessert', 'component', 'healthy', 'kid-friendly'] : c.task === 'reminders' ? ['needsDefrost', 'needsMarinate'] : c.task === 'tags' ? legacyTag.options : [...new Set([...expected, ...actual])];
    const match = row.valid && [ref.expected, ...(ref.acceptable ?? [])].some(v => prf(new Set(labels(c, v)), actual).exact);
    if (match) exact++;
    for (const k of possible) { const m = perLabel[k] ??= { tp: 0, fp: 0, fn: 0, tn: 0 }; if (expected.has(k)) actual.has(k) ? m.tp++ : m.fn++; else actual.has(k) ? m.fp++ : m.tn++; }
  }
  const metrics = Object.fromEntries(Object.entries(perLabel).map(([k, m]) => { const precision = m.tp + m.fp ? m.tp / (m.tp + m.fp) : 0, recall = m.tp + m.fn ? m.tp / (m.tp + m.fn) : null; return [k, { ...m, precision, recall, f1: 2 * m.tp + m.fp + m.fn ? 2 * m.tp / (2 * m.tp + m.fp + m.fn) : null, falsePositiveRate: m.fp + m.tn ? m.fp / (m.fp + m.tn) : null }]; }));
  const f1s = Object.values(metrics).map(m => m.f1).filter((v): v is number => v !== null);
  return { evaluatedUnambiguous: count, ambiguous, exactMatch: count ? exact / count : null, macroF1: f1s.length ? f1s.reduce((a, b) => a + b, 0) / f1s.length : null, perLabel: metrics };
}
export function renderReport(dataset: any, benchmark: any, events: any[]) {
  const cases = dataset.cases as Case[];
  const currentManifest = fs.existsSync(path.join(DIR, 'run-manifest.json')) ? JSON.parse(fs.readFileSync(path.join(DIR, 'run-manifest.json'), 'utf8')) : null;
  const allResults = events.filter(e => e.type === 'result');
  const results = allResults.filter(r => !currentManifest || r.jobId === hash([hash(currentManifest), r.caseId, r.provider, r.repeat, r.effort]));
  const blindPath = path.join(DIR, 'blind-map.json');
  const mapping: Record<string, string> = fs.existsSync(blindPath) ? JSON.parse(fs.readFileSync(blindPath, 'utf8')) : {};
  const blind = results.filter(r => r.task === 'substitutions' && r.valid).map(r => { const id = mapping[r.jobId] ??= randomBytes(12).toString('hex'); const c = cases.find(c => c.id === r.caseId)!; return { blindId: id, caseId: c.id, input: c.input, rubric: benchmark.references[c.id].rubric, output: r.value }; }).sort((a, b) => a.blindId.localeCompare(b.blindId));
  save('blind-map.json', mapping); save('blind-review.json', blind);
  const reviewsPath = path.join(DIR, 'blind-scores.json');
  const reviews = fs.existsSync(reviewsPath) ? JSON.parse(fs.readFileSync(reviewsPath, 'utf8')) : {};
  for (const [id, review] of Object.entries(reviews) as [string, any][]) {
    if (!blind.some(b => b.blindId === id)) throw new Error(`Unknown blind review ID: ${id}`);
    if (!['suitability', 'adjustment', 'practicality', 'distinctness'].every(k => Number.isInteger(review[k]) && review[k] >= 0 && review[k] <= 4) || !review.rationale) throw new Error(`Invalid blind review: ${id}`);
  }
  const summary: any[] = [];
  for (const task of TASKS) for (const provider of PROVIDERS) {
    if (!cases.some(c => c.task === task)) continue;
    const base = results.filter(r => r.task === task && r.provider === provider && r.repeat === 0 && ['main', 'pilot'].includes(r.phase));
    const shared = cases.filter(c => c.task === task && PROVIDERS.every(p => results.some(r => r.caseId === c.id && r.provider === p && r.repeat === 0 && ['main', 'pilot'].includes(r.phase)))).map(c => c.id);
    const compared = base.filter(r => shared.includes(r.caseId));
    let metrics: any = scoreRows(cases, benchmark.references, compared);
    const allCaseMetrics = !['shopping', 'substitutions'].includes(task) ? scoreRows(cases, Object.fromEntries(Object.entries(benchmark.references).map(([id, ref]: [string, any]) => [id, { ...ref, ambiguous: false }])), compared) : null;
    if (task === 'shopping') {
      const scores = compared.filter(r => !benchmark.references[r.caseId].ambiguous).map(r => {
        const expected = benchmark.references[r.caseId].expected;
        const comparison = prf(pairs(expected), pairs(r.valid ? r.value : []));
        const cats = new Map(expected.flatMap((g: any) => g.sourceIds.map((id: number) => [id, g.category])));
        const correct = r.valid ? r.value.reduce((n: number, g: any) => n + g.sourceIds.filter((id: number) => cats.get(id) === g.category).length, 0) : 0;
        return { precision: r.valid ? comparison.precision : 0, recall: r.valid ? comparison.recall : 0, f1: r.valid ? comparison.f1 : 0, exact: r.valid && comparison.exact, categoryAccuracy: correct / cats.size, conserved: !!r.shopping?.conserved };
      });
      const avg = (k: string) => scores.length ? scores.reduce((s: number, x: any) => s + Number(x[k]), 0) / scores.length : null;
      metrics = { evaluatedUnambiguous: scores.length, pairPrecision: avg('precision'), pairRecall: avg('recall'), pairF1: avg('f1'), exactMatch: avg('exact'), categoryAccuracy: avg('categoryAccuracy'), conservationRate: avg('conserved') };
    }
    if (task === 'substitutions') {
      const clear = compared.filter(r => !benchmark.references[r.caseId].ambiguous);
      const graded = clear.filter(r => !r.valid || reviews[mapping[r.jobId]]);
      const allGraded = compared.filter(r => !r.valid || reviews[mapping[r.jobId]]);
      const score = (r: any) => { if (!r.valid) return 0; const v = reviews[mapping[r.jobId]]; return (v.suitability * .4 + v.adjustment * .3 + v.practicality * .15 + v.distinctness * .15) / 4; };
      metrics = { reviewed: graded.length, pending: clear.length - graded.length, ambiguous: compared.length - clear.length, quality: graded.length ? graded.reduce((n, r) => n + score(r), 0) / graded.length : null, allCaseQuality: allGraded.length ? allGraded.reduce((n, r) => n + score(r), 0) / allGraded.length : null };
    }
    const spend = base.reduce((s, r) => s + r.usd, 0), valid = base.filter(r => r.valid).length;
    const repeated = results.filter(r => r.task === task && r.provider === provider && r.phase === 'repeat');
    const rubricScore = (r: any) => { const v = reviews[mapping[r.jobId]]; return !r.valid ? 0 : v ? (v.suitability * .4 + v.adjustment * .3 + v.practicality * .15 + v.distinctness * .15) / 4 : null; };
    const repeatDeltas = task === 'substitutions' ? repeated.filter(r => !benchmark.references[r.caseId].ambiguous).flatMap(r => { const first = base.find(b => b.caseId === r.caseId); const a = first && rubricScore(first), b = rubricScore(r); return a != null && b != null ? [Math.abs(a - b)] : []; }) : [];
    const attempts = events.filter(e => e.type === 'settle' && base.some(r => r.jobId === e.jobId));
    const usageTotals = attempts.reduce((out, e) => { for (const k of ['input', 'cached', 'cacheWrite', 'output', 'reasoning']) out[k] += e.response?.usage?.[k] ?? 0; return out; }, { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 });
    Object.assign(metrics, { usageTotals, usageMeasuredAttempts: attempts.filter(e => e.measured).length, apiAttempts: attempts.length, repeatRubricComparisons: repeatDeltas.length, repeatMeanAbsoluteQualityChange: repeatDeltas.length ? repeatDeltas.reduce((a, b) => a + b, 0) / repeatDeltas.length : null });
    const repeatMatches = repeated.map(r => { const first = base.find(b => b.caseId === r.caseId); if (!first?.valid || !r.valid) return false; return task === 'shopping' ? prf(pairs(first.value), pairs(r.value)).exact : task === 'substitutions' ? null : prf(new Set(labels(cases.find(c => c.id === r.caseId)!, first.value)), new Set(labels(cases.find(c => c.id === r.caseId)!, r.value))).exact; }).filter(v => v !== null);
    summary.push({ task, provider, model: config(provider, cases.find(c => c.task === task)!).model, attempted: base.length, planned: cases.filter(c => c.task === task).length, commonCases: shared.length, valid, invalidRate: base.length ? 1 - valid / base.length : null, medianMs: percentile(base.map(r => r.latencyMs), .5), p95Ms: percentile(base.map(r => r.latencyMs), .95), usd: spend, usdPer1000Attempts: base.length ? spend / base.length * 1000 : null, usdPer1000Valid: valid ? spend / valid * 1000 : null, repeatComparisons: repeatMatches.length, repeatAgreement: repeatMatches.length ? repeatMatches.filter(Boolean).length / repeatMatches.length : null, allCaseMetrics, ...metrics });
  }
  const latest = new Map<string, any>(); for (const e of events) if (['reserve', 'settle'].includes(e.type)) latest.set(e.attemptId, e);
  const costs = Object.fromEntries(PROVIDERS.map(p => [p, { measuredUsd: [...latest.values()].filter(e => e.provider === p && e.measured).reduce((n, e) => n + e.usd, 0), committedUsd: [...latest.values()].filter(e => e.provider === p).reduce((n, e) => n + e.usd, 0), capUsd: 4.5 }]));
  const sweep = results.filter(r => r.phase === 'sweep').map(r => ({ task: r.task, provider: r.provider, effort: r.effort, caseId: r.caseId, valid: r.valid, latencyMs: r.latencyMs, usd: r.usd, ...(r.task === 'shopping' ? { pairF1: r.valid ? prf(pairs(benchmark.references[r.caseId].expected), pairs(r.value)).f1 : 0 } : scoreRows(cases, benchmark.references, [r])) }));
  const sweepSummary: any[] = [];
  for (const task of ['reminders', 'shopping']) {
    const ids = new Set(sweep.filter(r => r.task === task).map(r => r.caseId));
    for (const provider of PROVIDERS) for (const effort of [...new Set(results.filter(r => r.task === task && r.provider === provider && r.repeat === 0 && ids.has(r.caseId)).map(r => r.effort))]) {
      const rows = results.filter(r => r.task === task && r.provider === provider && r.repeat === 0 && ids.has(r.caseId) && r.effort === effort);
      const metrics = task === 'shopping' ? { evaluatedUnambiguous: rows.length, pairF1: rows.reduce((s,r) => s + (r.valid ? prf(pairs(benchmark.references[r.caseId].expected), pairs(r.value)).f1 : 0),0) / rows.length } : scoreRows(cases, benchmark.references, rows);
      sweepSummary.push({ task, provider, effort, cases: rows.length, valid: rows.filter(r => r.valid).length, ...metrics, medianMs: percentile(rows.map(r => r.latencyMs), .5), p95Ms: percentile(rows.map(r => r.latencyMs), .95), usdPer1000: rows.reduce((s,r) => s+r.usd,0)/rows.length*1000 });
    }
  }
  const disagreements = results.filter(r => r.valid && r.repeat === 0 && ['main','pilot'].includes(r.phase) && !['shopping','substitutions'].includes(r.task)).flatMap(r => { const c = cases.find(c => c.id === r.caseId)!; const ref = benchmark.references[c.id]; const p = prf(new Set(labels(c, ref.expected)), new Set(labels(c, r.value))); return p.exact ? [] : [{ provider: r.provider, task: r.task, caseId: c.id, title: dataset.recipes.find((x: any) => x.id === c.recipeIds[0])?.content.title, expected: ref.expected, actual: r.value, ambiguous: ref.ambiguous, rationale: ref.rationale }]; });
  const report = { generatedAt: new Date().toISOString(), datasetHash: hash(dataset), benchmarkHash: hash(benchmark), blindScoresHash: hash(reviews), excludedEarlierPilotResults: allResults.length - results.length, unexercisedTasks: TASKS.filter(t => !cases.some(c => c.task === t)), costs, summary, sweep, sweepSummary, disagreements, failures: results.filter(r => !r.valid).map(r => ({ task: r.task, provider: r.provider, phase: r.phase, effort: r.effort, caseId: r.caseId, error: r.validationError })), pendingBlindReviews: blind.filter(b => !reviews[b.blindId]).length };
  save('report.json', report);
  const pct = (v: number | null | undefined) => v == null ? '—' : `${(v * 100).toFixed(1)}%`;
  const md = ['# MealWizard AI stack evaluation', '', 'Dinner-focused, constructed shopping lists. Reference answers authored and reviewed in chat; no Astra API calls. This is an AI-authored reference, not human-verified ground truth.', '', '## Results', '', '| Task | Provider | Cases/common | Valid | Quality* | Exact | Median / p95 (s) | Cost / 1,000 attempts |', '|---|---|---:|---:|---:|---:|---:|---:|', ...summary.map(r => `| ${r.task} | ${r.provider} | ${r.attempted}/${r.commonCases} | ${r.valid} | ${pct(r.macroF1 ?? r.pairF1 ?? r.quality)} | ${pct(r.exactMatch)} | ${r.medianMs == null ? '—' : (r.medianMs / 1000).toFixed(2)} / ${r.p95Ms == null ? '—' : (r.p95Ms / 1000).toFixed(2)} | ${r.usdPer1000Attempts == null ? '—' : '$' + r.usdPer1000Attempts.toFixed(3)} |`), '', '*Quality is macro F1 for classification, pairwise F1 for shopping, and the weighted blind rubric for substitutions. Scores use the common attempted cases; ambiguous reference cases are excluded from primary classification scores. Invalid answers count as failures.', '', '## Cost', '', ...Object.entries(costs).map(([p, c]) => `- ${p}: $${c.measuredUsd.toFixed(6)} measured usage; $${c.committedUsd.toFixed(6)} including conservative reservations; $4.50 cap.`), '', 'Costs are usage-based estimates at the saved official prices, not reconciled billing invoices. Gemini free-tier credits are not assumed. Chat subscription usage is excluded.', '', '## Coverage and limitations', '', `- ${dataset.recipes.length} recipes; ${cases.length} task cases. Shopping lists are assembled from these recipes, never live household data.`, '- Individual-recipe tagging/reminder requests are used; production batch throughput is not measured.', '- Snapshot inputs and prompts are frozen. Existing catalogue predictions were excluded from reference authoring.', '- Provider formatting differs; the same task content and requested semantic output are supplied.', '- Model-author agreement can contain shared biases, including bias toward an OpenAI candidate. Small effort-sweep subsets are directional evidence.', `- Pending blind substitution reviews: ${report.pendingBlindReviews}.`, '- Detailed per-label metrics, category accuracy, conservation, repeats, effort comparisons, and failures are in report.json.', '', '## Failures', '', ...report.failures.slice(0, 30).map(r => `- ${r.provider} / ${r.task}: ${r.error}`), ''].join('\n');
  const recommendationsPath = path.join(DIR, 'recommendations.md');
  const recommendations = fs.existsSync(recommendationsPath) ? fs.readFileSync(recommendationsPath, 'utf8') : 'Recommendations will be finalized after all phases and blind reviews are complete.';
  const appendix = [
    '## Primary score denominators and ambiguity', '',
    '| Task | Clear cases | Ambiguous cases |', '|---|---:|---:|',
    ...summary.filter(r => r.provider === 'gemini').map(r => `| ${r.task} | ${r.evaluatedUnambiguous ?? r.reviewed} | ${r.ambiguous ?? 0} |`), '',
    '## Secondary classification scores including ambiguous references', '',
    '| Task | Provider | Cases | Macro F1 | Exact |', '|---|---|---:|---:|---:|',
    ...summary.filter(r => r.allCaseMetrics).map(r => `| ${r.task} | ${r.provider} | ${r.allCaseMetrics.evaluatedUnambiguous} | ${pct(r.allCaseMetrics.macroF1)} | ${pct(r.allCaseMetrics.exactMatch)} |`), '',
    '## Matched thinking-level subsets', '',
    '| Task | Provider | Effort | Cases / clear | Valid | Quality | Exact | Median seconds | Cost / 1,000 |', '|---|---|---|---:|---:|---:|---:|---:|---:|',
    ...sweepSummary.map(r => `| ${r.task} | ${r.provider} | ${r.effort} | ${r.cases} / ${r.evaluatedUnambiguous} | ${r.valid} | ${pct(r.macroF1 ?? r.pairF1)} | ${pct(r.exactMatch)} | ${(r.medianMs / 1000).toFixed(2)} | $${r.usdPer1000.toFixed(3)} |`), '',
    '## Repeat consistency', '',
    '| Task | Provider | Comparisons | Exact agreement | Mean absolute blind-score change |', '|---|---|---:|---:|---:|',
    ...summary.map(r => `| ${r.task} | ${r.provider} | ${r.repeatRubricComparisons || r.repeatComparisons} | ${pct(r.repeatAgreement)} | ${pct(r.repeatMeanAbsoluteQualityChange)} |`), '',
    'Substitution consistency uses blind rubric score change on unambiguous inputs rather than exact wording. Each repeated answer is compared with its main answer. Invalid classification/grouping repeats count as disagreements.', '',
    '## Shopping validity and quantities', '',
    '| Provider | Pair precision | Pair recall | Exact groups | Category accuracy | ID and quantity conservation |', '|---|---:|---:|---:|---:|---:|',
    ...summary.filter(r => r.task === 'shopping').map(r => `| ${r.provider} | ${pct(r.pairPrecision)} | ${pct(r.pairRecall)} | ${pct(r.exactMatch)} | ${pct(r.categoryAccuracy)} | ${pct(r.conservationRate)} |`), '',
    'Conservation requires raw ID coverage and preservation of source contributions and unit totals through existing application arithmetic. Invalid raw answers remain failures. Category accuracy uses the frozen convention and should be interpreted cautiously where several aisle choices are reasonable.', '',
    '## Observed main-pass token usage (reasoning included in output)', '',
    '| Task | Provider | Input | Cached input | Cache writes | Output incl. reasoning | Reported reasoning |', '|---|---|---:|---:|---:|---:|---:|',
    ...summary.map(r => `| ${r.task} | ${r.provider} | ${r.usageTotals.input} | ${r.usageTotals.cached} | ${r.usageTotals.cacheWrite} | ${r.usageTotals.output} | ${r.provider === 'anthropic' ? 'Not separately exposed' : r.usageTotals.reasoning} |`), '',
    'Provider-specific schemas, formatting modes, effort settings, prices, and hashes are preserved in run-manifest.json and requests/. Raw final responses, per-attempt usage, reservations, and validation results are in ledger.jsonl. Unsupported F1 labels with no positives or predictions are excluded from macro averages; counts remain in report.json.', '',
    recommendations,
  ].join('\n');
  const completeMd = `${md}\n${appendix}\n`;
  fs.writeFileSync(path.join(DIR, 'report.md'), completeMd);
  const htmlRows = summary.map(r => `<tr><td><strong>${r.task}</strong><small>${r.model}</small></td><td>${r.provider}</td><td>${r.attempted} / ${r.planned}</td><td>${r.commonCases}</td><td>${pct(r.macroF1 ?? r.pairF1 ?? r.quality)}<small>n = ${r.evaluatedUnambiguous ?? r.reviewed}</small></td><td>${pct(r.exactMatch)}</td><td>${pct(r.invalidRate)}</td><td>${r.medianMs == null ? '—' : (r.medianMs / 1000).toFixed(2)}</td><td>${r.p95Ms == null ? '—' : (r.p95Ms / 1000).toFixed(2)}</td><td>${r.usdPer1000Attempts == null ? '—' : '$' + r.usdPer1000Attempts.toFixed(3)}</td></tr>`).join('');
  fs.writeFileSync(path.join(DIR, 'report.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MealWizard AI evaluation</title><style>body{max-width:1440px;margin:36px auto;padding:24px;font:15px system-ui;background:#f5f7f4;color:#18271e}h1{font-size:38px;margin:8px 0}h2{margin-top:32px}.eyebrow{color:#347551;font-weight:700;letter-spacing:.1em}.cards{display:flex;gap:16px;margin:24px 0}.card{background:#e3eee5;padding:20px;border-radius:12px;flex:1}.card b{display:block;font-size:26px}.table{overflow:auto;background:white;border-radius:12px}table{border-collapse:collapse;width:100%;white-space:nowrap}th,td{text-align:left;padding:12px 14px;border-bottom:1px solid #e1e7e2}th{background:#dae6dd}small{display:block;color:#66796c;font-size:11px}pre{white-space:pre-wrap;line-height:1.6;background:white;padding:24px;border-radius:12px;overflow:auto}.note{color:#52675a;line-height:1.6}details{margin-top:20px}summary{cursor:pointer;font-weight:600}a{color:#236c43}</style></head><body><div class="eyebrow">MEALWIZARD · MODEL EVALUATION</div><h1>Dinner, decisions, and shopping lists</h1><p class="note">100 recipes · 30 constructed lists · Gemini vs Haiku 5.5 vs GPT-6 Luna<br>Frozen chat-authored reference. No Astra API calls. Updated ${escape(report.generatedAt)}.</p><div class="cards">${Object.entries(costs).map(([p,c]) => `<div class="card">${p}<b>$${c.measuredUsd.toFixed(4)}</b><small>Measured API cost · $${c.committedUsd.toFixed(4)} committed · $4.50 cap</small></div>`).join('')}</div><h2>Quality, speed, and cost</h2><div class="table"><table><thead><tr><th>Task / model</th><th>Provider</th><th>Completed</th><th>Common</th><th>Quality*</th><th>Exact</th><th>Invalid</th><th>Median s</th><th>p95 s</th><th>Cost / 1k</th></tr></thead><tbody>${htmlRows}</tbody></table></div><p class="note">*Macro F1 for classification, pairwise F1 for shopping, weighted blind rubric for substitutions. Primary scores exclude ambiguous references; all-case scores and per-label metrics are available in <a href="report.json">report.json</a>. Costs are usage-derived estimates, not invoices. Cuisine fallback was not exercised because no collected record needed it. Earlier pilot results excluded from quality: ${report.excludedEarlierPilotResults}. Pending blind reviews: ${report.pendingBlindReviews}.</p><h2>Recommendations</h2><pre>${escape(recommendations)}</pre><details><summary>Full methodology, coverage, and failures</summary><pre>${escape(completeMd)}</pre></details><p><a href="report.md">Markdown report</a> · <a href="report.json">Detailed JSON</a> · <a href="benchmark.json">Reference benchmark</a> · <a href="dataset.json">Frozen dataset</a></p></body></html>`);
  console.log(JSON.stringify({ report: path.join(DIR, 'report.html'), results: results.length, costs, pendingBlindReviews: report.pendingBlindReviews }));
}
