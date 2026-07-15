import { createHash } from 'node:crypto';

import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { HttpsError, type CallableRequest } from 'firebase-functions/v2/https';

import {
  saveLegacyRecipeRequest,
  updateLegacyRecipeMetadataRequest,
  type QuotaEndpoint,
} from '../ai/contracts.js';

const TRUSTED_HOSTS = new Set([
  'www.recipetineats.com',
  'www.budgetbytes.com',
  'thewoksoflife.com',
  'www.themediterraneandish.com',
  'www.spendwithpennies.com',
  'cafedelites.com',
  'www.skinnytaste.com',
  'pinchofyum.com',
  'natashaskitchen.com',
  'www.seriouseats.com',
  'akispetretzikis.com',
  'cooking.nytimes.com',
  'www.americastestkitchen.com',
]);

// Temporary compatibility boundary for the pre-catalogue generator.
// Remove these callables when Phase 5 cuts generation over to catalogue-only reads.

type Identity = { uid: string; email: string };
type Authorize = (
  auth: CallableRequest<unknown>['auth'],
  householdId: string,
) => Promise<Identity>;
type Reserve = (
  uid: string,
  endpoint: QuotaEndpoint,
  units: number,
) => Promise<number>;
type LegacyRecipe = ReturnType<typeof saveLegacyRecipeRequest.parse>['recipe'];
type LegacyMetadata = Omit<
  ReturnType<typeof updateLegacyRecipeMetadataRequest.parse>,
  'householdId' | 'recipeId'
>;

export interface LegacyRecipeStore {
  create(recipe: LegacyRecipe): Promise<string>;
  update(recipeId: string, metadata: LegacyMetadata): Promise<void>;
}

export interface LegacyRecipeDocuments {
  createIfMissing(
    recipeId: string,
    recipe: LegacyRecipe,
  ): Promise<{ sourceUrl: unknown }>;
  update(recipeId: string, metadata: LegacyMetadata): Promise<void>;
}

function normalizeLegacySourceUrl(sourceUrl: string): string {
  const normalized = new URL(sourceUrl);
  normalized.hash = '';
  return normalized.toString();
}

function deterministicLegacyRecipeId(normalizedSourceUrl: string): string {
  const digest = createHash('sha256')
    .update(normalizedSourceUrl, 'utf8')
    .digest('hex');
  return `legacy_${digest}`;
}

export function createLegacyRecipeStore(
  documents: LegacyRecipeDocuments,
): LegacyRecipeStore {
  return {
    async create(recipe) {
      const normalizedSourceUrl = normalizeLegacySourceUrl(recipe.sourceUrl);
      const recipeId = deterministicLegacyRecipeId(normalizedSourceUrl);
      const existing = await documents.createIfMissing(recipeId, {
        ...recipe,
        sourceUrl: normalizedSourceUrl,
      });

      let existingSourceUrl: string;
      try {
        if (typeof existing.sourceUrl !== 'string') throw new Error('missing');
        existingSourceUrl = normalizeLegacySourceUrl(existing.sourceUrl);
      } catch {
        throw new HttpsError('internal', 'Recipe storage unavailable.');
      }
      if (existingSourceUrl !== normalizedSourceUrl) {
        throw new HttpsError('internal', 'Recipe storage unavailable.');
      }

      return recipeId;
    },

    update(recipeId, metadata) {
      return documents.update(recipeId, metadata);
    },
  };
}

export function firestoreLegacyRecipeStore(): LegacyRecipeStore {
  const db = getFirestore();
  const documents: LegacyRecipeDocuments = {
    async createIfMissing(recipeId, recipe) {
      const reference = db.collection('recipes').doc(recipeId);
      return db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(reference);
        if (snapshot.exists) {
          return { sourceUrl: snapshot.get('sourceUrl') };
        }

        transaction.create(reference, {
          ...recipe,
          scrapedAt: FieldValue.serverTimestamp(),
          legacyWriteBridge: true,
        });
        return { sourceUrl: recipe.sourceUrl };
      });
    },

    async update(recipeId, metadata) {
      await db.collection('recipes').doc(recipeId).update({
        ...metadata,
        legacyMetadataUpdatedAt: FieldValue.serverTimestamp(),
      });
    },
  };

  return createLegacyRecipeStore(documents);
}

export function createLegacyRecipeHandlers(dependencies: {
  authorize: Authorize;
  reserve: Reserve;
  create: LegacyRecipeStore['create'];
  update: LegacyRecipeStore['update'];
}) {
  return {
    save: async (request: CallableRequest<unknown>) => {
      const parsed = saveLegacyRecipeRequest.safeParse(request.data);
      if (!parsed.success) {
        throw new HttpsError('invalid-argument', 'Invalid recipe.');
      }

      const source = new URL(parsed.data.recipe.sourceUrl);
      if (
        source.protocol !== 'https:'
        || !TRUSTED_HOSTS.has(source.hostname.toLowerCase())
      ) {
        throw new HttpsError('invalid-argument', 'Untrusted recipe source.');
      }

      const identity = await dependencies.authorize(
        request.auth,
        parsed.data.householdId,
      );
      await dependencies.reserve(identity.uid, 'legacyRecipeCreate', 1);

      return {
        recipeId: await dependencies.create(parsed.data.recipe),
      };
    },

    update: async (request: CallableRequest<unknown>) => {
      const parsed = updateLegacyRecipeMetadataRequest.safeParse(request.data);
      if (!parsed.success) {
        throw new HttpsError('invalid-argument', 'Invalid recipe metadata.');
      }

      const identity = await dependencies.authorize(
        request.auth,
        parsed.data.householdId,
      );
      await dependencies.reserve(identity.uid, 'legacyRecipeMetadata', 1);

      const { householdId: _householdId, recipeId, ...metadata } = parsed.data;
      await dependencies.update(recipeId, metadata);
      return { recipeId };
    },
  };
}
