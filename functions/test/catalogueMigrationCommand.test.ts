import { describe, expect, it } from 'vitest';

import {
  assertSuccessfulMigrationResult,
  parseMigrationArguments,
} from '../src/catalogue/migrationCommand.js';

describe('parseMigrationArguments', () => {
  it('parses a safe dry-run with defaults', () => {
    expect(parseMigrationArguments(['dry-run'])).toEqual({ command: 'dry-run' });
  });

  it('parses bounded recipe migration options', () => {
    expect(parseMigrationArguments([
      'migrate-recipes', '--run-id', 'run-1', '--max-writes', '25',
    ])).toEqual({ command: 'migrate-recipes', runId: 'run-1', maxWrites: 25 });
  });

  it('parses a bounded reference canary', () => {
    expect(parseMigrationArguments([
      'migrate-references', '--max-references', '10',
    ])).toEqual({ command: 'migrate-references', maxReferences: 10 });
  });

  it.each([
    [],
    ['rollback-references'],
    ['migrate-recipes', '--max-writes', '8001'],
    ['migrate-references', '--max-references', '0'],
    ['verify', '--unknown', 'value'],
  ])('rejects unsupported or unsafe arguments: %j', (arguments_) => {
    expect(() => parseMigrationArguments(arguments_)).toThrow();
  });
});

describe('assertSuccessfulMigrationResult', () => {
  it('accepts expected capped runs', () => {
    expect(() => assertSuccessfulMigrationResult('migrate-recipes', { status: 'budget-exhausted' })).not.toThrow();
    expect(() => assertSuccessfulMigrationResult('migrate-references', { status: 'partial' })).not.toThrow();
  });

  it('rejects concurrent or incomplete runs', () => {
    expect(() => assertSuccessfulMigrationResult('migrate-recipes', { status: 'concurrent-change' })).toThrow();
    expect(() => assertSuccessfulMigrationResult('dry-run', {
      recipes: { status: 'complete' }, references: { status: 'stopped' },
    })).toThrow();
  });
});
