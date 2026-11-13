import { FROZEN_CATALOGUE_SOURCE_KEYS, SOURCE_CONFIGS } from './sourceAdapters.js';

export interface ContentEnrichmentArguments {
  mode: 'audit' | 'recover-legacy' | 'repair-run' | 'verify-run';
  dryRun: boolean;
  runId: string;
  writeCap: number;
  maxPerSource: number;
  pageSize: number;
  sourceKeys?: string[];
  startAfter?: string;
}

function invalid(): never { throw new Error('Invalid content enrichment arguments'); }

export function parseContentEnrichmentArguments(args: readonly string[]): ContentEnrichmentArguments {
  const mode = args[0] as ContentEnrichmentArguments['mode'];
  if (!['audit', 'recover-legacy', 'repair-run', 'verify-run'].includes(mode)) invalid();
  let dryRun = true;
  let runId = 'dry-run';
  let writeCap = 1_000;
  let maxPerSource = 10_000;
  let pageSize = 100;
  let sourceKeys: string[] | undefined;
  let startAfter: string | undefined;
  const allowed = new Set([
    ...SOURCE_CONFIGS.map(({ sourceKey }) => sourceKey),
    ...FROZEN_CATALOGUE_SOURCE_KEYS,
  ]);
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--dry-run') {
      if (dryRun !== true) invalid();
      continue;
    }
    if (argument === '--apply') { if (!dryRun) invalid(); dryRun = false; continue; }
    if (argument === '--run-id') {
      if (index + 1 >= args.length || runId !== 'dry-run') invalid();
      runId = args[++index];
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(runId)) invalid();
      continue;
    }
    if (argument === '--write-cap') {
      writeCap = Number(args[++index]);
      if (!Number.isInteger(writeCap) || writeCap < 0 || writeCap > 18_000) invalid();
      continue;
    }
    if (argument === '--max-per-source') {
      maxPerSource = Number(args[++index]);
      if (!Number.isInteger(maxPerSource) || maxPerSource < 1 || maxPerSource > 10_000) invalid();
      continue;
    }
    if (argument === '--page-size') {
      pageSize = Number(args[++index]);
      if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 250) invalid();
      continue;
    }
    if (argument === '--source') {
      if (index + 1 >= args.length || sourceKeys) invalid();
      sourceKeys = [...new Set(args[++index].split(',').map((value) => value.trim()).filter(Boolean))];
      if (!sourceKeys.length || sourceKeys.some((value) => !allowed.has(value))) invalid();
      continue;
    }
    if (argument === '--after') {
      if (index + 1 >= args.length || startAfter) invalid();
      startAfter = args[++index];
      if (!startAfter || startAfter.length > 160) invalid();
      continue;
    }
    invalid();
  }
  if (!dryRun && runId === 'dry-run') invalid();
  if (mode === 'audit' && (!dryRun || startAfter)) invalid();
  if (mode === 'repair-run' && (dryRun || runId === 'dry-run' || sourceKeys || startAfter)) invalid();
  if (mode === 'verify-run' && (!dryRun || runId === 'dry-run' || sourceKeys || startAfter)) invalid();
  return {
    mode, dryRun, runId, writeCap, maxPerSource, pageSize,
    ...(sourceKeys ? { sourceKeys } : {}),
    ...(startAfter ? { startAfter } : {}),
  };
}
