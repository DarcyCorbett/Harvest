import { beforeEach, describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ db: null as any, authorise: vi.fn() }));
vi.mock("firebase-admin/firestore", () => ({
  getFirestore: () => fixture.db,
  FieldValue: { serverTimestamp: () => 1, delete: () => null },
}));
vi.mock("../src/authz.js", () => ({
  authorizeHouseholdMember: fixture.authorise,
}));
import { connectedCommand, reconcileHousehold } from "../src/connected/service.js";
import { normaliseMeal } from "../src/connected/model.js";
function memoryDb() {
  const records = new Map<string, any>();
  const reference = (path: string): any => ({
    path,
    id: path.split("/").pop(),
    doc: (id: string) => reference(`${path}/${id}`),
    collection: (id: string) => reference(`${path}/${id}`),
    get: async () => read(path),
  });
  function read(path: string): any {
    if (path.split("/").length % 2) {
      const docs = [...records.keys()]
        .filter(
          (k) =>
            k.startsWith(path + "/") &&
            k.split("/").length === path.split("/").length + 1,
        )
        .map(read);
      return { docs, empty: !docs.length };
    }
    return {
      id: path.split("/").pop(),
      ref: reference(path),
      exists: records.has(path),
      data: () => structuredClone(records.get(path)),
      get: (key: string) => records.get(path)?.[key],
    };
  }
  return {
    records,
    collection: reference,
    getAll: async (...refs: any[]) => refs.map((r) => read(r.path)),
    runTransaction: async (fn: any) => {
      const changes: { type: string; ref: any; data?: any }[] = [];
      let writing = false;
      const tx = {
        get: async (ref: any) => {
          if (writing) throw new Error("Read after write");
          return read(ref.path);
        },
        getAll: async (...refs: any[]) => {
          if (writing) throw new Error("Read after write");
          return refs.map((r) => read(r.path));
        },
        set: (ref: any, data: any, options?: any) => {
          writing = true;
          changes.push({ type: options?.merge ? "update" : "set", ref, data });
        },
        update: (ref: any, data: any) => {
          writing = true;
          changes.push({ type: "update", ref, data });
        },
        create: (ref: any, data: any) => {
          writing = true;
          if (records.has(ref.path)) throw new Error("exists");
          changes.push({ type: "set", ref, data });
        },
        delete: (ref: any) => {
          writing = true;
          changes.push({ type: "delete", ref });
        },
      };
      const result = await fn(tx);
      for (const change of changes) {
        if (change.type === "delete") records.delete(change.ref.path);
        else
          records.set(
            change.ref.path,
            change.type === "update"
              ? {
                  ...records.get(change.ref.path),
                  ...structuredClone(change.data),
                }
              : structuredClone(change.data),
          );
      }
      return result;
    },
  };
}
let sequence = 0;
const invoke = (command: any, id = `request-${++sequence}`, clientVersion = 2) =>
  connectedCommand({
    data: { householdId: "home", clientVersion, requestId: id, command },
    auth: { uid: "one" },
  } as any);
const path = "households/home";
beforeEach(() => {
  fixture.db = memoryDb();
  fixture.authorise.mockResolvedValue({ uid: "one", email: "one@example.com" });
  fixture.db.records.set(path, { members: ["one", "two"] });
  fixture.db.records.set("recipes/soup", {
    title: "Soup",
    originalServings: 2,
    ingredients: [{ name: "stock", quantity: 1, unit: "cup" }],
  });
});

describe('atomic shopping card commands', () => {
  it('checks every row once, deduplicates retries and rejects the entire stale batch', async () => {
    await invoke({ operation: 'initialise', start: '2026-10-05', end: '2026-10-11' }, 'batch-init', 4);
    const state = fixture.db.records.get(`${path}/connected/state`);
    const periodPath = `${path}/shoppingPeriods/${state.periodId}`;
    const generation = fixture.db.records.get(periodPath).shopping.generation;
    for (const unit of ['g', 'tbsp']) await invoke({ operation: 'manual', name: 'butter', quantity: 2, unit, category: 'Dairy & Eggs', generation }, `manual-${unit}`, 4);
    const before = structuredClone(fixture.db.records.get(periodPath));
    const batch = { operation: 'shoppingBatch', periodId: state.periodId, generation, action: 'check', items: before.items.map((item: any) => ({ itemId: item.id, expectedRevision: item.revision })) };
    await expect(invoke({ ...batch, items: [batch.items[0], { ...batch.items[1], expectedRevision: 999 }] }, 'stale-batch', 4)).rejects.toMatchObject({ code: 'aborted' });
    expect(fixture.db.records.get(periodPath)).toEqual(before);
    const response = await invoke(batch, 'check-card', 4);
    expect(fixture.db.records.get(periodPath).items.every((item: any) => item.checked)).toBe(true);
    expect(await invoke(batch, 'check-card', 4)).toEqual(response);
    expect(fixture.db.records.get(periodPath).revision).toBe(before.revision + 1);
    await expect(invoke(batch, 'repeated-card', 4)).rejects.toMatchObject({ code: 'aborted' });
    await expect(invoke({ ...batch, generation: 'old-list' }, 'old-batch', 4)).rejects.toMatchObject({ code: 'aborted' });
  });
});
async function init() {
  await invoke({
    operation: "initialise",
    start: "2026-09-07",
    end: "2026-09-13",
  });
}
const meal = normaliseMeal("2026-09-07_dinner", {
  recipeId: "soup",
  date: "2026-09-07",
  servings: 2,
});
describe("server workflow command", () => {
  it('defers production grouping, caches it for servings, and never calls AI for checks', async () => {
    await init();
    const group = vi.fn(async (_household: string, ingredients: { id: number }[]) => [
      { canonicalName: 'vegetable stock', category: 'Pantry & Dry Goods', sourceIds: ingredients.map(i => i.id) },
    ]);
    await connectedCommand({ data: { householdId: 'home', requestId: 'async-plan', clientVersion: 2,
      command: { operation: 'mutate', changes: [{ meal, expectedRevision: 0 }] } }, auth: { uid: 'one' } } as any,
    { deferReconciliation: true, group });
    expect(fixture.db.records.get(`${path}/connected/state`).status).toBe('pending');
    expect(group).not.toHaveBeenCalled();
    await reconcileHousehold('home', fixture.db, group);
    const state = fixture.db.records.get(`${path}/connected/state`);
    const periodPath = `${path}/shoppingPeriods/${state.periodId}`;
    let period = fixture.db.records.get(periodPath);
    expect(period.groupingStatus).toBe('ai');
    expect(period.items[0].name).toBe('vegetable stock');
    const command = { operation: 'shopping', periodId: state.periodId, itemId: period.items[0].id,
      expectedRevision: period.items[0].revision, action: 'check' };
    const result = await invoke(command, 'instant-check');
    expect(result).toMatchObject({ shoppingRevision: period.revision + 1, periodId: state.periodId });
    expect(await invoke(command, 'instant-check')).toEqual(result);
    await connectedCommand({ data: { householdId: 'home', requestId: 'servings', clientVersion: 2,
      command: { operation: 'mutate', changes: [{ meal: { ...meal, servings: 4 }, expectedRevision: 1 }] } }, auth: { uid: 'one' } } as any,
    { group });
    period = fixture.db.records.get(periodPath);
    expect(group).toHaveBeenCalledTimes(1);
    expect(period.items[0]).toMatchObject({ checked: true, review: true });
    expect(period.items[0].quantity).toBeCloseTo(473.176);
  });

  it('keeps the list usable if AI fails and uses only groups without changing substitution indices', async () => {
    fixture.db.records.set('recipes/soup', { title: 'Soup', originalServings: 2,
      ingredients: [{ name: 'ignored', quantity: 99, unit: 'g' }, { name: 'onion', quantity: 100, unit: 'g' }],
      ingredientGroups: [{ name: 'Soup', ingredients: [{ name: 'onion', quantity: 100, unit: 'g' }] }],
    });
    await init();
    const group = vi.fn().mockRejectedValue(new Error('Provider unavailable'));
    await connectedCommand({ data: { householdId: 'home', requestId: 'fallback-plan', clientVersion: 2,
      command: { operation: 'mutate', changes: [{ meal: { ...meal, overrides: [{ recipeId: 'soup', ingredientIndex: 1,
        replacement: { name: 'leek', quantity: 150, unit: 'g' }, adjustment: 'Use leek', forServings: 2 }] }, expectedRevision: 0 }] } },
    auth: { uid: 'one' } } as any, { group });
    const state = fixture.db.records.get(`${path}/connected/state`);
    const period = fixture.db.records.get(`${path}/shoppingPeriods/${state.periodId}`);
    expect(state.status).toBe('ready');
    expect(period.groupingStatus).toBe('fallback');
    expect(period.items).toHaveLength(1);
    expect(period.items[0]).toMatchObject({ name: 'leek', quantity: 150, unit: 'g' });
  });

  it('activates stable planning atomically, keeps two dinners, and gates old planning clients only', async () => {
    await init();
    await invoke({operation:'mutate',changes:[{meal,expectedRevision:0}]});
    const second = {...meal,id:'12345678-1234-4234-8234-123456789012',customLabel:'  Kids dinner  '};
    const command = {operation:'mutate',changes:[{meal:second,expectedRevision:0}]};
    await invoke(command,'stable-add',3); await invoke(command,'stable-add',3);
    expect(fixture.db.records.get(`${path}/connected/state`).minPlanningClientVersion).toBe(3);
    expect(fixture.db.records.get(`${path}/mealPlan/${second.id}`)).toMatchObject({revision:1,customLabel:'Kids dinner'});
    expect(fixture.db.records.get(`${path}/mealPlan/${meal.id}`).revision).toBe(1);
    await expect(invoke({operation:'mutate',changes:[{meal:{...meal,servings:4},expectedRevision:1}]})).rejects.toMatchObject({code:'failed-precondition'});
    await invoke({operation:'manual',name:'soap',quantity:1,unit:'bottle',category:'Household'});
    const state=fixture.db.records.get(`${path}/connected/state`);
    expect(fixture.db.records.get(`${path}/shoppingPeriods/${state.periodId}`).items.find((i:any)=>i.name==='soap')).toBeTruthy();
  });
  it('moves a legacy ID in place and rejects stale edits and invalid new IDs', async () => {
    await init();await invoke({operation:'mutate',changes:[{meal,expectedRevision:0}]});
    const moved={...meal,date:'2026-09-08'};
    await invoke({operation:'mutate',changes:[{meal:moved,expectedRevision:1}]},'move',3);
    expect(fixture.db.records.get(`${path}/mealPlan/${meal.id}`)).toMatchObject({date:'2026-09-08',revision:2});
    await expect(invoke({operation:'mutate',changes:[{meal:moved,expectedRevision:1}]},'stale',3)).rejects.toMatchObject({code:'aborted'});
    await expect(invoke({operation:'mutate',changes:[{meal:{...meal,id:'not-a-uuid'},expectedRevision:0}]},'bad',3)).rejects.toMatchObject({code:'invalid-argument'});
  });
  it('does not activate version 3 on a failed mutation', async () => {
    await init();
    await expect(invoke({operation:'mutate',changes:[{meal:{...meal,id:'12345678-1234-4234-8234-123456789012',recipeId:'missing'},expectedRevision:0}]},'failed',3)).rejects.toMatchObject({code:'failed-precondition'});
    expect(fixture.db.records.get(`${path}/connected/state`).minPlanningClientVersion).toBeUndefined();
    await invoke({operation:'mutate',changes:[{meal,expectedRevision:0}]});
  });
  it("rejects unversioned commands before authorisation", async () => {
    fixture.authorise.mockClear();
    await expect(
      connectedCommand({
        data: {
          householdId: "home",
          requestId: "x",
          command: { operation: "retry" },
        },
      } as any),
    ).rejects.toMatchObject({ code: "invalid-argument" });
    expect(fixture.authorise).not.toHaveBeenCalled();
  });
  it("archives old shopping data and gates legacy clients", async () => {
    fixture.db.records.set(`${path}/shoppingList/a`, {
      name: "soap",
      quantity: 1,
      manual: true,
      checked: false,
    });
    await init();
    expect(fixture.db.records.get(path).workflowVersion).toBe(2);
    expect(
      [...fixture.db.records.keys()].some((k) =>
        k.includes("/workflowArchives/"),
      ),
    ).toBe(true);
    const state = fixture.db.records.get(`${path}/connected/state`);
    expect(
      fixture.db.records.get(`${path}/shoppingPeriods/${state.periodId}`)
        .items[0].name,
    ).toBe("soap");
  });
  it("makes repeated confirmation idempotent", async () => {
    await init();
    const cmd = {
      operation: "mutate",
      changes: [{ meal, expectedRevision: 0 }],
    };
    await invoke(cmd, "same");
    await invoke(cmd, "same");
    expect(fixture.db.records.get(`${path}/mealPlan/${meal.id}`).revision).toBe(
      1,
    );
    const state = fixture.db.records.get(`${path}/connected/state`);
    const period = fixture.db.records.get(
      `${path}/shoppingPeriods/${state.periodId}`,
    );
    expect(period.items).toHaveLength(1);
    expect(period.items[0].quantity).toBeCloseTo(236.588);
  });
  it("rejects stale partner edits without modifying the plan", async () => {
    await init();
    await invoke({
      operation: "mutate",
      changes: [{ meal, expectedRevision: 0 }],
    });
    await expect(
      invoke({
        operation: "mutate",
        changes: [{ meal: { ...meal, servings: 6 }, expectedRevision: 0 }],
      }),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(fixture.db.records.get(`${path}/mealPlan/${meal.id}`).servings).toBe(
      2,
    );
  });
  it("rejects request-id reuse with different content", async () => {
    await init();
    await invoke({ operation: "retry" }, "same");
    await expect(
      invoke(
        {
          operation: "manual",
          name: "soap",
          quantity: 1,
          unit: "",
          category: "Other",
        },
        "same",
      ),
    ).rejects.toMatchObject({ code: "already-exists" });
  });
  it("preserves every record when household authorization rejects a removal", async () => {
    await init();
    await invoke({
      operation: "mutate",
      changes: [{ meal, expectedRevision: 0 }],
    });
    const before = structuredClone(fixture.db.records);
    fixture.authorise.mockClear();
    fixture.authorise.mockRejectedValueOnce(
      Object.assign(new Error("Not a household member"), { code: "permission-denied" }),
    );

    await expect(invoke({
      operation: "mutate",
      changes: [{ meal: { ...meal, status: "removed" }, expectedRevision: 1 }],
    })).rejects.toMatchObject({ code: "permission-denied" });
    expect(fixture.authorise).toHaveBeenCalledWith({ uid: "one" }, "home");
    expect(fixture.db.records).toEqual(before);
  });
  it("removes a meal explicitly without deleting its shared recipe or cookbook references", async () => {
    await init();
    await invoke({
      operation: "mutate",
      changes: [{ meal, expectedRevision: 0 }],
    });
    const recipe = structuredClone(fixture.db.records.get("recipes/soup"));
    const cookbookPath = `${path}/cookbook/soup`;
    const otherCookbookPath = "households/other/cookbook/soup";
    const cookbookEntry = { recipeId: "soup", starred: true };
    fixture.db.records.set(cookbookPath, structuredClone(cookbookEntry));
    fixture.db.records.set(otherCookbookPath, structuredClone(cookbookEntry));

    await invoke({
      operation: "mutate",
      changes: [{ meal: { ...meal, status: "removed" }, expectedRevision: 1 }],
    });

    expect(fixture.db.records.get(`${path}/mealPlan/${meal.id}`)).toMatchObject({
      status: "removed", revision: 2, recipeId: "soup",
    });
    expect(fixture.db.records.get("recipes/soup")).toEqual(recipe);
    expect(fixture.db.records.get(cookbookPath)).toEqual(cookbookEntry);
    expect(fixture.db.records.get(otherCookbookPath)).toEqual(cookbookEntry);
    const state = fixture.db.records.get(`${path}/connected/state`);
    expect(state.status).toBe("ready");
    expect(fixture.db.records.get(`${path}/shoppingPeriods/${state.periodId}`).items).toEqual([]);
  });
  it("preserves checked items and flags a larger requirement after serving changes", async () => {
    await init();
    await invoke({
      operation: "mutate",
      changes: [{ meal, expectedRevision: 0 }],
    });
    const state = fixture.db.records.get(`${path}/connected/state`);
    const item = fixture.db.records.get(
      `${path}/shoppingPeriods/${state.periodId}`,
    ).items[0];
    await invoke({
      operation: "shopping",
      periodId: state.periodId,
      itemId: item.id,
      expectedRevision: item.revision,
      action: "check",
    });
    await invoke({
      operation: "mutate",
      changes: [{ meal: { ...meal, servings: 4 }, expectedRevision: 1 }],
    });
    expect(
      fixture.db.records.get(`${path}/shoppingPeriods/${state.periodId}`)
        .items[0],
    ).toMatchObject({ checked: true, review: true, reviewedQuantity: 236.588 });
  });
  it("rejects offline checks for a previous trip", async () => {
    await init();
    const state = fixture.db.records.get(`${path}/connected/state`);
    const period = fixture.db.records.get(
      `${path}/shoppingPeriods/${state.periodId}`,
    );
    await invoke({
      operation: "period",
      start: "2026-09-14",
      end: "2026-09-20",
      newPeriod: true,
      expectedRevision: period.revision,
    });
    await expect(
      invoke({
        operation: "shopping",
        periodId: period.id,
        itemId: "old",
        expectedRevision: 1,
        action: "check",
      }),
    ).rejects.toMatchObject({ code: "aborted" });
  });
  it("keeps the prior shopping list when a recipe disappears, then recovers on retry", async () => {
    await init();
    await invoke({
      operation: "mutate",
      changes: [{ meal, expectedRevision: 0 }],
    });
    const savedMeal = structuredClone(fixture.db.records.get(`${path}/mealPlan/${meal.id}`));
    const cookbookEntry = { recipeId: "soup", starred: true };
    fixture.db.records.set(`${path}/cookbook/soup`, cookbookEntry);
    fixture.db.records.delete("recipes/soup");
    await invoke({ operation: "retry" });
    const state = fixture.db.records.get(`${path}/connected/state`);
    expect(state.status).toBe("error");
    expect(fixture.db.records.get(`${path}/mealPlan/${meal.id}`)).toEqual(savedMeal);
    expect(fixture.db.records.get(`${path}/cookbook/soup`)).toEqual(cookbookEntry);
    expect(
      fixture.db.records.get(`${path}/shoppingPeriods/${state.periodId}`).items,
    ).toHaveLength(1);
    fixture.db.records.set("recipes/soup", {
      title: "Soup",
      originalServings: 2,
      ingredients: [{ name: "stock", quantity: 2, unit: "cup" }],
    });
    await invoke({ operation: "retry" });
    expect(fixture.db.records.get(`${path}/connected/state`).status).toBe(
      "ready",
    );
  });
});

describe('single-list version 4 commands', () => {
  const newMeal = (n: number, patch: Partial<typeof meal> = {}) => ({ ...meal, id: `12345678-1234-4234-8234-${String(n).padStart(12, '0')}`, ...patch });
  const current = () => {
    const state = fixture.db.records.get(`${path}/connected/state`);
    return fixture.db.records.get(`${path}/shoppingPeriods/${state.periodId}`);
  };
  const commandFor = (m: ReturnType<typeof newMeal>, mode = 'keep') => {
    const list = current();
    return { operation: 'mutate', changes: [{ meal: m, expectedRevision: 0 }], shopping: { mode, mealIds: [m.id], expectedRevision: list.revision, generation: list.shopping.generation } };
  };
  const check = (item: any, action = 'check', id?: string) => invoke({ operation: 'shopping', periodId: current().id, generation: current().shopping.generation, itemId: item.id, expectedRevision: item.revision, action }, id, 4);
  const start = () => invoke({ operation: 'initialise', start: '2026-09-07', end: '2026-09-13' }, undefined, 4);

  it('initialises one ongoing list and includes a meal far outside its legacy dates', async () => {
    await start();
    await invoke(commandFor(newMeal(1, { date: '2028-01-01' })), undefined, 4);
    expect(current().items).toHaveLength(1);
    expect(current().completedWorkflowRevision).toBe(fixture.db.records.get(`${path}/connected/state`).revision);
    expect(fixture.db.records.get(`${path}/connected/state`).status).toBe('ready');
  });
  it('migrates current state once and gates old clients and trip operations', async () => {
    await init(); await invoke({ operation: 'mutate', changes: [{ meal, expectedRevision: 0 }] });
    const previous = current();
    await invoke({ operation: 'migrateShopping' }, 'migrate', 4);
    expect(current().items[0]).toMatchObject({ id: previous.items[0].id, quantity: previous.items[0].quantity });
    await invoke({ operation: 'migrateShopping' }, 'migrate-again', 4);
    expect(current().revision).toBe(previous.revision + 1);
    await expect(invoke({ operation: 'manual', name: 'soap', quantity: 1, unit: '', category: 'Other' }, undefined, 3)).rejects.toMatchObject({ code: 'failed-precondition' });
    await expect(invoke({ operation: 'period', start: previous.start, end: previous.end, newPeriod: true, expectedRevision: current().revision }, undefined, 4)).rejects.toMatchObject({ code: 'failed-precondition' });
  });
  it('preserves bought quantities on edits and creates new outstanding ingredients for added meals', async () => {
    await start(); const first = newMeal(1);
    await invoke(commandFor(first), undefined, 4);
    await check(current().items[0]);
    const purchase = current().items[0];
    await invoke({ operation: 'mutate', changes: [{ meal: { ...first, servings: 8 }, expectedRevision: 1 }] }, undefined, 4);
    expect(current().items).toEqual([purchase]);
    await invoke(commandFor(newMeal(2)), undefined, 4);
    expect(current().items).toHaveLength(2);
    expect(current().items.find((i: any) => !i.checked).quantity).toBe(purchase.quantity);
    await check(current().items.find((i: any) => i.checked), 'uncheck');
    expect(current().items).toHaveLength(1);
    expect(current().items[0].quantity).toBeCloseTo(purchase.quantity * 2);
  });
  it('guards the reviewed revision and rejects old checks after replacement; retries never duplicate', async () => {
    await start(); await invoke(commandFor(newMeal(1)), 'add-first', 4);
    const old = current();
    const staleChoice = commandFor(newMeal(2), 'replace');
    await check(old.items[0]);
    await expect(invoke(staleChoice, 'stale-choice', 4)).rejects.toMatchObject({ code: 'aborted' });
    const command = commandFor(newMeal(2), 'replace');
    await invoke(command, 'replace', 4); await invoke(command, 'replace', 4);
    expect(current().items).toHaveLength(1);
    expect(current().shopping.generation).toBe('replace');
    await expect(invoke({ operation: 'shopping', periodId: old.id, generation: old.shopping.generation, itemId: old.items[0].id, expectedRevision: old.items[0].revision, action: 'check' }, 'old-check', 4)).rejects.toMatchObject({ code: 'aborted' });
  });
  it('leaves the old list intact when asynchronous replacement fails, then retries safely', async () => {
    await start(); await invoke(commandFor(newMeal(1)), undefined, 4);
    await invoke({ operation: 'manual', name: 'soap', quantity: 1, unit: '', category: 'Other', generation: current().shopping.generation }, undefined, 4);
    const before = current();
    const command = commandFor(newMeal(2), 'replace');
    await connectedCommand({ data: { householdId: 'home', requestId: 'deferred-replace', clientVersion: 4, command }, auth: { uid: 'one' } } as any, { deferReconciliation: true });
    const recipe = fixture.db.records.get('recipes/soup'); fixture.db.records.delete('recipes/soup');
    await reconcileHousehold('home', fixture.db);
    expect(current()).toEqual(before);
    expect(fixture.db.records.get(`${path}/connected/state`).status).toBe('error');
    fixture.db.records.set('recipes/soup', recipe);
    await invoke({ operation: 'retry' }, 'retry-replacement', 4);
    expect(current().items).toHaveLength(1);
    expect(current().shopping.generation).toBe('deferred-replace');
  });
  it('retries grouping against a concurrent checkbox without resurrecting or losing it', async () => {
    await start(); await invoke(commandFor(newMeal(1)), undefined, 4);
    const before = current();
    const command = commandFor(newMeal(2));
    await connectedCommand({ data: { householdId: 'home', requestId: 'concurrent', clientVersion: 4, command }, auth: { uid: 'one' } } as any, { deferReconciliation: true });
    let first = true;
    const group = vi.fn(async (_: string, inputs: { id: number }[]) => {
      if (first) { first = false; await check(before.items[0]); }
      return [{ canonicalName: 'stock', category: 'Other', sourceIds: inputs.map(i => i.id) }];
    });
    await reconcileHousehold('home', fixture.db, group);
    expect(current().items).toHaveLength(2);
    expect(current().items.filter((i: any) => i.checked)).toHaveLength(1);
    expect(current().items.find((i: any) => i.checked).quantity).toBe(before.items[0].quantity);
    expect(current().items.find((i: any) => !i.checked).quantity).toBe(before.items[0].quantity);
  });
  it('keeps a removed ingredient excluded when a different meal edit rebuilds shopping', async () => {
    await start(); const first = newMeal(1);
    await invoke(commandFor(first), undefined, 4); await check(current().items[0], 'delete');
    await invoke({ operation: 'mutate', changes: [{ meal: { ...first, servings: 4 }, expectedRevision: 1 }] }, undefined, 4);
    expect(current().items).toEqual([]);
    await invoke(commandFor(newMeal(2)), undefined, 4);
    expect(current().items).toHaveLength(1);
    expect(current().items[0].contributions[0].mealId).toBe(newMeal(2).id);
  });
  it('treats a date-only move as no change to shopping quantities or item revisions', async () => {
    await start(); const first = newMeal(1); await invoke(commandFor(first), undefined, 4);
    const row = current().items[0];
    await invoke({ operation: 'mutate', changes: [{ meal: { ...first, date: '2030-01-01' }, expectedRevision: 1 }] }, undefined, 4);
    expect(current().items[0]).toEqual(row);
  });
});
