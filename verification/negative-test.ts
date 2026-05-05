// Negative test: parseRecipe must throw on category/collection pages so the
// scraper service falls through to the next candidate URL instead of returning
// garbage. Regression guard against future detection-gate weakening.
//
// Usage: npx tsx verification/negative-test.ts

import { parseRecipe } from '../services/scraper/parse';

const NON_RECIPE_URLS = [
  'https://www.recipetineats.com/recipes/dinner/',         // collection page
  'https://pinchofyum.com/recipes',                        // collection on Tasty Recipes site
  'https://www.budgetbytes.com/category/recipes/',         // category index
  'https://pinchofyum.com/easy-family-dinner-recipes',     // round-up post (returned in REST API search)
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0';

async function main() {
  let pass = 0;
  let fail = 0;

  for (const url of NON_RECIPE_URLS) {
    process.stdout.write(`${url} … `);
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!res.ok) {
        console.log(`SKIP (HTTP ${res.status})`);
        continue;
      }
      const html = await res.text();
      try {
        parseRecipe(html, url);
        console.log('FAIL — parser returned a recipe (it should have thrown)');
        fail++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('No JSON-LD Recipe')) {
          console.log(`PASS (${msg})`);
          pass++;
        } else {
          console.log(`PASS (threw unrelated error: ${msg})`);
          pass++;
        }
      }
    } catch (err) {
      console.log(`FETCH ERR: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log();
  console.log(`Pass: ${pass}, Fail: ${fail}`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
