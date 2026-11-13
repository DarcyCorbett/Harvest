import fs from 'node:fs';
import path from 'node:path';
import { applicationDefault, initializeApp } from 'firebase-admin/app';
import { FieldPath, getFirestore } from 'firebase-admin/firestore';

// Read only public recipe content; never fetch household or prior prediction data.
const dir = path.resolve('artifacts/ai-stack-evaluation');
fs.mkdirSync(dir, { recursive: true });
initializeApp({ credential: applicationDefault(), projectId: 'meal-wizard-ad202' });
const db = getFirestore();
const pool = [];
let last;
for (let page = 0; page < 8; page++) {
  let query = db.collection('recipes').orderBy(FieldPath.documentId()).limit(500)
    .select('schemaVersion', 'status', 'source', 'content', 'sourceMetadata');
  if (last) query = query.startAfter(last);
  const snap = await query.get();
  for (const doc of snap.docs) {
    const d = doc.data();
    if (d.schemaVersion === 2 && d.status === 'ready' && d.content?.ingredients?.length && d.content?.instructions?.length)
      pool.push({ id: doc.id, source: { key: d.source.key, canonicalUrl: d.source.canonicalUrl }, content: d.content, sourceMetadata: d.sourceMetadata ?? {} });
  }
  console.log(JSON.stringify({ page: page + 1, recipes: pool.length }));
  if (snap.size < 500) break;
  last = snap.docs.at(-1).id;
}
fs.writeFileSync(path.join(dir, 'source-pool.json'), JSON.stringify(pool));
console.log(JSON.stringify({ saved: pool.length }));
