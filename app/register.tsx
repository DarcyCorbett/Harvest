import React, { useState } from 'react';
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
  useColorScheme,
  ScrollView,
  Modal,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '@/contexts/AuthContext';
import { Colors, FontSizes, Fonts, Spacing, Radius, Shadows } from '@/constants/theme';
import * as Clipboard from 'expo-clipboard';

export default function RegisterScreen() {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];
  const router = useRouter();
  const { register, signInWithGoogle } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [generatedCode, setGeneratedCode] = useState('');
  const [copied, setCopied] = useState(false);

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

  const handleRegister = async () => {
    if (!email.trim() || !password.trim()) {
      Alert.alert('Missing Fields', 'Please enter email and password.');
      return;
    }
    if (password !== confirmPassword) {
      Alert.alert('Password Mismatch', 'Passwords do not match.');
      return;
    }
    if (password.length < 6) {
      Alert.alert('Weak Password', 'Password must be at least 6 characters.');
      return;
    }
    setLoading(true);
    try {
      const result = await register(email.trim(), password, inviteCode.trim() || undefined);
      if (result.inviteCode) {
        // New household created — show the invite code
        setGeneratedCode(result.inviteCode);
        setShowInviteModal(true);
      }
      // If joined existing household, onAuthStateChanged handles navigation
    } catch (error: any) {
      if (error.message === 'Access Denied') {
        Alert.alert('Access Denied', 'Your email is not authorized to use this app. Please request an invitation.');
        return;
      }

      let message = 'Failed to create account. Please try again.';
      if (error.code === 'auth/email-already-in-use') {
        message = 'This email is already registered. Try logging in.';
      } else if (error.code === 'auth/invalid-email') {
        message = 'Please enter a valid email address.';
      } else if (error.code === 'auth/weak-password') {
        message = 'Password must be at least 6 characters.';
      } else if (error.message?.includes('Invalid invite code')) {
        message = error.message;
      }
      Alert.alert('Registration Failed', message);
    } finally {
      setLoading(false);
    }
  };

  const handleCopyCode = async () => {
    try {
      await Clipboard.setStringAsync(generatedCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard might not be available
      Alert.alert('Invite Code', `Your invite code is: ${generatedCode}\n\nShare it with your partner to join your household.`);
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
            Create your household
          </Text>
        </View>

        {/* Form */}
        <View style={[styles.formCard, { backgroundColor: colors.surface }, Shadows.md]}>
          <Text style={[styles.formTitle, { color: colors.text }]}>Create Account</Text>

          {/* Email */}
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
                id="register-email"
              />
            </View>
          </View>

          {/* Password */}
          <View style={styles.inputGroup}>
            <Text style={[styles.label, { color: colors.textSecondary }]}>Password</Text>
            <View style={[styles.inputContainer, { backgroundColor: colors.inputBackground, borderColor: colors.border }]}>
              <Ionicons name="lock-closed-outline" size={20} color={colors.textTertiary} style={styles.inputIcon} />
              <TextInput
                style={[styles.input, { color: colors.text }]}
                placeholder="At least 6 characters"
                placeholderTextColor={colors.placeholder}
                value={password}
                onChangeText={setPassword}
                secureTextEntry={!showPassword}
                autoComplete="new-password"
                id="register-password"
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

          {/* Confirm Password */}
          <View style={styles.inputGroup}>
            <Text style={[styles.label, { color: colors.textSecondary }]}>Confirm Password</Text>
            <View style={[styles.inputContainer, { backgroundColor: colors.inputBackground, borderColor: colors.border }]}>
              <Ionicons name="lock-closed-outline" size={20} color={colors.textTertiary} style={styles.inputIcon} />
              <TextInput
                style={[styles.input, { color: colors.text }]}
                placeholder="Re-enter your password"
                placeholderTextColor={colors.placeholder}
                value={confirmPassword}
                onChangeText={setConfirmPassword}
                secureTextEntry={!showPassword}
                id="register-confirm-password"
              />
            </View>
          </View>

          {/* Invite Code (optional) */}
          <View style={styles.inputGroup}>
            <Text style={[styles.label, { color: colors.textSecondary }]}>Invite Code (optional)</Text>
            <View style={[styles.inputContainer, { backgroundColor: colors.inputBackground, borderColor: colors.border }]}>
              <Ionicons name="people-outline" size={20} color={colors.textTertiary} style={styles.inputIcon} />
              <TextInput
                style={[styles.input, { color: colors.text }]}
                placeholder="Got a code from your partner?"
                placeholderTextColor={colors.placeholder}
                value={inviteCode}
                onChangeText={(text) => setInviteCode(text.toUpperCase())}
                autoCapitalize="characters"
                id="register-invite-code"
              />
            </View>
            <Text style={[styles.helperText, { color: colors.textTertiary }]}>
              Leave blank to create a new household
            </Text>
          </View>

          {/* Register Button */}
          <TouchableOpacity
            style={[styles.primaryButton, { backgroundColor: colors.primary }]}
            onPress={handleRegister}
            disabled={loading}
            activeOpacity={0.8}
            id="register-button"
          >
            {loading ? (
              <ActivityIndicator color={colors.textInverse} />
            ) : (
              <Text style={[styles.primaryButtonText, { color: colors.textInverse }]}>Create Account</Text>
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

        {/* Login Link */}
        <View style={styles.switchSection}>
          <Text style={[styles.switchText, { color: colors.textSecondary }]}>
            Already have an account?{' '}
          </Text>
          <TouchableOpacity onPress={() => router.back()} id="go-to-login">
            <Text style={[styles.switchLink, { color: colors.primary }]}>Log In</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>

      {/* Invite Code Modal */}
      <Modal
        visible={showInviteModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowInviteModal(false)}
      >
        <View style={[styles.modalOverlay, { backgroundColor: colors.overlay }]}>
          <View style={[styles.modalCard, { backgroundColor: colors.surface }, Shadows.lg]}>
            <View style={[styles.modalIconContainer, { backgroundColor: colors.accentLight }]}>
              <Ionicons name="checkmark-circle" size={48} color={colors.accent} />
            </View>
            <Text style={[styles.modalTitle, { color: colors.text }]}>Household Created!</Text>
            <Text style={[styles.modalSubtitle, { color: colors.textSecondary }]}>
              Share this code with your partner so they can join your household:
            </Text>

            {/* Code Display */}
            <View style={[styles.codeContainer, { backgroundColor: colors.inputBackground, borderColor: colors.border }]}>
              <Text style={[styles.codeText, { color: colors.primary }]}>{generatedCode}</Text>
            </View>

            <TouchableOpacity
              style={[styles.copyButton, { backgroundColor: colors.accent }]}
              onPress={handleCopyCode}
              activeOpacity={0.8}
            >
              <Ionicons
                name={copied ? 'checkmark' : 'copy-outline'}
                size={20}
                color="#FFFFFF"
                style={{ marginRight: Spacing.sm }}
              />
              <Text style={styles.copyButtonText}>
                {copied ? 'Copied!' : 'Copy Code'}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.dismissButton]}
              onPress={() => setShowInviteModal(false)}
              activeOpacity={0.7}
            >
              <Text style={[styles.dismissButtonText, { color: colors.textSecondary }]}>
                Continue to App
              </Text>
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
    paddingVertical: Spacing.xxxl,
  },
  headerSection: {
    alignItems: 'center',
    marginBottom: Spacing.xxl,
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
    fontFamily: Fonts.bold,
    letterSpacing: -1,
  },
  tagline: {
    fontSize: FontSizes.md,
    marginTop: Spacing.xs,
    fontFamily: Fonts.medium,
  },
  formCard: {
    borderRadius: Radius.xl,
    padding: Spacing.xxl,
    marginBottom: Spacing.xxl,
  },
  formTitle: {
    fontSize: FontSizes.xl,
    fontFamily: Fonts.bold,
    marginBottom: Spacing.xl,
  },
  inputGroup: {
    marginBottom: Spacing.lg,
  },
  label: {
    fontSize: FontSizes.sm,
    fontFamily: Fonts.semibold,
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
  helperText: {
    fontSize: FontSizes.xs,
    marginTop: Spacing.xs,
    marginLeft: Spacing.xs,
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
    fontFamily: Fonts.bold,
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
    fontFamily: Fonts.semibold,
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
    fontFamily: Fonts.semibold,
  },
  // Modal styles
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
    fontFamily: Fonts.medium,
  },
});
