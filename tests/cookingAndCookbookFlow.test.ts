import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');

describe('cooking and cookbook flow', () => {
  it('puts Start cooking above the fold in the recipe modal', () => {
    const modal = read('components/RecipeDetailModal.tsx');
    const top = modal.indexOf('testID="start-cooking-top"');
    expect(top).toBeGreaterThan(-1);
    expect(top).toBeLessThan(modal.indexOf('<SectionLabel title="Ingredients"'));
  });

  it('collapses recipe import behind the Cookbook header', () => {
    const screen = read('components/connected/CookbookScreen.tsx');
    expect(screen).toContain('const [showImport, setShowImport] = useState(false);');
    expect(screen).toContain('{(showImport || importing || !!imported) && <Card>');
    expect(screen).toContain('label={showImport ? "Hide recipe import" : "Import a recipe"}');
  });

  it('links an empty Plan week to Generate (fill gaps for that week) and the Cookbook', () => {
    const calendar = read('components/connected/ClassicCalendar.tsx');
    expect(calendar).toContain('days.every((d) => !forDate(d).length)');
    expect(calendar).toContain('router.push({ pathname: "/generate", params: { preset: "gaps", start: days[0], end: days[6] } })');
    expect(read('components/connected/GenerateScreen.tsx')).toContain('} else if (params.preset === "gaps") {');
  });
});
