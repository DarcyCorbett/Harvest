import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { tagRecipesWithAdminGemini } from './lib/geminiAdmin';
import type { Recipe } from '../services/types';

async function main() {
  const snapshotsDir = path.resolve(__dirname, '../verification/snapshots');
  const files = fs.readdirSync(snapshotsDir).filter((f) => f.endsWith('.json') && !f.startsWith('_'));
  
  // Pick next 5 recipes
  const testFiles = files.slice(5, 10);
  console.log(`Loading ${testFiles.length} recipes for testing...`);
  
  const recipes = testFiles.map((file) => {
    const content = fs.readFileSync(path.join(snapshotsDir, file), 'utf8');
    return {
      recipeId: file.replace('.json', ''),
      recipe: JSON.parse(content) as Recipe,
    };
  });

  const proModel = 'gemini-3.1-pro-preview';
  const flashLiteModel = 'gemini-3.1-flash-lite';
  const aiInput = recipes.map(({ recipeId, recipe }) => ({
    recipeId,
    title: recipe.title.slice(0, 160),
    totalMinutes: recipe.totalTime
      ? Number.parseInt(recipe.totalTime, 10) || null
      : null,
    ingredients: recipe.ingredients
      .slice(0, 100)
      .map((ingredient) => ingredient.name.slice(0, 200)),
    steps: recipe.instructions
      .slice(0, 40)
      .map((step) => step.text.slice(0, 300)),
    existingTags: (recipe.tags ?? []).slice(0, 30),
  }));

  console.log(`\n--- Tagging with ${proModel} ---`);
  const t0 = Date.now();
  const proResults = await tagRecipesWithAdminGemini(aiInput, proModel);
  console.log(`Time: ${Date.now() - t0}ms`);

  console.log(`\n--- Tagging with ${flashLiteModel} ---`);
  const t1 = Date.now();
  const flashLiteResults = await tagRecipesWithAdminGemini(aiInput, flashLiteModel);
  console.log(`Time: ${Date.now() - t1}ms`);

  console.log('\n--- Comparison ---');
  let diffCount = 0;
  for (const { recipeId, recipe } of recipes) {
    const proTags = [...(proResults.get(recipeId) || [])].sort();
    const flashTags = [...(flashLiteResults.get(recipeId) || [])].sort();
    
    const isMatch = JSON.stringify(proTags) === JSON.stringify(flashTags);
    
    console.log(`\nRecipe: ${recipe.title}`);
    if (isMatch) {
      console.log(`✅ MATCH: [${proTags.join(', ')}]`);
    } else {
      console.log(`❌ DIFF:`);
      console.log(`   Pro        : [${proTags.join(', ')}]`);
      console.log(`   Flash-Lite : [${flashTags.join(', ')}]`);
      diffCount++;
    }
  }

  console.log(`\nSummary: ${recipes.length - diffCount}/${recipes.length} identical matches.`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : 'Unknown operator error';
  console.error(`[Tagger Test] Failed: ${message}`);
  process.exitCode = 1;
});
