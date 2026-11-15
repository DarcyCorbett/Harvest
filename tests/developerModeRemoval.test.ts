import { existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('developer mode removal', () => {
  it('has no DeveloperModeContext or toggle left in the app', () => {
    expect(existsSync('contexts/DeveloperModeContext.tsx')).toBe(false);
    const files = execSync('git ls-files app components contexts hooks services', { encoding: 'utf8' }).split('\n').filter(f => /\.tsx?$/.test(f));
    expect(files.filter(f => /DeveloperMode|developerMode/.test(readFileSync(f, 'utf8')))).toEqual([]);
  });

  it('keeps the devLog viewer as the in-app log surface', () => {
    expect(readFileSync('components/SettingsModal.tsx', 'utf8')).toContain("from '@/services/devLog'");
  });
});
