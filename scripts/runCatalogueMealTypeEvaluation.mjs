import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { FieldPath, getFirestore } from 'firebase-admin/firestore';

import {
  API_MODELS,
  COMPONENT_KINDS,
  LUNA_MODEL,
  MEAL_TYPE_RESPONSE_JSON_SCHEMA,
  RUBRIC_VERSION,
  buildMealTypePrompt,
  createLunaTemplate,
  createReviewTemplate,
  fingerprintDocuments,
  importLunaResults,
  renderComparisonReport,
  renderModelSummaryReport,
  renderReviewShortlist,
  renderTaxonomyCriteriaReport,
  scoreReview,
  selectMealTypeEvaluationSamples,
  summarizeModels,
  tokenCost,
  validateMealTypeResponse,
} from './lib/catalogueMealTypeEvaluation.mjs';

const DEFAULT_PROJECT_ID = 'meal-wizard-ad202';
const DEFAULT_OUTPUT_DIR = 'artifacts/catalogue-meal-type-evaluation';
const DEFAULT_EXCLUSIONS = [
  'artifacts/catalogue-tagging-evaluation/evaluation-data.json',
  'artifacts/catalogue-tagging-evaluation/new-recipes-v4/evaluation-data.json',
];
const EXPECTED_SAMPLE_COUNT = 48;
const PROVIDER_HOSTS = new Set([
  'generativelanguage.googleapis.com',
  'api.deepseek.com',
]);

function parseArguments(args) {
  const result = {
    mode: 'collect',
    projectId: DEFAULT_PROJECT_ID,
    outputDir: DEFAULT_OUTPUT_DIR,
    excludeFrom: [...DEFAULT_EXCLUSIONS],
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];
    if (argument === '--mode' && ['collect', 'retry-failed', 'rerun-review', 'render'].includes(value)) {
      result.mode = value;
      index += 1;
    } else if (argument === '--project' && /^[a-z][a-z0-9-]{4,29}$/.test(value ?? '')) {
      result.projectId = value;
      index += 1;
    } else if (argument === '--output-dir' && typeof value === 'string' && value.length > 0) {
      result.outputDir = value;
      index += 1;
    } else if (argument === '--exclude-from' && typeof value === 'string' && value.length > 0) {
      result.excludeFrom.push(value);
      index += 1;
    } else {
      throw new Error(`Invalid argument: ${argument}`);
    }
  }
  return result;
}

function initialize(projectId) {
  if (getApps().length === 0) initializeApp({ credential: applicationDefault(), projectId });
  return getFirestore();
}

function timestamp(snapshot) {
  return snapshot.updateTime?.toDate().toISOString() ?? '';
}

async function readReadyRecipes(db) {
  const recipes = [];
  let lastId;
  let pages = 0;
  while (true) {
    let query = db.collection('recipes')
      .where('schemaVersion', '==', 2)
      .where('status', '==', 'ready')
      .orderBy(FieldPath.documentId())
      .limit(1_000);
    if (lastId) query = query.startAfter(lastId);
    const page = await query.get();
    if (page.empty) break;
    for (const document of page.docs) {
      recipes.push({ ...document.data(), id: document.id });
    }
    lastId = page.docs.at(-1).id;
    pages += 1;
    if (pages % 10 === 0) {
      console.log(JSON.stringify({ event: 'meal-type-ready-scan-progress', recipes: recipes.length }));
    }
  }
  return recipes;
}

async function readRecipeFingerprint(db) {
  const fingerprintInput = [];
  let lastId;
  let pages = 0;
  while (true) {
    let query = db.collection('recipes')
      .select()
      .orderBy(FieldPath.documentId())
      .limit(2_000);
    if (lastId) query = query.startAfter(lastId);
    const page = await query.get();
    if (page.empty) break;
    for (const document of page.docs) {
      fingerprintInput.push({ path: `recipes/${document.id}`, updateTime: timestamp(document) });
    }
    lastId = page.docs.at(-1).id;
    pages += 1;
    if (pages % 10 === 0) {
      console.log(JSON.stringify({ event: 'meal-type-recipe-fingerprint-progress', documents: fingerprintInput.length }));
    }
  }
  return fingerprintDocuments(fingerprintInput);
}

async function readCollectionGroupFingerprint(db, collectionId) {
  const snapshot = await db.collectionGroup(collectionId).select().get();
  const fingerprint = fingerprintDocuments(snapshot.docs.map((document) => ({
    path: document.ref.path,
    updateTime: timestamp(document),
  })));
  console.log(JSON.stringify({ event: 'meal-type-collection-fingerprint', collectionId, count: fingerprint.count }));
  return fingerprint;
}

async function readSafetySnapshot(db, { includeRecipeContents = true } = {}) {
  const [recipes, recipeFingerprint, mealPlans, cookbooks] = await Promise.all([
    includeRecipeContents ? readReadyRecipes(db) : Promise.resolve(undefined),
    readRecipeFingerprint(db),
    readCollectionGroupFingerprint(db, 'mealPlan'),
    readCollectionGroupFingerprint(db, 'cookbook'),
  ]);
  return { recipeData: { recipes, fingerprint: recipeFingerprint }, mealPlans, cookbooks };
}

function equalFingerprint(left, right) {
  return left.count === right.count && left.hash === right.hash;
}

function buildVerification(before, after) {
  const verification = {
    before: {
      recipes: before.recipeData.fingerprint,
      mealPlans: before.mealPlans,
      cookbooks: before.cookbooks,
    },
    after: {
      recipes: after.recipeData.fingerprint,
      mealPlans: after.mealPlans,
      cookbooks: after.cookbooks,
    },
    recipesUnchanged: equalFingerprint(before.recipeData.fingerprint, after.recipeData.fingerprint),
    mealPlansUnchanged: equalFingerprint(before.mealPlans, after.mealPlans),
    cookbooksUnchanged: equalFingerprint(before.cookbooks, after.cookbooks),
    recipeSiteRequests: 0,
  };
  if (!verification.recipesUnchanged
    || !verification.mealPlansUnchanged
    || !verification.cookbooksUnchanged) {
    throw new Error('Firestore fingerprints changed during the read-only evaluation');
  }
  return verification;
}

async function secretValue(client, projectId, secretId) {
  const [version] = await client.accessSecretVersion({
    name: `projects/${projectId}/secrets/${secretId}/versions/latest`,
  });
  const value = version.payload?.data?.toString('utf8').trim() ?? '';
  if (!value) throw new Error(`Secret ${secretId} is empty`);
  return value;
}

async function providerSecret(client, projectId, secretId, environmentName) {
  const environmentValue = process.env[environmentName]?.trim();
  if (environmentValue) return environmentValue;
  return secretValue(client, projectId, secretId);
}

async function providerFetch(url, options) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !PROVIDER_HOSTS.has(parsed.hostname)) {
    throw new Error(`Blocked non-provider request host: ${parsed.hostname}`);
  }
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const started = Date.now();
    try {
      const response = await fetch(parsed, { ...options, signal: AbortSignal.timeout(90_000) });
      if (response.ok || ![429, 500, 502, 503, 504].includes(response.status)) {
        return { response, latencyMs: Date.now() - started };
      }
      lastError = new Error(`Provider HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 750 * 2 ** attempt));
  }
  throw lastError ?? new Error('Provider request failed');
}

function parseJsonContent(text) {
  return JSON.parse(String(text ?? '').trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, ''));
}

function geminiThinkingLevel(model) {
  return model === 'gemini-3.7-flash' ? 'low' : 'minimal';
}

async function callGemini({ apiKey, model, prompt }) {
  const { response, latencyMs } = await providerFetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: 1_024,
          responseMimeType: 'application/json',
          responseJsonSchema: MEAL_TYPE_RESPONSE_JSON_SCHEMA,
          thinkingConfig: { thinkingLevel: geminiThinkingLevel(model) },
        },
      }),
    },
  );
  const envelope = await response.json();
  if (!response.ok) {
    const detail = typeof envelope?.error?.message === 'string'
      ? envelope.error.message.slice(0, 300) : 'provider-error';
    throw new Error(`Gemini ${model} HTTP ${response.status}: ${detail}`);
  }
  const rawText = envelope.candidates?.[0]?.content?.parts
    ?.filter((part) => typeof part.text === 'string' && part.thought !== true)
    .map((part) => part.text).join('') ?? '';
  const usageMetadata = envelope.usageMetadata ?? {};
  return {
    rawText,
    rawEnvelope: envelope,
    parsed: parseJsonContent(rawText),
    usage: {
      inputTokens: Number(usageMetadata.promptTokenCount ?? 0),
      outputTokens: Number(usageMetadata.candidatesTokenCount ?? 0)
        + Number(usageMetadata.thoughtsTokenCount ?? 0),
      thinkingTokens: Number(usageMetadata.thoughtsTokenCount ?? 0),
      totalTokens: Number(usageMetadata.totalTokenCount ?? 0),
    },
    latencyMs,
  };
}

async function callDeepSeek({ apiKey, model, prompt }) {
  const example = {
    mode: 'dish',
    roles: {
      breakfast: false,
      lunch: true,
      dinner: true,
      side: false,
      snack: false,
      dessert: false,
    },
    componentKind: 'none',
    confidence: 'high',
    reason: 'The complete recipe is commonly served as either a lunch or dinner main.',
  };
  const { response, latencyMs } = await providerFetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'system',
          content: `Return JSON only with exactly this shape: ${JSON.stringify(example)}. componentKind must be exactly one of: ${COMPONENT_KINDS.join(', ')}. Apply the user's taxonomy; do not add fields.`,
        },
        { role: 'user', content: prompt },
      ],
      response_format: { type: 'json_object' },
      thinking: { type: 'disabled' },
      temperature: 0,
      max_tokens: 1_024,
      stream: false,
    }),
  });
  const envelope = await response.json();
  if (!response.ok) {
    const detail = typeof envelope?.error?.message === 'string'
      ? envelope.error.message.slice(0, 300) : 'provider-error';
    throw new Error(`DeepSeek ${model} HTTP ${response.status}: ${detail}`);
  }
  const rawText = envelope.choices?.[0]?.message?.content ?? '';
  const usageEnvelope = envelope.usage ?? {};
  const cachedInputTokens = Number(usageEnvelope.prompt_cache_hit_tokens
    ?? usageEnvelope.prompt_tokens_details?.cached_tokens ?? 0);
  return {
    rawText,
    rawEnvelope: envelope,
    parsed: parseJsonContent(rawText),
    usage: {
      inputTokens: Number(usageEnvelope.prompt_tokens ?? 0),
      cachedInputTokens,
      outputTokens: Number(usageEnvelope.completion_tokens ?? 0),
      totalTokens: Number(usageEnvelope.total_tokens ?? 0),
    },
    latencyMs,
  };
}

async function runModel({ model, samples, call, concurrency = 4 }) {
  const results = new Array(samples.length);
  let nextIndex = 0;
  let completed = 0;
  async function worker() {
    while (nextIndex < samples.length) {
      const index = nextIndex;
      nextIndex += 1;
      const sample = samples[index];
      const prompt = buildMealTypePrompt(sample);
      try {
        const response = await call(prompt);
        const validation = validateMealTypeResponse(response.parsed);
        results[index] = {
          sampleKey: sample.sampleKey,
          model,
          modelConfig: model.startsWith('gemini-')
            ? { thinkingLevel: geminiThinkingLevel(model) }
            : { thinking: 'disabled' },
          prompt,
          rawText: response.rawText,
          rawEnvelope: response.rawEnvelope,
          validation,
          usage: response.usage,
          latencyMs: response.latencyMs,
          costUsd: tokenCost(model, response.usage),
        };
      } catch (error) {
        results[index] = {
          sampleKey: sample.sampleKey,
          model,
          prompt,
          rawText: '',
          error: error instanceof Error ? error.message : 'provider-error',
          validation: { valid: false, errors: ['provider-error'] },
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          latencyMs: 0,
          costUsd: 0,
        };
      }
      completed += 1;
      console.log(JSON.stringify({
        event: 'meal-type-evaluation-progress', model, completed,
        total: samples.length, valid: results[index].validation.valid,
      }));
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

async function existingExclusions(paths) {
  const ids = new Set();
  for (const path of paths) {
    try {
      const data = JSON.parse(await readFile(resolve(path), 'utf8'));
      for (const sample of data.samples ?? []) if (typeof sample.recipeId === 'string') ids.add(sample.recipeId);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return [...ids];
}

function validateData(data) {
  const expected = Number(data.expectedSampleCount ?? EXPECTED_SAMPLE_COUNT);
  if (!Number.isInteger(expected) || expected < 1
    || !Array.isArray(data.samples) || data.samples.length !== expected
    || new Set(data.samples.map((sample) => sample.recipeId)).size !== expected
    || new Set(data.samples.map((sample) => sample.canonicalUrl)).size !== expected) {
    throw new Error(`Evaluation data must contain ${expected} distinct recipes and canonical links`);
  }
}

async function runApiModels(projectId, samples, models = API_MODELS) {
  const secretClient = new SecretManagerServiceClient();
  const [geminiApiKey, deepSeekApiKey] = await Promise.all([
    models.some((model) => model.startsWith('gemini-'))
      ? providerSecret(secretClient, projectId, 'mealwizard-gemini-api-key', 'GEMINI_API_KEY')
      : Promise.resolve(''),
    models.some((model) => model.startsWith('deepseek-'))
      ? providerSecret(secretClient, projectId, 'mealwizard-deepseek-api-key', 'DEEPSEEK_API_KEY')
      : Promise.resolve(''),
  ]);
  const results = [];
  for (const model of models) {
    const call = model.startsWith('gemini-')
      ? (prompt) => callGemini({ apiKey: geminiApiKey, model, prompt })
      : (prompt) => callDeepSeek({ apiKey: deepSeekApiKey, model, prompt });
    results.push(...await runModel({ model, samples, call }));
  }
  return results;
}

async function readOptionalJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function renderArtifacts(outputPath, data) {
  validateData(data);
  const lunaInput = await readOptionalJson(resolve(outputPath, 'luna-results.json'), null);
  const lunaResults = lunaInput ? importLunaResults(data.samples, lunaInput) : [];
  const results = [
    ...data.results.filter((result) => result.model !== LUNA_MODEL),
    ...lunaResults,
  ];
  const currentReview = await readOptionalJson(resolve(outputPath, 'review.json'), []);
  const reviewByKey = new Map(currentReview.map((entry) => [entry.sampleKey, entry]));
  const review = createReviewTemplate(data.samples, results).map((entry) => ({
    ...entry,
    ...(reviewByKey.get(entry.sampleKey)?.recipeUrl === entry.recipeUrl
      ? reviewByKey.get(entry.sampleKey)
      : {}),
  }));
  const modelSummaries = summarizeModels({
    samples: data.samples,
    results,
    readyRecipeCount: data.readyRecipeCount,
  });
  const reviewScores = scoreReview(data.samples, results, review);
  await Promise.all([
    writeFile(resolve(outputPath, 'all-results.json'), `${JSON.stringify({ ...data, results }, null, 2)}\n`, 'utf8'),
    writeFile(resolve(outputPath, 'taxonomy-criteria.md'), renderTaxonomyCriteriaReport(), 'utf8'),
    writeFile(resolve(outputPath, 'model-comparison.md'), renderComparisonReport({
      samples: data.samples, results, verification: data.verification,
    }), 'utf8'),
    writeFile(resolve(outputPath, 'review-shortlist.md'), renderReviewShortlist({ samples: data.samples, results }), 'utf8'),
    writeFile(resolve(outputPath, 'review.json'), `${JSON.stringify(review, null, 2)}\n`, 'utf8'),
    writeFile(resolve(outputPath, 'model-summary.md'), renderModelSummaryReport({
      samples: data.samples, results, modelSummaries, reviewScores,
    }), 'utf8'),
  ]);
  return { results: results.length, luna: lunaResults.length, reviewed: reviewScores[0]?.reviewed ?? 0 };
}

async function collect({ projectId, outputDir, excludeFrom }) {
  const db = initialize(projectId);
  const outputPath = resolve(outputDir);
  await mkdir(outputPath, { recursive: true });
  const before = await readSafetySnapshot(db);
  const excludedRecipeIds = await existingExclusions(excludeFrom);
  const samples = selectMealTypeEvaluationSamples(before.recipeData.recipes, { excludedRecipeIds });
  const readyRecipeCount = before.recipeData.recipes.length;
  const results = await runApiModels(projectId, samples);
  const after = await readSafetySnapshot(db, { includeRecipeContents: false });
  const verification = buildVerification(before, after);
  const data = {
    schemaVersion: 1,
    rubricVersion: RUBRIC_VERSION,
    generatedAt: new Date().toISOString(),
    projectId,
    expectedSampleCount: EXPECTED_SAMPLE_COUNT,
    readyRecipeCount,
    excludedRecipeIds,
    exclusionSources: excludeFrom,
    samples,
    results,
    verification,
  };
  await Promise.all([
    writeFile(resolve(outputPath, 'evaluation-data.json'), `${JSON.stringify(data, null, 2)}\n`, 'utf8'),
    writeFile(resolve(outputPath, 'luna-results-template.json'), `${JSON.stringify(createLunaTemplate(samples), null, 2)}\n`, 'utf8'),
  ]);
  const rendered = await renderArtifacts(outputPath, data);
  console.log(JSON.stringify({ event: 'meal-type-evaluation-collected', samples: samples.length, ...rendered }));
}

async function retryFailed({ projectId, outputDir }) {
  const outputPath = resolve(outputDir);
  const data = JSON.parse(await readFile(resolve(outputPath, 'evaluation-data.json'), 'utf8'));
  validateData(data);
  const failedModels = API_MODELS.filter((model) => {
    const modelResults = data.results.filter((result) => result.model === model);
    return modelResults.length !== data.samples.length
      || modelResults.some((result) => result.validation?.valid !== true);
  });
  if (failedModels.length === 0) {
    console.log(JSON.stringify({ event: 'meal-type-evaluation-no-failed-models' }));
    return;
  }
  const replacement = [];
  const replacementKeys = new Set();
  for (const model of failedModels) {
    const existingByKey = new Map(data.results
      .filter((result) => result.model === model)
      .map((result) => [result.sampleKey, result]));
    const failedSamples = data.samples.filter((sample) =>
      existingByKey.get(sample.sampleKey)?.validation?.valid !== true);
    for (const sample of failedSamples) replacementKeys.add(`${model}\n${sample.sampleKey}`);
    replacement.push(...await runApiModels(projectId, failedSamples, [model]));
  }
  data.results = data.results
    .filter((result) => !replacementKeys.has(`${result.model}\n${result.sampleKey}`))
    .concat(replacement);
  data.rerunAt = new Date().toISOString();
  await writeFile(resolve(outputPath, 'evaluation-data.json'), `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  const rendered = await renderArtifacts(outputPath, data);
  console.log(JSON.stringify({ event: 'meal-type-evaluation-retried', models: failedModels, ...rendered }));
}

async function rerunReview({ projectId, outputDir }) {
  const sourcePath = resolve(DEFAULT_OUTPUT_DIR);
  const targetPath = resolve(outputDir);
  if (sourcePath === targetPath) {
    throw new Error('rerun-review requires a separate --output-dir so original results remain intact');
  }
  const [sourceData, sourceReview] = await Promise.all([
    readOptionalJson(resolve(sourcePath, 'all-results.json'), null),
    readOptionalJson(resolve(sourcePath, 'review.json'), null),
  ]);
  if (!sourceData || !Array.isArray(sourceReview) || sourceReview.length !== 20) {
    throw new Error('The original 20-recipe review shortlist is unavailable');
  }
  const sourceSamples = new Map(sourceData.samples.map((sample) => [sample.sampleKey, sample]));
  const samples = sourceReview.map((entry) => sourceSamples.get(entry.sampleKey));
  if (samples.some((sample) => !sample)) {
    throw new Error('Review shortlist contains an unknown sample');
  }
  await mkdir(targetPath, { recursive: true });
  const results = await runApiModels(projectId, samples);
  const data = {
    schemaVersion: 1,
    rubricVersion: RUBRIC_VERSION,
    generatedAt: new Date().toISOString(),
    projectId,
    expectedSampleCount: samples.length,
    readyRecipeCount: sourceData.readyRecipeCount,
    parentEvaluation: resolve(sourcePath, 'all-results.json'),
    sampleSelection: 'original-prioritized-disagreement-list',
    samples,
    results,
    verification: sourceData.verification,
  };
  await Promise.all([
    writeFile(resolve(targetPath, 'evaluation-data.json'), `${JSON.stringify(data, null, 2)}\n`, 'utf8'),
    writeFile(resolve(targetPath, 'luna-results-template.json'), `${JSON.stringify(createLunaTemplate(samples), null, 2)}\n`, 'utf8'),
  ]);
  const rendered = await renderArtifacts(targetPath, data);
  console.log(JSON.stringify({
    event: 'meal-type-review-rerun-collected', samples: samples.length, ...rendered,
  }));
}

async function render({ outputDir }) {
  const outputPath = resolve(outputDir);
  await access(resolve(outputPath, 'evaluation-data.json'));
  const data = JSON.parse(await readFile(resolve(outputPath, 'evaluation-data.json'), 'utf8'));
  const rendered = await renderArtifacts(outputPath, data);
  console.log(JSON.stringify({ event: 'meal-type-evaluation-rendered', ...rendered }));
}

const options = parseArguments(process.argv.slice(2));
if (options.mode === 'collect') await collect(options);
else if (options.mode === 'retry-failed') await retryFailed(options);
else if (options.mode === 'rerun-review') await rerunReview(options);
else await render(options);
