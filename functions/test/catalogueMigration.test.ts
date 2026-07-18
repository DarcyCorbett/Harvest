import { describe, expect, it } from 'vitest';

import {
  LEGACY_MIGRATION_REASON_CODES,
  convertLegacyRecipe,
  resolveMigrationTargetDisposition,
  type LegacyMigrationMappingState,
} from '../src/catalogue/migration.js';
import type { CompleteCanonicalRecipeV2 } from '../src/catalogue/domain.js';
import { SOURCE_CONFIGS } from '../src/catalogue/sourceAdapters.js';

const timestamp = '2026-07-18T08:00:00.000Z';

function legacyRecipe(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Chicken soup',
    sourceUrl: 'https://WWW.RECIPETINEATS.COM/chicken-soup/?utm_source=legacy#recipe',
    description: 'A warming soup.',
    imageUrl: 'https://images.example/soup.jpg',
    videoEmbedUrl: 'https://videos.example/soup',
    prepTime: '10 minutes',
    cookTime: '20 mins',
    totalTime: '30 minutes',
    originalServings: 4,
    course: ['Main Course'],
    cuisine: 'Mediterranean',
    tags: ['Healthy'],
    ingredients: [{ name: 'Chicken breasts', quantity: 2, unit: '', notes: 'diced' }],
    instructions: [{ text: 'Simmer until cooked.' }],
    notes: 'Serve warm.',
    nutrition: { calories: 250, protein: 30, carbs: 12, fat: 8 },
    ...overrides,
  };
}

describe('legacy catalogue conversion', () => {
  it('exports the complete migration mapping state contract', () => {
    const states: LegacyMigrationMappingState[] = ['migrated', 'linked-existing', 'failed'];
    expect(states).toEqual(['migrated', 'linked-existing', 'failed']);
  });
  it('converts valid legacy content into a ready schema-v2 recipe and migrated mapping', () => {
    const result = convertLegacyRecipe({
      legacyRecipeId: 'legacy-1',
      data: legacyRecipe(),
      runId: 'migration-run-1',
      timestamp,
    });

    expect(result.kind).toBe('success');
    if (result.kind !== 'success') return;
    expect(result.recipe).toMatchObject({
      schemaVersion: 2,
      status: 'ready',
      source: {
        key: 'recipetineats',
        canonicalUrl: 'https://www.recipetineats.com/chicken-soup',
      },
      content: {
        title: 'Chicken soup',
        originalServings: 4,
      },
      sourceMetadata: {
        prepMinutes: 10,
        cookMinutes: 20,
        totalMinutes: 30,
        mealTypes: ['dinner'],
        cuisines: ['mediterranean'],
        modifiers: ['healthy'],
      },
      classification: {
        parserVersion: 0,
        taxonomyVersion: 1,
        sources: {
          mealTypes: 'source',
          cuisines: 'source',
          modifiers: 'source',
        },
        complete: true,
      },
    });
    expect(result.mapping).toMatchObject({
      schemaVersion: 1,
      legacyRecipeId: 'legacy-1',
      state: 'migrated',
      targetStatus: 'ready',
      reasonCodes: [],
      runId: 'migration-run-1',
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  });

  it('returns a complete review proposal with bounded reasons when time and meal type are missing', () => {
    const result = convertLegacyRecipe({
      legacyRecipeId: 'legacy-review',
      data: legacyRecipe({ prepTime: '', cookTime: '', totalTime: undefined, course: [], tags: [] }),
      runId: 'migration-run-1',
      timestamp,
    });

    expect(result.kind).toBe('success');
    if (result.kind !== 'success') return;
    expect(result.recipe.status).toBe('review');
    expect(result.recipe.classification.complete).toBe(false);
    expect(result.mapping).toMatchObject({
      state: 'migrated',
      targetStatus: 'review',
      reasonCodes: ['missing-total-time', 'missing-meal-type', 'classification-incomplete'],
    });
  });

  it('returns review for cuisine-less content while keeping time and meal classification distinct', () => {
    const result = convertLegacyRecipe({
      legacyRecipeId: 'legacy-no-cuisine',
      data: legacyRecipe({ cuisine: undefined }),
      runId: 'migration-run-1',
      timestamp,
    });

    expect(result.kind).toBe('success');
    if (result.kind !== 'success') return;
    expect(result.recipe).toMatchObject({
      status: 'review',
      classification: {
        complete: false,
        sources: {
          mealTypes: 'source',
          cuisines: 'rule',
          modifiers: 'source',
        },
      },
    });
    expect(result.mapping.reasonCodes).toEqual([
      'missing-cuisine',
      'classification-incomplete',
    ]);
    expect(result.mapping.reasonCodes).not.toContain('missing-total-time');
  });

  it.each([
    ['not a URL', 'invalid-source-url'],
    ['https://recipes.example/chicken-soup', 'unsupported-source'],
    ['http://www.recipetineats.com/chicken-soup', 'invalid-source-url'],
  ])('returns only a failed mapping for unusable source URL %s', (sourceUrl, reasonCode) => {
    const result = convertLegacyRecipe({
      legacyRecipeId: 'legacy-bad-url',
      data: legacyRecipe({ sourceUrl }),
      runId: 'migration-run-1',
      timestamp,
    });

    expect(result).toMatchObject({
      kind: 'failure',
      mapping: {
        schemaVersion: 1,
        legacyRecipeId: 'legacy-bad-url',
        state: 'failed',
        reasonCodes: [reasonCode],
        runId: 'migration-run-1',
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    });
    if (sourceUrl.startsWith('http')) {
      expect(result.mapping.canonicalRecipeId).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it.each(SOURCE_CONFIGS)(
    'resolves approved host $host to source key $sourceKey without external requests',
    ({ host, sourceKey }) => {
      const result = convertLegacyRecipe({
        legacyRecipeId: `legacy-${sourceKey}`,
        data: legacyRecipe({ sourceUrl: `https://${host}/synthetic-migration-recipe` }),
        runId: 'migration-run-1',
        timestamp,
      });

      expect(result.kind).toBe('success');
      expect(result.mapping.sourceKey).toBe(sourceKey);
    },
  );

  it.each([
    [{ title: '   ' }, 'invalid-title'],
    [{ ingredients: [{ name: ' ' }] }, 'invalid-ingredients'],
    [{ instructions: [{ text: '' }] }, 'invalid-instructions'],
    [{ originalServings: 0 }, 'invalid-servings'],
  ])('returns a failed mapping for structurally undisplayable content: %o', (overrides, reasonCode) => {
    const result = convertLegacyRecipe({
      legacyRecipeId: 'legacy-invalid-content',
      data: legacyRecipe(overrides),
      runId: 'migration-run-1',
      timestamp,
    });

    expect(result.kind).toBe('failure');
    expect(result.mapping).toMatchObject({
      state: 'failed',
      reasonCodes: [reasonCode],
      canonicalRecipeId: expect.stringMatching(/^[a-f0-9]{64}$/),
      sourceKey: 'recipetineats',
    });
    expect('recipe' in result).toBe(false);
  });

  it.each([
    [{ ingredients: [] }, 'missing-ingredients'],
    [{ ingredients: undefined }, 'missing-ingredients'],
    [{ instructions: [] }, 'missing-instructions'],
    [{ instructions: undefined }, 'missing-instructions'],
    [{
      ingredients: [
        { name: 'Onion', quantity: 1, unit: '' },
        { name: '', quantity: 1, unit: '' },
      ],
    }, 'invalid-ingredients'],
    [{
      ingredientGroups: [{
        name: 'Sauce',
        ingredients: [{ name: ' ', quantity: 1, unit: '' }],
      }],
    }, 'invalid-ingredients'],
    [{ instructions: [{ text: 'Cook.' }, null] }, 'invalid-instructions'],
  ])('fails closed without silently dropping malformed display entries: %o', (overrides, reasonCode) => {
    const result = convertLegacyRecipe({
      legacyRecipeId: 'legacy-malformed-content',
      data: legacyRecipe(overrides),
      runId: 'migration-run-1',
      timestamp,
    });

    expect(result.kind).toBe('failure');
    expect(result.mapping.reasonCodes).toEqual([reasonCode]);
  });

  it('trims required ingredient names and instruction text in canonical content', () => {
    const result = convertLegacyRecipe({
      legacyRecipeId: 'legacy-trimmed-content',
      data: legacyRecipe({
        ingredients: [{ name: '  Chicken  ', quantity: 2, unit: '' }],
        instructions: [{ text: '  Cook thoroughly.  ' }],
      }),
      runId: 'migration-run-1',
      timestamp,
    });

    expect(result.kind).toBe('success');
    if (result.kind !== 'success') return;
    expect(result.recipe.content.ingredients[0].name).toBe('Chicken');
    expect(result.recipe.content.instructions[0].text).toBe('Cook thoroughly.');
  });

  it('preserves valid per-instruction display metadata exactly', () => {
    const instruction = {
      text: '  Cook thoroughly.  ',
      imageUrl: 'https://images.example/step.jpg',
      videoEmbedUrl: 'https://videos.example/step',
      isHeader: true,
    };
    const result = convertLegacyRecipe({
      legacyRecipeId: 'legacy-instruction-display',
      data: legacyRecipe({ instructions: [instruction] }),
      runId: 'migration-run-1',
      timestamp,
    });

    expect(result.kind).toBe('success');
    if (result.kind !== 'success') return;
    expect(result.recipe.content.instructions).toEqual([{
      ...instruction,
      text: 'Cook thoroughly.',
    }]);
  });

  it.each([
    ['imageUrl', 'http://images.example/step.jpg'],
    ['imageUrl', 42],
    ['videoEmbedUrl', 'javascript:alert(1)'],
    ['videoEmbedUrl', {}],
    ['isHeader', 'true'],
  ])('rejects malformed optional instruction field %s: %o', (field, value) => {
    const result = convertLegacyRecipe({
      legacyRecipeId: 'legacy-invalid-instruction-display',
      data: legacyRecipe({ instructions: [{ text: 'Cook.', [field]: value }] }),
      runId: 'migration-run-1',
      timestamp,
    });

    expect(result.kind).toBe('failure');
    expect(result.mapping.reasonCodes).toEqual(['invalid-instructions']);
  });

  it('stores a trimmed title and hashes normalized title whitespace deterministically', () => {
    const first = convertLegacyRecipe({
      legacyRecipeId: 'legacy-title-a',
      data: legacyRecipe({ title: '  Chicken soup  ' }),
      runId: 'migration-run-1',
      timestamp,
    });
    const second = convertLegacyRecipe({
      legacyRecipeId: 'legacy-title-b',
      data: legacyRecipe({ title: 'Chicken soup' }),
      runId: 'migration-run-1',
      timestamp,
    });

    expect(first.kind).toBe('success');
    expect(second.kind).toBe('success');
    if (first.kind !== 'success' || second.kind !== 'success') return;
    expect(first.recipe.content.title).toBe('Chicken soup');
    expect(first.mapping.contentHash).toBe(second.mapping.contentHash);
  });

  it.each([
    ['45 minutes', 45],
    ['1 hour 30 minutes', 90],
    ['2 hrs', 120],
    ['PT1H15M', 75],
  ])('parses the legacy total-time format %s', (totalTime, expectedMinutes) => {
    const result = convertLegacyRecipe({
      legacyRecipeId: `legacy-time-${expectedMinutes}`,
      data: legacyRecipe({ prepTime: '', cookTime: '', totalTime }),
      runId: 'migration-run-1',
      timestamp,
    });

    expect(result.kind).toBe('success');
    if (result.kind !== 'success') return;
    expect(result.recipe.sourceMetadata.totalMinutes).toBe(expectedMinutes);
    expect(result.recipe.status).toBe('ready');
  });

  it('maps course, cuisine, and tag aliases case-insensitively into the fixed taxonomy', () => {
    const result = convertLegacyRecipe({
      legacyRecipeId: 'legacy-taxonomy',
      data: legacyRecipe({
        course: ['BREAKFAST/BRUNCH', 'Lunch', 'Side', 'Snack', 'DINNER'],
        cuisine: 'ChInEsE',
        tags: [
          'Tex-Mex', 'Mediterranean', 'Italian', 'Indian', 'Greek', 'American',
          'French', 'Middle Eastern', 'Global', 'VEGETARIAN', 'Kid Friendly',
          'HEALTHY', 'Salad',
        ],
      }),
      runId: 'migration-run-1',
      timestamp,
    });

    expect(result.kind).toBe('success');
    if (result.kind !== 'success') return;
    expect(result.recipe.sourceMetadata).toMatchObject({
      mealTypes: ['breakfast', 'lunch', 'dinner', 'side', 'snack'],
      cuisines: [
        'asian', 'mexican', 'mediterranean', 'italian', 'indian', 'greek',
        'american', 'french', 'middle-eastern', 'global',
      ],
      modifiers: ['vegetarian', 'kid-friendly', 'healthy', 'salad'],
    });
  });

  it('derives the same canonical ID, random key, and normalized content hash deterministically', () => {
    const first = convertLegacyRecipe({
      legacyRecipeId: 'legacy-a',
      data: legacyRecipe(),
      runId: 'run-a',
      timestamp,
    });
    const second = convertLegacyRecipe({
      legacyRecipeId: 'legacy-b',
      data: legacyRecipe({
        sourceUrl: 'https://www.recipetineats.com/chicken-soup#different',
        nutrition: { fat: 8, carbs: 12, protein: 30, calories: 250 },
      }),
      runId: 'run-b',
      timestamp: '2026-07-19T08:00:00.000Z',
    });

    expect(first.kind).toBe('success');
    expect(second.kind).toBe('success');
    if (first.kind !== 'success' || second.kind !== 'success') return;
    expect(second.recipe.id).toBe(first.recipe.id);
    expect(second.recipe.search.randomKey).toBe(first.recipe.search.randomKey);
    expect(second.mapping.contentHash).toBe(first.mapping.contentHash);
  });

  it('preserves ingredient groups and all supported legacy display fields', () => {
    const ingredientGroups = [{
      name: 'Sauce',
      ingredients: [{ name: 'Olive oil', quantity: 2, unit: 'tbsp', notes: 'extra virgin' }],
    }];
    const result = convertLegacyRecipe({
      legacyRecipeId: 'legacy-display',
      data: legacyRecipe({ ingredientGroups }),
      runId: 'migration-run-1',
      timestamp,
    });

    expect(result.kind).toBe('success');
    if (result.kind !== 'success') return;
    expect(result.recipe.content).toEqual({
      title: 'Chicken soup',
      imageUrl: 'https://images.example/soup.jpg',
      videoEmbedUrl: 'https://videos.example/soup',
      description: 'A warming soup.',
      originalServings: 4,
      ingredients: [{ name: 'Chicken breasts', quantity: 2, unit: '', notes: 'diced' }],
      ingredientGroups,
      instructions: [{ text: 'Simmer until cooked.' }],
      notes: 'Serve warm.',
      nutrition: { calories: 250, protein: 30, carbs: 12, fat: 8 },
    });
  });

  it('accepts group-only ingredients as displayable canonical content', () => {
    const groupedIngredient = { name: 'Olive oil', quantity: 2, unit: 'tbsp' };
    const result = convertLegacyRecipe({
      legacyRecipeId: 'legacy-group-only',
      data: legacyRecipe({
        ingredients: [],
        ingredientGroups: [{ name: 'Sauce', ingredients: [groupedIngredient] }],
      }),
      runId: 'migration-run-1',
      timestamp,
    });

    expect(result.kind).toBe('success');
    if (result.kind !== 'success') return;
    expect(result.recipe.content.ingredients).toEqual([groupedIngredient]);
    expect(result.recipe.content.ingredientGroups).toEqual([
      { name: 'Sauce', ingredients: [groupedIngredient] },
    ]);
  });

  it('emits only reason codes from the bounded migration vocabulary', () => {
    const result = convertLegacyRecipe({
      legacyRecipeId: 'legacy-reasons',
      data: legacyRecipe({ sourceUrl: 'invalid' }),
      runId: 'migration-run-1',
      timestamp,
    });

    expect(result.mapping.reasonCodes.every((reason) =>
      LEGACY_MIGRATION_REASON_CODES.includes(reason))).toBe(true);
  });
});

describe('migration target disposition', () => {
  function proposedRecipe(): CompleteCanonicalRecipeV2 {
    const result = convertLegacyRecipe({
      legacyRecipeId: 'legacy-target',
      data: legacyRecipe(),
      runId: 'migration-run-1',
      timestamp,
    });
    if (result.kind !== 'success') throw new Error('fixture conversion failed');
    return result.recipe;
  }

  it('creates when the target is absent', () => {
    expect(resolveMigrationTargetDisposition(proposedRecipe(), undefined)).toBe('create');
    expect(resolveMigrationTargetDisposition(proposedRecipe(), {
      exists: false,
      data: () => undefined,
    })).toBe('create');
  });

  it('links an existing schema-v2 target with the same canonical URL', () => {
    const proposed = proposedRecipe();
    expect(resolveMigrationTargetDisposition(proposed, {
      exists: true,
      data: () => ({
        schemaVersion: 2,
        source: { canonicalUrl: proposed.source.canonicalUrl },
      }),
    })).toBe('linked-existing');
  });

  it.each([
    { schemaVersion: 2, source: { canonicalUrl: 'https://www.recipetineats.com/other' } },
    { schemaVersion: 1, source: { canonicalUrl: 'https://www.recipetineats.com/chicken-soup' } },
    { arbitrary: true },
  ])('reports a collision for an occupied incompatible target: %o', (existing) => {
    expect(resolveMigrationTargetDisposition(proposedRecipe(), existing)).toBe('collision');
  });
});
