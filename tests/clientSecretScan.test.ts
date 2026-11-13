import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createGeminiAdminAdapter } from '../scripts/lib/geminiAdmin';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function scanFixture(contents: string, filename = 'bundle.js') {
  const directory = mkdtempSync(join(tmpdir(), 'mealwizard-secret-scan-'));
  directories.push(directory);
  const outputPath = join(directory, filename);
  mkdirSync(join(outputPath, '..'), { recursive: true });
  writeFileSync(outputPath, contents);

  return spawnSync(process.execPath, ['scripts/scanClientSecrets.mjs', directory], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

describe('client secret scanner', () => {
  it.each([
    ['provider environment name', 'const key = "EXPO_PUBLIC_GEMINI_API_KEY"', 'EXPO_PUBLIC_GEMINI_API_KEY'],
    ['server-style Gemini environment name', 'const key = process.env.GEMINI_API_KEY', 'GEMINI_API_KEY'],
    ['DeepSeek environment name', 'const model = "EXPO_PUBLIC_DEEPSEEK_MODEL"', 'EXPO_PUBLIC_DEEPSEEK_MODEL'],
    ['server-style DeepSeek environment name', 'const key = process.env.DEEPSEEK_API_KEY', 'DEEPSEEK_API_KEY'],
    ['Gemini provider host', 'fetch("https://generativelanguage.googleapis.com/v1beta/models")', 'generativelanguage.googleapis.com'],
    ['DeepSeek provider host', 'fetch("https://api.deepseek.com/chat/completions")', 'api.deepseek.com'],
    ['query-string provider credential', 'fetch("model:generateContent?key=" + secret)', 'generateContent?key='],
    ['common DeepSeek key token', 'const credential = "sk-1234567890abcdefghijklmnopqrstuv"', 'sk-'],
  ])('fails on a %s', (_label, source, expectedFinding) => {
    const result = scanFixture(source);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(expectedFinding);
  });

  it('scans generated source-map artifacts recursively', () => {
    const result = scanFixture(
      '{"sourcesContent":["EXPO_PUBLIC_DEEPSEEK_API_KEY"]}',
      'assets/index.js.map',
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('index.js.map');
  });

  it('scans generated native bundle artifacts', () => {
    const result = scanFixture(
      'const key = "EXPO_PUBLIC_GEMINI_API_KEY"',
      'index.android.bundle',
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('index.android.bundle');
  });

  it('passes a clean export directory', () => {
    const result = scanFixture('const endpoint = "tagRecipes"');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Client secret scan clean');
  });

  it('fails closed on a symbolic-link file', (context) => {
    const directory = mkdtempSync(join(tmpdir(), 'mealwizard-secret-scan-'));
    directories.push(directory);
    const target = join(directory, 'target.js');
    const link = join(directory, 'linked.js');
    writeFileSync(target, 'const endpoint = "tagRecipes"');
    try {
      symlinkSync(target, link, 'file');
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      if (code === 'EPERM' || code === 'EACCES' || code === 'UNKNOWN') {
        context.skip();
        return;
      }
      throw error;
    }

    const result = spawnSync(process.execPath, [
      'scripts/scanClientSecrets.mjs',
      directory,
    ], { cwd: process.cwd(), encoding: 'utf8' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Symbolic links are not allowed');
    expect(result.stderr).toContain('linked.js');
  });

  it('fails closed on a symbolic-link directory', (context) => {
    const directory = mkdtempSync(join(tmpdir(), 'mealwizard-secret-scan-'));
    directories.push(directory);
    const target = join(directory, 'target');
    const link = join(directory, 'linked');
    mkdirSync(target);
    writeFileSync(join(target, 'bundle.js'), 'const endpoint = "tagRecipes"');
    try {
      symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      if (code === 'EPERM' || code === 'EACCES' || code === 'UNKNOWN') {
        context.skip();
        return;
      }
      throw error;
    }

    const result = spawnSync(process.execPath, [
      'scripts/scanClientSecrets.mjs',
      directory,
    ], { cwd: process.cwd(), encoding: 'utf8' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Symbolic links are not allowed');
    expect(result.stderr).toContain('linked');
  });
});

describe('operator Gemini adapter', () => {
  const recipes = Array.from({ length: 30 }, (_, index) => ({
    recipeId: `recipe-${index}`,
    title: `Recipe ${index}`,
    totalMinutes: 30,
    ingredients: ['ingredient'],
    steps: ['cook it'],
    existingTags: [],
  }));

  it('reads the approved secret once and tags in callable-sized batches', async () => {
    const secretNames: string[] = [];
    const requests: Array<{ apiKey: string; prompt: string; model: string }> = [];
    let offset = 0;
    const adapter = createGeminiAdminAdapter({
      projectId: 'test-project',
      accessSecretVersion: async (name) => {
        secretNames.push(name);
        return Buffer.from('operator-secret');
      },
      requestJson: async (request) => {
        requests.push(request);
        const batch = recipes.slice(offset, offset + (offset === 0 ? 25 : 5));
        offset += batch.length;
        return {
          results: batch.map(({ recipeId }) => ({ id: recipeId, tags: ['Dinner'] })),
        };
      },
    });

    const result = await adapter.tagRecipes(recipes, 'gemini-test');

    expect(secretNames).toEqual([
      'projects/test-project/secrets/mealwizard-gemini-api-key/versions/latest',
    ]);
    expect(requests).toHaveLength(2);
    expect(requests.every(({ apiKey }) => apiKey === 'operator-secret')).toBe(true);
    expect(requests.every(({ model }) => model === 'gemini-test')).toBe(true);
    expect(requests[0].prompt).toContain('recipe-24');
    expect(requests[0].prompt).not.toContain('recipe-25');
    expect(requests[1].prompt).toContain('recipe-29');
    expect(result.size).toBe(30);
  });

  it('reuses the cached secret for shopping grouping', async () => {
    let secretReads = 0;
    const adapter = createGeminiAdminAdapter({
      projectId: 'test-project',
      accessSecretVersion: async () => {
        secretReads += 1;
        return 'operator-secret';
      },
      requestJson: async ({ prompt }) => prompt.includes('recipe-0')
        ? { results: [{ id: 'recipe-0', tags: ['Dinner'] }] }
        : [{
            canonicalName: 'onion',
            category: 'Produce',
            sourceIds: [0],
            unit: 'onions',
          }],
    });

    await adapter.tagRecipes(recipes.slice(0, 1));
    const groups = await adapter.getShoppingGroups([
      { id: 0, name: 'onion', quantity: 1, unit: '' },
    ]);

    expect(secretReads).toBe(1);
    expect(groups).toEqual([{
      canonicalName: 'onion',
      category: 'Produce',
      sourceIds: [0],
      unit: 'onions',
    }]);
  });

  it('rejects an empty secret without making a provider request', async () => {
    let providerCalls = 0;
    const adapter = createGeminiAdminAdapter({
      projectId: 'test-project',
      accessSecretVersion: async () => Buffer.from('   '),
      requestJson: async () => {
        providerCalls += 1;
        return { results: [] };
      },
    });

    await expect(adapter.tagRecipes(recipes.slice(0, 1))).rejects.toThrow(
      'Gemini secret version is empty',
    );
    expect(providerCalls).toBe(0);
  });

  it('does not expose invalid provider response content in validation errors', async () => {
    const adapter = createGeminiAdminAdapter({
      projectId: 'test-project',
      accessSecretVersion: async () => 'operator-secret',
      requestJson: async () => ({ privatePayload: 'do-not-log-this' }),
    });

    await expect(adapter.tagRecipes(recipes.slice(0, 1))).rejects.toThrow(
      'Gemini tagging response failed validation',
    );
  });

  it.each([
    ['missing', [{ id: 'recipe-0', tags: ['Dinner'] }]],
    ['duplicate', [
      { id: 'recipe-0', tags: ['Dinner'] },
      { id: 'recipe-0', tags: ['Dinner'] },
    ]],
    ['unrelated', [
      { id: 'recipe-0', tags: ['Dinner'] },
      { id: 'private-unrelated-recipe', tags: ['Dinner'] },
    ]],
  ])('rejects %s tagging response IDs without exposing them', async (_case, results) => {
    const adapter = createGeminiAdminAdapter({
      projectId: 'test-project',
      accessSecretVersion: async () => 'operator-secret',
      requestJson: async () => ({ results }),
    });

    const error = await adapter.tagRecipes(recipes.slice(0, 2)).catch((value) => value);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('Gemini tagging response failed validation');
    expect(error.message).not.toContain('private-unrelated-recipe');
  });

  it.each([
    ['missing', [{ canonicalName: 'onion', category: 'Produce', sourceIds: [0] }]],
    ['duplicate', [{ canonicalName: 'onion', category: 'Produce', sourceIds: [0, 0] }]],
    ['unrelated', [{ canonicalName: 'onion', category: 'Produce', sourceIds: [0, 999] }]],
  ])('rejects %s shopping source IDs without exposing them', async (_case, groups) => {
    const adapter = createGeminiAdminAdapter({
      projectId: 'test-project',
      accessSecretVersion: async () => 'operator-secret',
      requestJson: async () => groups,
    });

    const error = await adapter.getShoppingGroups([
      { id: 0, name: 'private-onion', quantity: 1, unit: '' },
      { id: 1, name: 'private-garlic', quantity: 1, unit: '' },
    ]).catch((value) => value);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('Gemini shopping response failed validation');
    expect(error.message).not.toContain('private-onion');
    expect(error.message).not.toContain('private-garlic');
  });

  it('imports with root-owned runtime dependencies only', () => {
    const source = readFileSync('scripts/lib/geminiAdmin.ts', 'utf8');
    const sharedImports = [...source.matchAll(/from ['"](\.\.\/\.\.\/functions\/[^'"]+)['"]/g)].map(match => match[1]);
    expect(sharedImports).toEqual(['../../functions/src/shared/shoppingPrompt']);
    const prompt = readFileSync('functions/src/shared/shoppingPrompt.ts', 'utf8');
    expect(prompt).not.toMatch(/\bimport\s|\brequire\s*\(/);
    expect(source).not.toContain('firebase-functions');
    expect(source).not.toMatch(/from ['"]zod['"]/);

    const result = spawnSync(process.execPath, [
      'node_modules/tsx/dist/cli.mjs',
      '-e',
      'import("./scripts/lib/geminiAdmin.ts").then(() => process.stdout.write("operator-import-ok"))',
    ], { cwd: process.cwd(), encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('operator-import-ok');
  });
});

describe('operator migration guardrails', () => {
  it('keeps EAS and operator scripts free of mobile provider credentials', () => {
    const files = [
      'eas.json',
      'scripts/tagRecipeIndex.ts',
      'scripts/test-tagger.ts',
      'scripts/evaluate-shopping-list.ts',
    ];
    const source = files.map((file) => readFileSync(file, 'utf8')).join('\n');

    expect(source).not.toMatch(/EXPO_PUBLIC_(?:GEMINI|DEEPSEEK)/);
    expect(source).not.toContain('legacyGeminiOperator');
    expect(source).not.toContain(':generateContent?key=');
    expect(source).not.toContain('services/aiClient');
  });

  it('only selects untagged index entries for the scheduled tagger', () => {
    const source = readFileSync('scripts/tagRecipeIndex.ts', 'utf8');

    expect(source).toContain(".where('geminiTaggedAt', '==', null)");
    expect(source).toContain('if (tags === undefined)');
    expect(source).toContain('reconcileCached');
    expect(source.indexOf('reconcileCached')).toBeLessThan(
      source.indexOf('// ── Fetch + parse HTML'),
    );
  });

  it('does not log ingredient names or provider payload details', () => {
    const evaluation = readFileSync('scripts/evaluate-shopping-list.ts', 'utf8');

    expect(evaluation).not.toContain('JSON.stringify(memberNames)');
    expect(evaluation).not.toContain('g.canonicalName');
    expect(evaluation).not.toContain('item.name');
    expect(evaluation).not.toContain('console.error(err)');
  });

  it('reserves 12,000 discovery writes and no more than 4,000 tag/cache writes', () => {
    const source = readFileSync('scripts/run-daily-crawl.ps1', 'utf8');

    expect(source).toContain('$DailyWriteCeiling = 18000');
    expect(source).toContain('$DiscoveryWriteLimit = 12000');
    expect(source).toContain('$TagLimitPerSite = 500');
    expect(source).toContain('--limit $DiscoveryWriteLimit');
    expect(source).toContain('tagRecipeIndex.ts --limit $TagLimitPerSite');
    expect(source).toContain('12,000 discovery + 4,000 tag/cache = 16,000');
  });
});
