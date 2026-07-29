import { canonicalizeRecipeUrl } from './domain.js';

export interface DiscoveredUrl {
  url: string;
  lastModified?: string;
  cursor?: string;
}

export interface SourceHttpResponse {
  status: number;
  body: string;
  headers: Record<string, string | undefined>;
}

export type SourceFetchResult =
  | { kind: 'ok'; html: string; lastModified?: string }
  | { kind: 'retryable'; status: number }
  | { kind: 'permanent'; status: number }
  | { kind: 'unsupported'; status: number };

export interface SourceConfig {
  sourceKey: string;
  host: string;
  discoveryUrl: string;
  minDelayMs: number;
  rateLimitCooldownMs?: number;
  sitemapChildPattern?: RegExp;
  recipePathPattern?: RegExp;
}

export interface RecipeSourceAdapter {
  sourceKey: string;
  discover(cursor?: string): AsyncIterable<DiscoveredUrl>;
  canonicalize(url: string): string;
  fetch(url: string): Promise<SourceFetchResult>;
  render?(url: string): Promise<string | undefined>;
  setHeartbeat?(heartbeat: () => Promise<void>): void;
}

export interface SourceAdapterDependencies {
  request(url: string): Promise<SourceHttpResponse>;
  sleep(milliseconds: number): Promise<void>;
  random?: () => number;
  heartbeat?: () => Promise<void>;
  render?: (url: string) => Promise<string | undefined>;
}

export const WORDPRESS_SOURCE_KEYS = [
  'recipetineats',
  'budgetbytes',
  'thewoksoflife',
  'themediterraneandish',
  'spendwithpennies',
  'cafedelites',
  'skinnytaste',
  'pinchofyum',
  'natashaskitchen',
] as const;

const WORDPRESS_POST_SITEMAP = /\/post-sitemap\d*\.xml(?:$|\?)/i;

export const SOURCE_CONFIGS: readonly SourceConfig[] = [
  { sourceKey: 'recipetineats', host: 'www.recipetineats.com', discoveryUrl: 'https://www.recipetineats.com/sitemap_index.xml', minDelayMs: 1_000, sitemapChildPattern: WORDPRESS_POST_SITEMAP, recipePathPattern: /^\/(?:recipes\/)?(?!category\/|tag\/|author\/|about(?:\/|$)|privacy(?:\/|$))[^/]+\/?$/i },
  { sourceKey: 'budgetbytes', host: 'www.budgetbytes.com', discoveryUrl: 'https://www.budgetbytes.com/sitemap_index.xml', minDelayMs: 1_000, sitemapChildPattern: WORDPRESS_POST_SITEMAP, recipePathPattern: /^\/(?:recipes\/)?(?!category\/|tag\/|author\/)[^/]+\/?$/i },
  { sourceKey: 'thewoksoflife', host: 'thewoksoflife.com', discoveryUrl: 'https://thewoksoflife.com/sitemap_index.xml', minDelayMs: 1_000, sitemapChildPattern: WORDPRESS_POST_SITEMAP, recipePathPattern: /^\/(?:recipes\/)?(?!category\/|tag\/|author\/)[^/]+\/?$/i },
  { sourceKey: 'themediterraneandish', host: 'www.themediterraneandish.com', discoveryUrl: 'https://www.themediterraneandish.com/sitemap_index.xml', minDelayMs: 1_000, sitemapChildPattern: WORDPRESS_POST_SITEMAP, recipePathPattern: /^\/(?:recipes\/)?(?!category\/|tag\/|author\/)[^/]+\/?$/i },
  { sourceKey: 'spendwithpennies', host: 'www.spendwithpennies.com', discoveryUrl: 'https://www.spendwithpennies.com/sitemap_index.xml', minDelayMs: 10_000, rateLimitCooldownMs: 60_000, sitemapChildPattern: WORDPRESS_POST_SITEMAP, recipePathPattern: /^\/(?:recipes\/)?(?!category\/|tag\/|author\/)[^/]+\/?$/i },
  { sourceKey: 'cafedelites', host: 'cafedelites.com', discoveryUrl: 'https://cafedelites.com/sitemap_index.xml', minDelayMs: 1_000, sitemapChildPattern: WORDPRESS_POST_SITEMAP, recipePathPattern: /^\/(?:recipes\/)?(?!category\/|tag\/|author\/)[^/]+\/?$/i },
  { sourceKey: 'skinnytaste', host: 'www.skinnytaste.com', discoveryUrl: 'https://www.skinnytaste.com/sitemap_index.xml', minDelayMs: 1_000, sitemapChildPattern: WORDPRESS_POST_SITEMAP, recipePathPattern: /^\/(?:recipes\/)?(?!category\/|tag\/|author\/)[^/]+\/?$/i },
  { sourceKey: 'pinchofyum', host: 'pinchofyum.com', discoveryUrl: 'https://pinchofyum.com/sitemap_index.xml', minDelayMs: 1_000, sitemapChildPattern: WORDPRESS_POST_SITEMAP, recipePathPattern: /^\/(?:recipes\/)?(?!category\/|tag\/|author\/)[^/]+\/?$/i },
  { sourceKey: 'natashaskitchen', host: 'natashaskitchen.com', discoveryUrl: 'https://natashaskitchen.com/sitemap_index.xml', minDelayMs: 1_000, sitemapChildPattern: WORDPRESS_POST_SITEMAP, recipePathPattern: /^\/(?:recipes\/)?(?!category\/|tag\/|author\/)[^/]+\/?$/i },
  { sourceKey: 'seriouseats', host: 'www.seriouseats.com', discoveryUrl: 'https://www.seriouseats.com/sitemap.xml', minDelayMs: 1_500, recipePathPattern: /(?:\/recipes\/|[-/]recipe(?:-\d+)?\/?$)/i },
  { sourceKey: 'akispetretzikis', host: 'akispetretzikis.com', discoveryUrl: 'https://akispetretzikis.com/sitemap.xml', minDelayMs: 1_500, recipePathPattern: /\/recipes?\//i },
  { sourceKey: 'nytcooking', host: 'cooking.nytimes.com', discoveryUrl: 'https://www.nytimes.com/sitemaps/new/cooking.xml.gz', minDelayMs: 2_000, recipePathPattern: /^\/recipes\//i },
  { sourceKey: 'americastestkitchen', host: 'www.americastestkitchen.com', discoveryUrl: 'https://www.americastestkitchen.com/sitemap.xml', minDelayMs: 2_000, recipePathPattern: /^\/recipes\//i },
] as const;

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function element(block: string, name: string): string | undefined {
  const match = new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i').exec(block);
  return match ? decodeXml(match[1].trim()) : undefined;
}

function sitemapChildren(xml: string): string[] {
  if (!/<sitemapindex[\s>]/i.test(xml)) return [];
  return [...xml.matchAll(/<sitemap\b[^>]*>([\s\S]*?)<\/sitemap>/gi)]
    .map((match) => element(match[1], 'loc'))
    .filter((value): value is string => Boolean(value));
}

function sitemapUrls(xml: string): DiscoveredUrl[] {
  return [...xml.matchAll(/<url\b[^>]*>([\s\S]*?)<\/url>/gi)].flatMap((match) => {
    const url = element(match[1], 'loc');
    if (!url) return [];
    const lastModified = element(match[1], 'lastmod');
    return [{ url, ...(lastModified ? { lastModified } : {}) }];
  });
}

function header(response: SourceHttpResponse, name: string): string | undefined {
  const target = name.toLowerCase();
  const entry = Object.entries(response.headers).find(([key]) => key.toLowerCase() === target);
  return entry?.[1];
}

function encodeCursor(sitemapUrl: string, index: number): string {
  return Buffer.from(JSON.stringify({ sitemapUrl, index }), 'utf8').toString('base64url');
}

function decodeCursor(value: string | undefined): { sitemapUrl: string; index: number } | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as {
      sitemapUrl?: unknown;
      index?: unknown;
    };
    if (typeof parsed.sitemapUrl === 'string'
      && Number.isInteger(parsed.index)
      && (parsed.index as number) >= 0) {
      return { sitemapUrl: parsed.sitemapUrl, index: parsed.index as number };
    }
  } catch {
    // A stale or corrupt cursor safely restarts discovery.
  }
  return undefined;
}

function retryDelay(
  response: SourceHttpResponse,
  attempt: number,
  rateLimitCooldownMs?: number,
  random: () => number = Math.random,
): number {
  const retryAfterValue = header(response, 'retry-after');
  const retryAfterSeconds = Number(retryAfterValue);
  const retryAfterDate = retryAfterValue ? Date.parse(retryAfterValue) : Number.NaN;
  const retryAfterMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
    ? retryAfterSeconds * 1_000
    : Number.isFinite(retryAfterDate)
      ? Math.max(0, retryAfterDate - Date.now())
      : 0;
  const jitter = 0.8 + random() * 0.4;
  if (response.status === 429 && rateLimitCooldownMs) {
    const configured = rateLimitCooldownMs * (2 ** attempt);
    return Math.min(15 * 60_000, Math.ceil(Math.max(configured, retryAfterMs) * jitter));
  }
  return Math.ceil((retryAfterMs || Math.min(30_000, 1_000 * (2 ** attempt))) * jitter);
}

async function defaultRequest(url: string): Promise<SourceHttpResponse> {
  const response = await fetch(url, {
    headers: {
      accept: 'text/html,application/xml,text/xml,application/json',
      'accept-encoding': 'gzip, deflate, br',
      'accept-language': 'en-US,en;q=0.9',
      'cache-control': 'no-cache',
      'user-agent': 'Mozilla/5.0 (compatible; MealWizardCatalogue/1.0; +private recipe catalogue)',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000),
  });
  return {
    status: response.status,
    body: await response.text(),
    headers: Object.fromEntries(response.headers.entries()),
  };
}

function createDefaultDependencies(minDelayMs: number): SourceAdapterDependencies {
  let nextRequestAt = 0;
  const sleep = (milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  return {
    async request(url) {
      const wait = Math.max(0, nextRequestAt - Date.now());
      if (wait > 0) await sleep(wait);
      nextRequestAt = Date.now() + minDelayMs;
      return defaultRequest(url);
    },
    sleep,
    async render(url) {
      const { chromium } = await import('playwright');
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage({
          locale: 'en-US',
          userAgent: 'Mozilla/5.0 (compatible; MealWizardCatalogue/1.0; +private recipe catalogue)',
        });
        const response = await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: 45_000,
        });
        if (!response || [401, 402, 403, 429].includes(response.status())) return undefined;
        await page.waitForTimeout(1_500);
        return await page.content();
      } finally {
        await browser.close();
      }
    },
  };
}

export function createSourceAdapter(
  config: SourceConfig,
  injectedDependencies?: SourceAdapterDependencies,
): RecipeSourceAdapter {
  const dependencies = injectedDependencies ?? createDefaultDependencies(config.minDelayMs);
  const random = dependencies.random ?? (injectedDependencies ? () => 0.5 : Math.random);
  let heartbeat = dependencies.heartbeat;
  const sleepWithHeartbeat = async (milliseconds: number): Promise<void> => {
    if (milliseconds >= 60_000) await heartbeat?.();
    await dependencies.sleep(milliseconds);
    if (milliseconds >= 60_000) await heartbeat?.();
  };
  const canonicalize = (value: string): string => {
    const canonical = canonicalizeRecipeUrl(value);
    const parsed = new URL(canonical);
    if (parsed.protocol !== 'https:' || parsed.hostname !== config.host) {
      throw new Error(`URL is outside source ${config.sourceKey}`);
    }
    if (config.recipePathPattern && !config.recipePathPattern.test(parsed.pathname)) {
      throw new Error(`URL is not an admitted recipe path for ${config.sourceKey}`);
    }
    return canonical;
  };

  const requestWithRetries = async (url: string): Promise<SourceHttpResponse> => {
    let last: SourceHttpResponse | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        last = await dependencies.request(url);
      } catch {
        last = { status: 0, body: '', headers: {} };
        if (attempt < 2) {
          await sleepWithHeartbeat(retryDelay(
            last,
            attempt,
            config.rateLimitCooldownMs,
            random,
          ));
        }
        continue;
      }
      if (last.status !== 429 && last.status < 500) return last;
      if (attempt < 2 || (last.status === 429 && config.rateLimitCooldownMs)) {
        await sleepWithHeartbeat(retryDelay(
          last,
          attempt,
          config.rateLimitCooldownMs,
          random,
        ));
      }
    }
    return last as SourceHttpResponse;
  };

  async function* discover(cursor?: string): AsyncIterable<DiscoveredUrl> {
    const root = await requestWithRetries(config.discoveryUrl);
    if (root.status !== 200) throw new Error(`Discovery failed with HTTP ${root.status}`);
    const allChildren = sitemapChildren(root.body);
    const children = config.sitemapChildPattern
      ? allChildren.filter((child) => config.sitemapChildPattern?.test(child))
      : allChildren;
    if (allChildren.length > 0 && config.sitemapChildPattern && children.length === 0) {
      throw new Error(`Discovery found no recipe sitemap for ${config.sourceKey}`);
    }
    const sitemapQueue = children.length ? children : [config.discoveryUrl];
    const resume = decodeCursor(cursor);
    let cursorReached = resume === undefined;

    for (const sitemapUrl of sitemapQueue) {
      if (!cursorReached) {
        if (sitemapUrl !== resume?.sitemapUrl) continue;
        cursorReached = true;
      }
      const response = sitemapUrl === config.discoveryUrl
        ? root
        : await requestWithRetries(sitemapUrl);
      if (response.status !== 200) throw new Error(`Discovery failed with HTTP ${response.status}`);

      const discoveredUrls = sitemapUrls(response.body);
      const startIndex = resume?.sitemapUrl === sitemapUrl ? resume.index + 1 : 0;
      for (let index = startIndex; index < discoveredUrls.length; index += 1) {
        const discovered = discoveredUrls[index];
        try {
          yield {
            url: canonicalize(discovered.url),
            ...(discovered.lastModified ? { lastModified: discovered.lastModified } : {}),
            cursor: encodeCursor(sitemapUrl, index),
          };
        } catch {
          // A source sitemap can contain non-recipe or cross-domain URLs.
        }
      }
    }
  }

  return {
    sourceKey: config.sourceKey,
    discover,
    canonicalize,
    setHeartbeat(value) {
      heartbeat = value;
    },
    ...(dependencies.render ? { render: dependencies.render } : {}),
    async fetch(url) {
      const response = await requestWithRetries(canonicalize(url));
      if (response.status === 200) {
        return {
          kind: 'ok',
          html: response.body,
          ...(header(response, 'last-modified')
            ? { lastModified: header(response, 'last-modified') }
            : {}),
        };
      }
      if ([401, 402, 403].includes(response.status)) {
        return { kind: 'unsupported', status: response.status };
      }
      if (response.status === 404 || response.status === 410) {
        return { kind: 'permanent', status: response.status };
      }
      return { kind: 'retryable', status: response.status };
    },
  };
}

export function createTrustedSourceAdapters(
  dependencies?: SourceAdapterDependencies,
): RecipeSourceAdapter[] {
  return SOURCE_CONFIGS.map((config) => createSourceAdapter(config, dependencies));
}

export async function inventorySourceDiscovery(
  adapters: RecipeSourceAdapter[],
): Promise<{
  mode: 'crawl-inventory';
  totalDiscovered: number;
  bySource: Record<string, {
    discovered: number;
    status: 'complete' | 'failed';
    reasonCode?: string;
  }>;
}> {
  const bySource: Record<string, {
    discovered: number;
    status: 'complete' | 'failed';
    reasonCode?: string;
  }> = {};
  let totalDiscovered = 0;

  for (const adapter of adapters) {
    let discovered = 0;
    try {
      for await (const _item of adapter.discover()) discovered += 1;
      bySource[adapter.sourceKey] = { discovered, status: 'complete' };
      totalDiscovered += discovered;
    } catch (error) {
      bySource[adapter.sourceKey] = {
        discovered,
        status: 'failed',
        reasonCode: error instanceof Error ? error.name : 'unknown-error',
      };
    }
  }

  return { mode: 'crawl-inventory', totalDiscovered, bySource };
}
