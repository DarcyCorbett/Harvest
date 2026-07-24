import {
  buildCatalogueSelectionRequest,
  buildCatalogueSelectionRequestForSlots,
  catalogueClient,
  materializeCatalogueMeals,
} from './catalogueClient';
import type {
  GenerateConfig,
  GeneratedMeal,
} from './types';

export type GenerationProgressCallback = (
  message: string,
  current: number,
  total: number,
) => void;

export type RegenerateConfig = Pick<
  GenerateConfig,
  | 'cuisineStyles'
  | 'customInstructions'
  | 'ingredientFilters'
  | 'adults'
  | 'children'
  | 'settings'
>;

function requiredServings(adults: number, children: number): number {
  return Math.ceil((adults + children * 0.5) * 2) / 2;
}

function localDate(value: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day);
}

export function createCatalogueGenerator(dependencies: {
  select: typeof catalogueClient.select;
  getHistory: (
    householdId: string,
    planStartDate: Date,
  ) => Promise<{ currentPlanRecipeIds: string[]; recentRecipeIds: string[] }>;
  loadRecipe: (recipeId: string) => Promise<GeneratedMeal['recipe'] | null>;
}) {
  return {
    async generate(
      config: GenerateConfig,
      householdId: string,
      onProgress: GenerationProgressCallback,
    ): Promise<GeneratedMeal[]> {
      const total = config.numberOfDays * config.mealTypes.length;
      onProgress('Selecting exact catalogue matches…', 0, total);
      const history = await dependencies.getHistory(householdId, config.startDate);
      const request = buildCatalogueSelectionRequest(
        config,
        householdId,
        history.currentPlanRecipeIds,
        history.recentRecipeIds,
      );
      const response = await dependencies.select(request);
      const meals = await materializeCatalogueMeals(
        response,
        dependencies.loadRecipe,
        requiredServings(config.adults, config.children),
      );
      onProgress('Recipes ready to review…', total, total);
      return meals;
    },

    async regenerate(
      meals: GeneratedMeal[],
      indicesToRegenerate: number[],
      config: RegenerateConfig,
      householdId: string,
      onProgress: GenerationProgressCallback,
    ): Promise<GeneratedMeal[]> {
      const indices = [...new Set(indicesToRegenerate)].sort((left, right) => left - right);
      if (indices.length === 0 || indices.some((index) => index < 0 || index >= meals.length)) {
        throw new Error('Invalid regeneration selection.');
      }
      onProgress('Selecting replacement recipes…', 0, indices.length);
      const earliestDate = indices
        .map((index) => meals[index].date)
        .sort()[0];
      const history = await dependencies.getHistory(householdId, localDate(earliestDate));
      const request = buildCatalogueSelectionRequestForSlots(
        config,
        householdId,
        indices.map((index) => ({
          date: meals[index].date,
          mealType: meals[index].mealType,
        })),
        [
          ...history.currentPlanRecipeIds,
          ...meals.map((meal) => meal.recipeId),
        ],
        history.recentRecipeIds,
      );
      const response = await dependencies.select(request);
      const replacements = await materializeCatalogueMeals(
        response,
        dependencies.loadRecipe,
        requiredServings(config.adults, config.children),
      );
      const updated = [...meals];
      indices.forEach((index, replacementIndex) => {
        updated[index] = replacements[replacementIndex];
      });
      onProgress('Replacement recipes ready…', indices.length, indices.length);
      return updated;
    },
  };
}

const generator = createCatalogueGenerator({
  select: catalogueClient.select,
  async getHistory(householdId, planStartDate) {
    const { getGenerationRecipeHistory } = await import('./firestoreService');
    return getGenerationRecipeHistory(householdId, planStartDate);
  },
  async loadRecipe(recipeId) {
    const { getRecipe } = await import('./firestoreService');
    return getRecipe(recipeId);
  },
});

export const generateCatalogueMealPlan = generator.generate;
export const regenerateCatalogueMeals = generator.regenerate;
