import {
  COMPONENT_KINDS,
  DISH_MEAL_TYPES,
  HEALTHY_BLOCKERS,
  KID_BLOCKERS,
  deriveTaxonomyV2,
  type DerivedTaxonomyV2,
  type TaxonomyV2Evidence,
} from '../../functions/src/catalogue/taxonomyV2';
import type { Case } from './aiEvaluationCore';

export const DECISION_MODEL = 'gemini-decision-1';
export const DECISION_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/decisions';
export const DECISION_PRICE = {
  input: 0.10,
  output: 0.0,
  checkedOn: '2026-11-13',
  source: 'https://ai.google.dev/gemini-api/docs/pricing',
} as const;

export type DecisionQuestionSpec =
  | { type: 'noul'; instructions: string }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> };

export type DecisionAnswer =
  | { type: 'noul'; noul: number; confidence: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number };

export interface DecisionApiResponse {
  answers?: Record<string, DecisionAnswer>;
  usage?: {
    total_input_tokens?: number;
    total_output_tokens?: number;
    total_tokens?: number;
  };
  error?: { message?: string; status?: string; code?: number };
}

export interface DecisionRequestPayload {
  model: typeof DECISION_MODEL;
  input: string;
  questions: Record<string, DecisionQuestionSpec>;
}

const TAXONOMY_QUESTIONS: Record<string, DecisionQuestionSpec> = {
  mealType_mode: {
    type: 'choice',
    instructions:
      'Classify the complete prepared recipe as either a standalone dish or a non-meal component. Classify the finished food as written, not other meals it could later be used in. A dip alone is a component, while a complete dip-and-carriers recipe is a dish. Smoothies are dishes; cocktails and non-meal drinks are components.',
    criteria: {
      dish: 'A complete prepared dish, main meal, side dish, snack, or dessert commonly eaten directly.',
      component:
        'Sauces, Condiments & More: standalone sauces, dressings, dips alone, marinades, rubs, stocks, doughs, fillings, toppings, ingredient preparations, cocktails, or non-meal drinks.',
    },
  },
  mealType_componentKind: {
    type: 'choice',
    instructions:
      'If this recipe is a component (not a standalone dish, side, snack, or dessert), select the specific component kind; otherwise select none.',
    criteria: {
      none: 'The recipe is a standalone dish, main meal, side dish, snack, or dessert.',
      'sauce-condiment': 'A standalone sauce, dressing, gravy, glaze, marinade, spice rub, or condiment.',
      'dip-spread': 'A standalone dip, spread, salsa, or hummus without meal/snack carriers.',
      'ingredient-preparation': 'A base dough, crust, stock, broth, filling, topping, or single ingredient prep.',
      'drink-cocktail': 'A cocktail, alcoholic drink, coffee/tea beverage, or non-meal drink (not a meal smoothie).',
      'other-non-meal': 'Any other non-meal preparation that is not a dish, side, snack, or dessert.',
    },
  },
  mealType_role_breakfast: {
    type: 'noul',
    instructions:
      'Is this complete recipe commonly intended as a morning or brunch dish? Set true only when it is a common intended use (e.g. eggs, breakfast bowls, granola, smoothies, pancakes, waffles). Dessert-style sweet pancakes/waffles/crepes may also be breakfast.',
  },
  mealType_role_lunch: {
    type: 'noul',
    instructions:
      'Is this complete recipe a complete light-to-moderate midday meal? Set true only when the recipe itself constitutes a complete lunch as written — NOT for components, sides, snacks, dips, or desserts.',
  },
  mealType_role_dinner: {
    type: 'noul',
    instructions:
      'Is this complete recipe a complete main meal commonly served in the evening? Set true only when the recipe itself constitutes a complete dinner as written — NOT for sides, snacks, appetizers, components, or desserts.',
  },
  mealType_role_side: {
    type: 'noul',
    instructions:
      'Is this prepared recipe commonly served as a distinct edible accompaniment alongside a main dish (e.g. roasted vegetables, rice, bread, side salad), rather than a main meal, dessert, or sauce/condiment?',
  },
  mealType_role_snack: {
    type: 'noul',
    instructions:
      'Is this recipe commonly eaten independently between meals, such as smoothies, bars, fruit, cookies, small baked goods, complete dip-and-carriers recipes, or snack-style appetizers?',
  },
  mealType_role_dessert: {
    type: 'noul',
    instructions:
      'Is this recipe a complete sweet dish primarily intended as dessert (or dessert-style pancakes/waffles/crepes or cookies/small baked goods where dessert is a normal use)? Ordinary breakfast pancakes are NOT dessert.',
  },
  kid_standaloneOrRecognizable: {
    type: 'noul',
    instructions:
      'For children roughly ages 4–12, is this a standalone, recognizable dish (NOT a component-only recipe such as a standalone sauce, condiment, dip alone, stock, or ingredient prep)?',
  },
  kid_coreIngredientsAccessible: {
    type: 'noul',
    instructions:
      'Are the core ingredients of this recipe normally available in a mainstream full-size supermarket (without treating Western origin as inherently more familiar)?',
  },
  kid_broadChildAppeal: {
    type: 'noul',
    instructions:
      'Would a typical child (ages 4–12) reasonably be expected to choose and enjoy the complete dish, not merely tolerate or physically eat it? Mildness, sweetness, supermarket availability, or easy eating alone do NOT establish appeal. Do not assume a sweet glaze makes fish or a creamy texture makes a vegetable-forward risotto broadly child-appealing.',
  },
  kid_mildOrAdjustable: {
    type: 'noul',
    instructions:
      'Is the dish mild enough for ages 4–12, OR adjustable with at most one trivial serving change (an already-optional garnish, chili heat, or strong sauce served separately)? Changing integral seasoning, replacing a core ingredient, deconstructing the dish, or omitting multiple items is NOT trivial.',
  },
  kid_easyToEat: {
    type: 'noul',
    instructions:
      'Is this dish easy for a child (ages 4–12) to eat without awkward bones, shells, tough cuts, or integral extreme heat?',
  },
  kid_familyPractical: {
    type: 'noul',
    instructions:
      'Is this recipe practical as a family meal or snack with children?',
  },
  kid_blocker: {
    type: 'choice',
    instructions:
      'Select the primary blocker preventing this dish from being broadly Kid Friendly (ages 4–12), or select none if no such blocker exists.',
    criteria: {
      none: 'No kid-friendly blocker; broadly suitable and appealing for ages 4–12.',
      'integral-extreme-heat': 'Integral chili heat or spiciness that cannot be trivially omitted.',
      'alcohol-forward': 'Contains noticeable alcohol or an alcohol-forward flavor profile.',
      'awkward-bones-or-shells': 'Contains awkward bones, shells, or hard-to-eat seafood/meat cuts.',
      'central-specialty-or-acquired':
        'Relies on a central specialist, pungent, bitter, or strongly acquired ingredient/flavor for children.',
      'component-only': 'Recipe is a component-only sauce, condiment, marinade, or prep rather than a standalone dish.',
      'requires-major-changes': 'Would require changing integral seasoning, core ingredients, or deconstructing the dish.',
    },
  },
  healthy_nutrientDenseAnchor: {
    type: 'noul',
    instructions:
      'Does this recipe have a meaningful nutrient-dense anchor (meaningful non-starchy vegetables, fruit, legumes, nuts/seeds, whole grains, or suitable lean/plant protein)? Plain pasta, noodles, white rice, potatoes, taro, bread, or refined flour alone are NOT sufficient.',
  },
  healthy_meaningfulPlantsOrWholeFoods: {
    type: 'noul',
    instructions:
      'Does this recipe include meaningful amounts of non-starchy vegetables, fruit, legumes, nuts/seeds, or whole grains?',
  },
  healthy_suitableLeanOrPlantProtein: {
    type: 'noul',
    instructions:
      'Does this recipe provide suitable lean or plant protein (poultry breast, fish, seafood, eggs, legumes, tofu, tempeh, Greek yogurt), or is it a vegetable side/salad with a meaningful nutrient-dense plant base?',
  },
  healthy_minimallyProcessed: {
    type: 'noul',
    instructions:
      'Are the ingredients mostly minimally processed whole foods, without significant processed meat (bacon, sausage, salami) or heavy ultra-processed components?',
  },
  healthy_sensibleFatAndMethod: {
    type: 'noul',
    instructions:
      'Does the recipe use a sensible cooking method and fat level (baking, roasting, steaming, grilling, light sautéing; baked/air-fried with light breading and low oil is OK; battered, deep-fried, or oil/butter/cream-heavy fails)?',
  },
  healthy_limitedSugarRefinedStarchRichness: {
    type: 'noul',
    instructions:
      'Are added sugar, refined starch, processed meat, cheese, cream, butter, heavy sauces, oil, and sodium restrained in the complete recipe and realistic serving? Significant bacon/sausage/salami or materially high fat/sodium even with lean protein or vegetables fails this.',
  },
  healthy_clearlyHealthierVersion: {
    type: 'noul',
    instructions:
      'Is this recipe a clearly healthier version of a normally indulgent dish (such as a fruit-led/low-sugar dessert or baked light-breaded chicken) that materially reduces unhealthy features of the conventional version?',
  },
  healthy_blocker: {
    type: 'choice',
    instructions:
      'Select the primary nutritional blocker preventing this recipe from qualifying as Healthy, or select none if it qualifies.',
    criteria: {
      none: 'No nutritional blocker; everyday nutritious dish or clearly healthier version.',
      'deep-fried-or-battered': 'Deep-fried, battered, or heavily pan-fried in substantial oil.',
      'excess-added-sugar': 'High added sugar or confection/sweet-treat profile.',
      'processed-meat-dominant': 'Contains a nutritionally significant amount of bacon, sausage, salami, or processed meat.',
      'richness-dominant': 'Dominated by heavy cream, butter, substantial cheese, rich sauces, oil, or high fat/sodium.',
      'refined-starch-dominant': 'Centered on plain white pasta, noodles, white rice, refined flour, or bread without sufficient nutrient-dense balance.',
    },
  },
};

const TAG_QUESTIONS: Record<string, DecisionQuestionSpec> = {
  Breakfast: {
    type: 'noul',
    instructions: 'Tag as "Breakfast" only if this is clearly a morning meal (e.g. eggs, oats, pancakes, smoothies, breakfast bowls). Omit if borderline.',
  },
  Lunch: {
    type: 'noul',
    instructions: 'Tag as "Lunch" only if this is a substantial main midday meal — never for snacks, dips, appetizers, finger foods, or small bites. Only tag when confident.',
  },
  Dinner: {
    type: 'noul',
    instructions: 'Tag as "Dinner" only if this is a substantial main evening meal — never for snacks, dips, appetizers, finger foods, or small bites. Only tag when confident.',
  },
  Side: {
    type: 'noul',
    instructions: 'Tag as "Side" only if this dish is served alongside a main meal (e.g. roasted vegetables, rice, bread, side salads).',
  },
  Snack: {
    type: 'noul',
    instructions: 'Tag as "Snack" only if this is small/light and NOT a main meal (e.g. dips, wings, sliders, bliss balls, cookies, small bites).',
  },
  Salad: {
    type: 'noul',
    instructions: 'Tag as "Salad" only if this is clearly a salad-based dish.',
  },
  Asian: {
    type: 'noul',
    instructions: 'Tag as "Asian" only if this recipe clearly belongs to an Asian cuisine (e.g. Chinese, Japanese, Korean, Thai, Vietnamese, Southeast/East Asian). Exclude Indian (which has its own tag).',
  },
  Mexican: {
    type: 'noul',
    instructions: 'Tag as "Mexican" only if this recipe clearly belongs to Mexican or Tex-Mex cuisine.',
  },
  Mediterranean: {
    type: 'noul',
    instructions: 'Tag as "Mediterranean" only if this recipe clearly belongs to Mediterranean cuisine (e.g. Greek, Levantine, Spanish, coastal Mediterranean). Do not confuse purely Italian dishes unless genuinely Mediterranean-framed.',
  },
  Italian: {
    type: 'noul',
    instructions: 'Tag as "Italian" only if this recipe clearly belongs to Italian cuisine.',
  },
  Indian: {
    type: 'noul',
    instructions: 'Tag as "Indian" only if this recipe clearly belongs to Indian cuisine.',
  },
  Healthy: {
    type: 'noul',
    instructions:
      'Tag as "Healthy" ONLY when confident that MOST apply: whole minimally processed ingredients (whole grains, fresh produce, lean proteins, legumes); added sugar <~10g/serving, saturated fat <~5g/serving, no trans fats, sodium <~600mg/serving; contains a fibre source; cooked by baking/roasting/steaming/grilling/light sautéing (not deep/heavily pan-fried); vegetables are a substantial share. Omit if borderline.',
  },
  Vegetarian: {
    type: 'noul',
    instructions:
      'Tag as "Vegetarian" (lacto-ovo) ONLY if there is NO meat, poultry, fish, or seafood (including shellfish, fish sauce, anchovies, or any aquatic animal). Dairy and eggs are permitted.',
  },
  'Kid Friendly': {
    type: 'noul',
    instructions:
      'Tag as "Kid Friendly" ONLY when confident MOST apply: mild (no chili heat, minimal black pepper, no raw onion/garlic); no pungent ingredients (blue cheese, anchovies, olives, capers, fish sauce, strong curry pastes) unless undetectable; components identifiable and separated, not hidden in stew/casserole; bite-sized/fork-friendly; visually approachable; veg limited to kid-accepted ones (carrots, corn, peas, cucumber, cherry tomatoes, sweet peppers, broccoli, sweet potato); NO alcohol even if cooked off.',
  },
};

const REMINDER_QUESTIONS: Record<string, DecisionQuestionSpec> = {
  needsDefrost: {
    type: 'noul',
    instructions:
      'Set TRUE only if the recipe\'s main protein is one typically bought frozen and needing several hours to defrost: INCLUDE chicken breast/thigh/whole, ground/minced meat (beef/pork/lamb/turkey/chicken), beef cuts (steak, mince, stewing), pork chops/roasts/loins, lamb cuts, large fish fillets (salmon, cod, snapper), prawns/shrimp. EXCLUDE (FALSE): deli ham, sliced cured meats, bacon strips, smoked salmon, canned tuna/fish, eggs, tofu, paneer, halloumi, vegetarian/vegan dishes. When uncertain, choose FALSE.',
  },
  needsMarinate: {
    type: 'noul',
    instructions:
      'Set TRUE only if the instructions clearly call for >= 30 minutes of REFRIGERATED marinating BEFORE cooking (the protein/veg sits in a marinade in the fridge, e.g. "marinate for 30 minutes / overnight / 2 hours in the fridge"). EXCLUDE (FALSE): quick 5-15 min marinades, "marinate while you prep" with no duration, "rest at room temperature", "tenderise" with no liquid, dry-rubs not refrigerated. When uncertain, choose FALSE.',
  },
};

export function supportsDecision1(task: Case['task']): boolean {
  return task === 'taxonomy' || task === 'tags' || task === 'reminders';
}

export function buildDecisionRequest(c: Case): DecisionRequestPayload {
  if (c.task === 'taxonomy') {
    const content = c.input;
    const recipe = {
      title: String(content.title ?? '').trim().slice(0, 300),
      description: String(content.description ?? '').trim().slice(0, 1_000),
      originalServings: content.originalServings,
      ingredients: (content.ingredients ?? []).map((i: any) =>
        [i.quantity, i.unit, i.name, i.notes]
          .filter((v) => v !== undefined && v !== null && String(v).trim())
          .map((v) => String(v).trim())
          .join(' '),
      ),
      instructions: (content.instructions ?? [])
        .map((s: any) => String(s.text ?? '').trim())
        .filter(Boolean)
        .join(' ')
        .slice(0, 4_000),
      nutrition: content.nutrition ?? {},
    };
    return {
      model: DECISION_MODEL,
      input: `Recipe:\n${JSON.stringify(recipe)}`,
      questions: TAXONOMY_QUESTIONS,
    };
  }
  if (c.task === 'tags') {
    const r = Array.isArray(c.input) ? c.input[0] : c.input;
    return {
      model: DECISION_MODEL,
      input: `Recipe:\n${JSON.stringify({
        title: r.title,
        totalMinutes: r.totalMinutes,
        ingredients: r.ingredients,
        steps: r.steps,
        existingTags: r.existingTags,
      })}`,
      questions: TAG_QUESTIONS,
    };
  }
  if (c.task === 'reminders') {
    const r = Array.isArray(c.input) ? c.input[0] : c.input;
    return {
      model: DECISION_MODEL,
      input: `Recipe:\n${JSON.stringify({
        title: r.title,
        ingredients: r.ingredients,
        steps: r.steps,
      })}`,
      questions: REMINDER_QUESTIONS,
    };
  }
  throw new Error(`Task ${c.task} is not supported by ${DECISION_MODEL}`);
}

function noulProb(answers: Record<string, DecisionAnswer>, key: string): number {
  const ans = answers[key];
  if (!ans || ans.type !== 'noul' || typeof ans.noul !== 'number') {
    throw new Error(`Missing noul answer for ${key}`);
  }
  return ans.noul;
}

function choiceAnswer(
  answers: Record<string, DecisionAnswer>,
  key: string,
): { choice: string; probabilities: Record<string, number> } {
  const ans = answers[key];
  if (!ans || ans.type !== 'choice' || typeof ans.choice !== 'string') {
    throw new Error(`Missing choice answer for ${key}`);
  }
  return { choice: ans.choice, probabilities: ans.probabilities ?? {} };
}

export function composeDecisionOutput(
  c: Case,
  answers: Record<string, DecisionAnswer>,
  threshold = 0.5,
): DerivedTaxonomyV2 | { id: string; tags: string[] } | { id: string; needsDefrost: boolean; needsMarinate: boolean } {
  if (c.task === 'taxonomy') {
    const mode = choiceAnswer(answers, 'mealType_mode').choice as 'dish' | 'component';
    const rawComponent = choiceAnswer(answers, 'mealType_componentKind');
    let componentKind: typeof COMPONENT_KINDS[number];
    if (mode === 'dish') {
      componentKind = 'none';
    } else if (rawComponent.choice !== 'none' && COMPONENT_KINDS.includes(rawComponent.choice as any)) {
      componentKind = rawComponent.choice as typeof COMPONENT_KINDS[number];
    } else {
      const bestNonNone = Object.entries(rawComponent.probabilities)
        .filter(([k]) => k !== 'none' && COMPONENT_KINDS.includes(k as any))
        .sort((a, b) => b[1] - a[1])[0]?.[0];
      componentKind = (bestNonNone as typeof COMPONENT_KINDS[number]) ?? 'other-non-meal';
    }

    const roles = Object.fromEntries(
      DISH_MEAL_TYPES.map((role) => [
        role,
        mode === 'component' ? false : noulProb(answers, `mealType_role_${role}`) >= threshold,
      ]),
    ) as Record<typeof DISH_MEAL_TYPES[number], boolean>;

    const kidBlockerRaw = choiceAnswer(answers, 'kid_blocker').choice;
    const kidBlocker = KID_BLOCKERS.includes(kidBlockerRaw as any)
      ? (kidBlockerRaw as typeof KID_BLOCKERS[number])
      : 'none';
    const healthyBlockerRaw = choiceAnswer(answers, 'healthy_blocker').choice;
    const healthyBlocker = HEALTHY_BLOCKERS.includes(healthyBlockerRaw as any)
      ? (healthyBlockerRaw as typeof HEALTHY_BLOCKERS[number])
      : 'none';

    const evidence: TaxonomyV2Evidence = {
      mealType: {
        mode,
        roles,
        componentKind,
        confidence: 'medium',
        reason: 'gemini-decision-1',
      },
      kidFriendly: {
        standaloneOrRecognizable: noulProb(answers, 'kid_standaloneOrRecognizable') >= threshold,
        coreIngredientsAccessible: noulProb(answers, 'kid_coreIngredientsAccessible') >= threshold,
        broadChildAppeal: noulProb(answers, 'kid_broadChildAppeal') >= threshold,
        mildOrAdjustable: noulProb(answers, 'kid_mildOrAdjustable') >= threshold,
        easyToEat: noulProb(answers, 'kid_easyToEat') >= threshold,
        familyPractical: noulProb(answers, 'kid_familyPractical') >= threshold,
        blocker: kidBlocker,
        adjustment: null,
        confidence: 'medium',
        reason: 'gemini-decision-1',
      },
      healthy: {
        nutrientDenseAnchor: noulProb(answers, 'healthy_nutrientDenseAnchor') >= threshold,
        meaningfulPlantsOrWholeFoods: noulProb(answers, 'healthy_meaningfulPlantsOrWholeFoods') >= threshold,
        suitableLeanOrPlantProtein: noulProb(answers, 'healthy_suitableLeanOrPlantProtein') >= threshold,
        minimallyProcessed: noulProb(answers, 'healthy_minimallyProcessed') >= threshold,
        sensibleFatAndMethod: noulProb(answers, 'healthy_sensibleFatAndMethod') >= threshold,
        limitedSugarRefinedStarchRichness: noulProb(answers, 'healthy_limitedSugarRefinedStarchRichness') >= threshold,
        clearlyHealthierVersion: noulProb(answers, 'healthy_clearlyHealthierVersion') >= threshold,
        blocker: healthyBlocker,
        confidence: 'medium',
        reason: 'gemini-decision-1',
      },
    };
    return deriveTaxonomyV2(evidence);
  }

  if (c.task === 'tags') {
    const r = Array.isArray(c.input) ? c.input[0] : c.input;
    const probs = Object.fromEntries(
      Object.keys(TAG_QUESTIONS).map((tag) => [tag, noulProb(answers, tag)]),
    );
    const active = new Set(
      Object.entries(probs)
        .filter(([, p]) => p >= threshold)
        .map(([tag]) => tag),
    );
    // Enforce mutual-exclusion rules from buildTagRecipesPrompt using calibrated probabilities.
    if (active.has('Snack') && (active.has('Dinner') || active.has('Lunch'))) {
      const mealMax = Math.max(
        active.has('Dinner') ? probs.Dinner : 0,
        active.has('Lunch') ? probs.Lunch : 0,
      );
      if (probs.Snack >= mealMax) {
        active.delete('Dinner');
        active.delete('Lunch');
      } else {
        active.delete('Snack');
      }
    }
    if (active.has('Breakfast') && (active.has('Lunch') || active.has('Dinner'))) {
      const mealMax = Math.max(
        active.has('Dinner') ? probs.Dinner : 0,
        active.has('Lunch') ? probs.Lunch : 0,
      );
      if (probs.Breakfast >= mealMax) {
        active.delete('Lunch');
        active.delete('Dinner');
      } else {
        active.delete('Breakfast');
      }
    }
    return {
      id: r.recipeId,
      tags: Object.keys(TAG_QUESTIONS).filter((tag) => active.has(tag)),
    };
  }

  if (c.task === 'reminders') {
    const r = Array.isArray(c.input) ? c.input[0] : c.input;
    return {
      id: r.recipeId,
      needsDefrost: noulProb(answers, 'needsDefrost') >= threshold,
      needsMarinate: noulProb(answers, 'needsMarinate') >= threshold,
    };
  }

  throw new Error(`Unsupported task ${c.task}`);
}
