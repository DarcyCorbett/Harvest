// ============================================================
// Meal Wizard — Profile Tab
// Shows household invite code, lets user share/copy it,
// join a different household, and sign out.
// ============================================================

import { FontSizes, Fonts, Radius, Shadows, Spacing } from '@/constants/theme';
import { useAuth } from '@/contexts/AuthContext';
import { useTheme } from '@/contexts/ThemeContext';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import React, { useState, useCallback } from 'react';
import {
  ActivityIndicator,
  Alert,
  Share,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function ProfileScreen() {
  const { colors, mode, setMode } = useTheme();
  const { user, inviteCode, switchHousehold, logout } = useAuth();

  const [joinCode, setJoinCode] = useState('');
  const [switching, setSwitching] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    if (!inviteCode) return;
    await Clipboard.setStringAsync(inviteCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [inviteCode]);

  const handleShare = useCallback(async () => {
    if (!inviteCode) return;
    await Share.share({
      message: `Join my Harvest household! Enter this code when registering: ${inviteCode}`,
    });
  }, [inviteCode]);

  const handleSwitch = useCallback(async () => {
    const code = joinCode.trim().toUpperCase();
    if (code.length < 4) {
      Alert.alert('Invalid code', 'Please enter a valid invite code.');
      return;
    }
    if (code === inviteCode) {
      Alert.alert('Same household', 'That is your current household code.');
      return;
    }
    setSwitching(true);
    try {
      const ok = await switchHousehold(code);
      if (ok) {
        setJoinCode('');
        Alert.alert('Switched!', 'You are now connected to the new household.');
      } else {
        Alert.alert('Invalid code', 'No household found with that code. Please check and try again.');
      }
    } catch {
      Alert.alert('Error', 'Something went wrong. Please try again.');
    } finally {
      setSwitching(false);
    }
  }, [joinCode, inviteCode, switchHousehold]);

  const handleLogout = useCallback(() => {
    Alert.alert('Sign out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: () => logout() },
    ]);
  }, [logout]);

  return (
    <SafeAreaView style={[s.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={s.header}>
        <Text style={[s.title, { color: colors.text }]}>Profile</Text>
      </View>

      {/* Account section */}
      <View style={[s.card, { backgroundColor: colors.surface }, Shadows.sm]}>
        <View style={s.cardRow}>
          <View style={[s.avatarCircle, { backgroundColor: colors.primaryLight }]}>
            <Ionicons name="person" size={22} color={colors.primary} />
          </View>
          <View style={s.cardRowText}>
            <Text style={[s.cardLabel, { color: colors.textSecondary }]}>Signed in as</Text>
            <Text style={[s.cardValue, { color: colors.text }]} numberOfLines={1}>
              {user?.email ?? '—'}
            </Text>
          </View>
        </View>
      </View>

      {/* Household code section */}
      <Text style={[s.sectionTitle, { color: colors.textSecondary }]}>YOUR HOUSEHOLD CODE</Text>
      <View style={[s.card, { backgroundColor: colors.surface }, Shadows.sm]}>
        <Text style={[s.codeDisplay, { color: colors.primary, letterSpacing: 8 }]}>
          {inviteCode ?? '——'}
        </Text>
        <Text style={[s.codeHint, { color: colors.textTertiary }]}>
          Share this code with others to connect them to your household.
        </Text>
        <View style={s.codeActions}>
          <TouchableOpacity
            style={[s.actionBtn, { backgroundColor: copied ? colors.primaryLight : colors.primaryLight, borderColor: colors.primary }]}
            onPress={handleCopy}
            activeOpacity={0.75}
          >
            <Ionicons name={copied ? 'checkmark' : 'copy-outline'} size={16} color={colors.primary} />
            <Text style={[s.actionBtnText, { color: colors.primary }]}>
              {copied ? 'Copied!' : 'Copy'}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.actionBtn, { backgroundColor: colors.primaryLight, borderColor: colors.primary }]}
            onPress={handleShare}
            activeOpacity={0.75}
          >
            <Ionicons name="share-outline" size={16} color={colors.primary} />
            <Text style={[s.actionBtnText, { color: colors.primary }]}>Share</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Join different household */}
      <Text style={[s.sectionTitle, { color: colors.textSecondary }]}>JOIN A DIFFERENT HOUSEHOLD</Text>
      <View style={[s.card, { backgroundColor: colors.surface }, Shadows.sm]}>
        <Text style={[s.codeHint, { color: colors.textTertiary }]}>
          Enter another household's invite code to switch. Your current meal plan and shopping list will not carry over.
        </Text>
        <View style={s.joinRow}>
          <TextInput
            style={[s.joinInput, { backgroundColor: colors.inputBackground, color: colors.text, borderColor: colors.border }]}
            value={joinCode}
            onChangeText={(t) => setJoinCode(t.toUpperCase())}
            placeholder="e.g. AB12CD"
            placeholderTextColor={colors.textTertiary}
            autoCapitalize="characters"
            maxLength={10}
          />
          <TouchableOpacity
            style={[s.joinBtn, { backgroundColor: colors.primary }, switching && { opacity: 0.6 }]}
            onPress={handleSwitch}
            disabled={switching || joinCode.trim().length === 0}
            activeOpacity={0.8}
          >
            {switching
              ? <ActivityIndicator size="small" color="#fff" />
              : <Text style={s.joinBtnText}>Switch</Text>
            }
          </TouchableOpacity>
        </View>
      </View>

      {/* Preferences */}
      <Text style={[s.sectionTitle, { color: colors.textSecondary }]}>PREFERENCES</Text>
      <View style={[s.card, { backgroundColor: colors.surface }, Shadows.sm]}>
        <Text style={[s.codeHint, { color: colors.textTertiary, marginBottom: Spacing.md }]}>
          Choose how the app looks. &ldquo;System&rdquo; follows your device setting.
        </Text>
        <View style={s.themeRow}>
          {(['system', 'light', 'dark'] as const).map((opt) => {
            const active = mode === opt;
            return (
              <TouchableOpacity
                key={opt}
                style={[
                  s.themeChip,
                  {
                    borderColor: active ? colors.primary : colors.border,
                    backgroundColor: active ? colors.primaryLight : 'transparent',
                  },
                ]}
                onPress={() => setMode(opt)}
                activeOpacity={0.7}
              >
                <Text
                  style={[
                    s.themeChipText,
                    { color: active ? colors.primary : colors.textSecondary },
                  ]}
                >
                  {opt[0].toUpperCase() + opt.slice(1)}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      {/* Sign out */}
      <View style={s.spacer} />
      <TouchableOpacity
        style={[s.signOutBtn, { borderColor: colors.error }]}
        onPress={handleLogout}
        activeOpacity={0.75}
      >
        <Ionicons name="log-out-outline" size={18} color={colors.error} />
        <Text style={[s.signOutText, { color: colors.error }]}>Sign out</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },

  header: {
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.lg,
    paddingBottom: Spacing.md,
  },
  title: { fontSize: FontSizes.xxl, fontFamily: Fonts.bold },

  sectionTitle: {
    fontSize: FontSizes.xs,
    fontFamily: Fonts.semibold,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginHorizontal: Spacing.xl,
    marginTop: Spacing.lg,
    marginBottom: Spacing.sm,
  },

  card: {
    marginHorizontal: Spacing.xl,
    borderRadius: Radius.xl,
    padding: Spacing.xl,
  },

  cardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
  },
  avatarCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardRowText: { flex: 1 },
  cardLabel: { fontSize: FontSizes.xs, fontFamily: Fonts.medium },
  cardValue: { fontSize: FontSizes.md, fontFamily: Fonts.semibold, marginTop: 2 },

  codeDisplay: {
    fontSize: 32,
    fontFamily: Fonts.bold,
    textAlign: 'center',
    marginBottom: Spacing.sm,
  },
  codeHint: {
    fontSize: FontSizes.sm,
    fontFamily: Fonts.regular,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: Spacing.lg,
  },
  codeActions: {
    flexDirection: 'row',
    gap: Spacing.md,
    justifyContent: 'center',
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
    borderRadius: Radius.pill,
    borderWidth: 1.5,
  },
  actionBtnText: { fontSize: FontSizes.sm, fontFamily: Fonts.semibold },

  joinRow: {
    flexDirection: 'row',
    gap: Spacing.md,
    alignItems: 'center',
  },
  joinInput: {
    flex: 1,
    borderRadius: Radius.md,
    borderWidth: 1,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    fontSize: FontSizes.md,
    fontFamily: Fonts.semibold,
    letterSpacing: 2,
  },
  joinBtn: {
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderRadius: Radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 80,
  },
  joinBtnText: { color: '#fff', fontSize: FontSizes.sm, fontFamily: Fonts.bold },

  spacer: { flex: 1 },

  themeRow: {
    flexDirection: 'row',
    gap: Spacing.sm,
  },
  themeChip: {
    flex: 1,
    paddingVertical: Spacing.sm,
    borderRadius: Radius.pill,
    borderWidth: 1.5,
    alignItems: 'center',
  },
  themeChipText: {
    fontSize: FontSizes.sm,
    fontFamily: Fonts.semibold,
  },

  signOutBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    marginHorizontal: Spacing.xl,
    marginBottom: Spacing.xl,
    paddingVertical: Spacing.md,
    borderRadius: Radius.pill,
    borderWidth: 1.5,
  },
  signOutText: { fontSize: FontSizes.md, fontFamily: Fonts.semibold },
});
