import fs from 'node:fs';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { makeRequest, parseEnvelope, redact, type Case, type Provider } from './aiEvaluationCore';

export async function loadGeminiKey(): Promise<string> {
  const client = new SecretManagerServiceClient();
  try {
    const [v] = await client.accessSecretVersion({ name: 'projects/meal-wizard-ad202/secrets/mealwizard-gemini-api-key/versions/latest' });
    const key = v.payload?.data?.toString().trim();
    if (!key) throw new Error('Gemini credential missing');
    return key;
  } finally { await client.close(); }
}
export async function loadKeys(file: string): Promise<Record<Provider, string>> {
  const raw = fs.readFileSync(file, 'utf8');
  const anthropic = raw.match(/sk-ant-[A-Za-z0-9_-]+/)?.[0];
  const openai = raw.match(/sk-(?!ant-)[A-Za-z0-9_-]{20,}/)?.[0];
  if (!anthropic || !openai) throw new Error('Provider key missing from supplied file');
  const gemini = await loadGeminiKey();
  return { anthropic, openai, gemini };
}
export function headers(provider: Provider, key: string) {
  return { 'Content-Type': 'application/json', ...(provider === 'openai' ? { Authorization: `Bearer ${key}` } : provider === 'anthropic' ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' } : { 'x-goog-api-key': key }) };
}
export async function preflight(keys: Record<Provider, string>) {
  const endpoints = { openai: 'https://api.openai.com/v1/models/gpt-6-luna', anthropic: 'https://api.anthropic.com/v1/models/claude-haiku-5-5', gemini: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash' };
  const result: any[] = [];
  for (const provider of Object.keys(endpoints) as Provider[]) {
    try {
      const response = await fetch(endpoints[provider], { headers: headers(provider, keys[provider]), signal: AbortSignal.timeout(30000), redirect: 'error' });
      const body = await response.json() as any;
      result.push({ provider, status: response.status, available: response.ok, model: body.id ?? body.name, error: response.ok ? undefined : redact(String(body.error?.message ?? body.error?.type ?? 'Model lookup failed'), Object.values(keys)).slice(0, 600) });
    } catch { result.push({ provider, available: false, error: 'Model lookup network failure' }); }
  }
  return result;
}
export async function callProvider(provider: Provider, c: Case, key: string, secrets: string[], effort?: string, fetchImpl = fetch, requestOverride?: { url: string; body: unknown }) {
  const request = requestOverride ?? makeRequest(provider, c, effort), start = performance.now();
  try {
    const response = await fetchImpl(request.url, { method: 'POST', headers: headers(provider, key), body: JSON.stringify(request.body), signal: AbortSignal.timeout(c.task === 'shopping' ? 180000 : 120000), redirect: 'error' });
    const text = await response.text();
    let body: any;
    try { body = JSON.parse(text); } catch { return { httpStatus: response.status, error: 'Non-JSON provider envelope', latencyMs: performance.now() - start, usage: null, complete: false, text: '' }; }
    const parsed = parseEnvelope(provider, body);
    return { ...parsed, text: redact(parsed.text, secrets), httpStatus: response.status, latencyMs: performance.now() - start, error: response.ok ? undefined : redact(String(body.error?.message ?? body.error?.type ?? `HTTP ${response.status}`), secrets).slice(0, 600) };
  } catch { return { httpStatus: 0, error: 'Network failure or timeout; billing unknown', latencyMs: performance.now() - start, usage: null, complete: false, text: '' }; }
}
