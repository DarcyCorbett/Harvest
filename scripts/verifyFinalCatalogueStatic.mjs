import { readFile } from 'node:fs/promises';

const [
  catalogueGenerator,
  dispatcher,
  firestoreService,
  recipeModal,
  backfillRunner,
  modeRunner,
  matrix,
  legacyGenerator,
] = await Promise.all([
  readFile('services/catalogueGenerator.ts', 'utf8'),
  readFile('services/generationDispatcher.ts', 'utf8'),
  readFile('services/firestoreService.ts', 'utf8'),
  readFile('components/RecipeDetailModal.tsx', 'utf8'),
  readFile('scripts/run-phase4-backfill.ps1', 'utf8'),
  readFile('scripts/set-catalogue-generation-mode.ps1', 'utf8'),
  readFile('scripts/verifyFinalCatalogueMatrix.mjs', 'utf8'),
  readFile('services/generatorService.ts', 'utf8'),
]);

if (/recipeScraperService|scrapeRecipe|tagRecipesWithGemini|legacyRecipeClient/.test(catalogueGenerator)) {
  throw new Error('Catalogue generation must not depend on scraping, tagging, or the legacy bridge');
}
if (/catch[\s\S]{0,300}legacy/i.test(dispatcher)) {
  throw new Error('Catalogue generation must not automatically fall back to legacy');
}
if (!/getCatalogueGenerationMode/.test(legacyGenerator)
  || !/createGenerationDispatcher/.test(legacyGenerator)) {
  throw new Error('Public generation is not controlled by the operator mode');
}
if (!/decodeRecipeDocument/.test(firestoreService)) {
  throw new Error('Recipe reads do not use the schema-v2 compatibility decoder');
}
if (!/recipe\.schemaVersion === 2/.test(recipeModal)) {
  throw new Error('Catalogue metadata editing is not guarded');
}
if (/scheduler jobs (resume|run|update)/i.test(`${backfillRunner}\n${modeRunner}`)) {
  throw new Error('Final catalogue tooling must keep Scheduler paused');
}
if (!/initialMode/.test(backfillRunner) || !/finalMode/.test(backfillRunner)) {
  throw new Error('Backfill runner must preserve the generation mode');
}
if (!/ValidateSet\('legacy', 'catalogue'\)/.test(modeRunner)) {
  throw new Error('Mode runner must restrict operator values');
}
if (/\.set\(|\.update\(|\.delete\(|\.add\(/.test(matrix)) {
  throw new Error('Production selector matrix must remain read-only');
}
if (!/firestoreWrites:\s*0/.test(matrix) || !/externalRecipeRequests:\s*0/.test(matrix)) {
  throw new Error('Production matrix does not report its safety boundary');
}
if (!/async function generateLegacyMealPlan/.test(legacyGenerator)
  || !/async function regenerateLegacyMeals/.test(legacyGenerator)) {
  throw new Error('Legacy operator rollback was removed');
}

console.log('Final catalogue release static safety checks passed.');
