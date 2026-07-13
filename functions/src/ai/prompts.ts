import type {
  ReminderFlagsInput,
  ShoppingGroupsInput,
  SubstitutionsInput,
  TagRecipesInput,
} from './contracts.js';

export function buildTagRecipesPrompt(
  recipes: TagRecipesInput['recipes'],
): string {
  const input = recipes.map((recipe) => ({
    id: recipe.recipeId,
    title: recipe.title,
    totalMinutes: recipe.totalMinutes,
    ingredients: recipe.ingredients,
    steps: recipe.steps.join(' | '),
    existingTags: recipe.existingTags,
  }));

  return `You are given a list of freshly scraped recipes. Return JSON: { "results": [{ "id": string, "tags": string[] }] }. For each recipe, "tags" contains only tags from the allowed list that clearly apply.

Allowed tags:
- Course: "Breakfast", "Lunch", "Dinner", "Side", "Snack", "Salad"
- Cuisine: "Asian", "Mexican", "Mediterranean", "Italian", "Indian"
- Modifiers: "Healthy", "Vegetarian", "Kid Friendly"

Course rules:
- "Dinner" / "Lunch": substantial main meal only — never for snacks, dips, appetisers, finger foods, or small bites.
- "Snack": small/light, not a main meal (dips, wings, sliders, bliss balls).
- "Side": served alongside a main (roasted veg, rice, bread, side salads).
- "Breakfast": morning meal. "Salad": salad-based dish.
- Never combine: Snack+Dinner, Snack+Lunch (use Snack and/or Side). Never combine Breakfast with Lunch or Dinner (pick primary, or omit if ambiguous).
- Valid combinations: Side+Snack, Side+Salad, Lunch+Dinner, Salad+Lunch.

"Healthy" — tag only if MOST apply:
- Whole, minimally processed ingredients (whole grains, fresh produce, lean proteins, legumes).
- Added sugar <~10g/serving; saturated fat <~5g/serving; no trans fats; sodium <~600mg/serving.
- Contains a fibre source (veg, legumes, whole grains, fruit).
- Cooked by baking/roasting/steaming/grilling/light sautéing — not deep- or heavily pan-fried.
- Vegetables are a substantial share of the dish.

"Kid Friendly" — tag only if MOST apply:
- Mild: no chili heat, minimal black pepper, no raw onion/garlic.
- No pungent ingredients (blue cheese, anchovies, olives, capers, fish sauce, strong curry pastes) unless fully cooked and undetectable.
- Components identifiable and separated, not hidden in stew/casserole.
- Easy to eat: bite-sized or fork-friendly; no tough cuts or long unwieldy noodles.
- Visually approachable: no heavy char, minimal green flecks.
- Veg limited to kid-accepted ones (carrots, corn, peas, cucumber, cherry tomatoes, sweet peppers, broccoli, sweet potato).
- No alcohol, even if cooked off.

"Vegetarian" (lacto-ovo) — tag only if:
- No meat, poultry, fish, or seafood (including shellfish or any aquatic animal).
- Dairy and eggs are permitted.

General rules:
- Only include a tag when confident; omit anything borderline.
- Multiple cuisine tags allowed if the recipe genuinely spans cuisines.
- Do not repeat a tag that already appears in that recipe's existingTags.
- Every input recipe must appear exactly once in "results", preserving its input "id".
- Return only the JSON object — no markdown, no explanation.

Recipes:
${JSON.stringify(input)}`;
}

export function buildReminderFlagsPrompt(
  recipes: ReminderFlagsInput['recipes'],
): string {
  return `You classify recipes for kitchen-prep reminders. Return JSON: { "results": [{ "id": string, "needsDefrost": boolean, "needsMarinate": boolean }] }.

For each recipe:

"needsDefrost" = TRUE only if the recipe's main protein is one typically bought frozen and needing several hours to defrost:
- INCLUDE: chicken breast/thigh/whole, ground/minced meat (beef/pork/lamb/turkey/chicken), beef cuts (steak, mince, stewing), pork chops, lamb cuts, large fish fillets (salmon, cod, snapper), prawns/shrimp.
- EXCLUDE (set FALSE): deli ham, sliced cured meats, bacon strips (small/thin defrost fast), smoked salmon, canned tuna/fish, eggs, tofu, paneer, halloumi, vegetarian/vegan dishes.

"needsMarinate" = TRUE only if the instructions clearly call for ≥30 minutes of REFRIGERATED marinating BEFORE cooking (the protein/veg sits in a marinade in the fridge).
- INCLUDE: "marinate for 30 minutes / overnight / 2 hours in the fridge", "let sit refrigerated in the marinade".
- EXCLUDE (set FALSE): quick 5–15 min marinades, "marinate while you prep" with no duration, "rest at room temperature", "tenderise" with no liquid, dry-rubs that don't sit in the fridge.

Rules:
- When uncertain, choose FALSE. False negatives are better than false positives — reminders should feel earned.
- Every input recipe must appear exactly once in "results", returning its input "recipeId" as "id".
- Return only the JSON object — no markdown, no explanation.

Recipes:
${JSON.stringify(recipes)}`;
}

export function buildShoppingGroupsPrompt(
  ingredients: ShoppingGroupsInput['ingredients'],
): string {
  return `You are given a list of recipe ingredients as JSON. Group them into shopping list items.

Rules:
1. Group ingredients that refer to the same item despite different wording. Use the most natural canonical name (e.g. "garlic", not "minced garlic").
2. Prep-state differences done at home → merge into one group: "minced garlic" + "garlic" → "garlic"; "diced onion" + "onion" → "onion"; "chopped tomato" + "tomato" → "tomato".
3. Different cuts or forms of meat, poultry, and fish → ALWAYS keep as separate groups (they are sold separately): "chicken breast" ≠ "chicken thighs" ≠ "chicken mince"; "beef mince" ≠ "beef steak"; "salmon fillet" ≠ "smoked salmon".
4. "shredded chicken" with no whole-chicken ingredient → treat as "chicken breast". "shredded chicken" where a whole roast chicken ingredient also appears → merge into "whole chicken".
5. Every ingredient id must appear in exactly one group. If uncertain, create a single-item group.
6. Set the "category" field for each group using these rules:
   - Herbs & Spices: fresh/dried herbs, spices, spice blends
   - Oils, Sauces & Condiments: cooking oils, vinegar, soy sauce, fish sauce, oyster sauce, Worcestershire, sriracha, ketchup, mayo, mustard, miso, tahini, hoisin
   - Pantry & Dry Goods: stocks, broths, canned goods, pasta, rice, flour, sugar, honey, baking
   - Produce: fresh fruit and vegetables
   - Meat & Seafood: raw meat, fish, seafood
   - Dairy & Eggs: milk, cream, butter, cheese, yoghurt, eggs
   - Bread & Bakery: bread, wraps, rolls, tortillas
   - Frozen: anything frozen
   - Other: anything else
7. For dry pantry ingredients measured in ml (converted from cups/tbsp), note this in the canonicalName or leave as-is — the quantity conversion will be handled by the caller.
8. For groups whose natural shopping unit is a count (e.g. "chicken thighs", "eggs", "onions", "lemons"), set the "unit" field to the plural noun used when counting that item at the supermarket. Examples: "chicken thighs" → unit "thighs"; "eggs" → unit "eggs"; "onions" → unit "onions"; "lemons" → unit "lemons"; "bananas" → unit "bananas". A count-style group should always have a non-empty unit so the list reads "3 onions" not "3". Only leave unit as "" when the item is measured by weight or volume (e.g. flour, olive oil).

Return ONLY a valid JSON array — no markdown, no explanation:
[{"canonicalName": "...", "category": "...", "sourceIds": [0, 4, 7], "unit": ""}, ...]

Input:
${JSON.stringify(ingredients)}`;
}

export function buildSubstitutionsPrompt(
  input: Omit<SubstitutionsInput, 'householdId'>,
): string {
  return `You are a professional culinary assistant. Suggest exactly 3 suitable ingredient replacements for a specific ingredient in the context of the provided recipe.

Return JSON matching this exact schema — no markdown, no extra fields:
{
  "substitutions": [
    {
      "name": "name of substitute ingredient",
      "adjustment": "quantity or ratio adjustment, e.g. '1:1 ratio' or 'Use 1/2 cup per cup'",
      "reason": "one short sentence explaining why it works in this recipe"
    }
  ]
}

Input:
${JSON.stringify(input)}`;
}
