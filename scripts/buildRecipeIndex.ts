#!/usr/bin/env node
/**
 * Phase A — sitemap walker for the recipe discovery index.
 *
 * Walks each indexed site's sitemap, extracts recipe URLs, writes them as
 * untagged stubs to /recipeIndex/{site}/recipes/{id}. Tagging happens lazily
 * during generation (Phase B in services/scraper/recipeIndex.ts).
 *
 * Setup (one-time):
 *   1. npm i -D firebase-admin
 *   2. Firebase Console → Project Settings → Service Accounts → Generate
 *      new private key. Save as `service-account.json` in the project root
 *      (it's already gitignore-safe — see .gitignore).
 *   3. Run the script — it auto-detects ./service-account.json. Alternatively,
 *      set GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json.
 *
 * Usage:
 *   npx tsx scripts/buildRecipeIndex.ts --site akispetretzikis.com
 *   npx tsx scripts/buildRecipeIndex.ts --site cooking.nytimes.com
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fetchSitemapUrls } from '../services/scraper/sitemap';

interface SiteConfig {
  /** Domain key matching INDEXED_SITES in sites.ts */
  site: string;
  /** Sitemap entry point — may be a sitemap-index */
  rootUrl: string;
  /** Regex matching recipe (not category/blog/page) URLs */
  urlPattern: RegExp;
  /** User-Agent override (NYT needs Googlebot to bypass paywall block) */
  ua?: string;
  /** Force gzip decode (NYT) */
  gzip?: boolean;
}

const SITE_CONFIGS: Record<string, SiteConfig> = {
  'akispetretzikis.com': {
    site: 'akispetretzikis.com',
    rootUrl: 'https://akispetretzikis.com/sitemap.xml',
    urlPattern: /\/en\/recipe\/\d+\//,
  },
  'cooking.nytimes.com': {
    site: 'cooking.nytimes.com',
    rootUrl: 'https://www.nytimes.com/sitemaps/new/cooking.xml.gz',
    urlPattern: /\/recipes\/\d+-[a-z0-9-]+/,
    ua: 'Googlebot/2.1 (+http://www.google.com/bot.html)',
    gzip: true,
  },
  'www.americastestkitchen.com': {
    site: 'www.americastestkitchen.com',
    // /sitemap.xml is a sitemap-index; the sitemap walker recurses into the
    // children automatically. The recipes child has ~14.5K URLs; reviews,
    // articles, guides etc. are present too but their URLs won't match the
    // /recipes/ pattern below so they're filtered out.
    rootUrl: 'https://www.americastestkitchen.com/sitemap.xml',
    urlPattern: /\/recipes\/\d+-[a-z0-9-]+/,
  },
};

interface CliArgs {
  site: string;
  /** Cap on NEW URL writes this run. Lets you chunk a big crawl across multiple
   *  days to stay under Firestore's 20K writes/day Spark-tier quota. */
  limit?: number;
  /** Re-stamp `sitemapLastSeen` on existing entries. Off by default so resuming
   *  an interrupted crawl doesn't burn writes refreshing already-indexed URLs. */
  refresh: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const idx = argv.indexOf('--site');
  if (idx < 0 || !argv[idx + 1]) {
    console.error(
      'Usage: npx tsx scripts/buildRecipeIndex.ts --site <domain> [--limit N] [--refresh]',
    );
    console.error('Available sites:', Object.keys(SITE_CONFIGS).join(', '));
    console.error('  --limit N    Cap new writes per run (Spark tier: 20K/day total).');
    console.error('  --refresh    Re-stamp sitemapLastSeen on already-indexed URLs.');
    process.exit(2);
  }
  const limitIdx = argv.indexOf('--limit');
  const limitStr = limitIdx >= 0 ? argv[limitIdx + 1] : undefined;
  const limit = limitStr ? parseInt(limitStr, 10) : undefined;
  if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
    console.error(`Invalid --limit value: ${limitStr}`);
    process.exit(2);
  }
  return { site: argv[idx + 1], limit, refresh: argv.includes('--refresh') };
}

/** Detect Firestore RESOURCE_EXHAUSTED (quota errors). gRPC code 8. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isQuotaError(err: any): boolean {
  if (!err) return false;
  if (err.code === 8) return true;
  const msg = String(err.message ?? err);
  return msg.includes('RESOURCE_EXHAUSTED') || msg.includes('Quota exceeded');
}

/** Stable, short, URL-safe id derived from the recipe URL. */
function recipeIdFromUrl(url: string): string {
  return createHash('sha1').update(url).digest('base64url').slice(0, 16);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadAdmin(): Promise<any> {
  try {
    // firebase-admin is a dev-only dependency the developer installs as part of
    // the one-time setup (see top-of-file). We dynamic-import it so the rest of
    // the codebase doesn't need it. The @ts-ignore is here because the package
    // may not be installed at typecheck time.
    // @ts-ignore - optional dev dependency, may not be installed
    const mod: { default?: unknown } = await import('firebase-admin');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return ((mod as any).default ?? mod) as any;
  } catch {
    console.error('[RecipeIndex] firebase-admin is not installed.');
    console.error('             Run: npm i -D firebase-admin');
    process.exit(2);
  }
}

async function main() {
  const { site, limit, refresh } = parseArgs(process.argv.slice(2));
  const cfg = SITE_CONFIGS[site];
  if (!cfg) {
    console.error(`[RecipeIndex] Unknown site: ${site}`);
    console.error('             Available:', Object.keys(SITE_CONFIGS).join(', '));
    process.exit(2);
  }

  // Auto-detect service-account.json in project root for convenience.
  const saPath = resolve(process.cwd(), 'service-account.json');
  if (existsSync(saPath) && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = saPath;
    console.log(`[RecipeIndex] Using service account from ${saPath}`);
  }

  const admin = await loadAdmin();
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.applicationDefault() });
  }
  const db = admin.firestore();

  console.log(`[RecipeIndex] Phase A start: ${site}`);
  if (limit !== undefined) console.log(`[RecipeIndex]   --limit ${limit} new writes this run`);
  if (refresh) console.log(`[RecipeIndex]   --refresh ON: re-stamping sitemapLastSeen on existing entries`);
  else console.log(`[RecipeIndex]   --refresh OFF: skipping updates on already-indexed URLs`);

  const urls = await fetchSitemapUrls(cfg.rootUrl, cfg.urlPattern, {
    ua: cfg.ua,
    gzip: cfg.gzip,
  });
  console.log(`[RecipeIndex] Sitemap walk complete: ${urls.length} recipe URLs total`);

  if (urls.length === 0) {
    console.log('[RecipeIndex] No URLs matched the recipe pattern — exiting');
    return;
  }

  const collection = db.collection('recipeIndex').doc(site).collection('recipes');
  const now = admin.firestore.FieldValue.serverTimestamp();

  // Read existing IDs (cheap: docs are tiny and we use select() for no fields)
  const existing = new Set<string>();
  const snap = await collection.select().get();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  snap.forEach((doc: any) => existing.add(doc.id));
  console.log(
    `[RecipeIndex] Existing entries in /recipeIndex/${site}/recipes/: ${existing.size}`,
  );

  let added = 0;
  let refreshed = 0;
  let skipped = 0;
  // Firestore batched writes are capped at 500 ops; chunk at 450 for safety.
  let batch = db.batch();
  let opsInBatch = 0;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const safeCommit = async (b: any): Promise<boolean> => {
    try {
      await b.commit();
      return true;
    } catch (err) {
      if (isQuotaError(err)) {
        console.error(
          `[RecipeIndex] Firestore quota exhausted. Wrote ${added} new + ${refreshed} refreshed before stopping.`,
        );
        console.error(
          `[RecipeIndex] Spark tier free quota: 20K writes/day. Re-run tomorrow to continue ` +
          `— the script will skip already-indexed URLs automatically.`,
        );
        return false;
      }
      throw err;
    }
  };

  for (const url of urls) {
    // Stop emitting new SETs once the per-run cap is reached, but keep
    // iterating so we count what was skipped.
    if (limit !== undefined && added >= limit && !existing.has(recipeIdFromUrl(url))) {
      skipped++;
      continue;
    }

    const id = recipeIdFromUrl(url);
    const ref = collection.doc(id);
    if (existing.has(id)) {
      if (!refresh) {
        skipped++;
        continue;
      }
      batch.update(ref, { sitemapLastSeen: now });
      refreshed++;
    } else {
      batch.set(ref, {
        url,
        sitemapLastSeen: now,
        geminiTaggedAt: null,
        tags: null,
      });
      added++;
    }
    opsInBatch++;
    if (opsInBatch >= 450) {
      const ok = await safeCommit(batch);
      if (!ok) return;
      batch = db.batch();
      opsInBatch = 0;
    }
  }
  if (opsInBatch > 0) {
    const ok = await safeCommit(batch);
    if (!ok) return;
  }

  console.log(
    `[RecipeIndex] Done — ${site} total indexed: ${urls.length} ` +
    `(+${added} new, ${refreshed} refreshed, ${skipped} skipped)`,
  );
}

main().catch((e) => {
  console.error('[RecipeIndex] Fatal error:', e);
  process.exit(1);
});
