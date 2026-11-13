import { FieldPath, getFirestore, type Firestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import { HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { z } from 'zod';

import {
  CUISINES,
  MEAL_TYPES,
  MODIFIERS,
  normalizeIngredientTokens,
  type Cuisine,
  type MealType,
  type Modifier,
} from './domain.js';
import { SOURCE_CONFIGS } from './sourceAdapters.js';

const ingredientControl = z.string().trim().min(1).max(120);
const slotSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  mealType: z.enum(MEAL_TYPES),
  cuisines: z.array(z.enum(CUISINES)).max(CUISINES.length),
  modifiers: z.array(z.enum(MODIFIERS)).max(MODIFIERS.length),
  maxTotalMinutes: z.union([z.literal(30), z.literal(45)]).optional(),
  ingredients: z.object({
    must: z.array(ingredientControl).max(20),
    prefer: z.array(ingredientControl).max(20),
    exclude: z.array(ingredientControl).max(20),
  }).strict(),
}).strict();

export const selectCatalogueRecipesRequestSchema = z.object({
  householdId: z.string().trim().min(1).max(128),
  slots: z.array(slotSchema).min(1).max(31),
  currentPlanRecipeIds: z.array(z.string().trim().min(1).max(160)).max(500).optional().default([]),
  recentRecipeIds: z.array(z.string().trim().min(1).max(160)).max(500).optional().default([]),
  ranking: z.object({
    recentProteins: z.array(ingredientControl).max(20),
    preferredRecipeIds: z.array(z.string().max(160)).max(500),
    depreferredRecipeIds: z.array(z.string().max(160)).max(500),
  }).strict().optional(),
}).strict();

export type CatalogueMealSlot = z.infer<typeof slotSchema>;
export type SelectCatalogueRecipesRequest = z.input<typeof selectCatalogueRecipesRequestSchema>;
type ParsedSelectionRequest = z.output<typeof selectCatalogueRecipesRequestSchema>;

export interface CatalogueCandidate {
  id: string;
  sourceKey: string;
  totalMinutes?: number;
  mealTypes: readonly MealType[];
  cuisines: readonly Cuisine[];
  modifiers: readonly Modifier[];
  ingredientTokens: readonly string[];
  randomKey: number;
}

export interface CatalogueSelectionStore {
  getSourceWeights(householdId: string): Promise<Record<string, number>>;
  queryCandidates(
    sourceKey: string,
    query: CatalogueMealSlot,
    pageToken?: string,
    randomStart?: number,
  ): Promise<{ candidates: CatalogueCandidate[]; nextPageToken?: string }>;
}

export type Relaxation =
  | { filter: 'maxTotalMinutes'; from: 30; to: 45; matchCount: number }
  | { filter: 'modifier'; value: Modifier; matchCount: number }
  | { filter: 'cuisine'; value: Cuisine; matchCount: number }
  | { filter: 'mustIngredient'; value: string; matchCount: number }
  | { filter: 'excludedIngredient'; value: string; matchCount: number };

type RelaxationWithoutCount = Relaxation extends infer Candidate
  ? Candidate extends { matchCount: number }
    ? Omit<Candidate, 'matchCount'>
    : never
  : never;

export interface SelectCatalogueRecipesResponse {
  slots: Array<{
    date: string;
    mealType: MealType;
    status: 'selected';
    recipeId: string;
    sourceKey: string;
  } | {
    date: string;
    mealType: MealType;
    status: 'no-match';
    relaxations: Relaxation[];
  }>;
}

function normalizedControls(slot: CatalogueMealSlot) {
  return {
    must: normalizeIngredientTokens(slot.ingredients.must),
    prefer: normalizeIngredientTokens(slot.ingredients.prefer),
    exclude: normalizeIngredientTokens(slot.ingredients.exclude),
  };
}

function containsAll(haystack: readonly string[], needles: readonly string[]): boolean {
  const values = new Set(haystack);
  return needles.every((needle) => values.has(needle));
}

function isEligible(
  candidate: CatalogueCandidate,
  slot: CatalogueMealSlot,
  excludedIds: ReadonlySet<string>,
): boolean {
  if (excludedIds.has(candidate.id)) return false;
  if (!candidate.mealTypes.includes(slot.mealType)) return false;
  if (!containsAll(candidate.cuisines, slot.cuisines)) return false;
  if (!containsAll(candidate.modifiers, slot.modifiers)) return false;
  if (slot.maxTotalMinutes !== undefined
    && (candidate.totalMinutes === undefined || candidate.totalMinutes > slot.maxTotalMinutes)) {
    return false;
  }
  const controls = normalizedControls(slot);
  if (!containsAll(candidate.ingredientTokens, controls.must)) return false;
  if (controls.exclude.some((token) => candidate.ingredientTokens.includes(token))) return false;
  return true;
}

async function matchesForSource(
  sourceKey: string,
  slot: CatalogueMealSlot,
  store: CatalogueSelectionStore,
  excludedIds: ReadonlySet<string>,
  randomStart: number,
  maxMatchesPerSource = 25,
): Promise<CatalogueCandidate[]> {
  const matches: CatalogueCandidate[] = [];
  let pageToken: string | undefined;
  do {
    const page = await store.queryCandidates(sourceKey, slot, pageToken, randomStart);
    matches.push(...page.candidates.filter((candidate) =>
      candidate.sourceKey === sourceKey && isEligible(candidate, slot, excludedIds)));
    if (matches.length >= maxMatchesPerSource) break;
    pageToken = page.nextPageToken;
  } while (pageToken !== undefined);
  return matches.slice(0, maxMatchesPerSource);
}

function weightedPick<T>(
  values: readonly T[],
  weight: (value: T) => number,
  random: () => number,
): T {
  const total = values.reduce((sum, value) => sum + Math.max(0, weight(value)), 0);
  let target = random() * total;
  for (const value of values) {
    target -= Math.max(0, weight(value));
    if (target < 0) return value;
  }
  return values[values.length - 1];
}

function weightedSourceOrder(
  sourceWeights: Record<string, number>,
  random: () => number,
): string[] {
  const remaining = Object.entries(sourceWeights)
    .filter(([, weight]) => Number.isFinite(weight) && weight > 0)
    .map(([sourceKey]) => sourceKey);
  const ordered: string[] = [];
  while (remaining.length > 0) {
    const selected = weightedPick(remaining, (key) => sourceWeights[key] ?? 0, random);
    ordered.push(selected);
    remaining.splice(remaining.indexOf(selected), 1);
  }
  return ordered;
}

async function firstEligibleSource(
  sourceWeights: Record<string, number>,
  slot: CatalogueMealSlot,
  store: CatalogueSelectionStore,
  excludedIds: ReadonlySet<string>,
  random: () => number,
): Promise<{ sourceKey: string; matches: CatalogueCandidate[] } | undefined> {
  const orderedSources = weightedSourceOrder(sourceWeights, random);
  const batchSize = 4;
  for (let offset = 0; offset < orderedSources.length; offset += batchSize) {
    const batch = orderedSources.slice(offset, offset + batchSize);
    const results = await Promise.all(batch.map(async (sourceKey) => ({
      sourceKey,
      matches: await matchesForSource(sourceKey, slot, store, excludedIds, random()),
    })));
    const firstMatch = results.find(({ matches }) => matches.length > 0);
    if (firstMatch) return firstMatch;
  }
  return undefined;
}

async function relaxationDiagnostics(
  sourceWeights: Record<string, number>,
  slot: CatalogueMealSlot,
  store: CatalogueSelectionStore,
  excludedIds: ReadonlySet<string>,
): Promise<Relaxation[]> {
  const variants: Array<{ slot: CatalogueMealSlot; relaxation: RelaxationWithoutCount }> = [];
  if (slot.maxTotalMinutes === 30) {
    variants.push({
      slot: { ...slot, maxTotalMinutes: 45 },
      relaxation: { filter: 'maxTotalMinutes', from: 30, to: 45 },
    });
  }
  slot.modifiers.forEach((value) => variants.push({
    slot: { ...slot, modifiers: slot.modifiers.filter((item) => item !== value) },
    relaxation: { filter: 'modifier', value },
  }));
  slot.cuisines.forEach((value) => variants.push({
    slot: { ...slot, cuisines: slot.cuisines.filter((item) => item !== value) },
    relaxation: { filter: 'cuisine', value },
  }));
  slot.ingredients.must.forEach((value) => variants.push({
    slot: {
      ...slot,
      ingredients: { ...slot.ingredients, must: slot.ingredients.must.filter((item) => item !== value) },
    },
    relaxation: { filter: 'mustIngredient', value },
  }));
  slot.ingredients.exclude.forEach((value) => variants.push({
    slot: {
      ...slot,
      ingredients: { ...slot.ingredients, exclude: slot.ingredients.exclude.filter((item) => item !== value) },
    },
    relaxation: { filter: 'excludedIngredient', value },
  }));

  const diagnostics: Relaxation[] = [];
  for (const variant of variants) {
    const match = await firstEligibleSource(
      sourceWeights,
      variant.slot,
      store,
      excludedIds,
      () => 0,
    );
    const matchCount = match?.matches.length ?? 0;
    if (matchCount > 0) diagnostics.push({ ...variant.relaxation, matchCount } as Relaxation);
  }
  return diagnostics;
}

export async function selectCatalogueRecipes(
  input: SelectCatalogueRecipesRequest,
  store: CatalogueSelectionStore,
  random: () => number = Math.random,
): Promise<SelectCatalogueRecipesResponse> {
  const parsed = selectCatalogueRecipesRequestSchema.parse(input);
  const sourceWeights = await store.getSourceWeights(parsed.householdId);
  const excludedIds = new Set([...parsed.currentPlanRecipeIds, ...parsed.recentRecipeIds]);
  const selected: SelectCatalogueRecipesResponse['slots'] = [];

  for (const slot of parsed.slots) {
    const eligible = await firstEligibleSource(sourceWeights, slot, store, excludedIds, random);
    if (!eligible) {
      selected.push({
        date: slot.date,
        mealType: slot.mealType,
        status: 'no-match',
        relaxations: await relaxationDiagnostics(sourceWeights, slot, store, excludedIds),
      });
      continue;
    }

    const controls = normalizedControls(slot);
    const recipe = weightedPick(
      eligible.matches,
      (candidate) => (1 + controls.prefer.filter((token) =>
        candidate.ingredientTokens.includes(token)).length * 2 +
        (parsed.ranking?.preferredRecipeIds.includes(candidate.id) ? 2 : 0)) /
        (1 + (parsed.ranking?.recentProteins.filter(token=>candidate.ingredientTokens.includes(token)).length ?? 0) * 2 +
        (parsed.ranking?.depreferredRecipeIds.includes(candidate.id) ? 2 : 0)),
      random,
    );
    excludedIds.add(recipe.id);
    selected.push({
      date: slot.date,
      mealType: slot.mealType,
      status: 'selected',
      recipeId: recipe.id,
      sourceKey: eligible.sourceKey,
    });
  }

  return { slots: selected };
}

type Authorize = (
  auth: CallableRequest<unknown>['auth'],
  householdId: string,
) => Promise<{ uid: string; email: string }>;

export function createCatalogueSelectionHandlers(dependencies: {
  authorize: Authorize;
  store: CatalogueSelectionStore;
  random?: () => number;
}) {
  return {
    async select(request: CallableRequest<unknown>) {
      const startedAt = Date.now();
      const parsed = selectCatalogueRecipesRequestSchema.safeParse(request.data);
      if (!parsed.success) throw new HttpsError('invalid-argument', 'Invalid catalogue request.');
      await dependencies.authorize(request.auth, parsed.data.householdId);
      const response = await selectCatalogueRecipes(parsed.data, dependencies.store, dependencies.random);
      logger.info('catalogue_selection', {
        durationMs: Date.now() - startedAt,
        slots: response.slots.length,
        selected: response.slots.filter((slot) => slot.status === 'selected').length,
        noMatch: response.slots.filter((slot) => slot.status === 'no-match').length,
      });
      return response;
    },
  };
}

function decodeSourceWeights(value: unknown): Record<string, number> {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const weights: Record<string, number> = {};
  for (const config of SOURCE_CONFIGS) {
    const encodedHost = config.host.replace(/\./g, '_');
    const candidate = raw[encodedHost];
    weights[config.sourceKey] = typeof candidate === 'number' && Number.isFinite(candidate)
      ? Math.max(0, candidate)
      : 1;
  }
  return weights;
}

export function firestoreCatalogueSelectionStore(
  db: Firestore = getFirestore(),
  documentId: FieldPath = FieldPath.documentId(),
): CatalogueSelectionStore {
  return {
    async getSourceWeights(householdId) {
      const snapshot = await db.collection('households').doc(householdId)
        .collection('settings').doc('preferences').get();
      return decodeSourceWeights(snapshot.exists ? snapshot.get('sourceWeights') : undefined);
    },
    async queryCandidates(sourceKey, slot, pageToken, randomStart) {
      const controls = normalizedControls(slot);
      const requiredIngredient = controls.must[0];
      let query = db.collection('recipes')
        .where('schemaVersion', '==', 2)
        .where('status', '==', 'ready')
        .where('source.key', '==', sourceKey);
      if (requiredIngredient) {
        query = query.where('search.ingredientTokens', 'array-contains', requiredIngredient);
      } else {
        query = query.where(
          'search.selectionKeys',
          'array-contains',
          `${slot.mealType}|${slot.cuisines[0] ?? 'any'}`,
        );
      }
      // Use one bounded indexed discriminator and enforce the complete
      // intersection again in isEligible(). This avoids a combinatorial index
      // explosion while still exhausting every categorical candidate page.
      if (!requiredIngredient && slot.maxTotalMinutes === undefined && slot.modifiers.length === 1) {
        const modifier = slot.modifiers[0];
        const field = {
          vegetarian: 'search.vegetarian',
          'kid-friendly': 'search.kidFriendly',
          healthy: 'search.healthy',
          salad: 'search.salad',
        }[modifier];
        query = query.where(field, '==', true);
      }
      if (!requiredIngredient && slot.maxTotalMinutes === 30) {
        query = query.where('search.quick30', '==', true);
      }
      if (!requiredIngredient && slot.maxTotalMinutes === 45) {
        query = query.where('search.moderate45', '==', true);
      }
      query = query
        .select(
          'source.key',
          'effective.totalMinutes',
          'effective.mealTypes',
          'effective.cuisines',
          'effective.modifiers',
          'search.ingredientTokens',
          'search.randomKey',
        )
        .orderBy('search.randomKey')
        .orderBy(documentId)
        .limit(100);

      let cursor: {
        randomKey?: number;
        id?: string;
        wrapped?: boolean;
        upperBound?: number;
      } | undefined;
      if (pageToken) {
        cursor = JSON.parse(Buffer.from(pageToken, 'base64url').toString('utf8')) as typeof cursor;
        if (cursor?.randomKey !== undefined && cursor.id !== undefined) {
          query = query.startAfter(cursor.randomKey, cursor.id);
        }
        if (cursor?.wrapped && cursor.upperBound !== undefined) {
          query = query.endBefore(cursor.upperBound);
        }
      } else if (randomStart !== undefined && randomStart > 0) {
        query = query.startAt(randomStart);
      }
      const snapshot = await query.get();
      const candidates = snapshot.docs.map((document) => {
        const data = document.data();
        return {
          id: document.id,
          sourceKey: data.source?.key,
          totalMinutes: data.effective?.totalMinutes,
          mealTypes: Array.isArray(data.effective?.mealTypes) ? data.effective.mealTypes : [],
          cuisines: Array.isArray(data.effective?.cuisines) ? data.effective.cuisines : [],
          modifiers: Array.isArray(data.effective?.modifiers) ? data.effective.modifiers : [],
          ingredientTokens: Array.isArray(data.search?.ingredientTokens) ? data.search.ingredientTokens : [],
          randomKey: typeof data.search?.randomKey === 'number' ? data.search.randomKey : 0,
        } as CatalogueCandidate;
      });
      const last = candidates.at(-1);
      const upperBound = cursor?.upperBound ?? randomStart;
      let nextPageToken: string | undefined;
      if (snapshot.size === 100 && last) {
        nextPageToken = Buffer.from(JSON.stringify({
          randomKey: last.randomKey,
          id: last.id,
          wrapped: cursor?.wrapped ?? false,
          ...(upperBound === undefined ? {} : { upperBound }),
        })).toString('base64url');
      } else if (!cursor?.wrapped && upperBound !== undefined && upperBound > 0) {
        nextPageToken = Buffer.from(JSON.stringify({
          wrapped: true,
          upperBound,
        })).toString('base64url');
      }
      return {
        candidates,
        ...(nextPageToken ? { nextPageToken } : {}),
      };
    },
  };
}
