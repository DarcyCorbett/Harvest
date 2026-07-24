export type CatalogueGenerationMode = 'legacy' | 'catalogue';

type Generate = (...args: any[]) => Promise<any>;
type Regenerate = (...args: any[]) => Promise<any>;

export function createGenerationDispatcher(dependencies: {
  getMode: () => Promise<CatalogueGenerationMode>;
  legacyGenerate: Generate;
  catalogueGenerate: Generate;
  legacyRegenerate: Regenerate;
  catalogueRegenerate: Regenerate;
}) {
  return {
    async generate(...args: Parameters<Generate>): Promise<any> {
      const mode = await dependencies.getMode();
      return mode === 'catalogue'
        ? dependencies.catalogueGenerate(...args)
        : dependencies.legacyGenerate(...args);
    },
    async regenerate(...args: Parameters<Regenerate>): Promise<any> {
      const mode = await dependencies.getMode();
      return mode === 'catalogue'
        ? dependencies.catalogueRegenerate(...args)
        : dependencies.legacyRegenerate(...args);
    },
  };
}
