import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Alert,
  ScrollView,
  Modal,
} from 'react-native';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '@/contexts/AuthContext';
import { Colors, FontSizes, FontWeights, Fonts, Spacing, Radius, Shadows } from '@/constants/theme';
import * as Clipboard from 'expo-clipboard';

export default function LoginScreen() {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];
  const router = useRouter();
  const { login, signInWithGoogle, pendingInviteCode, clearPendingInviteCode } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);

  const handleGoogleSignIn = async () => {
    setGoogleLoading(true);
    try {
      await signInWithGoogle();
    } catch (error: any) {
      if (error.message === 'Access Denied') {
        Alert.alert('Access Denied', 'Your email is not authorized to use this app. Please request an invitation.');
      } else if (error.code === 'auth/account-exists-with-different-credential') {
        Alert.alert('Account Exists', 'This email is already registered with email/password. Please sign in with your email and password instead.');
      } else if (error.code !== 'ERR_REQUEST_CANCELED') {
        Alert.alert('Sign-In Failed', 'Google sign-in failed. Please try again.');
      }
    } finally {
      setGoogleLoading(false);
    }
  };

  const handleCopyCode = async () => {
    if (!pendingInviteCode) return;
    await Clipboard.setStringAsync(pendingInviteCode);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  };

  const handleLogin = async () => {
    if (!email.trim() || !password.trim()) {
      Alert.alert('Missing Fields', 'Please enter both email and password.');
      return;
    }
    setLoading(true);
    try {
      await login(email.trim(), password);
    } catch (error: any) {
      if (error.message === 'Access Denied') {
        Alert.alert('Access Denied', 'Your email is not authorized to use this app. Please request an invitation.');
        return;
      }

      let message = 'Failed to log in. Please try again.';
      if (error.code === 'auth/user-not-found' || error.code === 'auth/wrong-password' || error.code === 'auth/invalid-credential') {
        message = 'Invalid email or password.';
      } else if (error.code === 'auth/invalid-email') {
        message = 'Please enter a valid email address.';
      } else if (error.code === 'auth/too-many-requests') {
        message = 'Too many attempts. Please try again later.';
      }
      Alert.alert('Login Failed', message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: colors.background }]}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        {/* Logo / Header */}
        <View style={styles.headerSection}>
          <View style={[styles.logoContainer, { backgroundColor: colors.primaryLight }]}>
            <Ionicons name="restaurant" size={48} color={colors.primary} />
          </View>
          <Text style={[styles.appName, { color: colors.text }]}>Harvest</Text>
          <Text style={[styles.tagline, { color: colors.textSecondary }]}>
            Plan smarter. Cook better. Together.
          </Text>
        </View>

        {/* Form */}
        <View style={[styles.formCard, { backgroundColor: colors.surface }, Shadows.md]}>
          <Text style={[styles.formTitle, { color: colors.text }]}>Welcome Back</Text>

          {/* Email Input */}
          <View style={styles.inputGroup}>
            <Text style={[styles.label, { color: colors.textSecondary }]}>Email</Text>
            <View style={[styles.inputContainer, { backgroundColor: colors.inputBackground, borderColor: colors.border }]}>
              <Ionicons name="mail-outline" size={20} color={colors.textTertiary} style={styles.inputIcon} />
              <TextInput
                style={[styles.input, { color: colors.text }]}
                placeholder="your@email.com"
                placeholderTextColor={colors.placeholder}
                value={email}
                onChangeText={setEmail}
                keyboardType="email-address"
                autoCapitalize="none"
                autoComplete="email"
                id="login-email"
              />
            </View>
          </View>

          {/* Password Input */}
          <View style={styles.inputGroup}>
            <Text style={[styles.label, { color: colors.textSecondary }]}>Password</Text>
            <View style={[styles.inputContainer, { backgroundColor: colors.inputBackground, borderColor: colors.border }]}>
              <Ionicons name="lock-closed-outline" size={20} color={colors.textTertiary} style={styles.inputIcon} />
              <TextInput
                style={[styles.input, { color: colors.text }]}
                placeholder="Enter your password"
                placeholderTextColor={colors.placeholder}
                value={password}
                onChangeText={setPassword}
                secureTextEntry={!showPassword}
                autoComplete="password"
                id="login-password"
              />
              <TouchableOpacity onPress={() => setShowPassword(!showPassword)} style={styles.eyeButton}>
                <Ionicons
                  name={showPassword ? 'eye-off-outline' : 'eye-outline'}
                  size={20}
                  color={colors.textTertiary}
                />
              </TouchableOpacity>
            </View>
          </View>

          {/* Login Button */}
          <TouchableOpacity
            style={[styles.primaryButton, { backgroundColor: colors.primary }]}
            onPress={handleLogin}
            disabled={loading}
            activeOpacity={0.8}
            id="login-button"
          >
            {loading ? (
              <ActivityIndicator color={colors.textInverse} />
            ) : (
              <Text style={[styles.primaryButtonText, { color: colors.textInverse }]}>Log In</Text>
            )}
          </TouchableOpacity>

          {/* Divider */}
          <View style={styles.dividerRow}>
            <View style={[styles.dividerLine, { backgroundColor: colors.border }]} />
            <Text style={[styles.dividerText, { color: colors.textTertiary }]}>or</Text>
            <View style={[styles.dividerLine, { backgroundColor: colors.border }]} />
          </View>

          {/* Google Sign-In */}
          <TouchableOpacity
            style={[styles.googleButton, { backgroundColor: colors.surface, borderColor: colors.border }]}
            onPress={handleGoogleSignIn}
            disabled={googleLoading}
            activeOpacity={0.8}
          >
            {googleLoading ? (
              <ActivityIndicator color={colors.text} />
            ) : (
              <>
                <Ionicons name="logo-google" size={20} color="#4285F4" style={styles.googleIcon} />
                <Text style={[styles.googleButtonText, { color: colors.text }]}>Continue with Google</Text>
              </>
            )}
          </TouchableOpacity>
        </View>

        {/* Register Link */}
        <View style={styles.switchSection}>
          <Text style={[styles.switchText, { color: colors.textSecondary }]}>
            Don&apos;t have an account?{' '}
          </Text>
          <TouchableOpacity onPress={() => router.push('/register')} id="go-to-register">
            <Text style={[styles.switchLink, { color: colors.primary }]}>Create Account</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>

      {/* New household invite code modal (shown for first-time Google sign-in) */}
      <Modal
        visible={!!pendingInviteCode}
        transparent
        animationType="fade"
        onRequestClose={clearPendingInviteCode}
      >
        <View style={[styles.modalOverlay, { backgroundColor: colors.overlay }]}>
          <View style={[styles.modalCard, { backgroundColor: colors.surface }, Shadows.lg]}>
            <View style={[styles.modalIconContainer, { backgroundColor: colors.primaryLight }]}>
              <Ionicons name="checkmark-circle" size={48} color={colors.primary} />
            </View>
            <Text style={[styles.modalTitle, { color: colors.text }]}>Household Created!</Text>
            <Text style={[styles.modalSubtitle, { color: colors.textSecondary }]}>
              Share this code with others to join your household:
            </Text>
            <View style={[styles.codeContainer, { backgroundColor: colors.inputBackground, borderColor: colors.border }]}>
              <Text style={[styles.codeText, { color: colors.primary }]}>{pendingInviteCode}</Text>
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
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: Spacing.xxl,
    paddingVertical: Spacing.huge,
  },
  headerSection: {
    alignItems: 'center',
    marginBottom: Spacing.xxxl,
  },
  logoContainer: {
    width: 96,
    height: 96,
    borderRadius: Radius.xxl,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: Spacing.lg,
  },
  appName: {
    fontSize: FontSizes.xxxl,
    fontWeight: FontWeights.extrabold,
    letterSpacing: -1,
  },
  tagline: {
    fontSize: FontSizes.md,
    marginTop: Spacing.xs,
    fontWeight: FontWeights.regular,
  },
  formCard: {
    borderRadius: Radius.xl,
    padding: Spacing.xxl,
    marginBottom: Spacing.xxl,
  },
  formTitle: {
    fontSize: FontSizes.xl,
    fontWeight: FontWeights.bold,
    marginBottom: Spacing.xl,
  },
  inputGroup: {
    marginBottom: Spacing.lg,
  },
  label: {
    fontSize: FontSizes.sm,
    fontWeight: FontWeights.medium,
    marginBottom: Spacing.sm,
  },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: Radius.md,
    borderWidth: 1,
    paddingHorizontal: Spacing.md,
    height: 52,
  },
  inputIcon: {
    marginRight: Spacing.sm,
  },
  input: {
    flex: 1,
    fontSize: FontSizes.md,
    height: '100%',
  },
  eyeButton: {
    padding: Spacing.xs,
  },
  primaryButton: {
    height: 52,
    borderRadius: Radius.md,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: Spacing.sm,
  },
  primaryButtonText: {
    fontSize: FontSizes.lg,
    fontWeight: FontWeights.semibold,
  },
  switchSection: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
  },
  switchText: {
    fontSize: FontSizes.md,
  },
  switchLink: {
    fontSize: FontSizes.md,
    fontWeight: FontWeights.semibold,
  },
  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: Spacing.lg,
    gap: Spacing.md,
  },
  dividerLine: {
    flex: 1,
    height: 1,
  },
  dividerText: {
    fontSize: FontSizes.sm,
  },
  googleButton: {
    height: 52,
    borderRadius: Radius.md,
    borderWidth: 1,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
  },
  googleIcon: {
    marginRight: Spacing.sm,
  },
  googleButtonText: {
    fontSize: FontSizes.md,
    fontWeight: FontWeights.semibold,
  },
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
    fontWeight: FontWeights.bold,
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
