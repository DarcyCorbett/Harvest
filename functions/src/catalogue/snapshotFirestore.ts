import { FieldPath, getFirestore } from 'firebase-admin/firestore';

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

export function hasDisplayContent(recipe: CompleteCanonicalRecipeV2): boolean {
  return recipe.content.title.trim().length > 0
    && recipe.content.originalServings > 0
    && recipe.content.ingredients.length > 0
    && recipe.content.instructions.length > 0
    && recipe.content.instructions.every(({ text }) => text.trim().length > 0)
    && Buffer.byteLength(JSON.stringify(recipe), 'utf8') <= 900_000;
}

async function loadInventoryRecipes(
  inventoryIds: Set<string>,
): Promise<Map<string, CanonicalRecipeV2>> {
  const db = getFirestore();
  const recipes = new Map<string, CanonicalRecipeV2>();
  let cursor: string | undefined;
  while (true) {
    let query = db.collection('recipes')
      .where('schemaVersion', '==', 2)
      .orderBy(FieldPath.documentId())
      .limit(500);
    if (cursor) query = query.startAfter(cursor);
    const snapshot = await query.get();
    for (const document of snapshot.docs) {
      cursor = document.id;
      if (inventoryIds.has(document.id)) {
        recipes.set(document.id, { ...document.data(), id: document.id } as CanonicalRecipeV2);
      }
    }
    if (snapshot.size < 500) return recipes;
  }
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

export async function verifySnapshotInventory(
  inventory: SnapshotInventory,
): Promise<SnapshotVerification> {
  const ids = new Set(Object.values(inventory.bySource)
    .flatMap(({ items }) => items.map(({ id }) => id)));
  const recipes = await loadInventoryRecipes(ids);
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
    for (const item of source.items) {
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
