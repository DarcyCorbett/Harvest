import { baseAmount, normalizeIngredient, shoppingName, type NamedIngredient } from '../shared/ingredientAmounts';
/** Shared workflow contracts. Quantities describe recipe requirements, never stock. */
export type MealKind = "recipe" | "leftover" | "eating-out";
export type MealStatus = "planned" | "cooked" | "skipped" | "removed";
export interface Food {
  name: string;
  quantity: number;
  unit: string;
  notes?: string;
}
export interface Meal {
  id: string;
  recipeId: string;
  date: string;
  mealType: string;
  servings: number;
  adults?: number;
  children?: number;
  revision: number;
  kind: MealKind;
  status: MealStatus;
  sides?: { recipeId: string; servings: number }[];
  sourceMealId?: string;
  allocatedPortions?: number;
  overrides?: {
    recipeId: string;
    ingredientIndex: number;
    replacement: Food;
    adjustment: string;
    forServings?: number;
  }[];
  title?: string;
  customLabel?: string;
}
export interface Contribution {
  /** Stable ingredient identity, retained across serving/substitution edits. */
  sourceId?: string;
  mealId: string;
  recipeId: string;
  title: string;
  quantity: number;
  /** Saved, scaled source measurement; never re-scale it after purchase. */
  sourceAmount?: NamedIngredient;
  servings?: number;
}
export interface Requirement {
  id: string;
  name: string;
  quantity: number;
  unit: string;
  category: string;
  contributions: Contribution[];
  approximate?: boolean;
  /** Original deterministic shopping keys represented by this semantic group. */
  sourceKeys?: string[];
  notes?: string;
}
export interface ListItem extends Requirement {
  purchasedOrder?: number;
  revision: number;
  checked: boolean;
  manual: boolean;
  dismissed?: boolean;
  reviewedQuantity?: number;
  review?: boolean;
  obsolete?: boolean;
  legacy?: boolean;
}
export interface Period {
  shopping?: {
    generation: string;
    mealIds: string[];
    sources: Requirement[];
    removed: Requirement[];
    purchaseSequence: number;
  };
  completedWorkflowRevision?: number;
  id: string;
  start: string;
  end: string;
  items: ListItem[];
  revision: number;
  shoppingGrouping?: import('./shoppingGrouping.js').ShoppingGroupingCache;
  groupingStatus?: 'ai' | 'fallback';
}
export interface Workflow {
  version: 2;
  minPlanningClientVersion?: 3 | 4;
  minShoppingClientVersion?: 4;
  shoppingUpdate?: { mealIds: string[]; changedMealIds: string[]; replace: boolean; generation: string };
  revision: number;
  periodId: string;
  status: "pending" | "ready" | "error";
  error?: string;
  pendingDrafts?: { id: string; revision: number }[];
}
export interface RecipeInput {
  id: string;
  title: string;
  originalServings: number;
  ingredients: (Food & { originalIndex?: number; sourceKey?: string })[];
}
export interface DraftSlot {
  allowAnyCuisine?: boolean;
  id: string;
  date: string;
  mealType: string;
  expectedRevision: number;
  status: "ready" | "unmatched" | "failed";
  recipeId?: string;
  servings: number;
  locked: boolean;
  removed: boolean;
  message?: string;
  reasons?: string[];
  alternatives?: string[];
  sourceMealId?: string;
  allocatedPortions?: number;
  maxMinutes?: 30 | 45;
  must?: string[];
}
export interface Draft {
  id: string;
  revision: number;
  slots: DraftSlot[];
  submitted?: boolean;
  config: {
    adults: number;
    children: number;
    styles: string[];
    prefer: string[];
    exclude: string[];
    favouriteCount: number;
    leftovers: boolean;
    must: string[];
    mustScope: "plan" | "recipe";
  };
}
export const isoDate = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const shiftDate = (value: string, days: number): string => {
  const [y, m, d] = value.split("-").map(Number);
  return isoDate(new Date(y, m - 1, d + days));
};
export function weekRange(today = isoDate(new Date())): {
  start: string;
  end: string;
} {
  const d = new Date(`${today}T12:00:00`);
  const start = shiftDate(today, -((d.getDay() + 6) % 7));
  return { start, end: shiftDate(start, 6) };
}
export function validDate(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value
  );
}
export const slotId = (date: string, type: string): string => `${date}_${type}`;
export function normaliseMeal(id: string, data: Partial<Meal>): Meal {
  return {
    ...data,
    id,
    recipeId: data.recipeId ?? "",
    date: data.date ?? id.slice(0, 10),
    mealType: data.mealType ?? "dinner",
    servings: data.servings ?? 2,
    revision: data.revision ?? 0,
    kind: data.kind ?? "recipe",
    status: data.status ?? "planned",
  };
}
export function canonicalAmount(food: Food): Food {
  return { ...food, ...baseAmount(food), name: shoppingName(food) };
}
export function foodKey(food: Food): string {
  const n = canonicalAmount(food);
  return encodeURIComponent(`${n.name}|${n.unit}`).replace(/\./g, "%2E");
}
function category(name: string): string {
  if (/\b(chicken|beef|pork|fish|salmon|prawn|lamb|bacon|turkey)\b/.test(name))
    return "Meat & Seafood";
  if (/\b(milk|cheese|yogurt|yoghurt|butter|cream|egg|eggs)\b/.test(name))
    return "Dairy & Eggs";
  if (/\b(oil|sauce|stock|vinegar|mustard)\b/.test(name))
    return "Oils, Sauces & Condiments";
  if (/\b(salt|pepper|cumin|paprika|oregano|basil|cinnamon)\b/.test(name))
    return "Herbs & Spices";
  if (
    /\b(onion|garlic|tomato|lemon|lime|potato|carrot|broccoli|spinach|lettuce|mushroom)\b/.test(
      name,
    )
  )
    return "Produce";
  return "Other";
}
export function validateAllocations(meals: Meal[]): void {
  const active = meals.filter(
    (m) => m.status !== "removed" && m.status !== "skipped",
  );
  for (const meal of active.filter((m) => m.kind === "leftover")) {
    const source = active.find((m) => m.id === meal.sourceMealId);
    if (!source || source.kind !== "recipe" || source.date >= meal.date)
      throw new Error("Leftovers need an earlier active cooking occasion.");
    if (source.recipeId !== meal.recipeId)
      throw new Error(
        "The source recipe changed. Review its planned leftovers before saving.",
      );
    if (meal.servings <= 0)
      throw new Error("Leftover portions must be positive.");
  }
  for (const source of active.filter((m) => m.kind === "recipe")) {
    const used = active
      .filter((m) => m.kind === "leftover" && m.sourceMealId === source.id)
      .reduce((s, m) => s + m.servings, 0);
    if (used > (source.allocatedPortions ?? 0))
      throw new Error(
        "Leftover portions exceed the portions reserved by the source meal. Update its allocation first.",
      );
  }
}
export function buildRequirements(
  meals: Meal[],
  recipes: Record<string, RecipeInput>,
  period: Pick<Period, "start" | "end">,
  withSourceIds = false,
): Requirement[] {
  validateAllocations(meals);
  const requirements = new Map<string, Requirement>();
  for (const meal of meals) {
    if (
      meal.date < period.start ||
      meal.date > period.end ||
      meal.kind !== "recipe" ||
      ["skipped", "removed"].includes(meal.status)
    )
      continue;
    for (const part of [
      {
        recipeId: meal.recipeId,
        servings: meal.servings + (meal.allocatedPortions ?? 0),
      },
      ...(meal.sides ?? []),
    ]) {
      const recipe = recipes[part.recipeId];
      if (!recipe)
        throw new Error(
          "A planned recipe is unavailable. Shopping requirements have not been replaced.",
        );
      recipe.ingredients.forEach((ingredient, index) => {
        const override = meal.overrides?.find(
          (o) => o.recipeId === part.recipeId && o.ingredientIndex === (ingredient.originalIndex ?? index),
        );
        const normalized = normalizeIngredient(override?.replacement ?? ingredient);
        const sourceAmount = { ...normalized, quantity: normalized.quantity * part.servings / (override ? (override.forServings ?? part.servings) : recipe.originalServings) };
        const food = canonicalAmount(sourceAmount);
        if (!Number.isFinite(food.quantity) || food.quantity < 0)
          throw new Error("Invalid ingredient quantity.");
        const key = foodKey(food);
        const row = requirements.get(key) ?? {
          id: key,
          name: food.name,
          quantity: 0,
          unit: food.unit,
          category: category(food.name),
          ...(food.notes ? { notes: food.notes } : {}),
          contributions: [],
        };
        row.quantity += food.quantity;
        row.contributions.push({
          ...(withSourceIds ? { sourceId: JSON.stringify([meal.id, recipe.id, ingredient.sourceKey ?? foodKey(ingredient)]) } : {}),
          mealId: meal.id,
          recipeId: recipe.id,
          title: recipe.title,
          quantity: food.quantity,
          sourceAmount,
          servings: part.servings,
        });
        requirements.set(key, row);
      });
    }
  }
  return [...requirements.values()]
    .sort((a, b) => a.name.localeCompare(b.name));
}
export function reconcileItems(
  previous: ListItem[],
  requirements: Requirement[],
): ListItem[] {
  const old = new Map(
    previous.filter((i) => !i.manual && !i.legacy).map((i) => [i.id, i]),
  );
  const next = requirements.map((r) => {
    const candidates: ListItem[] = [];
    const sourceKeys = new Set(r.sourceKeys ?? [r.id]);
    for (const [key, item] of old.entries()) {
      // Match stable shopping IDs or fully represented source groups. Preserve
      // compatible purchased quantities when Gemini renames or combines rows.
      if (item.unit === r.unit && (key === r.id || foodKey(item) === r.id
        || (item.sourceKeys ?? [foodKey(item)]).every(source => sourceKeys.has(source)))) {
        candidates.push(item);
        old.delete(key);
      }
    }

    let before: ListItem | undefined;
    if (candidates.length > 1) {
      const checked = candidates.some(item => item.checked);
      const reviewedQuantity = checked
        ? candidates.reduce((sum, item) => sum + (item.checked ? (item.reviewedQuantity ?? item.quantity) : 0), 0)
        : undefined;
      before = {
        ...candidates[0],
        quantity: candidates.reduce((sum, item) => sum + item.quantity, 0),
        checked,
        revision: Math.max(...candidates.map(item => item.revision)),
        reviewedQuantity,
        dismissed: candidates.every(item => item.dismissed),
      };
    } else {
      before = candidates[0];
    }

    if (!before) return { ...r, revision: 1, checked: false, manual: false };
    const changed = Math.abs(before.quantity - r.quantity) > 0.001;
    const affected =
      changed ||
      before.obsolete ||
      JSON.stringify(before.contributions) !== JSON.stringify(r.contributions);
    return {
      ...before,
      ...r,
      revision: before.revision + (affected ? 1 : 0),
      obsolete: false,
      review:
        before.checked &&
        r.quantity > (before.reviewedQuantity ?? before.quantity) + 0.001,
      reviewedQuantity: before.checked
        ? (before.reviewedQuantity ?? before.quantity)
        : undefined,
      dismissed: changed ? false : before.dismissed,
    };
  });
  return [
    ...next,
    ...previous.filter((i) => i.manual || i.legacy),
    ...[...old.values()]
      .filter((i) => i.checked)
      .map((i) => ({
        ...i,
        obsolete: true,
        review: false,
        revision: i.revision + 1,
        contributions: [],
      })),
  ];
}
export function setItemAction(
  item: ListItem,
  action: "check" | "uncheck" | "dismiss" | "restore",
): ListItem {
  return {
    ...item,
    revision: item.revision + 1,
    checked:
      action === "check" ? true : action === "uncheck" ? false : item.checked,
    reviewedQuantity:
      action === "check" ? item.quantity : item.reviewedQuantity,
    review: action === "check" || action === "uncheck" ? false : item.review,
    dismissed:
      action === "dismiss"
        ? true
        : action === "restore"
          ? false
          : item.dismissed,
  };
}
