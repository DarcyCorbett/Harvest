import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { tagRecipesWithGemini } from '../services/gemini';
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

  console.log(`\n--- Tagging with ${proModel} ---`);
  const t0 = Date.now();
  const proResults = await tagRecipesWithGemini(recipes, proModel);
  console.log(`Time: ${Date.now() - t0}ms`);

  console.log(`\n--- Tagging with ${flashLiteModel} ---`);
  const t1 = Date.now();
  const flashLiteResults = await tagRecipesWithGemini(recipes, flashLiteModel);
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

main().catch(console.error);
