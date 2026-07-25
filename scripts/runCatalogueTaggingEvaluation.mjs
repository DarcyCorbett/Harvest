import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { applicationDefault, initializeApp } from 'firebase-admin/app';
import { FieldPath, getFirestore } from 'firebase-admin/firestore';

import {
  MODEL_PRICING_USD_PER_MILLION,
  buildClassificationPrompt,
  buildInventory,
  fingerprintDocuments,
  renderEvaluationReport,
  renderInventoryReport,
  selectEvaluationSamples,
  tokenCost,
  validateTagResponse,
} from './lib/catalogueTaggingEvaluation.mjs';

const DEFAULT_PROJECT_ID = 'meal-wizard-ad202';
const DEFAULT_OUTPUT_DIR = 'artifacts/catalogue-tagging-evaluation';
const PROVIDER_HOSTS = new Set([
  'generativelanguage.googleapis.com',
  'api.deepseek.com',
]);
function parseArguments(args) {
  const result = {
    mode: 'collect',
    projectId: DEFAULT_PROJECT_ID,
    outputDir: DEFAULT_OUTPUT_DIR,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];
    if (argument === '--mode'
      && ['collect', 'retry-gemini', 'refresh-inventory', 'render'].includes(value)) {
      result.mode = value;
      index += 1;
    } else if (argument === '--project' && /^[a-z][a-z0-9-]{4,29}$/.test(value ?? '')) {
      result.projectId = value;
      index += 1;
    } else if (argument === '--output-dir' && typeof value === 'string' && value.length > 0) {
      result.outputDir = value;
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
  return {
    recipeData,
    mealPlans,
    cookbooks,
  };
}

async function secretValue(client, projectId, secretId) {
  const [version] = await client.accessSecretVersion({
    name: `projects/${projectId}/secrets/${secretId}/versions/latest`,
  });
  const value = version.payload?.data?.toString('utf8').trim() ?? '';
  if (!value) throw new Error(`Secret ${secretId} is empty`);
  return value;
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
        signal: AbortSignal.timeout(60_000),
      });
      if (response.ok || ![429, 500, 502, 503, 504].includes(response.status)) {
        return { response, latencyMs: Date.now() - started };
      }
      lastError = new Error(`Provider HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500 * 2 ** attempt));
  }
  throw lastError ?? new Error('Provider request failed');
}

function parseJsonContent(text) {
  const normalized = String(text ?? '').trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  return JSON.parse(normalized);
}

function geminiGenerationConfig(model) {
  const config = {
    maxOutputTokens: 512,
    responseMimeType: 'application/json',
  };
  if (model === 'gemini-3.1-flash-lite') {
    config.temperature = 0;
  } else {
    config.thinkingConfig = { thinkingLevel: 'minimal' };
  }
  return config;
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

async function callDeepSeek({ apiKey, prompt }) {
  const model = 'deepseek-v4-pro';
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
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        thinking: { type: 'disabled' },
        temperature: 0,
        max_tokens: 512,
        stream: false,
      }),
    },
  );
  const envelope = await response.json();
  if (!response.ok) throw new Error(`DeepSeek HTTP ${response.status}`);
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

async function runModel({ model, samples, call }) {
  const results = [];
  for (const [index, sample] of samples.entries()) {
    const prompt = buildClassificationPrompt(sample);
    try {
      const response = await call(prompt);
      const validation = validateTagResponse(response.parsed);
      results.push({
        sampleKey: sample.sampleKey,
        model,
        prompt,
        rawText: response.rawText,
        rawEnvelope: response.rawEnvelope,
        validation,
        usage: response.usage,
        latencyMs: response.latencyMs,
        costUsd: tokenCost(model, response.usage),
      });
      console.log(JSON.stringify({
        event: 'tagging-evaluation-progress',
        model,
        completed: index + 1,
        total: samples.length,
        valid: validation.valid,
      }));
    } catch (error) {
      results.push({
        sampleKey: sample.sampleKey,
        model,
        prompt,
        rawText: '',
        error: error instanceof Error ? error.message : 'provider-error',
        validation: { valid: false, errors: ['provider-error'] },
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        latencyMs: 0,
        costUsd: 0,
      });
      console.log(JSON.stringify({
        event: 'tagging-evaluation-progress',
        model,
        completed: index + 1,
        total: samples.length,
        valid: false,
      }));
    }
  }
  return results;
}

function equalFingerprint(left, right) {
  return left.count === right.count && left.hash === right.hash;
}

async function collect({ projectId, outputDir }) {
  initializeApp({
    credential: applicationDefault(),
    projectId,
  });
  const db = getFirestore();
  const outputPath = resolve(outputDir);
  await mkdir(outputPath, { recursive: true });

  console.log(JSON.stringify({ event: 'tagging-evaluation-scan-started' }));
  const before = await readSafetySnapshot(db);
  const recipes = before.recipeData.recipes;
  const samples = selectEvaluationSamples(recipes);
  const inventory = buildInventory(recipes);
  if (samples.length !== 26 || new Set(samples.map((sample) => sample.sampleKey)).size !== 26) {
    throw new Error('Evaluation sample must contain 26 distinct entries');
  }

  const secretClient = new SecretManagerServiceClient();
  const [geminiApiKey, deepSeekApiKey] = await Promise.all([
    secretValue(secretClient, projectId, 'mealwizard-gemini-api-key'),
    secretValue(secretClient, projectId, 'mealwizard-deepseek-api-key'),
  ]);

  const results = [];
  for (const model of [
    'gemini-3.1-flash-lite',
    'gemini-3.5-flash-lite',
    'gemini-3.6-flash',
  ]) {
    results.push(...await runModel({
      model,
      samples,
      call: (prompt) => callGemini({ apiKey: geminiApiKey, model, prompt }),
    }));
  }
  results.push(...await runModel({
    model: 'deepseek-v4-pro',
    samples,
    call: (prompt) => callDeepSeek({ apiKey: deepSeekApiKey, prompt }),
  }));

  console.log(JSON.stringify({ event: 'tagging-evaluation-post-scan-started' }));
  const after = await readSafetySnapshot(db);
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
    recipesUnchanged: equalFingerprint(
      before.recipeData.fingerprint,
      after.recipeData.fingerprint,
    ),
    mealPlansUnchanged: equalFingerprint(before.mealPlans, after.mealPlans),
    cookbooksUnchanged: equalFingerprint(before.cookbooks, after.cookbooks),
    recipeSiteRequests: 0,
  };
  if (!verification.recipesUnchanged
    || !verification.mealPlansUnchanged
    || !verification.cookbooksUnchanged) {
    throw new Error('Firestore fingerprints changed during the read-only evaluation');
  }

  const data = {
    generatedAt: new Date().toISOString(),
    projectId,
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
    resolve(outputPath, 'codex-tags-template.json'),
    `${JSON.stringify(samples.map((sample) => ({
      sampleKey: sample.sampleKey,
      tags: { mealTypes: [], cuisines: [], modifiers: [] },
    })), null, 2)}\n`,
    'utf8',
  );
  console.log(JSON.stringify({
    event: 'tagging-evaluation-collected',
    samples: samples.length,
    apiResults: results.length,
    aiRequired: inventory.totals.aiRequired,
    outputPath,
  }));
}

async function retryGemini({ projectId, outputDir }) {
  initializeApp({
    credential: applicationDefault(),
    projectId,
  });
  const db = getFirestore();
  const outputPath = resolve(outputDir);
  const dataPath = resolve(outputPath, 'evaluation-data.json');
  const data = JSON.parse(await readFile(dataPath, 'utf8'));
  if (!Array.isArray(data.samples) || data.samples.length !== 26) {
    throw new Error('Existing evaluation data does not contain 26 samples');
  }

  console.log(JSON.stringify({ event: 'tagging-evaluation-gemini-retry-scan-started' }));
  const before = await readSafetySnapshot(db);
  const secretClient = new SecretManagerServiceClient();
  const geminiApiKey = await secretValue(
    secretClient,
    projectId,
    'mealwizard-gemini-api-key',
  );
  const geminiResults = [];
  for (const model of [
    'gemini-3.1-flash-lite',
    'gemini-3.5-flash-lite',
    'gemini-3.6-flash',
  ]) {
    geminiResults.push(...await runModel({
      model,
      samples: data.samples,
      call: (prompt) => callGemini({ apiKey: geminiApiKey, model, prompt }),
    }));
  }
  const after = await readSafetySnapshot(db);
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
    recipesUnchanged: equalFingerprint(
      before.recipeData.fingerprint,
      after.recipeData.fingerprint,
    ),
    mealPlansUnchanged: equalFingerprint(before.mealPlans, after.mealPlans),
    cookbooksUnchanged: equalFingerprint(before.cookbooks, after.cookbooks),
    recipeSiteRequests: 0,
  };
  if (!verification.recipesUnchanged
    || !verification.mealPlansUnchanged
    || !verification.cookbooksUnchanged) {
    throw new Error('Firestore fingerprints changed during the Gemini retry');
  }
  data.results = [
    ...data.results.filter((result) => !result.model.startsWith('gemini-')),
    ...geminiResults,
  ];
  data.verification = verification;
  data.geminiRetriedAt = new Date().toISOString();
  await writeFile(dataPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    event: 'tagging-evaluation-gemini-retried',
    samples: data.samples.length,
    geminiResults: geminiResults.length,
    outputPath,
  }));
}

async function refreshInventory({ projectId, outputDir }) {
  initializeApp({
    credential: applicationDefault(),
    projectId,
  });
  const db = getFirestore();
  const outputPath = resolve(outputDir);
  const dataPath = resolve(outputPath, 'evaluation-data.json');
  const data = JSON.parse(await readFile(dataPath, 'utf8'));
  const recipeData = await readRecipeDocuments(db);
  data.inventory = buildInventory(recipeData.recipes);
  data.inventoryRefreshedAt = new Date().toISOString();
  await writeFile(dataPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    event: 'tagging-evaluation-inventory-refreshed',
    recipes: data.inventory.totals.recipes,
    aiRequired: data.inventory.totals.aiRequired,
    missingTimeOnly: data.inventory.totals.missingTimeOnly,
    outputPath,
  }));
}

function summarizeModels(data, codexResults) {
  const summaries = [];
  for (const model of Object.keys(MODEL_PRICING_USD_PER_MILLION)
    .filter((key) => !key.startsWith('codex-'))) {
    const results = data.results.filter((result) => result.model === model);
    if (results.length === 0) continue;
    const evaluationCostUsd = results.reduce((sum, result) => sum + result.costUsd, 0);
    const usage = results.reduce((total, result) => ({
      inputTokens: total.inputTokens + Number(result.usage.inputTokens ?? 0),
      cachedInputTokens: total.cachedInputTokens
        + Number(result.usage.cachedInputTokens ?? 0),
      outputTokens: total.outputTokens + Number(result.usage.outputTokens ?? 0),
    }), { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 });
    const multiplier = data.inventory.totals.aiRequired / results.length;
    const batchCost = tokenCost(model, usage, { batch: true });
    summaries.push({
      model,
      evaluationCostUsd,
      projectedStandardCostUsd: evaluationCostUsd * multiplier,
      projectedBatchCostUsd: batchCost * multiplier,
    });
  }
  const codexEvaluationCost = codexResults.reduce(
    (sum, result) => sum + Number(result.costUsd ?? 0),
    0,
  );
  summaries.push({
    model: 'Codex / GPT-5.6 Sol API-equivalent',
    evaluationCostUsd: codexEvaluationCost,
    projectedStandardCostUsd:
      codexEvaluationCost * data.inventory.totals.aiRequired / codexResults.length,
    projectedBatchCostUsd: undefined,
  });
  return summaries;
}

async function render({ outputDir }) {
  const outputPath = resolve(outputDir);
  const data = JSON.parse(await readFile(resolve(outputPath, 'evaluation-data.json'), 'utf8'));
  const codexInput = JSON.parse(await readFile(resolve(outputPath, 'codex-tags.json'), 'utf8'));
  if (!Array.isArray(codexInput)
    || codexInput.length !== data.samples.length
    || new Set(codexInput.map((result) => result.sampleKey)).size !== data.samples.length) {
    throw new Error('Codex tags must contain exactly one result per sample');
  }
  const geminiUsage = new Map(data.results
    .filter((result) => result.model === 'gemini-3.1-flash-lite')
    .map((result) => [result.sampleKey, result.usage]));
  const codexResults = codexInput.map((result) => {
    const validation = validateTagResponse(result.tags);
    if (!validation.valid) {
      throw new Error(`Invalid Codex tags for ${result.sampleKey}: ${validation.errors.join(', ')}`);
    }
    const usageProxy = geminiUsage.get(result.sampleKey) ?? {
      inputTokens: 0,
      outputTokens: 0,
    };
    return {
      sampleKey: result.sampleKey,
      tags: validation.tags,
      valid: true,
      costUsd: tokenCost('codex-gpt-5.6-sol-estimate', usageProxy),
    };
  });
  const modelSummaries = summarizeModels(data, codexResults);
  await writeFile(
    resolve(outputPath, 'tagging-evaluation-report.md'),
    renderEvaluationReport({
      samples: data.samples,
      results: data.results,
      codexResults,
      verification: data.verification,
    }),
    'utf8',
  );
  await writeFile(
    resolve(outputPath, 'tagging-inventory.md'),
    renderInventoryReport({
      inventory: data.inventory,
      modelSummaries,
    }),
    'utf8',
  );
  console.log(JSON.stringify({
    event: 'tagging-evaluation-rendered',
    samples: data.samples.length,
    models: modelSummaries.length,
    outputPath,
  }));
}

const arguments_ = parseArguments(process.argv.slice(2));
if (arguments_.mode === 'collect') {
  await collect(arguments_);
} else if (arguments_.mode === 'retry-gemini') {
  await retryGemini(arguments_);
} else if (arguments_.mode === 'refresh-inventory') {
  await refreshInventory(arguments_);
} else {
  await render(arguments_);
}
