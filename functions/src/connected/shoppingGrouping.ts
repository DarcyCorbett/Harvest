import { createHash } from 'node:crypto';
import { shoppingGroupsResponse, type ShoppingGroupsInput } from '../ai/contracts.js';
import { foodKey, type Requirement } from './model.js';
import { safeGroupNames } from '../shared/ingredientAmounts.js';
import { SHOPPING_PROMPT_VERSION } from '../ai/prompts.js';

export interface ShoppingGroup {
  canonicalName: string;
  category: string;
  sourceIds: number[];
  unit?: string;
}
export interface ShoppingGroupingCache {
  fingerprint: string;
  groups: ShoppingGroup[];
}
export type ShoppingGrouper = (
  householdId: string,
  ingredients: ShoppingGroupsInput['ingredients'],
) => Promise<ShoppingGroup[]>;

/** Gemini chooses identity; quantities, units and contributions stay in code. */
export async function groupShoppingRequirements(
  householdId: string,
  requirements: Requirement[],
  group: ShoppingGrouper,
  cached?: ShoppingGroupingCache,
): Promise<{ requirements: Requirement[]; cache: ShoppingGroupingCache }> {
  const source = requirements.map(row => {
    const notes = [...new Set([row.notes, ...row.contributions.map(c => c.sourceAmount?.notes)].filter(Boolean))].join('; ').slice(0, 1000);
    return { ...row, ...(notes ? { notes } : {}) };
  }).sort((a, b) => a.id.localeCompare(b.id));
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([SHOPPING_PROMPT_VERSION, source.map(r => [r.id, r.name, r.unit, r.notes ?? ''])]))
    .digest('hex');
  const groups = shoppingGroupsResponse.parse(
    cached?.fingerprint === fingerprint ? cached.groups : source.length
      ? await group(householdId, source.map((r, id) => ({ id, name: r.name, quantity: r.quantity, unit: r.unit, ...(r.notes ? { notes: r.notes.slice(0, 1000) } : {}) })))
      : [],
  );
  const ids = groups.flatMap(g => g.sourceIds);
  if (ids.length !== source.length || new Set(ids).size !== source.length
    || ids.some(id => !source[id])) throw new Error('Invalid shopping grouping coverage');

  const result = new Map<string, Requirement>();
  for (const g of groups) {
    const names = safeGroupNames(g.canonicalName, g.sourceIds.map(id => source[id]));
    for (const id of g.sourceIds) {
      const r = source[id];
      // Ignore AI units: unlike names/categories, unit conversion is not an AI decision.
      const name = names[g.sourceIds.indexOf(id)];
      const key = foodKey({ name, unit: r.unit, quantity: 0 });
      const existing = result.get(key);
      if (existing) {
        existing.quantity += r.quantity;
        existing.contributions.push(...r.contributions);
        existing.sourceKeys!.push(r.id);
        if (r.approximate) existing.approximate = true;
      } else {
        result.set(key, { ...r, id: key, name, category: g.category,
          sourceKeys: [r.id], contributions: [...r.contributions] });
      }
    }
  }
  return {
    requirements: [...result.values()]
      .sort((a, b) => a.name.localeCompare(b.name)),
    cache: { fingerprint, groups },
  };
}
