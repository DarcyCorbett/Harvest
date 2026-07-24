import { applicationDefault, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const projectIndex = process.argv.indexOf('--project');
const projectId = projectIndex >= 0 ? process.argv[projectIndex + 1] : undefined;
if (!projectId || !/^[a-z][a-z0-9-]{4,29}$/.test(projectId)) {
  throw new Error('Invalid or missing --project');
}

initializeApp({ credential: applicationDefault(), projectId });
const snapshot = await getFirestore().collection('appConfig').doc('catalogue').get();
const mode = snapshot.exists ? snapshot.get('generationMode') : undefined;
if (mode !== 'legacy' && mode !== 'catalogue') {
  throw new Error('Catalogue generation mode is invalid');
}
console.log(mode);
