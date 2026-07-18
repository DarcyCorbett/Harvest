import { applicationDefault, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

import { validateCatalogueSmokeEvidence } from './catalogueSmokeValidation.mjs';

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const projectId = argument('--project');
const firstRunId = argument('--first-run');
const secondRunId = argument('--second-run');
if (!projectId || !firstRunId || !secondRunId) {
  throw new Error('Required: --project, --first-run, and --second-run');
}

initializeApp({ credential: applicationDefault(), projectId });
const db = getFirestore();
const [first, second, config] = await Promise.all([
  db.collection('catalogueRuns').doc(firstRunId).get(),
  db.collection('catalogueRuns').doc(secondRunId).get(),
  db.collection('appConfig').doc('catalogue').get(),
]);
if (!first.exists || !second.exists) throw new Error('Smoke run evidence is missing');
validateCatalogueSmokeEvidence({
  first: first.data(),
  second: second.data(),
  generationMode: config.get('generationMode'),
});
console.log(JSON.stringify({
  firstRun: first.data(),
  secondRun: second.data(),
  generationMode: config.get('generationMode'),
}, null, 2));
