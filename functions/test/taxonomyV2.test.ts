import { describe, expect, it } from 'vitest';

import type { CompleteCanonicalRecipeV2 } from '../src/catalogue/domain.js';
import {
  TAXONOMY_V2_RESPONSE_JSON_SCHEMA,
  buildTaxonomyV2Prompt,
  deriveTaxonomyV2,
  taxonomyV2ResponseSchema,
  type TaxonomyV2Evidence,
} from '../src/catalogue/taxonomyV2.js';
import {
  applyTaxonomyV2Evidence,
  buildTaxonomyRetagShards,
} from '../src/catalogue/taxonomyRetagBatch.js';

function evidence(): TaxonomyV2Evidence {
  return {
    mealType: {
      mode: 'dish',
      roles: {
        breakfast: false, lunch: true, dinner: true, side: false,
        snack: false, dessert: false,
      },
      componentKind: 'none', confidence: 'high', reason: 'Complete meal.',
    },
    kidFriendly: {
      standaloneOrRecognizable: true,
      coreIngredientsAccessible: true,
      broadChildAppeal: true,
      mildOrAdjustable: true,
      easyToEat: true,
      familyPractical: true,
      blocker: 'none', adjustment: null, confidence: 'high', reason: 'Broad appeal.',
    },
    healthy: {
      nutrientDenseAnchor: true,
      meaningfulPlantsOrWholeFoods: true,
      suitableLeanOrPlantProtein: true,
      minimallyProcessed: true,
      sensibleFatAndMethod: true,
      limitedSugarRefinedStarchRichness: true,
      clearlyHealthierVersion: false,
      blocker: 'none', confidence: 'high', reason: 'Balanced meal.',
    },
  };
}

function recipe(): CompleteCanonicalRecipeV2 {
  return {
    schemaVersion: 2,
    id: 'recipe-1',
    status: 'ready',
    source: {
      key: 'source', canonicalUrl: 'https://example.com/r', originalUrl: 'https://example.com/r',
    },
    ingestion: { contentHash: 'content-hash', firstIngestedAt: '2026-01-01' },
    content: {
      title: 'Chicken and vegetables', description: 'Dinner.', originalServings: 4,
      ingredients: [{ name: 'chicken', quantity: 500, unit: 'g' }, { name: 'broccoli' }],
      instructions: [{ text: 'Cook everything.' }],
      nutrition: { calories: 400, protein: 35 },
    },
    sourceMetadata: {
      totalMinutes: 30,
      mealTypes: ['side'], cuisines: ['global'], modifiers: ['vegetarian', 'salad'],
    },
    manualOverrides: { mealTypes: ['dinner'], updatedBy: 'admin' },
    effective: {
      totalMinutes: 30, totalTimeProvenance: 'source',
      mealTypes: ['dinner'], cuisines: ['global'], modifiers: ['vegetarian', 'salad'],
    },
    search: {
      selectionKeys: ['dinner|any', 'dinner|global'],
      vegetarian: true, kidFriendly: false, healthy: false, salad: true,
      quick30: true, moderate45: true, ingredientTokens: ['chicken', 'broccoli'], randomKey: 0.5,
    },
    classification: {
      parserVersion: 3, classifierVersion: 1, taxonomyVersion: 1,
      sources: { mealTypes: 'manual', cuisines: 'source', modifiers: 'source' }, complete: true,
    },
  };
}

describe('taxonomy v2', () => {
  it('publishes a strict combined provider schema', () => {
    expect(TAXONOMY_V2_RESPONSE_JSON_SCHEMA).toMatchObject({
      additionalProperties: false,
      required: ['mealType', 'kidFriendly', 'healthy'],
    });
    expect(taxonomyV2ResponseSchema.safeParse(evidence()).success).toBe(true);
  });

  it('bounds provider text locally when Gemini exceeds declared maxLength', () => {
    const verbose = evidence();
    verbose.kidFriendly.reason = 'x'.repeat(244);
    verbose.kidFriendly.adjustment = 'y'.repeat(164);
    const parsed = taxonomyV2ResponseSchema.parse(verbose);
    expect(parsed.kidFriendly.reason).toHaveLength(240);
    expect(parsed.kidFriendly.adjustment).toHaveLength(160);
  });

  it('allows breakfast dessert and deterministically removes forbidden dessert overlaps', () => {
    const breakfastDessert = evidence();
    breakfastDessert.mealType.roles = {
      breakfast: true, lunch: false, dinner: false, side: false,
      snack: false, dessert: true,
    };
    expect(deriveTaxonomyV2(breakfastDessert).mealTypes).toEqual(['breakfast', 'dessert']);
    breakfastDessert.mealType.roles.lunch = true;
    breakfastDessert.mealType.roles.side = true;
    expect(deriveTaxonomyV2(breakfastDessert).mealTypes).toEqual(['breakfast', 'dessert']);
  });

  it('forces Kid Friendly false for exclusive components while still deriving Healthy', () => {
    const component = evidence();
    component.mealType = {
      mode: 'component',
      roles: {
        breakfast: false, lunch: false, dinner: false, side: false,
        snack: false, dessert: false,
      },
      componentKind: 'sauce-condiment', confidence: 'high', reason: 'Standalone sauce.',
    };
    expect(deriveTaxonomyV2(component)).toEqual({
      mealTypes: ['component'], kidFriendly: false, healthy: true,
    });
  });

  it('maps a dish response with no supported meal role to exclusive component', () => {
    const unassignedPreparation = evidence();
    unassignedPreparation.mealType.roles = {
      breakfast: false, lunch: false, dinner: false, side: false,
      snack: false, dessert: false,
    };
    expect(deriveTaxonomyV2(unassignedPreparation).mealTypes).toEqual(['component']);
    expect(deriveTaxonomyV2(unassignedPreparation).kidFriendly).toBe(false);
  });

  it('includes full recipe content but no stored tags in the prompt', () => {
    const prompt = buildTaxonomyV2Prompt(recipe().content);
    expect(prompt).toContain('500 g chicken');
    expect(prompt).toContain('Cook everything.');
    expect(prompt).not.toContain('vegetarian');
  });

  it('preserves manual overrides, cuisines, non-target modifiers, content, and random keys', () => {
    const before = recipe();
    const updated = applyTaxonomyV2Evidence(before, evidence());
    expect(updated.sourceMetadata).toMatchObject({
      mealTypes: ['lunch', 'dinner'],
      cuisines: ['global'],
      modifiers: ['vegetarian', 'salad', 'kid-friendly', 'healthy'],
    });
    expect(updated.effective.mealTypes).toEqual(['dinner']);
    expect(updated.classification.sources.mealTypes).toBe('manual');
    expect(updated.classification.sources.modifiers).toBe('ai');
    expect(updated.content).toBe(before.content);
    expect(updated.ingestion).toBe(before.ingestion);
    expect(updated.search.randomKey).toBe(0.5);
    expect(updated.classification).toMatchObject({ classifierVersion: 2, taxonomyVersion: 2 });
  });

  it('builds deterministic combined-prompt batch shards with content hashes', () => {
    const candidate = { id: 'b', contentHash: 'hash-b', content: recipe().content };
    const first = buildTaxonomyRetagShards([candidate, { ...candidate, id: 'a', contentHash: 'hash-a' }]);
    const second = buildTaxonomyRetagShards([{ ...candidate, id: 'a', contentHash: 'hash-a' }, candidate]);
    expect(first.map(({ jsonl }) => jsonl)).toEqual(second.map(({ jsonl }) => jsonl));
    expect(first[0].manifest.split('\n')[0]).toContain('hash-a');
    expect(first[0].jsonl).toContain('"thinkingLevel":"minimal"');
    expect(first[0].jsonl).toContain('"kidFriendly"');
  });
});
