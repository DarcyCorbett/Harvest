// Uses the project's existing Admin SDK credential; never prints credentials.
// Usage: node scripts/configureAppInvites.mjs [https://download-url]
import { readFileSync } from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

const ownerEmail = 'darcy.r.corbett@gmail.com';
const downloadUrl = process.argv[2];
if (downloadUrl && (new URL(downloadUrl).protocol !== 'https:')) throw new Error('Download URL must use HTTPS.');
initializeApp({ credential: cert(JSON.parse(readFileSync(new URL('../service-account.json', import.meta.url), 'utf8'))) });
const owner = await getAuth().getUserByEmail(ownerEmail);
if (!owner.emailVerified || owner.disabled) throw new Error('The owner must have an enabled, verified account.');
const db = getFirestore();
await db.runTransaction(async transaction => {
  const allowed = db.collection('allowlist').doc(ownerEmail);
  const current = await transaction.get(allowed);
  transaction.set(db.collection('appAdmins').doc(owner.uid), {
    enabled: true, canInvite: true, updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  if (!current.exists) transaction.create(allowed, { enabled: true });
  if (downloadUrl) transaction.set(db.collection('appDistribution').doc('current'), {
    downloadUrl, updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
});
const role = await db.collection('appAdmins').doc(owner.uid).get();
console.log(JSON.stringify({ email: ownerEmail, admin: role.get('enabled'), canInvite: role.get('canInvite'), distributionConfigured: Boolean(downloadUrl) }));
