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
const HOUSEHOLD_SUBCOLLECTIONS = [
  'mealPlan',
  'shoppingList',
  'cookbook',
  'settings',
  'generationResult',
  'state',
] as const;

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
      await Promise.all(HOUSEHOLD_SUBCOLLECTIONS.map((subcollection) => setDoc(
        doc(database, `households/household-1/${subcollection}/existing`),
        { value: subcollection },
      )));
      await setDoc(doc(database, 'recipes/recipe-1'), {
        title: 'Soup',
      });
      await setDoc(doc(database, 'recipeIndex/site-1/recipes/recipe-1'), {
        url: 'https://example.com/recipe-1',
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

  it('rejects unauthenticated household document reads', async () => {
    const database = environment.unauthenticatedContext().firestore();

    await assertFails(getDoc(doc(database, 'households/household-1')));
  });

  it.each(HOUSEHOLD_SUBCOLLECTIONS)(
    'allows members to query and fully mutate the %s subcollection',
    async (subcollection) => {
      const database = environment.authenticatedContext('member-1').firestore();
      const existingDocument = doc(
        database,
        `households/household-1/${subcollection}/existing`,
      );

      await assertSucceeds(getDocs(collection(
        database,
        `households/household-1/${subcollection}`,
      )));
      await assertSucceeds(getDoc(existingDocument));
      await assertSucceeds(setDoc(doc(
        database,
        `households/household-1/${subcollection}/new`,
      ), { value: 'member-write' }));
      await assertSucceeds(updateDoc(existingDocument, { value: 'member-update' }));
      await assertSucceeds(deleteDoc(existingDocument));
    },
  );

  it.each(HOUSEHOLD_SUBCOLLECTIONS)(
    'rejects non-member queries and all mutations in the %s subcollection',
    async (subcollection) => {
      const database = environment.authenticatedContext('outsider-1').firestore();
      const existingDocument = doc(
        database,
        `households/household-1/${subcollection}/existing`,
      );

      await assertFails(getDocs(collection(
        database,
        `households/household-1/${subcollection}`,
      )));
      await assertFails(getDoc(existingDocument));
      await assertFails(setDoc(doc(
        database,
        `households/household-1/${subcollection}/new`,
      ), { value: 'outsider-write' }));
      await assertFails(updateDoc(existingDocument, { value: 'outsider-update' }));
      await assertFails(deleteDoc(existingDocument));
    },
  );

  it.each(HOUSEHOLD_SUBCOLLECTIONS)(
    'rejects unauthenticated queries and all mutations in the %s subcollection',
    async (subcollection) => {
      const database = environment.unauthenticatedContext().firestore();
      const existingDocument = doc(
        database,
        `households/household-1/${subcollection}/existing`,
      );

      await assertFails(getDocs(collection(
        database,
        `households/household-1/${subcollection}`,
      )));
      await assertFails(getDoc(existingDocument));
      await assertFails(setDoc(doc(
        database,
        `households/household-1/${subcollection}/new`,
      ), { value: 'anonymous-write' }));
      await assertFails(updateDoc(existingDocument, { value: 'anonymous-update' }));
      await assertFails(deleteDoc(existingDocument));
    },
  );

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

  it('rejects unauthenticated household listing', async () => {
    const database = environment.unauthenticatedContext().firestore();

    await assertFails(getDocs(collection(database, 'households')));
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

  it('allows authenticated recipe reads but rejects all recipe mutations', async () => {
    const database = environment.authenticatedContext('member-1').firestore();

    await assertSucceeds(getDoc(doc(database, 'recipes/recipe-1')));
    await assertSucceeds(getDocs(collection(database, 'recipes')));
    await assertFails(setDoc(doc(database, 'recipes/recipe-2'), { title: 'New' }));
    await assertFails(updateDoc(doc(database, 'recipes/recipe-1'), { title: 'Changed' }));
    await assertFails(deleteDoc(doc(database, 'recipes/recipe-1')));
  });

  it('allows authenticated recipe-index reads but rejects all index mutations', async () => {
    const database = environment.authenticatedContext('member-1').firestore();

    await assertSucceeds(getDoc(doc(database, 'recipeIndex/site-1/recipes/recipe-1')));
    await assertSucceeds(getDocs(collection(database, 'recipeIndex/site-1/recipes')));
    await assertFails(setDoc(
      doc(database, 'recipeIndex/site-1/recipes/recipe-2'),
      { url: 'https://example.com/recipe-2' },
    ));
    await assertFails(updateDoc(
      doc(database, 'recipeIndex/site-1/recipes/recipe-1'),
      { url: 'https://example.com/changed' },
    ));
    await assertFails(deleteDoc(doc(database, 'recipeIndex/site-1/recipes/recipe-1')));
  });

  it('rejects unauthenticated reads of recipes and the recipe index', async () => {
    const database = environment.unauthenticatedContext().firestore();

    await assertFails(getDoc(doc(database, 'recipes/recipe-1')));
    await assertFails(getDocs(collection(database, 'recipes')));
    await assertFails(getDoc(doc(database, 'recipeIndex/site-1/recipes/recipe-1')));
    await assertFails(getDocs(collection(database, 'recipeIndex/site-1/recipes')));
  });
});
