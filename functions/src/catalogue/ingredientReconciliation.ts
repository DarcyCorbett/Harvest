export interface IngredientLike {
  name: string;
  quantity?: number;
  unit?: string;
  notes?: string;
}

export interface OccurrenceReconciliationResult {
  matchedGroupedToRoot: number[];
  matchedRootToGrouped: number[];
  unmatchedRootIndices: number[];
  unmatchedGroupedIndices: number[];
  isCompleteBijection: boolean;
  ambiguities: string[];
}

const UNIT_ALIASES: Record<string, string> = {
  tablespoon: 'tbsp', tablespoons: 'tbsp', tbsps: 'tbsp',
  teaspoon: 'tsp', teaspoons: 'tsp', tsps: 'tsp',
  cup: 'cup', cups: 'cup',
  gram: 'g', grams: 'g',
  kilogram: 'kg', kilograms: 'kg',
  milliliter: 'ml', milliliters: 'ml', millilitre: 'ml', millilitres: 'ml',
  liter: 'l', liters: 'l', litre: 'l', litres: 'l',
  ounce: 'oz', ounces: 'oz', ozs: 'oz',
  pound: 'lb', pounds: 'lb', lbs: 'lb',
  'fluid ounce': 'fl oz', 'fluid ounces': 'fl oz',
  clove: 'clove', cloves: 'clove',
  slice: 'slice', slices: 'slice',
  piece: 'piece', pieces: 'piece',
  can: 'can', cans: 'can',
  jar: 'jar', jars: 'jar',
  bag: 'bag', bags: 'bag',
  bunch: 'bunch', bunches: 'bunch',
  stalk: 'stalk', stalks: 'stalk',
  sprig: 'sprig', sprigs: 'sprig',
  pinch: 'pinch', pinches: 'pinch',
  dash: 'dash', dashes: 'dash',
  handful: 'handful', handfuls: 'handful',
  pint: 'pint', pints: 'pint',
  quart: 'quart', quarts: 'quart',
  stick: 'stick', sticks: 'stick',
  head: 'head', heads: 'head',
};

function normalizeUnit(unit: string | undefined): string {
  const u = (unit ?? '').trim().toLowerCase().replace(/\.$/, '');
  return UNIT_ALIASES[u] ?? u;
}

function normalizeName(name: string | undefined): string {
  return (name ?? '')
    .trim()
    .toLowerCase()
    .replace(/^of\s+/i, '')
    .replace(/\s+/g, ' ');
}

function normalizeQuantity(qty: number | undefined): number {
  return typeof qty === 'number' && Number.isFinite(qty) ? Math.round(qty * 10000) / 10000 : 0;
}

function exactSignature(i: IngredientLike): string {
  return JSON.stringify([
    (i.name ?? '').trim().toLowerCase(),
    normalizeQuantity(i.quantity),
    (i.unit ?? '').trim().toLowerCase(),
    (i.notes ?? '').trim().toLowerCase(),
  ]);
}

function normalizedTuple(i: IngredientLike): string {
  return JSON.stringify([
    normalizeName(i.name),
    normalizeQuantity(i.quantity),
    normalizeUnit(i.unit),
  ]);
}

/**
 * Reconciles occurrences between root ingredients and grouped ingredients.
 *
 * Matching rules:
 * 1. Match exact signatures (name, quantity, unit, notes) across the entire list.
 * 2. Match remaining occurrences by normalized [name, quantity, unit] only when
 *    the remaining correspondence is unambiguous (1-to-1). Cosmetic notes
 *    differences are permitted at this stage.
 * 3. Consume each occurrence at most once. Preserve original flat-list index.
 * 4. Preserve unmatched ingredients.
 * 5. Never use unrestricted name-only matching, positional fallback, or equal list lengths.
 */
export function reconcileOccurrences<
  R extends IngredientLike,
  G extends IngredientLike,
>(root: readonly R[], grouped: readonly G[]): OccurrenceReconciliationResult {
  const matchedGroupedToRoot = new Array<number>(grouped.length).fill(-1);
  const matchedRootToGrouped = new Array<number>(root.length).fill(-1);
  const usedRoot = new Set<number>();
  const usedGrouped = new Set<number>();
  const ambiguities: string[] = [];

  // Pass 1: exact matches across the entire list
  for (let g = 0; g < grouped.length; g++) {
    const gSig = exactSignature(grouped[g]);
    for (let r = 0; r < root.length; r++) {
      if (!usedRoot.has(r) && exactSignature(root[r]) === gSig) {
        matchedGroupedToRoot[g] = r;
        matchedRootToGrouped[r] = g;
        usedRoot.add(r);
        usedGrouped.add(g);
        break;
      }
    }
  }

  // Pass 2: unambiguous match on normalized [name, quantity, unit]
  const remainingGroupedIndices: number[] = [];
  for (let g = 0; g < grouped.length; g++) {
    if (!usedGrouped.has(g)) remainingGroupedIndices.push(g);
  }

  const remainingRootIndices: number[] = [];
  for (let r = 0; r < root.length; r++) {
    if (!usedRoot.has(r)) remainingRootIndices.push(r);
  }

  const groupedTupleMap = new Map<string, number[]>();
  for (const g of remainingGroupedIndices) {
    const tuple = normalizedTuple(grouped[g]);
    const list = groupedTupleMap.get(tuple) ?? [];
    list.push(g);
    groupedTupleMap.set(tuple, list);
  }

  const rootTupleMap = new Map<string, number[]>();
  for (const r of remainingRootIndices) {
    const tuple = normalizedTuple(root[r]);
    const list = rootTupleMap.get(tuple) ?? [];
    list.push(r);
    rootTupleMap.set(tuple, list);
  }

  for (const [tuple, gIndices] of groupedTupleMap.entries()) {
    const rIndices = rootTupleMap.get(tuple) ?? [];
    if (gIndices.length === 1 && rIndices.length === 1) {
      const g = gIndices[0];
      const r = rIndices[0];
      matchedGroupedToRoot[g] = r;
      matchedRootToGrouped[r] = g;
      usedRoot.add(r);
      usedGrouped.add(g);
    } else if (gIndices.length > 0 && rIndices.length > 0) {
      ambiguities.push(
        `Ambiguous occurrence match for tuple ${tuple}: ${gIndices.length} grouped occurrence(s) vs ${rIndices.length} root occurrence(s)`,
      );
    }
  }

  const unmatchedRootIndices: number[] = [];
  for (let r = 0; r < root.length; r++) {
    if (!usedRoot.has(r)) unmatchedRootIndices.push(r);
  }

  const unmatchedGroupedIndices: number[] = [];
  for (let g = 0; g < grouped.length; g++) {
    if (!usedGrouped.has(g)) unmatchedGroupedIndices.push(g);
  }

  const isCompleteBijection =
    root.length === grouped.length &&
    unmatchedRootIndices.length === 0 &&
    unmatchedGroupedIndices.length === 0;

  return {
    matchedGroupedToRoot,
    matchedRootToGrouped,
    unmatchedRootIndices,
    unmatchedGroupedIndices,
    isCompleteBijection,
    ambiguities,
  };
}
