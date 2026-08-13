import { describe, expect, it } from 'vitest';
import { mergeCatalogueSettings } from '../services/catalogueSettings';
import type { HouseholdSettings } from '../services/types';

describe('catalogue settings controls', () => {
  it('updates visible controls without erasing hidden legacy settings', () => {
    const existing: HouseholdSettings = {
      sourceWeights: { 'www.example.com': 1 },
      ingredientWeights: { chicken: 3 },
      selectedSeeds: ['chicken'],
      strictMatching: false,
      kidFriendly: {
        allowedExceptions: ['mustard'],
        maxIngredients: 15,
        excludedIngredients: ['wasabi'],
      },
      defaultAdults: 2,
      defaultChildren: 1,
    };

    const result = mergeCatalogueSettings(existing, {
      sourceWeights: { 'www.example.com': 3 },
      kidFriendly: {
        ...existing.kidFriendly,
        excludedIngredients: ['wasabi', 'anchovy'],
      },
      mealReminders: {
        defrostEnabled: true,
        marinateEnabled: false,
        morningTime: '08:00',
        eveningTime: '19:00',
      },
      defaultAdults: 4,
      defaultChildren: 2,
    });

    expect(result).toMatchObject({
      ingredientWeights: { chicken: 3 },
      selectedSeeds: ['chicken'],
      strictMatching: false,
      sourceWeights: { 'www.example.com': 3 },
      defaultAdults: 4,
      defaultChildren: 2,
      kidFriendly: {
        allowedExceptions: ['mustard'],
        maxIngredients: 15,
        excludedIngredients: ['wasabi', 'anchovy'],
      },
    });
  });
});
