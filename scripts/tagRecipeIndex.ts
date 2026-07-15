// ============================================================
// Offline Recipe Tagger
//
// Connects to Firestore and tags untagged recipes in the
// /recipeIndex/{site}/recipes/ collection using Gemini Flash-Lite.
//
// Usage:
//   npx tsx scripts/tagRecipeIndex.ts                         # all sites, 500/site
//   npx tsx scripts/tagRecipeIndex.ts --limit 1000            # all sites, 1000/site
//   npx tsx scripts/tagRecipeIndex.ts --site akispetretzikis.com --limit 200
//
// Designed to be called from scripts/run-daily-crawl.ps1 as
// Phase B (after buildRecipeIndex.ts Phase A URL discovery).
// ============================================================

import 'dotenv/config';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { tagRecipesWithAdminGemini } from './lib/geminiAdmin';
import { fetchRawHtml } from '../services/scraper/http';
import { parseRecipe } from '../services/scraper/parse';
import { INDEXED_SITES } from '../services/scraper/sites';
import { fetchWithPlaywright } from '../services/scraper/sitemap';

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Fetch recipe HTML with Playwright fallback for Cloudflare/bot-blocked sites.
 * Tries a plain Node fetch first; on 402/403 falls back to a headless browser.
 */
async function fetchHtmlWithFallback(url: string): Promise<string> {
  try {
    return await fetchRawHtml(url);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('HTTP 402') || msg.includes('HTTP 403')) {
      console.log(`[Tagger] Node fetch blocked (${msg.slice(0, 30)}). Trying Playwright...`);
      return await fetchWithPlaywright(url, DEFAULT_UA);
    }
    throw err;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadAdmin(): Promise<any> {
  try {
    // @ts-ignore - optional dev dependency
    const mod: { default?: unknown } = await import('firebase-admin');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return ((mod as any).default ?? mod) as any;
  } catch {
    console.error('[Tagger] firebase-admin is not installed. Run: npm i -D firebase-admin');
    process.exit(2);
  }
}


/** Match the callable contract's maximum recipe batch. */
const BATCH_SIZE = 25;
const GEMINI_MODEL = 'gemini-3.1-flash-lite';

interface IndexEntry {
  id: string;
  url: string;
}

interface SiteStats {
  tagged: number;
  cached: number;
  failed: number;
  skippedEmpty: number;
  geminiCalls: number;
  durationMs: number;
}

function parseArgs(argv: string[]) {
  const args = { limit: 500, site: null as string | null };
  const limitIdx = argv.indexOf('--limit');
  if (limitIdx >= 0 && argv[limitIdx + 1]) {
    args.limit = parseInt(argv[limitIdx + 1], 10);
  }
  const siteIdx = argv.indexOf('--site');
  if (siteIdx >= 0 && argv[siteIdx + 1]) {
    args.site = argv[siteIdx + 1];
  }
  return args;
}

/** Convert "30 min", "PT45M", or undefined to a number of minutes (or null). */
function parseMinutesField(s: string | undefined): number | null {
  if (!s) return null;
  const iso = s.match(/^PT(?:(\d+)H)?(?:(\d+)M)?/i);
  if (iso && (iso[1] || iso[2])) {
    const h = parseInt(iso[1] || '0', 10);
    const m = parseInt(iso[2] || '0', 10);
    const total = h * 60 + m;
    return total > 0 ? total : null;
  }
  const justN = s.match(/(\d+)\s*min/i);
  if (justN) return parseInt(justN[1], 10);
  return null;
}

async function tagSite(site: string, writeLimit: number, db: FirebaseFirestore.Firestore): Promise<SiteStats> {
  const t0 = Date.now();
  const stats: SiteStats = { tagged: 0, cached: 0, failed: 0, skippedEmpty: 0, geminiCalls: 0, durationMs: 0 };
  const recipesCache = db.collection('recipes');

  console.log(`\n[Tagger] ── ${site} ── (limit: ${writeLimit})`);
  const recipesCol = db.collection('recipeIndex').doc(site).collection('recipes');

  let processedCount = 0;

  while (processedCount < writeLimit) {
    const currentBatchSize = Math.min(BATCH_SIZE, writeLimit - processedCount);

    // Pull untagged URLs
    const untaggedSnap = await recipesCol
      .where('geminiTaggedAt', '==', null)
      .limit(currentBatchSize)
      .get();

    const untagged: IndexEntry[] = untaggedSnap.docs
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((d: any) => ({ id: d.id, url: (d.data() as { url?: string }).url ?? '' }))
      .filter((d: IndexEntry) => d.url);

    if (untagged.length === 0) {
      console.log(`[Tagger] ${site}: No more untagged URLs — site fully tagged.`);
      break;
    }

    console.log(`[Tagger] ${site}: Batch of ${untagged.length} untagged URL(s)`);

    // ── Fetch + parse HTML (with Playwright fallback) ──
    const tFetch = Date.now();
    const parsed = await Promise.all(
      untagged.map(async (entry) => {
        try {
          const html = await fetchHtmlWithFallback(entry.url);
          const recipe = parseRecipe(html, entry.url);

          // Skip Gemini if the recipe is clearly invalid
          if (recipe.ingredients.length === 0 || recipe.instructions.length === 0) {
            throw new Error('No ingredients or instructions found');
          }

          return { ...entry, recipe };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.log(`[Tagger]   ✗ ${entry.url} — ${msg}`);

          // Classify the failure so permanent non-recipe pages don't get
          // retried on every future run.
          //
          // PERMANENT — stamp geminiTaggedAt so the URL exits the untagged queue:
          //   • No JSON-LD / no ingredients / no instructions → collection,
          //     author bio, gear review, or other non-recipe page.
          //   • HTTP 404 → page is gone.
          //
          // TRANSIENT — leave geminiTaggedAt unset so it retries next run:
          //   • HTTP 402/403 → bot-block that Playwright also couldn't bypass.
          //   • Everything else (timeout, DNS, etc.)
          const isPermanent =
            msg.includes('No JSON-LD Recipe found') ||
            msg.includes('No ingredients or instructions') ||
            msg.includes('HTTP 404');

          const update: Record<string, unknown> = { lastFetchError: msg.slice(0, 200) };
          if (isPermanent) {
            update.geminiTaggedAt = new Date();
            update.skipReason = 'non-recipe-page';
            console.log(`[Tagger]   ↳ Marked as permanent skip (won't retry).`);
          }
          await recipesCol.doc(entry.id).update(update).catch(() => {});

          stats.failed++;
          return null;
        }
      })
    );

    const valid = parsed.filter((p): p is NonNullable<typeof p> => p !== null);
    console.log(`[Tagger] ${site}: ${valid.length}/${untagged.length} parsed OK (${Date.now() - tFetch}ms)`);

    if (valid.length > 0) {
      // ── Single batched Gemini call ──
      const tGemini = Date.now();
      let tagsById = new Map<string, string[]>();
      try {
        const aiInput = valid.map(({ id: recipeId, recipe }) => ({
          recipeId,
          title: recipe.title.slice(0, 160),
          totalMinutes: parseMinutesField(recipe.totalTime),
          ingredients: recipe.ingredients
            .slice(0, 100)
            .map((ingredient) => ingredient.name.slice(0, 200)),
          steps: recipe.instructions
            .slice(0, 40)
            .map((step) => step.text.slice(0, 300)),
          existingTags: (recipe.tags ?? []).slice(0, 30),
        }));
        tagsById = await tagRecipesWithAdminGemini(
          aiInput,
          GEMINI_MODEL
        );
        stats.geminiCalls++;
        console.log(`[Tagger] ${site}: Gemini returned tags for ${tagsById.size}/${valid.length} recipes (${Date.now() - tGemini}ms)`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`[Tagger] ${site}: Gemini error — ${msg}; aborting this site.`);
        break;
      }

      // Guard: if Gemini returned tags for less than half the batch,
      // something went wrong. Don't write empty tags that would mark
      // recipes as "tagged" with no useful data.
      if (tagsById.size < valid.length * 0.5) {
        console.log(`[Tagger] ${site}: Gemini only tagged ${tagsById.size}/${valid.length} — skipping write to avoid marking recipes with empty tags.`);
        break;
      }

      // Log a sample of tags for visibility
      let sampleCount = 0;
      for (const v of valid) {
        const tags = tagsById.get(v.id);
        if (tags && tags.length > 0 && sampleCount < 3) {
          console.log(`[Tagger]   ✓ "${v.recipe.title.slice(0, 50)}" → [${tags.join(', ')}]`);
          sampleCount++;
        }
      }

      // ── Write tags + metadata back to Firestore ──
      await Promise.all(
        valid.map(async (v) => {
          const tags = tagsById.get(v.id);
          // Only write if Gemini actually returned a result for this recipe.
          // If it's missing from the map, leave it untagged for retry next run.
          if (tags === undefined) {
            stats.skippedEmpty++;
            return;
          }
          try {
            // 1. Update the index entry with tags + lightweight metadata
            await recipesCol.doc(v.id).update({
              title: v.recipe.title,
              ingredients: v.recipe.ingredients.map((i) => i.name.toLowerCase()).filter(Boolean),
              cuisine: v.recipe.cuisine ?? null,
              prepMinutes: parseMinutesField(v.recipe.prepTime),
              totalMinutes: parseMinutesField(v.recipe.totalTime),
              imageUrl: v.recipe.imageUrl ?? null,
              tags,
              geminiTaggedAt: new Date(),
            });

            // 2. Cache the full recipe in /recipes/ so generation gets
            //    an immediate hit from getCachedRecipeByUrl — no second
            //    web fetch needed.
            const recipeDoc = {
              title: v.recipe.title,
              sourceUrl: v.recipe.sourceUrl,
              imageUrl: v.recipe.imageUrl ?? null,
              videoEmbedUrl: v.recipe.videoEmbedUrl ?? null,
              prepTime: v.recipe.prepTime,
              cookTime: v.recipe.cookTime,
              totalTime: v.recipe.totalTime ?? null,
              originalServings: v.recipe.originalServings,
              course: v.recipe.course ?? [],
              tags,
              description: v.recipe.description ?? null,
              cuisine: v.recipe.cuisine ?? null,
              difficulty: v.recipe.difficulty ?? null,
              ingredients: v.recipe.ingredients,
              ingredientGroups: v.recipe.ingredientGroups ?? [],
              instructions: v.recipe.instructions,
              notes: v.recipe.notes ?? '',
              nutrition: v.recipe.nutrition ?? { calories: 0, protein: 0, carbs: 0, fat: 0 },
              scrapedAt: new Date(),
            };
            await recipesCache.add(recipeDoc);
            stats.cached++;

            stats.tagged++;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.log(`[Tagger]   ✗ Firestore write failed for ${v.url} — ${msg}`);
            stats.failed++;
          }
        })
      );
    }

    processedCount += untagged.length;
  }

  stats.durationMs = Date.now() - t0;
  console.log(
    `[Tagger] ${site}: Done — tagged=${stats.tagged}, cached=${stats.cached}, failed=${stats.failed}, ` +
    `skippedEmpty=${stats.skippedEmpty}, geminiCalls=${stats.geminiCalls}, ` +
    `duration=${(stats.durationMs / 1000).toFixed(1)}s`
  );
  return stats;
}

async function main() {
  const { limit: writeLimit, site: targetSite } = parseArgs(process.argv.slice(2));
  const t0 = Date.now();

  // Initialise firebase-admin (same pattern as buildRecipeIndex.ts)
  const saPath = resolve(process.cwd(), 'service-account.json');
  if (existsSync(saPath) && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = saPath;
    console.log(`[Tagger] Using service account from ${saPath}`);
  }
  const admin = await loadAdmin();
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.applicationDefault() });
  }
  const db: FirebaseFirestore.Firestore = admin.firestore();

  console.log(`=== MealWizard Recipe Tagger ===`);
  console.log(`Model:          ${GEMINI_MODEL}`);
  console.log(`Batch size:     ${BATCH_SIZE}`);
  console.log(`Limit per site: ${writeLimit}`);
  console.log(`Target:         ${targetSite || 'All INDEXED_SITES'}`);
  console.log(`Started:        ${new Date().toISOString()}`);

  const sitesToTag = targetSite ? [targetSite] : INDEXED_SITES;
  const allStats: Record<string, SiteStats> = {};

  for (const site of sitesToTag) {
    allStats[site] = await tagSite(site, writeLimit, db);
  }

  // ── Final summary ──
  const totalTagged = Object.values(allStats).reduce((s, st) => s + st.tagged, 0);
  const totalCached = Object.values(allStats).reduce((s, st) => s + st.cached, 0);
  const totalFailed = Object.values(allStats).reduce((s, st) => s + st.failed, 0);
  const totalGemini = Object.values(allStats).reduce((s, st) => s + st.geminiCalls, 0);
  const totalDur = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`\n=== Tagger Summary ===`);
  for (const [site, st] of Object.entries(allStats)) {
    console.log(`  ${site.padEnd(35)} tagged=${String(st.tagged).padStart(4)}  cached=${String(st.cached).padStart(4)}  failed=${String(st.failed).padStart(3)}  gemini=${st.geminiCalls}  ${(st.durationMs / 1000).toFixed(1)}s`);
  }
  console.log(`  ${'TOTAL'.padEnd(35)} tagged=${String(totalTagged).padStart(4)}  cached=${String(totalCached).padStart(4)}  failed=${String(totalFailed).padStart(3)}  gemini=${totalGemini}  ${totalDur}s`);
  console.log(`Finished: ${new Date().toISOString()}`);
}

main().catch((err) => {
  console.error('[Tagger] Fatal error:', err);
  process.exit(1);
});
