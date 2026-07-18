import { createHash } from 'node:crypto';

import {
  buildEffectiveMetadata,
  buildSearchFields,
  canonicalRecipeId,
  canonicalizeRecipeUrl,
  CUISINES,
  MEAL_TYPES,
  MODIFIERS,
  validateReadyRecipe,
  type CatalogueTimestamp,
  type CanonicalIngredient,
  type CanonicalIngredientGroup,
  type CanonicalInstructionStep,
  type CompleteCanonicalRecipeV2,
  type Cuisine,
  type MealType,
  type Modifier,
} from './domain.js';
import { SOURCE_CONFIGS } from './sourceAdapters.js';

export const LEGACY_MIGRATION_REASON_CODES = [
  'invalid-source-url',
  'unsupported-source',
  'invalid-title',
  'missing-ingredients',
  'invalid-ingredients',
  'missing-instructions',
  'invalid-instructions',
  'invalid-servings',
  'missing-total-time',
  'missing-meal-type',
  'missing-cuisine',
  'classification-incomplete',
  'invalid-search-fields',
  'document-limits',
] as const;

export type LegacyMigrationReasonCode = typeof LEGACY_MIGRATION_REASON_CODES[number];
export type LegacyMigrationMappingState = 'migrated' | 'linked-existing' | 'failed';
export type LegacyMigrationTargetDisposition = 'create' | 'linked-existing' | 'collision';

export interface LegacyMigrationInput {
  legacyRecipeId: string;
  data: Record<string, unknown>;
  runId: string;
  timestamp: CatalogueTimestamp;
}

export interface LegacyMigrationMappingProposal {
  schemaVersion: 1;
  legacyRecipeId: string;
  /** Omitted only when a canonical URL could not be derived. */
  canonicalRecipeId?: string;
  /** Omitted only when the canonical host did not resolve through SOURCE_CONFIGS. */
  sourceKey?: string;
  state: LegacyMigrationMappingState;
  targetStatus?: 'ready' | 'review';
  reasonCodes: LegacyMigrationReasonCode[];
  contentHash?: string;
  runId: string;
  createdAt: CatalogueTimestamp;
  updatedAt: CatalogueTimestamp;
}

export type LegacyMigrationConversionResult =
  | {
      kind: 'success';
      recipe: CompleteCanonicalRecipeV2;
      mapping: LegacyMigrationMappingProposal;
    }
  | { kind: 'failure'; mapping: LegacyMigrationMappingProposal };

function strings(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return typeof value === 'string' ? [value] : [];
}

function minutes(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  const iso = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/i.exec(normalized);
  if (iso) {
    const result = (Number(iso[1] ?? 0) * 1_440)
      + (Number(iso[2] ?? 0) * 60)
      + Number(iso[3] ?? 0);
    return Number.isInteger(result) && result > 0 ? result : undefined;
  }
  const hours = /(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|hr)\b/i.exec(normalized);
  const minutePart = /(\d+)\s*(?:minutes?|mins?|min)\b/i.exec(normalized);
  const result = (hours ? Number(hours[1]) * 60 : 0) + (minutePart ? Number(minutePart[1]) : 0);
  return Number.isInteger(result) && result > 0 ? result : undefined;
}

function normalizedLabels(data: Record<string, unknown>): string[] {
  return [
    ...strings(data.course),
    ...strings(data.cuisine),
    ...strings(data.tags),
  ].map((value) => value.trim().toLowerCase());
}

function taxonomy(data: Record<string, unknown>): {
  mealTypes: MealType[];
  cuisines: Cuisine[];
  modifiers: Modifier[];
} {
  const labels = normalizedLabels(data);
  const has = (...aliases: string[]) => labels.some((label) =>
    aliases.some((alias) => label === alias || label.includes(alias)));
  const mealAliases: Record<MealType, string[]> = {
    breakfast: ['breakfast', 'brunch'],
    lunch: ['lunch'],
    dinner: ['main course', 'dinner'],
    side: ['side'],
    snack: ['snack'],
  };
  const cuisineAliases: Record<Cuisine, string[]> = {
    asian: ['asian', 'chinese', 'japanese', 'thai', 'vietnamese', 'korean'],
    mexican: ['mexican', 'tex-mex'],
    mediterranean: ['mediterranean'],
    italian: ['italian'],
    indian: ['indian'],
    greek: ['greek'],
    american: ['american'],
    french: ['french'],
    'middle-eastern': ['middle eastern', 'middle-eastern', 'levantine'],
    global: ['global', 'international'],
  };
  const modifierAliases: Record<Modifier, string[]> = {
    vegetarian: ['vegetarian', 'meatless'],
    'kid-friendly': ['kid friendly', 'kid-friendly', 'family friendly', 'family-friendly'],
    healthy: ['healthy', 'wholesome'],
    salad: ['salad'],
  };
  return {
    mealTypes: MEAL_TYPES.filter((value) => has(...mealAliases[value])),
    cuisines: CUISINES.filter((value) => has(...cuisineAliases[value])),
    modifiers: MODIFIERS.filter((value) => has(...modifierAliases[value])),
  };
}

function randomKey(id: string): number {
  return Number.parseInt(id.slice(0, 13), 16) / 0xfffffffffffff;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: unknown): string {
  return createHash('sha256').update(stableJson(value), 'utf8').digest('hex');
}

function orderedReasonCodes(
  reasons: readonly LegacyMigrationReasonCode[],
): LegacyMigrationReasonCode[] {
  const requested = new Set(reasons);
  return LEGACY_MIGRATION_REASON_CODES.filter((reason) => requested.has(reason));
}

function reviewReasonCodes(errors: readonly string[]): LegacyMigrationReasonCode[] {
  const reasons: LegacyMigrationReasonCode[] = [];
  if (errors.includes('effective.totalMinutes')) reasons.push('missing-total-time');
  if (errors.includes('effective.mealTypes')) reasons.push('missing-meal-type');
  if (errors.includes('effective.cuisines')) reasons.push('missing-cuisine');
  if (errors.includes('classification.complete')) reasons.push('classification-incomplete');
  if (errors.some((error) => error === 'search')) reasons.push('invalid-search-fields');
  if (errors.some((error) => error.startsWith('firestore.'))) reasons.push('document-limits');
  return orderedReasonCodes(reasons);
}

function failedMapping(
  input: LegacyMigrationInput,
  reasonCode: LegacyMigrationReasonCode,
  identity: { canonicalRecipeId?: string; sourceKey?: string } = {},
): LegacyMigrationConversionResult {
  return {
    kind: 'failure',
    mapping: {
      schemaVersion: 1,
      legacyRecipeId: input.legacyRecipeId,
      ...identity,
      state: 'failed',
      reasonCodes: orderedReasonCodes([reasonCode]),
      runId: input.runId,
      createdAt: input.timestamp,
      updatedAt: input.timestamp,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export type ExistingMigrationTarget = Record<string, unknown> | {
  exists: boolean;
  data(): Record<string, unknown> | undefined;
} | undefined;

export function resolveMigrationTargetDisposition(
  proposed: CompleteCanonicalRecipeV2,
  existingTarget: ExistingMigrationTarget,
): LegacyMigrationTargetDisposition {
  if (existingTarget === undefined) return 'create';
  let existingData: Record<string, unknown> | undefined;
  if ('exists' in existingTarget && typeof existingTarget.exists === 'boolean') {
    if (!existingTarget.exists) return 'create';
    existingData = typeof existingTarget.data === 'function'
      ? existingTarget.data()
      : undefined;
  } else {
    existingData = existingTarget;
  }
  if (!isRecord(existingData)) return 'collision';
  const source = existingData.source;
  return existingData.schemaVersion === 2
    && isRecord(source)
    && source.canonicalUrl === proposed.source.canonicalUrl
    ? 'linked-existing'
    : 'collision';
}

function canonicalIngredient(value: unknown): CanonicalIngredient | undefined {
  if (!isRecord(value) || typeof value.name !== 'string' || !value.name.trim()) return undefined;
  if (value.quantity !== undefined
    && (typeof value.quantity !== 'number' || !Number.isFinite(value.quantity))) return undefined;
  if (value.unit !== undefined && typeof value.unit !== 'string') return undefined;
  if (value.notes !== undefined && typeof value.notes !== 'string') return undefined;
  return {
    name: value.name.trim(),
    ...(value.quantity === undefined ? {} : { quantity: value.quantity }),
    ...(value.unit === undefined ? {} : { unit: value.unit }),
    ...(value.notes === undefined ? {} : { notes: value.notes }),
  };
}

function canonicalIngredients(
  value: unknown,
  allowAbsent = false,
): CanonicalIngredient[] | undefined {
  if (value === undefined && allowAbsent) return [];
  if (!Array.isArray(value)) return undefined;
  const ingredients = value.map(canonicalIngredient);
  return ingredients.some((ingredient) => ingredient === undefined)
    ? undefined
    : ingredients as CanonicalIngredient[];
}

function canonicalInstructions(value: unknown): CanonicalInstructionStep[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  const instructions = value.map((instruction) => {
    if (!isRecord(instruction)
      || typeof instruction.text !== 'string'
      || !instruction.text.trim()) return undefined;
    const validOptionalHttpsUrl = (url: unknown) => {
      if (url === undefined) return true;
      if (typeof url !== 'string' || url.length > 2_048) return false;
      try {
        return new URL(url).protocol === 'https:';
      } catch {
        return false;
      }
    };
    if (!validOptionalHttpsUrl(instruction.imageUrl)
      || !validOptionalHttpsUrl(instruction.videoEmbedUrl)
      || (instruction.isHeader !== undefined && typeof instruction.isHeader !== 'boolean')) {
      return undefined;
    }
    return {
      text: instruction.text.trim(),
      ...(instruction.imageUrl === undefined ? {} : { imageUrl: instruction.imageUrl as string }),
      ...(instruction.videoEmbedUrl === undefined
        ? {}
        : { videoEmbedUrl: instruction.videoEmbedUrl as string }),
      ...(instruction.isHeader === undefined ? {} : { isHeader: instruction.isHeader as boolean }),
    };
  });
  return instructions.some((instruction) => instruction === undefined)
    ? undefined
    : instructions as CanonicalInstructionStep[];
}

function canonicalIngredientGroups(value: unknown): CanonicalIngredientGroup[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  const groups = value.map((group) => {
    if (!isRecord(group) || typeof group.name !== 'string') return undefined;
    const ingredients = canonicalIngredients(group.ingredients);
    if (!ingredients) return undefined;
    return { name: group.name, ingredients };
  });
  return groups.some((group) => group === undefined)
    ? undefined
    : groups as CanonicalIngredientGroup[];
}

export function convertLegacyRecipe(input: LegacyMigrationInput): LegacyMigrationConversionResult {
  let canonicalUrl: string;
  try {
    canonicalUrl = canonicalizeRecipeUrl(
      typeof input.data.sourceUrl === 'string' ? input.data.sourceUrl : '',
    );
  } catch {
    return failedMapping(input, 'invalid-source-url');
  }
  const parsedUrl = new URL(canonicalUrl);
  const id = canonicalRecipeId(canonicalUrl);
  const source = SOURCE_CONFIGS.find((config) => config.host === parsedUrl.hostname);
  if (parsedUrl.protocol !== 'https:') {
    return failedMapping(input, 'invalid-source-url', {
      canonicalRecipeId: id,
      ...(source ? { sourceKey: source.sourceKey } : {}),
    });
  }
  if (!source) return failedMapping(input, 'unsupported-source', { canonicalRecipeId: id });
  const identity = { canonicalRecipeId: id, sourceKey: source.sourceKey };
  const title = typeof input.data.title === 'string' ? input.data.title.trim() : '';
  if (!title) return failedMapping(input, 'invalid-title', identity);
  const rootIngredients = canonicalIngredients(input.data.ingredients, true);
  const ingredientGroups = canonicalIngredientGroups(input.data.ingredientGroups);
  if (!rootIngredients || !ingredientGroups) {
    return failedMapping(input, 'invalid-ingredients', identity);
  }
  const ingredients = rootIngredients.length > 0
    ? rootIngredients
    : ingredientGroups.flatMap((group) => group.ingredients);
  if (ingredients.length === 0) return failedMapping(input, 'missing-ingredients', identity);
  const instructions = canonicalInstructions(input.data.instructions);
  if (!instructions) return failedMapping(input, 'invalid-instructions', identity);
  if (instructions.length === 0) return failedMapping(input, 'missing-instructions', identity);
  const originalServings = typeof input.data.originalServings === 'number'
    ? input.data.originalServings
    : Number.NaN;
  if (!(Number.isFinite(originalServings) && originalServings > 0)) {
    return failedMapping(input, 'invalid-servings', identity);
  }
  const classification = taxonomy(input.data);
  const sourceMetadata = {
    ...(minutes(input.data.prepTime) ? { prepMinutes: minutes(input.data.prepTime) } : {}),
    ...(minutes(input.data.cookTime) ? { cookMinutes: minutes(input.data.cookTime) } : {}),
    ...(minutes(input.data.totalTime) ? { totalMinutes: minutes(input.data.totalTime) } : {}),
    ...classification,
  };
  const effective = buildEffectiveMetadata(sourceMetadata);
  const content = {
    title,
    ...(typeof input.data.imageUrl === 'string' ? { imageUrl: input.data.imageUrl } : {}),
    ...(typeof input.data.videoEmbedUrl === 'string'
      ? { videoEmbedUrl: input.data.videoEmbedUrl }
      : {}),
    ...(typeof input.data.description === 'string' ? { description: input.data.description } : {}),
    originalServings,
    ingredients,
    ...(ingredientGroups.length ? { ingredientGroups } : {}),
    instructions,
    ...(typeof input.data.notes === 'string' ? { notes: input.data.notes } : {}),
    ...(input.data.nutrition && typeof input.data.nutrition === 'object'
      ? { nutrition: input.data.nutrition as Record<string, unknown> }
      : {}),
  };
  const contentHash = sha256(content);
  const recipe: CompleteCanonicalRecipeV2 = {
    schemaVersion: 2,
    id,
    status: 'ready',
    source: { key: source.sourceKey, canonicalUrl, originalUrl: String(input.data.sourceUrl) },
    ingestion: {
      contentHash,
      firstIngestedAt: input.timestamp,
      lastChangedAt: input.timestamp,
      lastAttemptAt: input.timestamp,
      retryCount: 0,
    },
    content,
    sourceMetadata,
    effective,
    search: buildSearchFields(
      effective,
      content.ingredients.map((ingredient) => ingredient.name),
      randomKey(id),
    ),
    classification: {
      parserVersion: 0,
      taxonomyVersion: 1,
      sources: {
        mealTypes: classification.mealTypes.length ? 'source' : 'rule',
        cuisines: classification.cuisines.length ? 'source' : 'rule',
        modifiers: classification.modifiers.length ? 'source' : 'rule',
      },
      complete: effective.mealTypes.length > 0 && effective.cuisines.length > 0,
    },
  };
  const validationErrors = [
    ...validateReadyRecipe(recipe),
    ...(effective.cuisines.length === 0 ? ['effective.cuisines'] : []),
  ];
  if (validationErrors.length) recipe.status = 'review';
  return {
    kind: 'success',
    recipe,
    mapping: {
      schemaVersion: 1,
      legacyRecipeId: input.legacyRecipeId,
      canonicalRecipeId: id,
      sourceKey: source.sourceKey,
      state: 'migrated',
      targetStatus: recipe.status,
      reasonCodes: reviewReasonCodes(validationErrors),
      contentHash,
      runId: input.runId,
      createdAt: input.timestamp,
      updatedAt: input.timestamp,
    },
  };
}
