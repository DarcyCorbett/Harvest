import {
  COMPONENT_KINDS,
  DISH_MEAL_TYPES,
  type TaxonomyV2Evidence,
} from '../catalogue/taxonomyV2.js';
import type { CompleteCanonicalRecipeV2 } from '../catalogue/domain.js';
import { DECISION_MODEL } from './models.js';

/**
 * Recipe labelling with gemini-decision-1.
 *
 * The Decisions API returns a calibrated probability per question and no text.
 * Every question is answered independently against the same input and cannot
 * see the others, so each rule is stated inside its own question or applied
 * here when the answers are combined. There is no batch mode and no caching:
 * the efficient shape is one request per recipe, with requests in parallel.
 *
 * Changing a question or a cut-off changes labels. Re-run
 * scripts/evaluate-decision1-v2.ts (docs/ai-stack-evaluation.md) and bump
 * DECISION_QUESTION_SET before shipping a change.
 */
export const DECISION_QUESTION_SET = 'v4';
export const DECISION_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/decisions';

export type DecisionQuestion =
  | { type: 'noul'; instructions: string }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> };

export type DecisionAnswer =
  | { type: 'noul'; noul: number; confidence: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number };

export type DecisionAnswers = Record<string, DecisionAnswer>;
export type DecisionThresholds = { default: number } & Record<string, number>;

const noul = (instructions: string): DecisionQuestion => ({ type: 'noul', instructions });

export const TAXONOMY_QUESTIONS: Record<string, DecisionQuestion> = {
  mealType_mode: {
    type: 'choice',
    instructions:
      'Classify the complete prepared recipe as either a dish or a non-meal component. Classify the finished food as written, not other meals it could later be used in. A finished food commonly eaten directly (a cooked protein main, a soup, a salad) is a dish even if it can also be used as an ingredient. A dip alone is a component, while a complete dip-and-carriers recipe is a dish. Smoothies are dishes; cocktails and non-meal drinks are components.',
    criteria: {
      dish: 'A prepared main, side dish, snack, appetizer, or dessert commonly eaten directly.',
      component:
        'Sauces, Condiments & More: standalone sauces (including a pasta sauce with no pasta in the recipe), dressings, dips alone, marinades, rubs, stocks, doughs, fillings, toppings, ingredient preparations, cocktails, or non-meal drinks.',
    },
  },
  mealType_componentKind: {
    type: 'choice',
    instructions:
      'If this recipe is a component (not a dish, side, snack, or dessert), select the specific component kind; otherwise select none.',
    criteria: {
      none: 'The recipe is a main, side dish, snack, appetizer, or dessert.',
      'sauce-condiment': 'A standalone sauce, dressing, gravy, glaze, marinade, spice rub, or condiment.',
      'dip-spread': 'A standalone dip, spread, salsa, or hummus without meal/snack carriers.',
      'ingredient-preparation': 'A base dough, crust, stock, broth, filling, topping, or single ingredient prep.',
      'drink-cocktail': 'A cocktail, alcoholic drink, coffee/tea beverage, or non-meal drink (not a meal smoothie).',
      'other-non-meal': 'Any other non-meal preparation that is not a dish, side, snack, or dessert.',
    },
  },
  mealType_role_breakfast: noul(
    'Is this recipe commonly intended as a morning or brunch dish (e.g. eggs, breakfast bowls, granola, oats, smoothies, pancakes, waffles, breakfast pastries)? Dessert-style sweet pancakes/waffles/crepes may also be breakfast. Answer no for ordinary lunch or dinner mains.',
  ),
  mealType_role_lunch: noul(
    'Is this recipe a type of dish people commonly make for a midday meal, and substantial enough to be that meal: a soup, a main-course salad, a sandwich, wrap, gyro, taco or burger, dumplings, or a light rice, grain or noodle bowl? Answer no for a plated evening main such as a roast, chops, steak, fish fillet with sauce, stew, curry, braise, stir-fry, baked pasta, creamy pasta or casserole, even though leftovers could be eaten at lunch. Answer no for sides, snacks, dips, components and desserts.',
  ),
  mealType_role_dinner: noul(
    'Is this recipe a main dish commonly served as the centre of an evening meal? A protein main (chops, a roast, fish fillets, marinated, grilled or baked chicken), a stew, curry, stir-fry, pasta dish, casserole, hearty soup or main-course salad counts, even when the cook would add a simple side such as rice, bread or vegetables that the recipe does not include. Answer no for side dishes, snacks, appetizer-sized bites, dips, sauces, components and desserts.',
  ),
  mealType_role_side: noul(
    'Is this prepared recipe commonly served as a distinct accompaniment alongside a main dish (e.g. roasted or mashed vegetables, potatoes, rice, bread, a side salad, a grain or pasta salad, a vegetable stew that the recipe says can be a side)? Answer no for protein mains, complete meals, desserts, and sauces or condiments.',
  ),
  mealType_role_snack: noul(
    'Is this recipe commonly eaten between meals or as a small appetizer: smoothies, bars, fruit, cookies, small baked goods, complete dip-and-carriers recipes, finger foods, party bites, or a small plated starter? Answer no for soups, stews, salads, a main-sized portion of a protein, a complete meal, or a side dish.',
  ),
  mealType_role_dessert: noul(
    'Is this recipe a complete sweet dish primarily intended as dessert (or dessert-style pancakes/waffles/crepes or cookies/small baked goods where dessert is a normal use)? Ordinary breakfast pancakes are NOT dessert.',
  ),
  kid_standaloneOrRecognizable: noul(
    'For children roughly ages 4–12, is this a standalone, recognizable dish (NOT a component-only recipe such as a standalone sauce, condiment, dip alone, stock, or ingredient prep)?',
  ),
  kid_coreIngredientsAccessible: noul(
    'Are the core ingredients of this recipe normally available in a mainstream full-size supermarket (without treating Western origin as inherently more familiar)?',
  ),
  kid_broadChildAppeal: noul(
    'Would a typical child (ages 4–12) reasonably be expected to choose and enjoy the complete dish, not merely tolerate or physically eat it? Mildness, sweetness, supermarket availability, or easy eating alone do NOT establish appeal. Do not assume a sweet glaze makes fish or a creamy texture makes a vegetable-forward risotto broadly child-appealing. Mixed vegetable soups, stews, vegetable-forward casseroles, composed salads, and plain vegetable sides are usually tolerated rather than chosen.',
  ),
  kid_mildOrAdjustable: noul(
    'Is the dish mild enough for ages 4–12, OR adjustable with at most one trivial serving change (an already-optional garnish, chili heat, or strong sauce served separately)? Changing integral seasoning, replacing a core ingredient, deconstructing the dish, or omitting multiple items is NOT trivial.',
  ),
  kid_easyToEat: noul(
    'Can a child (ages 4–12) eat or drink this without difficulty? Food eaten with a fork, spoon or fingers, drinks and smoothies, sliced or carved meat, drumsticks, and boneless cuts are all easy. Answer no only when the eater must deal with small bones, shells, or very tough or unwieldy pieces.',
  ),
  kid_familyPractical: noul('Is this recipe practical as a family meal or snack with children?'),
  kid_block_heat: noul(
    'Is strong chili heat integral to this dish: built into the sauce, paste, marinade or seasoning in an amount a typical 4–12 year old would find hot, and not removable by leaving off an optional garnish or serving a sauce separately? A pinch of pepper flakes, mild chili powder, paprika, black pepper, or clearly optional chili does not count.',
  ),
  kid_block_alcohol: noul(
    'Is alcohol forward in the finished dish: uncooked or barely cooked spirits, wine or beer; ingredients soaked in alcohol; or a sauce whose defining flavour is the alcohol (for example Marsala sauce or beer cheese sauce)? A splash or cup of wine simmered into a long-cooked stew, ragù, pot pie or risotto does not count.',
  ),
  kid_block_bones: noul(
    'As the dish is served and eaten, must the eater deal with small bones or shells, or pick meat from fiddly pieces (whole fish, shell-on prawns, crab, bone-in chunks in a soup or stew, wings)? A whole bird or bone-in roast carved before serving, drumsticks, chops, and boneless cuts do not count.',
  ),
  kid_block_acquired: noul(
    'Is the dish built around a specialist or strongly acquired ingredient or flavour for children: offal, raw meat or fish, coffee, strong blue or washed-rind cheese, anchovy- or fish-sauce-forward seasoning, very bitter greens, fermented shrimp paste, medicinal herbs, or ingredients not sold in mainstream supermarkets? Everyday seasonings in ordinary amounts (mustard, pesto, garlic, dried herbs, Parmesan, mozzarella, mild spices, tomato sauce, breadcrumbs) do not count.',
  ),
  healthy_nutrientDenseAnchor: noul(
    'Does this recipe have a meaningful nutrient-dense anchor (meaningful non-starchy vegetables, fruit, legumes, nuts/seeds, whole grains, sweet potato, eggs, or suitable lean/plant protein)? Plain pasta, noodles, white rice, white potatoes, taro, bread, or refined flour alone are NOT sufficient.',
  ),
  healthy_meaningfulPlantsOrWholeFoods: noul(
    'Does this recipe include meaningful amounts of non-starchy vegetables, fruit, legumes, nuts/seeds, or whole grains?',
  ),
  healthy_suitableLeanOrPlantProtein: noul(
    'Does this recipe provide suitable lean or plant protein: skinless poultry, fish, seafood, eggs, lean pork or beef cuts (tenderloin, loin chops, lean mince, trimmed stewing beef), legumes, tofu, tempeh, or Greek yogurt? Fatty cuts (pork belly, ribs, skin-on fried chicken, regular mince in quantity) and processed meats do not count.',
  ),
  healthy_minimallyProcessed: noul(
    'Are the ingredients mostly minimally processed whole foods, without significant processed meat (bacon, sausage, salami) or heavy ultra-processed components (packet mixes, frozen fries, bottled sweet sauces as the main flavour)?',
  ),
  healthy_sensibleFatAndMethod: noul(
    'Does the recipe use a sensible cooking method and fat level (baking, roasting, steaming, poaching, grilling, air-frying, simmering, light sautéing; baked or air-fried with light breading and low oil is OK)? Battered, deep-fried, shallow-fried in substantial oil, or oil-, butter- or cream-heavy cooking fails.',
  ),
  healthy_addedSugarRestrained: noul(
    'Is added sugar restrained in a realistic serving: roughly under 10 g per serving of added sugar, honey, syrup, molasses, jam or sweet bottled sauce? Add up every sweetener in the ingredient list and divide by the servings. A sauce, glaze, compote, jam or condiment with sugar, honey, molasses or jam as a main ingredient is NOT restrained, however small its serving. Natural sugar from whole fruit, vegetables, tomatoes or dairy does not count against it. A recipe with no added sweetener is restrained.',
  ),
  healthy_refinedStarchRestrained: noul(
    'Is refined starch restrained: the dish is NOT mostly white pasta, noodles, white rice, refined flour, pastry, bread, dough or batter? A moderate portion (about 60 g dry pasta or noodles per serving or less, or bread on the side) balanced by plenty of vegetables or protein counts as restrained. Whole grains and dishes with no refined starch are restrained.',
  ),
  healthy_richnessRestrained: noul(
    'Are cheese, cream, butter, coconut milk, mayonnaise, fatty meat and added oil restrained in a realistic serving: not a cream-, butter-, cheese- or mayonnaise-based sauce, and no more than roughly a tablespoon of added fat plus a small amount of cheese per serving? Olive oil for sautéing or roasting, a normally dressed salad, nuts, avocado and oily fish count as restrained.',
  ),
  healthy_clearlyHealthierVersion: noul(
    'Is this recipe a clearly healthier version of a normally indulgent dish (such as a fruit-led/low-sugar dessert, baked or air-fried light-breaded chicken, or a cream sauce replaced by pureed vegetables) that materially reduces unhealthy features of the conventional version?',
  ),
  healthy_block_fried: noul(
    'Is the main food battered, deep-fried, or shallow-fried in a substantial depth of oil (a quarter inch or more, or a cup or more of frying oil)? Air-frying, oven-baking with light breading, and sautéing or searing in a few tablespoons of oil are NOT.',
  ),
  healthy_block_processedMeat: noul(
    'Is processed meat (bacon, sausage, salami, ham, prosciutto, pepperoni, hot dogs, processed meatballs) a main component of this recipe: roughly 40 g or more per serving, or the main protein? A slice of bacon or less per serving used as flavouring or garnish does not count.',
  ),
};

export const TAG_QUESTIONS: Record<string, DecisionQuestion> = {
  Breakfast: noul('Is this clearly a morning meal (e.g. eggs, oats, pancakes, French toast, smoothies, breakfast bowls)?'),
  Lunch: noul(
    'Is this a substantial main meal of a type people commonly make for midday: a soup, a main-course salad, a sandwich, wrap, gyro, taco or burger, dumplings, or a light rice, grain or noodle bowl? Answer no for a plated evening main such as a roast, chops, steak, fish fillet with sauce, stew, curry, braise, stir-fry, baked or creamy pasta or casserole, and no for snacks, dips, appetizers, finger foods, small bites and side dishes.',
  ),
  Dinner: noul(
    'Is this a substantial main dish commonly served as the centre of an evening meal? A protein main, stew, curry, stir-fry, pasta dish, casserole, hearty soup or main-course salad counts, even when the cook would add a simple side. Answer no for snacks, dips, appetizers, finger foods, small bites, side dishes and side salads.',
  ),
  Side: noul('Is this dish served alongside a main meal (e.g. roasted or mashed vegetables, potatoes, rice, bread, side salads, grain or vegetable salads without a protein main)? Answer no for a protein main such as fish, chicken or meat.'),
  Snack: noul('Is this small/light and NOT a main meal or a side dish: dips with carriers, wings, sliders, bliss balls, cookies, sweet loaves and muffins, finger foods, party bites, or a small plated starter such as carpaccio? Answer no for salads, vegetable or potato sides, and main dishes.'),
  Salad: noul('Is this clearly a salad-based dish?'),
  Asian: noul('Does this recipe clearly belong to an East or Southeast Asian cuisine or its takeaway adaptations (Chinese, Japanese, Korean, Thai, Vietnamese, Malaysian), including rice or noodle bowls built on soy sauce, sesame, ginger, or peanut sauce? Exclude Indian, which has its own tag.'),
  Mexican: noul('Does this recipe clearly belong to Mexican or Tex-Mex cuisine?'),
  Mediterranean: noul('Does this recipe clearly belong to Greek, Levantine, Middle Eastern, North African, Spanish or Provençal cuisine? Do not use for Italian pasta dishes.'),
  Italian: noul('Does this recipe clearly belong to Italian or Italian-American cuisine (pasta with Italian sauces, pesto, risotto, gnocchi, bolognese, parmigiana, carpaccio)?'),
  Indian: noul('Does this recipe clearly belong to Indian cuisine?'),
  Healthy: noul(
    'Do MOST of these apply: whole minimally processed ingredients (whole grains, fresh produce, lean proteins, legumes); added sugar <~10g/serving, saturated fat <~5g/serving, no trans fats, sodium <~600mg/serving; contains a fibre source (veg, legumes, whole grains, fruit); cooked by baking/roasting/steaming/grilling/light sautéing (not deep- or heavily pan-fried); vegetables are a substantial share of the dish?',
  ),
  Vegetarian: noul(
    'Is this lacto-ovo vegetarian: NO meat, poultry, fish, or seafood (including shellfish, fish sauce, shrimp paste, anchovies, or any aquatic animal)? Dairy and eggs are permitted. If the recipe offers vegetable broth or chicken broth as alternatives, answer by the first-listed option.',
  ),
  Kid_Friendly: noul(
    'Would a typical child aged 4–12 choose and enjoy this dish as written? Answer yes for familiar mild favourites: pasta bakes and mild pasta with meat or cheese sauce, pizza-style dishes, mild breaded or baked chicken, cheesy or potato dishes, meatballs, mild tacos, sweet baked goods, and fruit smoothies. Answer no if the dish has chili heat, any alcohol even if cooked off, coffee, raw onion or garlic, or pungent ingredients (blue cheese, anchovies, olives, capers, fish sauce, strong curry paste); if fish or seafood is the main ingredient; or if it is mostly vegetables other than carrots, corn, peas, cucumber, cherry tomatoes, sweet peppers, broccoli or sweet potato.',
  ),
};

export const REMINDER_QUESTIONS: Record<string, DecisionQuestion> = {
  needsDefrost: noul(
    'Is the recipe\'s main protein RAW meat, poultry or seafood of a kind typically bought or kept frozen and needing several hours to defrost: chicken breast/thigh/tenders/whole, turkey, ground/minced meat or raw sausage meat, beef cuts (steak, fillet, stewing, roasts), pork chops/roasts/loins/ribs/belly, lamb cuts and offal, large fish fillets (salmon, cod, white fish), scallops, prawns/shrimp? Answer NO when the recipe starts from already-cooked protein (rotisserie, leftover, or pre-cooked shredded chicken or turkey), and NO for deli ham, sliced cured meats, bacon, smoked salmon, canned tuna/fish, eggs, tofu, paneer, halloumi, and vegetarian/vegan dishes.',
  ),
  needsMarinate: noul(
    'Do the instructions call for an ingredient to sit in a marinade, brine, pickle or soaking liquid for 30 minutes or more before cooking or serving, in a way that must be started ahead: either explicitly refrigerated, or for 2 hours or more / overnight even if the fridge is not mentioned? Answer NO for quick 5–15 minute marinades, "marinate while you prep" with no duration, resting at room temperature, tenderising with no liquid, dry rubs, chilling a dough, soaking noodles or dried mushrooms for a few minutes, and make-ahead storage notes.',
  ),
};

/**
 * Per-question cut-offs, chosen on the tuning half of the evaluation set.
 * The model's probabilities for the healthy restraint gates sit high even for
 * rich dishes, so those gates need a stricter cut-off than the roles do.
 */
export const DECISION_THRESHOLDS: Record<'taxonomy' | 'tags' | 'reminders', DecisionThresholds> = {
  taxonomy: {
    default: 0.5,
    mealType_role_side: 0.4,
    healthy_nutrientDenseAnchor: 0.65,
    healthy_sensibleFatAndMethod: 0.78,
    healthy_refinedStarchRestrained: 0.78,
    healthy_richnessRestrained: 0.78,
  },
  tags: { default: 0.5, Side: 0.4, Healthy: 0.77 },
  reminders: { default: 0.5 },
};

function ingredientText(ingredient: CompleteCanonicalRecipeV2['content']['ingredients'][number]): string {
  return [ingredient.quantity, ingredient.unit, ingredient.name, ingredient.notes]
    .filter((value) => value !== undefined && value !== null && String(value).trim())
    .map((value) => String(value).trim())
    .join(' ');
}

/** Same recipe view as buildTaxonomyV2Prompt, without the instructions block. */
export function buildTaxonomyDecisionInput(content: CompleteCanonicalRecipeV2['content']): string {
  return `Recipe:\n${JSON.stringify({
    title: String(content.title ?? '').trim().slice(0, 300),
    description: String(content.description ?? '').trim().slice(0, 1_000),
    originalServings: content.originalServings,
    ingredients: (content.ingredients ?? []).map(ingredientText),
    instructions: (content.instructions ?? []).map(({ text }) => String(text ?? '').trim()).filter(Boolean).join(' ').slice(0, 4_000),
    nutrition: content.nutrition ?? {},
  })}`;
}

export function buildTagDecisionInput(recipe: { title: string; ingredients: string[]; steps: string[] }): string {
  return `Recipe:\n${JSON.stringify({ title: recipe.title, ingredients: recipe.ingredients, steps: recipe.steps })}`;
}

export const buildReminderDecisionInput = buildTagDecisionInput;

function probability(answers: DecisionAnswers, key: string): number {
  const answer = answers[key];
  if (!answer || answer.type !== 'noul' || typeof answer.noul !== 'number' || !Number.isFinite(answer.noul)) {
    throw new Error(`Missing decision for ${key}`);
  }
  return answer.noul;
}

const passes = (answers: DecisionAnswers, thresholds: DecisionThresholds) =>
  (key: string) => probability(answers, key) >= (thresholds[key] ?? thresholds.default);

/** Combines the taxonomy answers into the evidence shape deriveTaxonomyV2 already consumes. */
export function composeTaxonomyEvidence(
  answers: DecisionAnswers,
  thresholds: DecisionThresholds = DECISION_THRESHOLDS.taxonomy,
): TaxonomyV2Evidence {
  const yes = passes(answers, thresholds);
  const modeAnswer = answers.mealType_mode;
  if (!modeAnswer || modeAnswer.type !== 'choice') throw new Error('Missing decision for mealType_mode');
  const mode = modeAnswer.choice === 'component' ? 'component' : 'dish';
  let componentKind: typeof COMPONENT_KINDS[number] = 'none';
  if (mode === 'component') {
    const kind = answers.mealType_componentKind;
    const ranked = kind && kind.type === 'choice'
      ? Object.entries(kind.probabilities ?? {})
        .filter(([key]) => key !== 'none' && (COMPONENT_KINDS as readonly string[]).includes(key))
        .sort((left, right) => right[1] - left[1])
      : [];
    componentKind = (ranked[0]?.[0] as typeof COMPONENT_KINDS[number]) ?? 'other-non-meal';
  }
  const roles = Object.fromEntries(
    DISH_MEAL_TYPES.map((role) => [role, mode === 'dish' && yes(`mealType_role_${role}`)]),
  ) as Record<typeof DISH_MEAL_TYPES[number], boolean>;
  if (mode === 'dish' && !DISH_MEAL_TYPES.some((role) => roles[role])) {
    // No role cleared its cut-off. Take the most probable one, but a near-tie
    // between lunch and dinner resolves to dinner: an unaccompanied main is a
    // dinner main far more often than a lunch-only dish.
    const p = (role: string) => probability(answers, `mealType_role_${role}`);
    let best = [...DISH_MEAL_TYPES].sort((left, right) => p(right) - p(left))[0];
    if (best === 'lunch' && p('dinner') >= p('lunch') - 0.15) best = 'dinner';
    roles[best] = true;
  }
  if (roles.dessert) {
    // Dessert combines only with breakfast and snack (taxonomy combination rule).
    roles.lunch = false;
    roles.dinner = false;
    roles.side = false;
  }

  const sugar = yes('healthy_addedSugarRestrained');
  const starch = yes('healthy_refinedStarchRestrained');
  const richness = yes('healthy_richnessRestrained');
  const reason = `${DECISION_MODEL} ${DECISION_QUESTION_SET}`;
  return {
    mealType: { mode, roles, componentKind, confidence: 'medium', reason },
    kidFriendly: {
      standaloneOrRecognizable: yes('kid_standaloneOrRecognizable'),
      coreIngredientsAccessible: yes('kid_coreIngredientsAccessible'),
      broadChildAppeal: yes('kid_broadChildAppeal'),
      mildOrAdjustable: yes('kid_mildOrAdjustable'),
      easyToEat: yes('kid_easyToEat'),
      familyPractical: yes('kid_familyPractical'),
      blocker: mode === 'component' ? 'component-only'
        : yes('kid_block_heat') ? 'integral-extreme-heat'
        : yes('kid_block_alcohol') ? 'alcohol-forward'
        : yes('kid_block_bones') ? 'awkward-bones-or-shells'
        : yes('kid_block_acquired') ? 'central-specialty-or-acquired'
        : 'none',
      adjustment: null,
      confidence: 'medium',
      reason,
    },
    healthy: {
      nutrientDenseAnchor: yes('healthy_nutrientDenseAnchor'),
      meaningfulPlantsOrWholeFoods: yes('healthy_meaningfulPlantsOrWholeFoods'),
      suitableLeanOrPlantProtein: yes('healthy_suitableLeanOrPlantProtein'),
      minimallyProcessed: yes('healthy_minimallyProcessed'),
      sensibleFatAndMethod: yes('healthy_sensibleFatAndMethod'),
      limitedSugarRefinedStarchRichness: sugar && starch && richness,
      clearlyHealthierVersion: yes('healthy_clearlyHealthierVersion'),
      blocker: yes('healthy_block_fried') ? 'deep-fried-or-battered'
        : yes('healthy_block_processedMeat') ? 'processed-meat-dominant'
        : !sugar ? 'excess-added-sugar'
        : !richness ? 'richness-dominant'
        : !starch ? 'refined-starch-dominant'
        : 'none',
      confidence: 'medium',
      reason,
    },
  };
}

export function composeTags(
  answers: DecisionAnswers,
  thresholds: DecisionThresholds = DECISION_THRESHOLDS.tags,
): string[] {
  const yes = passes(answers, thresholds);
  const keys = Object.keys(TAG_QUESTIONS);
  const active = new Set(keys.filter(yes));
  const p = (key: string) => probability(answers, key);
  // Course exclusions from buildTagRecipesPrompt: Snack never with Lunch/Dinner,
  // Breakfast never with Lunch/Dinner. Keep the more probable side.
  for (const lone of ['Snack', 'Breakfast']) {
    if (!active.has(lone) || !(active.has('Dinner') || active.has('Lunch'))) continue;
    const meal = Math.max(active.has('Dinner') ? p('Dinner') : 0, active.has('Lunch') ? p('Lunch') : 0);
    if (p(lone) >= meal) {
      active.delete('Dinner');
      active.delete('Lunch');
    } else {
      active.delete(lone);
    }
  }
  return keys.filter((key) => active.has(key)).map((key) => (key === 'Kid_Friendly' ? 'Kid Friendly' : key));
}

export function composeReminders(
  answers: DecisionAnswers,
  thresholds: DecisionThresholds = DECISION_THRESHOLDS.reminders,
): { needsDefrost: boolean; needsMarinate: boolean } {
  const yes = passes(answers, thresholds);
  return { needsDefrost: yes('needsDefrost'), needsMarinate: yes('needsMarinate') };
}

export class DecisionProviderError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'DecisionProviderError';
  }
}

export interface DecisionUsage { inputTokens: number }

const RETRYABLE = new Set([429, 500, 502, 503, 504, 529]);

/** One Decisions API call. Retries transient failures with backoff; never logs the key or the input. */
export async function requestDecisions(options: {
  apiKey: string;
  input: string;
  questions: Record<string, DecisionQuestion>;
  timeoutMs?: number;
  attempts?: number;
  fetchImpl?: typeof fetch;
  onUsage?: (usage: DecisionUsage) => void;
  sleep?: (ms: number) => Promise<void>;
}): Promise<DecisionAnswers> {
  const { apiKey, input, questions, timeoutMs = 30_000, attempts = 3, fetchImpl = fetch } = options;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  if (apiKey.trim().length === 0) throw new DecisionProviderError('provider-secret-missing');
  let failure = 'provider-network';
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250));
    let response: Response;
    try {
      response = await fetchImpl(DECISION_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({ model: DECISION_MODEL, input, questions }),
      });
    } catch {
      failure = 'provider-network';
      continue;
    }
    if (!response.ok) {
      failure = `provider-http-${response.status}`;
      if (RETRYABLE.has(response.status)) continue;
      throw new DecisionProviderError(failure);
    }
    let body: { answers?: DecisionAnswers; usage?: { total_input_tokens?: number } };
    try {
      body = await response.json() as typeof body;
    } catch {
      throw new DecisionProviderError('provider-invalid-response');
    }
    if (!body.answers || typeof body.answers !== 'object') throw new DecisionProviderError('provider-invalid-response');
    if (Object.keys(questions).some((key) => !body.answers![key])) throw new DecisionProviderError('provider-missing-answer');
    options.onUsage?.({ inputTokens: body.usage?.total_input_tokens ?? 0 });
    return body.answers;
  }
  throw new DecisionProviderError(failure);
}

/** Runs `task` over `items` with at most `lanes` in flight, preserving order. */
export async function mapInParallel<T, R>(items: readonly T[], lanes: number, task: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function lane(): Promise<void> {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(lanes, items.length)) }, lane));
  return results;
}
