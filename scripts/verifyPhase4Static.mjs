import { readFile } from 'node:fs/promises';

const phase4Files = [
  'functions/src/catalogue/backfill.ts',
  'functions/src/catalogue/backfillFirestore.ts',
  'functions/src/catalogue/ingestionCli.ts',
  'functions/src/catalogue/sourceAdapters.ts',
  'scripts/run-phase4-backfill.ps1',
  'scripts/run-wordpress-crawl.ps1',
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
if (/setCatalogueGenerationMode|generationMode\s*:\s*['"]catalogue['"]/i.test(combined)) {
  throw new Error('Phase 4 must not change catalogue generation mode');
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
const ingestionCli = await readFile('functions/src/catalogue/ingestionCli.ts', 'utf8');
const crawlRunner = await readFile('scripts/run-wordpress-crawl.ps1', 'utf8');
if (!/command\.mode === 'crawl-backfill'[\s\S]*classifyCatalogueDeterministically/.test(ingestionCli)
  || /gemini/i.test(crawlRunner)) {
  throw new Error('WordPress crawl must use deterministic classification without Gemini');
}
if (!/ValidateRange\(0, 18000\)\]\[int\]\$WriteCap = 18000/.test(crawlRunner)) {
  throw new Error('WordPress crawl must retain the 18,000-write daily ceiling');
}

console.log('Phase 4 static safety checks passed.');
