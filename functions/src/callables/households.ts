import { randomBytes } from 'node:crypto';

import { FieldValue, getFirestore, type Firestore } from 'firebase-admin/firestore';
import { HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { z } from 'zod';

import type { AuthorizedIdentity } from '../authz.js';

const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const INVITE_PATTERN = new RegExp(`^[${INVITE_ALPHABET}]{6,20}$`);

const createRequest = z.object({}).strict();
const inviteRequest = z.object({
  inviteCode: z.string().min(1).max(64),
}).strict();

export interface HouseholdMutations {
  create(uid: string, email: string): Promise<{
    householdId: string;
    inviteCode: string;
  }>;
  join(uid: string, email: string, inviteCode: string): Promise<string | null>;
}

export type AtomicCreateResult = {
  status: 'created' | 'existing';
  householdId: string;
  inviteCode: string;
} | {
  status: 'collision';
};

export interface HouseholdMutationStore {
  findExactInvite(inviteCode: string): Promise<string[]>;
  createAtomic(
    uid: string,
    email: string,
    inviteCode: string,
  ): Promise<AtomicCreateResult>;
  joinAtomic(
    uid: string,
    email: string,
    inviteCode: string,
    householdId: string,
  ): Promise<boolean>;
}

type Authorize = (
  auth: CallableRequest<unknown>['auth'],
) => Promise<AuthorizedIdentity>;

export function normalizeInviteCode(value: string): string | null {
  const normalized = value.trim().toUpperCase();
  return INVITE_PATTERN.test(normalized) ? normalized : null;
}

export function createHouseholdMutations(
  store: HouseholdMutationStore,
  generateInviteCode: () => string,
  maxCreateAttempts = 5,
): HouseholdMutations {
  return {
    async create(uid, email) {
      for (let attempt = 0; attempt < maxCreateAttempts; attempt += 1) {
        const inviteCode = normalizeInviteCode(generateInviteCode());
        if (!inviteCode) continue;

        const existing = await store.findExactInvite(inviteCode);
        if (existing.length > 0) continue;

        const result = await store.createAtomic(uid, email, inviteCode);
        if (result.status !== 'collision') {
          return {
            householdId: result.householdId,
            inviteCode: result.inviteCode,
          };
        }
      }

      throw new HttpsError('internal', 'Household creation failed.');
    },

    async join(uid, email, inviteCode) {
      const matches = await store.findExactInvite(inviteCode);
      if (matches.length !== 1) return null;

      const joined = await store.joinAtomic(
        uid,
        email,
        inviteCode,
        matches[0],
      );
      return joined ? matches[0] : null;
    },
  };
}

function storageFailure(): HttpsError {
  return new HttpsError('failed-precondition', 'Household state is invalid.');
}

export function createFirestoreHouseholdStore(
  db: Firestore = getFirestore(),
): HouseholdMutationStore {
  return {
    async findExactInvite(inviteCode) {
      const reservation = await db
        .collection('householdInvites')
        .doc(inviteCode)
        .get();
      if (reservation.exists) {
        const householdId: unknown = reservation.get('householdId');
        return typeof householdId === 'string' && householdId.length > 0
          ? [householdId]
          : [];
      }

      const matches = await db
        .collection('households')
        .where('inviteCode', '==', inviteCode)
        .limit(2)
        .get();
      return matches.docs.map((snapshot) => snapshot.id);
    },

    async createAtomic(uid, email, inviteCode) {
      const householdRef = db.collection('households').doc();
      const inviteRef = db.collection('householdInvites').doc(inviteCode);
      const userRef = db.collection('users').doc(uid);

      return db.runTransaction(async (transaction) => {
        const userSnapshot = await transaction.get(userRef);
        if (userSnapshot.exists) {
          const householdId: unknown = userSnapshot.get('householdId');
          const profileEmail: unknown = userSnapshot.get('email');
          if (
            typeof householdId !== 'string'
            || householdId.length === 0
            || typeof profileEmail !== 'string'
            || profileEmail.trim().toLowerCase() !== email
          ) {
            throw storageFailure();
          }

          const existingHousehold = await transaction.get(
            db.collection('households').doc(householdId),
          );
          const members: unknown = existingHousehold.exists
            ? existingHousehold.get('members')
            : undefined;
          const existingInvite: unknown = existingHousehold.exists
            ? existingHousehold.get('inviteCode')
            : undefined;
          if (
            !existingHousehold.exists
            || !Array.isArray(members)
            || !members.every((member) => typeof member === 'string')
            || !members.includes(uid)
            || typeof existingInvite !== 'string'
            || normalizeInviteCode(existingInvite) !== existingInvite
          ) {
            throw storageFailure();
          }

          return {
            status: 'existing' as const,
            householdId,
            inviteCode: existingInvite,
          };
        }

        const reservation = await transaction.get(inviteRef);
        if (reservation.exists) return { status: 'collision' as const };

        transaction.create(householdRef, {
          members: [uid],
          inviteCode,
        });
        transaction.create(inviteRef, { householdId: householdRef.id });
        transaction.create(userRef, {
          email,
          householdId: householdRef.id,
        });
        return {
          status: 'created' as const,
          householdId: householdRef.id,
          inviteCode,
        };
      });
    },

    async joinAtomic(uid, email, inviteCode, householdId) {
      const householdRef = db.collection('households').doc(householdId);
      const inviteRef = db.collection('householdInvites').doc(inviteCode);
      const userRef = db.collection('users').doc(uid);

      return db.runTransaction(async (transaction) => {
        const household = await transaction.get(householdRef);
        const reservation = await transaction.get(inviteRef);
        const storedInvite: unknown = household.exists
          ? household.get('inviteCode')
          : undefined;
        const members: unknown = household.exists
          ? household.get('members')
          : undefined;
        if (
          !household.exists
          || storedInvite !== inviteCode
          || !Array.isArray(members)
          || !members.every((member) => typeof member === 'string')
        ) {
          return false;
        }

        if (reservation.exists) {
          const reservedHousehold: unknown = reservation.get('householdId');
          if (reservedHousehold !== householdId) return false;
        } else {
          transaction.create(inviteRef, { householdId });
        }

        transaction.update(householdRef, {
          members: FieldValue.arrayUnion(uid),
        });
        transaction.set(userRef, { email, householdId }, { merge: true });
        return true;
      });
    },
  };
}

export function generateServerInviteCode(): string {
  const bytes = randomBytes(6);
  let code = '';
  for (const byte of bytes) code += INVITE_ALPHABET[byte % INVITE_ALPHABET.length];
  return code;
}

export function firestoreHouseholdMutations(): HouseholdMutations {
  return createHouseholdMutations(
    createFirestoreHouseholdStore(),
    generateServerInviteCode,
  );
}

function invalidArgument(): HttpsError {
  return new HttpsError('invalid-argument', 'Invalid request.');
}

export function createHouseholdHandlers(dependencies: {
  authorize: Authorize;
  create: HouseholdMutations['create'];
  join: HouseholdMutations['join'];
}) {
  const joinLike = async (request: CallableRequest<unknown>) => {
    const parsed = inviteRequest.safeParse(request.data);
    if (!parsed.success) throw invalidArgument();

    const inviteCode = normalizeInviteCode(parsed.data.inviteCode);
    if (!inviteCode) throw invalidArgument();

    const identity = await dependencies.authorize(request.auth);
    const householdId = await dependencies.join(
      identity.uid,
      identity.email,
      inviteCode,
    );
    if (!householdId) {
      throw new HttpsError('not-found', 'Invalid invite code.');
    }
    return { householdId };
  };

  return {
    async create(request: CallableRequest<unknown>) {
      const parsed = createRequest.safeParse(
        request.data === undefined ? {} : request.data,
      );
      if (!parsed.success) throw invalidArgument();

      const identity = await dependencies.authorize(request.auth);
      return dependencies.create(identity.uid, identity.email);
    },
    join: joinLike,
    switch: joinLike,
  };
}
