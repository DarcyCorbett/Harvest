import React, {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useCallback,
} from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Alert, Platform } from 'react-native';
import ShoppingChoice from '@/components/connected/ShoppingChoice';
import { drainShoppingChecks, shoppingCheckObserved } from '@/services/shoppingCheckSync';
import { shoppingIsUpdating, commandHasItem } from '@/services/shoppingPresentation';
import NetInfo from "@react-native-community/netinfo";
import { useAuth } from "./AuthContext";
import {
  subscribeWorkflow,
  subscribeHouseholdSettings,
  subscribeConnectedMeals,
  subscribeShoppingPeriod,
  subscribeDrafts,
  subscribeCookbook,
  getRecipe,
  getHouseholdSettings,
} from "@/services/firestoreService";
import {
  cacheKey,
  workflowCommand,
  requestId,
  readChecks,
  writeChecks,
  weekRange,
  type Workflow,
  type Period,
  type Meal,
  type Draft,
  type ListItem,
  type PendingCheck,
} from "@/services/connectedClient";
import type {
  Recipe,
  CookbookEntry,
  HouseholdSettings,
} from "@/services/types";

interface ConnectedState {
  state: Workflow | null;
  period: Period | null;
  meals: Meal[];
  recipes: Record<string, Recipe>;
  cookbook: CookbookEntry[];
  drafts: Draft[];
  settings: HouseholdSettings;
  online: boolean;
  loading: boolean;
  shoppingUpdating: boolean;
  error: string;
  pending: PendingCheck[];
  run: <T = { ok: boolean }>(command: unknown, id?: string) => Promise<T>;
  check: (
    item: ListItem,
    action: "check" | "uncheck" | "dismiss" | "restore" | "delete",
  ) => Promise<void>;
  checkGroup: (items: ListItem[], action: 'check' | 'uncheck' | 'delete') => Promise<void>;
  load: (id: string) => Promise<Recipe | null>;
  refreshRecipes: (recipes: Map<string, Recipe>) => void;
  retry: () => void;
  dismissPending: (id: string) => Promise<void>;
}
const Context = createContext<ConnectedState | null>(null);

// Recipes are shared, rarely change and are the bulk of what the app reads.
// Each one is cached under its own key so a cold start needs no network for
// them, and no single stored value grows with the size of the cookbook.
const RECIPE_CACHE_PREFIX = 'recipes:v1:';
const RECIPE_FRESH_MS = 24 * 60 * 60 * 1000;
const RECIPE_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
async function readRecipeCache(): Promise<{ recipes: Record<string, Recipe>; cachedAt: Map<string, number> }> {
  const recipes: Record<string, Recipe> = {};
  const cachedAt = new Map<string, number>();
  const keys = (await AsyncStorage.getAllKeys()).filter((key) => key.startsWith(RECIPE_CACHE_PREFIX));
  const expired: string[] = [];
  for (let i = 0; i < keys.length; i += 50) {
    for (const [key, raw] of await AsyncStorage.multiGet(keys.slice(i, i + 50))) {
      try {
        const entry = JSON.parse(raw ?? '') as { at: number; recipe: Recipe };
        if (!entry.recipe?.id || Date.now() - entry.at > RECIPE_KEEP_MS) { expired.push(key); continue; }
        recipes[entry.recipe.id] = entry.recipe;
        cachedAt.set(entry.recipe.id, entry.at);
      } catch {
        expired.push(key);
      }
    }
  }
  if (expired.length) AsyncStorage.multiRemove(expired).catch(() => {});
  return { recipes, cachedAt };
}
function writeRecipeCache(recipe: Recipe): void {
  if (!recipe.id) return;
  AsyncStorage.setItem(RECIPE_CACHE_PREFIX + recipe.id, JSON.stringify({ at: Date.now(), recipe })).catch(() => {});
}
export function useConnected(): ConnectedState {
  const value = useContext(Context);
  if (!value) throw new Error("Connected provider missing");
  return value;
}
export function ConnectedProvider({ children }: { children: React.ReactNode }) {
  const { householdId, user } = useAuth();
  const owner = `${householdId}:${user?.uid}`;
  const currentOwner = useRef(owner);
  currentOwner.current = owner;
  const [state, setState] = useState<Workflow | null>(null);
  const [period, setPeriod] = useState<Period | null>(null);
  const [meals, setMeals] = useState<Meal[]>([]);
  const [recipes, setRecipes] = useState<Record<string, Recipe>>({});
  const [cookbook, setCookbook] = useState<CookbookEntry[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [settings, setSettings] = useState<HouseholdSettings>({
    sourceWeights: {},
    ingredientWeights: {},
  });
  const [online, setOnline] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<PendingCheck[]>([]);
  const [queueLoaded, setQueueLoaded] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const queueWrites = useRef(Promise.resolve());
  const kickCheckSync = useRef<() => void>(() => {});
  const periodRef = useRef(period);
  useLayoutEffect(() => { periodRef.current = period; }, [period]);
  const recipesRef = useRef(recipes);
  recipesRef.current = recipes;
  /** When each recipe was last read from the server or the device cache. */
  const recipeFetchedAt = useRef(new Map<string, number>());
  const [recipeCacheReady, setRecipeCacheReady] = useState(false);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const commandAttempts = useRef(new Map<string, { id: string; command: unknown }>());
  const [shoppingChoice, setShoppingChoice] = useState<((choice: 'keep' | 'replace' | null) => void) | null>(null);
  const choiceRef = useRef<((choice: 'keep' | 'replace' | null) => void) | null>(null);
  const workflowRef = useRef(state);
  useLayoutEffect(() => { workflowRef.current = state; }, [state]);
  const run = useCallback(
    async <T,>(command: unknown, id?: string): Promise<T> => {
      if (!householdId) throw new Error("Sign in to your household.");
      if (!online)
        throw new Error("Connect to the internet to change your plan.");
      const key = JSON.stringify([householdId, user?.uid, command]);
      let attempt = commandAttempts.current.get(key);
      if (!attempt) {
        const submitted = { ...(command as Record<string, any>) };
        const list = periodRef.current;
        if (submitted.operation === 'mutate') {
          if (!list?.shopping) throw new Error('Shopping list is loading. Please retry.');
          const additions: string[] = submitted.shoppingMealIds ?? submitted.changes
            .filter((c: { expectedRevision: number; meal: Meal }) => c.expectedRevision === 0 && c.meal.kind === 'recipe' && !['removed', 'skipped'].includes(c.meal.status))
            .map((c: { meal: Meal }) => c.meal.id);
          delete submitted.shoppingMealIds;
          if (additions.length) {
            if (pendingRef.current.length || workflowRef.current?.status !== 'ready')
              throw new Error('Wait for shopping changes to finish syncing before adding meals.');
            const mode = list.items.length ? await new Promise<'keep' | 'replace' | null>(resolve => {
              if (choiceRef.current) throw new Error('Finish the current shopping choice first.');
              const choose = (value: 'keep' | 'replace' | null) => { choiceRef.current = null; setShoppingChoice(null); resolve(value); };
              choiceRef.current = choose;
              if (Platform.OS === 'web') setShoppingChoice(() => choose);
              else Alert.alert('Update shopping list', 'Keep your existing items and add these ingredients, or replace the whole list? Replacing also clears manual and purchased items.', [
                { text: 'Cancel', style: 'cancel', onPress: () => choose(null) },
                { text: 'Keep existing items', onPress: () => choose('keep') },
                { text: 'Replace list', style: 'destructive', onPress: () => choose('replace') },
              ], { cancelable: true, onDismiss: () => choose(null) });
            }) : 'keep';
            if (!mode || currentOwner.current !== owner) {
              const error = new Error('Shopping update cancelled.'); error.name = 'ShoppingCancelled'; throw error;
            }
            submitted.shopping = { mode, mealIds: additions, expectedRevision: list.revision, generation: list.shopping.generation };
          }
        }
        if (submitted.operation === 'manual' && list?.shopping) submitted.generation = list.shopping.generation;
        attempt = { id: id ?? requestId(), command: submitted };
        commandAttempts.current.set(key, attempt);
      }
      try {
        const result = await workflowCommand<T>(householdId, attempt.command, attempt.id);
        commandAttempts.current.delete(key);
        return result;
      } catch (e) {
        if (/aborted|failed-precondition|invalid-argument/.test((e as { code?: string }).code ?? '')) commandAttempts.current.delete(key);
        const message =
          e instanceof Error ? e.message : "Could not save. Please retry.";
        throw new Error(message);
      }
    },
    [householdId, online, user?.uid, owner],
  );
  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener(n => setOnline(
      !(Platform.OS === 'web' && typeof navigator !== 'undefined' && !navigator.onLine)
      && n.isConnected !== false && n.isInternetReachable !== false,
    ));
    // On Chromium, NetInfo listens to connection changes but can miss window offline events.
    const browserOnline = () => { setOnline(navigator.onLine); if (navigator.onLine) void NetInfo.refresh(); };
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      window.addEventListener('online', browserOnline);
      window.addEventListener('offline', browserOnline);
    }
    return () => {
      unsubscribe();
      if (Platform.OS === 'web' && typeof window !== 'undefined') {
        window.removeEventListener('online', browserOnline);
        window.removeEventListener('offline', browserOnline);
      }
    };
  }, []);
  useEffect(() => {
    choiceRef.current?.(null);
    commandAttempts.current.clear();
    recipesRef.current = {};
    pendingRef.current = [];
    setState(null);
    setPeriod(null);
    setMeals([]);
    setRecipes({});
    setDrafts([]);
    setCookbook([]);
    setPending([]);
    setQueueLoaded(false);
    setRecipeCacheReady(false);
    setError("");
    setLoading(true);
    if (!householdId || !user) {
      setLoading(false);
      return;
    }
    let active = true;
    const owned = () => active && currentOwner.current === owner;
    const fail = (e: Error) => {
      if (owned()) {
        setError(e.message);
        setLoading(false);
      }
    };
    const key = cacheKey(householdId, user.uid, "snapshot");
    let fresh = false;
    readRecipeCache()
      .then(({ recipes: cachedRecipes, cachedAt }) => {
        if (!owned()) return;
        cachedAt.forEach((at, id) => { if (!recipeFetchedAt.current.has(id)) recipeFetchedAt.current.set(id, at); });
        setRecipes((prev) => ({ ...cachedRecipes, ...prev }));
      })
      .catch(() => {})
      .finally(() => { if (owned()) setRecipeCacheReady(true); });
    AsyncStorage.getItem(key)
      .then((raw) => {
        if (raw && owned()) {
          const cached = JSON.parse(raw);
          // Snapshots written by older app versions carried recipes inline.
          if (cached.recipes) setRecipes((prev) => ({ ...cached.recipes, ...prev }));
          if (fresh) return;
          setCookbook(cached.cookbook ?? []);
          setDrafts(cached.drafts ?? []);
          setSettings(
            cached.settings ?? { sourceWeights: {}, ingredientWeights: {} },
          );
          setState(cached.state);
          setPeriod(cached.period);
          setMeals(cached.meals ?? []);
          setLoading(false);
        }
      })
      .catch(() => {});
    readChecks(householdId, user.uid).then((v) => {
      if (owned()) { setPending(v); setQueueLoaded(true); }
    });
    getHouseholdSettings(householdId)
      .then((s) => {
        if (owned()) setSettings(s);
      })
      .catch(fail);
    let initialising = false;
    const subscriptions = [
      subscribeHouseholdSettings(householdId,s=>{if(owned())setSettings(s);},fail),
      subscribeWorkflow(
        householdId,
        (s) => {
          if (!owned()) return;
          fresh = true;
          setState(s);
          if (s) {
            setLoading(false);
            setError("");
          } else if (!initialising) {
            initialising = true;
            const range = weekRange();
            workflowCommand(householdId, {
              operation: "initialise",
              ...range,
            }).catch(fail);
          }
        },
        fail,
      ),
      subscribeConnectedMeals(
        householdId,
        (m) => {
          if (owned()) setMeals(m);
        },
        fail,
      ),
      subscribeDrafts(
        householdId,
        (d) => {
          if (owned()) setDrafts(d);
        },
        fail,
      ),
      subscribeCookbook(householdId, (c) => {
        if (owned()) setCookbook(c);
      }, fail),
    ];
    return () => {
      active = false;
      subscriptions.forEach((s) => s());
    };
  }, [householdId, user?.uid, owner, attempt]);
  useEffect(() => {
    if (!householdId || state?.status !== 'ready' || state.minShoppingClientVersion === 4 || !online || !queueLoaded || pending.length) return;
    let active = true;
    workflowCommand(householdId, { operation: 'migrateShopping' }).catch(e => {
      if (active) setError(e instanceof Error ? e.message : 'Could not update shopping list.');
    });
    return () => { active = false; };
  }, [householdId, state?.status, state?.minShoppingClientVersion, online, attempt, queueLoaded, pending.length]);
  useEffect(() => {
    if (!householdId || !state?.periodId) return;
    let active = true;
    const unsubscribe = subscribeShoppingPeriod(
      householdId,
      state.periodId,
      (p) => {
        if (active && currentOwner.current === owner) setPeriod(p);
      },
      (e) => {
        if (active) setError(e.message);
      },
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, [householdId, state?.periodId, owner]);
  const load = useCallback(
    async (id: string): Promise<Recipe | null> => {
      const known = recipesRef.current[id];
      const fetchedAt = recipeFetchedAt.current.get(id);
      if (known && fetchedAt !== undefined && Date.now() - fetchedAt < RECIPE_FRESH_MS) return known;
      let recipe: Recipe | null;
      try {
        recipe = await getRecipe(id);
      } catch (e) {
        // Offline or flaky: a slightly old copy beats no recipe.
        if (known) return known;
        throw e;
      }
      recipeFetchedAt.current.set(id, Date.now());
      if (recipe) writeRecipeCache(recipe);
      if (recipe && currentOwner.current === owner)
        setRecipes((prev) => ({ ...prev, [id]: { ...recipe,
          ...(typeof prev[id]?.needsDefrost === 'boolean' ? { needsDefrost: prev[id].needsDefrost } : {}),
          ...(typeof prev[id]?.needsMarinate === 'boolean' ? { needsMarinate: prev[id].needsMarinate } : {}),
        } }));
      return recipe;
    },
    [owner],
  );
  const refreshRecipes = useCallback((fresh: Map<string, Recipe>) => {
    if (currentOwner.current !== owner) return;
    fresh.forEach((recipe, id) => { recipeFetchedAt.current.set(id, Date.now()); writeRecipeCache(recipe); });
    setRecipes(prev => ({ ...prev, ...Object.fromEntries(fresh) }));
  }, [owner]);
  useEffect(() => {
    // Wait for the device cache so cached recipes are not fetched again.
    if (!recipeCacheReady) return;
    const ids = [
      ...new Set(
        [
          ...meals
            .filter((m) => m.status !== "removed")
            .flatMap((m) => [
              m.recipeId,
              ...(m.sides ?? []).map((s) => s.recipeId),
            ]),
          ...cookbook.map((c) => c.recipeId),
          ...drafts.flatMap((d) =>
            d.slots.flatMap((s) => [s.recipeId, ...(s.alternatives ?? [])]),
          ),
        ].filter((id): id is string => !!id),
      ),
    ];
    let stopped = false;
    (async () => {
      for (let i = 0; i < ids.length && !stopped; i += 8)
        await Promise.allSettled(ids.slice(i, i + 8).map(load));
    })();
    return () => {
      stopped = true;
    };
  }, [meals, cookbook, drafts, load, recipeCacheReady]);
  useEffect(() => {
    if (!householdId || !user || !state || !period) return;
    // Recipes live in their own cache; batch bursts of changes into one write.
    const timer = setTimeout(() => {
      AsyncStorage.setItem(
        cacheKey(householdId, user.uid, "snapshot"),
        JSON.stringify({ state, period, meals, cookbook, drafts, settings }),
      ).catch(() => {});
    }, 500);
    return () => clearTimeout(timer);
  }, [
    householdId,
    user?.uid,
    state,
    period,
    meals,
    cookbook,
    drafts,
    settings,
  ]);
  const updateQueue = useCallback(
    async (values: PendingCheck[]) => {
      if (!householdId || !user) return;
      pendingRef.current = values;
      setPending(values);
      const write = queueWrites.current
        .catch(() => {})
        .then(() => writeChecks(householdId, user.uid, values));
      queueWrites.current = write;
      await write;
    },
    [householdId, user?.uid],
  );
  const check = useCallback(
    async (
      item: ListItem,
      action: "check" | "uncheck" | "dismiss" | "restore" | "delete",
    ) => {
      if (!period) throw new Error("Shopping list is loading.");
      if (
        pendingRef.current.some(
          (p) => {
            const command = p.command as { itemId?: string; periodId?: string };
            return commandHasItem(command, item.id) && command.periodId === period.id;
          },
        )
      )
        throw new Error("This item already has a pending change.");
      const entry = {
        id: requestId(),
        queuedAt: Date.now(),
        command: {
          operation: "shopping",
          periodId: period.id,
          itemId: item.id,
          expectedRevision: item.revision,
          action,
          generation: period.shopping?.generation,
        },
      };
      await updateQueue([...pendingRef.current, entry]);
      kickCheckSync.current();
    },
    [period, updateQueue],
  );
  const checkGroup = useCallback(async (items: ListItem[], action: 'check' | 'uncheck' | 'delete') => {
    if (!period?.shopping) throw new Error('Shopping list is loading.');
    if (items.some(item => pendingRef.current.some(p => (p.command as { periodId?: string }).periodId === period.id && commandHasItem(p.command, item.id)))) {
      throw new Error('This item already has a pending change.');
    }
    const entry = { id: requestId(), queuedAt: Date.now(), command: {
      operation: 'shoppingBatch', periodId: period.id, generation: period.shopping.generation,
      items: items.map(item => ({ itemId: item.id, expectedRevision: item.revision })), action,
    } };
    await updateQueue([...pendingRef.current, entry]);
    kickCheckSync.current();
  }, [period, updateQueue]);
  const flushing = useRef(false);
  useEffect(() => {
    if (!online || !householdId || !user) return;
    let active = true;
    const drain = async () => {
      if (flushing.current || !active) return;
      flushing.current = true;
      try {
        await drainShoppingChecks({
          active: () => active && currentOwner.current === owner,
          entries: () => pendingRef.current,
          send: entry => workflowCommand(householdId, entry.command, entry.id),
          acknowledge: (entry, revision) => updateQueue(
            pendingRef.current.map(p => p.id === entry.id ? { ...p, acknowledgedRevision: revision } : p)
              .filter(p => !shoppingCheckObserved(p, periodRef.current)),
          ),
          fail: (entry, message) => updateQueue(
            pendingRef.current.map(p => p.id === entry.id ? { ...p, error: message } : p),
          ),
        });
      } catch (e) {
        if (active && currentOwner.current === owner)
          setError(e instanceof Error ? e.message : 'Could not save pending shopping changes.');
      } finally {
        flushing.current = false;
      }
    };
    kickCheckSync.current = () => { void drain(); };
    void drain();
    const timer = setInterval(() => void drain(), 2000);
    return () => {
      active = false;
      kickCheckSync.current = () => {};
      clearInterval(timer);
    };
  }, [online, householdId, user?.uid, owner, updateQueue]);
  useEffect(() => {
    const remaining = pendingRef.current.filter(p => !shoppingCheckObserved(p, period));
    if (remaining.length !== pendingRef.current.length) {
      void updateQueue(remaining).catch(e => setError(String(e)));
    }
  }, [period, pending, updateQueue]);
  return (
    <Context.Provider
      key={owner}
      value={{
        state,
        period,
        meals,
        recipes,
        cookbook,
        drafts,
        settings,
        online,
        loading,
        shoppingUpdating: shoppingIsUpdating(state, period),
        error,
        pending,
        run,
        check,
        checkGroup,
        load,
        refreshRecipes,
        retry: () => setAttempt((v) => v + 1),
        dismissPending: (id) =>
          updateQueue(pendingRef.current.filter((p) => p.id !== id)),
      }}
    >
      {children}
      {shoppingChoice && <ShoppingChoice choose={shoppingChoice} />}
    </Context.Provider>
  );
}
