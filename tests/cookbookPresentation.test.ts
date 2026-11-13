import { describe, expect, it } from 'vitest';
import { cookbookImageUrls, filterCookbook, indexCookbook } from '../services/cookbookPresentation';
import type { CookbookEntry, Recipe } from '../services/types';

const recipe = (id: string, extra: Partial<Recipe> = {}): Recipe => ({
  id, title: id, sourceUrl: 'https://example.test/recipe', prepTime: '10 min', cookTime: '20 min',
  originalServings: 2, ingredients: [{ name: 'Chickpeas', quantity: 1, unit: 'cup' }],
  instructions: [], notes: '', scrapedAt: new Date(0), ...extra,
});
const entry = (recipeId: string, extra: Partial<CookbookEntry> = {}): CookbookEntry => ({
  recipeId, starred: false, addedAt: new Date(0), ...extra,
});

describe('cookbook thumbnails', () => {
  it('tries the primary first, then unique nonempty saved alternatives', () => {
    expect(cookbookImageUrls({ imageUrl: ' https://img.test/main ', imageUrls: [
      'https://img.test/main', '', '  ', 'https://img.test/alternate', 'https://img.test/alternate',
    ] })).toEqual(['https://img.test/main', 'https://img.test/alternate']);
  });
  it('supports alternate-only recipes and an empty list for the placeholder', () => {
    expect(cookbookImageUrls({ imageUrls: ['https://img.test/poster'] })).toEqual(['https://img.test/poster']);
    expect(cookbookImageUrls({})).toEqual([]);
  });
  it('does not invent a thumbnail or request the video URL', () => {
    expect(cookbookImageUrls(recipe('video', { videoEmbedUrl: 'https://youtube.com/embed/example' }))).toEqual([]);
  });
});

describe('cookbook search and ordering', () => {
  const cookbook = [entry('a'), entry('b', { starred: true, lastCookedAt: '2026-09-20' }),
    entry('c', { lastCookedAt: '2026-09-24' }), entry('unavailable')];
  const recipes = {
    a: recipe('a', { course: ['Lunch'], cuisine: 'Italian' }),
    b: recipe('b', { title: 'Quick soup', tags: ['Dinner'], totalTime: '25 min' }),
    c: recipe('c', { course: ['Dinner'], totalTime: '60 min' }),
  };
  const all = { search: '', starred: false, cooked: false, time: 0, type: 'all' };
  const indexed = indexCookbook(cookbook, recipes);
  const ids = (filters = all) => filterCookbook(indexed, filters).map((row) => row.entry.recipeId);

  it('keeps recent cooking order, excludes unavailable recipes and does not mutate inputs', () => {
    expect(ids()).toEqual(['c', 'b', 'a']);
    expect(cookbook.map((item) => item.recipeId)).toEqual(['a', 'b', 'c', 'unavailable']);
  });
  it('searches title, ingredients, tags, course and cuisine without case sensitivity', () => {
    expect(ids({ ...all, search: 'SOUP' })).toEqual(['b']);
    expect(ids({ ...all, search: 'chickPEAS' })).toEqual(['c', 'b', 'a']);
    expect(ids({ ...all, search: 'dinner' })).toEqual(['c', 'b']);
    expect(ids({ ...all, search: 'lunch' })).toEqual(['a']);
    expect(ids({ ...all, search: 'ITALIAN' })).toEqual(['a']);
    expect(ids({ ...all, search: 'missing' })).toEqual([]);
  });
  it('combines favourites, cooking history, duration and meal-type filters', () => {
    expect(ids({ ...all, starred: true, cooked: true, time: 30, type: 'dinner' })).toEqual(['b']);
    expect(ids({ ...all, time: 30 })).toEqual(['b', 'a']);
    expect(ids({ ...all, cooked: true })).toEqual(['c', 'b']);
  });
  it('keeps source object identities for memoized cards and excludes unknown durations from timed results', () => {
    expect(indexed[0].recipe).toBe(recipes.c);
    expect(indexed[0].entry).toBe(cookbook[2]);
    const unknown = indexCookbook([entry('unknown')], { unknown: recipe('unknown', { prepTime: '', cookTime: '' }) });
    expect(filterCookbook(unknown, { ...all, time: 45 })).toEqual([]);
    expect(filterCookbook(unknown, all)).toHaveLength(1);
  });
});
