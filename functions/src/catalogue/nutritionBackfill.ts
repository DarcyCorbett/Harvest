import type { CompleteCanonicalRecipeV2 } from './domain.js';
import { CatalogueParseError, parseCatalogueRecipe } from './parser.js';
import type { RecipeSourceAdapter } from './sourceAdapters.js';

export function hasMeaningfulCanonicalNutrition(
  recipe: Pick<CompleteCanonicalRecipeV2, 'content'>,
): boolean {
  return Boolean(recipe.content.nutrition && Object.values(recipe.content.nutrition)
    .some((value) => typeof value === 'number' && Number.isFinite(value) && value > 0));
}

export interface NutritionRefreshWork {
  sourceKeys: string[];
  targetUrls: Record<string, string[]>;
  candidates: number;
}

export interface NutritionCanarySourceSummary {
  sourceKey: string;
  tested: number;
  nutritionFound: number;
  unavailable: number;
  transient: number;
  terminal: number;
  reasonCodes: string[];
}

export interface NutritionCanarySummary {
  mode: 'nutrition-canary';
  bySource: Record<string, NutritionCanarySourceSummary>;
}

function boundedReason(error: unknown): string {
  const name = error instanceof CatalogueParseError
    ? error.reasonCode
    : error instanceof Error
      ? error.name
      : 'unknown';
  return name.replace(/[^a-z0-9-]/gi, '-').toLowerCase().slice(0, 80) || 'unknown';
}

export async function runNutritionCanaries(options: {
  adapters: readonly RecipeSourceAdapter[];
  targetUrls: Readonly<Record<string, readonly string[]>>;
}): Promise<NutritionCanarySummary> {
  const bySource: Record<string, NutritionCanarySourceSummary> = {};
  for (const adapter of options.adapters) {
    const urls = options.targetUrls[adapter.sourceKey] ?? [];
    const reasons = new Set<string>();
    const summary: NutritionCanarySourceSummary = {
      sourceKey: adapter.sourceKey,
      tested: 0,
      nutritionFound: 0,
      unavailable: 0,
      transient: 0,
      terminal: 0,
      reasonCodes: [],
    };
    for (const url of urls) {
      summary.tested += 1;
      try {
        const fetched = await adapter.fetch(url);
        if (fetched.kind === 'retryable') {
          summary.transient += 1;
          reasons.add(`http-${fetched.status}`);
          continue;
        }
        if (fetched.kind !== 'ok') {
          summary.terminal += 1;
          reasons.add(`http-${fetched.status}`);
          continue;
        }
        let parsed;
        try {
          parsed = parseCatalogueRecipe(fetched.html, url);
        } catch (initialError) {
          if (!adapter.render || initialError instanceof CatalogueParseError
            && initialError.reasonCode === 'non-recipe-page') throw initialError;
          const rendered = await adapter.render(url);
          if (!rendered) throw initialError;
          parsed = parseCatalogueRecipe(rendered, url);
        }
        if (hasMeaningfulCanonicalNutrition({ content: parsed.content })) {
          summary.nutritionFound += 1;
        } else {
          summary.unavailable += 1;
        }
      } catch (error) {
        if (error instanceof CatalogueParseError) summary.terminal += 1;
        else summary.transient += 1;
        reasons.add(boundedReason(error));
      }
    }
    summary.reasonCodes = [...reasons].slice(0, 10);
    bySource[adapter.sourceKey] = summary;
  }
  return { mode: 'nutrition-canary', bySource };
}
