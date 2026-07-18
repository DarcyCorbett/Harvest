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

export interface CatalogueEditorLookups {
  isEnabledEditor(uid: string): Promise<boolean>;
}

export function firestoreCatalogueEditorLookups(): CatalogueEditorLookups {
  const db = getFirestore();
  return {
    async isEnabledEditor(uid) {
      const snapshot = await db.collection('catalogueEditors').doc(uid).get();
      return snapshot.exists && snapshot.get('enabled') === true;
    },
  };
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
  const identity = await authorizeAllowlistedUser(auth, lookups);

  const members = await lookups.getMembers(householdId);
  if (!members?.includes(identity.uid)) {
    throw new HttpsError('permission-denied', 'Permission denied.');
  }

  return identity;
}

export async function authorizeAllowlistedUser(
  auth: AuthData,
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

  return { uid: auth.uid, email };
}

export async function authorizeCatalogueEditor(
  auth: AuthData,
  authz: AuthzLookups = firestoreAuthzLookups(),
  editors: CatalogueEditorLookups = firestoreCatalogueEditorLookups(),
): Promise<AuthorizedIdentity> {
  const identity = await authorizeAllowlistedUser(auth, authz);
  if (!(await editors.isEnabledEditor(identity.uid))) {
    throw new HttpsError('permission-denied', 'Permission denied.');
  }
  return identity;
}
