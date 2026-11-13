import { FieldPath, getFirestore, type Firestore } from 'firebase-admin/firestore';

import { catalogueContentHash } from './contentFingerprint.js';
import type { CompleteCanonicalRecipeV2 } from './domain.js';
import type { ContentEnrichmentStore } from './contentEnrichment.js';
import { CATALOGUE_PARSER_VERSION } from './version.js';
import { isFrozenCatalogueSource } from './sourceAdapters.js';

function completeRecipe(id: string, value: unknown): CompleteCanonicalRecipeV2 | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const recipe = value as Partial<CompleteCanonicalRecipeV2>;
  return recipe.schemaVersion === 2 && (recipe.status === 'ready' || recipe.status === 'review')
    && recipe.content && recipe.classification && recipe.search && recipe.effective
    ? { ...recipe, id } as CompleteCanonicalRecipeV2
    : undefined;
}

export function firestoreContentEnrichmentStore(
  db: Firestore = getFirestore(),
  sourceKeys?: readonly string[],
): ContentEnrichmentStore {
  const selectedSources = sourceKeys?.length ? [...new Set(sourceKeys)] : undefined;
  return {
    async loadCursor(runId) {
      const snapshot = await db.collection('catalogueContentEnrichmentRuns').doc(runId).get();
      const cursor = snapshot.get('cursor');
      return typeof cursor === 'string' && cursor ? cursor : undefined;
    },
    async scan(after, limit) {
      let query = db.collection('catalogueRecipeMigrations') as FirebaseFirestore.Query;
      if (selectedSources) query = query.where('sourceKey', 'in', selectedSources);
      query = query.orderBy(FieldPath.documentId()).limit(limit);
      if (after) query = query.startAfter(after);
      const mappings = await query.get();
      const usable = mappings.docs.flatMap((mapping) => {
        const canonicalId = mapping.get('canonicalRecipeId');
        return typeof canonicalId === 'string' && canonicalId
          ? [{ mapping, canonicalId }]
          : [];
      });
      const references = usable.flatMap(({ mapping, canonicalId }) => [
        db.collection('recipes').doc(mapping.id),
        db.collection('recipes').doc(canonicalId),
      ]);
      const documents = references.length ? await db.getAll(...references) : [];
      const byPath = new Map(documents.map((document) => [document.ref.path, document]));
      return {
        candidates: usable.flatMap(({ mapping, canonicalId }) => {
          const legacy = byPath.get(`recipes/${mapping.id}`);
          const canonical = byPath.get(`recipes/${canonicalId}`);
          const recipe = completeRecipe(canonicalId, canonical?.data());
          const sourceKey = mapping.get('sourceKey');
          return legacy?.exists && recipe && typeof sourceKey === 'string'
            ? [{ mappingCursor: mapping.id, sourceKey, recipe, legacy: legacy.data()! }]
            : [];
        }),
        ...(mappings.docs.at(-1) ? { nextCursor: mappings.docs.at(-1)!.id } : {}),
        exhausted: mappings.size < limit,
        reads: mappings.size + documents.length,
      };
    },
    async write(runId, expectedContentHash, recipe) {
      const reference = db.collection('recipes').doc(recipe.id);
      const backup = db.collection('catalogueContentEnrichmentRuns').doc(runId)
        .collection('backups').doc(recipe.id);
      return db.runTransaction(async (transaction) => {
        const [currentSnapshot, backupSnapshot] = await transaction.getAll(reference, backup);
        const current = completeRecipe(recipe.id, currentSnapshot.data());
        if (!current || catalogueContentHash(current.content) !== expectedContentHash) {
          return 'concurrent' as const;
        }
        if (JSON.stringify(current) === JSON.stringify(recipe)) return 'already-current' as const;
        if (!backupSnapshot.exists) transaction.create(backup, currentSnapshot.data()!);
        transaction.set(reference, recipe);
        return 'written' as const;
      });
    },
    async saveCursor(runId, cursor) {
      await db.collection('catalogueContentEnrichmentRuns').doc(runId).set({
        schemaVersion: 1,
        mode: 'recover-legacy',
        cursor: cursor ?? null,
        updatedAt: new Date().toISOString(),
      }, { merge: true });
    },
    async summarize(runId, summary) {
      await db.collection('catalogueContentEnrichmentRuns').doc(runId).set({
        schemaVersion: 1,
        ...summary,
        updatedAt: new Date().toISOString(),
      }, { merge: true });
    },
  };
}

export interface ContentCoverageAudit {
  mode: 'audit';
  scanned: number;
  estimatedReads: number;
  estimatedRefetches: number;
  estimatedWrites: number;
  totalDocumentBytes: number;
  maximumDocumentBytes: number;
  bySource: Record<string, {
    recipes: number;
    belowParserVersion: number;
    estimatedRefetches: number;
    totalDocumentBytes: number;
    coverage: Record<string, number>;
  }>;
}

export async function runContentCoverageAudit(
  db: Firestore = getFirestore(),
  sourceKeys?: readonly string[],
  maxPerSource = 10_000,
): Promise<ContentCoverageAudit> {
  const selected = sourceKeys ? new Set(sourceKeys) : undefined;
  const result: ContentCoverageAudit = {
    mode: 'audit', scanned: 0, estimatedReads: 0, estimatedRefetches: 0,
    estimatedWrites: 0, totalDocumentBytes: 0, maximumDocumentBytes: 0, bySource: {},
  };
  let cursor: string | undefined;
  for (;;) {
    let query = db.collection('recipes').where('schemaVersion', '==', 2)
      .orderBy(FieldPath.documentId()).limit(250);
    if (cursor) query = query.startAfter(cursor);
    const snapshot = await query.get();
    result.estimatedReads += snapshot.size;
    for (const document of snapshot.docs) {
      const recipe = completeRecipe(document.id, document.data());
      if (!recipe || (selected && !selected.has(recipe.source.key))) continue;
      const source = result.bySource[recipe.source.key] ??= {
        recipes: 0, belowParserVersion: 0, estimatedRefetches: 0,
        totalDocumentBytes: 0, coverage: {},
      };
      if (source.recipes >= maxPerSource) continue;
      source.recipes += 1;
      result.scanned += 1;
      const bytes = Buffer.byteLength(JSON.stringify(document.data()));
      source.totalDocumentBytes += bytes;
      result.totalDocumentBytes += bytes;
      result.maximumDocumentBytes = Math.max(result.maximumDocumentBytes, bytes);
      const fields: Record<string, unknown> = {
        description: recipe.content.description,
        ingredientGroups: recipe.content.ingredientGroups,
        instructionHeaders: recipe.content.instructions.some((step) => step.isHeader),
        stepMedia: recipe.content.instructions.some((step) => step.imageUrl || step.videoEmbedUrl),
        stepTitles: recipe.content.instructions.some((step) => step.title),
        notes: recipe.content.notes,
        noteSections: recipe.content.noteSections,
        attribution: recipe.content.attribution,
        sourceRating: recipe.content.sourceRating,
        equipment: recipe.content.equipment,
        additionalTimes: recipe.content.additionalTimes,
        expandedNutrition: recipe.content.nutrition && Object.keys(recipe.content.nutrition).length > 4,
        dietaryClaims: recipe.content.dietaryClaims,
        cookingMethods: recipe.content.cookingMethods,
        alternateImages: recipe.content.imageUrls && recipe.content.imageUrls.length > 1,
        heroVideo: recipe.content.videoEmbedUrl,
      };
      for (const [field, value] of Object.entries(fields)) {
        if (value && (!Array.isArray(value) || value.length)) {
          source.coverage[field] = (source.coverage[field] ?? 0) + 1;
        }
      }
      if (recipe.classification.parserVersion < CATALOGUE_PARSER_VERSION) {
        source.belowParserVersion += 1;
        if (!isFrozenCatalogueSource(recipe.source.key)) {
          source.estimatedRefetches += 1;
          result.estimatedRefetches += 1;
          result.estimatedWrites += 1;
        }
      }
    }
    cursor = snapshot.docs.at(-1)?.id;
    if (snapshot.size < 250) break;
  }
  return result;
}

export async function repairContentEnrichmentRunMetadata(
  runId: string,
  db: Firestore = getFirestore(),
): Promise<{ scanned: number; repaired: number; concurrent: number }> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(runId)) {
    throw new Error('Invalid content enrichment run id');
  }
  const backups = await db.collection('catalogueContentEnrichmentRuns').doc(runId)
    .collection('backups').get();
  const result = { scanned: backups.size, repaired: 0, concurrent: 0 };
  for (const backupSnapshot of backups.docs) {
    const reference = db.collection('recipes').doc(backupSnapshot.id);
    const outcome = await db.runTransaction(async (transaction) => {
      const currentSnapshot = await transaction.get(reference);
      const current = completeRecipe(reference.id, currentSnapshot.data());
      const backup = completeRecipe(reference.id, backupSnapshot.data());
      if (!current || !backup) return 'concurrent' as const;
      const repaired: CompleteCanonicalRecipeV2 = {
        ...current,
        status: backup.status,
        source: backup.source,
        sourceMetadata: backup.sourceMetadata,
        ...(backup.manualOverrides ? { manualOverrides: backup.manualOverrides } : {}),
        effective: backup.effective,
        search: backup.search,
        classification: {
          ...backup.classification,
          parserVersion: current.classification.parserVersion,
        },
      };
      transaction.set(reference, repaired);
      return 'repaired' as const;
    });
    if (outcome === 'repaired') result.repaired += 1;
    else result.concurrent += 1;
  }
  return result;
}

export async function verifyContentEnrichmentRun(
  runId: string,
  db: Firestore = getFirestore(),
): Promise<{
  backups: number;
  missingCurrent: number;
  metadataMismatches: number;
  coreContentMismatches: number;
  oversizedDocuments: number;
}> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(runId)) {
    throw new Error('Invalid content enrichment run id');
  }
  const backups = await db.collection('catalogueContentEnrichmentRuns').doc(runId)
    .collection('backups').get();
  const currentSnapshots = backups.size
    ? await db.getAll(...backups.docs.map((backup) => db.collection('recipes').doc(backup.id)))
    : [];
  const result = {
    backups: backups.size, missingCurrent: 0, metadataMismatches: 0,
    coreContentMismatches: 0, oversizedDocuments: 0,
  };
  for (let index = 0; index < backups.docs.length; index += 1) {
    const backup = completeRecipe(backups.docs[index].id, backups.docs[index].data());
    const currentSnapshot = currentSnapshots[index];
    const current = completeRecipe(backups.docs[index].id, currentSnapshot?.data());
    if (!backup || !current) { result.missingCurrent += 1; continue; }
    const backupMetadata = {
      status: backup.status, source: backup.source, sourceMetadata: backup.sourceMetadata,
      manualOverrides: backup.manualOverrides, effective: backup.effective, search: backup.search,
      classification: { ...backup.classification, parserVersion: 0 },
    };
    const currentMetadata = {
      status: current.status, source: current.source, sourceMetadata: current.sourceMetadata,
      manualOverrides: current.manualOverrides, effective: current.effective, search: current.search,
      classification: { ...current.classification, parserVersion: 0 },
    };
    if (JSON.stringify(backupMetadata) !== JSON.stringify(currentMetadata)) {
      result.metadataMismatches += 1;
    }
    const core = (recipe: CompleteCanonicalRecipeV2) => ({
      title: recipe.content.title,
      originalServings: recipe.content.originalServings,
      ingredients: recipe.content.ingredients,
      instructions: recipe.content.instructions.filter((step) => !step.isHeader)
        .map((step) => step.text),
    });
    if (JSON.stringify(core(backup)) !== JSON.stringify(core(current))) {
      result.coreContentMismatches += 1;
    }
    if (Buffer.byteLength(JSON.stringify(currentSnapshot.data())) >= 900_000) {
      result.oversizedDocuments += 1;
    }
  }
  return result;
}
