export type MigrationCliCommand =
  | 'dry-run'
  | 'migrate-recipes'
  | 'migrate-references'
  | 'reconcile'
  | 'verify';

export interface MigrationCliArguments {
  command: MigrationCliCommand;
  runId?: string;
  maxWrites?: number;
  maxReferences?: number;
}

const COMMANDS = new Set<MigrationCliCommand>([
  'dry-run', 'migrate-recipes', 'migrate-references', 'reconcile', 'verify',
]);

function positiveInteger(value: string | undefined, maximum: number, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new Error(`${name} must be between 1 and ${maximum}`);
  }
  return parsed;
}

export function parseMigrationArguments(arguments_: readonly string[]): MigrationCliArguments {
  const [rawCommand, ...rest] = arguments_;
  if (!COMMANDS.has(rawCommand as MigrationCliCommand)) throw new Error('Unsupported migration command');
  const result: MigrationCliArguments = { command: rawCommand as MigrationCliCommand };
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!value) throw new Error(`Missing value for ${flag}`);
    if (flag === '--run-id' && value.trim()) result.runId = value.trim();
    else if (flag === '--max-writes') result.maxWrites = positiveInteger(value, 8_000, 'max-writes');
    else if (flag === '--max-references') result.maxReferences = positiveInteger(value, 10_000, 'max-references');
    else throw new Error(`Unsupported argument: ${flag}`);
  }
  if (result.maxWrites !== undefined && !['migrate-recipes', 'reconcile'].includes(result.command)) {
    throw new Error('max-writes is only valid for recipe migration');
  }
  if (result.maxReferences !== undefined && result.command !== 'migrate-references') {
    throw new Error('max-references is only valid for reference migration');
  }
  return result;
}

export function assertSuccessfulMigrationResult(command: string, result: unknown): void {
  if (!result || typeof result !== 'object') return;
  if (command === 'dry-run') {
    const dryRun = result as { recipes?: { status?: unknown }; references?: { status?: unknown } };
    if (dryRun.recipes?.status !== 'complete' || dryRun.references?.status !== 'complete') {
      throw new Error('Dry-run did not complete cleanly');
    }
    return;
  }
  const status = (result as { status?: unknown }).status;
  if ((command === 'migrate-recipes' || command === 'reconcile')
    && status !== 'complete' && status !== 'budget-exhausted') {
    throw new Error(`Recipe migration stopped with status ${String(status)}`);
  }
  if (command === 'migrate-references' && status !== 'complete' && status !== 'partial') {
    throw new Error(`Reference migration stopped with status ${String(status)}`);
  }
}
