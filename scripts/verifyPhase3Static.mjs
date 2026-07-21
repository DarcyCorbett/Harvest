import { readFile } from 'node:fs/promises';

const migrationFiles = [
  'functions/src/catalogue/migration.ts',
  'functions/src/catalogue/migrationEngine.ts',
  'functions/src/catalogue/migrationFirestore.ts',
  'functions/src/catalogue/migrationReferences.ts',
  'functions/src/catalogue/migrationCli.ts',
];
const migrationSource = (await Promise.all(migrationFiles.map((path) => readFile(path, 'utf8')))).join('\n');
const operatorScripts = await Promise.all([
  'scripts/deploy-phase3-migration.ps1',
  'scripts/run-phase3-migration.ps1',
].map((path) => readFile(path, 'utf8')));

const forbidden = [
  [/gemini/i, 'Phase 3 migration must not invoke Gemini'],
  [/\bfetch\s*\(/, 'Phase 3 migration must not fetch recipe sites'],
  [/collection\(['"]recipes['"]\)[\s\S]{0,100}\.delete\s*\(/, 'Phase 3 must not delete recipe documents'],
];
for (const [pattern, message] of forbidden) {
  if (pattern.test(migrationSource)) throw new Error(message);
}
for (const script of operatorScripts) {
  if (/scheduler jobs (resume|run)/i.test(script)) throw new Error('Phase 3 must not enable or invoke Scheduler');
  if (/generationMode[^\n]+catalogue/i.test(script)) throw new Error('Phase 3 must not enable catalogue generation');
}
console.log('Phase 3 static safety checks passed.');
