import { SecretManagerServiceClient } from '@google-cloud/secret-manager';

const SECRET_ID = 'mealwizard-gemini-api-key';
const DEFAULT_PROJECT_ID = 'meal-wizard-ad202';
const DEFAULT_TAGGING_MODEL = 'gemini-3.1-flash-lite';
const DEFAULT_SHOPPING_MODEL = 'gemini-3.8-flash';
const MAX_TAG_BATCH_SIZE = 25;
const GEMINI_API_BASE =
  'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_TIMEOUT_MS = 45_000;

const ALLOWED_TAGS = new Set([
  'Breakfast',
  'Lunch',
  'Dinner',
  'Side',
  'Snack',
  'Salad',
  'Asian',
  'Mexican',
  'Mediterranean',
  'Italian',
  'Indian',
  'Healthy',
  'Vegetarian',
  'Kid Friendly',
]);
const SHOPPING_CATEGORY_VALUES = [
  'Produce',
  'Meat & Seafood',
  'Dairy & Eggs',
  'Pantry & Dry Goods',
  'Herbs & Spices',
  'Oils, Sauces & Condiments',
  'Bread & Bakery',
  'Frozen',
  'Other',
] as const;
const SHOPPING_CATEGORIES = new Set<string>(SHOPPING_CATEGORY_VALUES);
type ShoppingCategory = typeof SHOPPING_CATEGORY_VALUES[number];

export interface TagRecipeInput {
  recipeId: string;
  title: string;
  totalMinutes: number | null;
  ingredients: string[];
  steps: string[];
  existingTags: string[];
}

export interface ShoppingIngredientInput {
  id: number;
  name: string;
  quantity: number;
  unit: string;
}

export interface ShoppingGroup {
  canonicalName: string;
  category: ShoppingCategory;
  sourceIds: number[];
  unit?: string;
}

interface ProviderRequest {
  apiKey: string;
  model: string;
  prompt: string;
  maxOutputTokens: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface GeminiAdminDependencies {
  projectId: string;
  accessSecretVersion: (
    name: string,
  ) => Promise<string | Uint8Array | undefined>;
  requestJson: (request: ProviderRequest) => Promise<unknown>;
}

export interface GeminiAdminAdapter {
  tagRecipes(
    recipes: TagRecipeInput[],
    model?: string,
  ): Promise<Map<string, string[]>>;
  getShoppingGroups(
    ingredients: ShoppingIngredientInput[],
    model?: string,
  ): Promise<ShoppingGroup[]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function isBoundedTrimmedString(
  value: unknown,
  maximum: number,
  allowEmpty = false,
): value is string {
  return typeof value === 'string'
    && value === value.trim()
    && value.length <= maximum
    && (allowEmpty || value.length > 0);
}

function hasExactCoverage<T extends string | number>(
  expected: readonly T[],
  actual: readonly T[],
): boolean {
  if (expected.length !== actual.length) return false;
  if (new Set(expected).size !== expected.length) return false;
  if (new Set(actual).size !== actual.length) return false;
  const actualSet = new Set(actual);
  return expected.every((identifier) => actualSet.has(identifier));
}

function parseTaggingResponse(
  raw: unknown,
  expectedIds: string[],
): Array<{ id: string; tags: string[] }> {
  if (!isRecord(raw) || !hasOnlyKeys(raw, ['results']) || !Array.isArray(raw.results)) {
    throw new Error('Gemini tagging response failed validation');
  }
  if (raw.results.length > MAX_TAG_BATCH_SIZE) {
    throw new Error('Gemini tagging response failed validation');
  }
  const results: Array<{ id: string; tags: string[] }> = [];
  for (const value of raw.results) {
    if (
      !isRecord(value)
      || !hasOnlyKeys(value, ['id', 'tags'])
      || !isBoundedTrimmedString(value.id, 160)
      || !Array.isArray(value.tags)
      || value.tags.length > 14
      || !value.tags.every((tag) => typeof tag === 'string' && ALLOWED_TAGS.has(tag))
    ) {
      throw new Error('Gemini tagging response failed validation');
    }
    results.push({ id: value.id, tags: [...value.tags] as string[] });
  }
  if (!hasExactCoverage(expectedIds, results.map(({ id }) => id))) {
    throw new Error('Gemini tagging response failed validation');
  }
  return results;
}

function parseShoppingResponse(
  raw: unknown,
  expectedIds: number[],
): ShoppingGroup[] {
  if (!Array.isArray(raw) || raw.length > 500) {
    throw new Error('Gemini shopping response failed validation');
  }
  const groups: ShoppingGroup[] = [];
  for (const value of raw) {
    if (
      !isRecord(value)
      || !hasOnlyKeys(value, ['canonicalName', 'category', 'sourceIds', 'unit'])
      || !isBoundedTrimmedString(value.canonicalName, 120)
      || typeof value.category !== 'string'
      || !SHOPPING_CATEGORIES.has(value.category)
      || !Array.isArray(value.sourceIds)
      || value.sourceIds.length < 1
      || value.sourceIds.length > 500
      || !value.sourceIds.every(
        (id) => Number.isInteger(id) && Number(id) >= 0 && Number(id) <= 9_999,
      )
      || (
        value.unit !== undefined
        && !isBoundedTrimmedString(value.unit, 40, true)
      )
    ) {
      throw new Error('Gemini shopping response failed validation');
    }
    groups.push({
      canonicalName: value.canonicalName,
      category: value.category as ShoppingCategory,
      sourceIds: [...value.sourceIds] as number[],
      ...(typeof value.unit === 'string' ? { unit: value.unit } : {}),
    });
  }
  if (!hasExactCoverage(expectedIds, groups.flatMap(({ sourceIds }) => sourceIds))) {
    throw new Error('Gemini shopping response failed validation');
  }
  return groups;
}

function buildTagRecipesPrompt(recipes: TagRecipeInput[]): string {
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

function buildShoppingGroupsPrompt(
  ingredients: ShoppingIngredientInput[],
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
8. For groups whose natural shopping unit is a count (e.g. "chicken thighs", "eggs", "onions", "lemons"), set the "unit" field to the plural noun used when counting that item at the supermarket. A count-style group should always have a non-empty unit. Only leave unit as "" when the item is measured by weight or volume.

Return ONLY a valid JSON array — no markdown, no explanation:
[{"canonicalName": "...", "category": "...", "sourceIds": [0, 4, 7], "unit": ""}, ...]

Input:
${JSON.stringify(ingredients)}`;
}

export async function requestOperatorGeminiJson({
  apiKey,
  model,
  prompt,
  maxOutputTokens,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
}: ProviderRequest): Promise<unknown> {
  if (apiKey.trim().length === 0) throw new Error('provider-secret-missing');
  const signal = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(
      `${GEMINI_API_BASE}/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        signal,
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            ...(model === 'gemini-3.8-flash' ? {} : { temperature: 0 }),
            maxOutputTokens,
            responseMimeType: 'application/json',
          },
        }),
      },
    );
  } catch (error) {
    const errorName = error instanceof Error ? error.name : undefined;
    const isTimeout = signal.aborted
      || errorName === 'AbortError'
      || errorName === 'TimeoutError';
    throw new Error(isTimeout ? 'provider-timeout' : 'provider-network');
  }
  if (!response.ok) throw new Error(`provider-http-${response.status}`);

  let envelope: unknown;
  try {
    envelope = await response.json();
  } catch {
    throw new Error('provider-invalid-response');
  }
  if (!isRecord(envelope) || !Array.isArray(envelope.candidates)) {
    throw new Error('provider-invalid-response');
  }
  const candidate = envelope.candidates[0];
  if (!isRecord(candidate)) throw new Error('provider-empty-response');
  if (candidate.finishReason === 'MAX_TOKENS') throw new Error('provider-max-tokens');
  if (!isRecord(candidate.content) || !Array.isArray(candidate.content.parts)) {
    throw new Error('provider-empty-response');
  }
  const text = candidate.content.parts.find(
    (part) => isRecord(part) && typeof part.text === 'string',
  )?.text;
  if (typeof text !== 'string') throw new Error('provider-empty-response');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('provider-invalid-json');
  }
}

export function createGeminiAdminAdapter(
  dependencies: GeminiAdminDependencies,
): GeminiAdminAdapter {
  let cachedKey: string | null = null;

  async function getGeminiKey(): Promise<string> {
    if (cachedKey) return cachedKey;
    const name =
      `projects/${dependencies.projectId}/secrets/${SECRET_ID}/versions/latest`;
    const payload = await dependencies.accessSecretVersion(name);
    const value = typeof payload === 'string'
      ? payload.trim()
      : Buffer.from(payload ?? []).toString('utf8').trim();
    if (!value) throw new Error('Gemini secret version is empty');
    cachedKey = value;
    return value;
  }

  return {
    async tagRecipes(
      recipes: TagRecipeInput[],
      model = DEFAULT_TAGGING_MODEL,
    ): Promise<Map<string, string[]>> {
      const tagsById = new Map<string, string[]>();
      if (recipes.length === 0) return tagsById;
      const apiKey = await getGeminiKey();
      for (let offset = 0; offset < recipes.length; offset += MAX_TAG_BATCH_SIZE) {
        const batch = recipes.slice(offset, offset + MAX_TAG_BATCH_SIZE);
        const raw = await dependencies.requestJson({
          apiKey,
          model,
          prompt: buildTagRecipesPrompt(batch),
          maxOutputTokens: Math.min(32_000, 4_096 + batch.length * 400),
        });
        const parsed = parseTaggingResponse(
          raw,
          batch.map(({ recipeId }) => recipeId),
        );
        for (const entry of parsed) tagsById.set(entry.id, entry.tags);
      }
      return tagsById;
    },

    async getShoppingGroups(
      ingredients: ShoppingIngredientInput[],
      model = DEFAULT_SHOPPING_MODEL,
    ): Promise<ShoppingGroup[]> {
      if (ingredients.length === 0) return [];
      const raw = await dependencies.requestJson({
        apiKey: await getGeminiKey(),
        model,
        prompt: buildShoppingGroupsPrompt(ingredients),
        maxOutputTokens: Math.min(65_536, 4_096 + ingredients.length * 200),
      });
      return parseShoppingResponse(raw, ingredients.map(({ id }) => id));
    },
  };
}

let defaultAdapter: GeminiAdminAdapter | null = null;

function getDefaultAdapter(): GeminiAdminAdapter {
  if (defaultAdapter) return defaultAdapter;
  const secretClient = new SecretManagerServiceClient();
  defaultAdapter = createGeminiAdminAdapter({
    projectId: process.env.GOOGLE_CLOUD_PROJECT
      ?? process.env.GCLOUD_PROJECT
      ?? DEFAULT_PROJECT_ID,
    accessSecretVersion: async (name) => {
      const [version] = await secretClient.accessSecretVersion({ name });
      const data = version.payload?.data;
      return data == null ? undefined : Buffer.from(data);
    },
    requestJson: requestOperatorGeminiJson,
  });
  return defaultAdapter;
}

export async function tagRecipesWithAdminGemini(
  recipes: TagRecipeInput[],
  model?: string,
): Promise<Map<string, string[]>> {
  return getDefaultAdapter().tagRecipes(recipes, model);
}

export async function getAdminShoppingGroups(
  ingredients: ShoppingIngredientInput[],
  model?: string,
): Promise<ShoppingGroup[]> {
  return getDefaultAdapter().getShoppingGroups(ingredients, model);
}
