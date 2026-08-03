import { FieldPath, getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';

import {
  CUISINES,
  MEAL_TYPES,
  MODIFIERS,
  type CompleteCanonicalRecipeV2,
  type Cuisine,
  type MealType,
  type Modifier,
} from './domain.js';
import { classifyStoredRecipe } from './backfill.js';
import type { StoredRecipeClassifier } from './backfill.js';
import type { CatalogueBudget } from './ingestion.js';
import { hasDisplayContent } from './snapshotFirestore.js';
import { isFrozenCatalogueSource } from './sourceAdapters.js';

export const GEMINI_BATCH_MODEL = 'gemini-3.1-flash-lite';
export const MAX_BATCH_RECIPES = 5_000;
export const MAX_BATCH_ESTIMATED_TOKENS = 8_000_000;
export const GEMINI_BATCH_INPUT_USD_PER_MILLION = 0.125;
export const GEMINI_BATCH_OUTPUT_USD_PER_MILLION = 0.75;

export interface AiBacklogRecipe {
  id: string;
  contentHash?: string;
  title: string;
  ingredients: string[];
}

export interface GeminiBatchShard {
  index: number;
  recipeIds: string[];
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  jsonl: string;
}

interface BatchStateShard {
  index: number;
  objectPath: string;
  recipeCount: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  status: 'prepared' | 'submitting' | 'submitted' | 'completed';
  fileName?: string;
  jobName?: string;
}

interface BatchState {
  schemaVersion: 1;
  runId: string;
  model: typeof GEMINI_BATCH_MODEL;
  phase: 'prepared' | 'submitting' | 'submitted' | 'completed';
  recipeCount: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  shards: BatchStateShard[];
  preparedAt: string;
  updatedAt: string;
}

function isCompleteRecipe(value: unknown): value is CompleteCanonicalRecipeV2 {
  if (!value || typeof value !== 'object') return false;
  const recipe = value as Partial<CompleteCanonicalRecipeV2>;
  return recipe.schemaVersion === 2
    && (recipe.status === 'ready' || recipe.status === 'review')
    && typeof recipe.id === 'string';
}

export function recipeRequiresAi(recipe: CompleteCanonicalRecipeV2): boolean {
  return !isFrozenCatalogueSource(recipe.source.key)
    && hasDisplayContent(recipe)
    && (recipe.effective.mealTypes.length === 0 || recipe.effective.cuisines.length === 0);
}

function classificationPrompt(recipe: AiBacklogRecipe): string {
  return [
    'Classify this recipe using only the fixed taxonomy.',
    `mealTypes: ${MEAL_TYPES.join(', ')}`,
    `cuisines: ${CUISINES.join(', ')}`,
    `modifiers: ${MODIFIERS.join(', ')}`,
    `Title: ${recipe.title.slice(0, 200)}`,
    `Ingredients: ${recipe.ingredients.join(', ').slice(0, 4_000)}`,
    'Return mealTypes, cuisines, and modifiers arrays. Do not return other fields.',
  ].join('\n');
}

function requestLine(recipe: AiBacklogRecipe): string {
  return JSON.stringify({
    key: recipe.id,
    request: {
      contents: [{ role: 'user', parts: [{ text: classificationPrompt(recipe) }] }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 256,
        responseMimeType: 'application/json',
        responseJsonSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['mealTypes', 'cuisines', 'modifiers'],
          properties: {
            mealTypes: { type: 'array', items: { type: 'string', enum: MEAL_TYPES } },
            cuisines: { type: 'array', items: { type: 'string', enum: CUISINES } },
            modifiers: { type: 'array', items: { type: 'string', enum: MODIFIERS } },
          },
        },
      },
    },
  });
}

function estimatedTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 4);
}

export function buildGeminiBatchShards(
  recipes: readonly AiBacklogRecipe[],
): GeminiBatchShard[] {
  const sorted = [...recipes].sort((left, right) => left.id.localeCompare(right.id));
  const shards: GeminiBatchShard[] = [];
  let lines: string[] = [];
  let ids: string[] = [];
  let inputTokens = 0;
  const flush = (): void => {
    if (ids.length === 0) return;
    shards.push({
      index: shards.length,
      recipeIds: ids,
      estimatedInputTokens: inputTokens,
      estimatedOutputTokens: ids.length * 128,
      jsonl: `${lines.join('\n')}\n`,
    });
    lines = [];
    ids = [];
    inputTokens = 0;
  };
  for (const recipe of sorted) {
    const line = requestLine(recipe);
    const tokens = estimatedTokens(line);
    if (ids.length > 0 && (ids.length >= MAX_BATCH_RECIPES
      || inputTokens + tokens > MAX_BATCH_ESTIMATED_TOKENS)) {
      flush();
    }
    lines.push(line);
    ids.push(recipe.id);
    inputTokens += tokens;
  }
  flush();
  return shards;
}

async function scanAiBacklog(): Promise<AiBacklogRecipe[]> {
  const db = getFirestore();
  const result: AiBacklogRecipe[] = [];
  let cursor: string | undefined;
  while (true) {
    let query = db.collection('recipes').where('schemaVersion', '==', 2)
      .orderBy(FieldPath.documentId()).limit(500);
    if (cursor) query = query.startAfter(cursor);
    const snapshot = await query.get();
    for (const document of snapshot.docs) {
      cursor = document.id;
      const value = { ...document.data(), id: document.id };
      if (isCompleteRecipe(value) && recipeRequiresAi(value)) {
        result.push({
          id: document.id,
          ...(value.ingestion.contentHash
            ? { contentHash: value.ingestion.contentHash }
            : {}),
          title: value.content.title,
          ingredients: value.content.ingredients.map(({ name }) => name),
        });
      }
    }
    if (snapshot.size < 500) return result;
  }
}

function batchStateReference() {
  return getFirestore().collection('catalogueTagBatchState').doc('initial-backfill');
}

export async function prepareGeminiTagBatch(options: {
  runId: string;
  bucketName?: string;
  now: () => Date;
}): Promise<{
  mode: 'tag-batch-prepare';
  runId: string;
  recipeCount: number;
  shardCount: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedCostUsd: number;
  targetCompletionHours: number;
  requiresSubmissionConfirmation: true;
}> {
  const bucketName = options.bucketName ?? process.env.CATALOGUE_MANIFEST_BUCKET;
  if (!bucketName) throw new Error('Catalogue manifest bucket is required');
  const reference = batchStateReference();
  const existing = await reference.get();
  if (existing.exists && ['submitting', 'submitted'].includes(existing.get('phase'))) {
    throw new Error('An initial backfill batch is already active');
  }
  const backlog = await scanAiBacklog();
  const shards = buildGeminiBatchShards(backlog);
  const bucket = getStorage().bucket(bucketName);
  const stateShards: BatchStateShard[] = [];
  for (const shard of shards) {
    const objectPath = `tag-batches/${options.runId}/shard-${String(shard.index).padStart(5, '0')}.jsonl`;
    await bucket.file(objectPath).save(shard.jsonl, {
      contentType: 'application/jsonl',
      resumable: false,
      preconditionOpts: { ifGenerationMatch: 0 },
    });
    stateShards.push({
      index: shard.index,
      objectPath,
      recipeCount: shard.recipeIds.length,
      estimatedInputTokens: shard.estimatedInputTokens,
      estimatedOutputTokens: shard.estimatedOutputTokens,
      status: 'prepared',
    });
  }
  const estimatedInputTokens = shards.reduce(
    (total, shard) => total + shard.estimatedInputTokens, 0);
  const estimatedOutputTokens = shards.reduce(
    (total, shard) => total + shard.estimatedOutputTokens, 0);
  const now = options.now().toISOString();
  const state: BatchState = {
    schemaVersion: 1,
    runId: options.runId,
    model: GEMINI_BATCH_MODEL,
    phase: 'prepared',
    recipeCount: backlog.length,
    estimatedInputTokens,
    estimatedOutputTokens,
    shards: stateShards,
    preparedAt: now,
    updatedAt: now,
  };
  await reference.set(state);
  return {
    mode: 'tag-batch-prepare',
    runId: options.runId,
    recipeCount: backlog.length,
    shardCount: shards.length,
    estimatedInputTokens,
    estimatedOutputTokens,
    estimatedCostUsd: Number((
      estimatedInputTokens / 1_000_000 * GEMINI_BATCH_INPUT_USD_PER_MILLION
      + estimatedOutputTokens / 1_000_000 * GEMINI_BATCH_OUTPUT_USD_PER_MILLION
    ).toFixed(4)),
    targetCompletionHours: 24,
    requiresSubmissionConfirmation: true,
  };
}

function requiredHeader(response: Response, name: string): string {
  const value = response.headers.get(name);
  if (!value) throw new Error(`Gemini response missing ${name}`);
  return value;
}

export interface GeminiBatchApi {
  uploadJsonl(displayName: string, contents: Buffer): Promise<string>;
  createBatch(fileName: string, displayName: string): Promise<string>;
  getBatch(jobName: string): Promise<{
    state: string;
    resultFileName?: string;
    error?: unknown;
  }>;
  downloadFile(fileName: string): Promise<string>;
}

export function isSuccessfulGeminiBatchState(state: string): boolean {
  return state === 'BATCH_STATE_SUCCEEDED' || state === 'JOB_STATE_SUCCEEDED';
}

export function createGeminiBatchApi(options: {
  apiKey: string;
  fetchImpl?: typeof fetch;
}): GeminiBatchApi {
  if (!options.apiKey.trim()) throw new Error('provider-secret-missing');
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers = { 'x-goog-api-key': options.apiKey };
  return {
    async uploadJsonl(displayName, contents) {
      const started = await fetchImpl(
        'https://generativelanguage.googleapis.com/upload/v1beta/files',
        {
          method: 'POST',
          headers: {
            ...headers,
            'X-Goog-Upload-Protocol': 'resumable',
            'X-Goog-Upload-Command': 'start',
            'X-Goog-Upload-Header-Content-Length': String(contents.byteLength),
            'X-Goog-Upload-Header-Content-Type': 'application/jsonl',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ file: { display_name: displayName } }),
        },
      );
      if (!started.ok) throw new Error(`provider-upload-start-${started.status}`);
      const uploaded = await fetchImpl(requiredHeader(started, 'x-goog-upload-url'), {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Length': String(contents.byteLength),
          'X-Goog-Upload-Offset': '0',
          'X-Goog-Upload-Command': 'upload, finalize',
        },
        body: new Uint8Array(contents),
      });
      if (!uploaded.ok) throw new Error(`provider-upload-${uploaded.status}`);
      const envelope = await uploaded.json() as { file?: { name?: string } };
      if (!envelope.file?.name) throw new Error('provider-upload-invalid-response');
      return envelope.file.name;
    },
    async createBatch(fileName, displayName) {
      const response = await fetchImpl(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_BATCH_MODEL}:batchGenerateContent`,
        {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            batch: {
              display_name: displayName,
              input_config: { file_name: fileName },
            },
          }),
        },
      );
      if (!response.ok) throw new Error(`provider-batch-create-${response.status}`);
      const envelope = await response.json() as { name?: string };
      if (!envelope.name) throw new Error('provider-batch-create-invalid-response');
      return envelope.name;
    },
    async getBatch(jobName) {
      const response = await fetchImpl(
        `https://generativelanguage.googleapis.com/v1beta/${jobName}`,
        { headers },
      );
      if (!response.ok) throw new Error(`provider-batch-get-${response.status}`);
      const envelope = await response.json() as {
        state?: string;
        metadata?: { state?: string };
        dest?: { fileName?: string };
        response?: { responsesFile?: string };
        error?: unknown;
      };
      return {
        state: envelope.state ?? envelope.metadata?.state ?? 'JOB_STATE_UNSPECIFIED',
        ...(envelope.dest?.fileName || envelope.response?.responsesFile
          ? { resultFileName: envelope.dest?.fileName ?? envelope.response?.responsesFile }
          : {}),
        ...(envelope.error ? { error: envelope.error } : {}),
      };
    },
    async downloadFile(fileName) {
      const response = await fetchImpl(
        `https://generativelanguage.googleapis.com/download/v1beta/${fileName}:download?alt=media`,
        { headers },
      );
      if (!response.ok) throw new Error(`provider-file-download-${response.status}`);
      return response.text();
    },
  };
}

async function loadBatchState(): Promise<BatchState> {
  const snapshot = await batchStateReference().get();
  if (!snapshot.exists) throw new Error('No prepared initial backfill batch');
  return snapshot.data() as BatchState;
}

export async function submitNextGeminiTagBatch(options: {
  api: GeminiBatchApi;
  bucketName?: string;
  now: () => Date;
}): Promise<object> {
  const bucketName = options.bucketName ?? process.env.CATALOGUE_MANIFEST_BUCKET;
  if (!bucketName) throw new Error('Catalogue manifest bucket is required');
  const reference = batchStateReference();
  const state = await loadBatchState();
  if (state.phase === 'submitting') {
    throw new Error('Batch submission is indeterminate; reconcile the provider job before retrying');
  }
  if (state.shards.some(({ status }) => status === 'submitted')) {
    throw new Error('Only one initial backfill batch may be active');
  }
  const shard = state.shards.find(({ status }) => status === 'prepared');
  if (!shard) return { mode: 'tag-batch-submit', status: 'nothing-to-submit' };
  shard.status = 'submitting';
  state.phase = 'submitting';
  state.updatedAt = options.now().toISOString();
  await reference.set(state);

  const [contents] = await getStorage().bucket(bucketName).file(shard.objectPath).download();
  const displayName = `mealwizard-${state.runId}-${String(shard.index).padStart(5, '0')}`;
  const fileName = await options.api.uploadJsonl(displayName, contents);
  shard.fileName = fileName;
  state.updatedAt = options.now().toISOString();
  await reference.set(state);
  const jobName = await options.api.createBatch(fileName, displayName);
  shard.status = 'submitted';
  shard.fileName = fileName;
  shard.jobName = jobName;
  state.phase = 'submitted';
  state.updatedAt = options.now().toISOString();
  await reference.set(state);
  return { mode: 'tag-batch-submit', status: 'submitted', shard: shard.index, jobName };
}

function validValues<T extends string>(
  value: unknown,
  allowed: readonly T[],
  required: boolean,
): value is T[] {
  return Array.isArray(value)
    && (!required || value.length > 0)
    && value.length <= allowed.length
    && new Set(value).size === value.length
    && value.every((entry) => typeof entry === 'string' && allowed.includes(entry as T));
}

function parseClassification(raw: string): {
  mealTypes: MealType[];
  cuisines: Cuisine[];
  modifiers: Modifier[];
} | undefined {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (Object.keys(value).some((key) =>
      !['mealTypes', 'cuisines', 'modifiers'].includes(key))
      || !validValues(value.mealTypes, MEAL_TYPES, true)
      || !validValues(value.cuisines, CUISINES, true)
      || !validValues(value.modifiers, MODIFIERS, false)) return undefined;
    return value as {
      mealTypes: MealType[];
      cuisines: Cuisine[];
      modifiers: Modifier[];
    };
  } catch {
    return undefined;
  }
}

function responseText(value: unknown): string | undefined {
  const envelope = value as {
    response?: { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  };
  return envelope.response?.candidates?.[0]?.content?.parts
    ?.find(({ text }) => typeof text === 'string')?.text;
}

export async function collectGeminiTagBatch(options: {
  api: GeminiBatchApi;
  budget: CatalogueBudget;
  bucketName?: string;
  now: () => Date;
}): Promise<object> {
  const bucketName = options.bucketName ?? process.env.CATALOGUE_MANIFEST_BUCKET;
  if (!bucketName) throw new Error('Catalogue manifest bucket is required');
  const state = await loadBatchState();
  const shard = state.shards.find(({ status }) => status === 'submitted');
  if (!shard?.jobName) return { mode: 'tag-batch-collect', status: 'nothing-to-collect' };
  const job = await options.api.getBatch(shard.jobName);
  if (!isSuccessfulGeminiBatchState(job.state)) {
    return { mode: 'tag-batch-collect', status: job.state, error: job.error };
  }
  if (!job.resultFileName) throw new Error('Completed Gemini batch has no result file');
  const reservation = await options.budget.reserve(shard.recipeCount, options.now());
  if (reservation.granted === 0) {
    return {
      mode: 'tag-batch-collect',
      status: 'write-cap-exhausted',
      quotaDate: reservation.quotaDate,
      written: 0,
    };
  }
  const [input] = await getStorage().bucket(bucketName).file(shard.objectPath).download();
  const expected = new Set(input.toString('utf8').split(/\r?\n/).filter(Boolean).map((line) => {
    const request = JSON.parse(line) as { key?: unknown };
    if (typeof request.key !== 'string') throw new Error('Prepared batch input is invalid');
    return request.key;
  }));
  const output = await options.api.downloadFile(job.resultFileName);
  const seen = new Set<string>();
  let written = 0;
  let invalid = 0;
  let failed = 0;
  let deferred = 0;
  const bucket = getStorage().bucket(bucketName);
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    let envelope: { key?: string; error?: unknown };
    try {
      envelope = JSON.parse(line) as { key?: string; error?: unknown };
    } catch {
      invalid += 1;
      continue;
    }
    if (!envelope.key || !expected.has(envelope.key) || seen.has(envelope.key)) {
      invalid += 1;
      continue;
    }
    seen.add(envelope.key);
    const text = responseText(envelope);
    const classification = text ? parseClassification(text) : undefined;
    if (!classification) {
      if (envelope.error) failed += 1;
      else invalid += 1;
      await bucket.file(
        `tag-batches/${state.runId}/raw-invalid/${envelope.key}.json`,
      ).save(line, { contentType: 'application/json', resumable: false });
      continue;
    }
    if (written >= reservation.granted) {
      deferred += 1;
      continue;
    }
    const reference = getFirestore().collection('recipes').doc(envelope.key);
    const outcome = await getFirestore().runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reference);
      const current = { ...snapshot.data(), id: snapshot.id };
      if (!snapshot.exists || !isCompleteRecipe(current) || !recipeRequiresAi(current)) {
        return false;
      }
      const updated = await classifyStoredRecipe(current, async (_content, sourceMetadata) => ({
        metadata: {
          ...sourceMetadata,
          mealTypes: sourceMetadata.mealTypes?.length
            ? sourceMetadata.mealTypes
            : classification.mealTypes,
          cuisines: sourceMetadata.cuisines?.length
            ? sourceMetadata.cuisines
            : classification.cuisines,
          modifiers: sourceMetadata.modifiers?.length
            ? sourceMetadata.modifiers
            : classification.modifiers,
        },
        sources: {
          mealTypes: sourceMetadata.mealTypes?.length ? 'source' : 'ai',
          cuisines: sourceMetadata.cuisines?.length ? 'source' : 'ai',
          modifiers: sourceMetadata.modifiers?.length ? 'source' : 'ai',
        },
        complete: true,
        classifierVersion: 1,
      }));
      transaction.set(reference, updated);
      return true;
    });
    if (outcome) written += 1;
  }
  failed += shard.recipeCount - seen.size;
  if (deferred > 0) {
    return {
      mode: 'tag-batch-collect',
      status: 'write-cap-exhausted',
      quotaDate: reservation.quotaDate,
      shard: shard.index,
      written,
      invalid,
      failed,
      deferred,
    };
  }
  shard.status = 'completed';
  state.phase = state.shards.every(({ status }) => status === 'completed')
    ? 'completed'
    : 'prepared';
  state.updatedAt = options.now().toISOString();
  await batchStateReference().set(state);
  return {
    mode: 'tag-batch-collect',
    status: state.phase,
    shard: shard.index,
    written,
    invalid,
    failed,
    remainingShards: state.shards.filter(({ status }) => status === 'prepared').length,
  };
}

export async function tagWeeklyNewRecipes(options: {
  recipeIds: readonly string[];
  classify: StoredRecipeClassifier;
  callCap?: number;
}): Promise<{
  considered: number;
  tagged: number;
  failed: number;
  overflow: number;
}> {
  const callCap = options.callCap ?? 500;
  if (!Number.isInteger(callCap) || callCap < 0 || callCap > 500) {
    throw new Error('Invalid weekly Gemini call cap');
  }
  const db = getFirestore();
  const ids = [...new Set(options.recipeIds)].sort();
  let tagged = 0;
  let failed = 0;
  let calls = 0;
  let overflow = 0;
  for (const id of ids) {
    const reference = db.collection('recipes').doc(id);
    const snapshot = await reference.get();
    const current = { ...snapshot.data(), id: snapshot.id };
    if (!snapshot.exists || !isCompleteRecipe(current) || !recipeRequiresAi(current)) continue;
    if (calls >= callCap) {
      overflow += 1;
      continue;
    }
    calls += 1;
    try {
      const updated = await classifyStoredRecipe(current, options.classify);
      const wrote = await db.runTransaction(async (transaction) => {
        const latest = await transaction.get(reference);
        const latestValue = { ...latest.data(), id: latest.id };
        if (!latest.exists || !isCompleteRecipe(latestValue)
          || !recipeRequiresAi(latestValue)
          || latestValue.ingestion.contentHash !== current.ingestion.contentHash) {
          return false;
        }
        transaction.set(reference, updated);
        return true;
      });
      if (wrote) tagged += 1;
    } catch {
      failed += 1;
    }
  }
  return { considered: ids.length, tagged, failed, overflow };
}
