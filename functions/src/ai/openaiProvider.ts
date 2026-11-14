import { logger } from 'firebase-functions';

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
const DEFAULT_TIMEOUT_MS = 45_000;

export class OpenAiProviderError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'OpenAiProviderError';
  }
}

interface OpenAiRequest {
  apiKey: string;
  model: string;
  prompt: string;
  /** Includes reasoning tokens, so leave headroom above the visible answer. */
  maxOutputTokens: number;
  reasoningEffort: 'low' | 'medium' | 'high';
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** One JSON-object answer from the OpenAI Responses API. The prompt must ask for JSON. */
export async function requestOpenAiJson<T>({
  apiKey,
  model,
  prompt,
  maxOutputTokens,
  reasoningEffort,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
}: OpenAiRequest): Promise<T> {
  if (apiKey.trim().length === 0) throw new OpenAiProviderError('provider-secret-missing');
  let response: Response;
  try {
    response = await fetchImpl(OPENAI_RESPONSES_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        model,
        input: `${prompt}\nReturn only raw JSON. No Markdown, code fences, or commentary.`,
        reasoning: { effort: reasoningEffort },
        max_output_tokens: maxOutputTokens,
        store: false,
        text: { format: { type: 'json_object' } },
      }),
    });
  } catch (error) {
    const name = typeof error === 'object' && error !== null && 'name' in error
      ? (error as { name?: unknown }).name
      : undefined;
    throw new OpenAiProviderError(
      name === 'AbortError' || name === 'TimeoutError' ? 'provider-timeout' : 'provider-network',
    );
  }
  if (!response.ok) throw new OpenAiProviderError(`provider-http-${response.status}`);

  let body: {
    status?: string;
    output?: { type?: string; content?: { type?: string; text?: string }[] }[];
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  try {
    body = await response.json() as typeof body;
  } catch {
    throw new OpenAiProviderError('provider-invalid-response');
  }
  logger.info('openai_usage', {
    model,
    inputTokens: body.usage?.input_tokens ?? 0,
    outputTokens: body.usage?.output_tokens ?? 0,
  });
  if (body.status !== 'completed') throw new OpenAiProviderError('provider-incomplete');
  const text = (body.output ?? [])
    .filter((item) => item.type === 'message')
    .flatMap((item) => item.content ?? [])
    .filter((part) => part.type === 'output_text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
  if (!text) throw new OpenAiProviderError('provider-empty-response');
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new OpenAiProviderError('provider-invalid-json');
  }
}
