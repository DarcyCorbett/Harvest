import { describe, expect, it, vi } from 'vitest';

import {
  GeminiProviderError,
  requestGeminiJson,
} from '../src/ai/geminiProvider.js';
import {
  shoppingGroupsRequest,
  substitutionsRequest,
  tagRecipesRequest,
} from '../src/ai/contracts.js';

const API_KEY = 'test-secret-key-never-expose';

function providerResponse(text: string, finishReason = 'STOP'): Response {
  return new Response(
    JSON.stringify({
      candidates: [
        {
          content: { parts: [{ text }] },
          finishReason,
        },
      ],
      usageMetadata: {
        promptTokenCount: 4,
        candidatesTokenCount: 2,
        totalTokenCount: 6,
      },
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    },
  );
}

describe('requestGeminiJson', () => {
  it('uses the API key header and JSON response mode without exposing the key in the URL', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      providerResponse('{"answer":"ok"}'),
    );

    const result = await requestGeminiJson<{ answer: string }>({
      apiKey: API_KEY,
      model: 'gemini-test',
      prompt: 'Return JSON.',
      maxOutputTokens: 256,
      fetchImpl,
    });

    expect(result).toEqual({ answer: 'ok' });
    expect(fetchImpl).toHaveBeenCalledOnce();

    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).not.toContain(API_KEY);
    expect(String(url)).not.toContain('?key=');
    expect(init?.headers).toMatchObject({ 'x-goog-api-key': API_KEY });
    expect(init?.signal).toBeInstanceOf(AbortSignal);

    const body = JSON.parse(String(init?.body)) as {
      generationConfig: { responseMimeType: string };
    };
    expect(body.generationConfig.responseMimeType).toBe('application/json');
  });

  it('maps a provider HTTP error to a bounded credential-free error', async () => {
    const providerBody = `rate limited: ${API_KEY}`;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(providerBody, { status: 429 }),
    );

    let thrown: unknown;
    try {
      await requestGeminiJson({
        apiKey: API_KEY,
        model: 'gemini-test',
        prompt: 'Return JSON.',
        maxOutputTokens: 256,
        fetchImpl,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(GeminiProviderError);
    expect(thrown).toMatchObject({
      code: 'provider-http-429',
      message: 'provider-http-429',
    });
    expect((thrown as Error).message).not.toContain(API_KEY);
    expect((thrown as Error).message).not.toContain(providerBody);
  });

  it('rejects a successful provider envelope whose candidate text is not JSON', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      providerResponse('not valid JSON'),
    );

    await expect(
      requestGeminiJson({
        apiKey: API_KEY,
        model: 'gemini-test',
        prompt: 'Return JSON.',
        maxOutputTokens: 256,
        fetchImpl,
      }),
    ).rejects.toMatchObject({
      name: 'GeminiProviderError',
      code: 'provider-invalid-json',
      message: 'provider-invalid-json',
    });
  });

  it('rejects an empty API key with a bounded error', async () => {
    await expect(
      requestGeminiJson({
        apiKey: '   ',
        model: 'gemini-test',
        prompt: 'Return JSON.',
        maxOutputTokens: 256,
      }),
    ).rejects.toMatchObject({ code: 'provider-secret-missing' });
  });

  it('maps a MAX_TOKENS finish reason to a bounded error', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      providerResponse('{"partial":true}', 'MAX_TOKENS'),
    );

    await expect(
      requestGeminiJson({
        apiKey: API_KEY,
        model: 'gemini-test',
        prompt: 'Return JSON.',
        maxOutputTokens: 1,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: 'provider-max-tokens' });
  });

  it('rejects a provider envelope without candidate text', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ candidates: [] }), { status: 200 }),
    );

    await expect(
      requestGeminiJson({
        apiKey: API_KEY,
        model: 'gemini-test',
        prompt: 'Return JSON.',
        maxOutputTokens: 256,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: 'provider-empty-response' });
  });
});

describe('AI request contract caps', () => {
  it('rejects a tag request with an empty recipes array', () => {
    expect(
      tagRecipesRequest.safeParse({
        householdId: 'household-1',
        recipes: [],
      }).success,
    ).toBe(false);
  });

  it('rejects a shopping-group request with 501 ingredients', () => {
    const ingredients = Array.from({ length: 501 }, (_, id) => ({
      id,
      name: `Ingredient ${id}`,
      quantity: 1,
      unit: 'item',
    }));

    expect(
      shoppingGroupsRequest.safeParse({
        householdId: 'household-1',
        ingredients,
      }).success,
    ).toBe(false);
  });

  it('rejects a substitution request with a 121-character ingredient name', () => {
    expect(
      substitutionsRequest.safeParse({
        householdId: 'household-1',
        ingredientName: 'x'.repeat(121),
        ingredientUnit: 'g',
        recipeTitle: 'Dinner',
        allIngredients: ['Rice'],
      }).success,
    ).toBe(false);
  });
});
