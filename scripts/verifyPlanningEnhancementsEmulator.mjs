// Runs only against local emulators and synthetic test households.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { initializeApp } from "firebase/app";
import {
  getAuth,
  connectAuthEmulator,
  signInWithEmailAndPassword,
} from "firebase/auth";
import {
  getFunctions,
  connectFunctionsEmulator,
  httpsCallable,
} from "firebase/functions";
import { initializeApp as adminApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099";
const projectId = "demo-meal-wizard-rules";
adminApp({ projectId });
const db = getFirestore();
const householdId = `qa-stable-${randomUUID()}`;
const root = db.doc(`households/${householdId}`);
await root.set({ members: ["qa-one", "qa-two"] });
const clients = await Promise.all(
  ["one", "two"].map(async (name) => {
    const app = initializeApp({ apiKey: "demo-key", projectId }, name);
    const auth = getAuth(app);
    connectAuthEmulator(auth, "http://127.0.0.1:9099", {
      disableWarnings: true,
    });
    await signInWithEmailAndPassword(
      auth,
      `${name}@mealwizard.test`,
      "Local-testing-2026!",
    );
    const functions = getFunctions(app, "europe-west1");
    connectFunctionsEmulator(functions, "127.0.0.1", 5001);
    return {
      call: async (command, requestId = randomUUID(), clientVersion = 3) =>
        (
          await httpsCallable(functions, "connectedCommand", {
            timeout: 30000,
          })({ householdId, clientVersion, requestId, command })
        ).data,
      browse: async (filters) =>
        (
          await httpsCallable(
            functions,
            "browseCatalogueRecipes",
          )({ householdId, mealType: "dinner", ...filters })
        ).data,
    };
  }),
);
const [one, two] = clients;
const state = async () =>
  (await root.collection("connected").doc("state").get()).data();
const period = async () =>
  (
    await root
      .collection("shoppingPeriods")
      .doc((await state()).periodId)
      .get()
  ).data();
await one.call({
  operation: "initialise",
  start: "2026-09-14",
  end: "2026-09-20",
});
const base = {
  date: "2026-09-15",
  mealType: "dinner",
  recipeId: "qa-chicken",
  servings: 2,
  revision: 0,
  kind: "recipe",
  status: "planned",
};
const legacy = { ...base, id: "2026-09-15_dinner" };
await one.call(
  { operation: "mutate", changes: [{ meal: legacy, expectedRevision: 0 }] },
  randomUUID(),
  2,
);
const adults = { ...base, id: randomUUID(), customLabel: "Adults dinner" },
  kids = { ...base, id: randomUUID(), customLabel: "Kids dinner" };
await Promise.all([
  one.call({
    operation: "mutate",
    changes: [{ meal: adults, expectedRevision: 0 }],
  }),
  two.call({
    operation: "mutate",
    changes: [{ meal: kids, expectedRevision: 0 }],
  }),
]);
assert.equal((await root.collection("mealPlan").get()).size, 3);
assert.equal((await state()).minPlanningClientVersion, 3);
await assert.rejects(
  two.call(
    { operation: "mutate", changes: [{ meal: legacy, expectedRevision: 1 }] },
    randomUUID(),
    2,
  ),
  (e) => e.code === "functions/failed-precondition",
);
let current = await period();
const chicken = current.items.find((i) => i.name === "chicken");
await two.call(
  {
    operation: "shopping",
    periodId: current.id,
    itemId: chicken.id,
    expectedRevision: chicken.revision,
    action: "check",
  },
  randomUUID(),
  2,
);
const move = {
    operation: "mutate",
    changes: [{ meal: { ...adults, date: "2026-09-16" }, expectedRevision: 1 }],
  },
  receipt = randomUUID();
await one.call(move, receipt);
await one.call(move, receipt);
assert.equal(
  (await root.collection("mealPlan").doc(adults.id).get()).data().revision,
  2,
);
assert.equal(
  (await root.collection("mealPlan").doc(adults.id).get()).data().date,
  "2026-09-16",
);
await assert.rejects(
  two.call({
    operation: "mutate",
    changes: [
      { meal: { ...adults, recipeId: "qa-pasta" }, expectedRevision: 1 },
    ],
  }),
  (e) => e.code === "functions/aborted",
);
assert.equal(
  (await period()).items.find((i) => i.name === "chicken").checked,
  true,
);
const leftover = {
  ...base,
  id: randomUUID(),
  date: "2026-09-18",
  kind: "leftover",
  sourceMealId: adults.id,
};
await one.call({
  operation: "mutate",
  changes: [
    {
      meal: { ...adults, date: "2026-09-16", allocatedPortions: 2 },
      expectedRevision: 2,
    },
    { meal: leftover, expectedRevision: 0 },
  ],
});
await assert.rejects(
  two.call({
    operation: "mutate",
    changes: [
      {
        meal: { ...adults, date: "2026-09-19", allocatedPortions: 2 },
        expectedRevision: 3,
      },
    ],
  }),
  (e) => e.code === "functions/failed-precondition",
);
assert.equal(
  (await root.collection("mealPlan").doc(adults.id).get()).data().date,
  "2026-09-16",
);
const { SOURCE_CONFIGS } = await import(
  "../functions/lib/catalogue/sourceAdapters.js"
);
const source = SOURCE_CONFIGS[0];
await root
  .collection("settings")
  .doc("preferences")
  .set({
    sourceWeights: Object.fromEntries(
      SOURCE_CONFIGS.map((s) => [
        s.host.replace(/\./g, "_"),
        s === source ? 1 : 0,
      ]),
    ),
    excludedIngredients: ["peanuts"],
  });
const writes = db.batch();
for (let i = 0; i < 27; i++)
  writes.set(db.doc(`recipes/qa-browse-${String(i).padStart(2, "0")}`), {
    schemaVersion: 2,
    status: i === 26 ? "review" : "ready",
    source: {
      key: source.sourceKey,
      canonicalUrl: `https://${source.host}/qa-${i}/`,
      originalUrl: `https://${source.host}/qa-${i}/`,
    },
    content: {
      title: `Catalogue dinner ${i}`,
      originalServings: 2,
      ingredients: [
        { name: i === 25 ? "peanuts" : "tomato", quantity: 200, unit: "g" },
      ],
      instructions: [{ text: "Cook." }],
      nutrition: { calories: 300, protein: 12 },
    },
    effective: {
      mealTypes: ["dinner"],
      cuisines: ["italian"],
      modifiers: [],
      totalMinutes: 20,
    },
    search: {
      randomKey: i / 100,
      ingredientTokens: [i === 25 ? "peanut" : "tomato"],
      selectionKeys: ["dinner|any", "dinner|italian"],
    },
    ingestion: {},
    sourceMetadata: {},
    classification: {},
  });
await writes.commit();
let page = await one.browse({ cuisine: "italian" });
let ids = page.recipes.map((r) => r.id);
let calls = 1;
while (page.nextCursor) {
  assert.ok(calls++ < 10);
  page = await one.browse({ cuisine: "italian", cursor: page.nextCursor });
  ids.push(...page.recipes.map((r) => r.id));
}
assert.equal(ids.length, 25);
assert.equal(new Set(ids).size, 25);
assert.ok(!ids.includes("qa-browse-25"));
assert.ok(!ids.includes("qa-browse-26"));
const ingredient = await one.browse({
  ingredient: "tomato",
  cuisine: "italian",
});
assert.ok(ingredient.recipes.length > 0);
console.log(
  "PASS: concurrent UUID meals, legacy compatibility gate, old-client shopping, stable moves and receipts, stale replacements, leftover rejection, purchased-check preservation, bounded catalogue browsing, exclusions and ready-only results.",
);
process.exit(0);
