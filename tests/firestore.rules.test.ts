import fs from 'node:fs';
import path from 'node:path';
import {
  RulesTestEnvironment,
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';

const PROJECT_ID = 'demo-meal-wizard-rules';

describe('Firestore household security boundary', () => {
  let environment: RulesTestEnvironment;

  beforeAll(async () => {
    environment = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: {
        rules: fs.readFileSync(path.join(process.cwd(), 'firestore.rules'), 'utf8'),
      },
    });
  });

  beforeEach(async () => {
    await environment.clearFirestore();
    await environment.withSecurityRulesDisabled(async (context) => {
      const database = context.firestore();
      await setDoc(doc(database, 'households/household-1'), {
        inviteCode: 'ABC234',
        members: ['member-1'],
      });
      await setDoc(doc(database, 'users/member-1'), {
        email: 'member@example.com',
        currentHouseholdId: 'household-1',
      });
      await setDoc(doc(database, 'householdInvites/ABC234'), {
        householdId: 'household-1',
      });
      await setDoc(doc(database, 'allowlist/member@example.com'), {
        active: true,
      });
    });
  });

  afterAll(async () => {
    await environment.cleanup();
  });

  it('allows a member to read their household and write household content', async () => {
    const database = environment.authenticatedContext('member-1').firestore();

    await assertSucceeds(getDoc(doc(database, 'households/household-1')));
    await assertSucceeds(setDoc(
      doc(database, 'households/household-1/mealPlan/monday'),
      { recipeId: 'recipe-1' },
    ));
  });

  it('rejects household reads by non-members', async () => {
    const database = environment.authenticatedContext('outsider-1').firestore();

    await assertFails(getDoc(doc(database, 'households/household-1')));
  });

  it('rejects all client household list and document mutations', async () => {
    const database = environment.authenticatedContext('member-1').firestore();

    await assertFails(getDocs(collection(database, 'households')));
    await assertFails(setDoc(doc(database, 'households/household-2'), {
      inviteCode: 'XYZ234',
      members: ['member-1'],
    }));
    await assertFails(updateDoc(doc(database, 'households/household-1'), {
      members: ['member-1', 'outsider-1'],
    }));
    await assertFails(deleteDoc(doc(database, 'households/household-1')));
  });

  it('allows an owner to get their profile but rejects all client profile writes', async () => {
    const ownerDatabase = environment.authenticatedContext('member-1').firestore();
    const outsiderDatabase = environment.authenticatedContext('outsider-1').firestore();

    await assertSucceeds(getDoc(doc(ownerDatabase, 'users/member-1')));
    await assertFails(getDoc(doc(outsiderDatabase, 'users/member-1')));
    await assertFails(setDoc(doc(ownerDatabase, 'users/member-1'), {
      email: 'attacker@example.com',
      currentHouseholdId: 'household-2',
    }));
    await assertFails(deleteDoc(doc(ownerDatabase, 'users/member-1')));
  });

  it('keeps invite reservations private and server-only', async () => {
    const database = environment.authenticatedContext('member-1').firestore();

    await assertFails(getDoc(doc(database, 'householdInvites/ABC234')));
    await assertFails(getDocs(collection(database, 'householdInvites')));
    await assertFails(setDoc(doc(database, 'householdInvites/XYZ234'), {
      householdId: 'household-2',
    }));
  });

  it('allows exact allowlist checks but prevents enumeration and writes', async () => {
    const anonymousDatabase = environment.unauthenticatedContext().firestore();

    await assertSucceeds(getDoc(doc(anonymousDatabase, 'allowlist/member@example.com')));
    await assertFails(getDocs(collection(anonymousDatabase, 'allowlist')));
    await assertFails(setDoc(doc(anonymousDatabase, 'allowlist/new@example.com'), {
      active: true,
    }));
  });
});
