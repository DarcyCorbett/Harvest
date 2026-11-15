import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');

describe('settings navigation', () => {
  it('opens Settings as a root stack screen with a Back button, keeping four tabs', () => {
    expect(existsSync('app/(tabs)/profile.tsx')).toBe(false);
    expect(existsSync('app/profile.tsx')).toBe(true);
    expect(read('app/(tabs)/_layout.tsx')).not.toContain('name="profile"');
    expect(read('app/(tabs)/_layout.tsx').match(/<Tabs\.Screen/g)).toHaveLength(4);
    expect(read('app/_layout.tsx')).toContain('<Stack.Screen name="profile" />');
    const profile = read('app/profile.tsx');
    expect(profile).toContain('accessibilityLabel="Back"');
    expect(profile).toContain("router.canGoBack() ? router.back() : router.replace('/')");
  });

  it('gives Plan the same one-tap gear as the other tabs, and calls it Plan', () => {
    const calendar = read('components/connected/ClassicCalendar.tsx');
    expect(calendar).toMatch(/icon="settings-outline"\s*label="Settings"\s*onPress=\{\(\) => router\.push\("\/profile"\)\}/);
    expect(calendar).not.toMatch(/>\s*Calendar\s*</);
    expect(read('components/connected/PlanScreen.tsx')).not.toContain('label="Settings"');
  });

  it('deep-links exclusions and nutrition targets straight to household preferences', () => {
    expect(read('app/profile.tsx')).toContain("useState(section === 'preferences')");
    expect(read('components/connected/GenerationForm.tsx')).toContain('router.push({ pathname: "/profile", params: { section: "preferences" } });');
    expect(read('components/connected/ClassicCalendar.tsx')).toContain("router.push({ pathname: '/profile', params: { section: 'preferences' } })");
    expect(read('components/SettingsModal.tsx')).toContain('>Household preferences</Text>');
  });
});
