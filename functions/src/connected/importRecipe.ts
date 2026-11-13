import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import { z } from "zod";
import { authorizeHouseholdMember } from "../authz.js";
import { SOURCE_CONFIGS } from "../catalogue/sourceAdapters.js";
import {
  canonicalizeRecipeUrl,
  canonicalRecipeId,
} from "../catalogue/domain.js";
import { parseCatalogueRecipe } from "../catalogue/parser.js";
const schema = z
  .object({
    householdId: z.string().min(1).max(128),
    url: z.string().url().max(2048),
  })
  .strict();
export function trustedImportUrl(value: string): string {
  const url = new URL(value);
  const host = url.hostname.replace(/^www\./, "").toLowerCase();
  const trusted = [
    ...SOURCE_CONFIGS.map((s) => s.host.replace(/^www\./, "")),
    "seriouseats.com",
    "akispetretzikis.com",
    "omnivorescookbook.com",
  ];
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    !trusted.includes(host)
  )
    throw new HttpsError(
      "invalid-argument",
      "Choose an HTTPS recipe link from a supported trusted source.",
    );
  return canonicalizeRecipeUrl(url.toString());
}
export async function importConnectedRecipe(request: CallableRequest<unknown>) {
  const parsed = schema.safeParse(request.data);
  if (!parsed.success)
    throw new HttpsError("invalid-argument", "Enter a valid recipe URL.");
  await authorizeHouseholdMember(request.auth, parsed.data.householdId);
  const db = getFirestore();
  let url = trustedImportUrl(parsed.data.url);
  const cached = await db
    .collection("recipes")
    .where("source.canonicalUrl", "==", url)
    .limit(1)
    .get();
  if (!cached.empty) return { recipeId: cached.docs[0].id };
  const legacy = await db
    .collection("recipes")
    .where("sourceUrl", "==", url)
    .limit(1)
    .get();
  if (!legacy.empty) return { recipeId: legacy.docs[0].id };
  const usage = db.doc(
    `households/${parsed.data.householdId}/importUsage/${new Date().toISOString().slice(0, 10)}`,
  );
  await db.runTransaction(async (tx) => {
    const previous = await tx.get(usage);
    const count = Number(previous.get("count") ?? 0);
    if (count >= 30)
      throw new HttpsError(
        "resource-exhausted",
        "The household import limit for today has been reached. Saved recipes remain available.",
      );
    tx.set(usage, {
      count: count + 1,
      expireAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });
  });
  let html = "";
  for (let hop = 0; hop < 5; hop++) {
    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(20000),
      headers: { "User-Agent": "MealWizard/2 recipe import" },
    });
    if (response.status >= 300 && response.status < 400) {
      const target = response.headers.get("location");
      if (!target)
        throw new HttpsError("unavailable", "Recipe redirect is unavailable.");
      url = trustedImportUrl(new URL(target, url).toString());
      continue;
    }
    if (!response.ok)
      throw new HttpsError(
        "unavailable",
        "The source could not be read. Try again later.",
      );
    if (Number(response.headers.get("content-length")) > 5000000)
      throw new HttpsError("resource-exhausted", "Recipe page is too large.");
    if (!response.body)
      throw new HttpsError("unavailable", "Empty recipe page.");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 5000000) {
        await reader.cancel();
        throw new HttpsError("resource-exhausted", "Recipe page is too large.");
      }
      chunks.push(value);
    }
    html = Buffer.concat(chunks).toString("utf8");
    break;
  }
  if (!html) throw new HttpsError("unavailable", "Too many recipe redirects.");
  const { content, sourceMetadata } = parseCatalogueRecipe(html, url);
  const id = canonicalRecipeId(url);
  const ref = db.collection("recipes").doc(id);
  await db.runTransaction(async (tx) => {
    const existing = await tx.get(ref);
    if (existing.exists) return;
    // Import-only records remain outside catalogue selection until normal ingestion classifies them.
    tx.create(ref, {
      ...JSON.parse(
        JSON.stringify({
          ...content,
          title: content.title,
          sourceUrl: url,
          originalServings: content.originalServings,
          ingredients: content.ingredients,
          prepTime: sourceMetadata.prepMinutes
            ? `${sourceMetadata.prepMinutes} min`
            : "",
          cookTime: sourceMetadata.cookMinutes
            ? `${sourceMetadata.cookMinutes} min`
            : "",
          totalTime: sourceMetadata.totalMinutes
            ? `${sourceMetadata.totalMinutes} min`
            : undefined,
          course: sourceMetadata.mealTypes,
          tags: [
            ...(sourceMetadata.cuisines ?? []),
            ...(sourceMetadata.modifiers ?? []),
          ],
          imported: true,
        }),
      ),
      scrapedAt: FieldValue.serverTimestamp(),
    });
  });
  return { recipeId: id };
}
