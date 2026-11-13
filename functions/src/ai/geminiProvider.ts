import { logger } from 'firebase-functions';
import { z } from 'zod';

import { acceptsTemperature } from './models.js';

const GEMINI_API_BASE =
  'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_TIMEOUT_MS = 45_000;

export interface GeminiUsage {
  model: string;
  promptTokenCount: number;
  candidatesTokenCount: number;
  totalTokenCount: number;
}

interface GeminiRequest {
  apiKey: string;
  model: string;
  prompt: string;
  maxOutputTokens: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  onUsage?: (usage: GeminiUsage) => void;
  responseJsonSchema?: object;
  thinkingLevel?: 'minimal' | 'low' | 'medium' | 'high';
}

const tokenCount = z.number().finite().nonnegative().optional();
const geminiResponseEnvelope = z
  .object({
    candidates: z
      .array(
        z
          .object({
            content: z
              .object({
                parts: z
                  .array(
                    z
                      .object({
                        text: z.string().optional(),
                      })
                      .passthrough(),
                  )
                  .optional(),
              })
              .passthrough()
              .optional(),
            finishReason: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
    usageMetadata: z
      .object({
        promptTokenCount: tokenCount,
        candidatesTokenCount: tokenCount,
        totalTokenCount: tokenCount,
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export class GeminiProviderError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'GeminiProviderError';
  }
}

export async function requestGeminiJson<T>({
  apiKey,
  model,
  prompt,
  maxOutputTokens,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
  onUsage,
  responseJsonSchema,
  thinkingLevel,
}: GeminiRequest): Promise<T> {
  if (apiKey.trim().length === 0) {
    throw new GeminiProviderError('provider-secret-missing');
  }

  const url = `${GEMINI_API_BASE}/${encodeURIComponent(model)}:generateContent`;
  const signal = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      signal,
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [{ text: prompt }],
          },
        ],
        generationConfig: {
          ...(acceptsTemperature(model) ? { temperature: 0 } : {}),
          maxOutputTokens,
          responseMimeType: 'application/json',
          ...(responseJsonSchema ? { responseJsonSchema } : {}),
          ...(thinkingLevel ? { thinkingConfig: { thinkingLevel } } : {}),
        },
      }),
    });
  } catch (error) {
    const errorName =
      typeof error === 'object' && error !== null && 'name' in error
        ? (error as { name?: unknown }).name
        : undefined;
    const isTimeout =
      signal.aborted || errorName === 'AbortError' || errorName === 'TimeoutError';
    throw new GeminiProviderError(
      isTimeout ? 'provider-timeout' : 'provider-network',
    );
  }

  if (!response.ok) {
    throw new GeminiProviderError(`provider-http-${response.status}`);
  }

  let rawEnvelope: unknown;
  try {
    rawEnvelope = await response.json();
  } catch {
    throw new GeminiProviderError('provider-invalid-response');
  }

  const parsedEnvelope = geminiResponseEnvelope.safeParse(rawEnvelope);
  if (!parsedEnvelope.success) {
    throw new GeminiProviderError('provider-invalid-response');
  }
  const envelope = parsedEnvelope.data;

  const usage: GeminiUsage = {
    model,
    promptTokenCount: envelope.usageMetadata?.promptTokenCount ?? 0,
    candidatesTokenCount: envelope.usageMetadata?.candidatesTokenCount ?? 0,
    totalTokenCount: envelope.usageMetadata?.totalTokenCount ?? 0,
  };
  logger.info('gemini_usage', usage);
  onUsage?.(usage);

  const candidate = envelope.candidates?.[0];
  if (candidate?.finishReason === 'MAX_TOKENS') {
    throw new GeminiProviderError('provider-max-tokens');
  }

  const text = candidate?.content?.parts?.find(
    (part) => typeof part.text === 'string',
  )?.text;
  if (!text) {
    throw new GeminiProviderError('provider-empty-response');
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new GeminiProviderError('provider-invalid-json');
  }
}
