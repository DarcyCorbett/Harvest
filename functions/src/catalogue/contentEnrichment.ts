import { catalogueContentHash } from './contentFingerprint.js';
import type {
  CanonicalIngredientGroup,
  CanonicalInstructionStep,
  CompleteCanonicalRecipeV2,
} from './domain.js';
import { reconcileOccurrences } from './ingredientReconciliation.js';

type UnknownRecord = Record<string, unknown>;

export interface LegacyEnrichmentCandidate {
  mappingCursor: string;
  sourceKey: string;
  recipe: CompleteCanonicalRecipeV2;
  legacy: UnknownRecord;
}

export interface ContentEnrichmentPage {
  candidates: LegacyEnrichmentCandidate[];
  nextCursor?: string;
  exhausted: boolean;
  reads: number;
}

export interface ContentEnrichmentStore {
  loadCursor(runId: string): Promise<string | undefined>;
  scan(after: string | undefined, limit: number): Promise<ContentEnrichmentPage>;
  write(
    runId: string,
    expectedContentHash: string,
    recipe: CompleteCanonicalRecipeV2,
  ): Promise<'written' | 'concurrent' | 'already-current'>;
  saveCursor(runId: string, cursor: string | undefined): Promise<void>;
  summarize(runId: string, summary: ContentEnrichmentSummary): Promise<void>;
}

export interface ContentEnrichmentSummary {
  mode: 'recover-legacy';
  dryRun: boolean;
  scannedMappings: number;
  estimatedReads: number;
  candidates: number;
  unchanged: number;
  alignmentFailures: number;
  written: number;
  concurrent: number;
  estimatedWrites: number;
  estimatedBackupWrites: number;
  estimatedByteDelta: number;
  bySource: Record<string, {
    scanned: number;
    candidates: number;
    alignmentFailures: number;
    estimatedByteDelta: number;
  }>;
  complete: boolean;
  nextCursor?: string;
}

function record(value: unknown): UnknownRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalized(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function legacyGroups(value: unknown): CanonicalIngredientGroup[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const groups = value.flatMap((raw) => {
    const group = record(raw);
    if (!group || !Array.isArray(group.ingredients)) return [];
    const ingredients = group.ingredients.flatMap((rawIngredient) => {
      const ingredient = record(rawIngredient);
      const name = text(ingredient?.name);
      if (!name) return [];
      const quantity = typeof ingredient?.quantity === 'number' && Number.isFinite(ingredient.quantity)
        ? ingredient.quantity : undefined;
      const unit = text(ingredient?.unit);
      const notes = text(ingredient?.notes);
      return [{ name, ...(quantity !== undefined ? { quantity } : {}), ...(unit ? { unit } : {}), ...(notes ? { notes } : {}) }];
    });
    return ingredients.length ? [{ name: text(group.name) ?? '', ingredients }] : [];
  });
  return groups.length ? groups : undefined;
}

function legacyInstructions(value: unknown): CanonicalInstructionStep[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const steps = value.flatMap((raw) => {
    if (typeof raw === 'string') return text(raw) ? [{ text: text(raw)! }] : [];
    const step = record(raw);
    const stepText = text(step?.text);
    if (!stepText) return [];
    return [{
      text: stepText,
      ...(text(step?.title) ? { title: text(step?.title) } : {}),
      ...(text(step?.sourceUrl) ? { sourceUrl: text(step?.sourceUrl) } : {}),
      ...(text(step?.imageUrl) ? { imageUrl: text(step?.imageUrl) } : {}),
      ...(text(step?.videoEmbedUrl) ? { videoEmbedUrl: text(step?.videoEmbedUrl) } : {}),
      ...(step?.isHeader === true ? { isHeader: true } : {}),
    }];
  });
  return steps.length ? steps : undefined;
}

function alignedGroups(
  groups: CanonicalIngredientGroup[],
  recipe: CompleteCanonicalRecipeV2,
): { aligned: boolean; alignedGroups?: CanonicalIngredientGroup[]; alignedIngredients?: CompleteCanonicalRecipeV2['content']['ingredients'] } {
  const flattened = groups.flatMap((group) => group.ingredients);
  if (flattened.length !== recipe.content.ingredients.length) return { aligned: false };
  const reconciliation = reconcileOccurrences(recipe.content.ingredients, flattened);
  if (!reconciliation.isCompleteBijection) return { aligned: false };

  const alignedIngredients = recipe.content.ingredients.map((rootIng, rIdx) => {
    const gIdx = reconciliation.matchedRootToGrouped[rIdx];
    const matchedGrouped = flattened[gIdx];
    return {
      ...rootIng,
      ...(matchedGrouped.notes ? { notes: matchedGrouped.notes } : {}),
    };
  });

  return { aligned: true, alignedGroups: groups, alignedIngredients };
}

function mergeAlignedInstructions(
  current: CanonicalInstructionStep[],
  legacy: CanonicalInstructionStep[],
): CanonicalInstructionStep[] | undefined {
  const currentSteps = current.filter((step) => !step.isHeader);
  const legacySteps = legacy.filter((step) => !step.isHeader);
  if (currentSteps.length !== legacySteps.length || currentSteps.some((step, index) => (
    normalized(step.text) !== normalized(legacySteps[index].text)
  ))) return undefined;
  let index = 0;
  const structure = current.some((step) => step.isHeader) ? current : legacy;
  return structure.map((step) => {
    if (step.isHeader) return step;
    const currentStep = currentSteps[index];
    const legacyStep = legacySteps[index++];
    return {
      ...currentStep,
      ...(!currentStep.title && legacyStep.title ? { title: legacyStep.title } : {}),
      ...(!currentStep.sourceUrl && legacyStep.sourceUrl ? { sourceUrl: legacyStep.sourceUrl } : {}),
      ...(!currentStep.imageUrl && legacyStep.imageUrl ? { imageUrl: legacyStep.imageUrl } : {}),
      ...(!currentStep.videoEmbedUrl && legacyStep.videoEmbedUrl
        ? { videoEmbedUrl: legacyStep.videoEmbedUrl }
        : {}),
    };
  });
}

export function recoverLegacyContent(
  recipe: CompleteCanonicalRecipeV2,
  legacy: UnknownRecord,
  now = new Date().toISOString(),
): { status: 'unchanged' | 'candidate' | 'alignment-failure'; recipe?: CompleteCanonicalRecipeV2; byteDelta?: number } {
  const content = { ...recipe.content };
  const groups = legacyGroups(legacy.ingredientGroups);
  let alignmentFailure = false;
  if (!content.ingredientGroups && groups) {
    const alignment = alignedGroups(groups, recipe);
    if (alignment.aligned && alignment.alignedGroups && alignment.alignedIngredients) {
      content.ingredientGroups = alignment.alignedGroups;
      content.ingredients = alignment.alignedIngredients;
    } else {
      alignmentFailure = true;
    }
  }
  const instructions = legacyInstructions(legacy.instructions);
  if (instructions) {
    const merged = mergeAlignedInstructions(content.instructions, instructions);
    if (merged) content.instructions = merged;
    else if (instructions.some((step) => step.isHeader || step.imageUrl || step.videoEmbedUrl || step.title)) {
      alignmentFailure = true;
    }
  }
  const imageUrl = text(legacy.imageUrl);
  const videoEmbedUrl = text(legacy.videoEmbedUrl);
  const description = text(legacy.description);
  const notes = text(legacy.notes);
  if (!content.imageUrl && imageUrl) content.imageUrl = imageUrl;
  if (!content.videoEmbedUrl && videoEmbedUrl) content.videoEmbedUrl = videoEmbedUrl;
  if (!content.description && description) content.description = description;
  if (!content.notes && notes) content.notes = notes;
  if (record(legacy.nutrition)) {
    content.nutrition = { ...legacy.nutrition as CompleteCanonicalRecipeV2['content']['nutrition'], ...content.nutrition };
  }

  if (JSON.stringify(content) === JSON.stringify(recipe.content)) {
    return { status: alignmentFailure ? 'alignment-failure' : 'unchanged' };
  }
  const next: CompleteCanonicalRecipeV2 = {
    ...recipe,
    content,
    ingestion: {
      ...recipe.ingestion,
      contentHash: catalogueContentHash(content),
      lastChangedAt: now,
    },
  };
  return {
    status: 'candidate',
    recipe: next,
    byteDelta: Buffer.byteLength(JSON.stringify(next)) - Buffer.byteLength(JSON.stringify(recipe)),
  };
}

export async function runLegacyContentRecovery(options: {
  runId: string;
  store: ContentEnrichmentStore;
  dryRun?: boolean;
  sourceKeys?: readonly string[];
  maxPerSource?: number;
  writeCap?: number;
  pageSize?: number;
  startAfter?: string;
}): Promise<ContentEnrichmentSummary> {
  const dryRun = options.dryRun ?? true;
  const writeCap = options.writeCap ?? 1_000;
  const pageSize = options.pageSize ?? 100;
  const maxPerSource = options.maxPerSource ?? 10_000;
  if (!options.runId || !Number.isInteger(writeCap) || writeCap < 0 || writeCap > 18_000
    || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 250
    || !Number.isInteger(maxPerSource) || maxPerSource < 1 || maxPerSource > 10_000) {
    throw new Error('Invalid content enrichment options');
  }
  const sourceKeys = options.sourceKeys ? new Set(options.sourceKeys) : undefined;
  let cursor = options.startAfter ?? (!dryRun ? await options.store.loadCursor(options.runId) : undefined);
  let exhausted = false;
  const summary: ContentEnrichmentSummary = {
    mode: 'recover-legacy', dryRun, scannedMappings: 0, estimatedReads: 0,
    candidates: 0, unchanged: 0, alignmentFailures: 0, written: 0, concurrent: 0,
    estimatedWrites: 0, estimatedBackupWrites: 0, estimatedByteDelta: 0,
    bySource: {}, complete: false,
  };
  while (!exhausted) {
    const page = await options.store.scan(cursor, pageSize);
    summary.estimatedReads += page.reads;
    exhausted = page.exhausted;
    let processedCursor = cursor;
    let capped = false;
    const richestByRecipe = new Map<string, LegacyEnrichmentCandidate>();
    for (const candidate of page.candidates) {
      const prior = richestByRecipe.get(candidate.recipe.id);
      if (!prior || JSON.stringify(candidate.legacy).length > JSON.stringify(prior.legacy).length) {
        richestByRecipe.set(candidate.recipe.id, candidate);
      }
    }
    for (const candidate of richestByRecipe.values()) {
      if (sourceKeys && !sourceKeys.has(candidate.sourceKey)) {
        processedCursor = candidate.mappingCursor;
        continue;
      }
      const source = summary.bySource[candidate.sourceKey] ??= {
        scanned: 0, candidates: 0, alignmentFailures: 0, estimatedByteDelta: 0,
      };
      if (source.scanned >= maxPerSource) {
        processedCursor = candidate.mappingCursor;
        continue;
      }
      source.scanned += 1;
      summary.scannedMappings += 1;
      const transformed = recoverLegacyContent(candidate.recipe, candidate.legacy);
      if (transformed.status === 'unchanged') {
        summary.unchanged += 1;
        processedCursor = candidate.mappingCursor;
        continue;
      }
      if (transformed.status === 'alignment-failure') {
        summary.alignmentFailures += 1;
        source.alignmentFailures += 1;
        processedCursor = candidate.mappingCursor;
        continue;
      }
      summary.candidates += 1;
      source.candidates += 1;
      summary.estimatedWrites += 1;
      summary.estimatedBackupWrites += 1;
      summary.estimatedByteDelta += transformed.byteDelta ?? 0;
      source.estimatedByteDelta += transformed.byteDelta ?? 0;
      if (dryRun) {
        processedCursor = candidate.mappingCursor;
        continue;
      }
      if ((summary.written + 1) * 2 > writeCap) { capped = true; break; }
      const outcome = await options.store.write(
        options.runId,
        catalogueContentHash(candidate.recipe.content),
        transformed.recipe!,
      );
      if (outcome === 'written') summary.written += 1;
      else if (outcome === 'concurrent') summary.concurrent += 1;
      else summary.unchanged += 1;
      processedCursor = candidate.mappingCursor;
    }
    cursor = capped ? processedCursor : page.nextCursor;
    if (!dryRun) await options.store.saveCursor(options.runId, cursor);
    if (capped) { exhausted = false; break; }
  }
  summary.complete = exhausted;
  if (cursor) summary.nextCursor = cursor;
  if (!dryRun) await options.store.summarize(options.runId, summary);
  return summary;
}
