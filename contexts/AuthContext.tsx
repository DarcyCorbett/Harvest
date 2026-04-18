// ============================================================
// Meal Wizard — Auth & Household Context
// Provides authentication state and household data globally.
// ============================================================

import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { auth } from '@/config/firebase';
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  User,
} from 'firebase/auth';
import {
  createHousehold,
  joinHousehold,
  saveUserProfile,
  getUserProfile,
  getHousehold,
} from '@/services/firestoreService';
import type { Household } from '@/services/types';

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
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

// ─── Provider ──────────────────────────────────────────────

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [householdId, setHouseholdId] = useState<string | null>(null);
  const [household, setHousehold] = useState<Household | null>(null);
  const [inviteCode, setInviteCode] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Listen for auth state changes (handles persistence)
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
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
    await signInWithEmailAndPassword(auth, email, password);
    // onAuthStateChanged will handle the rest
  }, []);

  // ── Register ──
  const register = useCallback(async (
    email: string,
    password: string,
    existingInviteCode?: string
  ): Promise<{ inviteCode?: string }> => {
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

  const value: AuthContextType = {
    user,
    householdId,
    household,
    inviteCode,
    loading,
    login,
    register,
    logout,
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
