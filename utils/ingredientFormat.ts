// ============================================================
// Meal Wizard — Ingredient Amount Formatting
//
// Converts raw decimal quantities + unit strings into
// human-readable cooking fractions with automatic unit
// normalisation (tbsp ↔ tsp ↔ cup) and a minimum threshold
// of ⅛ tsp.
// ============================================================

// ─── Fraction Table ──────────────────────────────────────────

/** Canonical cooking fractions: [decimal value, display string] */
const FRACTIONS: [number, string][] = [
  [0,      ''],
  [1/8,    '⅛'],
  [1/6,    '⅙'],
  [1/4,    '¼'],
  [1/3,    '⅓'],
  [3/8,    '⅜'],
  [1/2,    '½'],
  [5/8,    '⅝'],
  [2/3,    '⅔'],
  [3/4,    '¾'],
  [7/8,    '⅞'],
  [1,      'CARRY'],
];

const TOLERANCE = 0.04;

/**
 * Convert a positive decimal to the nearest cooking fraction string.
 * e.g. 0.25 → "¼", 1.75 → "1¾", 2.0 → "2", 0.1875 → "¼" (≈3/16 rounds to ¼)
 */
export function toFraction(n: number): string {
  if (n <= 0) return '0';

  const whole = Math.floor(n);
  const frac = n - whole;

  // Find nearest canonical fraction
  let bestLabel = '';
  let bestDist = Infinity;
  let carry = false;

  for (const [val, label] of FRACTIONS) {
    const dist = Math.abs(frac - val);
    if (dist < bestDist) {
      bestDist = dist;
      bestLabel = label;
      carry = label === 'CARRY';
    }
  }

  const effectiveWhole = carry ? whole + 1 : whole;
  const fracPart = carry ? '' : bestLabel;

  if (bestDist > TOLERANCE) {
    // No close fraction — use 1 decimal place
    const rounded = Math.round(n * 10) / 10;
    return rounded % 1 === 0 ? String(Math.round(rounded)) : rounded.toFixed(1);
  }

  if (effectiveWhole === 0) return fracPart || '0';
  return fracPart ? `${effectiveWhole}${fracPart}` : String(effectiveWhole);
}

// ─── Unit Normalisation ───────────────────────────────────────

const MIN_TSP = 1 / 8; // ⅛ tsp — minimum displayable unit

/**
 * Convert volume units to the most readable scale after scaling.
 * Returns the adjusted quantity and unit.
 *
 * Rules (applied in order):
 *   tbsp < 1        → tsp  (× 3)
 *   tsp  ≥ 3        → tbsp (÷ 3)
 *   tbsp ≥ 16       → cup  (÷ 16)
 *   cup  < ⅛ cup    → tbsp (× 16), then re-check tbsp → tsp
 *
 * After conversion: tsp < ⅛ → round up to ⅛ tsp.
 * All non-volume units pass through unchanged.
 */
export function normaliseUnit(
  quantity: number,
  unit: string
): { quantity: number; unit: string } {
  let q = quantity;
  let u = unit.toLowerCase().trim();

  // cup → tbsp (very small cup amounts)
  if (u === 'cup' && q < MIN_TSP * 2) {
    q = q * 16;
    u = 'tbsp';
  }

  // tbsp → tsp (less than 1 tbsp)
  if (u === 'tbsp' && q < 1) {
    q = q * 3;
    u = 'tsp';
  }

  // tsp → tbsp (3 or more tsp)
  if (u === 'tsp' && q >= 3) {
    q = q / 3;
    u = 'tbsp';
  }

  // tbsp → cup (16 or more tbsp = 1 cup)
  if (u === 'tbsp' && q >= 16) {
    q = q / 16;
    u = 'cup';
  }

  // Minimum threshold: ⅛ tsp
  if (u === 'tsp' && q > 0 && q < MIN_TSP) {
    q = MIN_TSP;
  }

  // Preserve the original unit casing for display if it wasn't changed
  const finalUnit = u === unit.toLowerCase().trim() ? unit : u;

  return { quantity: q, unit: finalUnit };
}

// ─── Public API ───────────────────────────────────────────────

/**
 * Format an ingredient quantity + unit as a human-readable cooking string.
 *
 * Examples:
 *   (0.25, 'tbsp')  → "¾ tsp"   (¼ tbsp scaled to ¾ → 0.1875 tbsp → 0.5625 tsp ≈ ½ tsp)
 *   (1.75, 'cup')   → "1¾ cups"
 *   (300, 'g')      → "300 g"
 *   (0.03, 'tsp')   → "⅛ tsp"   (below minimum, rounded up)
 *   (0, 'clove')    → ""         (no quantity)
 */
export function formatIngredientAmount(quantity: number, unit: string): string {
  if (quantity <= 0) return '';

  const { quantity: q, unit: u } = normaliseUnit(quantity, unit);
  const fracStr = toFraction(q);

  if (!unit.trim()) return fracStr;
  return `${fracStr} ${u}`;
}
