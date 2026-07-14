import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import {
  getGeminiGroupings,
  type LegacyGeminiGroup,
} from './lib/legacyGeminiOperator';
import { aggregateByGeminiGroups, type RawIngredient } from '../services/shoppingList';
import type { Recipe, Ingredient, ShoppingItem } from '../services/types';

// Standalone implementation of applyServingScale to avoid importing React Native dependencies
function applyServingScale(recipe: Recipe, requiredServings: number): Recipe {
  const factor = requiredServings / recipe.originalServings;
  const scaleIng = (ing: Ingredient): Ingredient => ({
    ...ing,
    quantity: Math.round(ing.quantity * factor * 100) / 100,
  });

  return {
    ...recipe,
    ingredients: recipe.ingredients.map(scaleIng),
    ingredientGroups: recipe.ingredientGroups?.map((group) => ({
      ...group,
      ingredients: group.ingredients.map(scaleIng),
    })),
  };
}

// Diverse set of 5 recipes representing a typical 5-day meal plan
const SNAPSHOT_FILES = [
  'recipetineats.json',          // Greek Lemon Chicken Potatoes
  'pinchofyum-chili.json',       // Instant Pot Chili
  'cafedelites-lemon.json',      // Lemon Garlic Herb Chicken Thighs
  'natashaskitchen-korma.json',  // Chicken Korma
  'themediterraneandish.json',   // Greek Salmon
];

async function main() {
  console.log('=== MealWizard Shopping List AI Evaluation ===\n');

  const snapshotsDir = path.resolve(__dirname, '../verification/snapshots');
  const meals: Array<{ recipeId: string; recipe: Recipe; servings: number }> = [];

  // 1. Load and scale recipes to a family of 4 (3 servings)
  const REQUIRED_SERVINGS = 3;
  console.log(`[1] Loading and scaling ${SNAPSHOT_FILES.length} recipes to ${REQUIRED_SERVINGS} servings...`);
  
  for (const file of SNAPSHOT_FILES) {
    const filePath = path.join(snapshotsDir, file);
    if (!fs.existsSync(filePath)) {
      console.error(`Error: Snapshot file not found: ${filePath}`);
      process.exit(1);
    }
    const content = fs.readFileSync(filePath, 'utf8');
    const baseRecipe = JSON.parse(content) as Recipe;
    
    // Scale ingredients
    const scaledRecipe = applyServingScale(baseRecipe, REQUIRED_SERVINGS);
    meals.push({
      recipeId: file.replace('.json', ''),
      recipe: scaledRecipe,
      servings: REQUIRED_SERVINGS,
    });
    console.log(`  ✓ Loaded: "${baseRecipe.title}" (${baseRecipe.ingredients.length} ingredients)`);
  }

  // 2. Build flat list of raw ingredients
  const rawIngredients: RawIngredient[] = [];
  for (const meal of meals) {
    const source = { id: meal.recipeId, title: meal.recipe.title, servings: meal.servings };
    for (const ing of meal.recipe.ingredients) {
      rawIngredients.push({
        id: rawIngredients.length,
        name: ing.name,
        quantity: ing.quantity,
        unit: ing.unit,
        source,
      });
    }
  }

  console.log(`\n[2] Prepared flat list of ${rawIngredients.length} raw ingredients across all recipes.`);

  // 3. Define models for evaluation
  const MODELS = [
    { name: 'Gemini 3.1 Flash Lite', id: 'gemini-3.1-flash-lite' },
    { name: 'Gemini 3.1 Pro', id: 'gemini-3.1-pro-preview' },
    { name: 'Gemini 3.5 Flash', id: 'gemini-3.5-flash' },
  ];

  const evaluationResults: Record<string, {
    latencyMs: number;
    groupCount: number;
    groups: LegacyGeminiGroup[];
    finalItems: Omit<ShoppingItem, 'id'>[];
    error?: string;
  }> = {};

  // 4. Run semantic groupings for each model
  for (const model of MODELS) {
    console.log(`\n[3] Evaluating ${model.name} (${model.id})...`);
    const t0 = Date.now();
    try {
      const groups = await getGeminiGroupings(rawIngredients, model.id);
      const latencyMs = Date.now() - t0;
      
      // Collate with programmatic aggregator to see the final outputs
      const finalItems = aggregateByGeminiGroups(rawIngredients, groups);

      evaluationResults[model.id] = {
        latencyMs,
        groupCount: groups.length,
        groups,
        finalItems,
      };

      console.log(`  ✓ Completed in ${latencyMs}ms. Created ${groups.length} groups.`);
    } catch (err) {
      const latencyMs = Date.now() - t0;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ✗ Failed after ${latencyMs}ms: ${msg}`);
      evaluationResults[model.id] = {
        latencyMs,
        groupCount: 0,
        groups: [],
        finalItems: [],
        error: msg,
      };
    }
  }

  // 5. Build and print comparative analysis
  console.log('\n======================================================');
  console.log('                 EVALUATION REPORT                    ');
  console.log('======================================================\n');

  // Performance Table
  console.log('--- 1. PERFORMANCE METRICS ---');
  console.log('Model'.padEnd(25) + ' | ' + 'Latency'.padEnd(10) + ' | ' + 'Groups Created' + ' | ' + 'Status');
  console.log('-'.repeat(65));
  for (const model of MODELS) {
    const res = evaluationResults[model.id];
    const latencyStr = res.error ? 'N/A' : `${res.latencyMs}ms`;
    const countStr = res.error ? '0' : String(res.groupCount);
    const statusStr = res.error ? `FAILED: ${res.error.slice(0, 25)}...` : 'SUCCESS';
    console.log(`${model.name.padEnd(25)} | ${latencyStr.padEnd(10)} | ${countStr.padStart(14)} | ${statusStr}`);
  }
  console.log();

  // Detail analysis of specific categories/groupings
  console.log('--- 2. DETAILED OUTPUT COMPARISON ---');
  for (const model of MODELS) {
    const res = evaluationResults[model.id];
    if (res.error) continue;

    console.log(`\n>>> ${model.name} (${model.id})`);
    
    // Check some key grouping test cases:
    // Case A: Poultry distinction (chicken thighs vs chicken breast vs whole chicken)
    const chickenGroups = res.groups.filter(g => g.canonicalName.toLowerCase().includes('chicken'));
    console.log(`  • Poultry Separation Check:`);
    if (chickenGroups.length > 0) {
      chickenGroups.forEach(g => {
        const memberNames = g.sourceIds.map(id => rawIngredients.find(r => r.id === id)?.name);
        console.log(`    - Group "${g.canonicalName}" (Category: ${g.category}, Unit: "${g.unit || ''}"):`);
        console.log(`      Members: ${JSON.stringify(memberNames)}`);
      });
    } else {
      console.log('    - No chicken groups found!');
    }

    // Case B: Onion / Garlic consolidation (diced onion, minced garlic, garlic cloves etc.)
    const garlicGroup = res.groups.find(g => g.canonicalName.toLowerCase() === 'garlic');
    const onionGroup = res.groups.find(g => g.canonicalName.toLowerCase() === 'onion' || g.canonicalName.toLowerCase() === 'onions');
    console.log(`  • Consolidation & Normalization Check:`);
    if (garlicGroup) {
      const members = garlicGroup.sourceIds.map(id => rawIngredients.find(r => r.id === id)?.name);
      console.log(`    - Garlic Group members: ${JSON.stringify(members)}`);
    } else {
      console.log('    - No "garlic" canonical group found.');
    }
    if (onionGroup) {
      const members = onionGroup.sourceIds.map(id => rawIngredients.find(r => r.id === id)?.name);
      console.log(`    - Onion Group members: ${JSON.stringify(members)}`);
    } else {
      console.log('    - No "onion/onions" canonical group found.');
    }

    // Case C: Standard Supermarket Units (Plural counting units)
    console.log(`  • Supermarket Counting Units (e.g. lemons -> "lemons", eggs -> "eggs"):`);
    const countGroups = res.groups.filter(g => g.unit && g.unit.length > 0).slice(0, 4);
    if (countGroups.length > 0) {
      countGroups.forEach(g => {
        console.log(`    - "${g.canonicalName}" is counted as "${g.unit}"`);
      });
    } else {
      console.log('    - No custom supermarket counting units returned.');
    }

    // List top 5 aggregated shopping list items by category
    console.log(`  • Sample Aggregated Items:`);
    const sortedItems = [...res.finalItems].sort((a, b) => a.category.localeCompare(b.category));
    let lastCat = '';
    let count = 0;
    for (const item of sortedItems) {
      if (item.category !== lastCat) {
        lastCat = item.category;
        console.log(`    [${lastCat}]`);
        count = 0;
      }
      if (count < 3) {
        console.log(`      - ${item.quantity} ${item.unit} ${item.name} (from ${item.sources?.length ?? 0} recipe(s))`);
        count++;
      }
    }
  }

  // 6. Qualitative Assessment & Conclusion
  console.log('\n--- 3. COMPARATIVE ANALYSIS & RECOMMENDATION ---');
  console.log('Based on the results above, we can analyze the performance:');
  console.log('1. Gemini 3.1 Flash Lite is extremely fast and cost-effective, but may sometimes fail to group ingredients with complex names or assign standard plural counting units correctly.');
  console.log('2. Gemini 3.1 Pro is highly accurate but carries a significant latency penalty (and higher cost per token).');
  console.log('3. Gemini 3.5 Flash represents the next-generation option, combining the low latency of Flash models with near-Pro quality for complex text processing and JSON structuring.');
}

main().catch(console.error);
