import { applicationDefault, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const projectId = argument('--project');
const requestedMode = argument('--mode');
if (!projectId || !/^[a-z][a-z0-9-]{4,29}$/.test(projectId)) {
  throw new Error('Invalid or missing --project');
}
if (requestedMode !== 'legacy' && requestedMode !== 'catalogue') {
  throw new Error('Mode must be legacy or catalogue');
}

initializeApp({ credential: applicationDefault(), projectId });
const reference = getFirestore().collection('appConfig').doc('catalogue');
const snapshot = await reference.get();
const previousMode = snapshot.exists ? snapshot.get('generationMode') : undefined;
if (previousMode !== 'legacy' && previousMode !== 'catalogue') {
  throw new Error('Existing catalogue generation mode is invalid');
}
await reference.set({
  schemaVersion: 1,
  generationMode: requestedMode,
}, { merge: true });
console.log(JSON.stringify({ previousMode, generationMode: requestedMode }));
