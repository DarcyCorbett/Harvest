// Exercise deployed callables using a disposable account; no email is sent.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

initializeApp({ credential: cert(JSON.parse(readFileSync(new URL('../service-account.json', import.meta.url), 'utf8'))) });
const apiKey = JSON.parse(readFileSync(new URL('../eas.json', import.meta.url), 'utf8')).build.production.env.EXPO_PUBLIC_FIREBASE_API_KEY;
const uid = `invite-check-${randomUUID()}`;
const email = `${uid}@example.com`;
const recipient = `${uid}-guest@example.com`;
const auth = getAuth();
const db = getFirestore();
const refs = [db.doc(`allowlist/${email}`), db.doc(`appAdmins/${uid}`), db.doc(`allowlist/${recipient}`), db.doc(`appInvitations/${recipient}`)];
let created = false;
let idToken;
async function call(name, data = {}) {
  const response = await fetch(`https://europe-west1-meal-wizard-ad202.cloudfunctions.net/${name}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` }, body: JSON.stringify({ data }),
  });
  const body = await response.json();
  return { status: response.status, result: body.result, error: body.error?.status };
}
function check(condition, label) { if (!condition) throw new Error(label); }
try {
  await auth.createUser({ uid, email, emailVerified: true }); created = true;
  await refs[0].create({ enabled: true });
  const token = await auth.createCustomToken(uid);
  const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${apiKey}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, returnSecureToken: true }),
  });
  const session = await response.json();
  check(response.ok && session.idToken, 'Disposable sign-in failed'); idToken = session.idToken;
  check((await call('getAppInvitePermissions')).result?.canInvite === false, 'Regular user permissions failed');
  check((await call('inviteAppUser', { email: recipient })).error === 'PERMISSION_DENIED', 'Regular user invite was not rejected');
  await refs[1].create({ enabled: true, canInvite: true });
  check((await call('getAppInvitePermissions')).result?.canInvite === true, 'Admin permissions failed');
  const first = await call('inviteAppUser', { email: ` ${recipient.toUpperCase()} ` });
  check(first.result?.email === recipient && first.result?.alreadyAllowed === false && first.result?.downloadUrl?.startsWith('https://storage.googleapis.com/meal-wizard-ad202-app-downloads/'), 'First invitation failed');
  check((await refs[2].get()).exists, 'Recipient was not allowlisted');
  await refs[2].update({ verificationMarker: uid });
  check((await call('inviteAppUser', { email: recipient })).result?.alreadyAllowed === true, 'Duplicate invitation failed');
  check((await refs[2].get()).get('verificationMarker') === uid, 'Existing allowlist record was overwritten');
  await refs[1].update({ canInvite: false });
  check((await call('inviteAppUser', { email: recipient })).error === 'PERMISSION_DENIED', 'Revoked invite permission was not enforced');
  console.log(JSON.stringify({ regularUserDenied: true, adminInviteSucceeded: true, recipientNormalized: true, duplicatePreserved: true, revocationEnforced: true }));
} finally {
  const batch = db.batch(); refs.forEach(ref => batch.delete(ref)); await batch.commit();
  if (created) await auth.deleteUser(uid);
  check((await Promise.all(refs.map(ref => ref.get()))).every(snapshot => !snapshot.exists), 'Test data cleanup failed');
  console.log(JSON.stringify({ testDocumentsRemoved: true, testAccountRemoved: created }));
}
