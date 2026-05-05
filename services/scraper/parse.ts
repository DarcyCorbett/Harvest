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

/**
 * Parse a full Recipe from WP Recipe Maker HTML.
 * Throws if the page has no WPRM markup or required fields are absent.
 */
export function parseRecipeFromWprm(rawHtml: string, sourceUrl: string): Recipe {
  const recipeHtml = extractByClass(rawHtml, 'wprm-recipe-container');
  if (!recipeHtml) {
    throw new Error('No WPRM recipe container found on page');
  }

  const title = getFirstText(recipeHtml, 'wprm-recipe-name').trim();
  if (!title) throw new Error('Could not extract recipe title from WPRM');

  const prepTime = buildTimeString(recipeHtml, 'prep_time');
  const cookTime = buildTimeString(recipeHtml, 'cook_time');

  const servingsText = getFirstText(recipeHtml, 'wprm-recipe-servings');
  const servingsUnit = getFirstText(recipeHtml, 'wprm-recipe-servings-unit').trim().toLowerCase();
  const originalServings = resolveOriginalServings(parseInt(servingsText, 10) || 4, servingsUnit);

  // WPRM sites vary: some put all courses comma-separated in one span,
  // others use a separate span per course. Handle both by collecting all
  // matching spans then splitting each on commas.
  const courseItems = extractAllByClass(recipeHtml, 'wprm-recipe-course')
    .flatMap((inner) => htmlToText(inner).split(','))
    .map((s) => s.trim())
    .filter(Boolean);
  const course = courseItems.length > 0 ? courseItems : undefined;

  const wprmTotal = buildTimeString(recipeHtml, 'total_time');
  const totalTime = wprmTotal !== 'N/A' ? wprmTotal : combineTimes(prepTime, cookTime);
  const description = getFirstText(recipeHtml, 'wprm-recipe-summary').trim() || undefined;
  const cuisine = getFirstText(recipeHtml, 'wprm-recipe-cuisine').trim() || undefined;
  const difficulty = getFirstText(recipeHtml, 'wprm-recipe-difficulty').trim() || undefined;

  const { ingredients, ingredientGroups } = parseWprmIngredients(recipeHtml);
  if (ingredients.length === 0) throw new Error('No ingredients found in WPRM recipe');

  const instructions = parseWprmInstructions(recipeHtml);
  if (instructions.length === 0) throw new Error('No instructions found in WPRM recipe');

  const notes = parseWprmNotes(recipeHtml);
  const nutrition = parseWprmNutrition(rawHtml, recipeHtml);
  const imageUrl = parseRecipeImage(rawHtml) ?? undefined;

  console.log(
    `[RecipeScraper] Parsed WPRM "${title}" — ${ingredients.length} ingredient(s), ${instructions.length} step(s)${imageUrl ? ' [img]' : ''}`
  );

  return {
    title,
    sourceUrl,
    ...(imageUrl ? { imageUrl } : {}),
    prepTime,
    cookTime,
    ...(totalTime !== 'N/A' ? { totalTime } : {}),
    originalServings,
    ...(course ? { course } : {}),
    ...(description ? { description } : {}),
    ...(cuisine ? { cuisine } : {}),
    ...(difficulty ? { difficulty } : {}),
    ingredients,
    ingredientGroups: ingredientGroups.length > 0 ? ingredientGroups : undefined,
    instructions: instructions.map(convertInstructionUnits).map((text): InstructionStep => ({ text })),
    notes,
    nutrition,
    tags: buildTagsFromRecipe(cuisine || undefined),
    scrapedAt: new Date(),
  };
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
 * Add two time strings (e.g. "20 min" + "30 min" → "50 min").
 * Returns 'N/A' if neither time is parseable.
 */
function combineTimes(t1: string, t2: string): string {
  const m1 = parseMinutes(t1) ?? 0;
  const m2 = parseMinutes(t2) ?? 0;
  const total = m1 + m2;
  if (!total) return 'N/A';
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h && m) return `${h} hr ${m} min`;
  return h ? `${h} hr` : `${m} min`;
}

/** Build a human-readable time string from WPRM hour/minute spans. */
function buildTimeString(html: string, timeType: string): string {
  const hoursText = getFirstText(html, `wprm-recipe-${timeType}-hours`);
  const minsText = getFirstText(html, `wprm-recipe-${timeType}-minutes`);
  const hours = parseInt(hoursText, 10) || 0;
  const mins = parseInt(minsText, 10) || 0;
  if (!hours && !mins) return 'N/A';
  if (hours && mins) return `${hours} hr ${mins} min`;
  return hours ? `${hours} hr` : `${mins} min`;
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

/** Parse all WPRM instruction steps into plain text strings. */
function parseWprmInstructions(html: string): string[] {
  return extractAllByClass(html, 'wprm-recipe-instruction-text')
    .map(htmlToText)
    .filter((t) => t.length > 0);
}

/** Parse the WPRM notes container, numbering list items where present. */
function parseWprmNotes(html: string): string {
  const inner = extractByClass(html, 'wprm-recipe-notes-container');
  if (!inner) return '';

  // If the notes contain <li> items, extract and number them (1. 2. 3.)
  const liItems = extractAllByTag(inner, 'li')
    .map((li) => htmlToText(li).trim())
    .filter((t) => t.length > 0);

  if (liItems.length > 0) {
    return liItems.map((item, i) => `${i + 1}. ${item}`).join('\n');
  }

  // Fallback: convert to plain text, split by paragraph/line, number if multiple.
  // Use a sentinel (\x00) to preserve intended newlines through htmlToText's whitespace collapse.
  const marked = inner
    .replace(/<br\s*\/?>/gi, '\x00')
    .replace(/<\/p>/gi, '\x00');
  const plain = htmlToText(marked)   // strips tags + decodes ALL entities
    .replace(/\x00/g, '\n')          // restore newline sentinels
    .replace(/ *\n */g, '\n')        // trim spaces around newlines
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const lines = plain.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length > 1) {
    return lines.map((line, i) => `${i + 1}. ${line}`).join('\n');
  }

  return plain;
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

/**
 * Parse WPRM nutrition via CSS classes.
 *
 * Three patterns observed in real WPRM HTML:
 *
 * Pattern A — container has nutrient suffix, value span is generic (RecipeTin Eats style):
 *   <span class="wprm-nutrition-label-text-nutrition-container-calories">
 *     <span class="wprm-nutrition-label-text-nutrition-value">362</span>
 *   </span>
 *
 * Pattern B — value span has nutrient suffix (WPRM Nutrition Label block):
 *   <span class="wprm-nutrition-label-text-nutrition-value-calories">320</span>
 *
 * Pattern C — legacy simple-text mode:
 *   <span class="wprm-nutrition-label-text-for-calories">320</span>
 *
 * Pattern D — compact per-serving strip:
 *   <span class="wprm-recipe-calories">320</span>
 */
function parseWprmNutritionByClass(html: string): Recipe['nutrition'] {
  // Pattern A: extract the per-nutrient container, then find the generic value span inside it.
  const fromContainer = (nutrient: string): number => {
    const container = extractByClass(html, `wprm-nutrition-label-text-nutrition-container-${nutrient}`);
    if (!container) return 0;
    const text = getFirstText(container, 'wprm-nutrition-label-text-nutrition-value');
    const m = text.match(/[\d.]+/);
    return m ? Math.round(parseFloat(m[0])) : 0;
  };

  // Patterns B / C / D: direct class on the value element.
  const fromClass = (...classes: string[]): number => {
    for (const cls of classes) {
      const text = getFirstText(html, cls);
      const m = text.match(/[\d.]+/);
      if (m) return Math.round(parseFloat(m[0]));
    }
    return 0;
  };

  const pick = (nutrient: string, ...fallbacks: string[]): number =>
    fromContainer(nutrient) ||
    fromClass(
      `wprm-nutrition-label-text-nutrition-value-${nutrient}`,
      ...fallbacks,
    );

  return {
    calories: pick('calories', 'wprm-nutrition-label-text-for-calories', 'wprm-recipe-calories'),
    protein: pick('protein', 'wprm-nutrition-label-text-for-protein', 'wprm-recipe-protein'),
    carbs: pick('carbohydrates', 'wprm-nutrition-label-text-for-carbohydrates', 'wprm-recipe-carbohydrates'),
    fat: pick('fat', 'wprm-nutrition-label-text-for-fat', 'wprm-recipe-fat'),
  };
}

/** Parse nutrition: JSON-LD first (most reliable), CSS classes as fallback. */
function parseWprmNutrition(rawHtml: string, recipeHtml: string): Recipe['nutrition'] {
  const fromJsonLd = parseJsonLdNutrition(rawHtml);
  if (fromJsonLd) return fromJsonLd;

  console.log('[RecipeScraper] No JSON-LD nutrition found — falling back to CSS class extraction');
  return parseWprmNutritionByClass(recipeHtml);
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
