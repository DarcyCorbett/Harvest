import { normalizeIngredient as normalizeStructuredIngredient, normalizeUnit as sharedNormalizeUnit, metricWeight, formatNumber } from '../shared/ingredientAmounts.js';
import type {
  CanonicalIngredient,
  CompleteCanonicalRecipeV2,
} from './domain.js';
import { decodeEntities } from './htmlEntities.js';

const KNOWN_UNITS_TWO_WORD = new Set([
  'fl oz', 'fluid ounce', 'fluid ounces',
]);

const KNOWN_UNITS_ONE_WORD = new Set([
  'tbsp', 'tbs', 'tbsps', 'tablespoon', 'tablespoons',
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

function normalizeUnicodeFractions(value: string): string {
  return value
    .replace(/¼/g, '1/4').replace(/½/g, '1/2').replace(/¾/g, '3/4')
    .replace(/⅓/g, '1/3').replace(/⅔/g, '2/3')
    .replace(/⅛/g, '1/8').replace(/⅜/g, '3/8').replace(/⅝/g, '5/8').replace(/⅞/g, '7/8')
    .replace(/⅕/g, '1/5').replace(/⅖/g, '2/5').replace(/⅗/g, '3/5').replace(/⅘/g, '4/5')
    .replace(/⅙/g, '1/6').replace(/⅚/g, '5/6');
}

function parseQuantity(value: string): number {
  const normalized = normalizeUnicodeFractions(value).trim();
  if (!normalized) return 0;
  const mixed = /^(\d+)\s+(\d+)\/(\d+)$/.exec(normalized);
  if (mixed) return Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]);
  const fraction = /^(\d+)\/(\d+)$/.exec(normalized);
  if (fraction) return Number(fraction[1]) / Number(fraction[2]);
  return Number.parseFloat(normalized) || 0;
}

const normalizeUnit = sharedNormalizeUnit;
const convertIngredientWeight = metricWeight;

const QUANTITY_SOURCE = String.raw`(?:\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:\.\d+)?)`;
const IMPERIAL_WEIGHT_SOURCE = String.raw`(?:oz|ounce|ounces|lb|lbs|pound|pounds)`;
const METRIC_WEIGHT_SOURCE = String.raw`(?:g|gram|grams|kg|kilogram|kilograms)`;

function formatQuantity(value: number): string {
  return formatNumber(value);
}

function convertEmbeddedIngredientWeights(value: string): string {
  let normalized = normalizeUnicodeFractions(value);
  const metricThenImperial = new RegExp(
    `(${QUANTITY_SOURCE})\\s*(${METRIC_WEIGHT_SOURCE})\\s*\\/\\s*${QUANTITY_SOURCE}\\s*[- ]?${IMPERIAL_WEIGHT_SOURCE}\\b`,
    'gi',
  );
  normalized = normalized.replace(
    metricThenImperial,
    (_match, metricQuantity: string, metricUnit: string) =>
      `${formatQuantity(parseQuantity(metricQuantity))} ${normalizeUnit(metricUnit)}`,
  );
  const imperialThenMetric = new RegExp(
    `(${QUANTITY_SOURCE})\\s*[- ]?(${IMPERIAL_WEIGHT_SOURCE})\\s*\\/\\s*(${QUANTITY_SOURCE})\\s*(${METRIC_WEIGHT_SOURCE})\\b`,
    'gi',
  );
  normalized = normalized.replace(
    imperialThenMetric,
    (_match, _imperialQuantity: string, _imperialUnit: string, metricQuantity: string, metricUnit: string) =>
      `${formatQuantity(parseQuantity(metricQuantity))} ${normalizeUnit(metricUnit)}`,
  );

  const embeddedRange = new RegExp(
    `(${QUANTITY_SOURCE})(?:\\s*(?:[-–—]|to)\\s*(${QUANTITY_SOURCE}))?\\s*[- ]?(${IMPERIAL_WEIGHT_SOURCE})\\b`,
    'gi',
  );
  return normalized.replace(
    embeddedRange,
    (_match, firstQuantity: string, secondQuantity: string | undefined, rawUnit: string) => {
      const unit = normalizeUnit(rawUnit);
      if (!secondQuantity) {
        const converted = convertIngredientWeight(parseQuantity(firstQuantity), unit);
        return `${formatQuantity(converted.quantity)} ${converted.unit}`;
      }
      const factor = unit === 'oz' ? 28.35 : 453.6;
      const firstGrams = parseQuantity(firstQuantity) * factor;
      const secondGrams = parseQuantity(secondQuantity) * factor;
      if (Math.max(firstGrams, secondGrams) >= 500) {
        return `${formatQuantity(Math.round(firstGrams / 100) / 10)}–${formatQuantity(Math.round(secondGrams / 100) / 10)} kg`;
      }
      return `${Math.round(firstGrams)}–${Math.round(secondGrams)} g`;
    },
  );
}

function stripBalancedParens(value: string): { paren: string; rest: string } {
  const start = value.indexOf('(');
  if (start < 0) return { paren: '', rest: value };
  let depth = 1;
  let end = start + 1;
  while (end < value.length && depth > 0) {
    if (value[end] === '(') depth += 1;
    else if (value[end] === ')') depth -= 1;
    end += 1;
  }
  if (depth !== 0) return { paren: '', rest: value };
  return {
    paren: value.slice(start + 1, end - 1).trim(),
    rest: `${value.slice(0, start)}${value.slice(end)}`.replace(/\s+/g, ' ').trim(),
  };
}

function stripAllBalancedParens(value: string): { parens: string[]; rest: string } {
  const parens: string[] = [];
  let rest = value;
  while (true) {
    const extracted = stripBalancedParens(rest);
    if (!extracted.paren) break;
    parens.push(extracted.paren);
    rest = extracted.rest;
  }
  return { parens, rest };
}

/**
 * Catalogue copy of the legacy recipe ingredient parser. Keep its parsing
 * order and conversion formulas in parity with services/scraper/parse.ts.
 */
export type NormalizedCanonicalIngredient = CanonicalIngredient & {
  quantity: number;
  unit: string;
};

export function parseLegacyIngredient(raw: string): NormalizedCanonicalIngredient {
  let value = normalizeUnicodeFractions(decodeEntities(raw)).trim();
  value = value.replace(/^[\s■-◿☀-⛿✀-➿]+/, '').trim();

  let notes = '';
  const parenthetical = stripAllBalancedParens(value);
  if (parenthetical.parens.length > 0) {
    notes = parenthetical.parens.join('; ');
    value = parenthetical.rest;
  }

  let quantity = 0;
  const quantityPattern = /^(\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:\.\d+)?)(?:\s*(?:[-–—]|to)\s*(?:\d+(?:\.\d+)?|\d+\/\d+))?\s*/;
  const quantityMatch = quantityPattern.exec(value);
  if (quantityMatch) {
    quantity = parseQuantity(quantityMatch[1]);
    value = value.slice(quantityMatch[0].length).trim();
  }

  let unit = '';
  const dualUnitPattern = new RegExp(
    `^([A-Za-z]+)\\.?\\s*\\/\\s*(${QUANTITY_SOURCE})(?:\\s*(?:[-–—]|to)\\s*${QUANTITY_SOURCE})?\\s*([A-Za-z]+)\\.?\\s*`,
    'i',
  );
  const dualUnit = dualUnitPattern.exec(value);
  if (dualUnit) {
    const firstUnit = normalizeUnit(dualUnit[1]);
    const secondUnit = normalizeUnit(dualUnit[3]);
    const firstKnown = KNOWN_UNITS_ONE_WORD.has(dualUnit[1].toLowerCase());
    const secondKnown = KNOWN_UNITS_ONE_WORD.has(dualUnit[3].toLowerCase());
    if (firstKnown && secondKnown) {
      const secondIsMetric = ['g', 'kg', 'ml', 'l'].includes(secondUnit);
      const firstIsMetric = ['g', 'kg', 'ml', 'l'].includes(firstUnit);
      if (secondIsMetric && !firstIsMetric) {
        quantity = parseQuantity(dualUnit[2]);
        unit = secondUnit;
      } else {
        unit = firstUnit;
      }
      value = value.slice(dualUnit[0].length).trim();
    }
  }
  const tokens = value.split(/\s+/);
  if (!unit && tokens.length >= 2) {
    const twoWord = `${tokens[0]} ${tokens[1]}`.toLowerCase();
    if (KNOWN_UNITS_TWO_WORD.has(twoWord)) {
      unit = normalizeUnit(twoWord);
      value = tokens.slice(2).join(' ');
    }
  }
  if (!unit && tokens.length >= 1) {
    const oneWord = tokens[0].toLowerCase().replace(/\.$/, '');
    if (KNOWN_UNITS_ONE_WORD.has(oneWord)) {
      unit = normalizeUnit(oneWord);
      value = tokens.slice(1).join(' ');
    } else if (oneWord.includes('/')) {
      const matches = oneWord.split('/').flatMap((part) => {
        const cleaned = part.replace(/^[\d.]+/, '');
        if (!KNOWN_UNITS_ONE_WORD.has(cleaned)) return [];
        const normalized = normalizeUnit(cleaned);
        return [{
          unitPart: part,
          normalized,
          isMetric: ['g', 'kg', 'ml', 'l'].includes(normalized),
        }];
      });
      const best = matches.find(({ isMetric }) => isMetric) ?? matches[0];
      if (best) {
        unit = best.normalized;
        const prefixedQuantity = /^([\d.]+)/.exec(best.unitPart);
        if (prefixedQuantity) quantity = Number.parseFloat(prefixedQuantity[1]);
        value = tokens.slice(1).join(' ');
      }
    }
  }

  if (unit) {
    value = value.replace(/^of\s+/i, '').trim();
  }

  const commaIndex = value.search(/,(?!\d)/);
  if (commaIndex >= 0) {
    const trailing = value.slice(commaIndex + 1).trim();
    if (trailing) notes = notes ? `${notes}; ${trailing}` : trailing;
    value = value.slice(0, commaIndex).trim();
  }
  const dashIndex = value.search(/\s[–—]\s/);
  if (dashIndex >= 0) {
    const trailing = value.slice(dashIndex + 2).trim();
    if (trailing) notes = notes ? `${notes}; ${trailing}` : trailing;
    value = value.slice(0, dashIndex).trim();
  }

  const converted = convertIngredientWeight(quantity, unit);
  value = convertEmbeddedIngredientWeights(value);
  notes = convertEmbeddedIngredientWeights(notes);
  return {
    name: value.replace(/^of\s+/i, '').trim() || 'unknown',
    quantity: converted.quantity,
    unit: converted.unit,
    ...(notes ? { notes } : {}),
  };
}

/** Exact legacy instruction conversion rules. */
export function convertLegacyInstructionUnits(text: string): string {
  return text
    .replace(
      /(\d+(?:\.\d+)?)\s*°?\s*C\s*\/\s*\d+(?:\.\d+)?\s*(?:°\s*F|degrees?\s+(?:Fahrenheit|F)|F)\b/gi,
      (_match, celsius: string) => `${celsius}°C`,
    )
    .replace(
      /\d+(?:\.\d+)?\s*(?:°\s*F|degrees?\s+(?:Fahrenheit|F)|F)\s*\/\s*(\d+(?:\.\d+)?)\s*°?\s*C\b/gi,
      (_match, celsius: string) => `${celsius}°C`,
    )
    .replace(
      /(\d+(?:\.\d+)?)\s*(?:°\s*F|degrees?\s+(?:Fahrenheit|F)|F)\b/gi,
      (_match, fahrenheit: string) =>
        `${Math.round((Number.parseFloat(fahrenheit) - 32) * 5 / 9)}°C`,
    )
    .replace(
      /(\d+(?:\.\d+)?)\s*inch(?:es)?\b/gi,
      (_match, inches: string) =>
        `${Math.round(Number.parseFloat(inches) * 2.54 * 10) / 10}cm`,
    );
}

export interface CatalogueUnitNormalizationIssue {
  path: string;
  reason: 'embedded-imperial-unit' | 'invalid-quantity';
}

function normalizeIngredient(
  ingredient: CanonicalIngredient,
  path: string,
): { ingredient: CanonicalIngredient; issues: CatalogueUnitNormalizationIssue[] } {
  const issues: CatalogueUnitNormalizationIssue[] = [];
  const isRaw = ingredient.quantity === undefined && ingredient.unit === undefined;
  if (isRaw) {
    const parsed = parseLegacyIngredient(ingredient.name);
    const parsedNotes = ingredient.notes && parsed.notes && ingredient.notes !== parsed.notes
      ? `${parsed.notes}; ${ingredient.notes}`
      : ingredient.notes ?? parsed.notes;
    const normalized = {
      ...parsed,
      ...(parsedNotes
        ? { notes: convertLegacyInstructionUnits(parsedNotes) }
        : {}),
    };
    const convertibleImperial = new RegExp(
      `${QUANTITY_SOURCE}\\s*[- ]?${IMPERIAL_WEIGHT_SOURCE}\\b`,
      'i',
    );
    if (convertibleImperial.test(normalized.name)
      || convertibleImperial.test(normalized.notes ?? '')) {
      issues.push({ path, reason: 'embedded-imperial-unit' });
    }
    return { ingredient: normalized, issues };
  }

  ingredient = normalizeStructuredIngredient({ ...ingredient, quantity: ingredient.quantity ?? 0, unit: ingredient.unit ?? '' });
  const quantity = ingredient.quantity ?? 0;
  if (!Number.isFinite(quantity) || quantity < 0) {
    issues.push({ path, reason: 'invalid-quantity' });
    return { ingredient, issues };
  }
  const converted = convertIngredientWeight(quantity, normalizeUnit(ingredient.unit ?? ''));
  return {
    ingredient: {
      ...ingredient,
      quantity: converted.quantity,
      unit: converted.unit,
      name: convertEmbeddedIngredientWeights(ingredient.name),
      ...(ingredient.notes
        ? { notes: convertLegacyInstructionUnits(convertEmbeddedIngredientWeights(ingredient.notes)) }
        : {}),
    },
    issues,
  };
}

export interface CatalogueUnitNormalizationResult {
  content: CompleteCanonicalRecipeV2['content'];
  changed: boolean;
  issues: CatalogueUnitNormalizationIssue[];
}

export function normalizeCatalogueContent(
  content: CompleteCanonicalRecipeV2['content'],
): CatalogueUnitNormalizationResult {
  const issues: CatalogueUnitNormalizationIssue[] = [];
  const ingredients = content.ingredients.map((ingredient, index) => {
    const normalized = normalizeIngredient(ingredient, `ingredients.${index}`);
    issues.push(...normalized.issues);
    return normalized.ingredient;
  });
  const ingredientGroups = content.ingredientGroups?.map((group, groupIndex) => ({
    ...group,
    ingredients: group.ingredients.map((ingredient, ingredientIndex) => {
      const normalized = normalizeIngredient(
        ingredient,
        `ingredientGroups.${groupIndex}.ingredients.${ingredientIndex}`,
      );
      issues.push(...normalized.issues);
      return normalized.ingredient;
    }),
  }));
  const instructions = content.instructions.map((step) => step.isHeader
    ? step
    : { ...step, text: convertLegacyInstructionUnits(step.text) });
  const normalized: CompleteCanonicalRecipeV2['content'] = {
    ...content,
    ingredients,
    ...(ingredientGroups ? { ingredientGroups } : {}),
    instructions,
  };
  return {
    content: normalized,
    changed: JSON.stringify(normalized) !== JSON.stringify(content),
    issues,
  };
}
