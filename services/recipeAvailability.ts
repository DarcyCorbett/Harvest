export function reconcileRecipeAvailability<T>(
  recipeIds: string[],
  fetched: Array<T | null>,
  previousRecipes: Record<string, T>,
  previousMissingRecipeIds: Set<string>,
) {
  const recipes = { ...previousRecipes };
  const missingRecipeIds = new Set(previousMissingRecipeIds);

  fetched.forEach((recipe, index) => {
    const recipeId = recipeIds[index];
    if (recipe) {
      recipes[recipeId] = recipe;
      missingRecipeIds.delete(recipeId);
    } else {
      delete recipes[recipeId];
      missingRecipeIds.add(recipeId);
    }
  });

  return {
    recipes,
    missingRecipeIds,
  };
}

export function getRecipePresentation(recipe: { title: string } | undefined, missing: boolean) {
  if (recipe) {
    return {
      status: 'available' as const,
      title: recipe.title,
      disabled: false,
    };
  }
  if (missing) {
    return {
      status: 'unavailable' as const,
      title: 'Recipe unavailable',
      disabled: true,
    };
  }
  return { status: 'loading' as const, title: 'Loading…', disabled: true };
}
