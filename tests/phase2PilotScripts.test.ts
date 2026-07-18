import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const runnerPath = resolve('scripts/run-phase2-pilot.ps1');
const verifierPath = resolve('scripts/verifyPhase2Pilot.mjs');
const legacyModeAssertionPath = resolve('scripts/assertCatalogueLegacyMode.mjs');

describe('Phase 2 catalogue pilot scripts', () => {
  it('keeps the scheduler paused and targets only the two pilot sources', () => {
    const source = readFileSync(runnerPath, 'utf8');

    expect(source).toContain("$sources = 'recipetineats,seriouseats'");
    expect(source).toContain('--write-cap~40');
    expect(source).toContain("-ne 'PAUSED'");
    expect(source.match(/Assert-SchedulerPaused/g)?.length).toBeGreaterThanOrEqual(3);
    expect(source.match(/Assert-CatalogueLegacyMode/g)?.length).toBeGreaterThanOrEqual(3);
    expect(source.indexOf('$catalogueMode = Assert-CatalogueLegacyMode')).toBeLessThan(
      source.indexOf("'run', 'jobs', 'execute'"),
    );
    expect(source).toMatch(/finally\s*\{[\s\S]*Assert-SchedulerPaused[\s\S]*Assert-CatalogueLegacyMode/);
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

  it('rechecks Scheduler and generation mode when a Cloud Run execution fails', () => {
    const directory = mkdtempSync(join(tmpdir(), 'phase2-pilot-runner-'));
    const logPath = join(directory, 'calls.log');
    const gcloudPath = join(directory, 'gcloud.cmd');
    const nodePath = join(directory, 'node.cmd');
    writeFileSync(gcloudPath, [
      '@echo off',
      'echo gcloud %*>>"%PHASE2_MOCK_LOG%"',
      'if "%1"=="scheduler" (echo PAUSED& exit /b 0)',
      'if "%1"=="run" exit /b 17',
      'exit /b 0',
    ].join('\r\n'));
    writeFileSync(nodePath, [
      '@echo off',
      'echo node %*>>"%PHASE2_MOCK_LOG%"',
      'exit /b 0',
    ].join('\r\n'));

    try {
      const result = spawnSync('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', runnerPath,
        '-ProjectId', 'meal-wizard-ad202',
        '-GcloudCommand', gcloudPath,
        '-NodeCommand', nodePath,
      ], {
        encoding: 'utf8',
        env: { ...process.env, PHASE2_MOCK_LOG: logPath },
      });
      const calls = readFileSync(logPath, 'utf8');

      expect(result.status).not.toBe(0);
      expect(calls.match(/gcloud scheduler jobs describe/g)?.length).toBe(2);
      expect(calls.match(/node .*assertCatalogueLegacyMode\.mjs/g)?.length).toBe(2);
      expect(calls.match(/gcloud run jobs execute/g)?.length).toBe(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps the verifier read-only, sanitized, and on the real catalogue selector path', () => {
    const source = readFileSync(verifierPath, 'utf8');

    expect(source).toContain('validateCataloguePilotEvidence');
    expect(source).toContain('validateReadyRecipe');
    expect(source).toContain('selectCatalogueRecipes');
    expect(source).toContain('firestoreCatalogueSelectionStore');
    expect(source).toContain('iterations: 10');
    expect(source).toContain('expectedSampleDocuments');
    expect(source).toContain('missingSampleDocuments');
    expect(source).not.toMatch(/\.set\(|\.update\(|\.delete\(|\.add\(/);
    expect(source).not.toMatch(/content\s*:/);

    const syntax = spawnSync('node.exe', ['--check', verifierPath], { encoding: 'utf8' });
    expect(syntax.status, syntax.stderr).toBe(0);
  });

  it('checks generationMode through a read-only preflight assertion', () => {
    const source = readFileSync(legacyModeAssertionPath, 'utf8');

    expect(source).toContain("configSnapshot.get('generationMode')");
    expect(source).toContain("!== 'legacy'");
    expect(source).not.toMatch(/\.set\(|\.update\(|\.delete\(|\.add\(/);

    const syntax = spawnSync('node.exe', ['--check', legacyModeAssertionPath], { encoding: 'utf8' });
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
