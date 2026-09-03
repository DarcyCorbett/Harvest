import { copyFile, readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { applicationDefault, initializeApp } from 'firebase-admin/app';
import { FieldPath, getFirestore } from 'firebase-admin/firestore';

import {
  API_MODELS,
  LUNA_MODEL,
  RUBRIC_VERSION,
  TAG_RESPONSE_JSON_SCHEMA,
  buildBlindRows,
  buildClassificationPrompt,
  buildInventory,
  createHumanReviewTemplate,
  createLunaTemplate,
  fingerprintDocuments,
  importLunaResults,
  parseHumanReview,
  renderBlindReviewReport,
  renderCriteriaReport,
  renderInventoryReport,
  renderModelSummaryReport,
  scoreHumanReview,
  selectEvaluationSamples,
  summarizeModels,
  tokenCost,
  validateTagResponse,
} from './lib/catalogueTaggingEvaluation.mjs';

const DEFAULT_PROJECT_ID = 'meal-wizard-ad202';
const DEFAULT_OUTPUT_DIR = 'artifacts/catalogue-tagging-evaluation';
const EXPECTED_SAMPLE_COUNT = 52;
const PROVIDER_HOSTS = new Set([
  'generativelanguage.googleapis.com',
  'api.deepseek.com',
]);

function parseArguments(args) {
  const result = {
    mode: 'collect',
    projectId: DEFAULT_PROJECT_ID,
    outputDir: DEFAULT_OUTPUT_DIR,
    sampleCount: EXPECTED_SAMPLE_COUNT,
    excludeFrom: null,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];
    if (argument === '--mode'
      && ['collect', 'rerun-all', 'retry-gemini', 'retry-failed', 'refresh-inventory', 'render'].includes(value)) {
      result.mode = value;
      index += 1;
    } else if (argument === '--project' && /^[a-z][a-z0-9-]{4,29}$/.test(value ?? '')) {
      result.projectId = value;
      index += 1;
    } else if (argument === '--output-dir' && typeof value === 'string' && value.length > 0) {
      result.outputDir = value;
      index += 1;
    } else if (argument === '--sample-count'
      && Number.isInteger(Number(value))
      && Number(value) >= 30
      && Number(value) <= 52
      && Number(value) % 13 === 0) {
      result.sampleCount = Number(value);
      index += 1;
    } else if (argument === '--exclude-from' && typeof value === 'string' && value.length > 0) {
      result.excludeFrom = value;
      index += 1;
    } else {
      throw new Error(`Invalid argument: ${argument}`);
    }
  }
  return result;
}

function timestamp(snapshot) {
  return snapshot.updateTime?.toDate().toISOString() ?? '';
}

async function readRecipeDocuments(db) {
  const recipes = [];
  const fingerprintInput = [];
  let lastId;
  while (true) {
    let query = db.collection('recipes').orderBy(FieldPath.documentId()).limit(500);
    if (lastId) query = query.startAfter(lastId);
    const page = await query.get();
    if (page.empty) break;
    for (const document of page.docs) {
      recipes.push({ ...document.data(), id: document.id });
      fingerprintInput.push({
        path: `recipes/${document.id}`,
        updateTime: timestamp(document),
      });
    }
    lastId = page.docs.at(-1).id;
  }
  return { recipes, fingerprint: fingerprintDocuments(fingerprintInput) };
}

async function readCollectionGroupFingerprint(db, collectionId) {
  const snapshot = await db.collectionGroup(collectionId).get();
  return fingerprintDocuments(snapshot.docs.map((document) => ({
    path: document.ref.path,
    updateTime: timestamp(document),
  })));
}

async function readSafetySnapshot(db, { includeRecipes = true } = {}) {
  const [recipeData, mealPlans, cookbooks] = await Promise.all([
    includeRecipes ? readRecipeDocuments(db) : Promise.resolve(undefined),
    readCollectionGroupFingerprint(db, 'mealPlan'),
    readCollectionGroupFingerprint(db, 'cookbook'),
  ]);
  return { recipeData, mealPlans, cookbooks };
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
      const response = await fetch(parsed, {
        ...options,
        signal: AbortSignal.timeout(90_000),
      });
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
  const normalized = String(text ?? '').trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  return JSON.parse(normalized);
}

function geminiThinkingLevel(model) {
  return model === 'gemini-3.7-flash' ? 'low' : 'minimal';
}

function geminiGenerationConfig(model) {
  return {
    maxOutputTokens: 1_024,
    responseMimeType: 'application/json',
    responseJsonSchema: TAG_RESPONSE_JSON_SCHEMA,
    thinkingConfig: { thinkingLevel: geminiThinkingLevel(model) },
  };
}

async function callGemini({ apiKey, model, prompt }) {
  const { response, latencyMs } = await providerFetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: geminiGenerationConfig(model),
      }),
    },
  );
  const envelope = await response.json();
  if (!response.ok) {
    const detail = typeof envelope?.error?.message === 'string'
      ? envelope.error.message.slice(0, 300)
      : 'provider-error';
    throw new Error(`Gemini ${model} HTTP ${response.status}: ${detail}`);
  }
  const rawText = envelope.candidates?.[0]?.content?.parts
    ?.filter((part) => typeof part.text === 'string' && part.thought !== true)
    .map((part) => part.text)
    .join('') ?? '';
  const usageMetadata = envelope.usageMetadata ?? {};
  const usage = {
    inputTokens: Number(usageMetadata.promptTokenCount ?? 0),
    outputTokens: Number(usageMetadata.candidatesTokenCount ?? 0)
      + Number(usageMetadata.thoughtsTokenCount ?? 0),
    thinkingTokens: Number(usageMetadata.thoughtsTokenCount ?? 0),
    totalTokens: Number(usageMetadata.totalTokenCount ?? 0),
  };
  return {
    rawText,
    rawEnvelope: envelope,
    parsed: parseJsonContent(rawText),
    usage,
    latencyMs,
  };
}

async function callDeepSeek({ apiKey, model, prompt }) {
  const example = {
    kidFriendly: {
      standaloneOrRecognizable: true,
      coreIngredientsAccessible: true,
      broadChildAppeal: true,
      mildOrAdjustable: true,
      easyToEat: true,
      familyPractical: true,
      blocker: 'none',
      adjustment: null,
      confidence: 'high',
      reason: 'Short evidence-based reason.',
    },
    healthy: {
      nutrientDenseAnchor: true,
      meaningfulPlantsOrWholeFoods: true,
      suitableLeanOrPlantProtein: true,
      minimallyProcessed: true,
      sensibleFatAndMethod: true,
      limitedSugarRefinedStarchRichness: true,
      clearlyHealthierVersion: false,
      blocker: 'none',
      confidence: 'high',
      reason: 'Short evidence-based reason.',
    },
  };
  const { response, latencyMs } = await providerFetch(
    'https://api.deepseek.com/chat/completions',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content: `Return JSON only, with exactly the keys and nesting in this example: ${JSON.stringify(example)}. Boolean values, enum values, adjustment, confidence, and reasons must reflect the recipe. Do not add label, softSignals, positiveEvidence, or any other keys.`,
          },
          { role: 'user', content: prompt },
        ],
        response_format: { type: 'json_object' },
        thinking: { type: 'disabled' },
        temperature: 0,
        max_tokens: 1_024,
        stream: false,
      }),
    },
  );
  const envelope = await response.json();
  if (!response.ok) {
    const detail = typeof envelope?.error?.message === 'string'
      ? envelope.error.message.slice(0, 300)
      : 'provider-error';
    throw new Error(`DeepSeek ${model} HTTP ${response.status}: ${detail}`);
  }
  const rawText = envelope.choices?.[0]?.message?.content ?? '';
  const usageEnvelope = envelope.usage ?? {};
  const cachedInputTokens = Number(
    usageEnvelope.prompt_cache_hit_tokens
      ?? usageEnvelope.prompt_tokens_details?.cached_tokens
      ?? 0,
  );
  const usage = {
    inputTokens: Number(usageEnvelope.prompt_tokens ?? 0),
    cachedInputTokens,
    outputTokens: Number(usageEnvelope.completion_tokens ?? 0),
    totalTokens: Number(usageEnvelope.total_tokens ?? 0),
  };
  return {
    rawText,
    rawEnvelope: envelope,
    parsed: parseJsonContent(rawText),
    usage,
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
      const prompt = buildClassificationPrompt(sample);
      try {
        const response = await call(prompt);
        const validation = validateTagResponse(response.parsed);
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
        event: 'tagging-evaluation-progress',
        model,
        completed,
        total: samples.length,
        valid: results[index].validation.valid,
      }));
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
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

function validateSamples(samples, expectedSampleCount = EXPECTED_SAMPLE_COUNT) {
  if (samples.length !== expectedSampleCount
    || new Set(samples.map((sample) => sample.sampleKey)).size !== expectedSampleCount
    || new Set(samples.map((sample) => sample.recipeId)).size !== expectedSampleCount
    || new Set(samples.map((sample) => sample.canonicalUrl)).size !== expectedSampleCount) {
    throw new Error(`Evaluation sample must contain ${expectedSampleCount} distinct recipes and links`);
  }
}

async function collect({ projectId, outputDir, sampleCount, excludeFrom }) {
  initializeApp({ credential: applicationDefault(), projectId });
  const db = getFirestore();
  const outputPath = resolve(outputDir);
  await mkdir(outputPath, { recursive: true });

  console.log(JSON.stringify({ event: 'tagging-evaluation-scan-started' }));
  const before = await readSafetySnapshot(db);
  const recipes = before.recipeData.recipes;
  let excludedRecipeIds = [];
  if (excludeFrom) {
    const priorData = JSON.parse(await readFile(resolve(excludeFrom), 'utf8'));
    excludedRecipeIds = priorData.samples.map((sample) => sample.recipeId);
  }
  const samples = selectEvaluationSamples(recipes, {
    recipesPerSource: sampleCount / 13,
    excludedRecipeIds,
  });
  validateSamples(samples, sampleCount);
  const inventory = buildInventory(recipes);

  const secretClient = new SecretManagerServiceClient();
  const [geminiApiKey, deepSeekApiKey] = await Promise.all([
    providerSecret(secretClient, projectId, 'mealwizard-gemini-api-key', 'GEMINI_API_KEY'),
    providerSecret(secretClient, projectId, 'mealwizard-deepseek-api-key', 'DEEPSEEK_API_KEY'),
  ]);

  const results = [];
  for (const model of API_MODELS) {
    const call = model.startsWith('gemini-')
      ? (prompt) => callGemini({ apiKey: geminiApiKey, model, prompt })
      : (prompt) => callDeepSeek({ apiKey: deepSeekApiKey, model, prompt });
    results.push(...await runModel({ model, samples, call }));
  }

  console.log(JSON.stringify({ event: 'tagging-evaluation-post-scan-started' }));
  const after = await readSafetySnapshot(db);
  const verification = buildVerification(before, after);
  const data = {
    generatedAt: new Date().toISOString(),
    projectId,
    rubricVersion: RUBRIC_VERSION,
    expectedSampleCount: sampleCount,
    excludedRecipeIds,
    samples,
    inventory,
    results,
    verification,
  };
  await writeFile(
    resolve(outputPath, 'evaluation-data.json'),
    `${JSON.stringify(data, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    resolve(outputPath, 'luna-tags-template.json'),
    `${JSON.stringify(createLunaTemplate(samples), null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    resolve(outputPath, 'human-review.json'),
    `${JSON.stringify(createHumanReviewTemplate(samples), null, 2)}\n`,
    'utf8',
  );
  console.log(JSON.stringify({
    event: 'tagging-evaluation-collected',
    samples: samples.length,
    apiResults: results.length,
    ready: inventory.totals.ready,
    neither: inventory.totals.neither,
    outputPath,
  }));
}

async function archiveCurrentIteration(outputPath) {
  const archivePath = resolve(outputPath, 'iteration-1-original-rubric');
  await mkdir(archivePath, { recursive: true });
  const names = [
    'evaluation-data.json',
    'all-results.json',
    'blind-review.md',
    'model-summary.md',
    'tagging-criteria.md',
    'tagging-inventory.md',
    'luna-tags.json',
    'human-review.json',
  ];
  await Promise.all(names.map(async (name) => {
    try {
      await copyFile(resolve(outputPath, name), resolve(archivePath, name));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }));
  return archivePath;
}

async function rerunAll({ projectId, outputDir }) {
  initializeApp({ credential: applicationDefault(), projectId });
  const db = getFirestore();
  const outputPath = resolve(outputDir);
  const dataPath = resolve(outputPath, 'evaluation-data.json');
  const data = JSON.parse(await readFile(dataPath, 'utf8'));
  validateSamples(data.samples, data.expectedSampleCount ?? EXPECTED_SAMPLE_COUNT);
  const archivePath = await archiveCurrentIteration(outputPath);
  const before = await readSafetySnapshot(db);
  const secretClient = new SecretManagerServiceClient();
  const [geminiApiKey, deepSeekApiKey] = await Promise.all([
    providerSecret(secretClient, projectId, 'mealwizard-gemini-api-key', 'GEMINI_API_KEY'),
    providerSecret(secretClient, projectId, 'mealwizard-deepseek-api-key', 'DEEPSEEK_API_KEY'),
  ]);
  const results = [];
  for (const model of API_MODELS) {
    const call = model.startsWith('gemini-')
      ? (prompt) => callGemini({ apiKey: geminiApiKey, model, prompt })
      : (prompt) => callDeepSeek({ apiKey: deepSeekApiKey, model, prompt });
    results.push(...await runModel({ model, samples: data.samples, call }));
  }
  const after = await readSafetySnapshot(db);
  data.results = results;
  data.verification = buildVerification(before, after);
  data.rubricVersion = RUBRIC_VERSION;
  data.rerunAt = new Date().toISOString();
  await Promise.all([
    writeFile(dataPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8'),
    writeFile(
      resolve(outputPath, 'luna-tags-template.json'),
      `${JSON.stringify(createLunaTemplate(data.samples), null, 2)}\n`,
      'utf8',
    ),
  ]);
  console.log(JSON.stringify({
    event: 'tagging-evaluation-rerun-complete',
    rubricVersion: RUBRIC_VERSION,
    samples: data.samples.length,
    apiResults: results.length,
    archivePath,
    outputPath,
  }));
}

async function retryGemini({ projectId, outputDir }) {
  initializeApp({ credential: applicationDefault(), projectId });
  const db = getFirestore();
  const outputPath = resolve(outputDir);
  const dataPath = resolve(outputPath, 'evaluation-data.json');
  const data = JSON.parse(await readFile(dataPath, 'utf8'));
  validateSamples(data.samples, data.expectedSampleCount ?? EXPECTED_SAMPLE_COUNT);
  const before = await readSafetySnapshot(db);
  const secretClient = new SecretManagerServiceClient();
  const geminiApiKey = await providerSecret(
    secretClient,
    projectId,
    'mealwizard-gemini-api-key',
    'GEMINI_API_KEY',
  );
  const geminiResults = [];
  for (const model of API_MODELS.filter((candidate) => candidate.startsWith('gemini-'))) {
    geminiResults.push(...await runModel({
      model,
      samples: data.samples,
      call: (prompt) => callGemini({ apiKey: geminiApiKey, model, prompt }),
    }));
  }
  const after = await readSafetySnapshot(db);
  data.results = [
    ...data.results.filter((result) => !result.model.startsWith('gemini-')),
    ...geminiResults,
  ];
  data.verification = buildVerification(before, after);
  data.geminiRetriedAt = new Date().toISOString();
  await writeFile(dataPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    event: 'tagging-evaluation-gemini-retried',
    samples: data.samples.length,
    geminiResults: geminiResults.length,
    outputPath,
  }));
}

async function retryFailed({ projectId, outputDir }) {
  initializeApp({ credential: applicationDefault(), projectId });
  const db = getFirestore();
  const outputPath = resolve(outputDir);
  const dataPath = resolve(outputPath, 'evaluation-data.json');
  const data = JSON.parse(await readFile(dataPath, 'utf8'));
  validateSamples(data.samples, data.expectedSampleCount ?? EXPECTED_SAMPLE_COUNT);
  const failedModels = API_MODELS.filter((model) => {
    const modelResults = data.results.filter((result) => result.model === model);
    return modelResults.length !== data.samples.length
      || modelResults.some((result) => result.validation?.valid !== true);
  });
  if (failedModels.length === 0) {
    console.log(JSON.stringify({ event: 'tagging-evaluation-no-failed-models' }));
    return;
  }
  const before = await readSafetySnapshot(db);
  const secretClient = new SecretManagerServiceClient();
  const needsGemini = failedModels.some((model) => model.startsWith('gemini-'));
  const needsDeepSeek = failedModels.some((model) => model.startsWith('deepseek-'));
  const [geminiApiKey, deepSeekApiKey] = await Promise.all([
    needsGemini
      ? providerSecret(secretClient, projectId, 'mealwizard-gemini-api-key', 'GEMINI_API_KEY')
      : Promise.resolve(''),
    needsDeepSeek
      ? providerSecret(secretClient, projectId, 'mealwizard-deepseek-api-key', 'DEEPSEEK_API_KEY')
      : Promise.resolve(''),
  ]);
  const replacementResults = [];
  for (const model of failedModels) {
    const call = model.startsWith('gemini-')
      ? (prompt) => callGemini({ apiKey: geminiApiKey, model, prompt })
      : (prompt) => callDeepSeek({ apiKey: deepSeekApiKey, model, prompt });
    replacementResults.push(...await runModel({ model, samples: data.samples, call }));
  }
  const after = await readSafetySnapshot(db);
  data.results = [
    ...data.results.filter((result) => !failedModels.includes(result.model)),
    ...replacementResults,
  ];
  data.verification = buildVerification(before, after);
  data.failedModelsRetriedAt = new Date().toISOString();
  await writeFile(dataPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    event: 'tagging-evaluation-failed-models-retried',
    models: failedModels,
    outputPath,
  }));
}

async function refreshInventory({ projectId, outputDir }) {
  initializeApp({ credential: applicationDefault(), projectId });
  const outputPath = resolve(outputDir);
  const dataPath = resolve(outputPath, 'evaluation-data.json');
  const data = JSON.parse(await readFile(dataPath, 'utf8'));
  const recipeData = await readRecipeDocuments(getFirestore());
  data.inventory = buildInventory(recipeData.recipes);
  data.inventoryRefreshedAt = new Date().toISOString();
  await writeFile(dataPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    event: 'tagging-evaluation-inventory-refreshed',
    ready: data.inventory.totals.ready,
    neither: data.inventory.totals.neither,
    outputPath,
  }));
}

async function render({ outputDir }) {
  const outputPath = resolve(outputDir);
  const data = JSON.parse(await readFile(resolve(outputPath, 'evaluation-data.json'), 'utf8'));
  validateSamples(data.samples, data.expectedSampleCount ?? EXPECTED_SAMPLE_COUNT);
  let lunaResults = [];
  try {
    const lunaInput = JSON.parse(await readFile(resolve(outputPath, 'luna-tags.json'), 'utf8'));
    lunaResults = importLunaResults(data.samples, lunaInput);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const results = [
    ...data.results.filter((result) => result.model !== LUNA_MODEL),
    ...lunaResults,
  ];
  const expectedResultCount = data.samples.length
    * (API_MODELS.length + (lunaResults.length ? 1 : 0));
  if (results.length !== expectedResultCount) {
    throw new Error(`Expected ${expectedResultCount} total model results, found ${results.length}`);
  }
  const humanReviewPath = resolve(outputPath, 'human-review.json');
  const savedHumanReview = parseHumanReview(await readFile(humanReviewPath, 'utf8'));
  const savedReviewByKey = new Map(savedHumanReview.map((entry) => [entry.sampleKey, entry]));
  const humanReview = createHumanReviewTemplate(data.samples).map((entry) => ({
    ...entry,
    ...(savedReviewByKey.get(entry.sampleKey) ?? {}),
    title: entry.title,
    recipeUrl: entry.recipeUrl,
  }));
  const modelSummaries = summarizeModels({
    samples: data.samples,
    results,
    inventory: data.inventory,
  });
  const scores = scoreHumanReview(data.samples, results, humanReview);
  const blindRows = buildBlindRows(data.samples, results);
  await Promise.all([
    writeFile(humanReviewPath, `${JSON.stringify(humanReview, null, 2)}\n`, 'utf8'),
    writeFile(
      resolve(outputPath, 'tagging-inventory.md'),
      renderInventoryReport({ inventory: data.inventory, modelSummaries }),
      'utf8',
    ),
    writeFile(
      resolve(outputPath, 'tagging-criteria.md'),
      renderCriteriaReport(),
      'utf8',
    ),
    writeFile(
      resolve(outputPath, 'blind-review.md'),
      renderBlindReviewReport({
        samples: data.samples,
        results,
        verification: data.verification,
      }),
      'utf8',
    ),
    writeFile(
      resolve(outputPath, 'model-summary.md'),
      renderModelSummaryReport({ modelSummaries, scores, blindRows }),
      'utf8',
    ),
    writeFile(
      resolve(outputPath, 'all-results.json'),
      `${JSON.stringify({ ...data, results, modelSummaries, scores }, null, 2)}\n`,
      'utf8',
    ),
  ]);
  console.log(JSON.stringify({
    event: 'tagging-evaluation-rendered',
    samples: data.samples.length,
    models: modelSummaries.length,
    humanScoresComplete: scores.length > 0,
    outputPath,
  }));
}

const arguments_ = parseArguments(process.argv.slice(2));
if (arguments_.mode === 'collect') await collect(arguments_);
else if (arguments_.mode === 'rerun-all') await rerunAll(arguments_);
else if (arguments_.mode === 'retry-gemini') await retryGemini(arguments_);
else if (arguments_.mode === 'retry-failed') await retryFailed(arguments_);
else if (arguments_.mode === 'refresh-inventory') await refreshInventory(arguments_);
else await render(arguments_);
