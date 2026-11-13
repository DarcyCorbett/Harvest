import { combineAmounts, formatAmount, formatNumber } from '../functions/src/shared/ingredientAmounts';

const fractions: [number, string][] = [[1 / 8, '⅛'], [1 / 6, '⅙'], [1 / 4, '¼'], [1 / 3, '⅓'], [3 / 8, '⅜'], [1 / 2, '½'], [5 / 8, '⅝'], [2 / 3, '⅔'], [3 / 4, '¾'], [7 / 8, '⅞']];

/** Fractions are a display choice, never a minimum dose or upward rounding rule. */
export function toFraction(value: number): string {
  if (value <= 0) return '0';
  const whole = Math.floor(value), remainder = value - whole;
  const fraction = fractions.find(([number]) => Math.abs(number - remainder) < 1e-6);
  return fraction ? `${whole || ''}${fraction[1]}` : formatNumber(value);
}

export function normaliseUnit(quantity: number, unit: string): { quantity: number; unit: string } {
  const amount = combineAmounts([{ quantity, unit }])[0];
  return amount && !amount.qualitative ? amount : { quantity, unit };
}

export function formatIngredientAmount(quantity: number, unit: string): string {
  if (quantity <= 0) return '';
  const amount = normaliseUnit(quantity, unit);
  const suffix = formatAmount(amount).slice(formatNumber(amount.quantity).length);
  return `${toFraction(amount.quantity)}${suffix}`;
}
