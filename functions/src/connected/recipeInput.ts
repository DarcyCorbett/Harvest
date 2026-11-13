import { type Food, type RecipeInput } from './model.js';
import { normalizeIngredient } from '../shared/ingredientAmounts.js';
import { reconcileOccurrences } from '../catalogue/ingredientReconciliation.js';

/** Frozen v1 identity, independent of display/measurement repairs. */
export function ingredientSourceKey(food: Food): string {
  const aliases: Record<string, string> = { kilogram: 'kg', kilograms: 'kg', ounce: 'oz', ounces: 'oz', pound: 'lb', pounds: 'lb', lbs: 'lb', tablespoon: 'tbsp', tablespoons: 'tbsp', tbsps: 'tbsp', teaspoon: 'tsp', teaspoons: 'tsp', tsps: 'tsp', milliliter: 'ml', milliliters: 'ml', millilitre: 'ml', millilitres: 'ml', liters: 'l', litres: 'l', cloves: 'clove', pieces: 'piece', slices: 'slice' };
  const raw = food.unit.trim().toLowerCase().replace(/\.$/, '');
  let unit = aliases[raw] ?? raw;
  if (['g', 'gram', 'grams', 'kg', 'oz', 'lb'].includes(unit)) unit = 'g';
  if (['ml', 'l', 'litre', 'liter', 'cup', 'cups', 'tbsp', 'tsp'].includes(unit)) unit = 'ml';
  const name = food.name.trim().toLowerCase().replace(/^of\s+/i, '').replace(/\s+/g, ' ');
  return encodeURIComponent(`${name}|${unit}`).replace(/\./g, '%2E');
}

export function recipeInput(id: string, raw: Record<string, unknown>): RecipeInput {
  const content = (raw.schemaVersion === 2 ? raw.content : raw) as Record<
    string,
    unknown
  >;
  if (!content || typeof content.title !== "string")
    throw new Error("A planned recipe is unavailable.");
  const root = Array.isArray(content.ingredients) ? content.ingredients : [];
  const grouped = (
    Array.isArray(content.ingredientGroups) ? content.ingredientGroups : []
  ).flatMap((g: any) => (Array.isArray(g?.ingredients) ? g.ingredients : []));

  const cleanFood = (i: any) => normalizeIngredient({ name: String(i.name ?? ""), quantity: Number(i.quantity) || 0, unit: String(i.unit ?? ""), ...(i.notes ? { notes: String(i.notes) } : {}) });
  const reconciliation = reconcileOccurrences(root.map(cleanFood), grouped.map(cleanFood));
  const hasGroups = Array.isArray(content.ingredientGroups) && content.ingredientGroups.length > 0;
  const entries = hasGroups ? grouped : root;

  return {
    id,
    title: content.title,
    originalServings: Math.max(1, Number(content.originalServings) || 1),
    ingredients: entries
      .map((i, index) => ({
        ...cleanFood(i),
        originalIndex: hasGroups ? reconciliation.matchedGroupedToRoot[index] : index,
        sourceKey: ingredientSourceKey({ name: String(i.name ?? ''), quantity: Number(i.quantity) || 0, unit: String(i.unit ?? '') }),
      }))
      .filter((i) => i.name),
  };
}
