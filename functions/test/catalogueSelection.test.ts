import type { CallableRequest } from 'firebase-functions/v2/https';
import { describe, expect, it, vi } from 'vitest';

import {
  createCatalogueSelectionHandlers,
  selectCatalogueRecipes,
  type CatalogueCandidate,
  type CatalogueSelectionStore,
  type SelectCatalogueRecipesRequest,
} from '../src/catalogue/selection.js';

const AUTH = { uid: 'u1', token: { email: 'member@example.com' } } as never;

function request(data: unknown): CallableRequest<unknown> {
  return { auth: AUTH, data } as CallableRequest<unknown>;
}

function candidate(id: string, sourceKey: string, overrides: Partial<CatalogueCandidate> = {}): CatalogueCandidate {
  return {
    id,
    sourceKey,
    totalMinutes: 30,
    mealTypes: ['dinner'],
    cuisines: ['mediterranean'],
    modifiers: ['healthy'],
    ingredientTokens: ['chicken', 'olive', 'oil'],
    randomKey: 0.5,
    ...overrides,
  };
}

function selectionRequest(overrides: Partial<SelectCatalogueRecipesRequest> = {}): SelectCatalogueRecipesRequest {
  return {
    householdId: 'h1',
    slots: [{
      date: '2026-07-20',
      mealType: 'dinner',
      cuisines: ['mediterranean'],
      modifiers: ['healthy'],
      maxTotalMinutes: 30,
      ingredients: { must: ['chicken'], prefer: [], exclude: [] },
    }],
    currentPlanRecipeIds: [],
    recentRecipeIds: [],
    ...overrides,
  };
}

function store(data: Record<string, CatalogueCandidate[]>, pageSize = 50): CatalogueSelectionStore {
  return {
    getSourceWeights: vi.fn(async () => Object.fromEntries(
      Object.keys(data).map((sourceKey) => [sourceKey, 1]),
    )),
    queryCandidates: vi.fn(async (sourceKey, _query, pageToken) => {
      const start = pageToken ? Number(pageToken) : 0;
      const candidates = data[sourceKey] ?? [];
      const page = candidates.slice(start, start + pageSize);
      const next = start + page.length < candidates.length ? String(start + page.length) : undefined;
      return { candidates: page, nextPageToken: next };
    }),
  };
}

describe('selectCatalogueRecipes', () => {
  it('exhausts paginated candidates for every enabled source before weighting', async () => {
    const first = candidate('wrong-ingredient', 'first', { ingredientTokens: ['beef'] });
    const exact = candidate('exact', 'first');
    const second = candidate('second', 'second');
    const injected = store({ first: [first, exact], second: [second] }, 1);

    const result = await selectCatalogueRecipes(selectionRequest(), injected, () => 0);

    expect(result.slots[0]).toMatchObject({ status: 'selected', recipeId: 'exact', sourceKey: 'first' });
    expect(injected.queryCandidates).toHaveBeenCalledWith('first', expect.any(Object), undefined);
    expect(injected.queryCandidates).toHaveBeenCalledWith('first', expect.any(Object), '1');
    expect(injected.queryCandidates).toHaveBeenCalledWith('second', expect.any(Object), undefined);
  });

  it('applies source weights only after eligible sources are known and not by catalogue size', async () => {
    const injected = store({
      small: [candidate('small-1', 'small')],
      large: Array.from({ length: 20 }, (_, index) => candidate(`large-${index}`, 'large')),
    });
    injected.getSourceWeights = vi.fn(async () => ({ small: 3, large: 1 }));

    const first = await selectCatalogueRecipes(selectionRequest(), injected, () => 0.5);
    const second = await selectCatalogueRecipes(selectionRequest(), injected, () => 0.9);

    expect(first.slots[0]).toMatchObject({ sourceKey: 'small' });
    expect(second.slots[0]).toMatchObject({ sourceKey: 'large' });
  });

  it('applies preferred ingredients after hard eligibility and excludes duplicate IDs', async () => {
    const injected = store({ only: [
      candidate('duplicate', 'only'),
      candidate('plain', 'only', { ingredientTokens: ['chicken'] }),
      candidate('preferred', 'only', { ingredientTokens: ['chicken', 'lemon'] }),
    ] });
    const input = selectionRequest({
      currentPlanRecipeIds: ['duplicate'],
      slots: [{
        ...selectionRequest().slots[0],
        ingredients: { must: ['chicken'], prefer: ['lemon'], exclude: [] },
      }],
    });

    const result = await selectCatalogueRecipes(input, injected, () => 0.75);
    expect(result.slots[0]).toMatchObject({ recipeId: 'preferred' });
  });

  it('returns controlled one-filter diagnostics instead of silently relaxing', async () => {
    const injected = store({ only: [candidate('slow', 'only', { totalMinutes: 45 })] });

    const result = await selectCatalogueRecipes(selectionRequest(), injected, () => 0);

    expect(result.slots[0]).toEqual({
      date: '2026-07-20',
      mealType: 'dinner',
      status: 'no-match',
      relaxations: [{ filter: 'maxTotalMinutes', from: 30, to: 45, matchCount: 1 }],
    });
  });
});

describe('catalogue selection callable', () => {
  it('validates before authorization and authorizes the household before querying', async () => {
    const authorize = vi.fn(async () => ({ uid: 'u1', email: 'member@example.com' }));
    const injected = store({ only: [candidate('recipe', 'only')] });
    const handler = createCatalogueSelectionHandlers({ authorize, store: injected, random: () => 0 });

    await expect(handler.select(request({ householdId: 'h1', slots: [] })))
      .rejects.toMatchObject({ code: 'invalid-argument' });
    expect(authorize).not.toHaveBeenCalled();

    await expect(handler.select(request(selectionRequest()))).resolves.toMatchObject({
      slots: [{ status: 'selected', recipeId: 'recipe' }],
    });
    expect(authorize).toHaveBeenCalledWith(AUTH, 'h1');
  });
});
