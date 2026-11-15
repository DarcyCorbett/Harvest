import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Platform: { select: (o: Record<string, unknown>) => o.default ?? o.ios } }));

import { Colors } from '../constants/theme';

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe('theme contrast', () => {
  for (const scheme of ['light', 'dark'] as const) {
    const c = Colors[scheme];
    it(`${scheme}: primaryText meets WCAG AA (4.5:1) on surfaces and primaryLight pills`, () => {
      for (const bg of [c.background, c.surface, c.primaryLight]) {
        expect(contrast(c.primaryText, bg), `${c.primaryText} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    });
    it(`${scheme}: white text on primary buttons meets AA`, () => {
      expect(contrast(c.textInverse, c.primary)).toBeGreaterThanOrEqual(4.5);
    });
  }

  it('uses primaryText, not primary, for text and icon colours', () => {
    const files = execSync('git ls-files app components', { encoding: 'utf8' }).split('\n').filter(f => f.endsWith('.tsx'));
    const offenders = files.filter(f => /(?<![A-Za-z])color(: |=\{)colors\.primary\b(?!Light|Dark|Text)/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('does not hardcode light-mode colours in the cuisine cards', () => {
    expect(readFileSync('components/connected/GenerationForm.tsx', 'utf8')).not.toContain('Colors.light[bg]');
    const card = readFileSync('components/PastelCard.tsx', 'utf8');
    expect(card).not.toContain('#D1D5DB');
    expect(card).not.toContain("'#1C1917'");
  });
});

describe('switching household', () => {
  const profile = readFileSync('app/(tabs)/profile.tsx', 'utf8');
  it('asks before leaving the current household', () => {
    expect(profile).toMatch(/const confirmed = await confirmAction\(\{\s*title: 'Switch household\?'/);
    expect(profile.indexOf('if (!confirmed) return;')).toBeLessThan(profile.indexOf('await switchHousehold(code)'));
  });
  it('keeps the Switch button inside the card and dims it while unusable', () => {
    expect(profile).toMatch(/joinInput: \{\s*flex: 1,[^}]*minWidth: 0,/);
    expect(profile).toContain("(switching || joinCode.trim().length === 0) && { opacity: 0.45 }");
  });
});
