const PILOT_SOURCES = ['recipetineats', 'seriouseats'];
const SOURCE_COUNTERS = [
  'discovered',
  'unchanged',
  'fetched',
  'parsed',
  'classified',
  'written',
  'review',
  'retryable',
  'permanentSkipped',
  'failed',
  'recipeReads',
  'documentWrites',
  'estimatedDocumentBytes',
];
const RUN_COUNTERS = [
  'discovered',
  'unchanged',
  'fetched',
  'parsed',
  'classified',
  'written',
  'review',
  'retryable',
  'permanentSkipped',
  'failed',
];
const GEMINI_COUNTERS = [
  'calls',
  'promptTokenCount',
  'candidatesTokenCount',
  'totalTokenCount',
];
const SHA256_DOCUMENT_ID = /^[a-f0-9]{64}$/;
const PROTECTED_ACCESS_REASON = /^unsupported-(401|402|403)$/;

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} evidence is missing`);
  }
  return value;
}

function nonNegative(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }
  return value;
}

function sampleRecipeIds(value, label) {
  if (!Array.isArray(value) || value.length > 20
    || value.some((id) => typeof id !== 'string' || !SHA256_DOCUMENT_ID.test(id))
    || new Set(value).size !== value.length) {
    throw new Error(`${label} sample identifiers are invalid`);
  }
  return value;
}

export function sanitizeCataloguePilotRun(rawRun) {
  const run = object(rawRun, 'catalogue run');
  const metrics = object(run.metrics, 'catalogue run metrics');
  const bySource = object(run.bySource, 'catalogue run bySource');
  const telemetry = object(run.telemetry, 'catalogue run telemetry');
  const gemini = object(telemetry.gemini, 'catalogue run Gemini');

  return {
    status: run.status,
    ...(typeof run.quotaDate === 'string' ? { quotaDate: run.quotaDate } : {}),
    reservedWrites: run.reservedWrites,
    consumedWrites: run.consumedWrites,
    metrics: Object.fromEntries(RUN_COUNTERS.map((counter) => [counter, metrics[counter]])),
    ...(typeof run.startedAt === 'string' ? { startedAt: run.startedAt } : {}),
    ...(typeof run.completedAt === 'string' ? { completedAt: run.completedAt } : {}),
    ...(typeof run.durationMs === 'number' ? { durationMs: run.durationMs } : {}),
    bySource: Object.fromEntries(PILOT_SOURCES.map((sourceKey) => {
      const source = object(bySource[sourceKey], `catalogue run ${sourceKey}`);
      return [sourceKey, {
        ...Object.fromEntries(SOURCE_COUNTERS.map((counter) => [counter, source[counter]])),
        sampleRecipeIds: sampleRecipeIds(source.sampleRecipeIds, `catalogue run ${sourceKey}`),
      }];
    })),
    telemetry: {
      gemini: Object.fromEntries(GEMINI_COUNTERS.map((counter) => [counter, gemini[counter]])),
    },
  };
}

function sourceMetrics(run, sourceKey, label) {
  const bySource = object(run.bySource, `${label} bySource`);
  return object(bySource[sourceKey], `${label} ${sourceKey}`);
}

function validateRunMeasurements(run, label, writeCap) {
  object(run, label);
  if (run.status !== 'complete') throw new Error(`${label} run is not complete`);
  const reservedWrites = nonNegative(run.reservedWrites, `${label} reservedWrites`);
  const consumedWrites = nonNegative(run.consumedWrites, `${label} consumedWrites`);
  if (reservedWrites > writeCap || consumedWrites > writeCap) {
    throw new Error(`${label} run exceeded the ${writeCap}-write cap`);
  }

  const metrics = object(run.metrics, `${label} metrics`);
  for (const counter of RUN_COUNTERS) nonNegative(metrics[counter], `${label} metrics.${counter}`);

  for (const sourceKey of PILOT_SOURCES) {
    const source = sourceMetrics(run, sourceKey, label);
    for (const counter of SOURCE_COUNTERS) {
      nonNegative(source[counter], `${label} ${sourceKey}.${counter}`);
    }
    sampleRecipeIds(source.sampleRecipeIds, `${label} ${sourceKey}`);
  }

  for (const counter of RUN_COUNTERS) {
    const sourceTotal = PILOT_SOURCES.reduce(
      (sum, sourceKey) => sum + sourceMetrics(run, sourceKey, label)[counter],
      0,
    );
    if (metrics[counter] !== sourceTotal) {
      throw new Error(`${label} metrics.${counter} does not match the per-source total`);
    }
  }

  const gemini = object(object(run.telemetry, `${label} telemetry`).gemini, `${label} Gemini`);
  for (const counter of GEMINI_COUNTERS) nonNegative(gemini[counter], `${label} Gemini.${counter}`);
}

function totalDocumentWrites(run) {
  return PILOT_SOURCES.reduce(
    (sum, sourceKey) => sum + nonNegative(
      sourceMetrics(run, sourceKey, 'second').documentWrites,
      `second ${sourceKey}.documentWrites`,
    ),
    0,
  );
}

function validateDiscovery(discovery) {
  for (const sourceKey of PILOT_SOURCES) {
    const source = sourceMetrics(discovery, sourceKey, 'discovery');
    if (source.discovered === 0 && source.failed === 0) {
      throw new Error(`discovery evidence is missing for ${sourceKey}`);
    }
    if (source.fetched !== 0 || source.documentWrites !== 0) {
      throw new Error(`discovery run mutated ${sourceKey}`);
    }
  }
}

function validateFirstRun(first) {
  if (first.metrics.failed !== 0 || first.metrics.retryable !== 0) {
    throw new Error('first pilot run has unbounded failures');
  }
  const recipeTin = sourceMetrics(first, 'recipetineats', 'first');
  if (recipeTin.fetched < 1 || recipeTin.written < 1 || recipeTin.documentWrites < 1) {
    throw new Error('first pilot run did not produce a RecipeTin Eats recipe');
  }
  const seriousEats = sourceMetrics(first, 'seriouseats', 'first');
  if (seriousEats.fetched < 1
    || seriousEats.documentWrites < 1
    || seriousEats.written + seriousEats.permanentSkipped < 1) {
    throw new Error('first pilot run did not resolve Serious Eats safely');
  }
}

function validateSecondRun(second) {
  if (second.metrics.fetched !== 0 || totalDocumentWrites(second) !== 0) {
    throw new Error('Second pilot run was not idempotent');
  }
  if (second.metrics.failed !== 0 || second.metrics.retryable !== 0) {
    throw new Error('Second pilot run has failures');
  }
}

function validateAudit(audit) {
  const fields = [
    'expectedSampleDocuments',
    'sampledDocuments',
    'missingSampleDocuments',
    'readyRecipeTin',
    'readySeriousEats',
    'reviewDocuments',
    'disabledSeriousEats',
    'invalidSeriousEatsReasonCodes',
    'invalidReady',
    'searchMismatches',
    'missingTime',
    'missingTaxonomy',
    'estimatedDocumentBytes',
  ];
  for (const field of fields) nonNegative(audit[field], `audit.${field}`);
  if (!Number.isInteger(audit.expectedSampleDocuments)
    || !Number.isInteger(audit.sampledDocuments)
    || !Number.isInteger(audit.missingSampleDocuments)
    || audit.expectedSampleDocuments < 1
    || audit.missingSampleDocuments !== 0
    || audit.sampledDocuments !== audit.expectedSampleDocuments) {
    throw new Error('Pilot sample document audit is incomplete');
  }
  if (audit.readyRecipeTin < 1) {
    throw new Error('Pilot recipe quality gate has no ready RecipeTin Eats sample');
  }
  if (audit.invalidReady > 0 || audit.searchMismatches > 0
    || audit.missingTime > 0 || audit.missingTaxonomy > 0) {
    throw new Error('Pilot recipe quality gate failed');
  }

  if (!Array.isArray(audit.seriousEatsReasonCodes)
    || audit.invalidSeriousEatsReasonCodes > 0
    || audit.seriousEatsReasonCodes.some((code) => !PROTECTED_ACCESS_REASON.test(code))) {
    throw new Error('Serious Eats evidence contains an unsafe protected-access reason');
  }

  if (audit.readySeriousEats < 1) {
    if (audit.disabledSeriousEats < 1
      || audit.seriousEatsReasonCodes.length < 1) {
      throw new Error('Serious Eats outcome is not a bounded protected-access result');
    }
  }
}

function validateSelection(selection) {
  const fields = ['iterations', 'p95Ms', 'maxMs', 'candidateReads', 'selected', 'noMatch'];
  for (const field of fields) nonNegative(selection[field], `selection.${field}`);
  if (!Number.isInteger(selection.iterations) || selection.iterations < 10) {
    throw new Error('Pilot selection requires at least 10 iterations');
  }
  if (selection.p95Ms > 2_000) throw new Error('Pilot selection p95 exceeds 2000 ms');
  if (selection.maxMs < selection.p95Ms) throw new Error('Pilot selection latency summary is inconsistent');
  if (selection.selected + selection.noMatch !== selection.iterations) {
    throw new Error('Pilot selection outcomes do not match the iteration count');
  }
}

export function validateCataloguePilotEvidence(rawEvidence) {
  const evidence = object(rawEvidence, 'pilot');
  if (evidence.schedulerState !== 'PAUSED') throw new Error('Scheduler is not PAUSED');
  if (evidence.generationMode !== 'legacy') throw new Error('generationMode is not legacy');
  const writeCap = nonNegative(evidence.writeCap, 'writeCap');
  if (!Number.isInteger(writeCap) || writeCap < 1 || writeCap > 40) {
    throw new Error('Pilot write cap must be an integer from 1 to 40');
  }

  const discovery = object(evidence.discovery, 'discovery');
  const first = object(evidence.first, 'first');
  const second = object(evidence.second, 'second');
  validateRunMeasurements(discovery, 'discovery', writeCap);
  validateRunMeasurements(first, 'first', writeCap);
  validateRunMeasurements(second, 'second', writeCap);
  validateDiscovery(discovery);
  validateFirstRun(first);
  validateSecondRun(second);
  validateAudit(object(evidence.audit, 'audit'));
  validateSelection(object(evidence.selection, 'selection'));
}
