import type { Nutrition, Recipe } from './types';

export function mergeRecipeLabels(
  course: readonly string[] = [],
  tags: readonly string[] = [],
): string[] {
  const labels = new Map<string, string>();
  for (const raw of [...course, ...tags]) {
    const label = raw.trim();
    const key = label.toLowerCase();
    if (label && !labels.has(key)) labels.set(key, label);
  }
  return [...labels.values()];
}

export function hasMeaningfulNutrition(
  nutrition: Nutrition | undefined,
): nutrition is Nutrition {
  return Boolean(nutrition && Object.values(nutrition)
    .some((value) => typeof value === 'number' && Number.isFinite(value) && value > 0));
}

export interface NutritionTotals extends Nutrition {
  contributingRecipes: number;
}

const LIST_MARKER = /^(?:\d+[.)]|[-•])\s+/;

/** Turn legacy flattened recipe notes into readable display lines without rewriting them. */
export function formatRecipeNotes(value: string): string[] {
  const text = value.replace(/\r\n?/g, '\n').trim();
  if (!text) return [];
  const sourceLines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  if (sourceLines.length > 1) return sourceLines;

  const numbered = [...text.matchAll(/(?:^|\s)(\d+)[.)]\s+(?=\S)/g)];
  if (numbered.length > 1 && numbered.every((match, index) => Number(match[1]) === index + 1)) {
    return numbered.map((match, index) => {
      const start = (match.index ?? 0) + (match[0].startsWith(' ') ? 1 : 0);
      const end = index + 1 < numbered.length
        ? (numbered[index + 1].index ?? text.length)
        : text.length;
      return text.slice(start, end).trim();
    });
  }

  const bullets = text.split(/\s+[•-]\s+(?=\S)/).map((line) => line.trim()).filter(Boolean);
  if (bullets.length > 1) return bullets.map((line) => LIST_MARKER.test(line) ? line : `• ${line}`);

  const sentences = text.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g)?.map((s) => s.trim()).filter(Boolean) ?? [text];
  if (sentences.length < 3) return [text];
  const paragraphs: string[] = [];
  for (let index = 0; index < sentences.length; index += 2)
    paragraphs.push(sentences.slice(index, index + 2).join(' '));
  return paragraphs;
}

export function formatRecipeNoteItems(items: readonly string[]): string[] {
  if (items.length === 1) return formatRecipeNotes(items[0]);
  return items.flatMap((item) => formatRecipeNotes(item).map((line) =>
    LIST_MARKER.test(line) ? line : `• ${line}`,
  ));
}

export function sumKnownNutrition(
  recipes: readonly (Recipe | null | undefined)[],
): NutritionTotals {
  const totals: NutritionTotals = { contributingRecipes: 0 };
  for (const recipe of recipes) {
    if (!hasMeaningfulNutrition(recipe?.nutrition)) continue;
    totals.contributingRecipes += 1;
    for (const key of ['calories', 'protein', 'carbs', 'fat'] as const) {
      const value = recipe.nutrition[key];
      if (value !== undefined) totals[key] = (totals[key] ?? 0) + value;
    }
  }
  return totals;
}
