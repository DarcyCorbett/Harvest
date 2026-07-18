import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const runnerPath = resolve('scripts/run-phase2-pilot.ps1');
const verifierPath = resolve('scripts/verifyPhase2Pilot.mjs');

describe('Phase 2 catalogue pilot scripts', () => {
  it('keeps the scheduler paused and targets only the two pilot sources', () => {
    const source = readFileSync(runnerPath, 'utf8');

    expect(source).toContain("$sources = 'recipetineats,seriouseats'");
    expect(source).toContain('--write-cap~40');
    expect(source).toContain("-ne 'PAUSED'");
    expect(source.match(/Assert-SchedulerPaused/g)?.length).toBeGreaterThanOrEqual(3);
    expect(source).not.toMatch(/scheduler.{0,80}(resume|update)/i);
    expect(source).not.toMatch(/generationMode.{0,80}catalogue/i);
    expect(source).not.toContain('tagRecipeIndex');
  });

  it('uses identical curated targets for the forced and unchanged runs', () => {
    const source = readFileSync(runnerPath, 'utf8');

    expect(source).toContain('poulet-roti-french-roast-chicken');
    expect(source).toContain('chow-mein-ramen-noodles-recipe');
    expect(source).toContain('the-best-roast-potatoes-ever-recipe');
    expect(source).toContain('$targetArgs~--force-refresh~--run-id~$firstRun');
    expect(source).toContain('$targetArgs~--run-id~$secondRun');
  });

  it('parses the runner with the PowerShell AST parser', () => {
    const escaped = runnerPath.replaceAll("'", "''");
    const command = [
      '$tokens = $null',
      '$errors = $null',
      `[System.Management.Automation.Language.Parser]::ParseFile('${escaped}', [ref]$tokens, [ref]$errors) | Out-Null`,
      'if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Error $_.Message }; exit 1 }',
    ].join('; ');
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { encoding: 'utf8' },
    );

    expect(result.status, result.stderr).toBe(0);
  });

  it('keeps the verifier read-only, sanitized, and on the real catalogue selector path', () => {
    const source = readFileSync(verifierPath, 'utf8');

    expect(source).toContain('validateCataloguePilotEvidence');
    expect(source).toContain('validateReadyRecipe');
    expect(source).toContain('selectCatalogueRecipes');
    expect(source).toContain('firestoreCatalogueSelectionStore');
    expect(source).toContain('iterations: 10');
    expect(source).not.toMatch(/\.set\(|\.update\(|\.delete\(|\.add\(/);
    expect(source).not.toMatch(/content\s*:/);

    const syntax = spawnSync('node.exe', ['--check', verifierPath], { encoding: 'utf8' });
    expect(syntax.status, syntax.stderr).toBe(0);
  });

  it('registers the full local gate and documents protected-source rollback', () => {
    const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
    const runbook = readFileSync(
      resolve('docs/superpowers/verification/phase-2-pilot-runbook.md'),
      'utf8',
    );

    expect(packageJson.scripts['verify:phase2:local']).toBe(
      'npm run test:functions && npm run build:functions && npm run test:client && npm run test:rules && npm run lint && tsc --noEmit && npm run scan:client-secrets',
    );
    expect(runbook).toContain('HTTP 402');
    expect(runbook).toContain('PAUSED');
    expect(runbook).toContain('generationMode');
    expect(runbook).toContain('legacy');
    expect(runbook).toContain('Rollback');
  });
});
