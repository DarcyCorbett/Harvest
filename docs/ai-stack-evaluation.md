# AI stack evaluation

This local tool compares the existing Gemini stack with `claude-haiku-5-5` and
`gpt-6-luna`. It does not change application providers or write to Firestore.
All outputs, source content, and references live in the gitignored
`artifacts/ai-stack-evaluation/` directory.

## Workflow

Use `node node_modules/tsx/dist/cli.mjs scripts/evaluate-ai-stack.ts <stage>`.

1. `node scripts/lib/aiEvaluationCollect.mjs` reads at most 4,000 public recipe
   records and saves content without existing model predictions. Google ADC must
   have read access to the catalogue and Gemini secret.
2. `prepare` selects 100 distinct recipes, creates recipe/substitution cases and
   30 constructed shopping lists through the existing measurement code. It
   refuses to overwrite an existing dataset. Selection candidates require chat
   review; record any stratum corrections before freezing the reference.
3. Author `benchmark.json` in the requested Astra-selected chat, using authoring
   packets that omit prior predictions. Use `Reference` in
   `scripts/lib/aiEvaluationCore.ts`; include a rationale and ambiguity flag for
   each case, and task-specific substitution rubrics. No paid judge is invoked.
4. `validate-benchmark` verifies coverage and freezes dataset/reference hashes.
5. `preflight` checks the exact model IDs without generating responses.
6. `pilot` runs three cases per available task and provider. Explicit
   `pilot --revise-pilot` permits adapter changes only before any main results
   exist. Earlier pilot results/costs are retained but excluded from the revised
   configuration's quality scores.
7. `run` completes one pass, two more runs of a fixed 20% subset, and then effort
   sweeps (shopping medium/xhigh; reminders/cuisine low). Each phase must finish
   across all providers before the next starts. Pilot successes/failures under
   the final configuration count in the main sample and are not silently retried.
8. `report` writes HTML, Markdown, JSON and randomized blind substitution packets.
   Grade `blind-review.json` in chat into `blind-scores.json`, keyed by `blindId`,
   with integer `suitability`, `adjustment`, `practicality`, `distinctness` (0–4)
   and a brief `rationale`. Keep `blind-map.json` closed during grading. Rerun
   `report` after grading. Add a reasoned recommendations artifact after review.

Use `--keys-file <path>` to override the user's supplied key file. Keys stay in
memory and request headers; do not put them in source, artifacts or command-line
arguments. Gemini uses `mealwizard-gemini-api-key` from Secret Manager.

## Controls and interpretation

- Separate $4.50 USD spending caps include both pilots, retries, reasoning and
  cache usage. An uncached UTF-8 byte upper bound plus framing allowance and
  maximum output tokens is reserved durably before each request. Requests over
  the conservative short-context bound are rejected. Unknown usage retains its
  reservation; known rejected requests with no usage release it.
- Two lanes per provider; one filesystem lock prevents overlapping runs. Do not
  remove `run.lock` unless its recorded PID is no longer running. Interrupted
  in-flight jobs keep their reservation and are not automatically repeated.
- One transient retry; JSON/schema/truncation failures are scored as failures.
  The ledger retains per-attempt usage and latency. Strict JSON parsing does not
  strip Markdown fences or otherwise repair candidate responses.
- Inputs, prompts, model settings and price snapshots are hashed. `run` refuses
  changed manifests. Recheck official prices before starting a later evaluation;
  the initial pricing snapshot is dated 2026-10-10.
- Quality comparisons use common attempted cases; unambiguous references are
  primary. F1 excludes unobserved labels rather than rewarding absent classes.
  Shopping pairwise F1 excludes true negatives, validates exact ID coverage and
  checks quantities and contributions after the actual shopping pipeline.
- Tagging/reminders use one recipe per request. These measurements do not
  represent production batching throughput. Shopping sizes are 3/5/7 recipes.
- Some catalogue data contains malformed quantities/names. Those are preserved,
  flagged in references, and shown to all models identically. No model is graded
  against information omitted from its actual task input.
- A catalogue cuisine fallback is tested only when source metadata and existing
  deterministic rules leave cuisine missing. A zero-case task is reported as
  unexercised, not as a perfect score.
- Costs are estimates derived from returned usage and official pricing, not
  billing invoices. Astra chat subscription usage is separate; no Astra API
  calls occur. AI-authored labels may share biases with candidate models.

Verification:

```
node node_modules/vitest/vitest.mjs run tests/aiStackEvaluation.test.ts
node node_modules/typescript/bin/tsc --ignoreConfig --noEmit --skipLibCheck --esModuleInterop --moduleResolution bundler --module esnext --target es2022 scripts/evaluate-ai-stack.ts
```

## Gemini 3.5 Flash-Lite extension

Use `node node_modules/tsx/dist/cli.mjs scripts/evaluate-gemini35.ts <stage>`
with `preflight`, `pilot`, `run`, and `report`. This reuses the frozen dataset
and benchmark while keeping its manifest, requests, ledger and reports under
`artifacts/ai-stack-evaluation/gemini-3.5-flash-lite/`. It does not rerun the
original candidates. Both runners share the same lock and the extension adds
the original Gemini ledger to its budget balance before every reservation.

The extension uses medium thinking for recipe tasks and high for shopping,
with 8,192/16,384 output allowances. It preserves the original Gemini task
content, JSON mode and temperature behavior. After the 300 main cases and 120
repeats, it compares minimal taxonomy (20 cases), low reminders (12), and medium
shopping (6). Gemini 3.5 Flash-Lite does not support extra-high effort.

The extension's blind-review packet mixes its 70 substitution answers with 70
randomly selected historical controls. Review the entire masked packet into
its own `blind-scores.json` using the same schema as the initial review. Keep
the new mapping closed while grading. Historical candidate scores are kept
unchanged, and control rescore drift is reported separately. Model styles can
still be recognizable; masking does not guarantee perfect blinding.

The combined four-stack report links from the original HTML report. Running
the original report generator later recreates that original page; run the
extension's `report` stage afterward to restore its banner link.

## Models the app uses

All model names live in `functions/src/ai/models.ts`.

| Feature | Model | Notes |
|---|---|---|
| Recipe tags, defrost/marinate reminders, catalogue taxonomy (callables, weekly catalogue job, nightly recipe-index tagger) | `gemini-decision-1` | One Decisions API request per recipe. Falls back to the `gemini-3.1-flash-lite` prompt if the request fails. Set `RECIPE_LABEL_ENGINE` to `'gemini'` to turn it off. |
| Shopping list grouping | `gemini-4-hydrogen`, thinking `low` | No temperature; `minimal` thinking is rejected. |
| Ingredient substitutions | `gpt-6-luna`, reasoning `medium` | OpenAI Responses API. Falls back to `gemini-3.1-flash-lite` if the request fails. |

`gemini-decision-1` returns probabilities and no text, so it cannot group a
shopping list or write substitutions. Provider fallbacks log
`ai_provider_fallback`.

Before deploying functions, create the OpenAI secret once (the deploy fails
without it):

```
firebase functions:secrets:set mealwizard-openai-api-key
```

The catalogue's Gemini Batch API paths (`geminiBatch.ts`,
`taxonomyRetagBatch.ts`) still use the prompt model: the Decisions API has no
batch mode. Use the retag script below for bulk relabelling.

## Gemini Decision 1 question set

The questions, cut-offs and answer composition are production code in
`functions/src/ai/decision.ts`. The Decisions API answers each question
independently, so rules that other models resolve by reasoning are stated in
each question or applied when the answers are combined: dinner accepts
unaccompanied mains, lunch is limited to midday dish types, each blocker is its
own yes/no question, the healthy restraint gate is split in three, defrost
excludes pre-cooked protein, and marinate covers long soaks.

Evaluate it with `node node_modules/tsx/dist/cli.mjs scripts/evaluate-decision1-v2.ts <stage>`;
the script imports the production module, so it measures what the app runs.
Outputs live under `artifacts/ai-stack-evaluation/gemini-decision-1-<set>/`,
where `<set>` is `DECISION_QUESTION_SET`. Bump that constant whenever a question
or cut-off changes; each set gets its own ledger and frozen manifest, and
earlier spend still counts toward the shared Gemini cap.

- `dev` runs the tuning half only (recipes are split by a recipe-level hash).
  Wording and cut-offs may change until `run` freezes the manifest. A job is
  identified by its exact request, so unchanged requests are never re-billed.
- `run` runs every case plus two repeats of every fifth.
- `report` scores v1 and the current set on each half against `benchmark.json`
  and, when `claude-fable-5-2/answers.json` exists, against that second answer
  set. Quote the holdout half.
- `fresh` runs cases from `fresh/dataset.json` (recipes outside the benchmark).
- `try "<title text>" [count]` labels up to ten matching recipes from
  `source-pool.json` and prints the result.

Set v4 (2026-11-14) only tightened two questions: soups, stews and salads are
never snacks, and sweet sauces, glazes and compotes fail added-sugar restraint.
On the 100-recipe catalogue sample it changed exactly those five recipes.

Do not fit a cut-off to a handful of positives: a Kid Friendly cut-off chosen
from four tuning examples missed 8 of 10 on the holdout half and was withdrawn.

## Shopping model check

`scripts/evaluate-hydrogen-shopping.ts run low medium` runs the shopping model
on every fifth frozen list through the production request path, and `report`
compares thinking levels with the previous model on the same lists. On six
lists `low` matched or beat `medium` for less time and cost, so production uses
`low`. Six lists is a sanity check, not a ranking.

## Retagging the catalogue with the decision model

`node node_modules/tsx/dist/cli.mjs scripts/retag-catalogue-decision.ts <stage>`
relabels meal types, healthy and kid-friendly on every ready catalogue recipe.
Cuisines and other modifiers are untouched and manual overrides keep winning.

1. `plan` counts recipes and estimates cost and time. No model calls, no writes.
2. `stage [--limit N] [--lanes N] [--max-usd N]` asks the model, one request per
   recipe with 12 in flight, and appends answers to
   `artifacts/catalogue-decision-retag/<set>/staged.jsonl`. It is resumable and
   stops at `--max-usd` (default 20). No Firestore writes.
3. `diff` summarises what would change from the staged answers.
4. `apply` counts what it would write; `apply --confirm` writes, skipping any
   recipe whose content changed since it was staged, and saves the previous
   labels to `applied.jsonl`.
5. `revert --confirm` restores those saved labels where nothing else has
   changed since.

Spend from this script is operational and is not counted in the evaluation cap.
