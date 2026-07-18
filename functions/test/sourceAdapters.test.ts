import { describe, expect, it, vi } from 'vitest';

import {
  SOURCE_CONFIGS,
  createSourceAdapter,
  type SourceHttpResponse,
} from '../src/catalogue/sourceAdapters.js';

function response(status: number, body = '', headers: Record<string, string> = {}): SourceHttpResponse {
  return { status, body, headers };
}

describe('catalogue source adapters', () => {
  it('defines exactly the 13 trusted sources', () => {
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
      'www.seriouseats.com',
      'akispetretzikis.com',
      'cooking.nytimes.com',
      'www.americastestkitchen.com',
    ]);
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
    const config = SOURCE_CONFIGS[0];
    const request = vi.fn(async (url: string) => {
      if (url === config.discoveryUrl) {
        return response(200, '<sitemapindex><sitemap><loc>https://maps.test/one.xml</loc></sitemap><sitemap><loc>https://maps.test/two.xml</loc></sitemap></sitemapindex>');
      }
      return response(200, `<urlset><url><loc>https://${config.host}/${url.includes('one') ? 'one' : 'two'}</loc></url></urlset>`);
    });
    const adapter = createSourceAdapter(config, { request, sleep: vi.fn() });

    const firstPass = [];
    for await (const item of adapter.discover()) firstPass.push(item);
    const discovered = [];
    for await (const item of adapter.discover(firstPass[0].cursor)) discovered.push(item.url);

    expect(discovered).toEqual([`https://${config.host}/two`]);
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
