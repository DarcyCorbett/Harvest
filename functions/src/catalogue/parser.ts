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

export type CatalogueParseFailureReason =
  | 'non-recipe-page'
  | 'missing-recipe-markup'
  | 'missing-display-content'
  | 'unsupported-markup';

export class CatalogueParseError extends Error {
  constructor(public readonly reasonCode: CatalogueParseFailureReason, detail?: string) {
    super(detail ?? reasonCode);
    this.name = 'CatalogueParseError';
  }
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_match, code: string) =>
      String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function text(value: unknown): string {
  if (typeof value !== 'string') return '';
  return decodeEntities(value
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
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
  for (const nested of Object.values(node)) {
    if (nested && typeof nested === 'object') visitJsonLd(nested, recipes);
  }
}

function jsonLdRecipeNode(html: string): Record<string, unknown> | undefined {
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

function embeddedStateRecipeNode(html: string): Record<string, unknown> | undefined {
  const recipes: Record<string, unknown>[] = [];
  const scripts = html.matchAll(
    /<script\b[^>]*(?:id=["']__NEXT_DATA__["']|type=["']application\/json["'])[^>]*>([\s\S]*?)<\/script>/gi,
  );
  for (const match of scripts) {
    try {
      visitJsonLd(JSON.parse(decodeEntities(match[1].trim())), recipes);
    } catch {
      // Ignore unrelated or malformed public state blocks.
    }
  }
  return recipes[0];
}

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}=["']([^"']+)["']`, 'i').exec(tag);
  return match ? decodeEntities(match[1]) : undefined;
}

function itemPropValues(html: string, property: string): string[] {
  const values: string[] = [];
  const pattern = new RegExp(
    `<([a-z0-9:-]+)\\b([^>]*\\bitemprop=["'][^"']*\\b${property}\\b[^"']*["'][^>]*)>([\\s\\S]*?)<\\/\\1>|<([a-z0-9:-]+)\\b([^>]*\\bitemprop=["'][^"']*\\b${property}\\b[^"']*["'][^>]*)\\/?>`,
    'gi',
  );
  for (const match of html.matchAll(pattern)) {
    const tag = `<${match[1] ?? match[4]} ${match[2] ?? match[5]}>`;
    const value = attribute(tag, 'content')
      ?? attribute(tag, 'datetime')
      ?? attribute(tag, 'href')
      ?? attribute(tag, 'src')
      ?? text(match[3]);
    if (value?.trim()) values.push(value.trim());
  }
  return values;
}

function classValues(html: string, className: string): string[] {
  const values: string[] = [];
  const pattern = new RegExp(
    `<([a-z0-9:-]+)\\b[^>]*class=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/\\1>`,
    'gi',
  );
  for (const match of html.matchAll(pattern)) {
    const value = text(match[2]);
    if (value) values.push(value);
  }
  return values;
}

function markupRecipeNode(html: string): Record<string, unknown> | undefined {
  const hasRecipeMicrodata = /\bitemtype=["'][^"']*schema\.org\/Recipe/i.test(html);
  const plugin = /\b(?:wprm-recipe|tasty-recipes)\b/i.test(html);
  if (!hasRecipeMicrodata && !plugin) return undefined;

  const wprm = /\bwprm-recipe\b/i.test(html);
  const tasty = /\btasty-recipes\b/i.test(html);
  const first = (...groups: string[][]): string | undefined => groups.flat().find(Boolean);
  const name = first(
    itemPropValues(html, 'name'),
    wprm ? classValues(html, 'wprm-recipe-name') : [],
    tasty ? classValues(html, 'tasty-recipes-title') : [],
  );
  const ingredients = [
    ...itemPropValues(html, 'recipeIngredient'),
    ...(wprm ? classValues(html, 'wprm-recipe-ingredient') : []),
    ...(tasty ? classValues(html, 'ingredient') : []),
  ];
  const instructions = [
    ...itemPropValues(html, 'recipeInstructions'),
    ...(wprm ? classValues(html, 'wprm-recipe-instruction-text') : []),
    ...(tasty ? classValues(html, 'instruction') : []),
  ];
  return {
    '@type': 'Recipe',
    name,
    recipeIngredient: [...new Set(ingredients)],
    recipeInstructions: [...new Set(instructions)],
    recipeYield: first(
      itemPropValues(html, 'recipeYield'),
      wprm ? classValues(html, 'wprm-recipe-servings') : [],
      tasty ? classValues(html, 'tasty-recipes-yield') : [],
    ),
    prepTime: first(itemPropValues(html, 'prepTime')),
    cookTime: first(itemPropValues(html, 'cookTime')),
    totalTime: first(itemPropValues(html, 'totalTime')),
    image: first(itemPropValues(html, 'image')),
    recipeCategory: itemPropValues(html, 'recipeCategory'),
    recipeCuisine: itemPropValues(html, 'recipeCuisine'),
    keywords: itemPropValues(html, 'keywords'),
  };
}

function recipeNode(html: string): Record<string, unknown> | undefined {
  return jsonLdRecipeNode(html)
    ?? markupRecipeNode(html)
    ?? embeddedStateRecipeNode(html);
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
  if (!node) {
    const hasRecipeSignal = /\b(?:recipe|wprm|tasty-recipes|schema\.org\/Recipe)\b/i.test(html);
    throw new CatalogueParseError(
      hasRecipeSignal ? 'missing-recipe-markup' : 'non-recipe-page',
    );
  }

  const title = text(node.name ?? node.headline);
  if (!title) {
    throw new CatalogueParseError('missing-display-content', 'Recipe is missing a title');
  }

  const ingredients = values(node.recipeIngredient).map((name) => ({ name }));
  if (ingredients.length === 0) {
    throw new CatalogueParseError('missing-display-content', 'Recipe is missing ingredients');
  }

  const instructions = instructionSteps(node.recipeInstructions);
  if (instructions.length === 0) {
    throw new CatalogueParseError('missing-display-content', 'Recipe is missing instructions');
  }
  const originalServings = servings(node.recipeYield);
  if (originalServings <= 0) {
    throw new CatalogueParseError('missing-display-content', 'Recipe is missing servings');
  }

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
      originalServings,
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
