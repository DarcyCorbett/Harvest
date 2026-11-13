import { createHash } from "node:crypto";
import {
  getFirestore,
  FieldValue,
  type Firestore,
} from "firebase-admin/firestore";
import { HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import { z } from "zod";
import { authorizeHouseholdMember } from "../authz.js";
import {
  buildRequirements,
  normaliseMeal,
  reconcileItems,
  setItemAction,
  slotId,
  validDate,
  type Meal,
  type Period,
  type RecipeInput,
  type Workflow,
  type ListItem,
} from "./model.js";
import { recipeInput } from './recipeInput.js';
import { groupShoppingRequirements, type ShoppingGrouper } from './shoppingGrouping.js';
import { logger } from 'firebase-functions';
import { migrateShopping, prepareShopping, outstandingRequirements, reconcileOngoingItems, applyOngoingAction, applyShoppingBatch } from './ongoingShopping.js';

const identifier = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[^/]+$/);
const date = z.string().refine(validDate, "Choose a valid date.");
const portions = z.number().finite().positive().max(100);
const food = z
  .object({
    name: z.string().trim().min(1).max(200),
    quantity: z.number().finite().min(0).max(1000000),
    unit: z.string().max(40),
    notes: z.string().max(1000).optional(),
  })
  .strict();
const mealSchema = z
  .object({
    id: identifier,
    recipeId: z
      .string()
      .max(160)
      .regex(/^[^/]*$/),
    date,
    mealType: z.enum([
      "breakfast",
      "lunch",
      "dinner",
      "side",
      "snack",
      "dessert",
      "component",
    ]),
    servings: portions,
    adults: z.number().min(0).max(20).optional(),
    children: z.number().min(0).max(20).optional(),
    revision: z.number().int().min(0),
    kind: z.enum(["recipe", "leftover", "eating-out"]),
    status: z.enum(["planned", "cooked", "skipped", "removed"]),
    sides: z
      .array(z.object({ recipeId: identifier, servings: portions }).strict())
      .max(8)
      .optional(),
    sourceMealId: identifier.optional(),
    allocatedPortions: z.number().finite().min(0).max(100).optional(),
    overrides: z
      .array(
        z
          .object({
            recipeId: identifier,
            ingredientIndex: z.number().int().min(0).max(500),
            replacement: food,
            adjustment: z.string().max(2000),
            forServings: portions.optional(),
          })
          .strict(),
      )
      .max(100)
      .optional(),
    title: z.string().max(200).optional(),
    customLabel: z.string().trim().max(200).optional(),
  })
  .strict();
const draftSlot = z
  .object({
    allowAnyCuisine: z.boolean().optional(),
    id: identifier,
    date,
    mealType: z.string().max(30),
    expectedRevision: z.number().int().min(0),
    status: z.enum(["ready", "unmatched", "failed"]),
    recipeId: identifier.optional(),
    servings: portions,
    locked: z.boolean(),
    removed: z.boolean(),
    message: z.string().max(2000).optional(),
    reasons: z.array(z.string().max(300)).max(5).optional(),
    alternatives: z.array(identifier).max(3).optional(),
    sourceMealId: identifier.optional(),
    allocatedPortions: z.number().min(0).max(100).optional(),
    maxMinutes: z.union([z.literal(30), z.literal(45)]).optional(),
    must: z.array(z.string().max(120)).max(20).optional(),
  })
  .strict();
const draftSchema = z
  .object({
    id: identifier,
    revision: z.number().int().min(0),
    slots: z.array(draftSlot).max(31),
    config: z
      .object({
        adults: z.number().min(0).max(20),
        children: z.number().min(0).max(20),
        styles: z.array(z.string().max(40)).max(20),
        prefer: z.array(z.string().max(120)).max(20),
        exclude: z.array(z.string().max(120)).max(20),
        must: z.array(z.string().max(120)).max(20),
        mustScope: z.enum(["plan", "recipe"]),
        favouriteCount: z.number().int().min(0).max(31),
        leftovers: z.boolean(),
      })
      .strict(),
  })
  .strict();
const command = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal('migrateShopping') }),
  z.object({ operation: z.literal("initialise"), start: date, end: date }),
  z.object({
    operation: z.literal("mutate"),
    changes: z
      .array(
        z.object({
          meal: mealSchema,
          expectedRevision: z.number().int().min(0),
        }),
      )
      .min(1)
      .max(62),
    draftId: identifier.optional(),
    draftRevision: z.number().int().min(0).optional(),
    shopping: z.object({ mode: z.enum(['keep', 'replace']), mealIds: z.array(identifier).max(62), expectedRevision: z.number().int().min(0), generation: identifier }).optional(),
  }),
  z.object({
    operation: z.literal("period"),
    start: date,
    end: date,
    newPeriod: z.boolean(),
    expectedRevision: z.number().int().min(0),
  }),
  z.object({
    operation: z.literal("shopping"),
    itemId: z.string().min(1).max(2400),
    expectedRevision: z.number().int().min(0),
    action: z.enum(["check", "uncheck", "dismiss", "restore", "delete"]),
    periodId: identifier,
    generation: identifier.optional(),
  }),
  z.object({
    operation: z.literal('shoppingBatch'),
    items: z.array(z.object({ itemId: z.string().min(1).max(2400), expectedRevision: z.number().int().min(0) }).strict()).min(1).max(500),
    action: z.enum(['check', 'uncheck', 'delete']),
    periodId: identifier,
    generation: identifier,
  }),
  z.object({
    operation: z.literal("manual"),
    name: z.string().trim().min(1).max(200),
    quantity: z.number().finite().min(0).max(1000000),
    unit: z.string().max(40),
    category: z.string().max(80),
    generation: identifier.optional(),
  }),
  z.object({ operation: z.literal("retry") }),
  z.object({ operation: z.literal("draft"), draft: draftSchema }),
  z.object({
    operation: z.literal("discardDraft"),
    draftId: identifier,
    revision: z.number().int().min(0),
  }),
]);
const requestSchema = z
  .object({
    householdId: identifier,
    requestId: identifier,
    clientVersion: z.union([z.literal(2), z.literal(3), z.literal(4)]),
    command,
  })
  .strict();
const clean = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function bounded(value: unknown) {
  if (Buffer.byteLength(JSON.stringify(value)) > 800000)
    throw new HttpsError(
      "resource-exhausted",
      "This shopping list is too large. Remove old items or replace the list before adding more meals.",
    );
}

export async function reconcileHousehold(
  householdId: string,
  db: Firestore = getFirestore(),
  group?: ShoppingGrouper,
): Promise<void> {
  const household = db.collection("households").doc(householdId);
  const stateRef = household.collection("connected").doc("state");
  for (let attempt = 0; attempt < 5; attempt++) {
    const state = (await stateRef.get()).data() as Workflow | undefined;
    if (!state || state.status === "ready") return;
    const periodRef = household
      .collection("shoppingPeriods")
      .doc(state.periodId);
    const [periodDoc, plan] = await Promise.all([
      periodRef.get(),
      household.collection("mealPlan").get(),
    ]);
    const period = periodDoc.data() as Period;
    if (!period) return;
    try {
      const meals = plan.docs.map((d) => normaliseMeal(d.id, d.data()));
      const ids = [
        ...new Set(
          meals
            .filter(
              (m) =>
                m.kind === "recipe" &&
                !["removed", "skipped"].includes(m.status) &&
                (period.shopping
                  ? (state.shoppingUpdate?.changedMealIds ?? []).includes(m.id)
                  : m.date >= period.start && m.date <= period.end),
            )
            .flatMap((m) => [
              m.recipeId,
              ...(m.sides ?? []).map((s) => s.recipeId),
            ]),
        ),
      ];
      const documents = ids.length
        ? await db.getAll(...ids.map((id) => db.collection("recipes").doc(id)))
        : [];
      const recipes: Record<string, RecipeInput> = {};
      for (const d of documents)
        if (d.exists) recipes[d.id] = recipeInput(d.id, d.data()!);
      const prepared = period.shopping ? prepareShopping(period, meals, recipes, state.shoppingUpdate) : period;
      let requirements = period.shopping ? outstandingRequirements(prepared) : buildRequirements(meals, recipes, period);
      let shoppingGrouping = period.shoppingGrouping;
      let groupingStatus = period.groupingStatus;
      if (group) {
        try {
          const grouped = await groupShoppingRequirements(householdId, requirements, group, shoppingGrouping);
          requirements = grouped.requirements;
          shoppingGrouping = grouped.cache;
          groupingStatus = 'ai';
        } catch {
          // An AI outage must not block a saved plan or lose any ingredient quantities.
          logger.warn('connected_shopping_grouping_fallback', { householdId });
          groupingStatus = 'fallback';
        }
      }
      const done = await db.runTransaction(async (tx) => {
        const [latestState, latestPeriod] = await Promise.all([
          tx.get(stateRef),
          tx.get(periodRef),
        ]);
        if (
          latestState.get("revision") !== state.revision ||
          latestState.get("periodId") !== state.periodId
          || (period.shopping && latestPeriod.get('revision') !== period.revision)
        )
          return false;
        if (latestState.get("status") === "ready") return true;
        const current = latestPeriod.data() as Period;
        const pendingDrafts =
          (latestState.data() as Workflow).pendingDrafts ?? [];
        const draftDocs = pendingDrafts.length
          ? await tx.getAll(
              ...pendingDrafts.map((d) =>
                household.collection("drafts").doc(d.id),
              ),
            )
          : [];
        const next = clean({
          ...current,
          ...(period.shopping ? { shopping: prepared.shopping, completedWorkflowRevision: state.revision } : {}),
          items: period.shopping ? reconcileOngoingItems(prepared, requirements, current.revision + 1) : reconcileItems(current.items, requirements),
          shoppingGrouping,
          groupingStatus,
          revision: current.revision + 1,
        });
        bounded(next);
        tx.set(periodRef, next);
        tx.update(stateRef, {
          status: "ready",
          error: FieldValue.delete(),
          pendingDrafts: FieldValue.delete(),
          shoppingUpdate: FieldValue.delete(),
        });
        draftDocs.forEach((d, i) => {
          if (d.get("revision") === pendingDrafts[i].revision) tx.delete(d.ref);
        });
        tx.set(
          household.collection("state").doc("mealReminders"),
          { lastConfirmedAt: FieldValue.serverTimestamp() },
          { merge: true },
        );
        return true;
      });
      if (done) return;
    } catch (error) {
      await db.runTransaction(async (tx) => {
        const latest = await tx.get(stateRef);
        if (latest.get("revision") === state.revision && latest.get('status') !== 'ready')
          tx.update(stateRef, {
            status: "error",
            error:
              error instanceof Error ? error.message : "Shopping needs retry.",
          });
      });
      return;
    }
  }
  throw new HttpsError('unavailable', 'Shopping changed during preparation. Please retry.');
}

export async function connectedCommand(
  request: CallableRequest<unknown>,
  options: { deferReconciliation?: boolean; group?: ShoppingGrouper } = {},
): Promise<unknown> {
  const parsed = requestSchema.safeParse(request.data);
  if (!parsed.success)
    throw new HttpsError(
      "invalid-argument",
      parsed.error.issues[0]?.message ?? "Invalid change.",
    );
  const { householdId, requestId, clientVersion, command: cmd } = parsed.data;
  const identity = await authorizeHouseholdMember(request.auth, householdId);
  const db = getFirestore();
  const household = db.collection("households").doc(householdId);
  const stateRef = household.collection("connected").doc("state");
  const ledgerRef = household.collection("workflowRequests").doc(requestId);
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ uid: identity.uid, cmd }))
    .digest("hex");
  let needsReconciliation = false;
  const result = await db.runTransaction(async (tx) => {
    const [receipt, stateDoc] = await Promise.all([
      tx.get(ledgerRef),
      tx.get(stateRef),
    ]);
    if (receipt.exists) {
      if (receipt.get("fingerprint") !== fingerprint)
        throw new HttpsError(
          "already-exists",
          "Request identifier was already used.",
        );
      return receipt.get("result");
    }
    const state = stateDoc.data() as Workflow | undefined;
    if (clientVersion < (state?.minShoppingClientVersion ?? 2))
      throw new HttpsError('failed-precondition', 'Update Meal Wizard to use this household’s shopping list.');
    const planningWrite = ['mutate', 'draft', 'discardDraft'].includes(cmd.operation);
    if (planningWrite && clientVersion < (state?.minPlanningClientVersion ?? 2))
      throw new HttpsError('failed-precondition', 'Update Meal Wizard to change this household’s plan.');
    if (cmd.operation === 'mutate' && clientVersion === 2 && cmd.changes.some(c => c.meal.id !== slotId(c.meal.date, c.meal.mealType)))
      throw new HttpsError('invalid-argument', 'Meal date and slot do not match.');
    let response: Record<string, unknown> = { ok: true };
    const conflict = () => {
      throw new HttpsError(
        "aborted",
        "This item changed on another device. Refresh and review your change.",
      );
    };
    if (cmd.operation === "initialise") {
      if (cmd.end < cmd.start)
        throw new HttpsError(
          "invalid-argument",
          "End date must follow start date.",
        );
      if (!state) {
        const old = await tx.get(household.collection("shoppingList"));
        const periodId = `trip-${requestId}`;
        const oldDraft = await tx.get(
          household.collection("generationResult").doc("pending"),
        );
        const items: ListItem[] = old.docs.map((d) => {
          const v = d.data();
          return {
            id: `legacy-${d.id}`,
            name: v.name ?? "Item",
            quantity: v.quantity ?? 0,
            unit: v.unit ?? "",
            category: v.category ?? "Other",
            checked: !!v.checked,
            manual: !!v.manual,
            legacy: !v.manual,
            review: !v.manual,
            revision: 1,
            contributions: [],
          };
        });
        const period: Period = {
          id: periodId,
          start: cmd.start,
          end: cmd.end,
          items,
          revision: 1,
        };
        bounded(period);
        const archive = {
          items: old.docs.map((d) => ({ id: d.id, ...d.data() })),
        };
        bounded(archive);
        tx.set(
          household.collection("workflowArchives").doc(`initial-${requestId}`),
          { ...archive, archivedAt: FieldValue.serverTimestamp() },
        );
        if (oldDraft.exists) {
          const value = oldDraft.data()!;
          const cfg = value.config ?? {};
          const draftId = `migrated-${requestId}`;
          const slots = (value.meals ?? []).map(
            (m: Record<string, unknown>) => ({
              id: slotId(String(m.date), String(m.mealType)),
              date: m.date,
              mealType: m.mealType,
              expectedRevision: 0,
              status: "ready",
              recipeId: m.recipeId,
              servings: m.servings ?? 2,
              locked: false,
              removed: false,
            }),
          );
          tx.set(household.collection("drafts").doc(draftId), {
            id: draftId,
            revision: 1,
            slots,
            config: {
              adults: cfg.adults ?? 2,
              children: cfg.children ?? 0,
              styles: cfg.cuisineStyles ?? [],
              prefer: cfg.ingredientFilters?.prefer ?? [],
              exclude: cfg.ingredientFilters?.exclude ?? [],
              must: cfg.ingredientFilters?.must ?? [],
              mustScope: "recipe",
              favouriteCount: 0,
              leftovers: false,
            },
          });
        }
        tx.set(household.collection("shoppingPeriods").doc(periodId), clean(clientVersion >= 4 ? { ...migrateShopping(period), completedWorkflowRevision: 1 } : period));
        tx.set(stateRef, {
          version: 2,
          revision: 1,
          periodId,
          status: clientVersion >= 4 ? 'ready' : 'pending',
          ...(clientVersion >= 4 ? { minShoppingClientVersion: 4, minPlanningClientVersion: 4 } as const : {}),
        } satisfies Workflow);
        tx.update(household, { workflowVersion: 2 });
        needsReconciliation = clientVersion < 4;
      }
    } else {
      if (!state)
        throw new HttpsError(
          "failed-precondition",
          "Open the updated Plan screen first.",
        );
      if (cmd.operation === 'migrateShopping') {
        if (clientVersion < 4) throw new HttpsError('failed-precondition', 'Update Meal Wizard first.');
        if (!state.minShoppingClientVersion) {
          if (state.status !== 'ready') throw new HttpsError('failed-precondition', 'Wait for the current shopping update or retry it first.');
          const ref = household.collection('shoppingPeriods').doc(state.periodId);
          const current = (await tx.get(ref)).data() as Period;
          const migrated = migrateShopping(current);
          migrated.completedWorkflowRevision = state.revision;
          migrated.revision++;
          bounded(migrated);
          tx.set(ref, clean(migrated));
          tx.update(stateRef, { minShoppingClientVersion: 4, minPlanningClientVersion: 4 });
        }
      } else if (cmd.operation === "mutate") {
        if (clientVersion >= 4 && !state.minShoppingClientVersion)
          throw new HttpsError('failed-precondition', 'Shopping list is still loading. Please retry.');
        if (state.shoppingUpdate?.replace)
          throw new HttpsError('failed-precondition', 'Wait for the shopping list replacement to finish or retry it first.');
        const list = clientVersion >= 4 ? (await tx.get(household.collection('shoppingPeriods').doc(state.periodId))).data() as Period : null;
        const all = await tx.get(household.collection("mealPlan"));
        const existing = new Map(
          all.docs.map((d) => [d.id, normaliseMeal(d.id, d.data())]),
        );
        const shoppingShape = (m: Meal | undefined) => m && JSON.stringify([m.recipeId, m.kind, m.servings, m.allocatedPortions ?? 0, m.sides ?? [], m.overrides ?? [], ['removed', 'skipped'].includes(m.status)]);
        const shoppingChanges = cmd.changes.filter(c => shoppingShape(existing.get(c.meal.id)) !== shoppingShape(c.meal)).map(c => c.meal.id);
        const draftRef = cmd.draftId
          ? household.collection("drafts").doc(cmd.draftId)
          : null;
        const draftDoc = draftRef ? await tx.get(draftRef) : null;
        if (
          draftDoc &&
          (!draftDoc.exists || draftDoc.get("revision") !== cmd.draftRevision)
        )
          conflict();
        if (
          new Set(cmd.changes.map((c) => c.meal.id)).size !== cmd.changes.length
        )
          throw new HttpsError("invalid-argument", "Duplicate meal identifiers.");
        for (const change of cmd.changes) {
          if (clientVersion >= 3 && !existing.has(change.meal.id) && !z.string().uuid().safeParse(change.meal.id).success)
            throw new HttpsError('invalid-argument', 'New meals need a unique identifier.');
          if (
            (existing.get(change.meal.id)?.revision ?? 0) !==
            change.expectedRevision
          )
            conflict();
          existing.set(change.meal.id, {
            ...change.meal,
            revision: change.expectedRevision + 1,
          });
        }
        const meals = [...existing.values()];
        if (list) {
          const added = cmd.changes.filter(c => c.expectedRevision === 0 && c.meal.kind === 'recipe' && !['removed','skipped'].includes(c.meal.status));
          if (added.length && (!cmd.shopping || added.some(c => !cmd.shopping!.mealIds.includes(c.meal.id))))
            throw new HttpsError('invalid-argument', 'Choose how to update the shopping list.');
          if (cmd.shopping) {
            if (cmd.shopping.generation !== list.shopping!.generation || cmd.shopping.expectedRevision !== list.revision) conflict();
            if (cmd.shopping.mealIds.some(id => !cmd.changes.some(c => c.meal.id === id && c.meal.kind === 'recipe' && !['removed','skipped'].includes(c.meal.status))))
              throw new HttpsError('invalid-argument', 'Shopping meals must be included in this save.');
            if (cmd.shopping.mode === 'replace' && state.status !== 'ready')
              throw new HttpsError('failed-precondition', 'Wait for the current shopping update before replacing the list.');
          }
        }
        // Validate allocations even before the asynchronous shopping stage.
        const { validateAllocations } = await import("./model.js");
        try {
          validateAllocations(meals);
        } catch (e) {
          throw new HttpsError(
            "failed-precondition",
            e instanceof Error ? e.message : "Review leftover allocations.",
          );
        }
        const ids = [
          ...new Set(
            cmd.changes
              .filter(
                (c) =>
                  c.meal.kind === "recipe" &&
                  !["removed", "skipped"].includes(c.meal.status),
              )
              .flatMap((c) => [
                c.meal.recipeId,
                ...(c.meal.sides ?? []).map((s) => s.recipeId),
              ]),
          ),
        ];
        const recipeDocs = ids.length
          ? await tx.getAll(
              ...ids.map((id) => db.collection("recipes").doc(id)),
            )
          : [];
        if (recipeDocs.some((d) => !d.exists))
          throw new HttpsError(
            "failed-precondition",
            "A selected recipe is unavailable.",
          );
        for (const { meal } of cmd.changes) {
          if (["removed", "skipped"].includes(meal.status)) continue;
          for (const override of meal.overrides ?? []) {
            const source = recipeDocs.find((d) => d.id === override.recipeId);
            if (
              !source ||
              !recipeInput(source.id, source.data()!).ingredients.some(
                (ingredient, index) => (ingredient.originalIndex ?? index) === override.ingredientIndex,
              ) ||
              ![
                meal.recipeId,
                ...(meal.sides ?? []).map((s) => s.recipeId),
              ].includes(override.recipeId)
            )
              throw new HttpsError(
                "invalid-argument",
                "This substitution does not belong to the selected meal.",
              );
          }
        }
        const cookbook = ids.length
          ? await tx.getAll(
              ...ids.map((id) => household.collection("cookbook").doc(id)),
            )
          : [];
        for (const change of cmd.changes)
          tx.set(
            household.collection("mealPlan").doc(change.meal.id),
            clean(existing.get(change.meal.id)!),
          );
        cookbook.forEach((d, i) => {
          if (!d.exists)
            tx.set(d.ref, {
              recipeId: ids[i],
              starred: false,
              addedAt: FieldValue.serverTimestamp(),
            });
        });
        if (draftRef) tx.update(draftRef, { submitted: true });
        tx.update(stateRef, {
          revision: state.revision + 1,
          status: "pending",
          ...(list ? { shoppingUpdate: {
            mealIds: [...new Set([...(cmd.shopping?.mode === 'replace' ? [] : state.shoppingUpdate?.mealIds ?? []), ...(cmd.shopping?.mealIds ?? [])])],
            changedMealIds: [...new Set([...(state.shoppingUpdate?.changedMealIds ?? []), ...shoppingChanges, ...(cmd.shopping?.mealIds ?? [])])],
            replace: cmd.shopping?.mode === 'replace',
            generation: cmd.shopping?.mode === 'replace' ? requestId : list.shopping!.generation,
          } } : {}),
          error: FieldValue.delete(),
          pendingDrafts: [
            ...(state.pendingDrafts ?? []),
            ...(cmd.draftId
              ? [{ id: cmd.draftId, revision: cmd.draftRevision! }]
              : []),
          ],
        });
        needsReconciliation = true;
        response = {
          ok: true,
          revisions: cmd.changes.map((c) => ({
            id: c.meal.id,
            revision: c.expectedRevision + 1,
          })),
        };
      } else if (cmd.operation === "period") {
        if (state.minShoppingClientVersion) throw new HttpsError('failed-precondition', 'This household uses one ongoing shopping list.');
        if (cmd.end < cmd.start)
          throw new HttpsError(
            "invalid-argument",
            "End date must follow start date.",
          );
        const currentRef = household
          .collection("shoppingPeriods")
          .doc(state.periodId);
        const current = (await tx.get(currentRef)).data() as Period;
        if (current.revision !== cmd.expectedRevision) conflict();
        const next: Period = cmd.newPeriod
          ? {
              id: `trip-${requestId}`,
              start: cmd.start,
              end: cmd.end,
              revision: 1,
              items: current.items
                .filter((i) => i.manual && !i.checked)
                .map((i) => ({ ...i, revision: 1 })),
            }
          : {
              ...current,
              start: cmd.start,
              end: cmd.end,
              revision: current.revision + 1,
            };
        tx.set(
          household.collection("shoppingPeriods").doc(next.id),
          clean(next),
        );
        tx.update(stateRef, {
          periodId: next.id,
          revision: state.revision + 1,
          status: "pending",
        });
        needsReconciliation = true;
      } else if (cmd.operation === "shopping" || cmd.operation === 'shoppingBatch' || cmd.operation === "manual") {
        if (cmd.operation !== 'manual' && cmd.periodId !== state.periodId)
          throw new HttpsError(
            "aborted",
            "The shopping period changed. Review this item in the current trip.",
          );
        const ref = household.collection("shoppingPeriods").doc(state.periodId);
        const period = (await tx.get(ref)).data() as Period;
        if (period.shopping) {
          if (cmd.generation !== period.shopping.generation) conflict();
          if (state.shoppingUpdate?.replace) throw new HttpsError('failed-precondition', 'Wait for the shopping list replacement to finish.');
        }
        if (cmd.operation === "manual")
          period.items.push({
            id: `manual-${requestId}`,
            name: cmd.name,
            quantity: cmd.quantity,
            unit: cmd.unit,
            category: cmd.category,
            manual: true,
            checked: false,
            revision: 1,
            contributions: [],
          });
        else if (cmd.operation === 'shoppingBatch') {
          try { applyShoppingBatch(period, cmd.items, cmd.action); } catch { conflict(); }
        } else {
          const index = period.items.findIndex((i) => i.id === cmd.itemId);
          if (
            index < 0 ||
            period.items[index].revision !== cmd.expectedRevision
          )
            conflict();
          if (period.shopping) {
            if (cmd.action === 'dismiss' || cmd.action === 'restore') throw new HttpsError('invalid-argument', 'Use Remove item.');
            applyOngoingAction(period, period.items[index], cmd.action);
          } else if (cmd.action === "delete") period.items.splice(index, 1);
          else
            period.items[index] = setItemAction(
              period.items[index],
              cmd.action,
            );
        }
        period.revision++;
        bounded(period);
        tx.set(ref, clean(period));
        response = { ok: true, periodId: period.id, shoppingRevision: period.revision };
      } else if (cmd.operation === "draft") {
        const ref = household.collection("drafts").doc(cmd.draft.id);
        const previous = await tx.get(ref);
        if ((previous.get("revision") ?? 0) !== cmd.draft.revision) conflict();
        if (previous.get("submitted"))
          throw new HttpsError(
            "failed-precondition",
            "This plan is saved. Retry its shopping update from Plan.",
          );
        const next = { ...cmd.draft, revision: cmd.draft.revision + 1 };
        tx.set(ref, clean(next));
        response = { ok: true, draft: next };
      } else if (cmd.operation === "discardDraft") {
        const ref = household.collection("drafts").doc(cmd.draftId);
        const previous = await tx.get(ref);
        if (previous.exists && previous.get("revision") !== cmd.revision)
          conflict();
        tx.delete(ref);
      } else if (cmd.operation === "retry") {
        tx.update(stateRef, {
          revision: state.revision + 1,
          status: "pending",
          error: FieldValue.delete(),
        });
        needsReconciliation = true;
      }
    }
    if (planningWrite && clientVersion === 3 && state)
      tx.update(stateRef, { minPlanningClientVersion: 3 });
    tx.create(ledgerRef, {
      fingerprint,
      result: response,
      createdAt: FieldValue.serverTimestamp(),
    });
    return response;
  });
  // Production uses the persisted pending-state trigger so a plan save does not
  // wait for Gemini or run the same AI request concurrently with that trigger.
  if (needsReconciliation && !options.deferReconciliation)
    await reconcileHousehold(householdId, db, options.group);
  return result;
}
