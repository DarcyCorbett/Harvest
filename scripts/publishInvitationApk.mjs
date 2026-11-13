// Preserve an approved EAS APK in a dedicated project bucket, then configure invites.
// Usage: node scripts/publishInvitationApk.mjs <EAS artifact URL> <versionCode>
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { initializeApp, cert } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

const source = new URL(process.argv[2]);
const version = process.argv[3];
const trustedSource = source.hostname === 'artifacts.eascdn.net'
  || (source.hostname === 'expo.dev' && source.pathname.startsWith('/artifacts/eas/'));
if (source.protocol !== 'https:' || !trustedSource || !source.pathname.endsWith('.apk')) {
  throw new Error('Expected an EAS APK artifact URL.');
}
if (!/^\d+$/.test(version ?? '')) throw new Error('Expected Android version code.');
const response = await fetch(source);
if (!response.ok) throw new Error(`APK download failed: ${response.status}`);
const data = Buffer.from(await response.arrayBuffer());
if (data.length < 1_000_000 || data.subarray(0, 2).toString() !== 'PK') throw new Error('Invalid APK archive.');
const sha256 = createHash('sha256').update(data).digest('hex');
initializeApp({ credential: cert(JSON.parse(readFileSync(new URL('../service-account.json', import.meta.url), 'utf8'))) });
const bucket = getStorage().bucket('meal-wizard-ad202-app-downloads');
const [bucketExists] = await bucket.exists();
if (!bucketExists) await bucket.create({ location: 'europe-west1', iamConfiguration: { uniformBucketLevelAccess: { enabled: false } } });
const object = `app-releases/harvest-${version}-${sha256.slice(0, 12)}.apk`;
const file = bucket.file(object);
const [exists] = await file.exists();
if (!exists) await file.save(data, {
  resumable: false,
  preconditionOpts: { ifGenerationMatch: 0 },
  metadata: {
    contentType: 'application/vnd.android.package-archive',
    contentDisposition: `attachment; filename="Harvest-${version}.apk"`,
    cacheControl: 'public, max-age=31536000, immutable',
    metadata: { sha256, versionCode: version },
  },
});
const [metadata] = await file.getMetadata();
if (metadata.metadata?.sha256 !== sha256) throw new Error('Stored APK metadata mismatch.');
// Publish this APK only. Bucket listing and other objects remain private.
await file.makePublic();
const downloadUrl = `https://storage.googleapis.com/${bucket.name}/${object}`;
const probe = await fetch(downloadUrl, { headers: { Range: 'bytes=0-3' } });
if (probe.status !== 206 || !(probe.headers.get('content-type') ?? '').includes('android.package-archive')) {
  await probe.body?.cancel();
  throw new Error(`Public download verification failed: ${probe.status}`);
}
const magic = Buffer.from(await probe.arrayBuffer());
if (magic.subarray(0, 2).toString() !== 'PK') throw new Error('Public APK verification failed.');
await getFirestore().collection('appDistribution').doc('current').set({
  downloadUrl, versionCode: version, sha256, updatedAt: FieldValue.serverTimestamp(),
}, { merge: true });
const configured = await getFirestore().collection('appDistribution').doc('current').get();
if (configured.get('downloadUrl') !== downloadUrl) throw new Error('Distribution verification failed.');
console.log(JSON.stringify({ versionCode: version, bytes: data.length, sha256, downloadUrl, configured: true }));
