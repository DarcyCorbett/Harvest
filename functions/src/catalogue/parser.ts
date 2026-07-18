import {
  CUISINES,
  MEAL_TYPES,
  MODIFIERS,
  type CompleteCanonicalRecipeV2,
  type Cuisine,
  type MealType,
  type Modifier,
} from './domain.js';

type ParsedCatalogueRecipe = Pick<CompleteCanonicalRecipeV2, 'content' | 'sourceMetadata'>;

function text(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function values(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(values);
  const normalized = text(value);
  return normalized ? [normalized] : [];
}

function hasType(node: Record<string, unknown>, expected: string): boolean {
  const type = node['@type'];
  return type === expected || (Array.isArray(type) && type.includes(expected));
}

function visitJsonLd(value: unknown, recipes: Record<string, unknown>[]): void {
  if (Array.isArray(value)) {
    value.forEach((entry) => visitJsonLd(entry, recipes));
    return;
  }
  if (!value || typeof value !== 'object') return;
  const node = value as Record<string, unknown>;
  if (hasType(node, 'Recipe')) recipes.push(node);
  if (node['@graph']) visitJsonLd(node['@graph'], recipes);
}

function recipeNode(html: string): Record<string, unknown> | undefined {
  const recipes: Record<string, unknown>[] = [];
  const scripts = html.matchAll(
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  );
  for (const match of scripts) {
    try {
      visitJsonLd(JSON.parse(match[1].trim()), recipes);
    } catch {
      // Ignore malformed publisher blocks and continue to the next one.
    }
  }
  return recipes[0];
}

export function parseIsoDurationMinutes(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(value.trim());
  if (!match) return undefined;
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3] ?? 0);
  const seconds = Number(match[4] ?? 0);
  return days * 1_440 + hours * 60 + minutes + Math.ceil(seconds / 60);
}

function imageUrl(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = imageUrl(entry);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof value === 'string') return value.trim() || undefined;
  if (value && typeof value === 'object') {
    const image = value as Record<string, unknown>;
    return imageUrl(image.url) ?? imageUrl(image.contentUrl);
  }
  return undefined;
}

function servings(value: unknown): number {
  const candidate = values(value)[0] ?? '';
  const match = /\d+(?:\.\d+)?/.exec(candidate);
  return match ? Number(match[0]) : 0;
}

function instructionSteps(value: unknown): { text: string }[] {
  if (Array.isArray(value)) return value.flatMap(instructionSteps);
  if (typeof value === 'string') {
    const normalized = text(value);
    return normalized ? [{ text: normalized }] : [];
  }
  if (!value || typeof value !== 'object') return [];
  const node = value as Record<string, unknown>;
  if (node.itemListElement) return instructionSteps(node.itemListElement);
  const normalized = text(node.text ?? node.name);
  return normalized ? [{ text: normalized }] : [];
}

function normalizedTags(node: Record<string, unknown>): string[] {
  return [
    ...values(node.recipeCategory),
    ...values(node.recipeCuisine),
    ...values(node.keywords),
  ].flatMap((entry) => entry.toLowerCase().split(/[,;/|]+/).map((part) => part.trim()));
}

function includesTag(tags: readonly string[], aliases: readonly string[]): boolean {
  return tags.some((tag) => aliases.some((alias) => tag === alias || tag.includes(alias)));
}

function mealTypes(tags: readonly string[]): MealType[] {
  return MEAL_TYPES.filter((mealType) => includesTag(tags, [mealType]));
}

const CUISINE_ALIASES: Record<Cuisine, readonly string[]> = {
  asian: ['asian', 'chinese', 'japanese', 'thai', 'vietnamese', 'korean'],
  mexican: ['mexican', 'tex-mex'],
  mediterranean: ['mediterranean'],
  italian: ['italian'],
  indian: ['indian'],
  greek: ['greek'],
  american: ['american'],
  french: ['french'],
  'middle-eastern': ['middle eastern', 'middle-eastern', 'levantine'],
  global: ['global', 'international'],
};

function cuisines(tags: readonly string[]): Cuisine[] {
  return CUISINES.filter((cuisine) => includesTag(tags, CUISINE_ALIASES[cuisine]));
}

const MODIFIER_ALIASES: Record<Modifier, readonly string[]> = {
  vegetarian: ['vegetarian', 'meatless'],
  'kid-friendly': ['kid friendly', 'kid-friendly', 'family friendly', 'family-friendly'],
  healthy: ['healthy', 'light', 'wholesome'],
  salad: ['salad'],
};

function modifiers(tags: readonly string[]): Modifier[] {
  return MODIFIERS.filter((modifier) => includesTag(tags, MODIFIER_ALIASES[modifier]));
}

export function parseCatalogueRecipe(html: string, _sourceUrl: string): ParsedCatalogueRecipe {
  const node = recipeNode(html);
  if (!node) throw new Error('Recipe JSON-LD was not found');

  const title = text(node.name ?? node.headline);
  if (!title) throw new Error('Recipe JSON-LD is missing a title');

  const ingredients = values(node.recipeIngredient).map((name) => ({ name }));
  if (ingredients.length === 0) throw new Error('Recipe JSON-LD is missing ingredients');

  const instructions = instructionSteps(node.recipeInstructions);
  if (instructions.length === 0) throw new Error('Recipe JSON-LD is missing instructions');

  const tags = normalizedTags(node);
  const prepMinutes = parseIsoDurationMinutes(node.prepTime);
  const cookMinutes = parseIsoDurationMinutes(node.cookTime);
  const totalMinutes = parseIsoDurationMinutes(node.totalTime);
  const description = text(node.description);
  const parsedImageUrl = imageUrl(node.image);

  return {
    content: {
      title,
      ...(parsedImageUrl ? { imageUrl: parsedImageUrl } : {}),
      ...(description ? { description } : {}),
      originalServings: servings(node.recipeYield),
      ingredients,
      instructions,
    },
    sourceMetadata: {
      ...(prepMinutes === undefined ? {} : { prepMinutes }),
      ...(cookMinutes === undefined ? {} : { cookMinutes }),
      ...(totalMinutes === undefined ? {} : { totalMinutes }),
      mealTypes: mealTypes(tags),
      cuisines: cuisines(tags),
      modifiers: modifiers(tags),
    },
  };
}
