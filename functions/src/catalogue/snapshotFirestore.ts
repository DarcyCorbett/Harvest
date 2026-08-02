import { getFirestore } from 'firebase-admin/firestore';

import type { CanonicalRecipeV2, CompleteCanonicalRecipeV2 } from './domain.js';
import type { SnapshotInventory } from './snapshot.js';

export interface SnapshotSourceEvidence {
  discovered: number;
  alreadyComplete: number;
  newlyParsed: number;
  nonRecipe: number;
  inaccessible: number;
  unsupported: number;
  retryable: number;
  structurallyIncomplete: number;
  aiRequired: number;
  unaccounted: number;
}

export interface SnapshotVerification {
  mode: 'snapshot-verify';
  snapshotId: string;
  inventoryHash: string;
  complete: boolean;
  totalDiscovered: number;
  displayable: number;
  terminal: number;
  retryable: number;
  structurallyIncomplete: number;
  unaccounted: number;
  aiRequired: number;
  bySource: Record<string, SnapshotSourceEvidence>;
}

function completeRecipe(value: unknown): value is CompleteCanonicalRecipeV2 {
  if (!value || typeof value !== 'object') return false;
  const recipe = value as Partial<CompleteCanonicalRecipeV2>;
  return recipe.schemaVersion === 2
    && (recipe.status === 'ready' || recipe.status === 'review')
    && typeof recipe.id === 'string';
}

function timestampMillis(value: unknown): number | undefined {
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (value instanceof Date) return value.getTime();
  if (value && typeof value === 'object' && 'toDate' in value
    && typeof (value as { toDate?: unknown }).toDate === 'function') {
    return (value as { toDate(): Date }).toDate().getTime();
  }
  return undefined;
}

export function hasDisplayContent(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const content = (value as { content?: unknown }).content;
  if (!content || typeof content !== 'object') return false;
  const candidate = content as {
    title?: unknown;
    originalServings?: unknown;
    ingredients?: unknown;
    instructions?: unknown;
  };
  return typeof candidate.title === 'string'
    && candidate.title.trim().length > 0
    && typeof candidate.originalServings === 'number'
    && candidate.originalServings > 0
    && Array.isArray(candidate.ingredients)
    && candidate.ingredients.length > 0
    && Array.isArray(candidate.instructions)
    && candidate.instructions.length > 0
    && candidate.instructions.every((step) => Boolean(
      step && typeof step === 'object'
      && typeof (step as { text?: unknown }).text === 'string'
      && (step as { text: string }).text.trim().length > 0,
    ))
    && Buffer.byteLength(JSON.stringify(value), 'utf8') <= 900_000;
}

const RECIPE_READ_BATCH_SIZE = 250;

type InventoryRecipeLoader = (
  inventoryIds: readonly string[],
) => Promise<Map<string, CanonicalRecipeV2>>;

async function loadInventoryRecipes(
  inventoryIds: readonly string[],
): Promise<Map<string, CanonicalRecipeV2>> {
  const db = getFirestore();
  const recipes = new Map<string, CanonicalRecipeV2>();
  const references = inventoryIds.map((id) => db.collection('recipes').doc(id));
  const snapshots = await db.getAll(...references);
  for (const document of snapshots) {
    const data = document.data();
    if (document.exists && data?.schemaVersion === 2) {
      recipes.set(document.id, { ...data, id: document.id } as CanonicalRecipeV2);
    }
  }
  return recipes;
}

function emptyEvidence(discovered: number): SnapshotSourceEvidence {
  return {
    discovered,
    alreadyComplete: 0,
    newlyParsed: 0,
    nonRecipe: 0,
    inaccessible: 0,
    unsupported: 0,
    retryable: 0,
    structurallyIncomplete: 0,
    aiRequired: 0,
    unaccounted: 0,
  };
}

function requiresReconciliation(recipe: CanonicalRecipeV2 | undefined): boolean {
  if (!recipe) return true;
  if (completeRecipe(recipe)) return !hasDisplayContent(recipe);
  if (recipe.status === 'retryable') return true;
  return !(recipe.reasonCode === 'non-recipe-page'
    || recipe.reasonCode.startsWith('permanent-')
    || recipe.reasonCode === 'protected-access'
    || recipe.reasonCode === 'unsupported-markup'
    || recipe.reasonCode === 'missing-recipe-markup'
    || recipe.reasonCode === 'missing-display-content');
}

export async function snapshotReconciliationTargets(
  inventory: SnapshotInventory,
  options: {
    sourceKeys?: readonly string[];
    loadRecipes?: InventoryRecipeLoader;
  } = {},
): Promise<Record<string, string[]>> {
  const selected = options.sourceKeys ? new Set(options.sourceKeys) : undefined;
  const loadRecipes = options.loadRecipes ?? loadInventoryRecipes;
  const targets: Record<string, string[]> = {};
  for (const [sourceKey, source] of Object.entries(inventory.bySource)) {
    if (selected && !selected.has(sourceKey)) continue;
    const sourceTargets: string[] = [];
    for (let offset = 0; offset < source.items.length; offset += RECIPE_READ_BATCH_SIZE) {
      const items = source.items.slice(offset, offset + RECIPE_READ_BATCH_SIZE);
      const recipes = await loadRecipes(items.map(({ id }) => id));
      for (const item of items) {
        if (requiresReconciliation(recipes.get(item.id))) sourceTargets.push(item.url);
      }
    }
    if (sourceTargets.length > 0) targets[sourceKey] = sourceTargets;
  }
  return targets;
}

export async function verifySnapshotInventory(
  inventory: SnapshotInventory,
  loadRecipes: InventoryRecipeLoader = loadInventoryRecipes,
): Promise<SnapshotVerification> {
  const baselineTime = Date.parse(inventory.createdAt);
  const bySource: Record<string, SnapshotSourceEvidence> = {};
  let displayable = 0;
  let terminal = 0;
  let retryable = 0;
  let structurallyIncomplete = 0;
  let unaccounted = 0;
  let aiRequired = 0;

  for (const [sourceKey, source] of Object.entries(inventory.bySource)) {
    const evidence = emptyEvidence(source.count);
    bySource[sourceKey] = evidence;
    for (let offset = 0; offset < source.items.length; offset += RECIPE_READ_BATCH_SIZE) {
      const items = source.items.slice(offset, offset + RECIPE_READ_BATCH_SIZE);
      const recipes = await loadRecipes(items.map(({ id }) => id));
      for (const item of items) {
        const recipe = recipes.get(item.id);
        if (!recipe) {
          evidence.unaccounted += 1;
          unaccounted += 1;
          continue;
        }
        if (completeRecipe(recipe)) {
          if (!hasDisplayContent(recipe)) {
            evidence.structurallyIncomplete += 1;
            structurallyIncomplete += 1;
            continue;
          }
          displayable += 1;
          const firstIngested = timestampMillis(recipe.ingestion.firstIngestedAt);
          if (firstIngested !== undefined && firstIngested >= baselineTime) {
            evidence.newlyParsed += 1;
          } else {
            evidence.alreadyComplete += 1;
          }
          if (recipe.effective.mealTypes.length === 0
            || recipe.effective.cuisines.length === 0) {
            evidence.aiRequired += 1;
            aiRequired += 1;
          }
          continue;
        }
        if (recipe.status === 'retryable') {
          evidence.retryable += 1;
          retryable += 1;
        } else if (recipe.reasonCode === 'non-recipe-page'
          || recipe.reasonCode.startsWith('permanent-')) {
          evidence.nonRecipe += 1;
          terminal += 1;
        } else if (recipe.reasonCode === 'protected-access') {
          evidence.inaccessible += 1;
          terminal += 1;
        } else if (recipe.reasonCode === 'unsupported-markup'
          || recipe.reasonCode === 'missing-recipe-markup'
          || recipe.reasonCode === 'missing-display-content') {
          evidence.unsupported += 1;
          terminal += 1;
        } else {
          evidence.unaccounted += 1;
          unaccounted += 1;
        }
      }
    }
  }
  return {
    mode: 'snapshot-verify',
    snapshotId: inventory.snapshotId,
    inventoryHash: inventory.hash,
    complete: unaccounted === 0 && retryable === 0 && structurallyIncomplete === 0,
    totalDiscovered: inventory.total,
    displayable,
    terminal,
    retryable,
    structurallyIncomplete,
    unaccounted,
    aiRequired,
    bySource,
  };
}
