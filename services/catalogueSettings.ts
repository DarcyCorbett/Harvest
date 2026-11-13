import type { HouseholdSettings, KidFriendlySettings } from './types';

type CatalogueSettingsControls = Pick<
  HouseholdSettings,
  'sourceWeights' | 'mealReminders' | 'defaultAdults' | 'defaultChildren' | 'nutritionTargets'
> & {
  kidFriendly?: KidFriendlySettings;
  excludedIngredients?: string[];
};

/**
 * Merge catalogue-facing controls into the stored household settings without
 * discarding fields retained for a possible legacy rollback.
 */
export function mergeCatalogueSettings(
  existing: HouseholdSettings,
  controls: CatalogueSettingsControls,
): HouseholdSettings {
  return {
    ...existing,
    ...controls,
  };
}
