import { applicationDefault, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const projectIndex = process.argv.indexOf('--project');
const projectId = projectIndex >= 0 ? process.argv[projectIndex + 1] : undefined;
if (!projectId || !/^[a-z][a-z0-9-]{4,29}$/.test(projectId)) {
  throw new Error('Usage: node scripts/setCatalogueConfig.mjs --project <project-id>');
}

initializeApp({ credential: applicationDefault(), projectId });
const db = getFirestore();
await Promise.all([
  db.collection('appConfig').doc('catalogue').set({
    schemaVersion: 1,
    generationMode: 'legacy',
    ingestionSchedulerEnabled: false,
  }, { merge: true }),
  db.collection('catalogueOps').doc('config').set({
    scheduledIngestionEnabled: false,
    defaultWriteLimit: 18_000,
    parserVersion: 4,
    taxonomyVersion: 2,
  }, { merge: true }),
]);
console.log('Catalogue configuration is pinned to legacy generation.');
