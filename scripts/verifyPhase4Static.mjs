import { readFile } from 'node:fs/promises';

const phase4Files = [
  'functions/src/catalogue/backfill.ts',
  'functions/src/catalogue/backfillFirestore.ts',
  'functions/src/catalogue/ingestionCli.ts',
  'scripts/run-phase4-backfill.ps1',
  'scripts/deploy-phase4-backfill.ps1',
];
const [backfillCore, ...otherSources] = await Promise.all(
  phase4Files.map((path) => readFile(path, 'utf8')),
);
const combined = [backfillCore, ...otherSources].join('\n');

if (/\bfetch\s*\(/.test(backfillCore)) {
  throw new Error('Stored-content classification must not fetch recipe sites');
}
if (/scheduler jobs (resume|run)/i.test(combined)) {
  throw new Error('Phase 4 must not enable or invoke Scheduler');
}
if (/generationMode[^\n]+catalogue/i.test(combined)) {
  throw new Error('Phase 4 must not enable catalogue generation');
}
if (/collection\(['"]recipes['"]\)[\s\S]{0,100}\.delete\s*\(/.test(combined)) {
  throw new Error('Phase 4 must not delete recipe documents');
}
if (!/ValidateRange\(0, 500\)/.test(otherSources.join('\n'))
  || !/geminiCallCap[^]*MAX_GEMINI_CALL_CAP/.test(backfillCore)) {
  throw new Error('Phase 4 Gemini calls must remain capped at 500');
}
if (!/WriteCap = 8000/.test(otherSources.join('\n'))
  || !/MAX_PHASE4_WRITE_CAP = 18_000/.test(backfillCore)) {
  throw new Error('Phase 4 write caps do not match the approved limits');
}

console.log('Phase 4 static safety checks passed.');
