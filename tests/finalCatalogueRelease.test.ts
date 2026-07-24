import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = process.cwd();

describe('final catalogue release tooling', () => {
  it('keeps the production selector matrix read-only and sanitized', () => {
    const source = readFileSync(resolve(root, 'scripts/verifyFinalCatalogueMatrix.mjs'), 'utf8');
    expect(source).toContain('selectCatalogueRecipes');
    expect(source).toContain('validateReadyRecipe');
    expect(source).toContain('p95Ms > 2_000');
    expect(source).toContain('firestoreWrites: 0');
    expect(source).toContain('externalRecipeRequests: 0');
    expect(source).not.toMatch(/\.set\(|\.update\(|\.delete\(|\.add\(/);
    expect(source).not.toMatch(/console\.log\([^)]*(recipeId|householdId|canonicalUrl)/);
  });

  it('restricts the operator mode command and never changes Scheduler state', () => {
    const script = readFileSync(resolve(root, 'scripts/set-catalogue-generation-mode.ps1'), 'utf8');
    const command = readFileSync(resolve(root, 'scripts/setCatalogueGenerationMode.mjs'), 'utf8');
    expect(script).toContain("ValidateSet('legacy', 'catalogue')");
    expect(script.match(/Assert-SchedulerPaused/g)?.length).toBeGreaterThanOrEqual(3);
    expect(script).not.toMatch(/scheduler jobs (resume|run|update)/i);
    expect(command).toContain("requestedMode !== 'legacy' && requestedMode !== 'catalogue'");
    expect(command).toContain('previousMode');
  });

  it('parses final-release PowerShell scripts and Node operator entrypoints', () => {
    for (const path of [
      'scripts/run-phase4-backfill.ps1',
      'scripts/set-catalogue-generation-mode.ps1',
    ]) {
      const escaped = resolve(root, path).replaceAll("'", "''");
      const command = [
        '$tokens = $null',
        '$errors = $null',
        `[System.Management.Automation.Language.Parser]::ParseFile('${escaped}', [ref]$tokens, [ref]$errors) | Out-Null`,
        'if ($errors.Count -gt 0) { exit 1 }',
      ].join('; ');
      expect(spawnSync(
        'powershell.exe',
        ['-NoProfile', '-Command', command],
        { encoding: 'utf8' },
      ).status).toBe(0);
    }
    for (const path of [
      'scripts/readCatalogueGenerationMode.mjs',
      'scripts/setCatalogueGenerationMode.mjs',
      'scripts/verifyFinalCatalogueMatrix.mjs',
    ]) {
      const result = spawnSync('node.exe', ['--check', resolve(root, path)], { encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
    }
  });
});
