import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const helperPath = resolve('scripts/gcloudResourceProbe.ps1');

describe('gcloud resource probe', () => {
  it('returns false for an expected missing resource without terminating strict callers', () => {
    const script = [
      "$ErrorActionPreference = 'Stop'",
      `. '${helperPath.replaceAll("'", "''")}'`,
      "$exists = Test-GcloudResource -Command 'cmd.exe' -Arguments @('/d', '/c', 'echo missing 1>&2 & exit 1')",
      "if ($exists) { throw 'Expected missing resource' }",
      "Write-Output 'probe-completed'",
    ].join('; ');

    const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      encoding: 'utf8',
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('probe-completed');
  });

  it('turns a failed native command into a terminating deployment error', () => {
    const script = [
      "$ErrorActionPreference = 'Stop'",
      `. '${helperPath.replaceAll("'", "''")}'`,
      "Invoke-CheckedNativeCommand -Command 'cmd.exe' -Arguments @('/d', '/c', 'exit 7')",
      "Write-Output 'should-not-reach'",
    ].join('; ');

    const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Native command failed with exit code 7');
    expect(result.stdout).not.toContain('should-not-reach');
  });

  it('requires checked execution for the final Firebase deployment and configuration commands', () => {
    const deployScript = readFileSync(resolve('scripts/deploy-phase1-catalogue.ps1'), 'utf8');

    expect(deployScript).toContain("Invoke-CheckedNativeCommand -Command 'npx.cmd'");
    expect(deployScript).toContain("Invoke-CheckedNativeCommand -Command 'node'");
  });
});
