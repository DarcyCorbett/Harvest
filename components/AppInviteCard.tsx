import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Share, Text, TextInput, TouchableOpacity, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useAuth } from '@/contexts/AuthContext';
import { useTheme } from '@/contexts/ThemeContext';
import { Fonts, Radius, Shadows, Spacing } from '@/constants/theme';
import { appInvitationMessage, getAppInvitePermissions, inviteAppUser, type AppInvitation } from '@/services/appInvites';

export default function AppInviteCard() {
  const { user } = useAuth();
  const { colors } = useTheme();
  const [canInvite, setCanInvite] = useState(false);
  const [permissionError, setPermissionError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [invitation, setInvitation] = useState<AppInvitation | null>(null);
  const [message, setMessage] = useState('');
  useEffect(() => {
    let active = true;
    setCanInvite(false); setPermissionError(false); setInvitation(null); setEmail(''); setMessage('');
    if (user) getAppInvitePermissions().then(result => {
      if (active) setCanInvite(result.canInvite);
    }).catch(() => { if (active) setPermissionError(true); });
    return () => { active = false; };
  }, [user, attempt]);
  const button = (label: string, action: () => void) => (
    <TouchableOpacity accessibilityRole="button" disabled={busy} onPress={action}
      style={{ minHeight: 48, justifyContent: 'center', padding: 12, borderRadius: 12, backgroundColor: colors.primaryLight, opacity: busy ? 0.5 : 1 }}>
      <Text style={{ color: colors.primaryText, fontFamily: Fonts.semibold, textAlign: 'center' }}>{label}</Text>
    </TouchableOpacity>
  );
  // Same horizontal inset and section rhythm as the other Settings cards.
  const frame = { marginHorizontal: Spacing.xl, marginTop: Spacing.lg };
  if (permissionError) return <View style={frame}>{button('Retry account permissions', () => setAttempt(value => value + 1))}</View>;
  if (!canInvite) return null;
  async function grant() {
    setBusy(true); setMessage(''); setInvitation(null);
    try { setInvitation(await inviteAppUser(email.trim())); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Could not enable access. Please try again.'); }
    finally { setBusy(false); }
  }
  async function share(copy: boolean) {
    if (!invitation) return;
    try {
      const text = appInvitationMessage(invitation);
      if (copy) { await Clipboard.setStringAsync(text); setMessage('Invitation copied.'); }
      else await Share.share({ message: text });
    } catch { setMessage('Could not share. Try copying the invitation.'); }
  }
  return <>
  <Text style={{ marginHorizontal: Spacing.xl, marginTop: Spacing.lg, marginBottom: Spacing.sm, color: colors.textSecondary, fontSize: 12, fontFamily: Fonts.semibold, letterSpacing: 0.6 }}>ADMIN</Text>
  <View style={[{ marginHorizontal: Spacing.xl, padding: Spacing.xl, gap: 12, borderRadius: Radius.xl, backgroundColor: colors.surface }, Shadows.sm]}>
    <Text style={{ color: colors.text, fontSize: 18, fontFamily: Fonts.semibold }}>Invite to Harvest</Text>
    <Text style={{ color: colors.textSecondary }}>Enter the email they will use to sign in. Enable access, then share the download link. They can create their own household.</Text>
    <TextInput accessibilityLabel="Invitee email address" placeholder="Email address" placeholderTextColor={colors.textSecondary}
      value={email} onChangeText={value => { setEmail(value); setInvitation(null); setMessage(''); }} editable={!busy}
      keyboardType="email-address" autoCapitalize="none" autoCorrect={false}
      style={{ color: colors.text, borderColor: colors.textSecondary, borderWidth: 1, borderRadius: 12, padding: 12, minHeight: 48 }} />
    {button('Enable access', () => { void grant(); })}
    {busy && <ActivityIndicator color={colors.primaryText} />}
    {invitation && <>
      <Text selectable style={{ color: colors.text }}>{invitation.alreadyAllowed ? 'Already has access' : 'Access enabled'}: {invitation.email}</Text>
      {button('Share invitation', () => { void share(false); })}
      {button('Copy invitation', () => { void share(true); })}
    </>}
    {!!message && <Text accessibilityLiveRegion="polite" style={{ color: colors.text }}>{message}</Text>}
  </View>
  </>;
}
