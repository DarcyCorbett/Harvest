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

  it('places Start cooking below the recipe tags with its own spacing', () => {
    const modal = read('components/RecipeDetailModal.tsx');
    const top = modal.indexOf('testID="start-cooking-top"');
    expect(top).toBeGreaterThan(modal.indexOf('styles.coursePills'));
    expect(top).toBeLessThan(modal.indexOf('{/* Macro strip */}'));
    expect(modal).toMatch(/startCooking: \{[^}]*marginBottom: Spacing\.lg,[^}]*paddingHorizontal: Spacing\.xl,/);
  });

  it('labels the empty-week shortcut by the days left, without claiming AI', () => {
    const calendar = read('components/connected/ClassicCalendar.tsx');
    expect(calendar).not.toContain('with AI');
    expect(calendar).toContain('{fillWeekLabel(days, today)}');
    expect(calendar).toContain('return `Plan the remaining ${remaining} days`;');
  });

  it('adds meals through a stepped walkthrough with searchable leftovers', () => {
    const plan = read('components/connected/PlanScreen.tsx');
    for (const heading of ['When is this meal?', 'What are you having?', 'Which recipe?', 'Leftovers from which meal?']) {
      expect(plan).toContain(heading);
    }
    expect(plan).toContain('label="Search cooked meals"');
    // One way to choose a recipe: the kind is "Cook a recipe"; the picker opens from step 3.
    expect(plan).not.toContain('"Choose recipe"');
    expect(plan).not.toContain('label="Choose recipe"');
  });
});

describe('settings layout', () => {
  it('insets the admin card like the other Settings cards and labels each section', () => {
    expect(read('components/AppInviteCard.tsx')).toContain('marginHorizontal: Spacing.xl');
    const profile = read('app/profile.tsx');
    for (const title of ['>ACCOUNT<', '>HOUSEHOLD<', '>YOUR HOUSEHOLD CODE<']) expect(profile).toContain(title);
  });
});

describe('recipe picker discover tab', () => {
  it('separates tabs, filters and actions, and loads pages on scroll', () => {
    const picker = read('components/connected/RecipePickerModal.tsx');
    expect(picker).toContain('<Segmented');
    expect(picker).toContain('<FilterSection title="Meal">');
    expect(picker).toContain('<FilterSection title="Cuisine">');
    expect(picker).toContain('<ActionButton');
    expect(picker).not.toContain('label="Load more"');
    expect(picker).toContain('onEndReached={loadMore}');
    expect(read('components/connected/Drawer.tsx')).toContain('onEndReached?: () => void;');
  });
});

describe('generate screen feedback', () => {
  const screen = () => read('components/connected/GenerateScreen.tsx');
  it('shows "Finding meals" as a floating banner only while searching, so Keep does not shift the list', () => {
    expect(screen()).toContain(': finding ? <FindingBanner');
    expect(screen()).not.toContain('Finding meals — completed results are saved as we go.');
  });
  it('warns about missing required ingredients instead of blocking Add to Calendar', () => {
    expect(screen()).not.toContain('A required ingredient was removed from this draft');
    expect(screen()).not.toContain('Each selected recipe must include the ingredients required in every recipe.');
    expect(screen()).toContain('You can still add them, or restore or swap a meal first.');
    // Household exclusions stay a hard stop.
    expect(screen()).toContain('Household exclusions changed.');
  });
  it('enters favoured, required and excluded ingredients as removable pills', () => {
    const form = read('components/connected/GenerationForm.tsx');
    for (const label of ['Other ingredients to favour', 'Required ingredients', 'Extra exclusions for this plan']) {
      expect(form).toContain(`<TermsField\n            label="${label}"`);
    }
  });
});
