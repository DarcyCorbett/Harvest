import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');

describe('auth and onboarding fixes', () => {
  it('marks a cancelled Google sign-in so screens do not show "Sign-In Failed"', () => {
    const auth = read('contexts/AuthContext.tsx');
    expect(auth).toContain("throw Object.assign(new Error('Google sign-in cancelled'), { code: 'ERR_REQUEST_CANCELED' });");
    for (const screen of ['app/login.tsx', 'app/register.tsx']) {
      expect(read(screen)).toContain("error.code !== 'ERR_REQUEST_CANCELED'");
    }
  });

  it('types register as always rejecting and drops the unreachable invite modal', () => {
    expect(read('contexts/AuthContext.tsx')).toContain('register: (email: string, password: string, inviteCode?: string) => Promise<never>;');
    expect(read('services/householdClient.ts')).toMatch(/async register\([\s\S]*?\): Promise<never>/);
    const register = read('app/register.tsx');
    expect(register).not.toContain('showInviteModal');
    expect(register).toContain("router.replace({ pathname: '/login', params: { email: email.trim() } });");
    expect(read('app/login.tsx')).toContain("useState(typeof params.email === 'string' ? params.email : '')");
  });

  it('shows the new household code from the root navigator, which survives the redirect to the tabs', () => {
    expect(read('app/login.tsx')).not.toContain('pendingInviteCode');
    expect(read('app/_layout.tsx')).toContain('<HouseholdCreatedModal />');
    expect(read('components/HouseholdCreatedModal.tsx')).toContain('visible={!!pendingInviteCode}');
  });

  it('gives signed-in users without a household a way forward', () => {
    expect(read('app/_layout.tsx')).toContain("} else if (user && !householdId && !inAuthGroup) {");
    const login = read('app/login.tsx');
    expect(login).toContain('{!!user && !householdId && !authLoading && !loading && !googleLoading && (');
    expect(login).toContain('Finish setting up');
  });
});

describe('login and register layout', () => {
  it('keeps the password eye toggle inside the field and Forgot password inside the form', () => {
    for (const screen of ['app/login.tsx', 'app/register.tsx']) {
      expect(read(screen)).toMatch(/ {2}input: \{\s*flex: 1,[^}]*minWidth: 0,/);
    }
    const login = read('app/login.tsx');
    expect(login.indexOf('id="forgot-password"')).toBeLessThan(login.indexOf('{/* Login Button */}'));
  });
});
