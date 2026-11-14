import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { applicationDefault, initializeApp } from '../functions/node_modules/firebase-admin/lib/app/index.js';
import { FieldPath, getFirestore } from '../functions/node_modules/firebase-admin/lib/firestore/index.js';
import {
  DECISION_QUESTION_SET,
  TAXONOMY_QUESTIONS,
  buildTaxonomyDecisionInput,
  composeTaxonomyEvidence,
  mapInParallel,
  requestDecisions,
} from '../functions/src/ai/decision';
import { DECISION_MODEL } from '../functions/src/ai/models';
import type { CompleteCanonicalRecipeV2 } from '../functions/src/catalogue/domain';
import { applyTaxonomyV2Evidence } from '../functions/src/catalogue/taxonomyRetagBatch';
import { deriveTaxonomyV2, type TaxonomyV2Evidence } from '../functions/src/catalogue/taxonomyV2';
import { loadGeminiKey } from './lib/aiEvaluationProviders';

// Retags every ready catalogue recipe (meal types, healthy, kid-friendly) with
// gemini-decision-1. Cuisines and other modifiers are left alone, and manual
// overrides keep winning exactly as they do for the existing retag.
//
// The Decisions API has no batch mode and no caching, so the efficient shape is
// one request per recipe (all taxonomy questions share the recipe input, which
// is billed once) with several requests in flight. Model answers are staged to
// a local file first; nothing is written to Firestore until `apply --confirm`.
//
//   plan                      count recipes and estimate cost and time; no model calls, no writes
//   stage [--limit N] [--lanes N] [--max-usd N]
//                             ask the model page by page; resumable; stops at --max-usd
//                             (default 20); no Firestore writes
//   diff                      what would change, from the staged answers; no writes
//   apply [--limit N] --confirm
//                             write staged labels; without --confirm it only counts
//   revert --confirm          restore the labels saved by `apply`
//
//   node node_modules/tsx/dist/cli.mjs scripts/retag-catalogue-decision.ts plan
const PROJECT_ID = 'meal-wizard-ad202';
const USD_PER_MILLION_INPUT_TOKENS = 0.10;
const DIR = path.resolve('artifacts/catalogue-decision-retag', DECISION_QUESTION_SET);
const STAGED = path.join(DIR, 'staged.jsonl');
const APPLIED = path.join(DIR, 'applied.jsonl');

type Labels = { mealTypes: string[]; kidFriendly: boolean; healthy: boolean };
interface StagedRow { id: string; title: string; contentHash: string; questionSet: string; evidence: TaxonomyV2Evidence; before: Labels; after: Labels; manual: boolean; inputTokens: number }

const args = process.argv.slice(3);
const flag = (name: string) => args.includes(name);
const option = (name: string, fallback: number) => (args.includes(name) ? Number(args[args.indexOf(name) + 1]) : fallback);
const lines = <T>(file: string): T[] =>
  fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((x) => JSON.parse(x) as T) : [];
const append = (file: string, row: unknown) => {
  fs.mkdirSync(DIR, { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
};
const contentHash = (recipe: CompleteCanonicalRecipeV2) =>
  recipe.ingestion.contentHash ?? createHash('sha256').update(JSON.stringify(recipe.content), 'utf8').digest('hex');
const labelsOf = (recipe: CompleteCanonicalRecipeV2): Labels => ({
  mealTypes: [...(recipe.sourceMetadata.mealTypes ?? [])],
  kidFriendly: (recipe.sourceMetadata.modifiers ?? []).includes('kid-friendly'),
  healthy: (recipe.sourceMetadata.modifiers ?? []).includes('healthy'),
});
const same = (a: Labels, b: Labels) =>
  [...a.mealTypes].sort().join() === [...b.mealTypes].sort().join() && a.kidFriendly === b.kidFriendly && a.healthy === b.healthy;
const hasManual = (recipe: CompleteCanonicalRecipeV2) =>
  recipe.manualOverrides?.mealTypes != null || recipe.manualOverrides?.modifiers != null;

const readyQuery = () => getFirestore().collection('recipes').where('status', '==', 'ready');

/** Ready catalogue recipes in pages, so a catalogue of any size never sits in memory at once. */
async function* readyPages(limit = Infinity, pageSize = 300): AsyncGenerator<CompleteCanonicalRecipeV2[]> {
  let cursor: string | undefined;
  let seen = 0;
  while (seen < limit) {
    let query = readyQuery().orderBy(FieldPath.documentId()).limit(Math.min(pageSize, limit - seen));
    if (cursor) query = query.startAfter(cursor);
    const snapshot = await query.get();
    if (snapshot.empty) return;
    cursor = snapshot.docs[snapshot.docs.length - 1].id;
    seen += snapshot.size;
    yield snapshot.docs
      .map((document) => ({ ...document.data(), id: document.id }) as CompleteCanonicalRecipeV2)
      .filter((recipe) => recipe.schemaVersion === 2 && !!recipe.content);
    if (snapshot.size < pageSize) return;
  }
}

/** Latest staged answer per recipe for the current question set. */
function staged(): Map<string, StagedRow> {
  const rows = new Map<string, StagedRow>();
  for (const row of lines<StagedRow>(STAGED)) if (row.questionSet === DECISION_QUESTION_SET) rows.set(row.id, row);
  return rows;
}

async function plan() {
  const total = (await readyQuery().count().get()).data().count;
  // Token use is estimated from the first page instead of reading every recipe.
  const sample: CompleteCanonicalRecipeV2[] = [];
  for await (const page of readyPages(300)) sample.push(...page);
  const questionChars = JSON.stringify(TAXONOMY_QUESTIONS).length;
  const tokensEach = sample.reduce((sum, r) => sum + Math.ceil((buildTaxonomyDecisionInput(r.content).length + questionChars) / 4), 0) / Math.max(1, sample.length);
  console.log(JSON.stringify({
    model: DECISION_MODEL,
    questionSet: DECISION_QUESTION_SET,
    readyRecipes: total,
    alreadyStaged: staged().size,
    manualOverridesInSample: `${sample.filter(hasManual).length} of ${sample.length}`,
    estimatedInputTokensPerRecipe: Math.round(tokensEach),
    estimatedUsd: +((total * tokensEach * USD_PER_MILLION_INPUT_TOKENS) / 1e6).toFixed(2),
    estimatedMinutesAt12Lanes: +((total * 0.45) / 12 / 60).toFixed(0),
    stagedFile: STAGED,
  }, null, 2));
}

async function stage() {
  const lanes = option('--lanes', 12);
  const maxUsd = option('--max-usd', 20);
  const done = new Map([...staged()].map(([id, row]) => [id, row.contentHash]));
  const apiKey = await loadGeminiKey();
  let usd = 0;
  let scanned = 0;
  let skipped = 0;
  let ok = 0;
  let failed = 0;
  let stopped = '';
  const started = Date.now();
  for await (const page of readyPages(option('--limit', Infinity))) {
    scanned += page.length;
    const todo = page.filter((r) => done.get(r.id) !== contentHash(r));
    skipped += page.length - todo.length;
    await mapInParallel(todo, lanes, async (recipe) => {
      if (stopped) return;
      if (usd >= maxUsd) {
        stopped = `reached --max-usd ${maxUsd}`;
        return;
      }
      try {
        let inputTokens = 0;
        const answers = await requestDecisions({
          apiKey,
          input: buildTaxonomyDecisionInput(recipe.content),
          questions: TAXONOMY_QUESTIONS,
          attempts: 5,
          onUsage: (usage) => { inputTokens = usage.inputTokens; },
        });
        const evidence = composeTaxonomyEvidence(answers);
        const row: StagedRow = {
          id: recipe.id, title: recipe.content.title, contentHash: contentHash(recipe), questionSet: DECISION_QUESTION_SET,
          evidence, before: labelsOf(recipe), after: deriveTaxonomyV2(evidence), manual: hasManual(recipe), inputTokens,
        };
        append(STAGED, row);
        usd += (inputTokens * USD_PER_MILLION_INPUT_TOKENS) / 1e6;
        ok += 1;
      } catch (error) {
        failed += 1;
        // A rejected key or model stops the run; anything else is retried on the next `stage`.
        if (error instanceof Error && /provider-http-(401|403|404)/.test(error.message)) stopped = error.message;
      }
    });
    console.log(JSON.stringify({ scanned, skippedAlreadyStaged: skipped, staged: ok, failed, usd: +usd.toFixed(4), seconds: Math.round((Date.now() - started) / 1000) }));
    if (stopped) break;
  }
  console.log(JSON.stringify({
    scanned, skippedAlreadyStaged: skipped, staged: ok, failed, stopped: stopped || false,
    usd: +usd.toFixed(4), seconds: +((Date.now() - started) / 1000).toFixed(1),
    next: failed || stopped ? 'run stage again to continue; finished recipes are skipped' : 'run diff',
  }, null, 2));
}

function diff() {
  const rows = [...staged().values()];
  if (!rows.length) throw new Error('Nothing staged yet; run stage first');
  const changed = rows.filter((r) => !same(r.before, r.after));
  const count = (pick: (l: Labels) => boolean, side: 'before' | 'after') => rows.filter((r) => pick(r[side])).length;
  const labels = ['breakfast', 'lunch', 'dinner', 'side', 'snack', 'dessert', 'component'];
  const table = [
    ...labels.map((l) => ({ label: l, before: count((x) => x.mealTypes.includes(l), 'before'), after: count((x) => x.mealTypes.includes(l), 'after') })),
    { label: 'healthy', before: count((x) => x.healthy, 'before'), after: count((x) => x.healthy, 'after') },
    { label: 'kid-friendly', before: count((x) => x.kidFriendly, 'before'), after: count((x) => x.kidFriendly, 'after') },
  ];
  const show = (l: Labels) => [...l.mealTypes, ...(l.healthy ? ['healthy'] : []), ...(l.kidFriendly ? ['kid-friendly'] : [])].join(', ') || '(none)';
  const report = {
    questionSet: DECISION_QUESTION_SET,
    staged: rows.length,
    wouldChange: changed.length,
    unchanged: rows.length - changed.length,
    changedButManuallyOverridden: changed.filter((r) => r.manual).length,
    mealTypesChange: rows.filter((r) => [...r.before.mealTypes].sort().join() !== [...r.after.mealTypes].sort().join()).length,
    healthyChange: rows.filter((r) => r.before.healthy !== r.after.healthy).length,
    kidFriendlyChange: rows.filter((r) => r.before.kidFriendly !== r.after.kidFriendly).length,
    labelCounts: table,
    examples: changed.slice(0, 25).map((r) => ({ title: r.title, before: show(r.before), after: show(r.after) })),
  };
  fs.writeFileSync(path.join(DIR, 'diff.json'), JSON.stringify({ ...report, changes: changed.map((r) => ({ id: r.id, title: r.title, before: show(r.before), after: show(r.after), manual: r.manual })) }, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

async function apply() {
  const confirm = flag('--confirm');
  const limit = option('--limit', Infinity);
  const already = new Set(lines<{ id: string; reverted?: boolean }>(APPLIED).filter((r) => !r.reverted).map((r) => r.id));
  const rows = [...staged().values()].filter((r) => !already.has(r.id)).slice(0, limit);
  const outcome = { written: 0, unchanged: 0, stale: 0, failed: 0, dryRun: !confirm };
  await mapInParallel(rows, 8, async (row) => {
    try {
      const reference = getFirestore().collection('recipes').doc(row.id);
      const result = await getFirestore().runTransaction(async (transaction) => {
        const snapshot = await transaction.get(reference);
        const recipe = { ...snapshot.data(), id: snapshot.id } as CompleteCanonicalRecipeV2;
        // Skip anything that changed since it was staged: stage it again instead.
        if (!snapshot.exists || recipe.schemaVersion !== 2 || recipe.status !== 'ready' || contentHash(recipe) !== row.contentHash) return 'stale' as const;
        const updated = applyTaxonomyV2Evidence(recipe, row.evidence);
        if (same(labelsOf(recipe), labelsOf(updated))) return 'unchanged' as const;
        if (!confirm) return 'written' as const;
        const fields = { sourceMetadata: updated.sourceMetadata, effective: updated.effective, search: updated.search, classification: updated.classification };
        transaction.update(reference, fields);
        return {
          before: { sourceMetadata: recipe.sourceMetadata, effective: recipe.effective, search: recipe.search, classification: recipe.classification },
          afterSourceMetadata: updated.sourceMetadata,
        };
      });
      if (result === 'stale') outcome.stale += 1;
      else if (result === 'unchanged') outcome.unchanged += 1;
      else {
        outcome.written += 1;
        if (result !== 'written') append(APPLIED, { id: row.id, at: new Date().toISOString(), ...result });
      }
    } catch {
      outcome.failed += 1;
    }
  });
  console.log(JSON.stringify({
    ...outcome,
    note: confirm ? `previous labels saved in ${APPLIED}` : '"written" is what apply --confirm would write; nothing was changed',
  }, null, 2));
}

async function revert() {
  if (!flag('--confirm')) throw new Error('revert restores the saved labels in Firestore; pass --confirm to proceed');
  const rows = lines<any>(APPLIED);
  const reverted = new Set(rows.filter((r) => r.reverted).map((r) => r.id));
  const outcome = { restored: 0, skippedChangedSince: 0, failed: 0 };
  await mapInParallel(rows.filter((r) => !r.reverted && !reverted.has(r.id)), 8, async (row) => {
    try {
      const reference = getFirestore().collection('recipes').doc(row.id);
      const restored = await getFirestore().runTransaction(async (transaction) => {
        const snapshot = await transaction.get(reference);
        // Only undo our own write; leave recipes someone has edited since.
        if (!snapshot.exists || JSON.stringify(snapshot.data()?.sourceMetadata) !== JSON.stringify(row.afterSourceMetadata)) return false;
        transaction.update(reference, row.before);
        return true;
      });
      if (restored) {
        outcome.restored += 1;
        append(APPLIED, { id: row.id, reverted: true, at: new Date().toISOString() });
      } else outcome.skippedChangedSince += 1;
    } catch {
      outcome.failed += 1;
    }
  });
  console.log(JSON.stringify(outcome, null, 2));
}

(async () => {
  const stage_ = process.argv[2];
  if (stage_ === 'diff') return diff();
  if (!['plan', 'stage', 'apply', 'revert'].includes(stage_)) throw new Error('Use plan, stage, diff, apply, or revert');
  initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID });
  if (stage_ === 'plan') await plan();
  if (stage_ === 'stage') await stage();
  if (stage_ === 'apply') await apply();
  if (stage_ === 'revert') await revert();
  // The Firestore client keeps the process alive; everything is flushed by now.
  process.exit(0);
})().catch((e) => {
  console.error(e instanceof Error ? e.message : 'Retag failed');
  process.exit(1);
});
