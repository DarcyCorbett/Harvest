import { httpsCallable } from 'firebase/functions';
import { functions } from '@/config/firebase';

export interface AppInvitation {
  email: string;
  alreadyAllowed: boolean;
  downloadUrl: string;
}
export async function getAppInvitePermissions() {
  return (await httpsCallable<void, { canInvite: boolean }>(functions, 'getAppInvitePermissions')()).data;
}
export async function inviteAppUser(email: string) {
  return (await httpsCallable<{ email: string }, AppInvitation>(functions, 'inviteAppUser')({ email })).data;
}
export function appInvitationMessage(invitation: AppInvitation) {
  return `You're invited to Harvest! Download the Android app: ${invitation.downloadUrl}\n\nSign in or register with ${invitation.email}. Access has been enabled for this email. If you register with a password, verify your email before signing in.`;
}
