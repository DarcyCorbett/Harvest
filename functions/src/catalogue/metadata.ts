import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { z } from 'zod';

import {
  CUISINES,
  MEAL_TYPES,
  MODIFIERS,
  buildEffectiveMetadata,
  buildSearchFields,
  validateMealTypeCombination,
  validateReadyRecipe,
  type CatalogueTimestamp,
  type CompleteCanonicalRecipeV2,
} from './domain.js';

const resetOperation = z.object({ operation: z.literal('reset') }).strict();
const numberOperation = z.union([
  z.object({ operation: z.literal('set'), value: z.number().int().positive().max(10_080) }).strict(),
  resetOperation,
]);
const listOperation = <Values extends readonly [string, ...string[]]>(
  allowed: Values,
  minimum: number,
) => z.union([
  z.object({
    operation: z.literal('set'),
    value: z.array(z.enum(allowed)).min(minimum).max(allowed.length),
  }).strict(),
  resetOperation,
]);

export const updateCanonicalRecipeMetadataRequestSchema = z.object({
  recipeId: z.string().trim().min(1).max(160),
  operations: z.object({
    prepMinutes: numberOperation.optional(),
    cookMinutes: numberOperation.optional(),
    totalMinutes: numberOperation.optional(),
    mealTypes: listOperation(MEAL_TYPES, 1).optional(),
    cuisines: listOperation(CUISINES, 1).optional(),
    modifiers: listOperation(MODIFIERS, 0).optional(),
  }).strict().refine(
    (operations) => Object.values(operations).some((operation) => operation !== undefined),
    'At least one operation is required',
  ),
}).strict().superRefine((request, context) => {
  const operation = request.operations.mealTypes;
  if (operation?.operation === 'set' && validateMealTypeCombination(operation.value).length > 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['operations', 'mealTypes'],
      message: 'Invalid meal-type combination',
    });
  }
});

export type CanonicalMetadataOperations = z.infer<
  typeof updateCanonicalRecipeMetadataRequestSchema
>['operations'];

function operationValue<T>(
  operation: { operation: 'set'; value: T } | { operation: 'reset' } | undefined,
): T | null | undefined {
  if (!operation) return undefined;
  return operation.operation === 'reset' ? null : operation.value;
}

export function applyCanonicalMetadataOperations(
  recipe: CompleteCanonicalRecipeV2,
  operations: CanonicalMetadataOperations,
  editorUid: string,
  updatedAt: CatalogueTimestamp,
): CompleteCanonicalRecipeV2 {
  const manualOverrides = { ...(recipe.manualOverrides ?? {}) };
  const changedFields: string[] = [];

  for (const field of [
    'prepMinutes',
    'cookMinutes',
    'totalMinutes',
    'mealTypes',
    'cuisines',
    'modifiers',
  ] as const) {
    const value = operationValue(operations[field] as never);
    if (value !== undefined) {
      (manualOverrides as Record<string, unknown>)[field] = value;
      changedFields.push(field);
    }
  }

  manualOverrides.updatedBy = editorUid;
  manualOverrides.updatedAt = updatedAt;
  const effective = buildEffectiveMetadata(recipe.sourceMetadata, manualOverrides);
  const search = buildSearchFields(
    effective,
    recipe.content.ingredients.map((ingredient) => ingredient.name),
    recipe.search.randomKey,
  );
  const sources = { ...recipe.classification.sources };
  changedFields.forEach((field) => { sources[field] = 'manual'; });

  const updated: CompleteCanonicalRecipeV2 = {
    ...recipe,
    manualOverrides,
    effective,
    search,
    classification: { ...recipe.classification, sources },
  };
  if (updated.status === 'ready') {
    const errors = validateReadyRecipe(updated);
    if (errors.length) throw new Error(`Ready recipe invariant failed: ${errors.join(', ')}`);
  }
  return updated;
}

export interface CanonicalMetadataStore {
  update(
    recipeId: string,
    operations: CanonicalMetadataOperations,
    editorUid: string,
  ): Promise<CompleteCanonicalRecipeV2>;
}

export function firestoreCanonicalMetadataStore(): CanonicalMetadataStore {
  const db = getFirestore();
  return {
    update(recipeId, operations, editorUid) {
      const reference = db.collection('recipes').doc(recipeId);
      return db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(reference);
        if (!snapshot.exists) throw new HttpsError('not-found', 'Recipe not found.');
        const recipe = snapshot.data() as CompleteCanonicalRecipeV2;
        if (recipe.schemaVersion !== 2 || !['ready', 'review'].includes(recipe.status)) {
          throw new HttpsError('failed-precondition', 'Recipe cannot be edited.');
        }

        let updated: CompleteCanonicalRecipeV2;
        try {
          updated = applyCanonicalMetadataOperations(
            { ...recipe, id: snapshot.id },
            operations,
            editorUid,
            Timestamp.now(),
          );
        } catch {
          throw new HttpsError('failed-precondition', 'Recipe metadata is inconsistent.');
        }
        transaction.set(reference, updated);
        return updated;
      });
    },
  };
}

type Authorize = (
  auth: CallableRequest<unknown>['auth'],
) => Promise<{ uid: string; email: string }>;

export function createCatalogueMetadataHandlers(dependencies: {
  authorize: Authorize;
  store: CanonicalMetadataStore;
}) {
  return {
    async update(request: CallableRequest<unknown>) {
      const parsed = updateCanonicalRecipeMetadataRequestSchema.safeParse(request.data);
      if (!parsed.success) {
        throw new HttpsError('invalid-argument', 'Invalid catalogue metadata request.');
      }
      const identity = await dependencies.authorize(request.auth);
      return dependencies.store.update(
        parsed.data.recipeId,
        parsed.data.operations,
        identity.uid,
      );
    },
  };
}
