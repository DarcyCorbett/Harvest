export type RecipeHistoryState<T> = {
  householdId: string | null;
  generation: number;
  recipes: Record<string, T>;
  missingRecipeIds: Set<string>;
  errorRecipeIds: Set<string>;
  loadedRecipeIds: Set<string>;
  referencedRecipeIds: Set<string>;
};

export type RecipeFetchRequest = {
  householdId: string;
  generation: number;
  recipeIds: string[];
};

export function createRecipeHistoryState<T>(
  householdId: string | null,
  generation: number,
): RecipeHistoryState<T> {
  return {
    householdId,
    generation,
    recipes: {},
    missingRecipeIds: new Set(),
    errorRecipeIds: new Set(),
    loadedRecipeIds: new Set(),
    referencedRecipeIds: new Set(),
  };
}

export function isCurrentHistorySession(
  ownerHouseholdId: string,
  ownerGeneration: number,
  currentHouseholdId: string | null,
  currentGeneration: number,
): boolean {
  return ownerHouseholdId === currentHouseholdId && ownerGeneration === currentGeneration;
}

export function recipeIdsToLoad<T>(
  recipeIds: string[],
  state: RecipeHistoryState<T>,
): string[] {
  return [...new Set(recipeIds)].filter(
    (recipeId) =>
      !state.loadedRecipeIds.has(recipeId)
      && !state.missingRecipeIds.has(recipeId)
      && !state.errorRecipeIds.has(recipeId)
      && !state.recipes[recipeId],
  );
}

export function beginRecipeLoads<T>(
  state: RecipeHistoryState<T>,
  recipeIds: string[],
): RecipeHistoryState<T> {
  const loadedRecipeIds = new Set(state.loadedRecipeIds);
  const referencedRecipeIds = new Set(state.referencedRecipeIds);
  recipeIds.forEach((recipeId) => loadedRecipeIds.add(recipeId));
  recipeIds.forEach((recipeId) => referencedRecipeIds.add(recipeId));
  return { ...state, loadedRecipeIds, referencedRecipeIds };
}

export function applyRecipeFetchResults<T>(
  state: RecipeHistoryState<T>,
  request: RecipeFetchRequest,
  results: Array<PromiseSettledResult<T | null>>,
): RecipeHistoryState<T> {
  if (!isCurrentHistorySession(
    request.householdId,
    request.generation,
    state.householdId,
    state.generation,
  )) {
    return state;
  }

  const recipes = { ...state.recipes };
  const missingRecipeIds = new Set(state.missingRecipeIds);
  const errorRecipeIds = new Set(state.errorRecipeIds);
  const loadedRecipeIds = new Set(state.loadedRecipeIds);

  request.recipeIds.forEach((recipeId, index) => {
    if (!state.referencedRecipeIds.has(recipeId)) {
      loadedRecipeIds.delete(recipeId);
      return;
    }
    const result = results[index];
    if (!result || result.status === 'rejected') {
      loadedRecipeIds.delete(recipeId);
      missingRecipeIds.delete(recipeId);
      errorRecipeIds.add(recipeId);
      return;
    }

    errorRecipeIds.delete(recipeId);
    loadedRecipeIds.add(recipeId);
    if (result.value === null) {
      delete recipes[recipeId];
      missingRecipeIds.add(recipeId);
    } else {
      recipes[recipeId] = result.value;
      missingRecipeIds.delete(recipeId);
    }
  });

  return {
    ...state,
    recipes,
    missingRecipeIds,
    errorRecipeIds,
    loadedRecipeIds,
  };
}

export function retryRecipeLoad<T>(
  state: RecipeHistoryState<T>,
  recipeId: string,
): RecipeHistoryState<T> {
  const errorRecipeIds = new Set(state.errorRecipeIds);
  errorRecipeIds.delete(recipeId);
  const loadedRecipeIds = new Set(state.loadedRecipeIds);
  loadedRecipeIds.delete(recipeId);
  return { ...state, errorRecipeIds, loadedRecipeIds };
}

export function pruneRecipeHistory<T>(
  state: RecipeHistoryState<T>,
  referencedRecipeIds: string[],
): RecipeHistoryState<T> {
  const referenced = new Set(referencedRecipeIds);
  const recipes = Object.fromEntries(
    Object.entries(state.recipes).filter(([recipeId]) => referenced.has(recipeId)),
  ) as Record<string, T>;
  return {
    ...state,
    recipes,
    missingRecipeIds: new Set([...state.missingRecipeIds].filter((id) => referenced.has(id))),
    errorRecipeIds: new Set([...state.errorRecipeIds].filter((id) => referenced.has(id))),
    loadedRecipeIds: new Set([...state.loadedRecipeIds].filter((id) => referenced.has(id))),
    referencedRecipeIds: referenced,
  };
}

export function getRecipePresentation(
  recipe: { title: string } | undefined,
  missing: boolean,
  error: boolean,
) {
  if (recipe) return { status: 'available' as const, title: recipe.title };
  if (missing) return { status: 'unavailable' as const, title: 'Recipe unavailable' };
  if (error) {
    return { status: 'error' as const, title: 'Could not load recipe — tap to retry' };
  }
  return { status: 'loading' as const, title: 'Loading…' };
}

export async function executeOwnedHistoryAction(
  snapshotHouseholdId: string | null,
  currentHouseholdId: string | null,
  action: (householdId: string) => Promise<unknown>,
  onError: (error: unknown) => void,
): Promise<'completed' | 'blocked' | 'failed'> {
  if (!snapshotHouseholdId || snapshotHouseholdId !== currentHouseholdId) return 'blocked';
  try {
    await action(snapshotHouseholdId);
    return 'completed';
  } catch (error) {
    onError(error);
    return 'failed';
  }
}
