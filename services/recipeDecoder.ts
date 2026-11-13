import type {
  Ingredient,
  IngredientGroup,
  InstructionStep,
  Nutrition,
  Recipe,
  RecipeAdditionalTime,
  RecipeEquipmentItem,
  RecipeNoteSection,
} from './types';
import { htmlToText } from './scraper/parse';
import { normalizeIngredient } from '../functions/src/shared/ingredientAmounts';

type UnknownRecord = Record<string, unknown>;

const MEAL_TYPE_LABELS: Record<string, string> = {
  breakfast: 'Breakfast',
  lunch: 'Lunch',
  dinner: 'Dinner',
  side: 'Side',
  snack: 'Snack',
  dessert: 'Dessert',
  component: 'Sauces, Condiments & More',
};

const CUISINE_LABELS: Record<string, string> = {
  asian: 'Asian',
  mexican: 'Mexican',
  mediterranean: 'Mediterranean',
  italian: 'Italian',
  indian: 'Indian',
  greek: 'Greek',
  american: 'American',
  french: 'French',
  'middle-eastern': 'Middle Eastern',
  global: 'Global',
};

const MODIFIER_LABELS: Record<string, string> = {
  vegetarian: 'Vegetarian',
  'kid-friendly': 'Kid Friendly',
  healthy: 'Healthy',
  salad: 'Salad',
};

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function asDate(value: unknown): Date | undefined {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (isRecord(value) && typeof value.toDate === 'function') {
    const date = (value.toDate as () => unknown)();
    return date instanceof Date && Number.isFinite(date.getTime()) ? date : undefined;
  }
  if (isRecord(value) && typeof value.seconds === 'number') {
    const date = new Date(value.seconds * 1000);
    return Number.isFinite(date.getTime()) ? date : undefined;
  }
  if (typeof value === 'string') {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : undefined;
  }
  return undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => asString(entry) ? [entry as string] : [])
    : [];
}

function labelValues(values: unknown, labels: Record<string, string>): string[] {
  return stringArray(values).flatMap((value) => labels[value] ? [labels[value]] : []);
}

function decodeIngredient(value: unknown): Ingredient | null {
  if (!isRecord(value)) return null;
  const rawName = asString(value.name);
  if (!rawName) return null;

  return normalizeIngredient({
    name: rawName,
    quantity: asNumber(value.quantity),
    unit: asString(value.unit) ?? '',
    ...(asString(value.notes) ? { notes: htmlToText(asString(value.notes)!) } : {}),
  });
}

function decodeIngredients(value: unknown): Ingredient[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => {
      const ingredient = decodeIngredient(entry);
      return ingredient ? [ingredient] : [];
    })
    : [];
}

function decodeGroups(value: unknown): IngredientGroup[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const groups = value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const ingredients = decodeIngredients(entry.ingredients);
    if (ingredients.length === 0) return [];
    return [{
      name: htmlToText(asString(entry.name) ?? ''),
      ingredients,
    }];
  });
  return groups.length ? groups : undefined;
}

function decodeInstructions(value: unknown): InstructionStep[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === 'string' && entry.trim()) return [{ text: htmlToText(entry) }];
    if (!isRecord(entry)) return [];
    const text = asString(entry.text);
    if (!text) return [];
    return [{
      text: htmlToText(text),
      ...(asString(entry.title) ? { title: htmlToText(entry.title as string) } : {}),
      ...(asString(entry.sourceUrl) ? { sourceUrl: entry.sourceUrl as string } : {}),
      ...(asString(entry.imageUrl) ? { imageUrl: entry.imageUrl as string } : {}),
      ...(asString(entry.videoEmbedUrl) ? { videoEmbedUrl: entry.videoEmbedUrl as string } : {}),
      ...(typeof entry.isHeader === 'boolean' ? { isHeader: entry.isHeader } : {}),
    }];
  });
}

function decodeNutrition(value: unknown): Nutrition | undefined {
  if (!isRecord(value)) return undefined;
  const nutrition: Nutrition = {};
  for (const key of [
    'calories', 'protein', 'carbs', 'fat', 'fiber', 'sugar', 'saturatedFat',
    'unsaturatedFat', 'transFat', 'sodium', 'cholesterol',
  ] as const) {
    const raw = value[key];
    const decoded = asNumber(raw, Number.NaN);
    if (Number.isFinite(decoded) && decoded >= 0) nutrition[key] = decoded;
  }
  return Object.values(nutrition).some((entry) => entry !== undefined && entry > 0)
    ? nutrition
    : undefined;
}

function decodeEquipment(value: unknown): RecipeEquipmentItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.flatMap((entry) => {
    if (typeof entry === 'string') {
      const name = asString(entry);
      return name ? [{ name }] : [];
    }
    if (!isRecord(entry)) return [];
    const name = asString(entry.name);
    if (!name) return [];
    const notes = asString(entry.notes);
    return [{ name, ...(notes ? { notes } : {}) }];
  });
  return items.length ? items : undefined;
}

function decodeAdditionalTimes(value: unknown): RecipeAdditionalTime[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const label = asString(entry.label);
    const minutes = asNumber(entry.minutes);
    return label && minutes > 0 ? [{ label, minutes }] : [];
  });
  return items.length ? items : undefined;
}

function decodeNoteSections(value: unknown): RecipeNoteSection[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const sections = value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const title = asString(entry.title);
    const items = stringArray(entry.items);
    return items.length ? [{ ...(title ? { title } : {}), items }] : [];
  });
  return sections.length ? sections : undefined;
}

function decodeEnrichment(content: UnknownRecord): Partial<Recipe> {
  const attribution = isRecord(content.attribution) ? content.attribution : {};
  const author = asString(attribution.author);
  const publisher = asString(attribution.publisher);
  const publishedAt = asString(attribution.publishedAt);
  const modifiedAt = asString(attribution.modifiedAt);
  const sourceRating = isRecord(content.sourceRating) ? content.sourceRating : {};
  const ratingValue = asNumber(sourceRating.value, Number.NaN);
  const ratingCount = asNumber(sourceRating.count, Number.NaN);
  const ratingCapturedAt = asString(sourceRating.capturedAt)
    ?? asDate(sourceRating.capturedAt)?.toISOString();
  const equipment = decodeEquipment(content.equipment);
  const additionalTimes = decodeAdditionalTimes(content.additionalTimes);
  const noteSections = decodeNoteSections(content.noteSections);
  const estimatedCost = isRecord(content.estimatedCost) ? content.estimatedCost : {};
  const costAmount = asNumber(estimatedCost.amount, Number.NaN);
  const currency = asString(estimatedCost.currency);
  const costText = asString(estimatedCost.text);

  return {
    ...(stringArray(content.imageUrls).length ? { imageUrls: stringArray(content.imageUrls) } : {}),
    ...(author || publisher || publishedAt || modifiedAt ? {
      attribution: {
        ...(author ? { author } : {}),
        ...(publisher ? { publisher } : {}),
        ...(publishedAt ? { publishedAt } : {}),
        ...(modifiedAt ? { modifiedAt } : {}),
      },
    } : {}),
    ...(Number.isFinite(ratingValue) && ratingValue > 0 ? {
      sourceRating: {
        value: ratingValue,
        ...(Number.isFinite(ratingCount) && ratingCount >= 0 ? { count: ratingCount } : {}),
        ...(ratingCapturedAt ? { capturedAt: ratingCapturedAt } : {}),
      },
    } : {}),
    ...(equipment ? { equipment } : {}),
    ...(additionalTimes ? { additionalTimes } : {}),
    ...(noteSections ? { noteSections } : {}),
    ...(stringArray(content.dietaryClaims).length ? { dietaryClaims: stringArray(content.dietaryClaims) } : {}),
    ...(stringArray(content.cookingMethods).length ? { cookingMethods: stringArray(content.cookingMethods) } : {}),
    ...(stringArray(content.sourceCategories).length ? { sourceCategories: stringArray(content.sourceCategories) } : {}),
    ...(stringArray(content.sourceCuisines).length ? { sourceCuisines: stringArray(content.sourceCuisines) } : {}),
    ...(stringArray(content.sourceKeywords).length ? { sourceKeywords: stringArray(content.sourceKeywords) } : {}),
    ...(costText || (Number.isFinite(costAmount) && costAmount >= 0) ? {
      estimatedCost: {
        ...(costText ? { text: costText } : {}),
        ...(Number.isFinite(costAmount) && costAmount >= 0 ? { amount: costAmount } : {}),
        ...(currency ? { currency } : {}),
      },
    } : {}),
  };
}

function minuteLabel(value: unknown): string {
  const minutes = asNumber(value);
  return minutes > 0 ? `${minutes} min` : '';
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function decodeCatalogueRecipe(documentId: string, data: UnknownRecord): Recipe | null {
  if (data.status !== 'ready' && data.status !== 'review') return null;
  const content = isRecord(data.content) ? data.content : {};
  const source = isRecord(data.source) ? data.source : {};
  const effective = isRecord(data.effective) ? data.effective : {};
  const ingestion = isRecord(data.ingestion) ? data.ingestion : {};
  const title = asString(content.title);
  const sourceUrl = asString(source.canonicalUrl) ?? asString(source.originalUrl);
  if (!title || !sourceUrl) return null;

  const mealTypes = labelValues(effective.mealTypes, MEAL_TYPE_LABELS);
  const cuisines = labelValues(effective.cuisines, CUISINE_LABELS);
  const modifiers = labelValues(effective.modifiers, MODIFIER_LABELS);
  const groups = decodeGroups(content.ingredientGroups);
  const imageUrl = asString(content.imageUrl);
  const videoEmbedUrl = asString(content.videoEmbedUrl);
  const description = asString(content.description);
  const nutrition = decodeNutrition(content.nutrition);

  return {
    id: documentId,
    schemaVersion: 2,
    catalogueStatus: data.status,
    title,
    sourceUrl,
    ...(imageUrl ? { imageUrl } : {}),
    ...(videoEmbedUrl ? { videoEmbedUrl } : {}),
    prepTime: minuteLabel(effective.prepMinutes),
    cookTime: minuteLabel(effective.cookMinutes),
    ...(minuteLabel(effective.totalMinutes) ? { totalTime: minuteLabel(effective.totalMinutes) } : {}),
    originalServings: Math.max(1, asNumber(content.originalServings, 1)),
    course: mealTypes,
    tags: unique([...cuisines, ...modifiers]),
    ...(description ? { description } : {}),
    ...decodeEnrichment(content),
    ...(cuisines[0] ? { cuisine: cuisines[0] } : {}),
    ingredients: decodeIngredients(content.ingredients),
    ...(groups ? { ingredientGroups: groups } : {}),
    instructions: decodeInstructions(content.instructions),
    notes: asString(content.notes) ?? '',
    ...(nutrition ? { nutrition } : {}),
    ...decodeEnrichment(data),
    ...(typeof data.needsDefrost === 'boolean' ? { needsDefrost: data.needsDefrost } : {}),
    ...(typeof data.needsMarinate === 'boolean' ? { needsMarinate: data.needsMarinate } : {}),
    scrapedAt: asDate(ingestion.lastChangedAt)
      ?? asDate(ingestion.firstIngestedAt)
      ?? new Date(0),
  };
}

function decodeLegacyRecipe(documentId: string, data: UnknownRecord): Recipe | null {
  const title = asString(data.title);
  const sourceUrl = asString(data.sourceUrl);
  if (!title || !sourceUrl) return null;
  const nutrition = decodeNutrition(data.nutrition);
  const { nutrition: _rawNutrition, ...legacy } = data;
  return {
    ...legacy,
    id: documentId,
    title,
    sourceUrl,
    prepTime: asString(data.prepTime) ?? '',
    cookTime: asString(data.cookTime) ?? '',
    originalServings: Math.max(1, asNumber(data.originalServings, 1)),
    ingredients: decodeIngredients(data.ingredients),
    ...(decodeGroups(data.ingredientGroups) ? { ingredientGroups: decodeGroups(data.ingredientGroups) } : {}),
    instructions: decodeInstructions(data.instructions),
    notes: asString(data.notes) ?? '',
    ...(nutrition ? { nutrition } : {}),
    scrapedAt: asDate(data.scrapedAt) ?? new Date(0),
  } as Recipe;
}

export function decodeRecipeDocument(documentId: string, value: unknown): Recipe | null {
  if (!documentId || !isRecord(value)) return null;
  return value.schemaVersion === 2
    ? decodeCatalogueRecipe(documentId, value)
    : decodeLegacyRecipe(documentId, value);
}
