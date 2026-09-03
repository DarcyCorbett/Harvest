import { SOURCE_CONFIGS } from './sourceAdapters.js';

export interface UnitBackfillArguments {
  apply: boolean;
  runId: string;
  writeCap: number;
  pageSize: number;
  sourceKeys?: string[];
  startAfter?: string;
}

function invalid(): never {
  throw new Error('Invalid unit backfill arguments');
}

export function parseUnitBackfillArguments(args: readonly string[]): UnitBackfillArguments {
  let apply = false;
  let runId = 'dry-run';
  let writeCap = 1_000;
  let pageSize = 250;
  let sourceKeys: string[] | undefined;
  let startAfter: string | undefined;
  const allowedSources = new Set(SOURCE_CONFIGS.map(({ sourceKey }) => sourceKey));

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--apply') {
      if (apply) invalid();
      apply = true;
      continue;
    }
    if (argument === '--run-id') {
      if (index + 1 >= args.length || runId !== 'dry-run') invalid();
      runId = args[++index];
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(runId)) invalid();
      continue;
    }
    if (argument === '--write-cap') {
      if (index + 1 >= args.length) invalid();
      writeCap = Number(args[++index]);
      if (!Number.isInteger(writeCap) || writeCap < 0 || writeCap > 18_000) invalid();
      continue;
    }
    if (argument === '--page-size') {
      if (index + 1 >= args.length) invalid();
      pageSize = Number(args[++index]);
      if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) invalid();
      continue;
    }
    if (argument === '--source') {
      if (index + 1 >= args.length || sourceKeys) invalid();
      sourceKeys = [...new Set(args[++index].split(',').map((value) => value.trim()).filter(Boolean))];
      if (!sourceKeys.length || sourceKeys.some((value) => !allowedSources.has(value))) invalid();
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
  if (apply && runId === 'dry-run') invalid();
  return {
    apply,
    runId,
    writeCap,
    pageSize,
    ...(sourceKeys ? { sourceKeys } : {}),
    ...(startAfter ? { startAfter } : {}),
  };
}

