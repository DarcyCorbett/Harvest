import { deriveTaxonomyV2, type DerivedTaxonomyV2 } from '../../functions/src/catalogue/taxonomyV2';
import {
  DECISION_QUESTION_SET,
  DECISION_THRESHOLDS,
  REMINDER_QUESTIONS,
  TAG_QUESTIONS,
  TAXONOMY_QUESTIONS,
  buildReminderDecisionInput,
  buildTagDecisionInput,
  buildTaxonomyDecisionInput,
  composeReminders,
  composeTags,
  composeTaxonomyEvidence,
  type DecisionAnswers,
  type DecisionQuestion,
  type DecisionThresholds,
} from '../../functions/src/ai/decision';
import { DECISION_MODEL } from '../../functions/src/ai/models';
import type { Case } from './aiEvaluationCore';

// Evaluation adapter for the gemini-decision-1 question set the app uses.
//
// The questions, cut-offs and answer composition live in
// functions/src/ai/decision.ts; this file only maps benchmark cases onto them,
// so the evaluation always measures exactly what production runs. The "V2"
// names are kept from the first rewrite; the set in use is DECISION_QUESTION_SET.
export { DECISION_QUESTION_SET, type DecisionThresholds };
export const TAXONOMY_QUESTIONS_V2 = TAXONOMY_QUESTIONS;
export const TAG_QUESTIONS_V2 = TAG_QUESTIONS;
export const REMINDER_QUESTIONS_V2 = REMINDER_QUESTIONS;
export const THRESHOLDS_V2 = DECISION_THRESHOLDS;

export interface DecisionRequestV2 {
  model: typeof DECISION_MODEL;
  input: string;
  questions: Record<string, DecisionQuestion>;
}

export function buildDecisionRequestV2(c: Case): DecisionRequestV2 {
  if (c.task === 'taxonomy') return { model: DECISION_MODEL, input: buildTaxonomyDecisionInput(c.input), questions: TAXONOMY_QUESTIONS };
  const recipe = Array.isArray(c.input) ? c.input[0] : c.input;
  if (c.task === 'tags') return { model: DECISION_MODEL, input: buildTagDecisionInput(recipe), questions: TAG_QUESTIONS };
  if (c.task === 'reminders') return { model: DECISION_MODEL, input: buildReminderDecisionInput(recipe), questions: REMINDER_QUESTIONS };
  throw new Error(`Task ${c.task} is not supported by ${DECISION_MODEL}`);
}

export function composeDecisionOutputV2(
  c: Case,
  answers: DecisionAnswers,
  thresholds: DecisionThresholds = DECISION_THRESHOLDS[c.task as 'taxonomy' | 'tags' | 'reminders'],
): DerivedTaxonomyV2 | { id: string; tags: string[] } | { id: string; needsDefrost: boolean; needsMarinate: boolean } {
  if (c.task === 'taxonomy') return deriveTaxonomyV2(composeTaxonomyEvidence(answers, thresholds));
  const recipe = Array.isArray(c.input) ? c.input[0] : c.input;
  if (c.task === 'tags') return { id: recipe.recipeId, tags: composeTags(answers, thresholds) };
  if (c.task === 'reminders') return { id: recipe.recipeId, ...composeReminders(answers, thresholds) };
  throw new Error(`Unsupported task ${c.task}`);
}
