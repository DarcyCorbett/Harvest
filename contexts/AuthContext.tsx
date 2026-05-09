// ============================================================
// Meal Wizard — Auth & Household Context
// Provides authentication state and household data globally.
// ============================================================

import { auth } from '@/config/firebase';
import {
  createHousehold,
  switchHousehold as firestoreSwitchHousehold,
  getHousehold,
  getUserProfile,
  joinHousehold,
  saveUserProfile,
  isEmailAllowed,
} from '@/services/firestoreService';
import type { Household } from '@/services/types';

import {
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithCredential,
  signInWithEmailAndPassword,
  signOut,
  User,
} from 'firebase/auth';
import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';



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

// ─── Provider ──────────────────────────────────────────────

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [householdId, setHouseholdId] = useState<string | null>(null);
  const [household, setHousehold] = useState<Household | null>(null);
  const [inviteCode, setInviteCode] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingInviteCode, setPendingInviteCode] = useState<string | null>(null);

  // Listen for auth state changes (handles persistence)
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        // Enforce allowlist for active sessions
        const email = firebaseUser.email;
        if (email) {
          const allowed = await isEmailAllowed(email);
          if (!allowed) {
            await signOut(auth);
            setUser(null);
            setHouseholdId(null);
            setHousehold(null);
            setInviteCode(null);
            setLoading(false);
            return;
          }
        }

        setUser(firebaseUser);
        // Load user profile to get householdId
        try {
          const profile = await getUserProfile(firebaseUser.uid);
          if (profile) {
            setHouseholdId(profile.householdId);
            const hh = await getHousehold(profile.householdId);
            if (hh) {
              setHousehold(hh);
              setInviteCode(hh.inviteCode);
            }
          }
        } catch (err) {
          console.error('Error loading user profile:', err);
        }
      } else {
        setUser(null);
        setHouseholdId(null);
        setHousehold(null);
        setInviteCode(null);
      }
      setLoading(false);
    });

    return unsubscribe;
  }, []);

  // ── Login ──
  const login = useCallback(async (email: string, password: string) => {
    const allowed = await isEmailAllowed(email);
    if (!allowed) {
      throw new Error('Access Denied');
    }
    await signInWithEmailAndPassword(auth, email, password);
    // onAuthStateChanged will handle the rest
  }, []);

  // ── Register ──
  const register = useCallback(async (
    email: string,
    password: string,
    existingInviteCode?: string
  ): Promise<{ inviteCode?: string }> => {
    const allowed = await isEmailAllowed(email);
    if (!allowed) {
      throw new Error('Access Denied');
    }

    const credential = await createUserWithEmailAndPassword(auth, email, password);
    const uid = credential.user.uid;

    let hId: string;
    let code: string | undefined;

    if (existingInviteCode && existingInviteCode.trim().length > 0) {
      // Join existing household
      const joinedId = await joinHousehold(uid, existingInviteCode.trim());
      if (!joinedId) {
        // Invalid invite code — delete the account and throw
        await credential.user.delete();
        throw new Error('Invalid invite code. Please check and try again.');
      }
      hId = joinedId;
    } else {
      // Create new household
      const result = await createHousehold(uid);
      hId = result.householdId;
      code = result.inviteCode;
    }

    // Save user profile
    await saveUserProfile(uid, { email, householdId: hId });

    // Update local state immediately so the router logic knows the user has a household
    setHouseholdId(hId);

    // Fetch and set the full household object
    const hh = await getHousehold(hId);
    if (hh) {
      setHousehold(hh);
      setInviteCode(hh.inviteCode);
    }

    return { inviteCode: code };
  }, []);

  // ── Logout ──
  const logout = useCallback(async () => {
    await signOut(auth);
  }, []);

  // ── Switch Household ──
  const switchHousehold = useCallback(async (code: string): Promise<boolean> => {
    if (!user) return false;
    const newId = await firestoreSwitchHousehold(user.uid, code.trim());
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

    const email = result.user.email;
    if (email) {
      const allowed = await isEmailAllowed(email);
      if (!allowed) {
        await signOut(auth);
        throw new Error('Access Denied');
      }
    }

    const uid = result.user.uid;
    const profile = await getUserProfile(uid);
    if (!profile?.householdId) {
      // New Google user — auto-create a household
      const { householdId: hId, inviteCode: code } = await createHousehold(uid);
      await saveUserProfile(uid, { email: result.user.email ?? '', householdId: hId });
      setHouseholdId(hId);
      const hh = await getHousehold(hId);
      if (hh) {
        setHousehold(hh);
        setInviteCode(hh.inviteCode);
      }
      setPendingInviteCode(code);
    }
  }, []);

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
