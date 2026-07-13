import { logger } from 'firebase-functions';

const GEMINI_API_BASE =
  'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_TIMEOUT_MS = 45_000;

interface GeminiRequest {
  apiKey: string;
  model: string;
  prompt: string;
  maxOutputTokens: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
}

interface GeminiResponseEnvelope {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
    finishReason?: string;
  }>;
  usageMetadata?: GeminiUsageMetadata;
}

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
}: GeminiRequest): Promise<T> {
  if (apiKey.trim().length === 0) {
    throw new GeminiProviderError('provider-secret-missing');
  }

  const url = `${GEMINI_API_BASE}/${encodeURIComponent(model)}:generateContent`;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [{ text: prompt }],
        },
      ],
      generationConfig: {
        temperature: 0,
        maxOutputTokens,
        responseMimeType: 'application/json',
      },
    }),
  });

  if (!response.ok) {
    throw new GeminiProviderError(`provider-http-${response.status}`);
  }

  let envelope: GeminiResponseEnvelope;
  try {
    envelope = (await response.json()) as GeminiResponseEnvelope;
  } catch {
    throw new GeminiProviderError('provider-invalid-response');
  }

  logger.info('gemini_usage', {
    model,
    promptTokenCount: envelope.usageMetadata?.promptTokenCount,
    candidatesTokenCount: envelope.usageMetadata?.candidatesTokenCount,
    totalTokenCount: envelope.usageMetadata?.totalTokenCount,
  });

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
