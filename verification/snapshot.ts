// Verification harness — runs the active scraper against canonical recipe URLs
// and writes snapshots to verification/snapshots/<site>.json.
//
// On `main` (pre-refactor), this captures baselines using parseRecipeFromWprm.
// On `feature/jsonld-scraper` (post-refactor), this captures the new output for diffing.
//
// Usage: npx tsx verification/snapshot.ts [--out-dir <dir>]

import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as parseModule from '../services/scraper/parse';

// Defensive: the new parseRecipe export only exists post-refactor.
// On main / pre-refactor commits, fall back to parseRecipeFromWprm.
const parseRecipe = (parseModule as { parseRecipe?: (h: string, u: string) => unknown }).parseRecipe;
const parseRecipeFromWprm = (parseModule as { parseRecipeFromWprm?: (h: string, u: string) => unknown }).parseRecipeFromWprm;

interface Target {
  site: string;
  url: string;
}

const TARGETS: Target[] = [
  { site: 'recipetineats', url: 'https://www.recipetineats.com/poulet-roti-french-roast-chicken/' },
  { site: 'budgetbytes', url: 'https://www.budgetbytes.com/smash-burger-tacos/' },
  { site: 'thewoksoflife', url: 'https://thewoksoflife.com/beef-chow-mein/' },
  { site: 'themediterraneandish', url: 'https://www.themediterraneandish.com/how-to-make-hummus/' },
  { site: 'spendwithpennies', url: 'https://www.spendwithpennies.com/one-pot-chicken-pasta/' },
  { site: 'cafedelites', url: 'https://cafedelites.com/easy-lamb-curry/' },
  { site: 'skinnytaste', url: 'https://www.skinnytaste.com/sheet-pan-meatballs-with-chickpeas-cauliflower-and-butternut-squash/' },
  { site: 'pinchofyum', url: 'https://pinchofyum.com/chicken-and-potatoes-with-smoky-sauce' },
  // The Texas chili recipe the user flagged — JSON-LD has no HowToStep.image,
  // so step images must come from the DOM <img> overlay. Tracks that overlay.
  { site: 'pinchofyum-chili', url: 'https://pinchofyum.com/slow-cooker-texas-style-chili' },
  // Sheet Pan Pitas — JSON-LD HowToStep.video on every step (per-step video clips).
  { site: 'pinchofyum-pitas', url: 'https://pinchofyum.com/sheet-pan-chicken-pitas' },
  // Cafe Delites garlic parm wings — top-level Recipe.video (overview clip).
  { site: 'cafedelites-wings', url: 'https://cafedelites.com/easy-crispy-garlic-parmesan-wings/' },
  // Vegetarian Pad Thai — exercises the @graph standalone VideoObject fallback
  // (no Recipe.video field, but a sibling VideoObject in the JSON-LD graph).
  { site: 'pinchofyum-padthai', url: 'https://pinchofyum.com/rainbow-vegetarian-pad-thai-with-peanuts-and-basil' },
  // Chinese Lemon Chicken — every HowToStep has an inline image; user reported
  // step images not rendering on this recipe. Diagnostic snapshot.
  { site: 'cafedelites-lemon', url: 'https://cafedelites.com/chinese-lemon-chicken/' },
  // Baked Falafel — Recipe.video has a contentUrl direct MP4 (no embedUrl).
  // Tests MP4 fallback support.
  { site: 'pinchofyum-falafel', url: 'https://pinchofyum.com/simple-6-ingredient-baked-falafel' },
  // Natasha's Kitchen — WPRM site, full WP REST API search. New trusted site.
  { site: 'natashaskitchen-korma', url: 'https://natashaskitchen.com/chicken-korma/' },
  // Serious Eats — Mantle CMS, @type: ["Recipe","NewsArticle"] multi-type array.
  // Indexed-pool site (no JSON search API). Verifies multi-type @type handling.
  { site: 'seriouseats-baked-ziti', url: 'https://www.seriouseats.com/baked-ziti-with-leeks-swiss-chard-and-sun-dried-tomatoes-11969711' },
  // Akis Petretzikis — custom Next.js app, standalone JSON-LD with numeric
  // recipeCategory. Indexed-pool site. Verifies graceful numeric recipeCategory.
  { site: 'akispetretzikis-pilafi', url: 'https://akispetretzikis.com/en/recipe/9624/pilafi-ntolmadakia' },
  // NYT Cooking — paywall site, full Recipe JSON-LD in SSR HTML.
  // HowToStep with extra @context field. Indexed-pool site.
  { site: 'nytcooking-cookies', url: 'https://cooking.nytimes.com/recipes/1015819-chocolate-chip-cookies' },
  // America's Test Kitchen — paywall site, full Recipe JSON-LD in SSR HTML.
  // Top-level JSON-LD is an array of [WebPage, Recipe]; tests array-rooted
  // candidate handling in findJsonLdRecipe. Indexed-pool site.
  { site: 'atk-broccoli-caesar', url: 'https://www.americastestkitchen.com/recipes/17148-charred-broccoli-caesar-salad-with-chicken' },
  // The user reported "400 chickens" for this recipe's ingredients
  { site: 'recipetineats-chow-mein', url: 'https://www.recipetineats.com/chow-mein-ramen-noodles-recipe/' },
  // The user reported missing coconut milk in the shopping list
  { site: 'skinnytaste-coconut-bowl', url: 'https://www.skinnytaste.com/coconut-chicken-rice-bowl' },
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

function parseArgs(argv: string[]): { outDir: string } {
  const idx = argv.indexOf('--out-dir');
  if (idx >= 0 && argv[idx + 1]) return { outDir: resolve(argv[idx + 1]) };
  return { outDir: resolve(__dirname, 'snapshots') };
}

// Choose parser based on what's exported. parseRecipe is the new entry point;
// fall back to parseRecipeFromWprm if it doesn't exist (running on `main`).
function pickParser(): { fn: (html: string, url: string) => unknown; name: string } {
  if (typeof parseRecipe === 'function') return { fn: parseRecipe, name: 'parseRecipe' };
  if (typeof parseRecipeFromWprm === 'function') return { fn: parseRecipeFromWprm, name: 'parseRecipeFromWprm' };
  throw new Error('Neither parseRecipe nor parseRecipeFromWprm is exported');
}

async function main() {
  const { outDir } = parseArgs(process.argv.slice(2));
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const { fn: parse, name: parserName } = pickParser();
  console.log(`Using parser: ${parserName}`);
  console.log(`Output: ${outDir}\n`);

  const summary: Record<string, { ok: boolean; error?: string }> = {};

  for (const { site, url } of TARGETS) {
    process.stdout.write(`${site.padEnd(24)} … `);
    try {
      const html = await fetchHtml(url);
      const recipe = parse(html, url);
      writeFileSync(
        join(outDir, `${site}.json`),
        JSON.stringify(recipe, null, 2),
        'utf8'
      );
      console.log('OK');
      summary[site] = { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`FAIL — ${msg}`);
      summary[site] = { ok: false, error: msg };
    }
  }

  writeFileSync(join(outDir, '_summary.json'), JSON.stringify(summary, null, 2), 'utf8');
  console.log(`\nWrote ${Object.keys(summary).length} snapshots.`);
  const failed = Object.entries(summary).filter(([, v]) => !v.ok);
  if (failed.length) {
    console.log(`${failed.length} failed:`, failed.map(([k]) => k).join(', '));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
