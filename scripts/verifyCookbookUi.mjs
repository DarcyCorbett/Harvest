// Browser regression fixture: real cookbook, FlatList and Expo Image; synthetic data only.
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const output = resolve(root, 'artifacts/cookbook-ui');
await mkdir(output, { recursive: true });
const mocks = {
  '@/contexts/ConnectedContext': `
    import React from 'react';
    const listeners = new Set();
    const recipes = Object.fromEntries(Array.from({length: 200}, (_, i) => {
      const id = String(i).padStart(3, '0');
      return [id, { id, title: 'Recipe ' + id, sourceUrl: 'https://example.test/' + id,
        prepTime: '10 min', cookTime: '20 min', originalServings: 2,
        ingredients: [{name: i % 2 ? 'Lentils' : 'Chickpeas', quantity: 1, unit: 'cup'}],
        course: [i % 2 ? 'Lunch' : 'Dinner'], instructions: [], notes: '', scrapedAt: new Date(0),
        ...(i === 0 ? {imageUrl: '/ok/main.svg', imageUrls: ['/ok/unused.svg']} :
          i === 1 ? {imageUrl: '/missing/primary.svg', imageUrls: ['/ok/alternate.svg']} :
          i === 2 ? {imageUrls: ['/ok/poster.svg'], videoEmbedUrl: 'https://example.test/video'} :
          i === 3 ? {imageUrl: '/missing/all.svg', imageUrls: ['/missing/other.svg']} : {}) }];
    }));
    let snapshot = { recipes, cookbook: Object.keys(recipes).map(recipeId => ({recipeId,
      starred: false, addedAt: new Date(0)})), online: true, loading: false, pending: [], error: '' };
    export const change = patch => { snapshot = {...snapshot, ...patch}; listeners.forEach(fn => fn()); };
    export const getSnapshot = () => snapshot;
    export const useConnected = () => React.useSyncExternalStore(fn => { listeners.add(fn); return () => listeners.delete(fn); }, getSnapshot);
    window.qa = { change, getSnapshot, navigation: [], saved: [] };
  `,
  '@/contexts/AuthContext': `export const useAuth = () => ({householdId: 'fixture'});`,
  '@/contexts/ThemeContext': `import {Colors} from '@/constants/theme'; export const useTheme = () => ({colors: Colors.light});`,
  '@/config/firebase': `export const functions = {};`,
  'firebase/functions': `export const httpsCallable = () => () => { throw Error('Import is outside this fixture'); };`,
  '@/services/firestoreService': `
    import {change, getSnapshot} from '@/contexts/ConnectedContext';
    export const addToCookbook = async () => {};
    export const toggleStarred = async (_home, id, starred) => change({cookbook: getSnapshot().cookbook.map(e => e.recipeId === id ? {...e, starred} : e)});
    export const updateCookbookDetails = async (_home, id, details) => {
      window.qa.saved.push({id, ...details});
      change({cookbook: getSnapshot().cookbook.map(e => e.recipeId === id ? {...e, ...details} : e)});
    };
  `,
  'expo-router': `const router = {push: target => window.qa.navigation.push(target)}; export const useRouter = () => router;`,
  'react-native-safe-area-context': `import React from 'react'; import {View} from 'react-native'; export const SafeAreaView = ({edges, ...props}) => <View {...props} />;`,
  '@expo/vector-icons': `import React from 'react'; export const Ionicons = ({name, color, size}) => <span data-icon={name} style={{color, fontSize:size}}>{name === 'restaurant-outline' ? '♧' : '☆'}</span>;`,
  '@/components/RecipeDetailModal': `import React from 'react'; export default function Modal({recipe, visible, onClose}) {return visible ? <div role="dialog" style={{position:'fixed', inset:0, background:'white', zIndex:100}}>{recipe.title}<button onClick={onClose}>Close preview</button></div> : null;}`,
  'expo-image': `export {Image} from 'expo-image/src/Image';`,
};
await build({
  stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import Cookbook from '@/components/connected/CookbookScreen'; createRoot(document.getElementById('root')).render(<Cookbook />);`, resolveDir: root, loader: 'tsx' },
  outfile: resolve(output, 'bundle.js'), bundle: true, platform: 'browser', format: 'iife',
  alias: { 'react-native': 'react-native-web' },
  resolveExtensions: ['.web.tsx', '.web.ts', '.web.jsx', '.web.js', '.tsx', '.ts', '.jsx', '.js', '.json'],
  define: { global: 'globalThis', __DEV__: 'true', 'process.env.NODE_ENV': '"development"', 'process.env.EXPO_OS': '"web"' },
  plugins: [{name: 'cookbook-fixture', setup(builder) {
    builder.onResolve({filter: /.*/}, args => args.path in mocks ? {path: args.path, namespace: 'fixture'} : undefined);
    builder.onLoad({filter: /.*/, namespace: 'fixture'}, args => ({contents: mocks[args.path], loader: 'tsx', resolveDir: root}));
  }}],
});
const requests = [];
const server = createServer(async (req, res) => {
  requests.push(req.url);
  if (req.url.startsWith('/ok/')) {
    res.setHeader('Content-Type', 'image/svg+xml');
    res.end('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="160"><rect width="320" height="160" fill="#a7f3d0"/></svg>');
  } else if (req.url.startsWith('/missing/')) { res.writeHead(404); res.end(); }
  else if (req.url === '/bundle.js') {res.setHeader('Content-Type', 'application/javascript'); res.end(await readFile(resolve(output, 'bundle.js')));}
  else {res.setHeader('Content-Type', 'text/html'); res.end('<html><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;margin:0}#root{display:flex}</style><div id="root"></div><script src="/bundle.js"></script></html>');}
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
let browser;
try {
  browser = await chromium.launch({headless: true});
  const page = await browser.newPage({viewport: {width: 390, height: 844}});
  const errors = [];
  page.on('pageerror', error => { errors.push(error.message); console.error(error.stack); });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByText('200 recipes', {exact: true}).waitFor();
  const search = page.getByRole('textbox', {name: 'Search recipes, ingredients, and cuisines'});
  const show = async (id) => { await search.fill('Recipe ' + id); await page.getByRole('heading', {name: 'Recipe ' + id, exact: true}).waitFor(); };
  const loaded = async (suffix) => page.waitForFunction(suffix => [...document.images].some(img => img.src.endsWith(suffix) && img.complete && img.naturalWidth > 0), suffix);
  const initialCards = await page.getByRole('heading', {name: /^Recipe /}).count();
  assert(initialCards < 30, `Expected windowed rendering, found ${initialCards} cards`);
  await show('000'); await loaded('/ok/main.svg');
  assert(!requests.includes('/ok/unused.svg'), 'Healthy primary should not request fallback');
  await show('001'); await loaded('/ok/alternate.svg');
  await show('002'); await loaded('/ok/poster.svg');
  assert.equal(await page.locator('iframe, video').count(), 0, 'No video players in the list');
  await show('003');
  await page.waitForFunction(() => performance.getEntriesByType('resource').some(entry => entry.name.endsWith('/missing/other.svg')));
  await page.waitForFunction(() => document.images.length === 0);
  assert(requests.includes('/missing/all.svg') && requests.includes('/missing/other.svg'));
  await show('004');
  assert.equal(await page.locator('[data-icon="restaurant-outline"]').count(), 1);
  await page.getByRole('button', {name: 'View Recipe 004', exact: true}).first().click();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('button', {name: 'Close preview'}).click();
  await page.getByRole('button', {name: 'Favourite Recipe 004', exact: true}).click();
  await page.getByRole('button', {name: 'Unfavourite Recipe 004', exact: true}).waitFor();
  await page.getByRole('button', {name: 'Add to plan', exact: true}).click();
  assert.equal(await page.evaluate(() => window.qa.navigation.at(-1).params.recipeId), '004');
  await page.getByRole('button', {name: 'Notes', exact: true}).click();
  await page.getByRole('textbox', {name: 'Household cooking notes'}).fill('Keep this unfinished draft');
  await show('005'); await show('004');
  assert.equal(await page.getByRole('textbox', {name: 'Household cooking notes'}).inputValue(), 'Keep this unfinished draft');
  await page.getByRole('button', {name: 'Save', exact: true}).click();
  await page.getByText('Keep this unfinished draft', {exact: true}).waitFor();
  assert.equal(await page.evaluate(() => window.qa.saved.at(-1).id), '004');
  // A previously failed image must recover when its saved sources change.
  await show('003');
  await page.evaluate(() => { const data = window.qa.getSnapshot(); window.qa.change({recipes: {...data.recipes, '003': {...data.recipes['003'], imageUrl: '/ok/repaired.svg'}}}); });
  await loaded('/ok/repaired.svg');
  await search.fill('');
  await page.getByRole('button', {name: 'Favourites', exact: true}).click();
  await page.getByText('1 recipes', {exact: true}).waitFor();
  await page.getByRole('button', {name: 'Favourites', exact: true}).click();
  await search.fill('LENTILS'); await page.getByText('100 recipes', {exact: true}).waitFor();
  await search.fill(''); await page.getByText('200 recipes', {exact: true}).waitFor();
  // Verify notes survive real window eviction as well as filtering.
  await show('080');
  await page.getByRole('button', {name: 'Notes', exact: true}).click();
  await page.getByRole('textbox', {name: 'Household cooking notes'}).fill('Scroll-retained draft');
  await search.fill('');
  await page.evaluate(() => { window.qa.scrollElement = [...document.querySelectorAll('div')].find(el => ['auto', 'scroll'].includes(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight); });
  assert(await page.evaluate(() => !!window.qa.scrollElement), 'Expected a bounded list scroll container');
  for (let i = 0; i < 6; i++) {
    await page.evaluate(() => {const el = window.qa.scrollElement; el.scrollTop = Math.min(el.scrollTop + 6000, el.scrollHeight - el.clientHeight);});
    await page.waitForTimeout(150);
  }
  const scrolledCards = await page.getByRole('heading', {name: /^Recipe /}).count();
  assert(scrolledCards < 30, `List grew to ${scrolledCards} mounted cards after scrolling`);
  await page.evaluate(() => {window.qa.scrollElement.scrollTop = 0;});
  await show('080');
  assert.equal(await page.getByRole('textbox', {name: 'Household cooking notes'}).inputValue(), 'Scroll-retained draft');
  await page.getByRole('button', {name: 'Cancel', exact: true}).click();
  await show('004');
  await page.screenshot({path: resolve(output, 'placeholder.png'), fullPage: true});
  assert.deepEqual(errors, []);
  const result = {passed: true, fixtureRecipes: 200, initialCards, scrolledCards,
    checks: ['primary image', 'failed primary fallback', 'saved video poster', 'all images failed', 'placeholder opens recipe',
      'favourite', 'add to plan', 'notes survive filtering and scrolling', 'save notes', 'source changes reset image failures',
      'ingredient search', 'favourites filter', 'windowed rendering', 'no video players', 'no browser runtime errors']};
  await writeFile(resolve(output, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser?.close();
  await new Promise(done => server.close(done));
}
