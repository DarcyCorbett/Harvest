import { describe, expect, it } from 'vitest';

import {
  sanitizeCataloguePilotRun,
  validateCataloguePilotEvidence,
} from '../scripts/cataloguePilotValidation.mjs';

function sourceMetrics(overrides: Record<string, unknown> = {}) {
  return {
    discovered: 0,
    unchanged: 0,
    fetched: 0,
    parsed: 0,
    classified: 0,
    written: 0,
    review: 0,
    retryable: 0,
    permanentSkipped: 0,
    failed: 0,
    recipeReads: 0,
    documentWrites: 0,
    estimatedDocumentBytes: 0,
    sampleRecipeIds: [],
    ...overrides,
  };
}

function run(overrides: Record<string, unknown> = {}) {
  return {
    status: 'complete',
    reservedWrites: 40,
    consumedWrites: 8,
    metrics: {
      discovered: 3,
      unchanged: 0,
      fetched: 3,
      parsed: 2,
      classified: 2,
      written: 2,
      review: 0,
      retryable: 0,
      permanentSkipped: 1,
      failed: 0,
    },
    bySource: {
      recipetineats: sourceMetrics({
        discovered: 2,
        fetched: 2,
        parsed: 2,
        classified: 2,
        written: 2,
        recipeReads: 2,
        documentWrites: 2,
        estimatedDocumentBytes: 20_000,
        sampleRecipeIds: ['recipe-tin-1', 'recipe-tin-2'],
      }),
      seriouseats: sourceMetrics({
        discovered: 1,
        fetched: 1,
        permanentSkipped: 1,
        recipeReads: 1,
        documentWrites: 1,
        estimatedDocumentBytes: 500,
        sampleRecipeIds: ['serious-eats-1'],
      }),
    },
    telemetry: {
      gemini: {
        calls: 2,
        promptTokenCount: 100,
        candidatesTokenCount: 20,
        totalTokenCount: 120,
      },
    },
    ...overrides,
  };
}

function validEvidence() {
  return {
    schedulerState: 'PAUSED',
    generationMode: 'legacy',
    writeCap: 40,
    discovery: run({
      consumedWrites: 6,
      metrics: {
        discovered: 241,
        unchanged: 0,
        fetched: 0,
        parsed: 0,
        classified: 0,
        written: 0,
        review: 0,
        retryable: 0,
        permanentSkipped: 0,
        failed: 1,
      },
      bySource: {
        recipetineats: sourceMetrics({ discovered: 241 }),
        seriouseats: sourceMetrics({ failed: 1 }),
      },
      telemetry: { gemini: { calls: 0, promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 } },
    }),
    first: run(),
    second: run({
      consumedWrites: 6,
      metrics: {
        discovered: 3,
        unchanged: 3,
        fetched: 0,
        parsed: 0,
        classified: 0,
        written: 0,
        review: 0,
        retryable: 0,
        permanentSkipped: 0,
        failed: 0,
      },
      bySource: {
        recipetineats: sourceMetrics({ discovered: 2, unchanged: 2 }),
        seriouseats: sourceMetrics({ discovered: 1, unchanged: 1 }),
      },
      telemetry: { gemini: { calls: 0, promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 } },
    }),
    audit: {
      sampledDocuments: 3,
      readyRecipeTin: 2,
      readySeriousEats: 0,
      reviewDocuments: 0,
      disabledSeriousEats: 1,
      seriousEatsReasonCodes: ['unsupported-402'],
      invalidReady: 0,
      searchMismatches: 0,
      missingTime: 0,
      missingTaxonomy: 0,
      estimatedDocumentBytes: 20_500,
    },
    selection: {
      iterations: 10,
      p95Ms: 250,
      maxMs: 300,
      candidateReads: 20,
      selected: 10,
      noMatch: 0,
    },
  };
}

describe('catalogue Phase 2 pilot validation', () => {
  it('allowlists run-summary evidence and drops checkpoint cursors or unknown fields', () => {
    const sanitized = sanitizeCataloguePilotRun({
      ...run(),
      checkpoints: {
        recipetineats: {
          cursor: Buffer.from('https://www.recipetineats.com/post-sitemap.xml').toString('base64'),
        },
      },
      rawUrl: 'https://www.recipetineats.com/private-evidence',
    });

    expect(sanitized).toMatchObject({
      status: 'complete',
      reservedWrites: 40,
      consumedWrites: 8,
      metrics: expect.any(Object),
      bySource: expect.any(Object),
      telemetry: expect.any(Object),
    });
    expect(sanitized).not.toHaveProperty('checkpoints');
    expect(sanitized).not.toHaveProperty('rawUrl');
    expect(JSON.stringify(sanitized)).not.toContain('post-sitemap');
    expect(JSON.stringify(sanitized)).not.toContain('private-evidence');
  });

  it('accepts a ready RecipeTin sample and explicit Serious Eats HTTP 402 outcome', () => {
    expect(() => validateCataloguePilotEvidence(validEvidence())).not.toThrow();
  });

  it('also accepts an accessible ready Serious Eats sample', () => {
    const evidence = validEvidence();
    evidence.audit.readySeriousEats = 1;
    evidence.audit.disabledSeriousEats = 0;
    evidence.audit.seriousEatsReasonCodes = [];
    expect(() => validateCataloguePilotEvidence(evidence)).not.toThrow();
  });

  it.each([
    ['scheduler', (value: ReturnType<typeof validEvidence>) => { value.schedulerState = 'ENABLED'; }],
    ['generation mode', (value: ReturnType<typeof validEvidence>) => { value.generationMode = 'catalogue'; }],
    ['rerun fetch', (value: ReturnType<typeof validEvidence>) => { value.second.metrics.fetched = 1; }],
    ['rerun write', (value: ReturnType<typeof validEvidence>) => {
      value.second.bySource.recipetineats.documentWrites = 1;
    }],
    ['invalid ready recipe', (value: ReturnType<typeof validEvidence>) => { value.audit.invalidReady = 1; }],
    ['search mismatch', (value: ReturnType<typeof validEvidence>) => { value.audit.searchMismatches = 1; }],
    ['missing time', (value: ReturnType<typeof validEvidence>) => { value.audit.missingTime = 1; }],
    ['missing taxonomy', (value: ReturnType<typeof validEvidence>) => { value.audit.missingTaxonomy = 1; }],
    ['selector p95', (value: ReturnType<typeof validEvidence>) => { value.selection.p95Ms = 2_001; }],
    ['selector iterations', (value: ReturnType<typeof validEvidence>) => { value.selection.iterations = 9; }],
    ['negative byte measurement', (value: ReturnType<typeof validEvidence>) => {
      value.audit.estimatedDocumentBytes = -1;
    }],
    ['negative Gemini measurement', (value: ReturnType<typeof validEvidence>) => {
      value.first.telemetry.gemini.totalTokenCount = -1;
    }],
  ])('rejects unsafe %s evidence', (_name, mutate) => {
    const evidence = validEvidence();
    mutate(evidence);
    expect(() => validateCataloguePilotEvidence(evidence)).toThrow();
  });

  it('rejects missing source evidence and unbounded first-run failures', () => {
    const missingSource = validEvidence();
    delete (missingSource.discovery.bySource as Record<string, unknown>).seriouseats;
    expect(() => validateCataloguePilotEvidence(missingSource)).toThrow('discovery');

    const failed = validEvidence();
    failed.first.metrics.failed = 1;
    expect(() => validateCataloguePilotEvidence(failed)).toThrow('first');
  });

  it('rejects a Serious Eats disabled outcome without a bounded protected-access reason', () => {
    const evidence = validEvidence();
    evidence.audit.seriousEatsReasonCodes = ['provider-secret-value'];
    expect(() => validateCataloguePilotEvidence(evidence)).toThrow('Serious Eats');
  });
});
