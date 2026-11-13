import {
  CUISINES,
  MEAL_TYPES,
  MODIFIERS,
  type CompleteCanonicalRecipeV2,
  type CanonicalAdditionalTime,
  type CanonicalAttribution,
  type CanonicalEquipmentItem,
  type CanonicalIngredientGroup,
  type CanonicalInstructionStep,
  type CanonicalNutrition,
  type CanonicalSourceRating,
  type Cuisine,
  type MealType,
  type Modifier,
} from './domain.js';
import { normalizeCatalogueContent } from './unitNormalization.js';

export type EnrichmentField =
  | 'imageUrl'
  | 'imageUrls'
  | 'videoEmbedUrl'
  | 'description'
  | 'attribution'
  | 'sourceRating'
  | 'equipment'
  | 'additionalTimes'
  | 'noteSections'
  | 'notes'
  | 'dietaryClaims'
  | 'cookingMethods'
  | 'sourceCategories'
  | 'sourceCuisines'
  | 'sourceKeywords'
  | 'estimatedCost'
  | 'ingredientGroups'
  | 'nutrition'
  | 'instructionEnrichment';

export type EnrichmentAvailability = Partial<
  Record<EnrichmentField, 'available' | 'confirmed-absent' | 'unavailable'>
>;

export type ParsedCatalogueRecipe = Pick<CompleteCanonicalRecipeV2, 'content' | 'sourceMetadata'> & {
  enrichment?: EnrichmentAvailability;
};

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

export function decodeEntities(value: string): string {
  return value
    // Core entities (&amp; must come first to avoid double-decoding)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    // Whitespace / punctuation
    .replace(/&ndash;/g, '–')
    .replace(/&mdash;/g, '—')
    .replace(/&hellip;/g, '…')
    .replace(/&middot;/g, '·')
    .replace(/&bull;/g, '•')
    .replace(/&deg;/g, '°')
    .replace(/&times;/g, '×')
    .replace(/&divide;/g, '÷')
    // Quotes
    .replace(/&rsquo;/g, '’')
    .replace(/&lsquo;/g, '‘')
    .replace(/&rdquo;/g, '”')
    .replace(/&ldquo;/g, '“')
    .replace(/&raquo;/g, '»')
    .replace(/&laquo;/g, '«')
    // Fractions / maths
    .replace(/&frac12;/g, '½')
    .replace(/&frac14;/g, '¼')
    .replace(/&frac34;/g, '¾')
    .replace(/&frac13;/g, '⅓')
    .replace(/&frac23;/g, '⅔')
    .replace(/&frac18;/g, '⅛')
    .replace(/&frac38;/g, '⅜')
    .replace(/&frac58;/g, '⅝')
    .replace(/&frac78;/g, '⅞')
    .replace(/&Prime;/g, '″')
    .replace(/&prime;/g, '′')
    // Accented characters
    .replace(/&[Ee]acute;/g, (m) => (m[1] === 'E' ? 'É' : 'é'))
    .replace(/&[Ee]grave;/g, (m) => (m[1] === 'E' ? 'È' : 'è'))
    .replace(/&[Ee]circ;/g, (m) => (m[1] === 'E' ? 'Ê' : 'ê'))
    .replace(/&[Aa]grave;/g, (m) => (m[1] === 'A' ? 'À' : 'à'))
    .replace(/&[Aa]acute;/g, (m) => (m[1] === 'A' ? 'Á' : 'á'))
    .replace(/&[Aa]circ;/g, (m) => (m[1] === 'A' ? 'Â' : 'â'))
    .replace(/&[Aa]uml;/g, (m) => (m[1] === 'A' ? 'Ä' : 'ä'))
    .replace(/&[Oo]acute;/g, (m) => (m[1] === 'O' ? 'Ó' : 'ó'))
    .replace(/&[Oo]uml;/g, (m) => (m[1] === 'O' ? 'Ö' : 'ö'))
    .replace(/&[Uu]acute;/g, (m) => (m[1] === 'U' ? 'Ú' : 'ú'))
    .replace(/&[Uu]uml;/g, (m) => (m[1] === 'U' ? 'Ü' : 'ü'))
    .replace(/&[Ii]acute;/g, (m) => (m[1] === 'I' ? 'Í' : 'í'))
    .replace(/&[Cc]cedil;/g, (m) => (m[1] === 'C' ? 'Ç' : 'ç'))
    .replace(/&[Nn]tilde;/g, (m) => (m[1] === 'N' ? 'Ñ' : 'ñ'))
    .replace(/&szlig;/g, 'ß')
    // Symbols
    .replace(/&copy;/g, '©')
    .replace(/&reg;/g, '®')
    .replace(/&trade;/g, '™')
    // Numeric references: decimal &#123; and hex &#xAB; with bounds check
    .replace(/&#x([0-9a-fA-F]+);/g, (match, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    })
    .replace(/&#(\d+);/g, (match, dec) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    });
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
      try {
        visitJsonLd(
          JSON.parse(
            match[1]
              .trim()
              .replace(/&quot;/g, '"')
              .replace(/&#34;/g, '"')
              .replace(/&apos;/g, "'")
              .replace(/&#39;/g, "'")
              .replace(/&amp;/g, '&'),
          ),
          recipes,
        );
      } catch {
        // Ignore malformed publisher blocks and continue to the next one.
      }
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
    nutrition: {
      calories: first(itemPropValues(html, 'calories')),
      proteinContent: first(itemPropValues(html, 'proteinContent')),
      carbohydrateContent: first(itemPropValues(html, 'carbohydrateContent')),
      fatContent: first(itemPropValues(html, 'fatContent')),
    },
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

/** Only HTTPS media and links are kept: Android blocks cleartext loads. */
function httpsUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const candidate = decodeEntities(value.trim());
  return /^https:\/\/[^\s"'<>]+$/i.test(candidate) ? candidate : undefined;
}

function allImageUrls(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(allImageUrls);
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  if (value && typeof value === 'object') {
    const image = value as Record<string, unknown>;
    return [...allImageUrls(image.url), ...allImageUrls(image.contentUrl)];
  }
  return [];
}

function httpsImageUrls(value: unknown): string[] {
  return [...new Set(allImageUrls(value).flatMap((url) => httpsUrl(url) ?? []))];
}

function videoEmbedUrl(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = videoEmbedUrl(entry);
      if (found) return found;
    }
    return undefined;
  }
  const video = value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
  const url = httpsUrl(video ? video.embedUrl ?? video.contentUrl : value);
  if (!url) return undefined;
  const youtube = /^https:\/\/(?:www\.|m\.)?youtube\.com\/watch\?(?:[^#]*&)?v=([\w-]+)/i.exec(url)
    ?? /^https:\/\/youtu\.be\/([\w-]+)/i.exec(url);
  return youtube ? `https://www.youtube.com/embed/${youtube[1]}` : url;
}

function instructionSteps(value: unknown): CanonicalInstructionStep[] {
  if (Array.isArray(value)) return value.flatMap(instructionSteps);
  if (typeof value === 'string') {
    const normalized = text(value);
    return normalized ? [{ text: normalized }] : [];
  }
  if (!value || typeof value !== 'object') return [];
  const node = value as Record<string, unknown>;
  if (node.itemListElement) {
    const steps = instructionSteps(node.itemListElement);
    const heading = hasType(node, 'HowToSection') ? text(node.name) : '';
    return heading && steps.length > 0 ? [{ text: heading, isHeader: true }, ...steps] : steps;
  }
  const body = text(node.text);
  const name = text(node.name);
  const normalized = body || name;
  if (!normalized) return [];
  // Publishers often repeat a truncated copy of the step as its name.
  const isTitle = body && name && name !== body
    && !body.startsWith(name.replace(/(?:\.{3}|…)$/, '').trim());
  const stepImage = httpsImageUrls(node.image)[0];
  const stepVideo = videoEmbedUrl(node.video);
  const stepUrl = httpsUrl(node.url);
  return [{
    text: normalized,
    ...(isTitle ? { title: name } : {}),
    ...(stepUrl ? { sourceUrl: stepUrl } : {}),
    ...(stepImage ? { imageUrl: stepImage } : {}),
    ...(stepVideo ? { videoEmbedUrl: stepVideo } : {}),
  }];
}

function names(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(names);
  if (value && typeof value === 'object') return names((value as Record<string, unknown>).name);
  const normalized = text(value);
  return normalized ? [normalized] : [];
}

function unique(entries: string[], limit = 40): string[] {
  return [...new Set(entries.map((entry) => entry.trim()).filter(Boolean))].slice(0, limit);
}

function attribution(node: Record<string, unknown>): CanonicalAttribution | undefined {
  const author = names(node.author)[0];
  const publisher = names(node.publisher)[0];
  const publishedAt = text(node.datePublished);
  const modifiedAt = text(node.dateModified);
  const result: CanonicalAttribution = {
    ...(author ? { author } : {}),
    ...(publisher ? { publisher } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    ...(modifiedAt ? { modifiedAt } : {}),
  };
  return Object.keys(result).length > 0 ? result : undefined;
}

function sourceRating(value: unknown): CanonicalSourceRating | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const rating = value as Record<string, unknown>;
  const score = Number(text(String(rating.ratingValue ?? '')));
  // Ratings on other scales are skipped rather than guessed at.
  if (!Number.isFinite(score) || score <= 0 || score > 5) return undefined;
  const count = Number(text(String(rating.ratingCount ?? rating.reviewCount ?? '')).replace(/,/g, ''));
  return {
    value: score,
    ...(Number.isInteger(count) && count > 0 ? { count } : {}),
  };
}

/** "https://schema.org/GlutenFreeDiet" -> "Gluten Free". */
function dietLabel(value: string): string {
  return value
    .replace(/^.*\//, '')
    .replace(/Diet$/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim();
}

interface MarkupElement {
  attributes: string;
  inner: string;
}

function classTokens(attributes: string): string[] {
  const match = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attributes);
  return (match?.[1] ?? match?.[2] ?? '').split(/\s+/).filter(Boolean);
}

/** Elements carrying an exact class token, with balanced inner markup. */
function elementsWithClass(html: string, className: string): MarkupElement[] {
  if (!html.includes(className)) return [];
  const found: MarkupElement[] = [];
  for (const match of html.matchAll(/<([a-z][a-z0-9]*)\b([^<>]*)>/gi)) {
    if (!match[2].includes(className) || !classTokens(match[2]).includes(className)) continue;
    const start = (match.index ?? 0) + match[0].length;
    const boundary = new RegExp(`<(/?)${match[1]}\\b[^<>]*>`, 'gi');
    boundary.lastIndex = start;
    let depth = 1;
    for (let tag = boundary.exec(html); tag; tag = boundary.exec(html)) {
      if (tag[1]) depth -= 1;
      else if (!tag[0].endsWith('/>')) depth += 1;
      if (depth === 0) {
        found.push({ attributes: match[2], inner: html.slice(start, tag.index) });
        break;
      }
    }
  }
  return found;
}

function firstText(html: string, ...classNames: string[]): string {
  for (const className of classNames) {
    const value = text(elementsWithClass(html, className)[0]?.inner);
    if (value) return value;
  }
  return '';
}

/** Recipe-card plugins: the card container and the element holding its notes. */
const NOTE_PROFILES: readonly (readonly [container: string, notes: string])[] = [
  ['wprm-recipe-container', 'wprm-recipe-notes-container'],
  ['tasty-recipes', 'tasty-recipes-notes-body'],
  ['mv-create-card', 'mv-create-notes'],
  ['delicious-recipe', 'delicious-recipe-notes'],
  ['cooked-recipe-card', 'cooked-recipe-notes'],
  ['wpzoom-recipe-card', 'wpzoom-recipe-card-notes'],
  ['recipe-card', 'recipe-card__notes'],
];

function noteItems(html: string): string[] {
  for (const [container, notes] of NOTE_PROFILES) {
    if (!html.includes(container)) continue;
    for (const element of elementsWithClass(html, notes)) {
      const items = element.inner
        .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
        .replace(/<br\s*\/?>|<\/(?:p|li|div|h[1-6]|ul|ol|tr|blockquote)>/gi, '\n')
        .split('\n')
        .map((line) => text(line))
        .filter((line) => line && !/^(?:recipe\s+)?notes?:?$/i.test(line))
        .slice(0, 60);
      if (items.length > 0) return items;
    }
  }
  return [];
}

function lazyImageUrl(html: string): string | undefined {
  for (const tag of html.matchAll(/<img\b[^<>]*>/gi)) {
    for (const name of ['data-lazy-src', 'data-src', 'src']) {
      const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*["']([^"']+)["']`, 'i').exec(tag[0].slice(4));
      const url = httpsUrl(match?.[1]);
      if (url) return url;
    }
  }
  return undefined;
}

function durationMinutes(value: string): number | undefined {
  let total = 0;
  for (const match of value.matchAll(/(\d+(?:\.\d+)?)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m)\b/gi)) {
    const unit = match[2].toLowerCase();
    total += Number(match[1]) * (unit.startsWith('d') ? 1_440 : unit.startsWith('h') ? 60 : 1);
  }
  const minutes = Math.round(total);
  return minutes > 0 && minutes <= 43_200 ? minutes : undefined;
}

interface PluginMarkup {
  ingredientGroups: CanonicalIngredientGroup[];
  instructions: CanonicalInstructionStep[];
  equipment: CanonicalEquipmentItem[];
  additionalTimes: CanonicalAdditionalTime[];
}

/** WP Recipe Maker renders structure that its JSON-LD omits. */
function wprmMarkup(html: string): PluginMarkup {
  const empty: PluginMarkup = { ingredientGroups: [], instructions: [], equipment: [], additionalTimes: [] };
  if (!html.includes('wprm-recipe')) return empty;

  const ingredientGroups = elementsWithClass(html, 'wprm-recipe-ingredient-group')
    .map((group) => ({
      name: firstText(group.inner, 'wprm-recipe-ingredient-group-name'),
      ingredients: elementsWithClass(group.inner, 'wprm-recipe-ingredient')
        .map((ingredient) => ({ name: text(ingredient.inner) }))
        .filter((ingredient) => ingredient.name),
    }))
    .filter((group) => group.ingredients.length > 0);

  const instructions = elementsWithClass(html, 'wprm-recipe-instruction-group').flatMap((group) => {
    const heading = firstText(group.inner, 'wprm-recipe-instruction-group-name');
    const steps = elementsWithClass(group.inner, 'wprm-recipe-instruction').flatMap((step) => {
      const body = firstText(step.inner, 'wprm-recipe-instruction-text') || text(step.inner);
      const stepImage = lazyImageUrl(step.inner);
      return body ? [{ text: body, ...(stepImage ? { imageUrl: stepImage } : {}) }] : [];
    });
    return heading && steps.length > 0 ? [{ text: heading, isHeader: true }, ...steps] : steps;
  });

  const equipmentNames = ['wprm-recipe-equipment-name', 'wprm-recipe-equipment-item', 'wprm-recipe-equipment']
    .map((className) => elementsWithClass(html, className).map((item) => text(item.inner)))
    .find((entries) => entries.some(Boolean)) ?? [];

  const additionalTimes = elementsWithClass(html, 'wprm-recipe-custom-time-container').flatMap((time) => {
    const label = firstText(time.inner, 'wprm-recipe-custom-time-name', 'wprm-recipe-custom-time-label');
    const minutes = durationMinutes(text(time.inner).slice(label.length));
    const cleaned = label.replace(/:\s*$/, '').trim();
    return cleaned && minutes ? [{ label: cleaned, minutes }] : [];
  });

  return {
    ingredientGroups,
    instructions,
    equipment: unique(equipmentNames).map((name) => ({ name })),
    additionalTimes,
  };
}

function comparableStep(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Card markup only adds headings and step photos. It is used when its steps
 * match the structured data one-for-one, so step wording never changes.
 */
function withMarkupStructure(
  steps: CanonicalInstructionStep[],
  markup: CanonicalInstructionStep[],
): CanonicalInstructionStep[] {
  const structured = steps.filter((step) => !step.isHeader);
  const rendered = markup.filter((step) => !step.isHeader);
  if (rendered.length === 0 || structured.length !== rendered.length
    || rendered.some((step, index) => (
      comparableStep(step.text) !== comparableStep(structured[index].text)))) {
    return steps;
  }
  let index = 0;
  const layout = steps.some((step) => step.isHeader) ? steps : markup;
  return layout.map((entry) => {
    if (entry.isHeader) return entry;
    const step = structured[index];
    const image = step.imageUrl ?? rendered[index].imageUrl;
    index += 1;
    return { ...step, ...(image ? { imageUrl: image } : {}) };
  });
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

function rounded(value: number): number {
  return Math.round(value * 10) / 10;
}

function numericAmount(value: unknown): { amount: number; unit: string } | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? { amount: value, unit: '' } : undefined;
  }
  if (typeof value !== 'string') return undefined;
  const normalized = text(value).toLowerCase().replace(/,/g, '');
  const match = /(-?\d+(?:\.\d+)?)\s*([a-z]+)?/.exec(normalized);
  if (!match) return undefined;
  const amount = Number(match[1]);
  return Number.isFinite(amount) && amount >= 0
    ? { amount, unit: match[2] ?? '' }
    : undefined;
}

function energy(value: unknown): number | undefined {
  const parsed = numericAmount(value);
  if (!parsed) return undefined;
  if (!parsed.unit || ['kcal', 'cal', 'calorie', 'calories'].includes(parsed.unit)) {
    return rounded(parsed.amount);
  }
  if (['kj', 'kilojoule', 'kilojoules'].includes(parsed.unit)) {
    return rounded(parsed.amount / 4.184);
  }
  return undefined;
}

function grams(value: unknown): number | undefined {
  const parsed = numericAmount(value);
  if (!parsed) return undefined;
  if (!parsed.unit || ['g', 'gram', 'grams'].includes(parsed.unit)) {
    return rounded(parsed.amount);
  }
  if (['mg', 'milligram', 'milligrams'].includes(parsed.unit)) {
    return rounded(parsed.amount / 1_000);
  }
  return undefined;
}

function milligrams(value: unknown): number | undefined {
  const parsed = numericAmount(value);
  if (!parsed) return undefined;
  if (!parsed.unit || ['mg', 'milligram', 'milligrams'].includes(parsed.unit)) {
    return rounded(parsed.amount);
  }
  if (['g', 'gram', 'grams'].includes(parsed.unit)) {
    return rounded(parsed.amount * 1_000);
  }
  return undefined;
}

export function parseNutrition(value: unknown): CanonicalNutrition | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const data = value as Record<string, unknown>;
  const calories = energy(data.calories);
  const protein = grams(data.proteinContent ?? data.protein);
  const carbs = grams(data.carbohydrateContent ?? data.carbs);
  const fat = grams(data.fatContent ?? data.fat);
  const fiber = grams(data.fiberContent);
  const sugar = grams(data.sugarContent);
  const saturatedFat = grams(data.saturatedFatContent);
  const unsaturatedFat = grams(data.unsaturatedFatContent);
  const transFat = grams(data.transFatContent);
  const sodium = milligrams(data.sodiumContent);
  const cholesterol = milligrams(data.cholesterolContent);
  const nutrition: CanonicalNutrition = {
    ...(calories === undefined ? {} : { calories }),
    ...(protein === undefined ? {} : { protein }),
    ...(carbs === undefined ? {} : { carbs }),
    ...(fat === undefined ? {} : { fat }),
    ...(fiber === undefined ? {} : { fiber }),
    ...(sugar === undefined ? {} : { sugar }),
    ...(saturatedFat === undefined ? {} : { saturatedFat }),
    ...(unsaturatedFat === undefined ? {} : { unsaturatedFat }),
    ...(transFat === undefined ? {} : { transFat }),
    ...(sodium === undefined ? {} : { sodium }),
    ...(cholesterol === undefined ? {} : { cholesterol }),
  };
  return Object.values(nutrition).some((entry) => entry !== undefined && entry > 0)
    ? nutrition
    : undefined;
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

  const markup = wprmMarkup(html);
  const instructions = withMarkupStructure(
    instructionSteps(node.recipeInstructions),
    markup.instructions,
  );
  if (!instructions.some((step) => !step.isHeader)) {
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
  const images = httpsImageUrls(node.image);
  const parsedImageUrl = images[0] ?? imageUrl(node.image);
  const nutrition = parseNutrition(node.nutrition);
  const recipeAttribution = attribution(node);
  const rating = sourceRating(node.aggregateRating);
  const tools = unique(names(node.tool)).map((name) => ({ name }));
  const equipment = tools.length > 0 ? tools : markup.equipment;
  const dietaryClaims = unique(values(node.suitableForDiet).map(dietLabel));
  const cookingMethods = unique(values(node.cookingMethod).flatMap((entry) => entry.split(/[,;]/)));
  const sourceKeywords = unique(values(node.keywords).flatMap((entry) => entry.split(/[,;]/)));
  const notes = noteItems(html);
  // Groups drive shopping quantities, so only accept a complete, named breakdown.
  const ingredientGroups = markup.ingredientGroups.some((group) => group.name)
    && markup.ingredientGroups.reduce((sum, group) => sum + group.ingredients.length, 0)
      === ingredients.length
    ? markup.ingredientGroups
    : [];

  const content = normalizeCatalogueContent({
      title,
      ...(parsedImageUrl ? { imageUrl: parsedImageUrl } : {}),
      ...(images.length > 1 ? { imageUrls: images } : {}),
      ...(description ? { description } : {}),
      ...(recipeAttribution ? { attribution: recipeAttribution } : {}),
      ...(rating ? { sourceRating: rating } : {}),
      ...(equipment.length > 0 ? { equipment } : {}),
      ...(markup.additionalTimes.length > 0 ? { additionalTimes: markup.additionalTimes } : {}),
      ...(notes.length > 0 ? { noteSections: [{ items: notes }] } : {}),
      ...(dietaryClaims.length > 0 ? { dietaryClaims } : {}),
      ...(cookingMethods.length > 0 ? { cookingMethods } : {}),
      ...(sourceKeywords.length > 0 ? { sourceKeywords } : {}),
      originalServings,
      ingredients,
      ...(ingredientGroups.length > 0 ? { ingredientGroups } : {}),
      instructions,
      ...(notes.length > 0 ? { notes: notes.join('\n') } : {}),
      ...(nutrition ? { nutrition } : {}),
    }).content;

  return {
    content,
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
