import { describe, expect, it } from 'vitest';

import type { Case } from '../scripts/lib/aiEvaluationCore';
import type { DecisionAnswer } from '../scripts/lib/aiEvaluationDecision1';
import {
  REMINDER_QUESTIONS_V2,
  TAG_QUESTIONS_V2,
  TAXONOMY_QUESTIONS_V2,
  buildDecisionRequestV2,
  composeDecisionOutputV2,
} from '../scripts/lib/aiEvaluationDecision1V2';

const noul = (p: number): DecisionAnswer => ({ type: 'noul', noul: p, confidence: Math.max(p, 1 - p) });
const choice = (c: string): DecisionAnswer => ({ type: 'choice', choice: c, probabilities: { [c]: 1 }, confidence: 1 });
const taxonomyCase = { id: 'taxonomy-x', task: 'taxonomy', recipeIds: ['x'], input: { title: 'T', ingredients: [], instructions: [] }, prompt: '', baselineMax: 1 } as Case;
const tagCase = { id: 'tags-x', task: 'tags', recipeIds: ['x'], input: [{ recipeId: 'x', title: 'T', totalMinutes: null, ingredients: [], steps: [], existingTags: [] }], prompt: '', baselineMax: 1 } as Case;

/** A plain, healthy, kid-friendly dinner main; individual answers are overridden per test. */
function taxonomyAnswers(overrides: Record<string, DecisionAnswer> = {}): Record<string, DecisionAnswer> {
  const answers: Record<string, DecisionAnswer> = {};
  for (const [key, spec] of Object.entries(TAXONOMY_QUESTIONS_V2)) {
    if (spec.type === 'choice') answers[key] = choice(key === 'mealType_mode' ? 'dish' : 'none');
    else if (/_block_/.test(key) || /role_(breakfast|lunch|side|snack|dessert)$/.test(key) || key === 'healthy_clearlyHealthierVersion') answers[key] = noul(0.02);
    else answers[key] = noul(0.95);
  }
  return { ...answers, ...overrides };
}

describe('gemini-decision-1 v2 adapter', () => {
  it('sends the v1 recipe input with the v2 question set', () => {
    expect(Object.keys(buildDecisionRequestV2(taxonomyCase).questions)).toEqual(Object.keys(TAXONOMY_QUESTIONS_V2));
    expect(Object.keys(buildDecisionRequestV2(tagCase).questions)).toEqual(Object.keys(TAG_QUESTIONS_V2));
    expect(Object.keys(REMINDER_QUESTIONS_V2)).toEqual(['needsDefrost', 'needsMarinate']);
  });

  it('labels a clean main as a healthy, kid-friendly dinner', () => {
    expect(composeDecisionOutputV2(taxonomyCase, taxonomyAnswers())).toEqual({ mealTypes: ['dinner'], kidFriendly: true, healthy: true });
  });

  it('resolves a low lunch/dinner near-tie to dinner instead of lunch only', () => {
    const answers = taxonomyAnswers({ mealType_role_lunch: noul(0.4), mealType_role_dinner: noul(0.35) });
    expect(composeDecisionOutputV2(taxonomyCase, answers)).toMatchObject({ mealTypes: ['dinner'] });
    const clearLunch = taxonomyAnswers({ mealType_role_lunch: noul(0.45), mealType_role_dinner: noul(0.1) });
    expect(composeDecisionOutputV2(taxonomyCase, clearLunch)).toMatchObject({ mealTypes: ['lunch'] });
  });

  it('applies a kid blocker only when its own question says yes', () => {
    expect(composeDecisionOutputV2(taxonomyCase, taxonomyAnswers({ kid_block_alcohol: noul(0.3) }))).toMatchObject({ kidFriendly: true });
    expect(composeDecisionOutputV2(taxonomyCase, taxonomyAnswers({ kid_block_alcohol: noul(0.8) }))).toMatchObject({ kidFriendly: false });
  });

  it('fails healthy when any one restraint gate or blocker fails', () => {
    for (const key of ['healthy_addedSugarRestrained', 'healthy_refinedStarchRestrained', 'healthy_richnessRestrained']) {
      expect(composeDecisionOutputV2(taxonomyCase, taxonomyAnswers({ [key]: noul(0.3) }))).toMatchObject({ healthy: false });
    }
    expect(composeDecisionOutputV2(taxonomyCase, taxonomyAnswers({ healthy_block_fried: noul(0.9) }))).toMatchObject({ healthy: false });
  });

  it('treats a component as exclusive and never kid friendly', () => {
    const answers = taxonomyAnswers({ mealType_mode: choice('component'), mealType_componentKind: { type: 'choice', choice: 'sauce-condiment', probabilities: { 'sauce-condiment': 0.9, none: 0.1 }, confidence: 0.9 } });
    expect(composeDecisionOutputV2(taxonomyCase, answers)).toMatchObject({ mealTypes: ['component'], kidFriendly: false });
  });

  it('keeps Snack apart from Lunch and Dinner by probability', () => {
    const answers = Object.fromEntries(Object.keys(TAG_QUESTIONS_V2).map((k) => [k, noul(0.01)])) as Record<string, DecisionAnswer>;
    expect(composeDecisionOutputV2(tagCase, { ...answers, Snack: noul(0.9), Dinner: noul(0.6), Kid_Friendly: noul(0.9) })).toEqual({ id: 'x', tags: ['Snack', 'Kid Friendly'] });
    expect(composeDecisionOutputV2(tagCase, { ...answers, Snack: noul(0.6), Dinner: noul(0.9) })).toEqual({ id: 'x', tags: ['Dinner'] });
  });
});
