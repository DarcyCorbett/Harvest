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
  const profile = readFileSync('app/profile.tsx', 'utf8');
  it('asks before leaving the current household', () => {
    expect(profile).toMatch(/const confirmed = await confirmAction\(\{\s*title: 'Switch household\?'/);
    expect(profile.indexOf('if (!confirmed) return;')).toBeLessThan(profile.indexOf('await switchHousehold(code)'));
  });
  it('keeps the Switch button inside the card and dims it while unusable', () => {
    expect(profile).toMatch(/joinInput: \{\s*flex: 1,[^}]*minWidth: 0,/);
    expect(profile).toContain("(switching || joinCode.trim().length === 0) && { opacity: 0.45 }");
  });
});

describe('borders and placeholders', () => {
  it('keeps light-mode borders visible and placeholders readable', () => {
    expect(contrast(Colors.light.border, Colors.light.surface)).toBeGreaterThanOrEqual(1.4);
    expect(contrast(Colors.light.placeholder, Colors.light.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(Colors.dark.placeholder, Colors.dark.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(Colors.dark.border, Colors.dark.surface)).toBeGreaterThan(contrast('#44403C', Colors.dark.surface));
  });
  it('outlines unselected secondary buttons and pills so they read as buttons on white cards', () => {
    const ui = readFileSync('components/connected/ui.tsx', 'utf8');
    expect(ui).toContain('borderWidth: secondary && !selected ? 1 : 0,');
    const classic = readFileSync('components/connected/classic.tsx', 'utf8');
    expect(classic).toContain('borderWidth: selected ? 0 : 1,');
  });
});

describe('touch targets and scannable shopping rows', () => {
  it('sizes the flagged controls to at least 44pt', () => {
    const modal = readFileSync('components/RecipeDetailModal.tsx', 'utf8');
    expect(modal).toMatch(/closeBtn: \{\s*width: 44,\s*height: 44,/);
    expect(modal).toMatch(/stepperBtn: \{\s*width: 44,\s*height: 44,/);
    const settings = readFileSync('components/SettingsModal.tsx', 'utf8');
    expect(settings).toMatch(/weightChip: \{\s*minHeight: 44,\s*minWidth: 44,/);
    expect(settings).toMatch(/addTermBtn: \{\s*width: 44,\s*height: 44,/);
    for (const screen of ['app/login.tsx', 'app/register.tsx']) {
      expect(readFileSync(screen, 'utf8')).toMatch(/eyeButton: \{\s*minWidth: 44,\s*minHeight: 44,/);
    }
  });
  it('puts recipe sources under the item name instead of a 36% column', () => {
    const screen = readFileSync('components/connected/ShoppingScreen.tsx', 'utf8');
    expect(screen).not.toContain("width: '36%'");
    expect(screen).toContain("marginLeft: 32, marginRight: 8, marginTop: 4");
  });
});

describe('typography', () => {
  it('uses the loaded Outfit faces rather than fontWeight, which falls back to the system font', () => {
    for (const file of ['app/login.tsx', 'app/(tabs)/_layout.tsx', 'components/AppInviteCard.tsx', 'app/_layout.tsx']) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/fontWeight:/);
    }
    expect(readFileSync('constants/theme.ts', 'utf8')).not.toContain('extrabold');
  });
});
