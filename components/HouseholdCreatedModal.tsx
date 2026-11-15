import React, { useState } from 'react';
import { Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useAuth } from '@/contexts/AuthContext';
import { useTheme } from '@/contexts/ThemeContext';
import { FontSizes, Fonts, Radius, Shadows, Spacing } from '@/constants/theme';

/**
 * Shows a newly created household's invite code after first-time Google sign-in.
 * Rendered by the root navigator rather than the login screen: signing in redirects
 * to the tabs at once, which unmounted the login screen before the code was seen.
 */
export default function HouseholdCreatedModal() {
  const { pendingInviteCode, clearPendingInviteCode } = useAuth();
  const { colors } = useTheme();
  const [copiedCode, setCopiedCode] = useState(false);
  const handleCopyCode = async () => {
    if (!pendingInviteCode) return;
    await Clipboard.setStringAsync(pendingInviteCode);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  };
  return (
    <Modal
      visible={!!pendingInviteCode}
      transparent
      animationType="fade"
      onRequestClose={clearPendingInviteCode}
    >
      <View style={[styles.modalOverlay, { backgroundColor: colors.overlay }]}>
        <View style={[styles.modalCard, { backgroundColor: colors.surface }, Shadows.lg]}>
          <View style={[styles.modalIconContainer, { backgroundColor: colors.primaryLight }]}>
            <Ionicons name="checkmark-circle" size={48} color={colors.primaryText} />
          </View>
          <Text style={[styles.modalTitle, { color: colors.text }]}>Household Created!</Text>
          <Text style={[styles.modalSubtitle, { color: colors.textSecondary }]}>
            Share this code with others to join your household:
          </Text>
          <View style={[styles.codeContainer, { backgroundColor: colors.inputBackground, borderColor: colors.border }]}>
            <Text style={[styles.codeText, { color: colors.primaryText }]}>{pendingInviteCode}</Text>
          </View>
          <TouchableOpacity
            style={[styles.copyButton, { backgroundColor: colors.primary }]}
            onPress={handleCopyCode}
            activeOpacity={0.8}
          >
            <Ionicons name={copiedCode ? 'checkmark' : 'copy-outline'} size={20} color="#fff" style={{ marginRight: Spacing.sm }} />
            <Text style={styles.copyButtonText}>{copiedCode ? 'Copied!' : 'Copy Code'}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.dismissButton} onPress={clearPendingInviteCode} activeOpacity={0.7}>
            <Text style={[styles.dismissButtonText, { color: colors.textSecondary }]}>Continue to App</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  modalOverlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: Spacing.xxl,
  },
  modalCard: {
    borderRadius: Radius.xl,
    padding: Spacing.xxxl,
    alignItems: 'center',
    width: '100%',
    maxWidth: 360,
  },
  modalIconContainer: {
    width: 80,
    height: 80,
    borderRadius: Radius.pill,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: Spacing.lg,
  },
  modalTitle: {
    fontSize: FontSizes.xxl,
    fontFamily: Fonts.bold,
    marginBottom: Spacing.sm,
  },
  modalSubtitle: {
    fontSize: FontSizes.md,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: Spacing.xl,
  },
  codeContainer: {
    borderRadius: Radius.md,
    borderWidth: 2,
    borderStyle: 'dashed',
    paddingVertical: Spacing.lg,
    paddingHorizontal: Spacing.xxxl,
    marginBottom: Spacing.xl,
  },
  codeText: {
    fontSize: FontSizes.xxxl,
    fontFamily: Fonts.bold,
    letterSpacing: 4,
  },
  copyButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 48,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.xxl,
    width: '100%',
    marginBottom: Spacing.md,
  },
  copyButtonText: {
    color: '#FFFFFF',
    fontSize: FontSizes.md,
    fontFamily: Fonts.bold,
  },
  dismissButton: {
    padding: Spacing.md,
  },
  dismissButtonText: {
    fontSize: FontSizes.md,
  },
});
