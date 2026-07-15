// ============================================================
// Meal Wizard — Auth & Household Context
// Provides authentication state and household data globally.
// ============================================================

import { auth } from '@/config/firebase';
import {
  getHousehold,
  getUserProfile,
  isEmailAllowed,
} from '@/services/firestoreService';
import {
  clearAuthenticatedFailureState,
  createAsyncStoragePendingIntentStore,
  completeGoogleHouseholdOnboarding,
  createPasswordOnboarding,
  householdClient,
  type PasswordOnboardingUser,
} from '@/services/householdClient';
import type { Household } from '@/services/types';

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  onAuthStateChanged,
  sendEmailVerification,
  signInWithCredential,
  signInWithEmailAndPassword,
  signOut,
  User,
} from 'firebase/auth';
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';



// ─── Context Type ──────────────────────────────────────────

interface AuthContextType {
  user: User | null;
  householdId: string | null;
  household: Household | null;
  inviteCode: string | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, inviteCode?: string) => Promise<{ inviteCode?: string }>;
  logout: () => Promise<void>;
  /** Join a different household by invite code. Returns false if the code is invalid. */
  switchHousehold: (inviteCode: string) => Promise<boolean>;
  /** Start the Google OAuth flow. */
  signInWithGoogle: () => Promise<void>;
  /** Set when a new household was auto-created during Google sign-in. */
  pendingInviteCode: string | null;
  clearPendingInviteCode: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const passwordOnboarding = createPasswordOnboarding({
  isEmailAllowed,
  async hasUserProfile(uid) {
    return (await getUserProfile(uid)) !== null;
  },
  async createUser(email, password) {
    return (await createUserWithEmailAndPassword(auth, email, password)).user;
  },
  async signIn(email, password) {
    return (await signInWithEmailAndPassword(auth, email, password)).user;
  },
  sendVerification(user: PasswordOnboardingUser) {
    return sendEmailVerification(user as User);
  },
  signOut() {
    return signOut(auth);
  },
  pendingIntents: createAsyncStoragePendingIntentStore(AsyncStorage),
  households: householdClient,
});

const googleOnboardingDependencies = {
  isEmailAllowed,
  async hasUserProfile(uid: string) {
    return (await getUserProfile(uid)) !== null;
  },
  households: householdClient,
};

// ─── Provider ──────────────────────────────────────────────

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [householdId, setHouseholdId] = useState<string | null>(null);
  const [household, setHousehold] = useState<Household | null>(null);
  const [inviteCode, setInviteCode] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingInviteCode, setPendingInviteCode] = useState<string | null>(null);
  const authFlowInProgress = useRef(false);

  const clearLocalAuth = useCallback(() => {
    setUser(null);
    setHouseholdId(null);
    setHousehold(null);
    setInviteCode(null);
  }, []);

  const loadAuthenticatedUser = useCallback(async (
    firebaseUser: User,
    householdOverride?: { householdId: string; inviteCode?: string } | null,
  ) => {
    setUser(firebaseUser);
    const profile = householdOverride
      ? null
      : await getUserProfile(firebaseUser.uid);
    const hId = householdOverride?.householdId ?? profile?.householdId ?? null;
    if (!hId) {
      setHouseholdId(null);
      setHousehold(null);
      setInviteCode(null);
      return;
    }

    setHouseholdId(hId);
    const hh = await getHousehold(hId);
    if (hh) {
      setHousehold(hh);
      setInviteCode(hh.inviteCode);
    } else {
      setHousehold(null);
      setInviteCode(null);
    }
    if (householdOverride?.inviteCode) {
      setPendingInviteCode(householdOverride.inviteCode);
    }
  }, []);

  // Listen for auth state changes (handles persistence)
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (authFlowInProgress.current || passwordOnboarding.isBusy()) return;
      if (firebaseUser) {
        if (firebaseUser.emailVerified !== true) {
          try {
            await sendEmailVerification(firebaseUser);
          } finally {
            await clearAuthenticatedFailureState(
              () => signOut(auth),
              clearLocalAuth,
            );
            setLoading(false);
          }
          return;
        }

        // Enforce allowlist for active sessions
        const email = firebaseUser.email;
        if (email) {
          const allowed = await isEmailAllowed(email);
          if (!allowed) {
            await clearAuthenticatedFailureState(
              () => signOut(auth),
              clearLocalAuth,
            );
            setLoading(false);
            return;
          }
        }

        // Load user profile to get householdId
        try {
          await loadAuthenticatedUser(firebaseUser);
        } catch (err) {
          console.error('Error loading user profile:', err);
        }
      } else {
        clearLocalAuth();
      }
      setLoading(false);
    });

    return unsubscribe;
  }, [clearLocalAuth, loadAuthenticatedUser]);

  // ── Login ──
  const login = useCallback(async (email: string, password: string) => {
    authFlowInProgress.current = true;
    try {
      const result = await passwordOnboarding.login(email, password);
      await loadAuthenticatedUser(result.user as User, result.household);
    } catch (error) {
      clearLocalAuth();
      throw error;
    } finally {
      authFlowInProgress.current = false;
    }
  }, [clearLocalAuth, loadAuthenticatedUser]);

  // ── Register ──
  const register = useCallback(async (
    email: string,
    password: string,
    existingInviteCode?: string
  ): Promise<{ inviteCode?: string }> => {
    authFlowInProgress.current = true;
    try {
      await passwordOnboarding.register(email, password, existingInviteCode);
      return {};
    } finally {
      clearLocalAuth();
      authFlowInProgress.current = false;
    }
  }, [clearLocalAuth]);

  // ── Logout ──
  const logout = useCallback(async () => {
    await signOut(auth);
  }, []);

  // ── Switch Household ──
  const switchHousehold = useCallback(async (code: string): Promise<boolean> => {
    if (!user) return false;
    const newId = await householdClient.switch(code);
    if (!newId) return false;
    const hh = await getHousehold(newId);
    if (hh) {
      setHouseholdId(newId);
      setHousehold(hh);
      setInviteCode(hh.inviteCode);
    }
    return true;
  }, [user]);

  const signInWithGoogle = useCallback(async () => {
    authFlowInProgress.current = true;
    let authenticatedUser: User | null = null;
    try {
      // Lazy-load native module — avoids crash in Expo Go where RNGoogleSignin isn't available
      const { GoogleSignin } = require('@react-native-google-signin/google-signin');
      GoogleSignin.configure({ webClientId: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID });
      await GoogleSignin.hasPlayServices();
      const response = await GoogleSignin.signIn();
      if (response.type !== 'success') {
        throw new Error('Google sign-in cancelled');
      }
      const idToken = response.data.idToken;
      if (!idToken) {
        throw new Error('Google sign-in did not return an idToken');
      }

      const credential = GoogleAuthProvider.credential(idToken);
      const result = await signInWithCredential(auth, credential);
      authenticatedUser = result.user;
      const onboarding = await completeGoogleHouseholdOnboarding(
        result.user,
        googleOnboardingDependencies,
      );

      if (onboarding.household && 'inviteCode' in onboarding.household) {
        // New Google user — auto-create a household
        await loadAuthenticatedUser(result.user, onboarding.household);
        setPendingInviteCode(onboarding.household.inviteCode);
      } else {
        await loadAuthenticatedUser(result.user);
      }
    } catch (error) {
      if (authenticatedUser) {
        await clearAuthenticatedFailureState(
          () => signOut(auth),
          clearLocalAuth,
        );
      } else {
        clearLocalAuth();
      }
      throw error;
    } finally {
      authFlowInProgress.current = false;
    }
  }, [clearLocalAuth, loadAuthenticatedUser]);

  const clearPendingInviteCode = useCallback(() => {
    setPendingInviteCode(null);
  }, []);

  const value: AuthContextType = {
    user,
    householdId,
    household,
    inviteCode,
    loading,
    login,
    register,
    logout,
    switchHousehold,
    signInWithGoogle,
    pendingInviteCode,
    clearPendingInviteCode,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// ─── Hook ──────────────────────────────────────────────────

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
