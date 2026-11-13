import { normaliseTargets } from './plannedNutrition';
// ============================================================
// Meal Wizard — Firestore Service
// Centralized module for ALL Firestore operations.
// No other file should import from 'firebase/firestore' directly.
// ============================================================

import { db } from '@/config/firebase';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  onSnapshot,
  Timestamp,
  writeBatch,
  serverTimestamp,
  runTransaction,
} from 'firebase/firestore';
import { logEvent } from './devLog';
import { legacyRecipeClient } from './legacyRecipeClient';
import { decodeRecipeDocument } from './recipeDecoder';
import { workflowCommand } from './connectedClient';
import { normaliseMeal, type Workflow, type Period, type Meal, type Draft } from '../functions/src/connected/model';
import type { CatalogueGenerationMode } from './generationDispatcher';
import type {
  GenerateConfig,
  GeneratedMeal,
  Household,
  HouseholdSettings,
  UserProfile,
  Recipe,
  MealPlanEntry,
  ShoppingItem,
  CookbookEntry,
} from './types';

// ─── Helpers ───────────────────────────────────────────────

/**
 * Race a Firestore promise against a timeout. If the inner Promise doesn't
 * settle by `ms` milliseconds, the wrapper rejects with a "<label> timeout"
 * error so the surrounding try/catch can react (e.g. move on to the next
 * candidate URL during scraping) instead of stalling forever.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms),
    ),
  ]);
}

// ─── Household Operations ──────────────────────────────────

/** Fetch household data */
export async function getHousehold(householdId: string): Promise<Household | null> {
  const snap = await getDoc(doc(db, 'households', householdId));
  return snap.exists() ? (snap.data() as Household) : null;
}

// ─── User Profile Operations ──────────────────────────────

/** Get user profile */
export async function getUserProfile(userId: string): Promise<UserProfile | null> {
  const snap = await getDoc(doc(db, 'users', userId));
  return snap.exists() ? (snap.data() as UserProfile) : null;
}

// ─── Authentication Allowlist ────────────────────────────────

/** Check if an email is on the allowlist to use the app. */
export async function isEmailAllowed(email: string): Promise<boolean> {
  if (!email) return false;
  // Simplest approach: The Document ID in the 'allowlist' collection is the email address.
  const snap = await getDoc(doc(db, 'allowlist', email.toLowerCase().trim()));
  return snap.exists();
}

// ─── Recipe Operations ─────────────────────────────────────

/** Save a scraped recipe to the root recipes collection */
export async function saveRecipe(householdId: string, recipe: Recipe): Promise<string> {
  return withTimeout(
    legacyRecipeClient.save(householdId, recipe),
    15000,
    'saveRecipe',
  );
}

/** Get a recipe by ID */
export async function getRecipe(recipeId: string): Promise<Recipe | null> {
  const snap = await withTimeout(getDoc(doc(db, 'recipes', recipeId)), 10000, 'getRecipe');
  if (!snap.exists()) return null;
  return decodeRecipeDocument(snap.id, snap.data());
}

/** Read the operator-controlled generator mode. Missing/invalid config fails closed. */
export async function getCatalogueGenerationMode(): Promise<CatalogueGenerationMode> {
  const snapshot = await withTimeout(
    getDoc(doc(db, 'appConfig', 'catalogue')),
    10000,
    'getCatalogueGenerationMode',
  );
  const mode = snapshot.exists() ? snapshot.data().generationMode : undefined;
  if (mode !== 'legacy' && mode !== 'catalogue') {
    throw new Error('Generation mode is unavailable.');
  }
  return mode;
}

/** Check if a recipe with this source URL already exists (cache check) */
export async function getCachedRecipeByUrl(url: string): Promise<Recipe | null> {
  const q = query(collection(db, 'recipes'), where('sourceUrl', '==', url));
  const snapshot = await withTimeout(getDocs(q), 10000, 'getCachedRecipeByUrl');
  if (snapshot.empty) return null;
  const docSnap = snapshot.docs[0];
  return decodeRecipeDocument(docSnap.id, docSnap.data());
}

// ─── Household Settings ────────────────────────────────────

const DEFAULT_SETTINGS: HouseholdSettings = {
  sourceWeights: {},
  ingredientWeights: {},
  selectedSeeds: [],
  defaultAdults: 2,
  defaultChildren: 2,
  strictMatching: true,
};

// Firestore does not allow dots in field names. Encode/decode site keys for storage.
function encodeSiteKey(site: string): string { return site.replace(/\./g, '_'); }
function decodeSiteKey(key: string): string { return key.replace(/_/g, '.'); }

/** Load generation settings for a household (empty defaults if not yet saved). */
export async function getHouseholdSettings(householdId: string): Promise<HouseholdSettings> {
  const snap = await getDoc(doc(db, 'households', householdId, 'settings', 'preferences'));
  if (!snap.exists()) return { ...DEFAULT_SETTINGS };
  const raw = snap.data() as {
    excludedIngredients?: string[];
    sourceWeights?: Record<string, number>;
    ingredientWeights?: Record<string, number>;
    selectedSeeds?: string[];
    kidFriendly?: { excludedIngredients?: string[]; allowedExceptions?: string[] };
    mealReminders?: HouseholdSettings['mealReminders'];
    defaultAdults?: number;
    defaultChildren?: number;
    strictMatching?: boolean;
    nutritionTargets?: HouseholdSettings['nutritionTargets'];
  };
  const sourceWeights: Record<string, number> = {};
  Object.entries(raw.sourceWeights ?? {}).forEach(([k, v]) => {
    sourceWeights[decodeSiteKey(k)] = v;
  });
  return {
    sourceWeights,
    excludedIngredients: raw.excludedIngredients ?? [],
    ingredientWeights: raw.ingredientWeights ?? {},
    selectedSeeds: raw.selectedSeeds ?? [],
    kidFriendly: raw.kidFriendly,
    mealReminders: raw.mealReminders,
    defaultAdults: raw.defaultAdults ?? 2,
    defaultChildren: raw.defaultChildren ?? 2,
    strictMatching: raw.strictMatching ?? true,
    nutritionTargets: normaliseTargets(raw.nutritionTargets),
  };
}

/** Persist generation settings for a household. */
export async function saveHouseholdSettings(
  householdId: string,
  settings: HouseholdSettings
): Promise<void> {
  const encodedSourceWeights: Record<string, number> = {};
  Object.entries(settings.sourceWeights).forEach(([k, v]) => {
    encodedSourceWeights[encodeSiteKey(k)] = v;
  });
  await setDoc(doc(db, 'households', householdId, 'settings', 'preferences'), {
    excludedIngredients: settings.excludedIngredients ?? [],
    sourceWeights: encodedSourceWeights,
    ingredientWeights: settings.ingredientWeights,
    selectedSeeds: settings.selectedSeeds ?? [],
    defaultAdults: settings.defaultAdults ?? 2,
    defaultChildren: settings.defaultChildren ?? 2,
    strictMatching: settings.strictMatching ?? true,
    ...(settings.nutritionTargets ? { nutritionTargets: normaliseTargets(settings.nutritionTargets) } : {}),
    ...(settings.kidFriendly ? { kidFriendly: settings.kidFriendly } : {}),
    ...(settings.mealReminders ? { mealReminders: settings.mealReminders } : {}),
  });
}

/** Update the Gemini-assigned tags on a cached recipe. */
export async function updateRecipeTags(
  householdId: string,
  recipeId: string,
  tags: string[],
): Promise<void> {
  await legacyRecipeClient.update(householdId, recipeId, { tags });
}

// ─── Recipe Cache Operations ────────────────────────────────

// ─── Meal Plan Operations ──────────────────────────────────

/** Add a meal plan entry */
export async function addMealPlanEntry(householdId: string, entry: MealPlanEntry): Promise<void> {
  const docId = `${entry.date}_${entry.mealType}`;
  await setDoc(
    doc(db, 'households', householdId, 'mealPlan', docId),
    {
      recipeId: entry.recipeId,
      date: entry.date,
      mealType: entry.mealType,
      ...(entry.servings != null ? { servings: entry.servings } : {}),
      ...(entry.adults != null ? { adults: entry.adults } : {}),
      ...(entry.children != null ? { children: entry.children } : {}),
    }
  );
}

/** Update servings (and adults/children) on an existing meal plan entry. */
export async function updateMealPlanServings(
  householdId: string,
  entryId: string,
  adults: number,
  children: number,
  servings: number,
  expectedRevision?: number,
): Promise<void> {
  const household = await getHousehold(householdId);
  if ((household as Household & { workflowVersion?: number })?.workflowVersion === 2) {
    const snapshot = await getDoc(doc(db, 'households', householdId, 'mealPlan', entryId));
    if (!snapshot.exists()) throw new Error('This meal is no longer planned.');
    const meal = normaliseMeal(snapshot.id, snapshot.data());
    if (expectedRevision === undefined || meal.revision !== expectedRevision) throw new Error('This planned meal changed. Close and reopen it before changing servings.');
    await workflowCommand(householdId, { operation: 'mutate', changes: [{ meal: { ...meal, adults, children, servings }, expectedRevision }] });
    return;
  }
  await updateDoc(
    doc(db, 'households', householdId, 'mealPlan', entryId),
    { adults, children, servings }
  );
}

/** Delete a meal plan entry */
export async function deleteMealPlanEntry(householdId: string, entryId: string): Promise<void> {
  await deleteDoc(doc(db, 'households', householdId, 'mealPlan', entryId));
}

/** Subscribe to meal plan in real time */
export function subscribeMealPlan(
  householdId: string,
  callback: (entries: MealPlanEntry[]) => void
): () => void {
  const q = query(
    collection(db, 'households', householdId, 'mealPlan'),
    orderBy('date', 'asc')
  );
  return onSnapshot(q, (snapshot) => {
    const entries: MealPlanEntry[] = snapshot.docs.map((d) => ({
      id: d.id,
      ...d.data(),
    })) as MealPlanEntry[];
    callback(entries);
  });
}

// ─── Shopping List Operations ──────────────────────────────

/** Add an item to the shopping list */
export async function addShoppingItem(householdId: string, item: Omit<ShoppingItem, 'id'>): Promise<string> {
  const docRef = await addDoc(
    collection(db, 'households', householdId, 'shoppingList'),
    item
  );
  return docRef.id;
}

/** Add multiple shopping items (batch) */
export async function addShoppingItems(householdId: string, items: Omit<ShoppingItem, 'id'>[]): Promise<void> {
  const collectionRef = collection(db, 'households', householdId, 'shoppingList');
  // Stay below Firestore's 500-operation batch limit. Typical lists fit in one
  // commit; unusually large plans remain writeable instead of failing outright.
  for (let start = 0; start < items.length; start += 450) {
    const batch = writeBatch(db);
    items.slice(start, start + 450).forEach((item) => {
      const ref = doc(collectionRef);
      batch.set(ref, shoppingItemData(item));
    });
    await batch.commit();
  }
}

function shoppingItemData(item: Omit<ShoppingItem, 'id'>): Record<string, unknown> {
  // Firestore rejects `undefined` field values — strip them before writing.
  return Object.fromEntries(Object.entries(item).filter(([, value]) => value !== undefined));
}

/**
 * Atomically replace the shopping list after the new aggregation is complete.
 * Refuse oversized replacements before deleting anything; this preserves the
 * existing list if Firestore cannot perform the replacement as one commit.
 */
export async function replaceShoppingItems(
  householdId: string,
  items: Omit<ShoppingItem, 'id'>[],
): Promise<void> {
  const collectionRef = collection(db, 'households', householdId, 'shoppingList');
  const snapshot = await getDocs(collectionRef);
  if (snapshot.size + items.length > 500) {
    throw new Error('Shopping list is too large to replace safely. Clear purchased items and try again.');
  }
  const batch = writeBatch(db);
  snapshot.docs.forEach((document) => batch.delete(document.ref));
  items.forEach((item) => batch.set(doc(collectionRef), shoppingItemData(item)));
  await batch.commit();
}

export function subscribeWorkflow(householdId: string, callback: (state: Workflow | null) => void, error: (error: Error) => void): () => void {
  return onSnapshot(doc(db,'households',householdId,'connected','state'), s=>{if(!s.exists()&&s.metadata.fromCache)return;callback(s.exists()?s.data() as Workflow:null);}, error);
}
export function subscribeHouseholdSettings(householdId:string, callback:(settings:HouseholdSettings)=>void, error:(error:Error)=>void):()=>void {
  let active=true;
  const unsubscribe=onSnapshot(doc(db,'households',householdId,'settings','preferences'),()=>{getHouseholdSettings(householdId).then(s=>{if(active)callback(s);}).catch(error);},error);
  return()=>{active=false;unsubscribe();};
}
export function subscribeConnectedMeals(householdId: string, callback: (meals: Meal[]) => void, error: (error: Error) => void): () => void {
  return onSnapshot(collection(db,'households',householdId,'mealPlan'), s=>callback(s.docs.map(d=>normaliseMeal(d.id,d.data()))), error);
}
export function subscribeShoppingPeriod(householdId:string,id:string,callback:(period:Period)=>void,error:(error:Error)=>void):()=>void {
  return onSnapshot(doc(db,'households',householdId,'shoppingPeriods',id),s=>{if(s.exists())callback(s.data() as Period);},error);
}
export function subscribeDrafts(householdId:string,callback:(drafts:Draft[])=>void,error:(error:Error)=>void):()=>void {
  return onSnapshot(collection(db,'households',householdId,'drafts'),s=>callback(s.docs.map(d=>d.data() as Draft)),error);
}
export async function listShoppingPeriods(householdId:string):Promise<Period[]> {
  const snapshot=await getDocs(collection(db,'households',householdId,'shoppingPeriods'));
  return snapshot.docs.map(d=>d.data() as Period).sort((a,b)=>b.start.localeCompare(a.start));
}
export async function updateCookbookDetails(householdId:string,recipeId:string,details:{notes?:string;collections?:string[];lastCookedAt?:string;effort?:string}):Promise<void> {
  await setDoc(doc(db,'households',householdId,'cookbook',recipeId),details,{merge:true});
}
export interface PlanTemplate {id:string;name:string;start:string;meals:Meal[]}
export async function savePlanTemplate(householdId:string,template:PlanTemplate):Promise<void> {
  await setDoc(doc(db,'households',householdId,'planTemplates',template.id),JSON.parse(JSON.stringify(template)));
}
export async function getPlanTemplates(householdId:string):Promise<PlanTemplate[]> {
  const snapshot=await getDocs(collection(db,'households',householdId,'planTemplates'));return snapshot.docs.map(d=>d.data() as PlanTemplate);
}

/** Toggle an item's checked state */
export async function toggleShoppingItem(
  householdId: string,
  itemId: string,
  checked: boolean
): Promise<void> {
  await updateDoc(
    doc(db, 'households', householdId, 'shoppingList', itemId),
    { checked }
  );
}

/** Subscribe to shopping list in real time */
export function subscribeShoppingList(
  householdId: string,
  callback: (items: ShoppingItem[]) => void
): () => void {
  const q = collection(db, 'households', householdId, 'shoppingList');
  return onSnapshot(q, (snapshot) => {
    const items: ShoppingItem[] = snapshot.docs.map((d) => ({
      id: d.id,
      ...d.data(),
    })) as ShoppingItem[];
    callback(items);
  });
}

/** Delete a single shopping list item */
export async function deleteShoppingItem(householdId: string, itemId: string): Promise<void> {
  await deleteDoc(doc(db, 'households', householdId, 'shoppingList', itemId));
}

/** Clear all purchased (checked) items */
export async function clearPurchasedItems(householdId: string): Promise<void> {
  const q = query(
    collection(db, 'households', householdId, 'shoppingList'),
    where('checked', '==', true)
  );
  const snapshot = await getDocs(q);
  const batch = writeBatch(db);
  snapshot.docs.forEach((d) => batch.delete(d.ref));
  await batch.commit();
}

/** Count the number of unpurchased (unchecked) items currently on the list. */
export async function countUnpurchasedShoppingItems(householdId: string): Promise<number> {
  const q = query(
    collection(db, 'households', householdId, 'shoppingList'),
    where('checked', '==', false)
  );
  const snapshot = await getDocs(q);
  return snapshot.size;
}

/** Add a manual item to the shopping list */
export async function addManualItem(
  householdId: string,
  name: string,
  quantity: number = 1,
  unit: string = '',
  category: ShoppingItem['category'] = 'Other'
): Promise<string> {
  return addShoppingItem(householdId, {
    name,
    quantity,
    unit,
    category,
    checked: false,
    manual: true,
  });
}

/** Update the quantity of a shopping list item */
export async function updateShoppingItemQuantity(
  householdId: string,
  itemId: string,
  quantity: number
): Promise<void> {
  await updateDoc(
    doc(db, 'households', householdId, 'shoppingList', itemId),
    { quantity }
  );
}

// ─── Cookbook Operations ────────────────────────────────────

/** Add a recipe to the household cookbook */
export async function addToCookbook(householdId: string, recipeId: string): Promise<void> {
  const ref = doc(db, 'households', householdId, 'cookbook', recipeId);
  await runTransaction(db, async tx => { if (!(await tx.get(ref)).exists()) tx.set(ref, { recipeId, starred: false, addedAt: serverTimestamp() }); });
}

/** Remove a recipe from the household cookbook. */
export async function removeFromCookbook(householdId: string, recipeId: string): Promise<void> {
  await deleteDoc(doc(db, 'households', householdId, 'cookbook', recipeId));
}

/** Toggle a recipe's starred status in the cookbook */
export async function toggleStarred(
  householdId: string,
  recipeId: string,
  starred: boolean
): Promise<void> {
  const ref = doc(db, 'households', householdId, 'cookbook', recipeId);
  await runTransaction(db, async tx => {
    const existing = await tx.get(ref);
    if (existing.exists()) tx.update(ref, { starred });
    else if (starred) tx.set(ref, { recipeId, starred: true, addedAt: serverTimestamp() });
  });
}

// ─── Generation Result Persistence ────────────────────────────
// Stored at households/{householdId}/generationResult/pending so results
// survive app restarts until the user has visited the results screen.

type StoredMeal = Omit<GeneratedMeal, 'recipe'> & {
  recipe: Omit<GeneratedMeal['recipe'], 'scrapedAt'> & { scrapedAt: Timestamp };
};

type StoredGenerationDoc = {
  meals: StoredMeal[];
  config: Omit<GenerateConfig, 'startDate' | 'settings'> & { startDate: string };
  savedAt: ReturnType<typeof serverTimestamp>;
};

/** Persist a completed generation result so it survives app restarts. */
export async function saveGenerationResult(
  householdId: string,
  meals: GeneratedMeal[],
  config: GenerateConfig,
): Promise<void> {
  const { settings: _settings, startDate, ...restConfig } = config;
  const storedMeals: StoredMeal[] = meals.map((m) => ({
    ...m,
    recipe: {
      ...m.recipe,
      scrapedAt: Timestamp.fromDate(m.recipe.scrapedAt || new Date()),
    },
  }));
  await withTimeout(
    setDoc(
      doc(db, 'households', householdId, 'generationResult', 'pending'),
      { meals: storedMeals, config: { ...restConfig, startDate: startDate.toISOString() }, savedAt: serverTimestamp() },
    ),
    15000,
    'saveGenerationResult',
  );
}

/** Load a persisted generation result, or null if none exists. */
export async function loadGenerationResult(
  householdId: string,
): Promise<{ meals: GeneratedMeal[]; config: GenerateConfig } | null> {
  const snap = await withTimeout(
    getDoc(doc(db, 'households', householdId, 'generationResult', 'pending')),
    10000,
    'loadGenerationResult',
  );
  if (!snap.exists()) return null;
  const data = snap.data() as StoredGenerationDoc;
  const meals: GeneratedMeal[] = (data.meals as StoredMeal[]).map((m) => ({
    ...m,
    recipe: {
      ...m.recipe,
      scrapedAt: m.recipe.scrapedAt?.toDate?.() ?? new Date(),
    },
  }));
  return {
    meals,
    config: {
      ...data.config,
      startDate: new Date(data.config.startDate),
    } as GenerateConfig,
  };
}

/** Delete the persisted generation result (idempotent). */
export async function clearGenerationResult(householdId: string): Promise<void> {
  await withTimeout(
    deleteDoc(doc(db, 'households', householdId, 'generationResult', 'pending')),
    10000,
    'clearGenerationResult',
  );
}

/** Subscribe to cookbook in real time */
export function subscribeCookbook(
  householdId: string,
  callback: (entries: CookbookEntry[]) => void
): () => void {
  const q = collection(db, 'households', householdId, 'cookbook');
  return onSnapshot(q, (snapshot) => {
    const entries: CookbookEntry[] = snapshot.docs.map((d) => ({
      id: d.id,
      ...d.data(),
      addedAt: d.data().addedAt?.toDate?.() || new Date(),
    })) as CookbookEntry[];
    callback(entries);
  });
}

/** Get all starred recipes from the cookbook */
export async function getStarredRecipes(householdId: string): Promise<CookbookEntry[]> {
  const q = query(
    collection(db, 'households', householdId, 'cookbook'),
    where('starred', '==', true)
  );
  const snapshot = await getDocs(q);
  return snapshot.docs.map((d) => ({
    id: d.id,
    ...d.data(),
    addedAt: d.data().addedAt?.toDate?.() || new Date(),
  })) as CookbookEntry[];
}

// ─── Meal Reminder Helpers ───────────────────────────────────

/** Persist Gemini-detected reminder flags onto the cached recipe doc. */
export async function updateRecipeFlags(
  householdId: string,
  recipeId: string,
  flags: { needsDefrost?: boolean; needsMarinate?: boolean },
): Promise<void> {
  const update: Record<string, boolean> = {};
  if (typeof flags.needsDefrost === 'boolean') update.needsDefrost = flags.needsDefrost;
  if (typeof flags.needsMarinate === 'boolean') update.needsMarinate = flags.needsMarinate;
  if (Object.keys(update).length === 0) return;
  await withTimeout(
    legacyRecipeClient.update(householdId, recipeId, update),
    10000,
    'updateRecipeFlags',
  );
}

/** Bump the "last confirmed at" marker so every household device knows to re-sync reminders. */
export async function bumpMealReminderState(householdId: string): Promise<void> {
  await withTimeout(
    setDoc(
      doc(db, 'households', householdId, 'state', 'mealReminders'),
      { lastConfirmedAt: serverTimestamp() },
    ),
    10000,
    'bumpMealReminderState',
  );
}

/** Listen for changes to the household's meal-reminder state. Fires `cb` with the
 *  current `lastConfirmedAt` Date on each snapshot (and immediately if the doc exists).
 *  Listener errors are logged via devLog so they don't disappear silently. */
export function subscribeMealReminderState(
  householdId: string,
  cb: (lastConfirmedAt: Date | null) => void,
): () => void {
  return onSnapshot(
    doc(db, 'households', householdId, 'state', 'mealReminders'),
    (snap) => {
      if (!snap.exists()) {
        cb(null);
        return;
      }
      const ts = snap.data().lastConfirmedAt as Timestamp | undefined;
      cb(ts?.toDate?.() ?? null);
    },
    (err) => {
      logEvent('warn', 'subscribeMealReminderState', 'listener error', (err as { code?: string }).code, err.message);
    },
  );
}

/** Fetch all upcoming meal plan entries (today onward) plus their recipes. */
export async function getUpcomingMealPlan(
  householdId: string,
): Promise<{ meals: MealPlanEntry[]; recipes: Map<string, Recipe> }> {
  const now = new Date();
  const todayISO = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const mealsSnap = await withTimeout(
    getDocs(query(collection(db, 'households', householdId, 'mealPlan'), where('date', '>=', todayISO))),
    10000,
    'getUpcomingMealPlan',
  );
  const meals: MealPlanEntry[] = mealsSnap.docs
    .filter(d=>!['removed','skipped','cooked'].includes(d.data().status) && (!d.data().kind||d.data().kind==='recipe'))
    .flatMap((d) => { const meal={ id:d.id,...d.data() } as MealPlanEntry; return [meal,...((d.data().sides??[]) as {recipeId:string;servings:number}[]).map(side=>({...meal,...side}))]; });

  const recipes = new Map<string, Recipe>();
  const uniqueIds = Array.from(new Set(meals.map((m) => m.recipeId)));
  await Promise.all(
    uniqueIds.map(async (id) => {
      const r = await getRecipe(id);
      if (r) recipes.set(id, r);
    }),
  );
  return { meals, recipes };
}

/** IDs used for current-plan and 28-day recent-use catalogue exclusions. */
export async function getGenerationRecipeHistory(
  householdId: string,
  planStartDate: Date,
): Promise<{ currentPlanRecipeIds: string[]; recentRecipeIds: string[] }> {
  const format = (date: Date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const recentStart = new Date(planStartDate);
  recentStart.setDate(recentStart.getDate() - 28);
  const planStart = format(planStartDate);
  const snapshot = await withTimeout(
    getDocs(query(
      collection(db, 'households', householdId, 'mealPlan'),
      where('date', '>=', format(recentStart)),
    )),
    10000,
    'getGenerationRecipeHistory',
  );
  const current = new Set<string>();
  const recent = new Set<string>();
  for (const document of snapshot.docs) {
    if (['removed', 'skipped'].includes(document.data().status)) continue;
    const recipeId = document.data().recipeId;
    const date = document.data().date;
    if (typeof recipeId !== 'string' || typeof date !== 'string') continue;
    (date >= planStart ? current : recent).add(recipeId);
  }
  return {
    currentPlanRecipeIds: [...current].slice(0, 500),
    recentRecipeIds: [...recent].slice(0, 500),
  };
}
