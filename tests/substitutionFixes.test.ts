import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { formatIngredientAmount, prefillQuantity } from '../utils/ingredientFormat';

const read = (path: string) => readFileSync(path, 'utf8');

describe('ingredient swaps', () => {
  it('pre-fills the replacement amount from the scaled ingredient', () => {
    expect(prefillQuantity(1.3333333)).toBe('1.33');
    expect(prefillQuantity(250)).toBe('250');
    expect(prefillQuantity(undefined)).toBe('');
    expect(prefillQuantity(0)).toBe('');
  });

  it('explains how to apply a swap when there is no planned meal yet, instead of ending in blank space', () => {
    const drawer = read('components/connected/SubstitutionDrawer.tsx');
    expect(drawer).toContain('{!meal && (');
    expect(drawer).toContain('Swaps are saved to a planned meal.');
    expect(drawer).toContain('setQuantity(prefillQuantity(occurrence.ingredient.quantity));');
  });

  it('opens draft recipes at the draft slot servings', () => {
    const screen = read('components/connected/GenerateScreen.tsx');
    expect(screen).toContain('setPreviewServings(slot.servings);');
    expect(screen).toContain('defaultServings={previewServings}');
  });
});

describe('ingredient amounts', () => {
  it('reads fractions of a unit as singular', () => {
    expect(formatIngredientAmount(0.25, 'cup')).toBe('¼ cup');
    expect(formatIngredientAmount(2, 'cup')).toBe('2 cups');
  });
});
