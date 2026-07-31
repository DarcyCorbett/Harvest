import { SOURCE_CONFIGS, WORDPRESS_SOURCE_KEYS } from './sourceAdapters.js';

export interface IngestionArguments {
  mode?: IngestionMode;
  sourceKeys?: string[];
  dryRun?: boolean;
  forceRefresh?: boolean;
  writeCap?: number;
  maxPerSource?: number;
  targetUrls?: Record<string, string[]>;
  runId?: string;
  geminiCallCap?: number;
  confirmPaidBatch?: boolean;
}

export const INGESTION_MODES = [
  'classify-backfill',
  'refresh-canary',
  'refresh-backfill',
  'verify-backfill',
  'retry-failed',
  'crawl-canary',
  'crawl-inventory',
  'crawl-backfill',
  'snapshot-inventory',
  'snapshot-canary',
  'snapshot-crawl',
  'snapshot-verify',
  'tag-batch-prepare',
  'tag-batch-submit',
  'tag-batch-collect',
  'weekly-new',
] as const;

export type SanitizedIngestionFailureReason =
  | 'lease-lost'
  | 'resource-exhausted'
  | 'unavailable'
  | 'deadline-exceeded'
  | 'aborted'
  | 'internal'
  | 'unexpected';

const FAILURE_STAGES = new Set([
  'budget-reserve',
  'lease-acquire',
  'lease-renew',
  'lease-release',
  'manifest-load',
  'manifest-save',
  'recipe-recover',
  'recipe-write-complete',
  'recipe-write-operational',
  'run-checkpoint',
  'run-summarize',
  'generation-mode-read',
  'generation-mode-check',
]);

export function sanitizedIngestionFailureStage(error: unknown): string {
  const stage = error && typeof error === 'object'
    ? (error as { stage?: unknown }).stage
    : undefined;
  return typeof stage === 'string' && FAILURE_STAGES.has(stage) ? stage : 'unexpected';
}

export function sanitizedIngestionFailureReason(
  error: unknown,
): SanitizedIngestionFailureReason {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const value = current && typeof current === 'object'
      ? current as { code?: unknown; message?: unknown; cause?: unknown }
      : {};
    const code = typeof value.code === 'string' || typeof value.code === 'number'
      ? String(value.code).toLowerCase()
      : '';
    const message = typeof value.message === 'string' ? value.message.toLowerCase() : '';
    if (message.includes('catalogue ingestion lease was lost')) return 'lease-lost';
    if (code === '8' || code.includes('resource-exhausted')) return 'resource-exhausted';
    if (code === '14' || code.includes('unavailable')) return 'unavailable';
    if (code === '4' || code.includes('deadline-exceeded')) return 'deadline-exceeded';
    if (code === '10' || code.includes('aborted')) return 'aborted';
    if (code === '13' || code.includes('internal')) return 'internal';
    current = value.cause;
  }
  return 'unexpected';
}

export type IngestionMode = typeof INGESTION_MODES[number];

function invalid(): never {
  throw new Error('Invalid ingestion arguments');
}

export function parseIngestionArguments(args: string[]): IngestionArguments {
  const result: IngestionArguments = {};
  const allowedSources = new Set(SOURCE_CONFIGS.map((source) => source.sourceKey));
  let index = 0;
  if (args[0] && !args[0].startsWith('--')) {
    if (!INGESTION_MODES.includes(args[0] as IngestionMode)) invalid();
    result.mode = args[0] as IngestionMode;
    index = 1;
  }

  for (; index < args.length; index += 1) {
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
    if (argument === '--confirm-paid-batch') {
      if (result.confirmPaidBatch) invalid();
      result.confirmPaidBatch = true;
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
    if (argument === '--gemini-call-cap') {
      if (result.geminiCallCap !== undefined || index + 1 >= args.length) invalid();
      const value = Number(args[++index]);
      if (!Number.isInteger(value) || value < 0 || value > 500) invalid();
      result.geminiCallCap = value;
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

  if (result.mode?.startsWith('crawl-')) {
    const wordpressSources = new Set<string>(WORDPRESS_SOURCE_KEYS);
    if (result.sourceKeys?.some((sourceKey) => !wordpressSources.has(sourceKey))) invalid();
    if (result.geminiCallCap !== undefined
      || result.forceRefresh
      || result.targetUrls
      || result.dryRun) {
      invalid();
    }
    if (result.mode !== 'crawl-backfill'
      && (result.writeCap !== undefined || result.maxPerSource !== undefined)) {
      invalid();
    }
  }
  if (result.mode?.startsWith('snapshot-')) {
    if (result.forceRefresh || result.targetUrls || result.geminiCallCap !== undefined
      || result.confirmPaidBatch) invalid();
    if (result.mode !== 'snapshot-crawl'
      && (result.writeCap !== undefined || result.maxPerSource !== undefined)) invalid();
    if ((result.mode === 'snapshot-inventory' || result.mode === 'snapshot-verify')
      && result.sourceKeys) invalid();
  }
  if (result.mode?.startsWith('tag-batch-')) {
    if (result.sourceKeys || result.dryRun || result.forceRefresh || result.writeCap !== undefined
      || result.maxPerSource !== undefined || result.targetUrls
      || result.geminiCallCap !== undefined) invalid();
    if (result.mode === 'tag-batch-submit' && !result.confirmPaidBatch) invalid();
    if (result.mode !== 'tag-batch-submit' && result.confirmPaidBatch) invalid();
  }
  if (result.mode === 'weekly-new') {
    if (result.forceRefresh || result.targetUrls || result.confirmPaidBatch
      || result.dryRun) invalid();
    if (result.writeCap !== undefined && result.writeCap > 17_500) invalid();
  }

  return result;
}
