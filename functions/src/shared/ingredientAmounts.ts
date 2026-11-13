import { decodeEntities } from '../catalogue/htmlEntities';

/** Framework-free measurement rules used by ingestion, shopping and presentation. */
export interface IngredientAmount { quantity: number; unit: string; notes?: string }
export interface NamedIngredient extends IngredientAmount { name: string }

const aliases: Record<string, string> = {
  tbs: 'tbsp', tbsps: 'tbsp', tablespoon: 'tbsp', tablespoons: 'tbsp',
  tsps: 'tsp', teaspoon: 'tsp', teaspoons: 'tsp', cups: 'cup',
  gram: 'g', grams: 'g', kilogram: 'kg', kilograms: 'kg',
  ounce: 'oz', ounces: 'oz', ozs: 'oz', pound: 'lb', pounds: 'lb', lbs: 'lb',
  milliliter: 'ml', milliliters: 'ml', millilitre: 'ml', millilitres: 'ml',
  liter: 'l', liters: 'l', litre: 'l', litres: 'l',
  'fluid ounce': 'fl oz', 'fluid ounces': 'fl oz',
  cloves: 'clove', pieces: 'piece', slices: 'slice', cans: 'can', jars: 'jar',
  bags: 'bag', bunches: 'bunch', stalks: 'stalk', sprigs: 'sprig',
  leaves: 'leaf', heads: 'head', pinches: 'pinch', dashes: 'dash', handfuls: 'handful',
  pints: 'pint', quarts: 'quart', sticks: 'stick',
};
export function normalizeUnit(unit: string): string {
  const value = unit.trim().toLowerCase().replace(/\.$/, '');
  return aliases[value] ?? value;
}
// Retain the application's existing cup/spoon convention. Never infer densities.
export const VOLUME_ML: Record<string, number> = { ml: 1, l: 1000, cup: 236.588, tbsp: 14.7868, tsp: 4.92892, 'fl oz': 29.5735 };
export const WEIGHT_G: Record<string, number> = { g: 1, kg: 1000, oz: 28.3495, lb: 453.592 };
const countUnits = new Set(['', 'piece', 'clove', 'slice', 'can', 'jar', 'bag', 'bunch', 'stalk', 'sprig', 'leaf', 'head']);
export const isCountUnit = (unit: string): boolean => countUnits.has(normalizeUnit(unit));
export function baseAmount(amount: IngredientAmount): IngredientAmount {
  const unit = normalizeUnit(amount.unit);
  const factor = VOLUME_ML[unit] ?? WEIGHT_G[unit] ?? 1;
  return { ...amount, quantity: amount.quantity * factor, unit: VOLUME_ML[unit] ? 'ml' : WEIGHT_G[unit] ? 'g' : unit };
}
export function metricWeight(quantity: number, unit: string): IngredientAmount {
  unit = normalizeUnit(unit);
  if (unit !== 'oz' && unit !== 'lb') return { quantity, unit };
  const grams = quantity * WEIGHT_G[unit];
  return grams >= 500 ? { quantity: grams / 1000, unit: 'kg' } : { quantity: grams, unit: 'g' };
}
export function normalizedName(name: string): string {
  return decodeEntities(name).trim().toLowerCase().replace(/^of\s+/i, '').replace(/\s+/g, ' ');
}
const fractionValues: Record<string, string> = { '½': '1/2', '¼': '1/4', '¾': '3/4', '⅓': '1/3', '⅔': '2/3', '⅛': '1/8', '⅜': '3/8', '⅝': '5/8', '⅞': '7/8' };
const numberPattern = '(?:\\d+\\s+\\d+/\\d+|\\d+/\\d+|\\d+(?:\\.\\d+)?)';
function numberValue(value: string): number {
  const parts = value.trim().split(/\s+/);
  return parts.reduce((sum, part) => {
    const [a, b] = part.split('/').map(Number);
    return sum + (b ? a / b : a);
  }, 0);
}

/** Repair only syntactically explicit measurements; never infer a food's density. */
export function normalizeIngredient<T extends NamedIngredient>(ingredient: T): T {
  let name = decodeEntities(ingredient.name).replace(/<[^>]+>/g, '').trim();
  name = name.replace(/([\d])([½¼¾⅓⅔⅛⅜⅝⅞])/g, '$1 $2').replace(/[½¼¾⅓⅔⅛⅜⅝⅞]/g, c => fractionValues[c]);
  let quantity = ingredient.quantity;
  let unit = normalizeUnit(ingredient.unit);
  let notes = ingredient.notes ? decodeEntities(ingredient.notes) : '';
  if (!unit) {
    const candidate = /^[-–—]\s*\d/.test(name) ? `${quantity} ${name}` : name;
    const match = new RegExp(`^(${numberPattern})(?:\\s*([-–—]|to)\\s*(${numberPattern}))?\\s*(.+)$`, 'i').exec(candidate);
    const rest = match?.[4] ?? name;
    const unitMatch = /^(fluid ounces?|fl oz|[a-z]+)\.?(?=\s|\/)(.+)$/i.exec(rest);
    const parsedUnit = unitMatch ? normalizeUnit(unitMatch[1]) : '';
    const explicitQuantity = !match || quantity === 0 || numberValue(match[1]) === quantity;
    if (explicitQuantity && unitMatch && (parsedUnit in VOLUME_ML || parsedUnit in WEIGHT_G || countUnits.has(parsedUnit) || ['pinch', 'dash', 'handful'].includes(parsedUnit))) {
      if (match) quantity = numberValue(match[1]);
      unit = parsedUnit;
      name = unitMatch[2].trim();
      const alternate = new RegExp(`^/\\s*${numberPattern}(?:\\s*(?:[-–—]|to)\\s*${numberPattern})?\\s*([a-z]+)\\.?\\s+(.+)$`, 'i').exec(name);
      if (alternate && normalizeUnit(alternate[1]) in WEIGHT_G && unit in WEIGHT_G) name = alternate[2];
      if (match?.[3]) notes = [notes, `Source range: ${match[1]}–${match[3]} ${unit}`].filter(Boolean).join('; ');
    }
    // "garlic cloves" carries an explicit count unit, whereas "cloves" is a spice.
    if (!unit) {
      const count = /^(.+?)\s+(cloves?|heads?|stalks?|sprigs?|slices?|pieces?)$/i.exec(name);
      if (count) { name = count[1]; unit = normalizeUnit(count[2]); }
    }
  }
  return { ...ingredient, name: name.replace(/^of\s+/i, '').trim(), quantity, unit, ...(notes ? { notes } : {}) };
}

/** Product forms are retained even if an AI returns an over-broad canonical name. */
export function productForm(food: Pick<NamedIngredient, 'name' | 'notes'>): string {
  const primary = normalizedName(food.name);
  const context = `${primary} ${food.notes ?? ''}`.toLowerCase();
  const forms: string[] = [];
  if (/\b(powder|powdered)\b/.test(context)) forms.push('powder');
  if (/\bcubes?\b/.test(primary)) forms.push('cube');
  if (/\b(concentrate|concentrated)\b/.test(primary)) forms.push('concentrate');
  if (/\b(dried|dehydrated)\b/.test(primary)) forms.push('dried');
  else if (/\bfresh\b/.test(primary)) forms.push('fresh');
  if (/\bcooked\b/.test(primary) || /^(?:\s*[^;]*;)*\s*cooked\b/.test(food.notes ?? '')) forms.push('cooked');
  else if (/\braw\b/.test(primary)) forms.push('raw');
  if (/\bsmoked\b/.test(primary)) forms.push('smoked');
  for (const cut of ['breast', 'thigh', 'mince', 'ground', 'fillet', 'steak', 'whole']) {
    if (new RegExp(`\\b${cut}(?:s)?\\b`).test(primary)) forms.push(cut === 'ground' ? 'mince' : cut);
  }
  return [...new Set(forms)].sort().join('|');
}

export function safeGroupNames(canonicalName: string, members: Pick<NamedIngredient, 'name' | 'notes'>[]): string[] {
  // Unspecified fresh produce may join explicitly fresh produce; explicit dried
  // or processed forms cannot join an unspecified/other product.
  const signature = (food: Pick<NamedIngredient, 'name' | 'notes'>) => productForm(food).split('|').filter(f => f !== 'fresh').join('|');
  const forms = members.map(signature);
  const proposed = signature({ name: canonicalName });
  const safe = new Set(forms).size === 1 && (!forms[0] || proposed === forms[0]);
  return members.map(member => safe ? normalizedName(canonicalName) : shoppingName(member));
}

export function shoppingName(food: Pick<NamedIngredient, 'name' | 'notes'>): string {
  const name = normalizedName(food.name);
  const existing = new Set(productForm({ name }).split('|'));
  const missing = productForm(food).split('|').filter(form => form && !existing.has(form));
  return missing.length ? `${name} (${missing.join(', ')})` : name;
}

export interface DisplayAmount extends IngredientAmount { qualitative?: string }
export function combineAmounts(amounts: IngredientAmount[], roundCounts = false): DisplayAmount[] {
  const groups = new Map<string, { quantity: number; originals: IngredientAmount[] }>();
  const qualitative = new Set<string>();
  for (const amount of amounts) {
    if (!Number.isFinite(amount.quantity) || amount.quantity < 0) continue;
    if (!amount.quantity) { qualitative.add(/to taste/i.test(amount.notes ?? '') ? 'to taste' : 'as needed'); continue; }
    const base = baseAmount(amount);
    const group = groups.get(base.unit) ?? { quantity: 0, originals: [] };
    group.quantity += base.quantity;
    group.originals.push(amount);
    groups.set(base.unit, group);
  }
  const result: DisplayAmount[] = [];
  for (const [baseUnit, group] of groups) {
    let { quantity } = group;
    let unit = baseUnit;
    if (unit === 'ml' && group.originals.every(a => ['tsp', 'tbsp', 'cup'].includes(normalizeUnit(a.unit)))) {
      const units = group.originals.map(a => normalizeUnit(a.unit));
      unit = units.includes('cup') && quantity >= VOLUME_ML.cup / 4 ? 'cup'
        : units.includes('tbsp') && quantity >= VOLUME_ML.tbsp ? 'tbsp' : 'tsp';
      quantity /= VOLUME_ML[unit];
    } else if ((unit === 'ml' || unit === 'g') && quantity >= 1000) {
      quantity /= 1000; unit = unit === 'ml' ? 'l' : 'kg';
    }
    if (roundCounts && isCountUnit(unit)) quantity = Math.ceil(quantity - 1e-9);
    result.push({ quantity, unit });
  }
  for (const text of qualitative) result.push({ quantity: 0, unit: '', qualitative: text });
  return result;
}
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '?';
  if (value !== 0 && Math.abs(value) < 0.01) return String(Number(value.toPrecision(2)));
  return String(Math.round(value * 100) / 100);
}
export function formatAmount(amount: DisplayAmount): string {
  if (amount.qualitative) return amount.qualitative;
  const plurals: Record<string, string> = { cup: 'cups', clove: 'cloves', head: 'heads', piece: 'pieces', slice: 'slices', can: 'cans', jar: 'jars', bag: 'bags', bunch: 'bunches', leaf: 'leaves', sprig: 'sprigs', stalk: 'stalks', pinch: 'pinches', dash: 'dashes' };
  const unit = amount.quantity === 1 ? amount.unit : plurals[amount.unit] ?? amount.unit;
  return `${formatNumber(amount.quantity)}${unit ? ` ${unit}` : ''}`;
}
