import { applicationDefault, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const projectId = argument('--project');
if (!projectId || !/^[a-z][a-z0-9-]{4,29}$/.test(projectId)) {
  throw new Error('Invalid or missing --project');
}

initializeApp({ credential: applicationDefault(), projectId });
const configSnapshot = await getFirestore().collection('appConfig').doc('catalogue').get();
if (!configSnapshot.exists) throw new Error('Catalogue configuration evidence is missing');

const generationMode = configSnapshot.get('generationMode');
if (generationMode !== 'legacy') {
  throw new Error(`generationMode must remain legacy; observed ${String(generationMode)}`);
}

console.log(generationMode);
