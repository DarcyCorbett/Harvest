import { describe, expect, it, vi } from 'vitest';

import {
  classifyCatalogueDeterministically,
  createCatalogueClassifier,
} from '../src/catalogue/classifier.js';

const content = {
  title: 'Mediterranean chicken salad',
  originalServings: 4,
  ingredients: [{ name: 'chicken' }, { name: 'lettuce' }],
  instructions: [{ text: 'Cook and toss.' }],
};

function evidence(overrides: { healthy?: boolean; kid?: boolean } = {}) {
  return {
    mealType: {
      mode: 'dish',
      roles: {
        breakfast: false, lunch: true, dinner: true, side: false,
        snack: false, dessert: false,
      },
      componentKind: 'none', confidence: 'high', reason: 'A complete lunch or dinner.',
    },
    kidFriendly: {
      standaloneOrRecognizable: true,
      coreIngredientsAccessible: true,
      broadChildAppeal: overrides.kid ?? true,
      mildOrAdjustable: true,
      easyToEat: true,
      familyPractical: true,
      blocker: 'none', adjustment: null, confidence: 'high', reason: 'Broadly appealing.',
    },
    healthy: {
      nutrientDenseAnchor: overrides.healthy ?? true,
      meaningfulPlantsOrWholeFoods: true,
      suitableLeanOrPlantProtein: true,
      minimallyProcessed: true,
      sensibleFatAndMethod: true,
      limitedSugarRefinedStarchRichness: true,
      clearlyHealthierVersion: false,
      blocker: 'none', confidence: 'high', reason: 'Balanced and minimally processed.',
    },
  };
}

describe('catalogue classification', () => {
  it('leaves deterministic output at version zero until the full taxonomy-v2 pass runs', () => {
    expect(classifyCatalogueDeterministically(content, {
      mealTypes: ['dinner'], cuisines: ['mediterranean'], modifiers: [],
    })).toMatchObject({
      classifierVersion: 0,
      complete: true,
      metadata: { modifiers: ['salad'] },
    });
  });

  it('always applies the combined taxonomy-v2 pass while preserving cuisines and non-target modifiers', async () => {
    const requestJson = vi.fn(async () => evidence());
    const classify = createCatalogueClassifier({ requestJson });
    const result = await classify(content, {
      totalMinutes: 30,
      mealTypes: ['side'],
      cuisines: ['mediterranean'],
      modifiers: ['vegetarian', 'salad'],
    });

    expect(requestJson).toHaveBeenCalledOnce();
    expect(requestJson.mock.calls[0][1]).toMatchObject({
      required: ['mealType', 'kidFriendly', 'healthy'],
    });
    expect(result).toMatchObject({
      classifierVersion: 2,
      metadata: {
        mealTypes: ['lunch', 'dinner'],
        cuisines: ['mediterranean'],
        modifiers: ['vegetarian', 'salad', 'kid-friendly', 'healthy'],
      },
      sources: { mealTypes: 'ai', cuisines: 'source', modifiers: 'ai' },
      complete: true,
    });
  });

  it('uses a separate cuisine-only fallback only when cuisine is missing', async () => {
    const requestJson = vi.fn()
      .mockResolvedValueOnce({ cuisines: ['global'] })
      .mockResolvedValueOnce(evidence({ kid: false, healthy: false }));
    const classify = createCatalogueClassifier({ requestJson });
    const result = await classify({ ...content, title: 'Grandma\'s special' }, {
      totalMinutes: 40, mealTypes: [], cuisines: [], modifiers: [],
    });

    expect(requestJson).toHaveBeenCalledTimes(2);
    expect(result.metadata.cuisines).toEqual(['global']);
    expect(result.sources.cuisines).toBe('ai');
  });

  it('fails closed on invalid combined evidence', async () => {
    const classify = createCatalogueClassifier({ requestJson: vi.fn(async () => ({})) });
    await expect(classify(content, {
      mealTypes: ['dinner'], cuisines: ['global'], modifiers: [],
    })).rejects.toThrow();
  });
});
