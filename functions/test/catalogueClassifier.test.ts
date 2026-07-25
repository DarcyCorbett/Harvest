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

describe('catalogue classification', () => {
  it('marks deterministic classifications current only when required taxonomy is complete', () => {
    expect(classifyCatalogueDeterministically(content, {
      mealTypes: ['dinner'],
      cuisines: ['mediterranean'],
      modifiers: [],
    })).toMatchObject({
      classifierVersion: 1,
      complete: true,
      metadata: { modifiers: ['salad'] },
    });

    expect(classifyCatalogueDeterministically(
      { ...content, title: 'Unknown dish' },
      { mealTypes: ['dinner'], cuisines: [], modifiers: [] },
    )).toMatchObject({
      classifierVersion: 0,
      complete: false,
    });
  });

  it('uses source fields and deterministic rules without Gemini when classification is complete', async () => {
    const requestJson = vi.fn();
    const classify = createCatalogueClassifier({ requestJson });

    const result = await classify(content, {
      totalMinutes: 30,
      mealTypes: ['dinner'],
      cuisines: ['mediterranean'],
      modifiers: ['healthy'],
    });

    expect(requestJson).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      metadata: {
        mealTypes: ['dinner'],
        cuisines: ['mediterranean'],
        modifiers: ['healthy', 'salad'],
      },
      complete: true,
    });
  });

  it('uses one strict structured Gemini call only for ambiguous controlled fields', async () => {
    const requestJson = vi.fn(async () => ({
      mealTypes: ['lunch'],
      cuisines: ['global'],
      modifiers: ['kid-friendly'],
    }));
    const classify = createCatalogueClassifier({ requestJson });

    const result = await classify({ ...content, title: 'Grandma\'s special' }, {
      totalMinutes: 40,
      mealTypes: [],
      cuisines: [],
      modifiers: [],
    });

    expect(requestJson).toHaveBeenCalledOnce();
    expect(result.metadata).toMatchObject({
      mealTypes: ['lunch'],
      cuisines: ['global'],
      modifiers: ['kid-friendly'],
    });
    expect(result.sources).toMatchObject({
      mealTypes: 'ai',
      cuisines: 'ai',
      modifiers: 'ai',
    });
  });

  it('does not use Gemini when only optional modifiers are empty', async () => {
    const requestJson = vi.fn();
    const classify = createCatalogueClassifier({ requestJson });

    const result = await classify({ ...content, title: 'Chicken bake' }, {
      mealTypes: ['dinner'], cuisines: ['mediterranean'], modifiers: [],
    });

    expect(requestJson).not.toHaveBeenCalled();
    expect(result.metadata.modifiers).toEqual([]);
    expect(result.sources.modifiers).toBe('rule');
    expect(result.complete).toBe(true);
  });

  it('fails closed on an invalid structured classification', async () => {
    const classify = createCatalogueClassifier({
      requestJson: vi.fn(async () => ({ mealTypes: ['supper'], cuisines: [], modifiers: [] })),
    });

    await expect(classify({ ...content, title: 'Unknown dish' }, {
      mealTypes: [], cuisines: [], modifiers: [],
    })).rejects.toThrow('Invalid catalogue classification');
  });
});
