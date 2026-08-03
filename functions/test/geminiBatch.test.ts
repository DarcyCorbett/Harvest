import { describe, expect, it } from 'vitest';

import {
  GEMINI_BATCH_MODEL,
  MAX_BATCH_RECIPES,
  buildGeminiBatchShards,
  createGeminiBatchApi,
  isSuccessfulGeminiBatchState,
  recipeRequiresAi,
} from '../src/catalogue/geminiBatch.js';
import type { CompleteCanonicalRecipeV2 } from '../src/catalogue/domain.js';

function recipe(): CompleteCanonicalRecipeV2 {
  return {
    schemaVersion: 2,
    id: 'recipe-1',
    status: 'review',
    source: {
      key: 'source',
      canonicalUrl: 'https://source.test/recipe',
      originalUrl: 'https://source.test/recipe',
    },
    content: {
      title: 'Dinner',
      originalServings: 4,
      ingredients: [{ name: 'onion' }],
      instructions: [{ text: 'Cook.' }],
    },
    sourceMetadata: { mealTypes: [], cuisines: [], modifiers: [] },
    effective: { mealTypes: [], cuisines: [], modifiers: [] },
    search: {
      selectionKeys: [],
      vegetarian: false,
      kidFriendly: false,
      healthy: false,
      salad: false,
      quick30: false,
      moderate45: false,
      ingredientTokens: ['onion'],
      randomKey: 0.5,
    },
    classification: {
      parserVersion: 2,
      classifierVersion: 0,
      taxonomyVersion: 1,
      sources: {},
      complete: false,
    },
    ingestion: { contentHash: 'hash' },
  };
}

describe('Gemini initial backfill batches', () => {
  it('requires AI only for displayable recipes missing meal type or cuisine', () => {
    const unresolved = recipe();
    expect(recipeRequiresAi(unresolved)).toBe(true);
    expect(recipeRequiresAi({
      ...unresolved,
      effective: { ...unresolved.effective, mealTypes: ['dinner'], cuisines: ['global'] },
    })).toBe(false);
    expect(recipeRequiresAi({
      ...unresolved,
      content: { ...unresolved.content, instructions: [] },
    })).toBe(false);
    expect(recipeRequiresAi({
      ...unresolved,
      source: {
        ...unresolved.source,
        key: 'seriouseats',
        canonicalUrl: 'https://www.seriouseats.com/frozen-recipe',
        originalUrl: 'https://www.seriouseats.com/frozen-recipe',
      },
    })).toBe(false);
    expect(recipeRequiresAi({
      ...unresolved,
      source: {
        ...unresolved.source,
        key: 'akispetretzikis',
        canonicalUrl: 'https://akispetretzikis.com/en/recipe/1/frozen-recipe',
        originalUrl: 'https://akispetretzikis.com/en/recipe/1/frozen-recipe',
      },
    })).toBe(false);
  });

  it('creates deterministic JSONL shards capped at 5,000 recipes', () => {
    const recipes = Array.from({ length: MAX_BATCH_RECIPES + 1 }, (_, index) => ({
      id: `recipe-${String(MAX_BATCH_RECIPES - index).padStart(5, '0')}`,
      title: 'Recipe',
      ingredients: ['onion'],
    }));
    const first = buildGeminiBatchShards(recipes);
    const second = buildGeminiBatchShards([...recipes].reverse());

    expect(first).toHaveLength(2);
    expect(first[0].recipeIds).toHaveLength(MAX_BATCH_RECIPES);
    expect(first.map(({ jsonl }) => jsonl)).toEqual(second.map(({ jsonl }) => jsonl));
    expect(first[0].jsonl).toContain('"responseJsonSchema"');
    const request = JSON.parse(first[0].jsonl.split('\n')[0]) as {
      request: { generationConfig: { responseJsonSchema: {
        properties: { mealTypes: { minItems?: number }; cuisines: { minItems?: number } };
      } } };
    };
    expect(request.request.generationConfig.responseJsonSchema.properties.mealTypes.minItems)
      .toBe(1);
    expect(request.request.generationConfig.responseJsonSchema.properties.cuisines.minItems)
      .toBe(1);
  });

  it('uses the stable model and official file Batch API endpoints', async () => {
    const calls: string[] = [];
    const fetchImpl = async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/upload/')) {
        return new Response('{}', {
          status: 200,
          headers: { 'x-goog-upload-url': 'https://upload.test/session' },
        });
      }
      if (url === 'https://upload.test/session') {
        return Response.json({ file: { name: 'files/input' } });
      }
      return Response.json({ name: 'batches/job' });
    };
    const api = createGeminiBatchApi({ apiKey: 'secret', fetchImpl: fetchImpl as typeof fetch });
    const file = await api.uploadJsonl('fixture', Buffer.from('{}\n'));
    await expect(api.createBatch(file, 'fixture')).resolves.toBe('batches/job');

    expect(calls).toContain(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_BATCH_MODEL}:batchGenerateContent`,
    );
  });

  it('accepts the provider batch success state used by completed file batches', async () => {
    const api = createGeminiBatchApi({
      apiKey: 'secret',
      fetchImpl: (async () => Response.json({
        metadata: { state: 'BATCH_STATE_SUCCEEDED' },
        response: { responsesFile: 'files/results' },
      })) as typeof fetch,
    });

    await expect(api.getBatch('batches/job')).resolves.toEqual({
      state: 'BATCH_STATE_SUCCEEDED',
      resultFileName: 'files/results',
    });
    expect(isSuccessfulGeminiBatchState('BATCH_STATE_SUCCEEDED')).toBe(true);
    expect(isSuccessfulGeminiBatchState('BATCH_STATE_RUNNING')).toBe(false);
  });
});
