import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { getAdminShoppingGroups } from './lib/geminiAdmin';
import { groupShoppingRequirements } from '../functions/src/connected/shoppingGrouping';
import { repairShoppingMeasurements } from '../functions/src/connected/shoppingRepair';
import { SHOPPING_PROMPT_VERSION } from '../functions/src/ai/prompts';
import type { Period } from '../functions/src/connected/model';
import { shoppingDisplayGroups } from '../services/shoppingPresentation';

async function main() {
  const args = process.argv.slice(2), live = args.includes('--live');
  const modelIndex = args.indexOf('--model'), model = modelIndex >= 0 ? args[modelIndex + 1] : undefined;
  const fixture = JSON.parse(fs.readFileSync('functions/test/fixtures/shopping-week-2026-10-05.json', 'utf8'));
  const repaired = repairShoppingMeasurements(fixture.period, fixture.recipes);
  const source = repaired.period.shopping!.sources;
  const start = performance.now();
  const result = await groupShoppingRequirements('evaluation', source, async (_household, input) => live
    ? getAdminShoppingGroups(input, model)
    : input.map(row => ({ canonicalName: row.name, category: 'Other', sourceIds: [row.id] })));
  const period: Period = { ...repaired.period, items: result.requirements.map(row => ({ ...row, checked: false, manual: false, revision: 1 })) };
  const output = {
    live, model: model ?? 'configured default', promptVersion: SHOPPING_PROMPT_VERSION,
    elapsedMs: Math.round(performance.now() - start), sourceCount: source.length,
    sourceContributions: source.reduce((n, row) => n + row.contributions.length, 0),
    resultContributions: period.items.reduce((n, row) => n + row.contributions.length, 0),
    groups: shoppingDisplayGroups(period.items, false).map(g => ({ name: g.name, amount: g.label })),
  };
  if (output.sourceContributions !== output.resultContributions) throw new Error('Ingredient contributions were lost.');
  const destination = 'artifacts/shopping-measurements/evaluation.json';
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, JSON.stringify(output, null, 2));
  console.log(JSON.stringify({ report: path.resolve(destination), live, sourceCount: output.sourceCount, cards: output.groups.length, elapsedMs: output.elapsedMs }));
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
