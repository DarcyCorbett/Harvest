// ============================================================
// HTTP fetching — timeout-wrapped raw HTML + WordPress REST API pagination.
// ============================================================

const FETCH_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Linux; Android 10; Mobile) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
};

const FETCH_TIMEOUT_MS = 15000;

async function fetchWithTimeout(url: string, options: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Request timed out after ${FETCH_TIMEOUT_MS / 1000}s: ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchRawHtml(url: string): Promise<string> {
  const response = await fetchWithTimeout(url, { headers: FETCH_HEADERS });
  if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`);
  const html = await response.text();
  console.log(`[RecipeScraper] Fetched ${url} — raw size: ${html.length} chars`);
  return html;
}

function extractLinks(posts: unknown): string[] {
  if (!Array.isArray(posts)) return [];
  return posts
    .map((p) => (p as Record<string, unknown>).link)
    .filter((link): link is string => typeof link === 'string' && link.startsWith('http'));
}

export async function fetchRestApiLinks(apiUrl: string): Promise<string[]> {
  // Always fetch page 1 first — this gives us the X-WP-TotalPages header cheaply.
  const page1Response = await fetchWithTimeout(apiUrl, {
    headers: { ...FETCH_HEADERS, Accept: 'application/json' },
  });
  if (!page1Response.ok) {
    console.warn(`[RecipeScraper] REST API ${page1Response.status} for ${apiUrl}`);
    return [];
  }

  const totalPages = Math.max(1, parseInt(page1Response.headers.get('X-WP-TotalPages') ?? '1', 10) || 1);

  let page1Posts: unknown;
  try { page1Posts = await page1Response.json(); } catch { return []; }
  const page1Links = extractLinks(page1Posts);

  if (totalPages <= 1) return page1Links;

  // Linear step-down: page k gets weight (totalPages + 1 - k), so page 1 is most likely.
  const pageWeights = Array.from({ length: totalPages }, (_, i) => totalPages - i);
  const weightTotal = pageWeights.reduce((a, b) => a + b, 0);
  let rand = Math.random() * weightTotal;
  let selectedPage = 1;
  for (let i = 0; i < pageWeights.length; i++) {
    rand -= pageWeights[i];
    if (rand <= 0) { selectedPage = i + 1; break; }
  }

  if (selectedPage === 1) {
    console.log(`[RecipeScraper] Using page 1 of ${totalPages}`);
    return page1Links;
  }

  console.log(`[RecipeScraper] Fetching page ${selectedPage} of ${totalPages}`);
  try {
    const pageResponse = await fetchWithTimeout(`${apiUrl}&page=${selectedPage}`, {
      headers: { ...FETCH_HEADERS, Accept: 'application/json' },
    });
    if (!pageResponse.ok) {
      console.warn(`[RecipeScraper] Page ${selectedPage} failed (${pageResponse.status}), using page 1`);
      return page1Links;
    }
    let pagePosts: unknown;
    try { pagePosts = await pageResponse.json(); } catch { return page1Links; }
    const pageLinks = extractLinks(pagePosts);
    return pageLinks.length > 0 ? pageLinks : page1Links;
  } catch {
    return page1Links;
  }
}
