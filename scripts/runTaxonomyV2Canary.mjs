import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { applicationDefault, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

import {
  TAXONOMY_V2_MODEL,
  TAXONOMY_V2_RESPONSE_JSON_SCHEMA,
  buildTaxonomyV2Prompt,
  parseAndDeriveTaxonomyV2,
  taxonomyV2PromptHash,
} from '../functions/lib/catalogue/taxonomyV2.js';

const projectId = 'meal-wizard-ad202';
const outputDir = resolve('artifacts/catalogue-taxonomy-v2-canary');
const taggingDir = resolve('artifacts/catalogue-tagging-evaluation/new-recipes-v4');
const mealDir = resolve('artifacts/catalogue-meal-type-evaluation/updated-prompt');

async function json(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function metrics(predictions, truth, field) {
  let tp = 0; let fp = 0; let fn = 0;
  for (const [key, expected] of truth) {
    const actual = predictions.get(key)?.[field];
    if (actual === true && expected[field] === true) tp += 1;
    if (actual === true && expected[field] === false) fp += 1;
    if (actual === false && expected[field] === true) fn += 1;
  }
  const precision = tp + fp ? tp / (tp + fp) : 1;
  const recall = tp + fn ? tp / (tp + fn) : 1;
  return { tp, fp, fn, precision, recall, f1: precision + recall ? 2 * precision * recall / (precision + recall) : 0 };
}

async function secretValue() {
  const client = new SecretManagerServiceClient();
  const [version] = await client.accessSecretVersion({
    name: `projects/${projectId}/secrets/mealwizard-gemini-api-key/versions/latest`,
  });
  const value = version.payload?.data?.toString().trim();
  if (!value) throw new Error('Gemini secret is unavailable');
  return value;
}

async function callGemini(apiKey, content) {
  const started = Date.now();
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(TAXONOMY_V2_MODEL)}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      signal: AbortSignal.timeout(90_000),
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: buildTaxonomyV2Prompt(content) }] }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 2_048,
          responseMimeType: 'application/json',
          responseJsonSchema: TAXONOMY_V2_RESPONSE_JSON_SCHEMA,
          thinkingConfig: { thinkingLevel: 'minimal' },
        },
      }),
    },
  );
  const envelope = await response.json();
  if (!response.ok) throw new Error(`Gemini HTTP ${response.status}`);
  const text = envelope.candidates?.[0]?.content?.parts
    ?.filter((part) => typeof part.text === 'string' && part.thought !== true)
    .map((part) => part.text).join('') ?? '';
  const parsed = parseAndDeriveTaxonomyV2(JSON.parse(text));
  const usage = envelope.usageMetadata ?? {};
  return {
    ...parsed,
    usage: {
      inputTokens: Number(usage.promptTokenCount ?? 0),
      outputTokens: Number(usage.candidatesTokenCount ?? 0) + Number(usage.thoughtsTokenCount ?? 0),
      totalTokens: Number(usage.totalTokenCount ?? 0),
    },
    latencyMs: Date.now() - started,
  };
}

const [tagData, tagReview, mealData] = await Promise.all([
  json(resolve(taggingDir, 'evaluation-data.json')),
  json(resolve(taggingDir, 'human-review.json')),
  json(resolve(mealDir, 'evaluation-data.json')),
]);
const samples = new Map([...tagData.samples, ...mealData.samples]
  .map((sample) => [sample.recipeId, sample]));
initializeApp({ credential: applicationDefault(), projectId });
const db = getFirestore();
const snapshots = await db.getAll(...[...samples.keys()].map((id) => db.collection('recipes').doc(id)));
const recipes = snapshots.flatMap((snapshot) => snapshot.exists
  && snapshot.get('schemaVersion') === 2 && snapshot.get('status') === 'ready'
  ? [{ ...snapshot.data(), id: snapshot.id }] : []);
if (recipes.length !== samples.size) throw new Error('Canary recipe set is incomplete');
const apiKey = await secretValue();
const results = new Array(recipes.length);
let next = 0;
async function worker() {
  while (next < recipes.length) {
    const index = next++;
    const recipe = recipes[index];
    try {
      results[index] = { recipeId: recipe.id, valid: true, ...(await callGemini(apiKey, recipe.content)) };
    } catch (error) {
      results[index] = {
        recipeId: recipe.id, valid: false,
        error: error instanceof Error ? error.message : 'provider-error',
      };
    }
    console.log(JSON.stringify({ event: 'taxonomy-v2-canary', completed: index + 1, total: recipes.length }));
  }
}
await Promise.all(Array.from({ length: 4 }, () => worker()));

const byId = new Map(results.filter(({ valid }) => valid)
  .map((result) => [result.recipeId, result.derived]));
const tagSampleByKey = new Map(tagData.samples.map((sample) => [sample.sampleKey, sample.recipeId]));
const humanTruth = new Map(tagReview.map((review) => [tagSampleByKey.get(review.sampleKey), {
  kidFriendly: review.kidFriendly, healthy: review.healthy,
}]).filter(([id]) => id));
const priorTags = new Map(tagData.results
  .filter((result) => result.model === TAXONOMY_V2_MODEL && result.validation?.valid)
  .map((result) => [tagSampleByKey.get(result.sampleKey), result.validation.tags])
  .filter(([id]) => id));
const mealSampleByKey = new Map(mealData.samples.map((sample) => [sample.sampleKey, sample.recipeId]));
const priorMeals = new Map(mealData.results
  .filter((result) => result.model === TAXONOMY_V2_MODEL && result.validation?.valid)
  .map((result) => [mealSampleByKey.get(result.sampleKey), result.validation.mealTypes])
  .filter(([id]) => id));
const tagAgreement = [...priorTags].filter(([id, prior]) => {
  const current = byId.get(id);
  return current && current.kidFriendly === prior.kidFriendly && current.healthy === prior.healthy;
}).length;
const mealAgreement = [...priorMeals].filter(([id, prior]) =>
  JSON.stringify(byId.get(id)?.mealTypes) === JSON.stringify(prior)).length;
const summary = {
  generatedAt: new Date().toISOString(),
  projectId,
  model: TAXONOMY_V2_MODEL,
  promptHash: taxonomyV2PromptHash(),
  recipes: recipes.length,
  valid: results.filter(({ valid }) => valid).length,
  invalid: results.filter(({ valid }) => !valid).length,
  humanMetrics: {
    kidFriendly: metrics(byId, humanTruth, 'kidFriendly'),
    healthy: metrics(byId, humanTruth, 'healthy'),
  },
  separatePromptAgreement: {
    kidHealthy: { matches: tagAgreement, total: priorTags.size },
    mealTypes: { matches: mealAgreement, total: priorMeals.size },
  },
  usage: results.reduce((total, result) => ({
    inputTokens: total.inputTokens + Number(result.usage?.inputTokens ?? 0),
    outputTokens: total.outputTokens + Number(result.usage?.outputTokens ?? 0),
  }), { inputTokens: 0, outputTokens: 0 }),
};
await mkdir(outputDir, { recursive: true });
await Promise.all([
  writeFile(resolve(outputDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`),
  writeFile(resolve(outputDir, 'results.json'), `${JSON.stringify(results, null, 2)}\n`),
]);
console.log(JSON.stringify(summary));
