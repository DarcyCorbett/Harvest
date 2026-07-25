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
  sitemapChildPattern?: RegExp;
}

export interface RecipeSourceAdapter {
  sourceKey: string;
  discover(cursor?: string): AsyncIterable<DiscoveredUrl>;
  canonicalize(url: string): string;
  fetch(url: string): Promise<SourceFetchResult>;
}

export interface SourceAdapterDependencies {
  request(url: string): Promise<SourceHttpResponse>;
  sleep(milliseconds: number): Promise<void>;
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
  { sourceKey: 'recipetineats', host: 'www.recipetineats.com', discoveryUrl: 'https://www.recipetineats.com/sitemap_index.xml', minDelayMs: 1_000, sitemapChildPattern: WORDPRESS_POST_SITEMAP },
  { sourceKey: 'budgetbytes', host: 'www.budgetbytes.com', discoveryUrl: 'https://www.budgetbytes.com/sitemap_index.xml', minDelayMs: 1_000, sitemapChildPattern: WORDPRESS_POST_SITEMAP },
  { sourceKey: 'thewoksoflife', host: 'thewoksoflife.com', discoveryUrl: 'https://thewoksoflife.com/sitemap_index.xml', minDelayMs: 1_000, sitemapChildPattern: WORDPRESS_POST_SITEMAP },
  { sourceKey: 'themediterraneandish', host: 'www.themediterraneandish.com', discoveryUrl: 'https://www.themediterraneandish.com/sitemap_index.xml', minDelayMs: 1_000, sitemapChildPattern: WORDPRESS_POST_SITEMAP },
  { sourceKey: 'spendwithpennies', host: 'www.spendwithpennies.com', discoveryUrl: 'https://www.spendwithpennies.com/sitemap_index.xml', minDelayMs: 1_000, sitemapChildPattern: WORDPRESS_POST_SITEMAP },
  { sourceKey: 'cafedelites', host: 'cafedelites.com', discoveryUrl: 'https://cafedelites.com/sitemap_index.xml', minDelayMs: 1_000, sitemapChildPattern: WORDPRESS_POST_SITEMAP },
  { sourceKey: 'skinnytaste', host: 'www.skinnytaste.com', discoveryUrl: 'https://www.skinnytaste.com/sitemap_index.xml', minDelayMs: 1_000, sitemapChildPattern: WORDPRESS_POST_SITEMAP },
  { sourceKey: 'pinchofyum', host: 'pinchofyum.com', discoveryUrl: 'https://pinchofyum.com/sitemap_index.xml', minDelayMs: 1_000, sitemapChildPattern: WORDPRESS_POST_SITEMAP },
  { sourceKey: 'natashaskitchen', host: 'natashaskitchen.com', discoveryUrl: 'https://natashaskitchen.com/sitemap_index.xml', minDelayMs: 1_000, sitemapChildPattern: WORDPRESS_POST_SITEMAP },
  { sourceKey: 'seriouseats', host: 'www.seriouseats.com', discoveryUrl: 'https://www.seriouseats.com/sitemap.xml', minDelayMs: 1_500 },
  { sourceKey: 'akispetretzikis', host: 'akispetretzikis.com', discoveryUrl: 'https://akispetretzikis.com/sitemap.xml', minDelayMs: 1_500 },
  { sourceKey: 'nytcooking', host: 'cooking.nytimes.com', discoveryUrl: 'https://www.nytimes.com/sitemaps/new/cooking.xml.gz', minDelayMs: 2_000 },
  { sourceKey: 'americastestkitchen', host: 'www.americastestkitchen.com', discoveryUrl: 'https://www.americastestkitchen.com/sitemap.xml', minDelayMs: 2_000 },
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

function retryDelay(response: SourceHttpResponse, attempt: number): number {
  const retryAfter = Number(header(response, 'retry-after'));
  return Number.isFinite(retryAfter) && retryAfter >= 0
    ? retryAfter * 1_000
    : Math.min(30_000, 1_000 * (2 ** attempt));
}

async function defaultRequest(url: string): Promise<SourceHttpResponse> {
  const response = await fetch(url, {
    headers: {
      accept: 'text/html,application/xml,text/xml,application/json',
      'user-agent': 'MealWizardCatalogue/1.0 (+private recipe catalogue)',
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
  };
}

export function createSourceAdapter(
  config: SourceConfig,
  injectedDependencies?: SourceAdapterDependencies,
): RecipeSourceAdapter {
  const dependencies = injectedDependencies ?? createDefaultDependencies(config.minDelayMs);
  const canonicalize = (value: string): string => {
    const canonical = canonicalizeRecipeUrl(value);
    const parsed = new URL(canonical);
    if (parsed.protocol !== 'https:' || parsed.hostname !== config.host) {
      throw new Error(`URL is outside source ${config.sourceKey}`);
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
        if (attempt < 2) await dependencies.sleep(retryDelay(last, attempt));
        continue;
      }
      if (last.status !== 429 && last.status < 500) return last;
      if (attempt < 2) await dependencies.sleep(retryDelay(last, attempt));
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
