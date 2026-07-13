import { getFirestore } from 'firebase-admin/firestore';
import { HttpsError, type CallableRequest } from 'firebase-functions/v2/https';

type AuthData = CallableRequest<unknown>['auth'];

export interface AuthzLookups {
  isAllowlisted(email: string): Promise<boolean>;
  getMembers(householdId: string): Promise<string[] | null>;
}

export interface AuthorizedIdentity {
  uid: string;
  email: string;
}

export function firestoreAuthzLookups(): AuthzLookups {
  const db = getFirestore();

  return {
    async isAllowlisted(email) {
      const snapshot = await db.collection('allowlist').doc(email).get();
      return snapshot.exists;
    },
    async getMembers(householdId) {
      const snapshot = await db.collection('households').doc(householdId).get();
      if (!snapshot.exists) return null;

      const members: unknown = snapshot.get('members');
      if (!Array.isArray(members)) return [];
      return members.filter((member): member is string => typeof member === 'string');
    },
  };
}

export async function authorizeHouseholdMember(
  auth: AuthData,
  householdId: string,
  lookups: AuthzLookups = firestoreAuthzLookups(),
): Promise<AuthorizedIdentity> {
  if (!auth) {
    throw new HttpsError('unauthenticated', 'Authentication required.');
  }
  if (auth.token.email_verified !== true) {
    throw new HttpsError('permission-denied', 'Permission denied.');
  }

  const email = typeof auth.token.email === 'string'
    ? auth.token.email.trim().toLowerCase()
    : '';
  if (!email || !(await lookups.isAllowlisted(email))) {
    throw new HttpsError('permission-denied', 'Permission denied.');
  }

  const members = await lookups.getMembers(householdId);
  if (!members?.includes(auth.uid)) {
    throw new HttpsError('permission-denied', 'Permission denied.');
  }

  return { uid: auth.uid, email };
}
