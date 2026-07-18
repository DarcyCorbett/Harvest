import { SOURCE_CONFIGS } from './sourceAdapters.js';

export interface IngestionArguments {
  sourceKeys?: string[];
  dryRun?: boolean;
  forceRefresh?: boolean;
  writeCap?: number;
  maxPerSource?: number;
  targetUrls?: Record<string, string[]>;
  runId?: string;
}

function invalid(): never {
  throw new Error('Invalid ingestion arguments');
}

export function parseIngestionArguments(args: string[]): IngestionArguments {
  const result: IngestionArguments = {};
  const allowedSources = new Set(SOURCE_CONFIGS.map((source) => source.sourceKey));

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--dry-run') {
      if (result.dryRun) invalid();
      result.dryRun = true;
      continue;
    }
    if (argument === '--force-refresh') {
      if (result.forceRefresh) invalid();
      result.forceRefresh = true;
      continue;
    }
    if (argument === '--source') {
      if (result.sourceKeys || index + 1 >= args.length) invalid();
      const values = args[++index].split(',').map((value) => value.trim()).filter(Boolean);
      if (values.length === 0 || values.some((value) => !allowedSources.has(value))) invalid();
      result.sourceKeys = [...new Set(values)];
      continue;
    }
    if (argument === '--write-cap') {
      if (result.writeCap !== undefined || index + 1 >= args.length) invalid();
      const value = Number(args[++index]);
      if (!Number.isInteger(value) || value < 0 || value > 18_000) invalid();
      result.writeCap = value;
      continue;
    }
    if (argument === '--max-per-source') {
      if (result.maxPerSource !== undefined || index + 1 >= args.length) invalid();
      const value = Number(args[++index]);
      if (!Number.isInteger(value) || value < 1 || value > 10_000) invalid();
      result.maxPerSource = value;
      continue;
    }
    if (argument === '--target') {
      if (index + 1 >= args.length) invalid();
      const values = args[++index].split(',').map((value) => value.trim()).filter(Boolean);
      if (values.length === 0) invalid();
      for (const value of values) {
        const separator = value.indexOf('=');
        if (separator <= 0) invalid();
        const sourceKey = value.slice(0, separator);
        const url = value.slice(separator + 1);
        if (!allowedSources.has(sourceKey)) invalid();
        try {
          if (new URL(url).protocol !== 'https:') invalid();
        } catch {
          invalid();
        }
        result.targetUrls ??= {};
        (result.targetUrls[sourceKey] ??= []).push(url);
      }
      continue;
    }
    if (argument === '--run-id') {
      if (result.runId || index + 1 >= args.length) invalid();
      const value = args[++index];
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) invalid();
      result.runId = value;
      continue;
    }
    invalid();
  }

  return result;
}
