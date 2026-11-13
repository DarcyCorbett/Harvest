import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { authorizeAllowlistedUser, type AuthorizedIdentity } from '../authz.js';

type Auth = CallableRequest<unknown>['auth'];
export interface InviteStore {
  isAdmin(uid: string): Promise<boolean>;
  grant(uid: string, email: string): Promise<{ alreadyAllowed: boolean; downloadUrl: string }>;
}

export function normalizeInviteEmail(value: unknown): string {
  if (typeof value !== 'string') throw new HttpsError('invalid-argument', 'Enter a valid email address.');
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(email)) {
    throw new HttpsError('invalid-argument', 'Enter a valid email address.');
  }
  return email;
}

export function createAppInviteHandlers(
  store: InviteStore,
  authorize: (auth: Auth) => Promise<AuthorizedIdentity> = authorizeAllowlistedUser,
) {
  return {
    async permissions(request: { auth?: Auth }) {
      const identity = await authorize(request.auth);
      return { canInvite: await store.isAdmin(identity.uid) };
    },
    async invite(request: { auth?: Auth; data: unknown }) {
      const identity = await authorize(request.auth);
      if (!(await store.isAdmin(identity.uid))) throw new HttpsError('permission-denied', 'Admin invite permission required.');
      const data = request.data;
      if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => key !== 'email')) {
        throw new HttpsError('invalid-argument', 'Provide an email address.');
      }
      const email = normalizeInviteEmail((data as { email?: unknown }).email);
      return { email, ...await store.grant(identity.uid, email) };
    },
  };
}

export function firestoreInviteStore(): InviteStore {
  const db = getFirestore();
  return {
    async isAdmin(uid) {
      const role = await db.collection('appAdmins').doc(uid).get();
      return role.get('enabled') === true && role.get('canInvite') === true;
    },
    async grant(uid, email) {
      return db.runTransaction(async transaction => {
        const role = await transaction.get(db.collection('appAdmins').doc(uid));
        if (role.get('enabled') !== true || role.get('canInvite') !== true) {
          throw new HttpsError('permission-denied', 'Admin invite permission required.');
        }
        const distribution = await transaction.get(db.collection('appDistribution').doc('current'));
        const downloadUrl: unknown = distribution.get('downloadUrl');
        if (typeof downloadUrl !== 'string' || !/^https:\/\/[^\s]+$/.test(downloadUrl)) {
          throw new HttpsError('failed-precondition', 'App download is not configured yet. Please try again later.');
        }
        const target = db.collection('allowlist').doc(email);
        const existing = await transaction.get(target);
        if (!existing.exists) {
          transaction.create(target, { enabled: true });
        }
        // Audit privately: allowlist documents support pre-login lookups.
        transaction.set(db.collection('appInvitations').doc(email), {
          invitedBy: uid, lastInvitedAt: FieldValue.serverTimestamp(),
        });
        return { alreadyAllowed: existing.exists, downloadUrl };
      });
    },
  };
}
