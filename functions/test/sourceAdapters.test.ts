import { describe, expect, it, vi } from 'vitest';

import {
  FROZEN_CATALOGUE_SOURCE_KEYS,
  SOURCE_CONFIGS,
  WORDPRESS_SOURCE_KEYS,
  createSourceAdapter,
  inventorySourceDiscovery,
  type SourceHttpResponse,
} from '../src/catalogue/sourceAdapters.js';

function response(status: number, body = '', headers: Record<string, string> = {}): SourceHttpResponse {
  return { status, body, headers };
}

describe('catalogue source adapters', () => {
  it('defines 12 active sources and freezes Serious Eats outside ingestion', () => {
    expect(SOURCE_CONFIGS.map((source) => source.host)).toEqual([
      'www.recipetineats.com',
      'www.budgetbytes.com',
      'thewoksoflife.com',
      'www.themediterraneandish.com',
      'www.spendwithpennies.com',
      'cafedelites.com',
      'www.skinnytaste.com',
      'pinchofyum.com',
      'natashaskitchen.com',
      'akispetretzikis.com',
      'cooking.nytimes.com',
      'www.americastestkitchen.com',
    ]);
    expect(FROZEN_CATALOGUE_SOURCE_KEYS).toEqual(['seriouseats']);
  });

  it('uses every WordPress post sitemap shard and excludes non-post sitemaps', async () => {
    expect(WORDPRESS_SOURCE_KEYS).toHaveLength(9);
    const config = SOURCE_CONFIGS.find((source) => source.sourceKey === 'recipetineats');
    if (!config) throw new Error('missing source');
    const request = vi.fn(async (url: string) => {
      if (url === config.discoveryUrl) {
        return response(200, `<sitemapindex>
          <sitemap><loc>https://${config.host}/post-sitemap.xml</loc></sitemap>
          <sitemap><loc>https://${config.host}/post-sitemap2.xml</loc></sitemap>
          <sitemap><loc>https://${config.host}/page-sitemap.xml</loc></sitemap>
        </sitemapindex>`);
      }
      return response(200, `<urlset><url><loc>https://${config.host}/${url.includes('2') ? 'two' : 'one'}</loc></url></urlset>`);
    });
    const source = createSourceAdapter(config, { request, sleep: vi.fn() });

    const discovered = [];
    for await (const item of source.discover()) discovered.push(item.url);

    expect(discovered).toEqual([
      `https://${config.host}/one`,
      `https://${config.host}/two`,
    ]);
    expect(request).not.toHaveBeenCalledWith(`https://${config.host}/page-sitemap.xml`);
  });

  it('inventories discovery without fetching recipe pages', async () => {
    const first = {
      sourceKey: 'first',
      canonicalize: (url: string) => url,
      async *discover() {
        yield { url: 'https://first.test/one', cursor: '1' };
        yield { url: 'https://first.test/two', cursor: '2' };
      },
      fetch: vi.fn(),
    };
    const second = {
      sourceKey: 'second',
      canonicalize: (url: string) => url,
      async *discover() {
        yield { url: 'https://second.test/one', cursor: '1' };
      },
      fetch: vi.fn(),
    };

    await expect(inventorySourceDiscovery([first, second])).resolves.toEqual({
      mode: 'crawl-inventory',
      totalDiscovered: 3,
      bySource: {
        first: { discovered: 2, status: 'complete' },
        second: { discovered: 1, status: 'complete' },
      },
    });
    expect(first.fetch).not.toHaveBeenCalled();
    expect(second.fetch).not.toHaveBeenCalled();
  });

  it.each(SOURCE_CONFIGS)('discovers and canonicalizes a fixture for $sourceKey', async (config) => {
    const sourceUrl = `https://${config.host}/recipes/test-recipe/?utm_source=fixture#card`;
    const request = vi.fn().mockResolvedValue(response(200, `<?xml version="1.0"?>
      <urlset><url><loc>${sourceUrl.replace('&', '&amp;')}</loc><lastmod>2026-07-01</lastmod></url></urlset>`));
    const adapter = createSourceAdapter(config, { request, sleep: vi.fn() });

    const discovered = [];
    for await (const item of adapter.discover()) discovered.push(item);

    expect(discovered).toEqual([{
      url: `https://${config.host}/recipes/test-recipe`,
      lastModified: '2026-07-01',
      cursor: expect.any(String),
    }]);
    expect(adapter.canonicalize(sourceUrl)).toBe(`https://${config.host}/recipes/test-recipe`);
  });

  it('recurses through sitemap indexes and resumes after the durable child cursor', async () => {
    const config = SOURCE_CONFIGS.find((source) =>
      source.sourceKey === 'americastestkitchen');
    if (!config) throw new Error('missing source');
    const request = vi.fn(async (url: string) => {
      if (url === config.discoveryUrl) {
        return response(200, '<sitemapindex><sitemap><loc>https://maps.test/one.xml</loc></sitemap><sitemap><loc>https://maps.test/two.xml</loc></sitemap></sitemapindex>');
      }
      return response(200, `<urlset><url><loc>https://${config.host}/recipes/${url.includes('one') ? 'one-recipe' : 'two-recipe'}</loc></url></urlset>`);
    });
    const adapter = createSourceAdapter(config, { request, sleep: vi.fn() });

    const firstPass = [];
    for await (const item of adapter.discover()) firstPass.push(item);
    const discovered = [];
    for await (const item of adapter.discover(firstPass[0].cursor)) discovered.push(item.url);

    expect(discovered).toEqual([`https://${config.host}/recipes/two-recipe`]);
  });

  it('retries transient fetches and marks protected access unsupported without bypassing it', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(response(429, '', { 'retry-after': '0' }))
      .mockResolvedValueOnce(response(503))
      .mockResolvedValueOnce(response(200, '<html>recipe</html>'))
      .mockResolvedValueOnce(response(403));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const adapter = createSourceAdapter(SOURCE_CONFIGS[0], { request, sleep });

    await expect(adapter.fetch('https://www.recipetineats.com/recipe')).resolves.toEqual({
      kind: 'ok',
      html: '<html>recipe</html>',
    });
    await expect(adapter.fetch('https://www.recipetineats.com/protected')).resolves.toEqual({
      kind: 'unsupported',
      status: 403,
    });
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('uses a conservative adaptive cooldown for configured HTTP 429 responses', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(response(429))
      .mockResolvedValueOnce(response(429))
      .mockResolvedValueOnce(response(200, '<html>ok</html>'));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const adapter = createSourceAdapter({
      ...SOURCE_CONFIGS[4],
      rateLimitCooldownMs: 60_000,
    }, { request, sleep });

    await expect(adapter.fetch('https://www.spendwithpennies.com/recipe')).resolves.toMatchObject({
      kind: 'ok',
    });
    expect(sleep).toHaveBeenNthCalledWith(1, 60_000);
    expect(sleep).toHaveBeenNthCalledWith(2, 120_000);
  });

  it('renders Akis sitemap discovery after a blocked direct request', async () => {
    const config = SOURCE_CONFIGS.find((source) =>
      source.sourceKey === 'akispetretzikis');
    if (!config) throw new Error('missing source');
    const request = vi.fn().mockResolvedValue(response(403));
    const renderDiscovery = vi.fn().mockResolvedValue(
      '<urlset><url><loc>https://akispetretzikis.com/en/recipe/1/test</loc></url></urlset>',
    );
    const adapter = createSourceAdapter(config, {
      request,
      renderDiscovery,
      sleep: vi.fn(),
    });

    const discovered = [];
    for await (const item of adapter.discover()) discovered.push(item.url);

    expect(discovered).toEqual([
      'https://akispetretzikis.com/en/recipe/1/test',
    ]);
    expect(renderDiscovery).toHaveBeenCalledWith(config.discoveryUrl);
  });

  it('retries Akis sitemap discovery before launching a browser', async () => {
    const config = SOURCE_CONFIGS.find((source) =>
      source.sourceKey === 'akispetretzikis');
    if (!config) throw new Error('missing source');
    const request = vi.fn()
      .mockResolvedValueOnce(response(403))
      .mockResolvedValueOnce(response(200,
        '<urlset><url><loc>https://akispetretzikis.com/en/recipe/1/test</loc></url></urlset>'));
    const renderDiscovery = vi.fn();
    const adapter = createSourceAdapter(config, {
      request,
      renderDiscovery,
      sleep: vi.fn(),
    });

    const discovered = [];
    for await (const item of adapter.discover()) discovered.push(item.url);

    expect(discovered).toEqual([
      'https://akispetretzikis.com/en/recipe/1/test',
    ]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(renderDiscovery).not.toHaveBeenCalled();
  });

  it('renders an Akis recipe page after a blocked direct request', async () => {
    const config = SOURCE_CONFIGS.find((source) =>
      source.sourceKey === 'akispetretzikis');
    if (!config) throw new Error('missing source');
    const request = vi.fn().mockResolvedValue(response(403));
    const render = vi.fn().mockResolvedValue(
      '<script type="application/ld+json">{"@type":"Recipe"}</script>',
    );
    const adapter = createSourceAdapter(config, {
      request,
      render,
      sleep: vi.fn(),
    });
    const url = 'https://akispetretzikis.com/en/recipe/1/test';

    await expect(adapter.fetch(url)).resolves.toEqual({
      kind: 'ok',
      html: '<script type="application/ld+json">{"@type":"Recipe"}</script>',
    });
    expect(render).toHaveBeenCalledWith(url);
  });

  it('renews the lease before and after long rate-limit cooldowns', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(response(429, '', { 'retry-after': '60' }))
      .mockResolvedValueOnce(response(200, '<html>ok</html>'));
    const heartbeat = vi.fn().mockResolvedValue(undefined);
    const adapter = createSourceAdapter(SOURCE_CONFIGS[4], {
      request,
      sleep: vi.fn().mockResolvedValue(undefined),
      heartbeat,
      random: () => 0.5,
    });

    await expect(adapter.fetch('https://www.spendwithpennies.com/recipe'))
      .resolves.toMatchObject({ kind: 'ok' });
    expect(heartbeat).toHaveBeenCalledTimes(2);
  });

  it('cools down after a final configured HTTP 429 before yielding to the engine', async () => {
    const request = vi.fn().mockResolvedValue(response(429));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const adapter = createSourceAdapter({
      ...SOURCE_CONFIGS[4],
      rateLimitCooldownMs: 60_000,
    }, { request, sleep });

    await expect(adapter.fetch('https://www.spendwithpennies.com/recipe')).resolves.toEqual({
      kind: 'retryable',
      status: 429,
    });
    expect(sleep).toHaveBeenNthCalledWith(3, 240_000);
  });

  it('retries network failures and maps exhausted attempts to retryable state', async () => {
    const request = vi.fn()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockRejectedValueOnce(new Error('reset'))
      .mockResolvedValueOnce(response(200, '<html>ok</html>'))
      .mockRejectedValue(new Error('offline'));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const adapter = createSourceAdapter(SOURCE_CONFIGS[0], { request, sleep });

    await expect(adapter.fetch('https://www.recipetineats.com/recipe')).resolves.toMatchObject({
      kind: 'ok', html: '<html>ok</html>',
    });
    await expect(adapter.fetch('https://www.recipetineats.com/offline')).resolves.toEqual({
      kind: 'retryable', status: 0,
    });
    expect(sleep).toHaveBeenCalledTimes(4);
  });
});
