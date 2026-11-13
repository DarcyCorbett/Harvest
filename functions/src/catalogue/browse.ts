import { createHash } from "node:crypto";
import {
  FieldPath,
  getFirestore,
  type Firestore,
} from "firebase-admin/firestore";
import { HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import { z } from "zod";
import { authorizeHouseholdMember } from "../authz.js";
import {
  CUISINES,
  MEAL_TYPES,
  normalizeIngredientTokens,
  type CanonicalNutrition,
} from "./domain.js";
import { SOURCE_CONFIGS } from "./sourceAdapters.js";

export const browseSchema = z
  .object({
    householdId: z.string().min(1).max(128).regex(/^[^/]+$/),
    ingredient: z.string().trim().max(120).default(""),
    mealType: z.enum(MEAL_TYPES),
    cuisine: z.enum(CUISINES).optional(),
    pageSize: z.number().int().min(1).max(20).default(20),
    cursor: z.string().max(2000).optional(),
  })
  .strict();
export type BrowseRequest = z.input<typeof browseSchema>;
export interface RecipeSummary {
  id: string;
  title: string;
  imageUrl?: string;
  totalMinutes?: number;
  nutrition?: CanonicalNutrition;
}
export interface BrowseResponse {
  recipes: RecipeSummary[];
  nextCursor?: string;
}
const cursorSchema = z
  .object({
    scope: z.string(),
    source: z.number().int().min(0),
    key: z.number().finite().optional(),
    id: z
      .string()
      .max(160)
      .regex(/^[^/]+$/)
      .optional(),
  })
  .strict();

export function matchesBrowse(
  data: {
    effective?: { mealTypes?: string[]; cuisines?: string[] };
    search?: { ingredientTokens?: string[] };
  },
  type: string,
  cuisine: string | undefined,
  must: string[],
  exclude: string[],
) {
  const tokens = data.search?.ingredientTokens ?? [];
  return (
    !!data.effective?.mealTypes?.includes(type) &&
    (!cuisine || !!data.effective?.cuisines?.includes(cuisine)) &&
    must.every((t) => tokens.includes(t)) &&
    !exclude.some((t) => tokens.includes(t))
  );
}

/** At most three 40-document pages per request; the cursor advances even on an empty result page. */
export async function browseCatalogue(
  input: BrowseRequest,
  db: Firestore = getFirestore(),
): Promise<BrowseResponse> {
  const request = browseSchema.parse(input);
  const settings =
    (
      await db
        .collection("households")
        .doc(request.householdId)
        .collection("settings")
        .doc("preferences")
        .get()
    ).data() ?? {};
  const sources = SOURCE_CONFIGS.filter(
    (s) =>
      (settings.sourceWeights?.[s.host.replace(/\./g, "_")] ??
        settings.sourceWeights?.[s.host] ??
        1) > 0,
  ).map((s) => s.sourceKey);
  const must = normalizeIngredientTokens(
    request.ingredient ? [request.ingredient] : [],
  );
  const exclude = normalizeIngredientTokens(
    Array.isArray(settings.excludedIngredients)
      ? settings.excludedIngredients
      : [],
  );
  const scope = createHash("sha256")
    .update(
      JSON.stringify([
        request.householdId,
        request.mealType,
        request.cuisine,
        must,
        exclude,
        sources,
      ]),
    )
    .digest("hex");
  let cursor: z.infer<typeof cursorSchema> = { scope, source: 0 };
  if (request.cursor) {
    try {
      cursor = cursorSchema.parse(
        JSON.parse(Buffer.from(request.cursor, "base64url").toString("utf8")),
      );
    } catch {
      throw new HttpsError(
        "invalid-argument",
        "Invalid browsing cursor. Start a new search.",
      );
    }
    if (
      cursor.scope !== scope ||
      cursor.source > sources.length ||
      (cursor.key === undefined) !== (cursor.id === undefined)
    )
      throw new HttpsError(
        "failed-precondition",
        "Filters or household preferences changed. Start a new search.",
      );
  }
  const recipes: RecipeSummary[] = [];
  for (
    let page = 0;
    page < 3 &&
    cursor.source < sources.length &&
    recipes.length < request.pageSize;
    page++
  ) {
    let query = db
      .collection("recipes")
      .where("schemaVersion", "==", 2)
      .where("status", "==", "ready")
      .where("source.key", "==", sources[cursor.source]);
    query = must.length
      ? query.where("search.ingredientTokens", "array-contains", must[0])
      : query.where(
          "search.selectionKeys",
          "array-contains",
          `${request.mealType}|${request.cuisine ?? "any"}`,
        );
    query = query
      .orderBy("search.randomKey")
      .orderBy(FieldPath.documentId())
      .limit(40)
      .select(
        "content.title",
        "content.imageUrl",
        "content.nutrition",
        "effective.mealTypes",
        "effective.cuisines",
        "effective.totalMinutes",
        "search.ingredientTokens",
        "search.randomKey",
      );
    if (cursor.id !== undefined)
      query = query.startAfter(cursor.key, cursor.id);
    const snapshot = await query.get();
    let examined = 0;
    for (const document of snapshot.docs) {
      examined++;
      const data = document.data();
      cursor = { ...cursor, key: data.search.randomKey, id: document.id };
      if (
        typeof data.content?.title === "string" &&
        matchesBrowse(data, request.mealType, request.cuisine, must, exclude)
      ) {
        recipes.push({
          id: document.id,
          title: data.content.title,
          ...(data.content.imageUrl ? { imageUrl: data.content.imageUrl } : {}),
          ...(typeof data.effective.totalMinutes === "number"
            ? { totalMinutes: data.effective.totalMinutes }
            : {}),
          ...(data.content.nutrition
            ? { nutrition: data.content.nutrition }
            : {}),
        });
      }
      if (recipes.length === request.pageSize) break;
    }
    if (examined === snapshot.size && snapshot.size < 40)
      cursor = { scope, source: cursor.source + 1 };
  }
  return {
    recipes,
    ...(cursor.source < sources.length
      ? {
          nextCursor: Buffer.from(JSON.stringify(cursor)).toString("base64url"),
        }
      : {}),
  };
}
export async function browseCatalogueHandler(
  request: CallableRequest<unknown>,
) {
  const parsed = browseSchema.safeParse(request.data);
  if (!parsed.success)
    throw new HttpsError("invalid-argument", "Choose valid catalogue filters.");
  await authorizeHouseholdMember(request.auth, parsed.data.householdId);
  return browseCatalogue(parsed.data);
}
