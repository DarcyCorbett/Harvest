// ============================================================
// HTML primitives + WPRM recipe parsing — turns raw HTML into Recipe objects.
// ============================================================

import type { Ingredient, IngredientGroup, InstructionStep, Recipe } from '../types';

// ─── HTML Utilities ───────────────────────────────────────────

/** Strip HTML tags and decode HTML entities to plain text. */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/p>/gi, ' ')
    .replace(/<\/li>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    // Core entities (order: &amp; must come first to avoid double-decoding)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    // Whitespace / punctuation
    .replace(/&nbsp;/g, ' ')
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
    .replace(/&Prime;/g, '″')
    .replace(/&prime;/g, '′')
    // Accented characters (common in recipe text: sauté, naïve, jalapeño, etc.)
    .replace(/&[Ee]acute;/g, (m) => m[1] === 'E' ? 'É' : 'é')
    .replace(/&[Ee]grave;/g, (m) => m[1] === 'E' ? 'È' : 'è')
    .replace(/&[Ee]circ;/g, (m) => m[1] === 'E' ? 'Ê' : 'ê')
    .replace(/&[Aa]grave;/g, (m) => m[1] === 'A' ? 'À' : 'à')
    .replace(/&[Aa]acute;/g, (m) => m[1] === 'A' ? 'Á' : 'á')
    .replace(/&[Aa]circ;/g, (m) => m[1] === 'A' ? 'Â' : 'â')
    .replace(/&[Aa]uml;/g, (m) => m[1] === 'A' ? 'Ä' : 'ä')
    .replace(/&[Oo]acute;/g, (m) => m[1] === 'O' ? 'Ó' : 'ó')
    .replace(/&[Oo]uml;/g, (m) => m[1] === 'O' ? 'Ö' : 'ö')
    .replace(/&[Uu]acute;/g, (m) => m[1] === 'U' ? 'Ú' : 'ú')
    .replace(/&[Uu]uml;/g, (m) => m[1] === 'U' ? 'Ü' : 'ü')
    .replace(/&[Ii]acute;/g, (m) => m[1] === 'I' ? 'Í' : 'í')
    .replace(/&[Cc]cedil;/g, (m) => m[1] === 'C' ? 'Ç' : 'ç')
    .replace(/&[Nn]tilde;/g, (m) => m[1] === 'N' ? 'Ñ' : 'ñ')
    .replace(/&szlig;/g, 'ß')
    // Symbols
    .replace(/&copy;/g, '©')
    .replace(/&reg;/g, '®')
    .replace(/&trade;/g, '™')
    // Numeric references: decimal &#123; and hex &#xAB;
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Starting from contentStart (right after an opening tag),
 * return the inner HTML up to the matching closing tag using depth tracking.
 */
function depthTrack(html: string, tagName: string, contentStart: number): string | null {
  const openTag = `<${tagName}`;
  const closeTag = `</${tagName}>`;
  let depth = 1;
  let pos = contentStart;

  while (pos < html.length && depth > 0) {
    const nextOpen = html.indexOf(openTag, pos);
    const nextClose = html.indexOf(closeTag, pos);

    if (nextClose === -1) return null;

    if (nextOpen !== -1 && nextOpen < nextClose) {
      const ch = html[nextOpen + openTag.length];
      if (ch === ' ' || ch === '>' || ch === '\n' || ch === '\t' || ch === '\r' || ch === '/') {
        depth++;
      }
      pos = nextOpen + 1;
    } else {
      depth--;
      if (depth === 0) return html.slice(contentStart, nextClose);
      pos = nextClose + closeTag.length;
    }
  }

  return null;
}

/**
 * Return the inner HTML of the first element whose class attribute
 * includes className as an exact word.
 */
function extractByClass(html: string, className: string): string | null {
  const marker = 'class="';
  let pos = 0;

  while (pos < html.length) {
    const idx = html.indexOf(marker, pos);
    if (idx === -1) break;

    const valStart = idx + marker.length;
    const valEnd = html.indexOf('"', valStart);
    if (valEnd === -1) break;

    const classes = html.slice(valStart, valEnd).split(/\s+/);
    if (classes.includes(className)) {
      const tagStart = html.lastIndexOf('<', idx);
      if (tagStart === -1) { pos = valEnd + 1; continue; }
      const tagMatch = /^<(\w+)/.exec(html.slice(tagStart));
      if (!tagMatch) { pos = valEnd + 1; continue; }

      const tagName = tagMatch[1].toLowerCase();
      const openEnd = html.indexOf('>', idx);
      if (openEnd === -1) break;
      if (html[openEnd - 1] === '/') { pos = openEnd + 1; continue; } // self-closing

      const inner = depthTrack(html, tagName, openEnd + 1);
      if (inner !== null) return inner;
    }

    pos = valEnd + 1;
  }

  return null;
}

/**
 * Return the inner HTML of every element whose class attribute
 * includes className as an exact word.
 */
function extractAllByClass(html: string, className: string): string[] {
  const results: string[] = [];
  const marker = 'class="';
  let pos = 0;

  while (pos < html.length) {
    const idx = html.indexOf(marker, pos);
    if (idx === -1) break;

    const valStart = idx + marker.length;
    const valEnd = html.indexOf('"', valStart);
    if (valEnd === -1) break;

    const classes = html.slice(valStart, valEnd).split(/\s+/);
    if (classes.includes(className)) {
      const tagStart = html.lastIndexOf('<', idx);
      if (tagStart === -1) { pos = valEnd + 1; continue; }
      const tagMatch = /^<(\w+)/.exec(html.slice(tagStart));
      if (!tagMatch) { pos = valEnd + 1; continue; }

      const tagName = tagMatch[1].toLowerCase();
      const openEnd = html.indexOf('>', idx);
      if (openEnd === -1) break;

      if (html[openEnd - 1] === '/') {
        results.push('');
        pos = openEnd + 1;
        continue;
      }

      const contentStart = openEnd + 1;
      const inner = depthTrack(html, tagName, contentStart);
      if (inner !== null) {
        results.push(inner);
        pos = contentStart + inner.length + `</${tagName}>`.length;
      } else {
        pos = valEnd + 1;
      }
    } else {
      pos = valEnd + 1;
    }
  }

  return results;
}

/** Get the plain-text content of the first element with the given class. */
function getFirstText(html: string, className: string): string {
  const inner = extractByClass(html, className);
  return inner !== null ? htmlToText(inner) : '';
}

/**
 * Return the inner HTML of every element of the given tag name.
 * Uses depthTrack so nested same-tag elements are handled correctly.
 */
function extractAllByTag(html: string, tagName: string): string[] {
  const results: string[] = [];
  const openTag = `<${tagName}`;
  let pos = 0;

  while (pos < html.length) {
    const idx = html.indexOf(openTag, pos);
    if (idx === -1) break;

    const ch = html[idx + openTag.length];
    if (ch !== ' ' && ch !== '>' && ch !== '\n' && ch !== '\t' && ch !== '\r' && ch !== '/') {
      pos = idx + 1;
      continue;
    }

    const openEnd = html.indexOf('>', idx);
    if (openEnd === -1) break;

    if (html[openEnd - 1] === '/') {
      results.push('');
      pos = openEnd + 1;
      continue;
    }

    const contentStart = openEnd + 1;
    const inner = depthTrack(html, tagName, contentStart);
    if (inner !== null) {
      results.push(inner);
      pos = contentStart + inner.length + `</${tagName}>`.length;
    } else {
      pos = idx + 1;
    }
  }

  return results;
}

// ─── Plugin Profile Registry ─────────────────────────────────
// Most popular WordPress recipe plugins emit consistent CSS class structures
// for ingredient groups, instruction groups, and notes. JSON-LD covers the
// scalar fields (title, times, nutrition) but is structurally flat — no
// ingredient groups, no notes, no per-step images. This registry is the
// enrichment layer: detect which plugin a page uses, pull richer structure
// from its DOM. JSON-LD remains the detection gate (no Recipe → throw).

interface SectionProfile {
  containerClass: string;
  /** Dedicated group wrapper class (most plugins). */
  groupClass?: string;
  /** Class on the group's name element, if the plugin marks it. */
  groupNameClass?: string;
  /** Class on individual <li> wrappers; falls back to all <li> if absent. */
  itemClass?: string;
  /** Tasty Recipes uses bare <h3>/<h4> separators inside the section, no group class. */
  headingBasedGroups?: boolean;
}

interface PluginProfile {
  /** For logging only. */
  name: string;
  /** Detection: presence of this class in the HTML identifies this plugin. */
  containerClass: string;
  /** Notes section class, if the plugin has one. */
  notesClass?: string;
  ingredients: SectionProfile;
  instructions: SectionProfile;
}

const PLUGIN_PROFILES: PluginProfile[] = [
  {
    name: 'WPRM',
    containerClass: 'wprm-recipe-container',
    notesClass: 'wprm-recipe-notes-container',
    ingredients: {
      containerClass: 'wprm-recipe-ingredients-container',
      groupClass: 'wprm-recipe-ingredient-group',
      groupNameClass: 'wprm-recipe-ingredient-group-name',
      itemClass: 'wprm-recipe-ingredient',
    },
    instructions: {
      containerClass: 'wprm-recipe-instructions-container',
      groupClass: 'wprm-recipe-instruction-group',
      groupNameClass: 'wprm-recipe-instruction-group-name',
      itemClass: 'wprm-recipe-instruction',
    },
  },
  {
    name: 'Tasty Recipes',
    containerClass: 'tasty-recipes',
    notesClass: 'tasty-recipes-notes-body',
    ingredients: {
      containerClass: 'tasty-recipes-ingredients',
      headingBasedGroups: true,
    },
    instructions: {
      containerClass: 'tasty-recipes-instructions',
      headingBasedGroups: true,
    },
  },
  {
    name: 'Mediavine Create',
    containerClass: 'mv-create-card',
    notesClass: 'mv-create-notes',
    ingredients: {
      containerClass: 'mv-create-ingredients',
      groupClass: 'mv-create-ingredients-group',
      itemClass: 'mv-create-ingredient',
    },
    instructions: {
      containerClass: 'mv-create-instructions',
      groupClass: 'mv-create-instructions-group',
      itemClass: 'mv-create-instruction',
    },
  },
  {
    name: 'WP Delicious',
    containerClass: 'delicious-recipe',
    notesClass: 'delicious-recipe-notes',
    ingredients: {
      containerClass: 'delicious-recipe-ingredients',
      groupClass: 'dr-ingredient-group',
      itemClass: 'delicious-recipe-ingredient',
    },
    instructions: {
      containerClass: 'delicious-recipe-instructions',
      groupClass: 'dr-instruction-group',
      itemClass: 'delicious-recipe-instruction',
    },
  },
  {
    name: 'Cooked',
    containerClass: 'cooked-recipe-card',
    notesClass: 'cooked-recipe-notes',
    ingredients: {
      containerClass: 'cooked-ingredients',
      groupClass: 'cooked-ingredient-group',
      itemClass: 'cooked-ingredient',
    },
    instructions: {
      containerClass: 'cooked-directions',
      groupClass: 'cooked-direction-group',
      itemClass: 'cooked-direction',
    },
  },
  {
    name: 'WPZoom Recipe Card',
    containerClass: 'wpzoom-recipe-card',
    notesClass: 'wpzoom-recipe-card-notes',
    ingredients: {
      containerClass: 'wpzoom-recipe-card-ingredients',
      groupClass: 'wpzoom-recipe-card-ingredient-group',
      itemClass: 'wpzoom-recipe-card-ingredient',
    },
    instructions: {
      containerClass: 'wpzoom-recipe-card-directions',
      groupClass: 'wpzoom-recipe-card-direction-group',
      itemClass: 'wpzoom-recipe-card-direction',
    },
  },
  // Mantle (Dotdash Meredith CMS family — Serious Eats, Simply Recipes, Allrecipes).
  // UNVERIFIED selectors — Serious Eats is Cloudflare-blocked so the class names below
  // are best-effort guesses based on the BEM-style structure used elsewhere in the family.
  // Refine when a Mantle site is added to TRUSTED_SITES and a sample page is inspectable.
  {
    name: 'Mantle (UNVERIFIED)',
    containerClass: 'recipe-card',
    notesClass: 'recipe-card__notes',
    ingredients: {
      containerClass: 'recipe-card__ingredients',
      itemClass: 'recipe-card__ingredient',
      headingBasedGroups: true,
    },
    instructions: {
      containerClass: 'recipe-card__directions',
      itemClass: 'recipe-card__direction',
      headingBasedGroups: true,
    },
  },
];

/** Detect which recipe plugin a page uses. Returns the first matching profile. */
export function detectPlugin(rawHtml: string): PluginProfile | null {
  for (const p of PLUGIN_PROFILES) {
    if (extractByClass(rawHtml, p.containerClass)) return p;
  }
  return null;
}

// ─── WPRM Recipe Parsing ──────────────────────────────────────

/** Map WPRM free-text cuisine to our recognised tag set. */
function buildTagsFromRecipe(cuisine: string | undefined): string[] {
  const tags: string[] = [];

  // Cuisine — map WPRM free-text to our recognised set
  if (cuisine) {
    const cl = cuisine.toLowerCase();
    if (/\b(asian|chinese|japanese|thai|korean|vietnamese|indonesian|malaysian)\b/.test(cl))
      tags.push('Asian');
    if (/\bmexican\b/.test(cl)) tags.push('Mexican');
    if (/\b(mediterranean|greek|middle eastern|lebanese|turkish|moroccan)\b/.test(cl))
      tags.push('Mediterranean');
    if (/\bitalian\b/.test(cl)) tags.push('Italian');
    if (/\bindian\b/.test(cl)) tags.push('Indian');
  }

  return tags;
}

// Units that represent individual items rather than people served.
// When a recipe says "makes 24 cookies", we treat it as serving 4 people.
// "piece"/"pieces" excluded: too broadly matches savory portioning ("serves 4 pieces of chicken").
const ITEM_SERVINGS_UNITS = new Set([
  'cookie', 'cookies', 'skewer', 'skewers',
  'bar', 'bars', 'muffin', 'muffins', 'biscuit', 'biscuits',
  'ball', 'balls', 'bite', 'bites', 'pancake', 'pancakes',
  'waffle', 'waffles', 'cupcake', 'cupcakes', 'brownie', 'brownies',
  'scone', 'scones', 'truffle', 'truffles',
]);

/**
 * Convert raw WPRM servings count into a "people served" number for scaling.
 * Item-based units (e.g. "24 cookies") → default 4 people.
 * People-based units (e.g. "4 servings") → use the number directly.
 */
function resolveOriginalServings(rawCount: number, unit: string): number {
  if (ITEM_SERVINGS_UNITS.has(unit)) return 4;
  return rawCount || 4;
}

/**
 * Parse all WPRM ingredients.
 * Returns a flat list (for shopping list) and groups (for display).
 * When groups exist, the flat list is the concatenation of all group ingredients.
 */
function parseWprmIngredients(html: string): {
  ingredients: Ingredient[];
  ingredientGroups: IngredientGroup[];
} {
  const groupHtmls = extractAllByClass(html, 'wprm-recipe-ingredient-group');

  if (groupHtmls.length > 0) {
    const ingredientGroups: IngredientGroup[] = [];
    const allIngredients: Ingredient[] = [];

    for (const groupHtml of groupHtmls) {
      const groupName = htmlToText(
        extractByClass(groupHtml, 'wprm-recipe-ingredient-group-name') ?? ''
      );
      const liHtmls = extractAllByClass(groupHtml, 'wprm-recipe-ingredient');
      const groupIngredients = liHtmls
        .map(parseWprmIngredient)
        .filter((i) => i.name && i.name !== 'unknown');

      if (groupIngredients.length > 0) {
        ingredientGroups.push({ name: groupName, ingredients: groupIngredients });
        allIngredients.push(...groupIngredients);
      }
    }

    if (allIngredients.length > 0) {
      return { ingredients: allIngredients, ingredientGroups };
    }
  }

  // No groups — flat list
  const liHtmls = extractAllByClass(html, 'wprm-recipe-ingredient');
  const ingredients = liHtmls
    .map(parseWprmIngredient)
    .filter((i) => i.name && i.name !== 'unknown');
  return { ingredients, ingredientGroups: [] };
}

/** Parse a single WPRM ingredient <li> inner HTML into an Ingredient. */
function parseWprmIngredient(liHtml: string): Ingredient {
  const amountRaw = getFirstText(liHtml, 'wprm-recipe-ingredient-amount');
  const unitRaw = getFirstText(liHtml, 'wprm-recipe-ingredient-unit').trim();
  const nameText = getFirstText(liHtml, 'wprm-recipe-ingredient-name').trim();
  const notesRaw = getFirstText(liHtml, 'wprm-recipe-ingredient-notes').trim();

  // Some WPRM sites output dual imperial/metric measurements like "14 oz / 400 g"
  // or "14 oz (400 g)" inside the amount span. Prefer metric, fall back to raw.
  const { amount: amountText, unit: unitFromAmount } = splitDualMeasurement(amountRaw);

  let quantity = parseQuantityString(amountText);
  let unit = normalizeWprmUnit(unitFromAmount || unitRaw);

  // Convert oz/lb to metric
  const converted = convertIngredientWeight(quantity, unit);
  quantity = converted.quantity;
  unit = converted.unit;

  // Strip leading punctuation from notes (WPRM often includes ", minced")
  // Also strip Budget Bytes–style price annotations e.g. "$0.15"
  const notes = notesRaw
    .replace(/^[,;]\s*/, '')
    .replace(/\$[\d.]+\b/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return {
    name: nameText || 'unknown',
    quantity,
    unit,
    ...(notes ? { notes } : {}),
  };
}

/**
 * If the amount text carries a dual imperial/metric measurement
 * (e.g. "14 oz / 400 g", "14 oz (400 g)", "400 g / 14 oz"), return the metric
 * half plus its unit. Otherwise return the original amount with no unit override.
 * When both halves are metric or both imperial, prefer the first.
 */
function splitDualMeasurement(raw: string): { amount: string; unit: string } {
  const s = raw.trim();
  if (!s) return { amount: '', unit: '' };

  const metricRe = /(\d+(?:[.,]\d+)?)\s*(kg|g|ml|l|grams?|kilograms?|millilitres?|milliliters?|litres?|liters?)\b/i;
  const imperialRe = /(\d+(?:[.,]\d+)?)\s*(fl\s*oz|oz|lb|lbs|pounds?|ounces?)\b/i;

  const metric = s.match(metricRe);
  const imperial = s.match(imperialRe);

  if (metric && imperial) {
    return { amount: metric[1].replace(',', '.'), unit: metric[2].toLowerCase().replace(/\s+/g, ' ') };
  }
  return { amount: raw, unit: '' };
}

/** Parse a WPRM quantity string, handling fractions and unicode fraction chars. */
function parseQuantityString(s: string): number {
  if (!s.trim()) return 0;

  s = s
    .replace(/¼/g, '1/4').replace(/½/g, '1/2').replace(/¾/g, '3/4')
    .replace(/⅓/g, '1/3').replace(/⅔/g, '2/3')
    .replace(/⅛/g, '1/8').replace(/⅜/g, '3/8').replace(/⅝/g, '5/8').replace(/⅞/g, '7/8')
    .trim();

  // Mixed number: "1 1/2"
  const mixed = s.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (mixed) {
    return parseInt(mixed[1], 10) + parseInt(mixed[2], 10) / parseInt(mixed[3], 10);
  }

  // Fraction: "1/2"
  const frac = s.match(/^(\d+)\/(\d+)$/);
  if (frac) return parseInt(frac[1], 10) / parseInt(frac[2], 10);

  return parseFloat(s) || 0;
}

/** Normalise WPRM unit strings to canonical lowercase abbreviations. */
function normalizeWprmUnit(unit: string): string {
  const u = unit.toLowerCase().trim();
  const MAP: Record<string, string> = {
    tablespoon: 'tbsp', tablespoons: 'tbsp',
    teaspoon: 'tsp', teaspoons: 'tsp',
    cup: 'cup', cups: 'cup',
    gram: 'g', grams: 'g',
    kilogram: 'kg', kilograms: 'kg',
    milliliter: 'ml', milliliters: 'ml', millilitre: 'ml', millilitres: 'ml',
    liter: 'l', liters: 'l', litre: 'l', litres: 'l',
    ounce: 'oz', ounces: 'oz',
    pound: 'lb', pounds: 'lb',
    'fluid ounce': 'fl oz', 'fluid ounces': 'fl oz',
    clove: 'clove', cloves: 'clove',
    slice: 'slice', slices: 'slice',
    piece: 'piece', pieces: 'piece',
    can: 'can', cans: 'can',
    jar: 'jar', jars: 'jar',
    bag: 'bag', bags: 'bag',
    bunch: 'bunch', bunches: 'bunch',
    stalk: 'stalk', stalks: 'stalk',
    sprig: 'sprig', sprigs: 'sprig',
    pinch: 'pinch', pinches: 'pinch',
    dash: 'dash', dashes: 'dash',
    handful: 'handful', handfuls: 'handful',
    pint: 'pint', pints: 'pint',
    quart: 'quart', quarts: 'quart',
  };
  return MAP[u] ?? u;
}

/** Convert oz → g and lb → g/kg. */
function convertIngredientWeight(quantity: number, unit: string): { quantity: number; unit: string } {
  if (unit === 'oz') {
    return { quantity: Math.round(quantity * 28.35), unit: 'g' };
  }
  if (unit === 'lb') {
    const grams = quantity * 453.6;
    if (grams >= 500) return { quantity: Math.round(grams / 100) / 10, unit: 'kg' };
    return { quantity: Math.round(grams), unit: 'g' };
  }
  return { quantity, unit };
}

// ─── Nutrition Parsing ───────────────────────────────────────

/**
 * Extract a number from a Schema.org nutrition field value.
 * Handles strings like "320 calories", "25 g", "12", etc.
 */
function extractNutritionNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const m = String(value).match(/[\d.]+/);
  return m ? Math.round(parseFloat(m[0])) : 0;
}

/**
 * Extract the hero image URL from a recipe page.
 * Priority: JSON-LD "image" field → og:image meta → twitter:image meta.
 */
function parseRecipeImage(html: string): string | null {
  const scriptRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptRe.exec(html)) !== null) {
    let parsed: unknown;
    try { parsed = JSON.parse(match[1]); } catch { continue; }

    const candidates: unknown[] = [];
    if (Array.isArray(parsed)) {
      candidates.push(...parsed);
    } else if (parsed && typeof parsed === 'object') {
      const graph = (parsed as Record<string, unknown>)['@graph'];
      if (Array.isArray(graph)) candidates.push(...graph);
      else candidates.push(parsed);
    }

    for (const obj of candidates) {
      if (!obj || typeof obj !== 'object') continue;
      const o = obj as Record<string, unknown>;
      const types = Array.isArray(o['@type']) ? o['@type'] : [o['@type']];
      if (!types.includes('Recipe')) continue;
      const img = o['image'];
      if (!img) continue;
      if (typeof img === 'string') return img;
      if (Array.isArray(img)) {
        const first = img[0];
        if (typeof first === 'string') return first;
        if (first && typeof first === 'object') {
          const url = (first as Record<string, unknown>)['url'];
          if (typeof url === 'string') return url;
        }
      }
      if (typeof img === 'object') {
        const url = (img as Record<string, unknown>)['url'];
        if (typeof url === 'string') return url;
      }
    }
  }

  // og:image meta tag (both attribute orderings)
  const ogMatch =
    html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ??
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  if (ogMatch?.[1]) return ogMatch[1];

  // twitter:image meta tag
  const twMatch = html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i);
  if (twMatch?.[1]) return twMatch[1];

  return null;
}

/**
 * Parse nutrition from JSON-LD Schema.org structured data.
 *
 * Every WPRM site automatically emits a <script type="application/ld+json">
 * Recipe block for Google rich snippets — this is far more reliable than
 * scraping CSS classes because it's standardised and version-independent.
 *
 * Handles three JSON-LD shapes:
 *   - Root object:   { "@type": "Recipe", "nutrition": {...} }
 *   - Root array:    [{ "@type": "Recipe", ... }]
 *   - @graph wrap:   { "@graph": [{ "@type": "Recipe", ... }] }
 */
function parseJsonLdNutrition(html: string): Recipe['nutrition'] | null {
  const scriptRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;

  while ((match = scriptRe.exec(html)) !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[1]);
    } catch {
      continue; // malformed JSON — skip
    }

    const candidates: unknown[] = [];
    if (Array.isArray(parsed)) {
      candidates.push(...parsed);
    } else if (parsed && typeof parsed === 'object') {
      const graph = (parsed as Record<string, unknown>)['@graph'];
      if (Array.isArray(graph)) candidates.push(...graph);
      else candidates.push(parsed);
    }

    for (const obj of candidates) {
      if (!obj || typeof obj !== 'object') continue;
      const o = obj as Record<string, unknown>;

      // @type can be a string or an array (e.g. ["Recipe", "WebPage"])
      const types = Array.isArray(o['@type']) ? o['@type'] : [o['@type']];
      if (!types.includes('Recipe')) continue;

      const n = o['nutrition'];
      if (!n || typeof n !== 'object') continue;
      const nutrition = n as Record<string, unknown>;

      const calories = extractNutritionNumber(nutrition['calories']);
      const protein = extractNutritionNumber(nutrition['proteinContent']);
      const carbs = extractNutritionNumber(nutrition['carbohydrateContent']);
      const fat = extractNutritionNumber(nutrition['fatContent']);

      if (calories > 0 || protein > 0 || carbs > 0 || fat > 0) {
        console.log(`[RecipeScraper] Nutrition from JSON-LD: ${calories} kcal, P${protein}g, C${carbs}g, F${fat}g`);
        return { calories, protein, carbs, fat };
      }
    }
  }

  return null;
}

// ─── JSON-LD Recipe Parsing (Schema.org) ────────────────────
// JSON-LD-first parsing widens scraper coverage from "WPRM-only" to anything
// that ships Schema.org Recipe data — Tasty Recipes, Mediavine Create, custom
// CMSes, etc. Helpers below convert raw JSON-LD shapes to our typed model.

/**
 * Convert ISO 8601 duration ("PT1H30M", "PT45M", "PT2H") to total minutes.
 * Returns null if the string isn't parseable.
 */
export function parseIso8601Duration(iso: unknown): number | null {
  if (typeof iso !== 'string' || !iso) return null;
  // P[nD]T[nH][nM][nS] — recipes rarely use the full form, but cover it.
  const m = iso.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return null;
  const days = parseInt(m[1] || '0', 10);
  const hours = parseInt(m[2] || '0', 10);
  const minutes = parseInt(m[3] || '0', 10);
  const seconds = parseInt(m[4] || '0', 10);
  const total = days * 1440 + hours * 60 + minutes + Math.round(seconds / 60);
  return total > 0 ? total : null;
}

/**
 * Walk every <script type="application/ld+json"> block on the page and return
 * the first object whose @type is (or includes) "Recipe". Handles three
 * wrapper shapes: root object, root array, and { "@graph": [...] }.
 *
 * Some publishers ship HTML-entity-escaped JSON inside the script body
 * (&quot; instead of "), which JSON.parse rejects. Falls back to a
 * once-decoded retry before giving up.
 */
export function findJsonLdRecipe(html: string): Record<string, unknown> | null {
  const scriptRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;

  while ((match = scriptRe.exec(html)) !== null) {
    const body = match[1];
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      try {
        parsed = JSON.parse(
          body
            .replace(/&quot;/g, '"')
            .replace(/&#34;/g, '"')
            .replace(/&apos;/g, "'")
            .replace(/&#39;/g, "'")
            .replace(/&amp;/g, '&')
        );
      } catch {
        continue;
      }
    }

    const candidates: unknown[] = [];
    if (Array.isArray(parsed)) {
      candidates.push(...parsed);
    } else if (parsed && typeof parsed === 'object') {
      const graph = (parsed as Record<string, unknown>)['@graph'];
      if (Array.isArray(graph)) candidates.push(...graph);
      else candidates.push(parsed);
    }

    for (const obj of candidates) {
      if (!obj || typeof obj !== 'object') continue;
      const o = obj as Record<string, unknown>;
      const types = Array.isArray(o['@type']) ? o['@type'] : [o['@type']];
      if (types.includes('Recipe')) return o;
    }
  }

  return null;
}

/** Pull a step image URL from a HowToStep.image field. Handles string,
 *  array of strings, ImageObject {url|contentUrl}, or array thereof. */
function extractStepImageUrl(img: unknown): string | undefined {
  if (typeof img === 'string') return img;
  if (Array.isArray(img)) {
    for (const i of img) {
      const u = extractStepImageUrl(i);
      if (u) return u;
    }
    return undefined;
  }
  if (img && typeof img === 'object') {
    const o = img as Record<string, unknown>;
    const url = o['url'] ?? o['contentUrl'];
    if (typeof url === 'string') return url;
  }
  return undefined;
}

/**
 * Convert a Schema.org recipeInstructions value to InstructionStep[].
 *
 * Three accepted shapes (recursively):
 *   - string                              → split on newlines
 *   - HowToStep[]                         → { text, imageUrl? }
 *   - HowToSection[] (with itemListElement) → flatten with isHeader rows
 *   - Mixed array of strings + HowToStep  → coerce each element
 */
export function parseJsonLdInstructions(value: unknown): InstructionStep[] {
  if (typeof value === 'string') {
    return value
      .split(/\r?\n+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((text) => ({ text }));
  }

  if (!Array.isArray(value)) return [];

  const steps: InstructionStep[] = [];
  for (const item of value) {
    if (typeof item === 'string') {
      const t = item.trim();
      if (t) steps.push({ text: t });
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const type = obj['@type'];
    const isSection =
      type === 'HowToSection' || (Array.isArray(type) && type.includes('HowToSection'));

    if (isSection) {
      const name = typeof obj['name'] === 'string' ? htmlToText(obj['name']).trim() : '';
      if (name) steps.push({ text: name, isHeader: true });
      const sub = obj['itemListElement'];
      if (Array.isArray(sub)) steps.push(...parseJsonLdInstructions(sub));
      continue;
    }

    // Default: HowToStep (also catches plain objects with a text field)
    const rawText = typeof obj['text'] === 'string' ? obj['text'] : '';
    const text = htmlToText(rawText).trim();
    if (!text) continue;
    const imageUrl = extractStepImageUrl(obj['image']);
    steps.push(imageUrl ? { text, imageUrl } : { text });
  }
  return steps;
}

/** Replace unicode vulgar fraction characters with their ASCII form. */
function normalizeUnicodeFractions(s: string): string {
  return s
    .replace(/¼/g, '1/4').replace(/½/g, '1/2').replace(/¾/g, '3/4')
    .replace(/⅓/g, '1/3').replace(/⅔/g, '2/3')
    .replace(/⅛/g, '1/8').replace(/⅜/g, '3/8').replace(/⅝/g, '5/8').replace(/⅞/g, '7/8')
    .replace(/⅕/g, '1/5').replace(/⅖/g, '2/5').replace(/⅗/g, '3/5').replace(/⅘/g, '4/5')
    .replace(/⅙/g, '1/6').replace(/⅚/g, '5/6');
}

const KNOWN_UNITS_TWO_WORD = new Set([
  'fl oz', 'fluid ounce', 'fluid ounces',
]);
const KNOWN_UNITS_ONE_WORD = new Set([
  'tbsp', 'tbsps', 'tablespoon', 'tablespoons',
  'tsp', 'tsps', 'teaspoon', 'teaspoons',
  'cup', 'cups',
  'g', 'gram', 'grams', 'kg', 'kilogram', 'kilograms',
  'ml', 'milliliter', 'milliliters', 'millilitre', 'millilitres',
  'l', 'liter', 'liters', 'litre', 'litres',
  'oz', 'ounce', 'ounces', 'lb', 'lbs', 'pound', 'pounds',
  'clove', 'cloves', 'slice', 'slices', 'piece', 'pieces',
  'can', 'cans', 'jar', 'jars', 'bag', 'bags', 'bunch', 'bunches',
  'stalk', 'stalks', 'sprig', 'sprigs', 'pinch', 'pinches', 'dash', 'dashes',
  'handful', 'handfuls', 'pint', 'pints', 'quart', 'quarts',
  'stick', 'sticks', 'head', 'heads',
]);

/**
 * Strip the first balanced parenthetical group from a string (handles nesting:
 * "(finely chopped (about 1 cup))" comes out as one note, not two).
 * Returns the parenthetical content (without the surrounding parens) and the
 * remaining string with the group excised.
 */
function stripBalancedParens(s: string): { paren: string; rest: string } {
  const start = s.indexOf('(');
  if (start < 0) return { paren: '', rest: s };
  let depth = 1;
  let end = start + 1;
  while (end < s.length && depth > 0) {
    if (s[end] === '(') depth++;
    else if (s[end] === ')') depth--;
    end++;
  }
  if (depth !== 0) return { paren: '', rest: s };
  return {
    paren: s.slice(start + 1, end - 1).trim(),
    rest: (s.slice(0, start) + s.slice(end)).replace(/\s+/g, ' ').trim(),
  };
}

/**
 * Parse a Schema.org recipeIngredient string into our Ingredient type.
 *
 *   "2 cups butternut squash (peeled and cubed)"
 *     → { quantity: 2, unit: 'cup', name: 'butternut squash', notes: 'peeled and cubed' }
 *   "1/2 cup olive oil – rosemary olive oil or other herb infused oil is delicious"
 *     → { quantity: 0.5, unit: 'cup', name: 'olive oil', notes: 'rosemary olive oil ...' }
 *   "a swish of sherry"
 *     → { quantity: 0, unit: '', name: 'a swish of sherry' }
 *
 * Strategy: extract balanced parenthetical (notes), pull leading quantity
 * (handles fractions, mixed numbers, ranges — uses lower bound of ranges
 * matching parseQuantityString semantics), match next token(s) against the
 * units vocabulary, treat the remainder as the name. Trailing comma-suffixed
 * text becomes additional notes.
 */
export function parseIngredientString(raw: string): Ingredient {
  let s = normalizeUnicodeFractions(htmlToText(raw)).trim();

  // 1. Pull out balanced parenthetical as primary notes
  let notes = '';
  const paren = stripBalancedParens(s);
  if (paren.paren) {
    notes = paren.paren;
    s = paren.rest;
  }

  // 2. Quantity (mixed "1 1/2", fraction "1/2", decimal "0.5", range "2-3"/"2 to 3")
  let quantity = 0;
  const qtyRe = /^(\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:\.\d+)?)(?:\s*(?:[-–—]|to)\s*(?:\d+(?:\.\d+)?|\d+\/\d+))?\s*/;
  const qtyMatch = s.match(qtyRe);
  if (qtyMatch) {
    quantity = parseQuantityString(qtyMatch[1]); // lower bound of any range
    s = s.slice(qtyMatch[0].length).trim();
  }

  // 3. Unit (try two-word first to catch "fluid ounces")
  let unit = '';
  const tokens = s.split(/\s+/);
  if (tokens.length >= 2) {
    const twoWord = `${tokens[0]} ${tokens[1]}`.toLowerCase();
    if (KNOWN_UNITS_TWO_WORD.has(twoWord)) {
      unit = normalizeWprmUnit(twoWord);
      s = tokens.slice(2).join(' ');
    }
  }
  if (!unit && tokens.length >= 1) {
    const oneWord = tokens[0].toLowerCase().replace(/\.$/, ''); // drop "tsp."/"lb."/etc
    if (KNOWN_UNITS_ONE_WORD.has(oneWord)) {
      unit = normalizeWprmUnit(oneWord);
      s = tokens.slice(1).join(' ');
    }
  }

  // 4. Trailing comma-prefixed text → additional notes ("butter, melted")
  // Skip if the comma is inside something that looks like a number ("1,000").
  const commaIdx = s.search(/,(?!\d)/);
  if (commaIdx >= 0) {
    const trailing = s.slice(commaIdx + 1).trim();
    if (trailing) notes = notes ? `${notes}; ${trailing}` : trailing;
    s = s.slice(0, commaIdx).trim();
  }

  // 5. Trailing en/em-dash clause → notes ("olive oil – rosemary infused")
  const dashIdx = s.search(/\s[–—]\s/);
  if (dashIdx >= 0) {
    const trailing = s.slice(dashIdx + 2).trim();
    if (trailing) notes = notes ? `${notes}; ${trailing}` : trailing;
    s = s.slice(0, dashIdx).trim();
  }

  let name = s.trim() || 'unknown';

  // 6. Apply oz/lb → metric conversion (matches existing WPRM behaviour)
  if (unit === 'oz' || unit === 'lb') {
    const converted = convertIngredientWeight(quantity, unit);
    quantity = converted.quantity;
    unit = converted.unit;
  }

  return {
    name,
    quantity,
    unit,
    ...(notes ? { notes } : {}),
  };
}

/**
 * Parse Schema.org recipeYield into a numeric serving count.
 * Accepts: "8" | "8 servings" | 8 | ["8", "8 servings"] | "Serves 4-6"
 * Returns the lower bound for ranges, defaults to 4 if unparseable.
 */
function parseRecipeYield(value: unknown): { servings: number; unitText: string } {
  const candidates: string[] = [];
  if (typeof value === 'number') return { servings: value, unitText: '' };
  if (typeof value === 'string') candidates.push(value);
  if (Array.isArray(value)) {
    for (const v of value) {
      if (typeof v === 'string') candidates.push(v);
      else if (typeof v === 'number') return { servings: v, unitText: '' };
    }
  }
  // Prefer the longer string for unit detection.
  candidates.sort((a, b) => b.length - a.length);
  for (const c of candidates) {
    const m = c.match(/(\d+)/);
    if (m) {
      const unitText = c.replace(/\d+\s*(?:[-–]\s*\d+)?/, '').trim().toLowerCase();
      return { servings: parseInt(m[1], 10), unitText };
    }
  }
  return { servings: 4, unitText: '' };
}

/**
 * Per-step images aren't always in JSON-LD HowToStep.image — many sites only
 * render them inline in the recipe card HTML. This pulls them out positionally:
 * find the recipe-card instruction list (Tasty Recipes' .tasty-recipes-instructions
 * or WPRM's .wprm-recipe-instructions-container), walk its <li> items in order,
 * and grab the first <img src> inside each. Returned as a parallel array indexed
 * by non-header step position.
 */
function extractStepImagesFromHtml(rawHtml: string): string[] {
  const container =
    extractByClass(rawHtml, 'tasty-recipes-instructions') ??
    extractByClass(rawHtml, 'wprm-recipe-instructions-container') ??
    null;
  if (!container) return [];

  return extractAllByTag(container, 'li').map((li) => {
    const m = li.match(/<img[^>]+src=["']([^"']+)["']/i);
    return m ? m[1] : '';
  });
}

/**
 * Mutates `instructions` in-place: for every non-header step that lacks an
 * imageUrl, fill it from `htmlImages[i]` where i is the step's position
 * among non-header steps. No-op when htmlImages is empty.
 */
function overlayStepImages(instructions: InstructionStep[], htmlImages: string[]): void {
  if (htmlImages.length === 0) return;
  let stepIdx = 0;
  for (let i = 0; i < instructions.length; i++) {
    const step = instructions[i];
    if (step.isHeader) continue;
    if (!step.imageUrl && htmlImages[stepIdx]) {
      instructions[i] = { ...step, imageUrl: htmlImages[stepIdx] };
    }
    stepIdx++;
  }
}

/** Format a minute count back to a human-readable "X min" / "X hr Y min" string. */
function formatMinutes(min: number): string {
  if (!min) return 'N/A';
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h && m) return `${h} hr ${m} min`;
  return h ? `${h} hr` : `${m} min`;
}

/**
 * Recipe notes fall back across plugin-specific HTML selectors since JSON-LD
 * has no notes property. Tries WPRM (wprm-recipe-notes-container), then Tasty
 * Recipes (tasty-recipes-notes-body). Returns "" if neither matches.
 *
 * Numbering behaviour mirrors the legacy WPRM parser: <li> items get numbered
 * "1. ... 2. ...", multi-paragraph text gets numbered, single-paragraph text
 * is returned as-is.
 */
function extractNotesFromHtml(rawHtml: string): string {
  // WPRM notes
  const wprm = extractByClass(rawHtml, 'wprm-recipe-notes-container');
  if (wprm) return formatNotesContainer(wprm);

  // Tasty Recipes notes (Pinch of Yum, etc.)
  const tasty = extractByClass(rawHtml, 'tasty-recipes-notes-body');
  if (tasty) return formatNotesContainer(tasty);

  return '';
}

/** Convert a notes-container's inner HTML to a numbered string. */
function formatNotesContainer(inner: string): string {
  // Numbered list items take precedence
  const liItems = extractAllByTag(inner, 'li')
    .map((li) => htmlToText(li).trim())
    .filter((t) => t.length > 0);
  if (liItems.length > 0) {
    return liItems.map((item, i) => `${i + 1}. ${item}`).join('\n');
  }
  // Otherwise preserve paragraph breaks via a sentinel through htmlToText
  const marked = inner
    .replace(/<br\s*\/?>/gi, '\x00')
    .replace(/<\/p>/gi, '\x00');
  const plain = htmlToText(marked)
    .replace(/\x00/g, '\n')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const lines = plain.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length > 1) return lines.map((line, i) => `${i + 1}. ${line}`).join('\n');
  return plain;
}

/**
 * Map a Schema.org Recipe JSON-LD node to our Recipe type.
 * Pulls structured fields from JSON-LD; falls back to HTML scraping for
 * fields JSON-LD doesn't carry (notes) or where the page has richer
 * structure (WPRM ingredient groups).
 */
function extractRecipeFromJsonLd(
  node: Record<string, unknown>,
  rawHtml: string,
  sourceUrl: string,
): Recipe {
  // ── Title (required) ───────────────────────────────────────
  const title = (typeof node['name'] === 'string' ? htmlToText(node['name']).trim() : '');
  if (!title) throw new Error('JSON-LD Recipe missing name');

  // ── Description / image ────────────────────────────────────
  const description = (typeof node['description'] === 'string'
    ? htmlToText(node['description']).trim()
    : '') || undefined;
  const imageUrl = parseRecipeImage(rawHtml) ?? undefined;

  // ── Times (ISO 8601 → "X min" / "X hr Y min") ─────────────
  const prepMin = parseIso8601Duration(node['prepTime']);
  const cookMin = parseIso8601Duration(node['cookTime']);
  const totalMinIso = parseIso8601Duration(node['totalTime']);
  const totalMin = totalMinIso ?? (prepMin || cookMin ? (prepMin ?? 0) + (cookMin ?? 0) : null);
  const prepTime = prepMin !== null ? formatMinutes(prepMin) : 'N/A';
  const cookTime = cookMin !== null ? formatMinutes(cookMin) : 'N/A';
  const totalTime = totalMin !== null ? formatMinutes(totalMin) : undefined;

  // ── Servings ──────────────────────────────────────────────
  const yieldParsed = parseRecipeYield(node['recipeYield']);
  const originalServings = resolveOriginalServings(yieldParsed.servings, yieldParsed.unitText);

  // ── Course / cuisine ──────────────────────────────────────
  const courseRaw = node['recipeCategory'];
  let course: string[] | undefined;
  if (typeof courseRaw === 'string') {
    course = courseRaw.split(',').map((s) => s.trim()).filter(Boolean);
  } else if (Array.isArray(courseRaw)) {
    course = courseRaw.filter((c): c is string => typeof c === 'string').map((s) => s.trim()).filter(Boolean);
  }
  if (course && course.length === 0) course = undefined;

  const cuisine = (typeof node['recipeCuisine'] === 'string'
    ? node['recipeCuisine'].trim()
    : Array.isArray(node['recipeCuisine']) && typeof node['recipeCuisine'][0] === 'string'
      ? (node['recipeCuisine'][0] as string).trim()
      : '') || undefined;

  // ── Ingredients: prefer WPRM groups when the page exposes them ────────
  // JSON-LD recipeIngredient is flat (no group structure). For sites running
  // WP Recipe Maker we still get the richer grouped structure by parsing the
  // WPRM container directly. Other sites use the JSON-LD flat list.
  let ingredients: Ingredient[] = [];
  let ingredientGroups: IngredientGroup[] = [];

  const wprmContainer = extractByClass(rawHtml, 'wprm-recipe-container');
  if (wprmContainer) {
    const wprm = parseWprmIngredients(wprmContainer);
    if (wprm.ingredients.length > 0) {
      ingredients = wprm.ingredients;
      ingredientGroups = wprm.ingredientGroups;
    }
  }
  if (ingredients.length === 0 && Array.isArray(node['recipeIngredient'])) {
    ingredients = (node['recipeIngredient'] as unknown[])
      .filter((s): s is string => typeof s === 'string')
      .map(parseIngredientString)
      .filter((i) => i.name && i.name !== 'unknown');
  }
  if (ingredients.length === 0) throw new Error('JSON-LD Recipe has no ingredients');

  // ── Instructions ──────────────────────────────────────────
  const instructions = parseJsonLdInstructions(node['recipeInstructions'])
    .map((step) => step.isHeader ? step : { ...step, text: convertInstructionUnits(step.text) });
  if (instructions.length === 0) throw new Error('JSON-LD Recipe has no instructions');

  // Many sites (Pinch of Yum / Tasty Recipes, some WPRM recipes) only embed
  // step photos inline in the recipe card HTML, not in JSON-LD HowToStep.image.
  // Overlay them positionally onto any step that doesn't already have one.
  overlayStepImages(instructions, extractStepImagesFromHtml(rawHtml));

  // ── Notes / nutrition ─────────────────────────────────────
  const notes = extractNotesFromHtml(rawHtml);
  const nutrition = parseJsonLdNutrition(rawHtml) ?? { calories: 0, protein: 0, carbs: 0, fat: 0 };

  console.log(
    `[RecipeScraper] Parsed JSON-LD "${title}" — ${ingredients.length} ingredient(s), ${instructions.length} step(s)${imageUrl ? ' [img]' : ''}${ingredientGroups.length ? ` [${ingredientGroups.length} group(s)]` : ''}`
  );

  return {
    title,
    sourceUrl,
    ...(imageUrl ? { imageUrl } : {}),
    prepTime,
    cookTime,
    ...(totalTime ? { totalTime } : {}),
    originalServings,
    ...(course ? { course } : {}),
    ...(description ? { description } : {}),
    ...(cuisine ? { cuisine } : {}),
    ingredients,
    ...(ingredientGroups.length > 0 ? { ingredientGroups } : {}),
    instructions,
    notes,
    nutrition,
    tags: buildTagsFromRecipe(cuisine),
    scrapedAt: new Date(),
  };
}

/**
 * New scraper entry point. Detects a Schema.org Recipe via JSON-LD; if absent
 * (e.g. a category/collection page) throws, which the caller treats as "skip,
 * try the next candidate URL". This replaces the WPRM-container check that
 * was used previously.
 */
export function parseRecipe(rawHtml: string, sourceUrl: string): Recipe {
  const node = findJsonLdRecipe(rawHtml);
  if (!node) throw new Error('No JSON-LD Recipe found on page');
  return extractRecipeFromJsonLd(node, rawHtml, sourceUrl);
}

// ─── Instruction Unit Conversion ──────────────────────────────

/**
 * Programmatically convert imperial measurements in instruction text.
 *   °F / degrees F / degrees Fahrenheit → °C  (rounded integer)
 *   X inch / X inches                   → Xcm (× 2.54, 1 decimal)
 */
function convertInstructionUnits(text: string): string {
  text = text.replace(
    /(\d+(?:\.\d+)?)\s*(?:°\s*F|degrees?\s+(?:Fahrenheit|F))\b/gi,
    (_, f) => `${Math.round((parseFloat(f) - 32) * 5 / 9)}°C`
  );
  text = text.replace(
    /(\d+(?:\.\d+)?)\s*inches?\b/gi,
    (_, i) => `${Math.round(parseFloat(i) * 2.54 * 10) / 10}cm`
  );
  return text;
}

// ─── Serving Scale + Time Parse (shared helpers) ─────────────

export function applyServingScale(recipe: Recipe, requiredServings: number): Recipe {
  const factor = requiredServings / recipe.originalServings;
  const scaleIng = (ing: Ingredient): Ingredient => ({
    ...ing,
    quantity: Math.round(ing.quantity * factor * 100) / 100,
  });

  return {
    ...recipe,
    ingredients: recipe.ingredients.map(scaleIng),
    ingredientGroups: recipe.ingredientGroups?.map((group) => ({
      ...group,
      ingredients: group.ingredients.map(scaleIng),
    })),
  };
}

export function parseMinutes(timeStr: string): number | null {
  if (!timeStr || timeStr === 'N/A' || !timeStr.trim()) return null;
  let total = 0;
  let found = false;
  const hrMatch = timeStr.match(/(\d+(?:\.\d+)?)\s*(?:hr|hour|h)\b/i);
  const minMatch = timeStr.match(/(\d+(?:\.\d+)?)\s*(?:min|minute|m)\b/i);
  if (hrMatch) { total += parseFloat(hrMatch[1]) * 60; found = true; }
  if (minMatch) { total += parseFloat(minMatch[1]); found = true; }
  return found ? Math.round(total) : null;
}
