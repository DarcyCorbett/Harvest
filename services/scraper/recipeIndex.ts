// ============================================================
// Recipe discovery index — runtime layer.
//
// Bridges the offline-built /recipeIndex/{site}/recipes/ pool to the online
// generator. When recipeScraperService.scrapeRecipe selects a site listed in
// INDEXED_SITES (services/scraper/sites.ts), fetchIndexedCandidates does:
//
//   Step 1 — pull a batch of UNTAGGED URLs from Firestore
//   Step 2 — fetch HTML + parseRecipe in parallel
//   Step 3 — batch-tag with Gemini against the project's fixed taxonomy
//   Step 4 — write tags + extracted metadata back to /recipeIndex/
//   Step 5 — filter the just-tagged batch by queryTags
//   Step 6 — fall back to existing tagged pool (array-contains-any)
//   Step 7 — return matching URLs (or empty if site exhausted)
//
// The downstream cache check (getCachedRecipeByUrl) + parseRecipe in
// scrapeRecipe is shared between this indexed path and the JSON-API path.
// In v1 a matched URL gets re-fetched + re-parsed by scrapeRecipe — the
// duplicate fetch is the cost of keeping the data flow simple.
// ============================================================

import {
  collection,
  doc,
  getDocs,
  limit,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from 'firebase/firestore';
import { db } from '../../config/firebase';
import { tagRecipesWithGemini } from '../gemini';
import { fetchRawHtml } from './http';
import { parseRecipe } from './parse';

/** Cap on URLs lazy-tagged per generation call. Bounds latency at ~5–10s. */
const LAZY_TAG_BATCH = 15;
/** Cap on URLs returned from the already-tagged pool fallback. */
const TAGGED_POOL_CAP = 25;
/** Firestore array-contains-any allows up to 10 values. queryTags is 3–5 in practice. */
const FIRESTORE_ARRAY_CONTAINS_ANY_LIMIT = 10;

interface IndexEntry {
  id: string;
  url: string;
}

/**
 * Orchestrates the lazy-tag-then-fallback flow described above.
 * Returns candidate URLs the generator should try (cache check + fetch+parse
 * happen in scrapeRecipe). Returns [] if the site has no untagged URLs and
 * no tagged-pool match — caller should advance to the next site.
 */
export async function fetchIndexedCandidates(
  site: string,
  queryTags: string[],
): Promise<string[]> {
  if (queryTags.length === 0) {
    console.log(`[RecipeIndex] ${site}: no queryTags provided — skipping`);
    return [];
  }

  const recipesCol = collection(db, 'recipeIndex', site, 'recipes');

  // Step 1 — pull a batch of untagged URLs
  const untaggedSnap = await getDocs(
    query(recipesCol, where('geminiTaggedAt', '==', null), limit(LAZY_TAG_BATCH)),
  );
  const untagged: IndexEntry[] = untaggedSnap.docs
    .map((d) => ({ id: d.id, url: (d.data() as { url?: string }).url ?? '' }))
    .filter((d) => d.url);
  console.log(
    `[RecipeIndex] ${site}: pulling ${untagged.length} untagged URL(s) for lazy tagging`,
  );

  // Steps 2–5 — fetch, tag, write back, match-against-batch
  if (untagged.length > 0) {
    const matched = await lazyTagBatch(site, recipesCol, untagged, queryTags);
    if (matched.length > 0) return matched;
  }

  // Step 6 — fall back to the existing tagged pool
  return await queryTaggedPool(site, recipesCol, queryTags);
}

async function lazyTagBatch(
  site: string,
  recipesCol: ReturnType<typeof collection>,
  untagged: IndexEntry[],
  queryTags: string[],
): Promise<string[]> {
  const t0 = Date.now();

  // Step 2 — parallel HTML fetch + parse
  const parsed = await Promise.all(
    untagged.map(async (entry) => {
      try {
        const html = await fetchRawHtml(entry.url);
        const recipe = parseRecipe(html, entry.url);
        return { ...entry, recipe };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(
          `[RecipeIndex] ${site}: HTML fetch/parse failed for ${entry.url} — ${msg}`,
        );
        // Record the error but leave geminiTaggedAt null so it's retried later.
        await updateDoc(doc(recipesCol, entry.id), {
          lastFetchError: msg.slice(0, 200),
        }).catch(() => {});
        return null;
      }
    }),
  );
  const valid = parsed.filter((p): p is NonNullable<typeof p> => p !== null);
  if (valid.length === 0) {
    console.log(`[RecipeIndex] ${site}: 0 recipes parsed cleanly — nothing to tag`);
    return [];
  }

  // Step 3 — single batched Gemini call
  let tagsById = new Map<string, string[]>();
  try {
    tagsById = await tagRecipesWithGemini(
      valid.map((v) => ({ recipeId: v.id, recipe: v.recipe })),
    );
    const tookMs = Date.now() - t0;
    console.log(
      `[RecipeIndex] ${site}: lazy-tagged ${tagsById.size}/${valid.length} recipes in ${tookMs}ms (Gemini batched)`,
    );
    const first = valid[0];
    const sample = tagsById.get(first.id);
    if (sample && sample.length > 0) {
      console.log(
        `[RecipeIndex] ${site}: sample tags for "${first.recipe.title.slice(0, 40)}": [${sample.slice(0, 4).join(', ')}]`,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(
      `[RecipeIndex] ${site}: Gemini error — ${msg}; leaving batch untagged for retry`,
    );
    // Skip Step 4 writes and let the existing pool path try.
    return [];
  }

  // Step 4 — write tags + extracted metadata back. We always write geminiTaggedAt
  // (even when tags === []) so the same URL doesn't get retagged on the next call;
  // re-tagging uniformly empty results would burn Gemini quota for no value.
  const written = await Promise.all(
    valid.map(async (v) => {
      const tags = tagsById.get(v.id) ?? [];
      try {
        await updateDoc(doc(recipesCol, v.id), {
          title: v.recipe.title,
          ingredients: v.recipe.ingredients
            .map((i) => i.name.toLowerCase())
            .filter(Boolean),
          cuisine: v.recipe.cuisine ?? null,
          prepMinutes: parseMinutesField(v.recipe.prepTime),
          totalMinutes: parseMinutesField(v.recipe.totalTime),
          imageUrl: v.recipe.imageUrl ?? null,
          tags,
          geminiTaggedAt: serverTimestamp(),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`[RecipeIndex] ${site}: Firestore write failed for ${v.url} — ${msg}`);
      }
      return { url: v.url, tags };
    }),
  );

  // Step 5 — filter just-tagged batch
  const matched = written.filter((w) => w.tags.some((t) => queryTags.includes(t)));
  if (matched.length > 0) {
    console.log(
      `[RecipeIndex] ${site}: found ${matched.length} match(es) in just-tagged batch — returning`,
    );
    return matched.map((m) => m.url);
  }
  console.log(
    `[RecipeIndex] ${site}: no match in fresh batch; falling back to tagged pool with [${queryTags.join(', ')}]`,
  );
  return [];
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
    `[RecipeIndex] ${site}: exhausted (no untagged + no tagged-pool match) — advancing to next site`,
  );
  return [];
}

/** Convert "30 min", "PT45M", or undefined to a number of minutes (or null). */
function parseMinutesField(s: string | undefined): number | null {
  if (!s) return null;
  // ISO-8601: PT45M, PT1H30M
  const iso = s.match(/^PT(?:(\d+)H)?(?:(\d+)M)?/i);
  if (iso && (iso[1] || iso[2])) {
    const h = parseInt(iso[1] || '0', 10);
    const m = parseInt(iso[2] || '0', 10);
    const total = h * 60 + m;
    return total > 0 ? total : null;
  }
  // "30 min" or "1h 30m"
  const justN = s.match(/(\d+)\s*min/i);
  if (justN) return parseInt(justN[1], 10);
  return null;
}
