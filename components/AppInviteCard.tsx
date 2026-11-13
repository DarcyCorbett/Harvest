import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Share, Text, TextInput, TouchableOpacity, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useAuth } from '@/contexts/AuthContext';
import { useTheme } from '@/contexts/ThemeContext';
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
      <Text style={{ color: colors.primary, fontWeight: '600', textAlign: 'center' }}>{label}</Text>
    </TouchableOpacity>
  );
  if (permissionError) return button('Retry account permissions', () => setAttempt(value => value + 1));
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
  return <View style={{ padding: 20, marginBottom: 20, gap: 12, borderRadius: 20, backgroundColor: colors.surface }}>
    <Text style={{ color: colors.text, fontSize: 20, fontWeight: '600' }}>Admin · Invite to Harvest</Text>
    <Text style={{ color: colors.textSecondary }}>Enter the email they will use to sign in. Enable access, then share the download link. They can create their own household.</Text>
    <TextInput accessibilityLabel="Invitee email address" placeholder="Email address" placeholderTextColor={colors.textSecondary}
      value={email} onChangeText={value => { setEmail(value); setInvitation(null); setMessage(''); }} editable={!busy}
      keyboardType="email-address" autoCapitalize="none" autoCorrect={false}
      style={{ color: colors.text, borderColor: colors.textSecondary, borderWidth: 1, borderRadius: 12, padding: 12, minHeight: 48 }} />
    {button('Enable access', () => { void grant(); })}
    {busy && <ActivityIndicator color={colors.primary} />}
    {invitation && <>
      <Text selectable style={{ color: colors.text }}>{invitation.alreadyAllowed ? 'Already has access' : 'Access enabled'}: {invitation.email}</Text>
      {button('Share invitation', () => { void share(false); })}
      {button('Copy invitation', () => { void share(true); })}
    </>}
    {!!message && <Text accessibilityLiveRegion="polite" style={{ color: colors.text }}>{message}</Text>}
  </View>;
}
