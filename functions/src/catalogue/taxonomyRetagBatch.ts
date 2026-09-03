import { createHash } from 'node:crypto';

import { FieldPath, getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';

import {
  buildEffectiveMetadata,
  buildSearchFields,
  validateReadyRecipe,
  type CompleteCanonicalRecipeV2,
  type Modifier,
} from './domain.js';
import type { GeminiBatchApi } from './geminiBatch.js';
import type { CatalogueBudget } from './ingestion.js';
import {
  TAXONOMY_V2_MODEL,
  TAXONOMY_V2_PROMPT_VERSION,
  TAXONOMY_V2_RESPONSE_JSON_SCHEMA,
  buildTaxonomyV2Prompt,
  parseAndDeriveTaxonomyV2,
  taxonomyV2PromptHash,
  type TaxonomyV2Evidence,
} from './taxonomyV2.js';

export const TAXONOMY_V2_BATCH_INPUT_USD_PER_MILLION = 0.125;
export const TAXONOMY_V2_BATCH_OUTPUT_USD_PER_MILLION = 0.75;
const MAX_RECIPES_PER_SHARD = 5_000;
const MAX_ESTIMATED_INPUT_TOKENS = 8_000_000;
const STATE_COLLECTION = 'catalogueTaxonomyRetagState';
const STATE_ID = 'taxonomy-v2';

interface RetagCandidate {
  id: string;
  contentHash: string;
  content: CompleteCanonicalRecipeV2['content'];
}

export interface TaxonomyRetagShard {
  index: number;
  recipeIds: string[];
  manifest: string;
  jsonl: string;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
}

interface StoredShard {
  index: number;
  inputPath: string;
  manifestPath: string;
  stagedPath?: string;
  recipeCount: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  status: 'prepared' | 'submitting' | 'submitted' | 'staged' | 'applied';
  fileName?: string;
  jobName?: string;
  applyCursor?: number;
  valid?: number;
  invalid?: number;
  failed?: number;
  actualInputTokens?: number;
  actualOutputTokens?: number;
  retryCount?: number;
}

interface RetagState {
  schemaVersion: 1;
  taxonomyVersion: 2;
  classifierVersion: 2;
  promptVersion: typeof TAXONOMY_V2_PROMPT_VERSION;
  promptHash: string;
  model: typeof TAXONOMY_V2_MODEL;
  runId: string;
  phase: 'prepared' | 'submitting' | 'submitted' | 'staged' | 'applying' | 'completed';
  recipeCount: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  shards: StoredShard[];
  fingerprints: RetagFingerprints;
  preparedAt: string;
  updatedAt: string;
}

interface Fingerprint {
  count: number;
  hash: string;
}

interface RetagFingerprints {
  recipeInvariants: Fingerprint;
  mealPlans: Fingerprint;
  cookbooks: Fingerprint;
}

interface StagedResult {
  key: string;
  contentHash: string;
  evidence: TaxonomyV2Evidence;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
}

function isReadyRecipe(value: unknown): value is CompleteCanonicalRecipeV2 {
  if (!value || typeof value !== 'object') return false;
  const recipe = value as Partial<CompleteCanonicalRecipeV2>;
  return recipe.schemaVersion === 2 && recipe.status === 'ready'
    && typeof recipe.id === 'string' && !!recipe.content;
}

export function recipeRequiresTaxonomyV2(recipe: CompleteCanonicalRecipeV2): boolean {
  return recipe.status === 'ready'
    && (recipe.classification.taxonomyVersion < 2
      || (recipe.classification.classifierVersion ?? 0) < 2);
}

function stableContentHash(recipe: CompleteCanonicalRecipeV2): string {
  return recipe.ingestion.contentHash
    ?? createHash('sha256').update(JSON.stringify(recipe.content), 'utf8').digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function recipeInvariant(recipe: CompleteCanonicalRecipeV2): unknown {
  const modifiers = (recipe.sourceMetadata.modifiers ?? [])
    .filter((modifier) => modifier !== 'kid-friendly' && modifier !== 'healthy');
  const { mealTypes: _mealTypes, modifiers: _modifiers, ...sourceMetadata } = recipe.sourceMetadata;
  return {
    id: recipe.id,
    schemaVersion: recipe.schemaVersion,
    status: recipe.status,
    source: recipe.source,
    ingestion: recipe.ingestion,
    content: recipe.content,
    sourceMetadata: { ...sourceMetadata, modifiers },
    manualOverrides: recipe.manualOverrides,
    search: {
      vegetarian: recipe.search.vegetarian,
      salad: recipe.search.salad,
      quick30: recipe.search.quick30,
      moderate45: recipe.search.moderate45,
      ingredientTokens: recipe.search.ingredientTokens,
      randomKey: recipe.search.randomKey,
    },
    parserVersion: recipe.classification.parserVersion,
    cuisineSource: recipe.classification.sources.cuisines,
  };
}

async function recipeInvariantFingerprint(): Promise<Fingerprint> {
  const hash = createHash('sha256');
  let count = 0;
  let cursor: string | undefined;
  while (true) {
    let query = getFirestore().collection('recipes').where('schemaVersion', '==', 2)
      .orderBy(FieldPath.documentId()).limit(500);
    if (cursor) query = query.startAfter(cursor);
    const snapshot = await query.get();
    for (const document of snapshot.docs) {
      cursor = document.id;
      const recipe = { ...document.data(), id: document.id };
      if (!isReadyRecipe(recipe)) continue;
      hash.update(document.id).update('\0').update(stableJson(recipeInvariant(recipe))).update('\n');
      count += 1;
    }
    if (snapshot.size < 500) break;
  }
  return { count, hash: hash.digest('hex') };
}

async function collectionGroupFingerprint(collectionId: string): Promise<Fingerprint> {
  const snapshot = await getFirestore().collectionGroup(collectionId).get();
  const documents = snapshot.docs
    .map((document) => ({ path: document.ref.path, data: document.data() }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const hash = createHash('sha256');
  for (const document of documents) {
    hash.update(document.path).update('\0').update(stableJson(document.data)).update('\n');
  }
  return { count: documents.length, hash: hash.digest('hex') };
}

async function captureRetagFingerprints(): Promise<RetagFingerprints> {
  const [recipeInvariants, mealPlans, cookbooks] = await Promise.all([
    recipeInvariantFingerprint(),
    collectionGroupFingerprint('mealPlan'),
    collectionGroupFingerprint('cookbook'),
  ]);
  return { recipeInvariants, mealPlans, cookbooks };
}

function equalFingerprint(left: Fingerprint, right: Fingerprint): boolean {
  return left.count === right.count && left.hash === right.hash;
}

function estimatedTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 4);
}

function requestLine(recipe: RetagCandidate): string {
  return JSON.stringify({
    key: recipe.id,
    request: {
      contents: [{ role: 'user', parts: [{ text: buildTaxonomyV2Prompt(recipe.content) }] }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 2_048,
        responseMimeType: 'application/json',
        responseJsonSchema: TAXONOMY_V2_RESPONSE_JSON_SCHEMA,
        thinkingConfig: { thinkingLevel: 'minimal' },
      },
    },
  });
}

export function buildTaxonomyRetagShards(
  candidates: readonly RetagCandidate[],
): TaxonomyRetagShard[] {
  const sorted = [...candidates].sort((left, right) => left.id.localeCompare(right.id));
  const result: TaxonomyRetagShard[] = [];
  let current: Array<{ candidate: RetagCandidate; line: string; tokens: number }> = [];
  let currentTokens = 0;
  const flush = (): void => {
    if (current.length === 0) return;
    result.push({
      index: result.length,
      recipeIds: current.map(({ candidate }) => candidate.id),
      manifest: `${current.map(({ candidate }) => JSON.stringify({
        key: candidate.id, contentHash: candidate.contentHash,
      })).join('\n')}\n`,
      jsonl: `${current.map(({ line }) => line).join('\n')}\n`,
      estimatedInputTokens: currentTokens,
      estimatedOutputTokens: current.length * 512,
    });
    current = [];
    currentTokens = 0;
  };
  for (const candidate of sorted) {
    const line = requestLine(candidate);
    const tokens = estimatedTokens(line);
    if (current.length > 0 && (current.length >= MAX_RECIPES_PER_SHARD
      || currentTokens + tokens > MAX_ESTIMATED_INPUT_TOKENS)) flush();
    current.push({ candidate, line, tokens });
    currentTokens += tokens;
  }
  flush();
  return result;
}

async function scanCandidates(): Promise<RetagCandidate[]> {
  const result: RetagCandidate[] = [];
  let cursor: string | undefined;
  while (true) {
    let query = getFirestore().collection('recipes')
      .where('schemaVersion', '==', 2)
      .orderBy(FieldPath.documentId())
      .limit(500);
    if (cursor) query = query.startAfter(cursor);
    const snapshot = await query.get();
    for (const document of snapshot.docs) {
      cursor = document.id;
      const recipe = { ...document.data(), id: document.id };
      if (isReadyRecipe(recipe) && recipeRequiresTaxonomyV2(recipe)) {
        result.push({
          id: recipe.id,
          contentHash: stableContentHash(recipe),
          content: recipe.content,
        });
      }
    }
    if (snapshot.size < 500) return result;
  }
}

function stateReference() {
  return getFirestore().collection(STATE_COLLECTION).doc(STATE_ID);
}

async function loadState(): Promise<RetagState> {
  const snapshot = await stateReference().get();
  if (!snapshot.exists) throw new Error('No prepared taxonomy-v2 batch');
  const state = snapshot.data() as RetagState;
  if (state.taxonomyVersion !== 2 || state.model !== TAXONOMY_V2_MODEL
    || state.promptHash !== taxonomyV2PromptHash()) {
    throw new Error('Taxonomy-v2 batch state is incompatible with the current classifier');
  }
  return state;
}

export async function prepareTaxonomyRetagBatch(options: {
  runId: string;
  bucketName?: string;
  now: () => Date;
}): Promise<object> {
  const bucketName = options.bucketName ?? process.env.CATALOGUE_MANIFEST_BUCKET;
  if (!bucketName) throw new Error('Catalogue manifest bucket is required');
  const prior = await stateReference().get();
  if (prior.exists && ['submitting', 'submitted', 'applying'].includes(prior.get('phase'))) {
    throw new Error('A taxonomy-v2 batch is already active');
  }
  const [candidates, fingerprints] = await Promise.all([
    scanCandidates(),
    captureRetagFingerprints(),
  ]);
  const shards = buildTaxonomyRetagShards(candidates);
  const bucket = getStorage().bucket(bucketName);
  const stored: StoredShard[] = [];
  for (const shard of shards) {
    const prefix = `taxonomy-v2/${options.runId}/shard-${String(shard.index).padStart(5, '0')}`;
    const inputPath = `${prefix}-input.jsonl`;
    const manifestPath = `${prefix}-manifest.jsonl`;
    await Promise.all([
      bucket.file(inputPath).save(shard.jsonl, {
        contentType: 'application/jsonl', resumable: false,
        preconditionOpts: { ifGenerationMatch: 0 },
      }),
      bucket.file(manifestPath).save(shard.manifest, {
        contentType: 'application/jsonl', resumable: false,
        preconditionOpts: { ifGenerationMatch: 0 },
      }),
    ]);
    stored.push({
      index: shard.index,
      inputPath,
      manifestPath,
      recipeCount: shard.recipeIds.length,
      estimatedInputTokens: shard.estimatedInputTokens,
      estimatedOutputTokens: shard.estimatedOutputTokens,
      status: 'prepared',
    });
  }
  const now = options.now().toISOString();
  const state: RetagState = {
    schemaVersion: 1,
    taxonomyVersion: 2,
    classifierVersion: 2,
    promptVersion: TAXONOMY_V2_PROMPT_VERSION,
    promptHash: taxonomyV2PromptHash(),
    model: TAXONOMY_V2_MODEL,
    runId: options.runId,
    phase: 'prepared',
    recipeCount: candidates.length,
    estimatedInputTokens: stored.reduce((sum, shard) => sum + shard.estimatedInputTokens, 0),
    estimatedOutputTokens: stored.reduce((sum, shard) => sum + shard.estimatedOutputTokens, 0),
    shards: stored,
    fingerprints,
    preparedAt: now,
    updatedAt: now,
  };
  await stateReference().set(state);
  return {
    mode: 'taxonomy-retag-prepare',
    runId: state.runId,
    recipeCount: state.recipeCount,
    shardCount: state.shards.length,
    promptHash: state.promptHash,
    estimatedInputTokens: state.estimatedInputTokens,
    estimatedOutputTokens: state.estimatedOutputTokens,
    estimatedCostUsd: Number((state.estimatedInputTokens / 1_000_000
      * TAXONOMY_V2_BATCH_INPUT_USD_PER_MILLION
      + state.estimatedOutputTokens / 1_000_000
      * TAXONOMY_V2_BATCH_OUTPUT_USD_PER_MILLION).toFixed(4)),
    requiresSubmissionConfirmation: true,
  };
}

export async function submitNextTaxonomyRetagBatch(options: {
  api: GeminiBatchApi;
  bucketName?: string;
  now: () => Date;
}): Promise<object> {
  const bucketName = options.bucketName ?? process.env.CATALOGUE_MANIFEST_BUCKET;
  if (!bucketName) throw new Error('Catalogue manifest bucket is required');
  const state = await loadState();
  if (state.phase === 'submitting') throw new Error('Batch submission is indeterminate');
  if (state.shards.some(({ status }) => status === 'submitted')) {
    throw new Error('Only one taxonomy-v2 shard may be active');
  }
  const incomplete = state.shards.find(({ status, invalid = 0, failed = 0 }) =>
    status === 'staged' && invalid + failed > 0);
  if (incomplete) {
    if (!incomplete.stagedPath) throw new Error('Incomplete shard has no staged checkpoint');
    const bucket = getStorage().bucket(bucketName);
    const [[inputBuffer], [manifestBuffer], [stagedBuffer]] = await Promise.all([
      bucket.file(incomplete.inputPath).download(),
      bucket.file(incomplete.manifestPath).download(),
      bucket.file(incomplete.stagedPath).download(),
    ]);
    const stagedKeys = new Set(stagedBuffer.toString('utf8').split(/\r?\n/).filter(Boolean)
      .map((line) => (JSON.parse(line) as StagedResult).key));
    const retryManifest = manifestBuffer.toString('utf8').split(/\r?\n/).filter(Boolean)
      .filter((line) => !stagedKeys.has((JSON.parse(line) as { key: string }).key));
    const retryKeys = new Set(retryManifest
      .map((line) => (JSON.parse(line) as { key: string }).key));
    const retryInput = inputBuffer.toString('utf8').split(/\r?\n/).filter(Boolean)
      .filter((line) => retryKeys.has((JSON.parse(line) as { key: string }).key));
    if (retryManifest.length === 0 || retryInput.length !== retryManifest.length) {
      throw new Error('Invalid taxonomy-v2 retry checkpoint');
    }
    incomplete.retryCount = (incomplete.retryCount ?? 0) + 1;
    const suffix = `retry-${incomplete.retryCount}`;
    const prefix = `taxonomy-v2/${state.runId}/shard-${String(incomplete.index).padStart(5, '0')}-${suffix}`;
    incomplete.inputPath = `${prefix}-input.jsonl`;
    incomplete.manifestPath = `${prefix}-manifest.jsonl`;
    incomplete.recipeCount = retryManifest.length;
    incomplete.invalid = 0;
    incomplete.failed = 0;
    incomplete.status = 'prepared';
    await Promise.all([
      bucket.file(incomplete.inputPath).save(`${retryInput.join('\n')}\n`, {
        contentType: 'application/jsonl', resumable: false,
        preconditionOpts: { ifGenerationMatch: 0 },
      }),
      bucket.file(incomplete.manifestPath).save(`${retryManifest.join('\n')}\n`, {
        contentType: 'application/jsonl', resumable: false,
        preconditionOpts: { ifGenerationMatch: 0 },
      }),
    ]);
  }
  const shard = state.shards.find(({ status }) => status === 'prepared');
  if (!shard) return { mode: 'taxonomy-retag-submit', status: 'nothing-to-submit' };
  shard.status = 'submitting';
  state.phase = 'submitting';
  state.updatedAt = options.now().toISOString();
  await stateReference().set(state);
  const [contents] = await getStorage().bucket(bucketName).file(shard.inputPath).download();
  const retrySuffix = shard.retryCount ? `-retry-${shard.retryCount}` : '';
  const displayName = `mealwizard-taxonomy-v2-${state.runId}-${String(shard.index).padStart(5, '0')}${retrySuffix}`;
  shard.fileName = await options.api.uploadJsonl(displayName, contents);
  shard.jobName = await options.api.createBatch(shard.fileName, displayName);
  shard.status = 'submitted';
  state.phase = 'submitted';
  state.updatedAt = options.now().toISOString();
  await stateReference().set(state);
  return { mode: 'taxonomy-retag-submit', status: 'submitted', shard: shard.index };
}

function responseText(value: unknown): string | undefined {
  const envelope = value as {
    response?: { candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }> };
  };
  return envelope.response?.candidates?.[0]?.content?.parts
    ?.filter(({ text, thought }) => typeof text === 'string' && thought !== true)
    .map(({ text }) => text).join('');
}

function responseUsage(value: unknown): StagedResult['usage'] {
  const usage = (value as { response?: { usageMetadata?: Record<string, unknown> } })
    .response?.usageMetadata ?? {};
  const number = (key: string): number => typeof usage[key] === 'number' ? usage[key] as number : 0;
  return {
    inputTokens: number('promptTokenCount'),
    outputTokens: number('candidatesTokenCount') + number('thoughtsTokenCount'),
    totalTokens: number('totalTokenCount'),
  };
}

export async function stageNextTaxonomyRetagBatch(options: {
  api: GeminiBatchApi;
  bucketName?: string;
  now: () => Date;
}): Promise<object> {
  const bucketName = options.bucketName ?? process.env.CATALOGUE_MANIFEST_BUCKET;
  if (!bucketName) throw new Error('Catalogue manifest bucket is required');
  const state = await loadState();
  const shard = state.shards.find(({ status }) => status === 'submitted');
  if (!shard?.jobName) return { mode: 'taxonomy-retag-stage', status: 'nothing-to-stage' };
  const job = await options.api.getBatch(shard.jobName);
  if (!['BATCH_STATE_SUCCEEDED', 'JOB_STATE_SUCCEEDED'].includes(job.state)) {
    return { mode: 'taxonomy-retag-stage', status: job.state, error: job.error };
  }
  if (!job.resultFileName) throw new Error('Completed Gemini batch has no result file');
  const bucket = getStorage().bucket(bucketName);
  const [manifestBuffer, output, priorStagedBuffer] = await Promise.all([
    bucket.file(shard.manifestPath).download().then(([value]) => value),
    options.api.downloadFile(job.resultFileName),
    shard.stagedPath
      ? bucket.file(shard.stagedPath).download().then(([value]) => value)
      : Promise.resolve(undefined),
  ]);
  const manifest = new Map(manifestBuffer.toString('utf8').split(/\r?\n/).filter(Boolean)
    .map((line) => {
      const entry = JSON.parse(line) as { key: string; contentHash: string };
      return [entry.key, entry.contentHash] as const;
    }));
  const seen = new Set<string>();
  const priorStaged = priorStagedBuffer
    ? priorStagedBuffer.toString('utf8').split(/\r?\n/).filter(Boolean)
      .map((line) => JSON.parse(line) as StagedResult)
    : [];
  const staged: StagedResult[] = [];
  let invalid = 0;
  let failed = 0;
  let actualInputTokens = 0;
  let actualOutputTokens = 0;
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    let envelope: { key?: string; error?: unknown };
    try {
      envelope = JSON.parse(line) as { key?: string; error?: unknown };
    } catch {
      invalid += 1;
      continue;
    }
    if (!envelope.key || !manifest.has(envelope.key) || seen.has(envelope.key)) {
      invalid += 1;
      continue;
    }
    seen.add(envelope.key);
    try {
      const text = responseText(envelope);
      if (!text) throw new Error('missing-response');
      const { evidence } = parseAndDeriveTaxonomyV2(JSON.parse(text));
      const usage = responseUsage(envelope);
      actualInputTokens += usage.inputTokens;
      actualOutputTokens += usage.outputTokens;
      staged.push({ key: envelope.key, contentHash: manifest.get(envelope.key)!, evidence, usage });
    } catch {
      if (envelope.error) failed += 1;
      else invalid += 1;
      await bucket.file(`taxonomy-v2/${state.runId}/raw-invalid/${envelope.key}.json`)
        .save(line, { contentType: 'application/json', resumable: false });
    }
  }
  failed += shard.recipeCount - seen.size;
  const stagedPath = `taxonomy-v2/${state.runId}/shard-${String(shard.index).padStart(5, '0')}-staged.jsonl`;
  const combined = [...priorStaged, ...staged];
  await bucket.file(stagedPath).save(`${combined.map((entry) => JSON.stringify(entry)).join('\n')}\n`, {
    contentType: 'application/jsonl', resumable: false,
    ...(!shard.stagedPath ? { preconditionOpts: { ifGenerationMatch: 0 } } : {}),
  });
  shard.stagedPath = stagedPath;
  shard.status = 'staged';
  shard.valid = combined.length;
  shard.invalid = invalid;
  shard.failed = failed;
  shard.actualInputTokens = (shard.actualInputTokens ?? 0) + actualInputTokens;
  shard.actualOutputTokens = (shard.actualOutputTokens ?? 0) + actualOutputTokens;
  state.phase = state.shards.every(({ status }) => status === 'staged') ? 'staged' : 'prepared';
  state.updatedAt = options.now().toISOString();
  await stateReference().set(state);
  return {
    mode: 'taxonomy-retag-stage', status: state.phase, shard: shard.index,
    valid: staged.length, invalid, failed,
    actualInputTokens, actualOutputTokens,
  };
}

function hasManualList(value: readonly unknown[] | null | undefined): boolean {
  return value !== null && value !== undefined;
}

export function applyTaxonomyV2Evidence(
  recipe: CompleteCanonicalRecipeV2,
  evidence: TaxonomyV2Evidence,
): CompleteCanonicalRecipeV2 {
  const { derived } = parseAndDeriveTaxonomyV2(evidence);
  const preservedModifiers = (recipe.sourceMetadata.modifiers ?? [])
    .filter((modifier): modifier is Modifier => modifier !== 'kid-friendly' && modifier !== 'healthy');
  const sourceMetadata = {
    ...recipe.sourceMetadata,
    mealTypes: derived.mealTypes,
    modifiers: [
      ...preservedModifiers,
      ...(derived.kidFriendly ? ['kid-friendly' as const] : []),
      ...(derived.healthy ? ['healthy' as const] : []),
    ],
  };
  const effective = buildEffectiveMetadata(sourceMetadata, recipe.manualOverrides);
  const updated: CompleteCanonicalRecipeV2 = {
    ...recipe,
    sourceMetadata,
    effective,
    search: buildSearchFields(
      effective,
      recipe.content.ingredients.map(({ name }) => name),
      recipe.search.randomKey,
    ),
    classification: {
      ...recipe.classification,
      classifierVersion: 2,
      taxonomyVersion: 2,
      sources: {
        ...recipe.classification.sources,
        mealTypes: hasManualList(recipe.manualOverrides?.mealTypes) ? 'manual' : 'ai',
        modifiers: hasManualList(recipe.manualOverrides?.modifiers) ? 'manual' : 'ai',
      },
      complete: effective.mealTypes.length > 0 && effective.cuisines.length > 0,
    },
  };
  const errors = validateReadyRecipe(updated);
  if (errors.length > 0) throw new Error(`Taxonomy-v2 ready invariant failed: ${errors.join(', ')}`);
  return updated;
}

export async function applyStagedTaxonomyRetag(options: {
  budget: CatalogueBudget;
  bucketName?: string;
  now: () => Date;
}): Promise<object> {
  const bucketName = options.bucketName ?? process.env.CATALOGUE_MANIFEST_BUCKET;
  if (!bucketName) throw new Error('Catalogue manifest bucket is required');
  const state = await loadState();
  if (state.shards.some(({ status }) => ['prepared', 'submitting', 'submitted'].includes(status))) {
    throw new Error('Every taxonomy-v2 shard must be staged before writes begin');
  }
  const shard = state.shards.find(({ status }) => status === 'staged');
  if (!shard?.stagedPath) return { mode: 'taxonomy-retag-apply', status: 'nothing-to-apply' };
  const [buffer] = await getStorage().bucket(bucketName).file(shard.stagedPath).download();
  const entries = buffer.toString('utf8').split(/\r?\n/).filter(Boolean)
    .map((line) => JSON.parse(line) as StagedResult);
  const start = shard.applyCursor ?? 0;
  const reservation = await options.budget.reserve(entries.length - start, options.now());
  let written = 0;
  let alreadyCurrent = 0;
  let stale = 0;
  let failed = 0;
  let cursor = start;
  for (; cursor < entries.length && written < reservation.granted; cursor += 1) {
    const entry = entries[cursor];
    try {
      const reference = getFirestore().collection('recipes').doc(entry.key);
      const outcome = await getFirestore().runTransaction(async (transaction) => {
        const snapshot = await transaction.get(reference);
        const recipe = { ...snapshot.data(), id: snapshot.id };
        if (!snapshot.exists || !isReadyRecipe(recipe)) return 'stale';
        if (!recipeRequiresTaxonomyV2(recipe)) return 'already-current';
        if (stableContentHash(recipe) !== entry.contentHash) return 'stale';
        transaction.set(reference, applyTaxonomyV2Evidence(recipe, entry.evidence));
        return 'written';
      });
      if (outcome === 'written') written += 1;
      else if (outcome === 'already-current') alreadyCurrent += 1;
      else stale += 1;
    } catch {
      failed += 1;
    }
  }
  shard.applyCursor = cursor;
  if (cursor >= entries.length) shard.status = 'applied';
  state.phase = state.shards.every(({ status }) => status === 'applied') ? 'completed' : 'applying';
  state.updatedAt = options.now().toISOString();
  await stateReference().set(state);
  return {
    mode: 'taxonomy-retag-apply', status: state.phase, shard: shard.index,
    quotaDate: reservation.quotaDate, written, alreadyCurrent, stale, failed,
    remainingInShard: entries.length - cursor,
  };
}

export async function verifyTaxonomyRetag(): Promise<object> {
  const state = await loadState();
  const fingerprints = await captureRetagFingerprints();
  let ready = 0;
  let current = 0;
  let invalidCombinations = 0;
  let invalidReady = 0;
  const counts: Record<string, number> = {};
  let cursor: string | undefined;
  while (true) {
    let query = getFirestore().collection('recipes').where('schemaVersion', '==', 2)
      .orderBy(FieldPath.documentId()).limit(500);
    if (cursor) query = query.startAfter(cursor);
    const snapshot = await query.get();
    for (const document of snapshot.docs) {
      cursor = document.id;
      const recipe = { ...document.data(), id: document.id };
      if (!isReadyRecipe(recipe)) continue;
      ready += 1;
      if (!recipeRequiresTaxonomyV2(recipe)) current += 1;
      if (validateReadyRecipe(recipe).length > 0) invalidReady += 1;
      if (recipe.effective.mealTypes.includes('component') && recipe.effective.mealTypes.length > 1) {
        invalidCombinations += 1;
      }
      for (const mealType of recipe.effective.mealTypes) counts[mealType] = (counts[mealType] ?? 0) + 1;
    }
    if (snapshot.size < 500) break;
  }
  return {
    mode: 'taxonomy-retag-verify',
    runId: state.runId,
    phase: state.phase,
    ready,
    current,
    remaining: ready - current,
    invalidReady,
    invalidCombinations,
    counts,
    fingerprints: {
      recipeInvariantsUnchanged: equalFingerprint(
        state.fingerprints.recipeInvariants, fingerprints.recipeInvariants,
      ),
      mealPlansUnchanged: equalFingerprint(state.fingerprints.mealPlans, fingerprints.mealPlans),
      cookbooksUnchanged: equalFingerprint(state.fingerprints.cookbooks, fingerprints.cookbooks),
      before: state.fingerprints,
      after: fingerprints,
    },
  };
}
