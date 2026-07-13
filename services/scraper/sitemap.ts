// ============================================================
// Sitemap walker — fetches XML sitemaps (incl. <sitemapindex> recursion
// and gzipped variants), filters URLs by per-site regex.
//
// Used by scripts/buildRecipeIndex.ts (Phase A — offline URL discovery
// for /recipeIndex/{site}/recipes/). Pure Node helper; not used at runtime
// by the React Native app.
// ============================================================

import { gunzipSync } from 'node:zlib';

export async function fetchWithPlaywright(url: string, ua: string): Promise<string> {
  // Dynamic import so Playwright isn't required unless Cloudflare blocks us
  let pw;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    pw = (await import('playwright')) as any;
  } catch {
    throw new Error(
      `\n[!] Cloudflare blocked the request. To bypass this, install Playwright:\n` +
      `      npm i -D playwright\n` +
      `      npx playwright install chromium\n` +
      `    Then re-run the script.\n`
    );
  }

  console.log(`[RecipeIndex] Launching Playwright to bypass Cloudflare for ${url}...`);
  const browser = await pw.chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ userAgent: ua });
    const page = await context.newPage();
    
    // Cloudflare returns 403 then challenges, so we don't fail on non-200.
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    
    // Wait for the Cloudflare challenge to pass
    const title = await page.title();
    if (title.toLowerCase().includes('just a moment') || title.toLowerCase().includes('attention required') || title.toLowerCase().includes('cloudflare')) {
      console.log(`[RecipeIndex] Solving Cloudflare challenge...`);
      await page.waitForFunction(() => {
        const t = document.title.toLowerCase();
        return !t.includes('just a moment') && !t.includes('attention required') && !t.includes('cloudflare');
      }, { timeout: 45000 }).catch(() => console.log('[RecipeIndex] Timeout waiting for challenge to clear.'));
    }
    
    // XML is usually displayed inside a viewer or as plain text. 
    // page.content() gives us the serialized DOM which contains the tags.
    return await page.content();
  } finally {
    await browser.close();
  }
}

export interface FetchSitemapOpts {
  /** Override User-Agent header. Default: Mozilla. Use Googlebot for NYT. */
  ua?: string;
  /** Force gzip decode. Default: auto-detect by `.gz` extension. */
  gzip?: boolean;
  /** Recurse into <sitemap><loc> children inside a <sitemapindex>. Default true. */
  recurse?: boolean;
  /** Max retries on 403/503 (Cloudflare-style transient blocks). Default 5. */
  maxRetries?: number;
}

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Browser-like header set. Cloudflare's basic bot detection looks at the
 * Sec-Fetch-* family, Accept-Language, Upgrade-Insecure-Requests, and a
 * realistic Accept value — minimal headers (UA + Accept only) get 403'd.
 */
function buildHeaders(ua: string): Record<string, string> {
  return {
    'User-Agent': ua,
    'Accept':
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,' +
      'image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Language': 'en-US,en;q=0.9',
    // gzip+deflate only — Node's native fetch decompresses these reliably across
    // versions; brotli (br) handling depends on Node version and could leave us
    // with binary garbage in res.text() on older runtimes.
    'Accept-Encoding': 'gzip, deflate',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    'Cache-Control': 'max-age=0',
  };
}

interface FetchResult {
  text: string;
  status: number;
  /** Set when the response body looks like a Cloudflare bot-challenge page. */
  cloudflareChallenge: boolean;
}

function looksLikeCloudflareChallenge(body: string): boolean {
  const head = body.slice(0, 4000).toLowerCase();
  return (
    head.includes('cf-chl') ||
    head.includes('cf_chl_opt') ||
    head.includes('challenge-platform') ||
    head.includes('just a moment') ||
    head.includes('attention required') ||
    head.includes('cloudflare')
  );
}

async function fetchOnce(url: string, ua: string, isGzip: boolean): Promise<FetchResult> {
  const res = await fetch(url, { headers: buildHeaders(ua) });

  if (isGzip) {
    const buf = Buffer.from(await res.arrayBuffer());
    // Node's native fetch transparently decompresses responses when the server
    // sends Content-Encoding: gzip — even for URLs ending in .gz. So the buffer
    // we get back may already be plain XML. Check gzip magic bytes (1f 8b) to
    // decide whether we still need to decompress; otherwise gunzipSync would
    // throw "incorrect header check" on already-decompressed content.
    const stillGzipped = buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
    let text: string;
    try {
      text = stillGzipped ? gunzipSync(buf).toString('utf8') : buf.toString('utf8');
    } catch {
      // Fallback: server lied about Content-Encoding, or magic-byte check was
      // wrong — try the other interpretation.
      text = stillGzipped ? buf.toString('utf8') : buf.toString('utf8');
    }
    if (!res.ok) {
      return { text, status: res.status, cloudflareChallenge: looksLikeCloudflareChallenge(text) };
    }
    return { text, status: res.status, cloudflareChallenge: false };
  }

  const text = await res.text();
  if (!res.ok) {
    return { text, status: res.status, cloudflareChallenge: looksLikeCloudflareChallenge(text) };
  }
  return { text, status: res.status, cloudflareChallenge: false };
}

/** True iff the body is an SE/Dotdash Meredith "access issue / licensing" page,
 *  which the server returns with HTTP 402. Distinct from Cloudflare's challenge. */
function looksLikeAccessBlock(body: string): boolean {
  const head = body.slice(0, 4000).toLowerCase();
  return (
    head.includes('support@people.inc') ||
    head.includes('contentlicensing@people.inc') ||
    head.includes('experiencing an access issue')
  );
}

async function fetchWithRetry(
  url: string,
  ua: string,
  isGzip: boolean,
  maxRetries: number,
): Promise<string> {
  let lastStatus = 0;
  let lastWasBlocked = false;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const res = await fetchOnce(url, ua, isGzip);
    if (res.status >= 200 && res.status < 300) return res.text;

    lastStatus = res.status;
    lastWasBlocked = res.cloudflareChallenge || looksLikeAccessBlock(res.text);

    // 402 = SE/Dotdash Meredith datacenter-IP/bot block. Deterministic — retrying
    // with the same Node fetch won't help. Break out and let Playwright try.
    if (res.status === 402) {
      console.log(
        `[RecipeIndex] HTTP 402 access-block detected on attempt ${attempt}. Skipping retries; will try Playwright.`,
      );
      lastWasBlocked = true;
      break;
    }

    // Retry on transient 403/503/429 (incl. Cloudflare challenges)
    if (res.status === 403 || res.status === 503 || res.status === 429) {
      if (res.cloudflareChallenge) {
        console.log(`[RecipeIndex] Cloudflare bot challenge detected on attempt ${attempt}. Bypassing retries...`);
        break; // break loop to trigger fallback immediately
      }

      const wait = Math.min(2000 * 2 ** (attempt - 1), 30000);
      console.log(
        `[RecipeIndex] Sitemap retry ${attempt}/${maxRetries} after HTTP ${res.status}; waiting ${wait}ms`,
      );
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }

    // Other status codes — fail fast
    throw new Error(`HTTP ${res.status}`);
  }

  // Out of retries — surface a friendlier message when it's clearly bot-blocking
  if (lastWasBlocked || lastStatus === 403 || lastStatus === 402) {
    if (isGzip) {
      throw new Error(
        `HTTP ${lastStatus} after ${maxRetries} retries — block on gzipped sitemap. ` +
        `Playwright fallback can't reliably hand back gzipped XML; try a different network or a non-gzip sitemap path.`,
      );
    }
    console.log(`[RecipeIndex] Node fetch blocked (HTTP ${lastStatus}). Attempting Playwright fallback...`);
    return await fetchWithPlaywright(url, ua);
  }
  throw new Error(`HTTP ${lastStatus} after ${maxRetries} retries`);
}

function extractLocs(xml: string): string[] {
  const out: string[] = [];
  const re = /<loc>([^<]+)<\/loc>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    out.push(m[1].trim());
  }
  return out;
}

function isSitemapIndex(xml: string): boolean {
  return /<sitemapindex[\s>]/i.test(xml);
}

/**
 * Walk a sitemap (root or sitemap-index) and return all URLs matching urlPattern.
 * Handles gzip decoding, sitemap-index recursion, and Cloudflare-style retries.
 */
export async function fetchSitemapUrls(
  rootUrl: string,
  urlPattern: RegExp,
  opts: FetchSitemapOpts = {},
): Promise<string[]> {
  const ua = opts.ua ?? DEFAULT_UA;
  const recurse = opts.recurse ?? true;
  const maxRetries = opts.maxRetries ?? 5;

  const visited = new Set<string>();
  const found: string[] = [];

  async function walk(url: string): Promise<void> {
    if (visited.has(url)) return;
    visited.add(url);

    const isGzip = opts.gzip ?? url.endsWith('.gz');
    console.log(`[RecipeIndex] Fetching sitemap: ${url}`);
    const xml = await fetchWithRetry(url, ua, isGzip, maxRetries);
    const locs = extractLocs(xml);

    if (recurse && isSitemapIndex(xml)) {
      console.log(`[RecipeIndex] Sitemap index → ${locs.length} child sitemap(s)`);
      for (const child of locs) {
        await walk(child);
      }
      return;
    }

    let hits = 0;
    for (const u of locs) {
      if (urlPattern.test(u)) {
        found.push(u);
        hits++;
      }
    }
    console.log(`[RecipeIndex] ${url}: ${locs.length} URLs, ${hits} matched recipe pattern`);
  }

  await walk(rootUrl);
  return found;
}
