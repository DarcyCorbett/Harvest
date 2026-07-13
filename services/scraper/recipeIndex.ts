// ============================================================
// Recipe discovery index — runtime layer.
//
// Bridges the offline-built /recipeIndex/{site}/recipes/ pool to the online
// generator. When recipeScraperService.scrapeRecipe selects a site listed in
// INDEXED_SITES (services/scraper/sites.ts), fetchIndexedCandidates does:
//
//   Step 1 — query the existing tagged pool using array-contains-any
//   Step 2 — return matching URLs (or empty if site exhausted)
//
// The downstream cache check (getCachedRecipeByUrl) + parseRecipe in
// scrapeRecipe is shared between this indexed path and the JSON-API path.
// ============================================================

import {
  collection,
  getDocs,
  limit,
  query,
  where,
} from 'firebase/firestore';
import { db } from '../../config/firebase';

/** Cap on URLs returned from the already-tagged pool fallback. */
const TAGGED_POOL_CAP = 25;
/** Firestore array-contains-any allows up to 10 values. queryTags is 3–5 in practice. */
const FIRESTORE_ARRAY_CONTAINS_ANY_LIMIT = 10;

export async function fetchIndexedCandidates(
  site: string,
  queryTags: string[],
): Promise<string[]> {
  if (queryTags.length === 0) {
    console.log(`[RecipeIndex] ${site}: no queryTags provided — skipping`);
    return [];
  }

  const recipesCol = collection(db, 'recipeIndex', site, 'recipes');
  return await queryTaggedPool(site, recipesCol, queryTags);
}

async function queryTaggedPool(
  site: string,
  recipesCol: ReturnType<typeof collection>,
  queryTags: string[],
): Promise<string[]> {
  const trimmed = queryTags.slice(0, FIRESTORE_ARRAY_CONTAINS_ANY_LIMIT);
  const poolSnap = await getDocs(
    query(
      recipesCol,
      where('tags', 'array-contains-any', trimmed),
      limit(TAGGED_POOL_CAP),
    ),
  );
  const urls = poolSnap.docs
    .map((d) => (d.data() as { url?: string }).url ?? '')
    .filter(Boolean);
  if (urls.length > 0) {
    console.log(`[RecipeIndex] ${site}: tagged pool returned ${urls.length} candidate(s)`);
    return urls;
  }
  console.log(
    `[RecipeIndex] ${site}: exhausted (no tagged-pool match) — advancing to next site`,
  );
  return [];
}
