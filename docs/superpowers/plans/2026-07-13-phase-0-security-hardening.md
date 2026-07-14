# Phase 0 Security Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move paid-provider access and privileged household/catalogue mutations behind authenticated Firebase Functions, harden Firestore rules, preserve orphaned history, and prove the replacement build is safe before old credentials are revoked.

**Architecture:** Firebase Functions Gen 2 (which runs on Cloud Run) provides a small set of purpose-specific callable endpoints bound to the existing Gemini Secret Manager secret. Every endpoint validates a narrow Zod contract, checks Firebase Authentication, allowlist status, and current household membership, then enforces a per-user daily quota before invoking Gemini; household membership mutations use Admin SDK transactions. The mobile app retains public Firebase/OAuth configuration but contains no provider key or direct paid-provider request, while the existing local tagger uses the same server-side AI module through Secret Manager until Phase 1 replaces its schedule.

**Tech Stack:** Expo 54, React Native 0.81, TypeScript 5.9, Firebase JS SDK 12, Firebase Functions Gen 2, Firebase Admin SDK, Firestore, Google Secret Manager, Zod, Vitest, Firebase Emulator Suite.

**User decisions (already made):**
- Complete the work phase by phase, with Phase 0 fully verified before Phase 1 begins.
- Use the staged cutover: replacement credentials are already in Secret Manager and old credentials are revoked only after the replacement endpoints and app are verified.
- Keep infrastructure as cheap as practical; low ongoing freshness is acceptable.
- Preserve the current scheduled task during Phase 0 if it can use server-side secrets securely; Phase 1 will replace it with managed ingestion.
- The unified catalogue will later enforce global eligibility before applying source weights, but catalogue ingestion and selection are Phase 1 work.
- Do not put provider credentials in Expo variables, tracked files, app configuration, logs, or mobile bundles.

**Design reference:** `docs/superpowers/specs/2026-07-13-unified-recipe-catalog-design.md`

---

## File structure locked for Phase 0

- `functions/src/config.ts` — region, runtime limits, and Secret Manager binding.
- `functions/src/ai/contracts.ts` — shared request/response schemas and payload caps.
- `functions/src/ai/geminiProvider.ts` — timeout-bound Gemini JSON transport using an HTTP header for the key.
- `functions/src/ai/prompts.ts` — pure prompt builders moved from mobile services.
- `functions/src/ai/service.ts` — provider-independent classification/grouping/substitution operations.
- `functions/src/authz.ts` — authentication, allowlist, and household membership checks.
- `functions/src/quota.ts` — transactional per-user/per-endpoint daily usage limits.
- `functions/src/callables/ai.ts` — four fixed-purpose AI callable handlers.
- `functions/src/callables/households.ts` — create/join/switch household transactions.
- `functions/src/index.ts` — exported Gen 2 callables only.
- `services/aiClient.ts` — authenticated mobile callable adapter.
- `services/householdClient.ts` — authenticated mobile household mutation adapter.
- `scripts/lib/geminiAdmin.ts` — Secret Manager adapter for operator-only scripts.
- `tests/firestore.rules.test.ts` — Firestore authorization matrix.
- `tests/dataSafety.test.ts` — regression checks for destructive client behavior.
- `scripts/scanClientSecrets.mjs` — source/export scanner for paid-provider leakage.

### Task 1: Scaffold the secure Gemini backend

**Goal:** Produce a deployable Functions Gen 2 package with validated AI contracts and a timeout-bound Gemini JSON provider that never places the credential in a URL or log.

**Files:**
- Create: `functions/package.json`
- Create: `functions/tsconfig.json`
- Create: `functions/src/config.ts`
- Create: `functions/src/ai/contracts.ts`
- Create: `functions/src/ai/geminiProvider.ts`
- Create: `functions/test/geminiProvider.test.ts`
- Create: `firebase.json`
- Create: `.firebaserc`

**Acceptance Criteria:**
- [ ] `npm --prefix functions test` proves the provider sends `x-goog-api-key`, JSON mode, and an abort signal without placing the key in the request URL.
- [ ] Invalid provider JSON and non-2xx responses become bounded errors that contain no credential.
- [ ] All request schemas reject oversized arrays/strings before a provider call.
- [ ] `npm --prefix functions run build` emits `functions/lib` without TypeScript errors.

**Verify:** `npm --prefix functions test && npm --prefix functions run build` → Vitest reports all tests passed and TypeScript exits 0.

**Steps:**

- [ ] **Step 1: Add the Functions package and Firebase project configuration**

Create `functions/package.json`:

```json
{
  "name": "mealwizard-functions",
  "private": true,
  "main": "lib/index.js",
  "engines": { "node": "20" },
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "firebase-admin": "^13.9.0",
    "firebase-functions": "^6.4.0",
    "zod": "^3.25.76"
  },
  "devDependencies": {
    "@types/node": "^22.15.0",
    "typescript": "~5.9.2",
    "vitest": "^3.2.4"
  }
}
```

Create `functions/tsconfig.json`:

```json
{
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "target": "ES2022",
    "outDir": "lib",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "sourceMap": true
  },
  "include": ["src/**/*.ts"]
}
```

Create `firebase.json`:

```json
{
  "functions": {
    "source": "functions",
    "predeploy": ["npm --prefix functions run test", "npm --prefix functions run build"]
  },
  "firestore": {
    "rules": "firestore.rules"
  },
  "emulators": {
    "auth": { "port": 9099 },
    "firestore": { "port": 8080 },
    "functions": { "port": 5001 },
    "ui": { "enabled": true }
  }
}
```

Create `.firebaserc`:

```json
{
  "projects": {
    "default": "meal-wizard-ad202"
  }
}
```

Run: `npm --prefix functions install`

Expected: `functions/package-lock.json` is created and npm exits 0.

- [ ] **Step 2: Write the failing provider transport tests**

Create `functions/test/geminiProvider.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { GeminiProviderError, requestGeminiJson } from '../src/ai/geminiProvider.js';

describe('requestGeminiJson', () => {
  it('keeps the API key out of the URL and requests JSON', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({
        candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"ok":true}' }] } }]
      }), { status: 200 })
    );

    await expect(requestGeminiJson({
      apiKey: 'replacement-secret-value',
      model: 'gemini-3.1-flash-lite',
      prompt: 'classify',
      maxOutputTokens: 100,
      fetchImpl
    })).resolves.toEqual({ ok: true });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).not.toContain('replacement-secret-value');
    expect(String(url)).not.toContain('?key=');
    expect((init?.headers as Record<string, string>)['x-goog-api-key'])
      .toBe('replacement-secret-value');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init?.body)).generationConfig.responseMimeType)
      .toBe('application/json');
  });

  it('redacts provider bodies and keys from HTTP failures', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response('provider echoed replacement-secret-value', { status: 429 })
    );

    const call = requestGeminiJson({
      apiKey: 'replacement-secret-value',
      model: 'gemini-3.1-flash-lite',
      prompt: 'classify',
      maxOutputTokens: 100,
      fetchImpl
    });

    await expect(call).rejects.toEqual(
      expect.objectContaining({ code: 'provider-http-429' })
    );
    await expect(call).rejects.not.toThrow(/replacement-secret-value/);
  });

  it('rejects missing or malformed JSON responses', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({
        candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'not-json' }] } }]
      }), { status: 200 })
    );

    await expect(requestGeminiJson({
      apiKey: 'secret',
      model: 'gemini-3.1-flash-lite',
      prompt: 'classify',
      maxOutputTokens: 100,
      fetchImpl
    })).rejects.toBeInstanceOf(GeminiProviderError);
  });
});
```

Run: `npm --prefix functions test -- geminiProvider.test.ts`

Expected: FAIL because `functions/src/ai/geminiProvider.ts` does not exist.

- [ ] **Step 3: Add the runtime config and minimal provider**

Create `functions/src/config.ts`:

```ts
import { defineSecret } from 'firebase-functions/params';
import { setGlobalOptions } from 'firebase-functions/v2';

export const REGION = 'europe-west1';
export const GEMINI_API_KEY = defineSecret('mealwizard-gemini-api-key');

setGlobalOptions({
  region: REGION,
  maxInstances: 3,
  timeoutSeconds: 60,
  memory: '256MiB'
});
```

Create `functions/src/ai/geminiProvider.ts`:

```ts
import { logger } from 'firebase-functions';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

export class GeminiProviderError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'GeminiProviderError';
  }
}

interface GeminiRequest {
  apiKey: string;
  model: string;
  prompt: string;
  maxOutputTokens: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export async function requestGeminiJson<T>({
  apiKey,
  model,
  prompt,
  maxOutputTokens,
  timeoutMs = 45_000,
  fetchImpl = fetch
}: GeminiRequest): Promise<T> {
  if (!apiKey) throw new GeminiProviderError('provider-secret-missing');

  const response = await fetchImpl(${GEMINI_API_BASE}/${encodeURIComponent(model)}:generateContent, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey
    },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens,
        responseMimeType: 'application/json'
      }
    })
  });

  if (!response.ok) {
    throw new GeminiProviderError($provider-http-${response.status});
  }

  const body = await response.json() as {
    candidates?: Array<{
      finishReason?: string;
      content?: { parts?: Array<{ text?: string }> };
    }>;
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      totalTokenCount?: number;
    };
  };
  logger.info('gemini_usage', {
    model,
    promptTokens: body.usageMetadata?.promptTokenCount ?? null,
    outputTokens: body.usageMetadata?.candidatesTokenCount ?? null,
    totalTokens: body.usageMetadata?.totalTokenCount ?? null
  });
  if (body.candidates?.[0]?.finishReason === 'MAX_TOKENS') {
    throw new GeminiProviderError('provider-max-tokens');
  }
  const text = body.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new GeminiProviderError('provider-empty-response');

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new GeminiProviderError('provider-invalid-json');
  }
}
```

Run: `npm --prefix functions test -- geminiProvider.test.ts`

Expected: PASS, 3 tests.

- [ ] **Step 4: Add exact, capped request and response contracts**

Create `functions/src/ai/contracts.ts`:

```ts
import { z } from 'zod';

const shortText = z.string().trim().min(1).max(200);
const ingredientName = z.string().trim().min(1).max(120);
const recipeInput = z.object({
  recipeId: z.string().min(1).max(160),
  title: shortText,
  totalMinutes: z.number().int().positive().max(7 * 24 * 60).nullable(),
  ingredients: z.array(ingredientName).max(100),
  steps: z.array(z.string().trim().min(1).max(300)).max(40),
  existingTags: z.array(shortText).max(30)
}).strict();

export const householdRequest = z.object({
  householdId: z.string().min(1).max(128)
}).strict();

export const tagRecipesRequest = householdRequest.extend({
  recipes: z.array(recipeInput).min(1).max(25)
}).strict();

export const reminderFlagsRequest = householdRequest.extend({
  recipes: z.array(recipeInput.pick({
    recipeId: true,
    title: true,
    ingredients: true,
    steps: true
  })).min(1).max(25)
}).strict();

export const rawIngredientSchema = z.object({
  id: z.number().int().min(0).max(9999),
  name: ingredientName,
  quantity: z.number().finite().min(0).max(1_000_000),
  unit: z.string().trim().max(40)
}).strict();

export const shoppingGroupsRequest = householdRequest.extend({
  ingredients: z.array(rawIngredientSchema).min(1).max(500)
}).strict();

export const substitutionsRequest = householdRequest.extend({
  ingredientName,
  ingredientUnit: z.string().trim().max(40),
  recipeTitle: shortText,
  allIngredients: z.array(ingredientName).min(1).max(100)
}).strict();

export const tagRecipesResponse = z.object({
  results: z.array(z.object({
    id: z.string().min(1).max(160),
    tags: z.array(z.enum([
      'Breakfast', 'Lunch', 'Dinner', 'Side', 'Snack', 'Salad',
      'Asian', 'Mexican', 'Mediterranean', 'Italian', 'Indian',
      'Healthy', 'Vegetarian', 'Kid Friendly'
    ])).max(14)
  }).strict()).max(25)
}).strict();

export const reminderFlagsResponse = z.object({
  results: z.array(z.object({
    id: z.string().min(1).max(160),
    needsDefrost: z.boolean(),
    needsMarinate: z.boolean()
  }).strict()).max(25)
}).strict();

export const shoppingGroupsResponse = z.array(z.object({
  canonicalName: ingredientName,
  category: z.enum([
    'Produce', 'Meat & Seafood', 'Dairy & Eggs', 'Pantry & Dry Goods',
    'Herbs & Spices', 'Oils, Sauces & Condiments', 'Bread & Bakery',
    'Frozen', 'Other'
  ]),
  sourceIds: z.array(z.number().int().min(0).max(9999)).min(1).max(500),
  unit: z.string().trim().max(40).optional()
}).strict()).max(500);

export const substitutionsResponse = z.object({
  substitutions: z.array(z.object({
    name: ingredientName,
    adjustment: z.string().trim().min(1).max(160),
    reason: z.string().trim().min(1).max(300)
  }).strict()).length(3)
}).strict();

export type AiEndpoint =
  | 'tagRecipes'
  | 'reminderFlags'
  | 'shoppingGroups'
  | 'substitutions';

export type TagRecipesInput = z.infer<typeof tagRecipesRequest>;
export type ReminderFlagsInput = z.infer<typeof reminderFlagsRequest>;
export type ShoppingGroupsInput = z.infer<typeof shoppingGroupsRequest>;
export type SubstitutionsInput = z.infer<typeof substitutionsRequest>;
```

Add a contract test to `functions/test/geminiProvider.test.ts`:

```ts
import { shoppingGroupsRequest, substitutionsRequest, tagRecipesRequest } from '../src/ai/contracts.js';

it('rejects payloads above the endpoint caps', () => {
  expect(tagRecipesRequest.safeParse({ householdId: 'h1', recipes: [] }).success).toBe(false);
  expect(shoppingGroupsRequest.safeParse({
    householdId: 'h1',
    ingredients: Array.from({ length: 501 }, (_, id) => ({
      id, name: 'onion', quantity: 1, unit: ''
    }))
  }).success).toBe(false);
  expect(substitutionsRequest.safeParse({
    householdId: 'h1',
    ingredientName: 'x'.repeat(121),
    ingredientUnit: '',
    recipeTitle: 'Soup',
    allIngredients: ['onion']
  }).success).toBe(false);
});
```

Run: `npm --prefix functions test && npm --prefix functions run build`

Expected: PASS and exit 0.

- [ ] **Step 5: Commit**

```bash
git add functions/package.json functions/package-lock.json functions/tsconfig.json functions/src/config.ts functions/src/ai/contracts.ts functions/src/ai/geminiProvider.ts functions/test/geminiProvider.test.ts firebase.json .firebaserc
git commit -m "feat: scaffold secure AI backend"
```

### Task 2: Enforce endpoint authorization and quotas

**Goal:** Reject unauthenticated, non-allowlisted, non-member, and over-quota AI requests before they can reach a paid provider.

**Files:**
- Create: `functions/src/authz.ts`
- Create: `functions/src/quota.ts`
- Create: `functions/test/authz.test.ts`
- Create: `functions/test/quota.test.ts`

**Acceptance Criteria:**
- [ ] Missing authentication returns `unauthenticated`.
- [ ] Missing allowlist entry or household membership returns `permission-denied`.
- [ ] Daily limits are isolated by user, endpoint, and UTC date.
- [ ] The transaction rejects the request that would exceed the limit and logs only endpoint, user ID, units, and outcome.

**Verify:** `npm --prefix functions test -- authz.test.ts quota.test.ts` → all authorization and quota cases pass.

**Steps:**

- [ ] **Step 1: Write failing authorization tests against dependency-injected lookups**

Create `functions/test/authz.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { HttpsError } from 'firebase-functions/v2/https';
import { authorizeHouseholdMember } from '../src/authz.js';

const allowed = {
  isAllowlisted: vi.fn(async () => true),
  getMembers: vi.fn(async () => ['user-1'])
};

describe('authorizeHouseholdMember', () => {
  it('requires Firebase Authentication', async () => {
    await expect(authorizeHouseholdMember(undefined, 'home-1', allowed))
      .rejects.toMatchObject<HttpsError>({ code: 'unauthenticated' });
  });

  it('requires an allowlisted email', async () => {
    await expect(authorizeHouseholdMember(
      { uid: 'user-1', token: { email: 'blocked@example.com' } },
      'home-1',
      { ...allowed, isAllowlisted: vi.fn(async () => false) }
    )).rejects.toMatchObject<HttpsError>({ code: 'permission-denied' });
  });

  it('requires current membership', async () => {
    await expect(authorizeHouseholdMember(
      { uid: 'user-2', token: { email: 'member@example.com' } },
      'home-1',
      allowed
    )).rejects.toMatchObject<HttpsError>({ code: 'permission-denied' });
  });

  it('returns the authorized identity', async () => {
    await expect(authorizeHouseholdMember(
      { uid: 'user-1', token: { email: 'MEMBER@example.com' } },
      'home-1',
      allowed
    )).resolves.toEqual({ uid: 'user-1', email: 'member@example.com' });
  });
});
```

Run: `npm --prefix functions test -- authz.test.ts`

Expected: FAIL because `authorizeHouseholdMember` does not exist.

- [ ] **Step 2: Implement the authorization guard**

Create `functions/src/authz.ts`:

```ts
import { getFirestore } from 'firebase-admin/firestore';
import type { CallableRequest } from 'firebase-functions/v2/https';
import { HttpsError } from 'firebase-functions/v2/https';

type AuthData = CallableRequest<unknown>['auth'];

export interface AuthzLookups {
  isAllowlisted(email: string): Promise<boolean>;
  getMembers(householdId: string): Promise<string[] | null>;
}

export interface AuthorizedIdentity {
  uid: string;
  email: string;
}

export function firestoreAuthzLookups(): AuthzLookups {
  const db = getFirestore();
  return {
    async isAllowlisted(email) {
      return (await db.doc($allowlist/${email}).get()).exists;
    },
    async getMembers(householdId) {
      const snapshot = await db.doc($households/${householdId}).get();
      if (!snapshot.exists) return null;
      const members = snapshot.get('members');
      return Array.isArray(members)
        ? members.filter((value): value is string => typeof value === 'string')
        : [];
    }
  };
}

export async function authorizeHouseholdMember(
  auth: AuthData,
  householdId: string,
  lookups: AuthzLookups = firestoreAuthzLookups()
): Promise<AuthorizedIdentity> {
  if (!auth) throw new HttpsError('unauthenticated', 'Sign in is required.');
  const email = typeof auth.token.email === 'string'
    ? auth.token.email.toLowerCase().trim()
    : '';
  if (!email || !(await lookups.isAllowlisted(email))) {
    throw new HttpsError('permission-denied', 'This account is not approved.');
  }
  const members = await lookups.getMembers(householdId);
  if (!members?.includes(auth.uid)) {
    throw new HttpsError('permission-denied', 'Household membership is required.');
  }
  return { uid: auth.uid, email };
}
```

Run: `npm --prefix functions test -- authz.test.ts`

Expected: PASS, 4 tests.

- [ ] **Step 3: Write failing quota tests**

Create `functions/test/quota.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { HttpsError } from 'firebase-functions/v2/https';
import { quotaDocumentId, reserveQuota, type QuotaStore } from '../src/quota.js';

class MemoryQuotaStore implements QuotaStore {
  values = new Map<string, number>();
  async incrementIfAllowed(id: string, units: number, limit: number): Promise<number | null> {
    const next = (this.values.get(id) ?? 0) + units;
    if (next > limit) return null;
    this.values.set(id, next);
    return next;
  }
}

describe('quota', () => {
  it('isolates counters by user, endpoint, and UTC date', () => {
    const now = new Date('2026-07-13T23:59:00Z');
    expect(quotaDocumentId('u1', 'tagRecipes', now))
      .toBe('2026-07-13_u1_tagRecipes');
    expect(quotaDocumentId('u2', 'tagRecipes', now))
      .not.toBe(quotaDocumentId('u1', 'tagRecipes', now));
    expect(quotaDocumentId('u1', 'substitutions', now))
      .not.toBe(quotaDocumentId('u1', 'tagRecipes', now));
  });

  it('rejects the request that exceeds the endpoint limit', async () => {
    const store = new MemoryQuotaStore();
    const now = new Date('2026-07-13T12:00:00Z');
    await reserveQuota(store, 'u1', 'shoppingGroups', 39, now);
    await expect(reserveQuota(store, 'u1', 'shoppingGroups', 2, now))
      .rejects.toMatchObject<HttpsError>({ code: 'resource-exhausted' });
  });
});
```

Run: `npm --prefix functions test -- quota.test.ts`

Expected: FAIL because `functions/src/quota.ts` does not exist.

- [ ] **Step 4: Implement transactional daily quotas**

Create `functions/src/quota.ts`:

```ts
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import { HttpsError } from 'firebase-functions/v2/https';
import type { AiEndpoint } from './ai/contracts.js';

const DAILY_LIMITS: Record<AiEndpoint, number> = {
  tagRecipes: 100,
  reminderFlags: 100,
  shoppingGroups: 40,
  substitutions: 80
};

export interface QuotaStore {
  incrementIfAllowed(id: string, units: number, limit: number): Promise<number | null>;
}

export function firestoreQuotaStore(): QuotaStore {
  const db = getFirestore();
  return {
    async incrementIfAllowed(id, units, limit) {
      const ref = db.collection('aiUsage').doc(id);
      return db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(ref);
        const used = snapshot.exists ? Number(snapshot.get('units') ?? 0) : 0;
        const next = used + units;
        if (next > limit) return null;
        transaction.set(ref, {
          units: next,
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        return next;
      });
    }
  };
}

export function quotaDocumentId(uid: string, endpoint: AiEndpoint, now: Date): string {
  return ${now.toISOString().slice(0, 10)}_${uid}_${endpoint};
}

export async function reserveQuota(
  store: QuotaStore,
  uid: string,
  endpoint: AiEndpoint,
  units = 1,
  now = new Date()
): Promise<number> {
  const limit = DAILY_LIMITS[endpoint];
  const used = await store.incrementIfAllowed(
    quotaDocumentId(uid, endpoint, now),
    units,
    limit
  );
  if (used === null) {
    logger.warn('ai_quota_rejected', { uid, endpoint, units, limit });
    throw new HttpsError('resource-exhausted', 'Daily AI limit reached.');
  }
  logger.info('ai_quota_reserved', { uid, endpoint, units, used, limit });
  return used;
}
```

Run: `npm --prefix functions test -- authz.test.ts quota.test.ts`

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add functions/src/authz.ts functions/src/quota.ts functions/test/authz.test.ts functions/test/quota.test.ts
git commit -m "feat: guard AI calls with auth and quotas"
```

### Task 3: Implement four fixed-purpose AI callables

**Goal:** Expose only recipe tagging, reminder classification, shopping grouping, and ingredient substitution as authenticated, schema-validated callables bound to the Gemini secret.

**Files:**
- Modify: `functions/src/ai/contracts.ts`
- Test: `functions/test/geminiProvider.test.ts`
- Create: `functions/src/ai/prompts.ts`
- Create: `functions/src/ai/service.ts`
- Create: `functions/src/callables/ai.ts`
- Create: `functions/src/index.ts`
- Create: `functions/test/aiService.test.ts`
- Test: `functions/test/aiCallables.test.ts`

**Acceptance Criteria:**
- [ ] Each handler validates input before authorization/provider work and validates structured provider output before returning.
- [ ] Duplicate recipe IDs and shopping ingredient IDs are rejected by request contracts before authorization, quota, or provider work; the service also rejects them defensively before a provider request.
- [ ] Every handler calls the auth guard and endpoint-specific quota.
- [ ] The Gemini secret is bound only to the four AI functions.
- [ ] Tests prove malformed provider output is rejected and no generic prompt proxy exists.
- [ ] Logs contain endpoint/cost metadata only, never prompts, ingredient lists, provider responses, or secret values.

**Verify:** `npm --prefix functions test -- aiService.test.ts aiCallables.test.ts && npm --prefix functions run build` → all endpoint tests pass and the build exits 0.

**Steps:**

- [ ] **Step 1: Move the existing prompt behavior into pure builders and write failing service tests**

Create `functions/src/ai/prompts.ts` using the exact constants and builders below. They preserve the current controlled taxonomy, culinary decisions, JSON shapes, and conservative classification behavior from:

- `services/gemini.ts` → `buildTagRecipesPrompt` and `buildReminderFlagsPrompt`
- `services/shoppingList.ts` → `buildShoppingGroupsPrompt`
- `services/deepseek.ts` → `buildSubstitutionsPrompt`

Wrap those exact strings with these signatures so mobile and operator code cannot inject an arbitrary prompt:

```ts
import type {
  ReminderFlagsInput,
  ShoppingGroupsInput,
  SubstitutionsInput,
  TagRecipesInput
} from './contracts.js';

type TagInput = TagRecipesInput['recipes'];
type ReminderInput = ReminderFlagsInput['recipes'];
type ShoppingInput = ShoppingGroupsInput['ingredients'];
type SubstitutionInput = Omit<SubstitutionsInput, 'householdId'>;

const TAG_RECIPE_RULES = `You are given a list of freshly scraped recipes. Return JSON: { "results": [{ "id": string, "tags": string[] }] }. For each recipe, "tags" contains only tags from the allowed list that clearly apply.

Allowed tags:
- Course: "Breakfast", "Lunch", "Dinner", "Side", "Snack", "Salad"
- Cuisine: "Asian", "Mexican", "Mediterranean", "Italian", "Indian"
- Modifiers: "Healthy", "Vegetarian", "Kid Friendly"

Course rules:
- "Dinner" / "Lunch": substantial main meal only; never snacks, dips, appetisers, finger foods, or small bites.
- "Snack": small or light, not a main meal. "Side": served alongside a main. "Breakfast": morning meal. "Salad": salad-based dish.
- Never combine Snack+Dinner, Snack+Lunch, or Breakfast with Lunch/Dinner.
- Valid combinations include Side+Snack, Side+Salad, Lunch+Dinner, and Salad+Lunch.

"Healthy" applies only when most are true: whole/minimally processed ingredients; low added sugar, saturated fat, trans fat, and sodium; a fibre source; baked, roasted, steamed, grilled, or lightly sautéed rather than fried; vegetables are substantial.

"Kid Friendly" applies only when most are true: mild heat/pepper; no pungent ingredients unless undetectable; identifiable components; easy to eat; visually approachable; kid-accepted vegetables; no alcohol.

"Vegetarian" means lacto-ovo: no meat, poultry, fish, seafood, or other aquatic animal; dairy and eggs are permitted.

General rules:
- Include only confident tags and omit borderline tags.
- Multiple cuisine tags are allowed.
- Do not repeat a tag already in existingTags.
- Every input recipe appears exactly once and preserves its id.
- Return only the JSON object with no markdown or explanation.`;

const REMINDER_RULES = `You classify recipes for kitchen-prep reminders. Return JSON: { "results": [{ "id": string, "needsDefrost": boolean, "needsMarinate": boolean }] }.

"needsDefrost" is true only when the main protein is typically bought frozen and needs several hours to defrost.
- Include chicken breast/thigh/whole, ground or minced meat, beef/pork/lamb cuts, large fish fillets, and prawns/shrimp.
- Exclude deli/cured meats, bacon strips, smoked salmon, canned fish, eggs, tofu, paneer, halloumi, and vegetarian/vegan dishes.

"needsMarinate" is true only when instructions clearly require at least 30 minutes of refrigerated marinating before cooking.
- Include explicit 30-minute, multi-hour, or overnight refrigerated marinades.
- Exclude quick 5–15 minute marinades, unspecified "while you prep" marinades, room-temperature rests, tenderising without liquid, and dry rubs that do not sit refrigerated.

When uncertain choose false. Every input recipe appears exactly once and preserves its id. Return only the JSON object with no markdown or explanation.`;

const SHOPPING_RULES = `You are given recipe ingredients as JSON. Group them into shopping-list items.

Rules:
1. Merge wording variants of the same item and use a natural canonical name.
2. Merge home prep-state differences such as minced garlic/garlic and diced onion/onion.
3. Always keep different cuts/forms of meat, poultry, and fish separate.
4. Treat shredded chicken as chicken breast unless a whole roast chicken ingredient is also present, in which case merge it with whole chicken.
5. Every ingredient id must appear in exactly one group; if uncertain create a single-item group.
6. Category must be exactly one of:
   - Herbs & Spices: fresh/dried herbs, spices, blends
   - Oils, Sauces & Condiments: oils, vinegars, sauces, ketchup, mayo, mustard, miso, tahini, hoisin
   - Pantry & Dry Goods: stocks, canned goods, pasta, rice, flour, sugar, honey, baking
   - Produce: fresh fruit and vegetables
   - Meat & Seafood: raw meat, fish, seafood
   - Dairy & Eggs: milk, cream, butter, cheese, yoghurt, eggs
   - Bread & Bakery: bread, wraps, rolls, tortillas
   - Frozen: frozen items
   - Other: anything else
7. Quantity conversion is performed by the caller.
8. Count-style groups must set "unit" to the natural plural supermarket unit; weight/volume groups may omit it or use an empty string.

Return only a valid JSON array with no markdown or explanation:
[{"canonicalName":"...","category":"...","sourceIds":[0,4,7],"unit":""}]`;

const SUBSTITUTION_RULES = `You are a professional culinary assistant. Suggest exactly three suitable ingredient replacements for the target ingredient in the context of the recipe and all its ingredients.

Return only JSON matching this schema, with no markdown or extra fields:
{
  "substitutions": [
    {
      "name": "substitute ingredient",
      "adjustment": "quantity or ratio adjustment",
      "reason": "one short sentence explaining why it works in this recipe"
    }
  ]
}`;

export function buildTagRecipesPrompt(recipes: TagInput): string {
  const input = recipes.map((recipe) => ({
    id: recipe.recipeId,
    title: recipe.title,
    totalMinutes: recipe.totalMinutes,
    ingredients: recipe.ingredients,
    steps: recipe.steps.join(' | '),
    existingTags: recipe.existingTags
  }));
  return TAG_RECIPE_RULES + '\nRecipes:\n' + JSON.stringify(input);
}

export function buildReminderFlagsPrompt(recipes: ReminderInput): string {
  return REMINDER_RULES + '\nRecipes:\n' + JSON.stringify(recipes);
}

export function buildShoppingGroupsPrompt(ingredients: ShoppingInput): string {
  return SHOPPING_RULES + '\nInput:\n' + JSON.stringify(ingredients);
}

export function buildSubstitutionsPrompt(input: SubstitutionInput): string {
  return SUBSTITUTION_RULES + '\nInput:\n' + JSON.stringify(input);
}
```

Do not change taxonomy or culinary behavior during this security move.

Create `functions/test/aiService.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createAiService } from '../src/ai/service.js';

const tagInput = [{
  recipeId: 'r1',
  title: 'Vegetable soup',
  totalMinutes: 30,
  ingredients: ['carrot'],
  steps: ['Simmer'],
  existingTags: []
}];

describe('AI service', () => {
  it('validates tag output and preserves IDs', async () => {
    const requestJson = vi.fn(async () => ({
      results: [{ id: 'r1', tags: ['Dinner', 'Vegetarian'] }]
    }));
    const service = createAiService({ requestJson });
    await expect(service.tagRecipes(tagInput)).resolves.toEqual({
      results: [{ id: 'r1', tags: ['Dinner', 'Vegetarian'] }]
    });
    expect(requestJson).toHaveBeenCalledTimes(1);
  });

  it('rejects tags outside the controlled taxonomy', async () => {
    const service = createAiService({
      requestJson: vi.fn(async () => ({
        results: [{ id: 'r1', tags: ['Cheap'] }]
      }))
    });
    await expect(service.tagRecipes(tagInput)).rejects.toThrow();
  });

  it('requires exactly three valid substitutions', async () => {
    const service = createAiService({
      requestJson: vi.fn(async () => ({ substitutions: [] }))
    });
    await expect(service.substitutions({
      ingredientName: 'cream',
      ingredientUnit: 'cup',
      recipeTitle: 'Soup',
      allIngredients: ['cream', 'onion']
    })).rejects.toThrow();
  });
});
```

Run: `npm --prefix functions test -- aiService.test.ts`

Expected: FAIL because `createAiService` does not exist.

- [ ] **Step 2: Implement the schema-validating AI service**

Create `functions/src/ai/service.ts`:

```ts
import {
  reminderFlagsResponse,
  shoppingGroupsResponse,
  substitutionsResponse,
  tagRecipesResponse,
  type ReminderFlagsInput,
  type ShoppingGroupsInput,
  type SubstitutionsInput,
  type TagRecipesInput
} from './contracts.js';
import {
  buildReminderFlagsPrompt,
  buildShoppingGroupsPrompt,
  buildSubstitutionsPrompt,
  buildTagRecipesPrompt
} from './prompts.js';

type TagInput = TagRecipesInput['recipes'];
type ReminderInput = ReminderFlagsInput['recipes'];
type ShoppingInput = ShoppingGroupsInput['ingredients'];
type SubstitutionInput = Omit<SubstitutionsInput, 'householdId'>;

export interface JsonRequester {
  requestJson(model: string, prompt: string, maxOutputTokens: number): Promise<unknown>;
}

function assertExactCoverage(expectedIds: Array<string | number>, actualIds: Array<string | number>) {
  const expected = [...expectedIds].sort().join('|');
  const actual = [...actualIds].sort().join('|');
  if (expected !== actual) throw new Error('provider-id-coverage-mismatch');
}

export function createAiService(provider: JsonRequester) {
  return {
    async tagRecipes(recipes: TagInput) {
      const raw = await provider.requestJson(
        'gemini-3.1-flash-lite',
        buildTagRecipesPrompt(recipes),
        Math.min(32_000, 4_096 + recipes.length * 400)
      );
      const parsed = tagRecipesResponse.parse(raw);
      assertExactCoverage(
        recipes.map((recipe) => recipe.recipeId),
        parsed.results.map((result) => result.id)
      );
      return parsed;
    },
    async reminderFlags(recipes: ReminderInput) {
      const raw = await provider.requestJson(
        'gemini-3.1-flash-lite',
        buildReminderFlagsPrompt(recipes),
        Math.min(8_000, 1_024 + recipes.length * 200)
      );
      const parsed = reminderFlagsResponse.parse(raw);
      assertExactCoverage(
        recipes.map((recipe) => recipe.recipeId),
        parsed.results.map((result) => result.id)
      );
      return parsed;
    },
    async shoppingGroups(ingredients: ShoppingInput) {
      const raw = await provider.requestJson(
        'gemini-3.5-flash',
        buildShoppingGroupsPrompt(ingredients),
        Math.min(65_536, 4_096 + ingredients.length * 200)
      );
      const parsed = shoppingGroupsResponse.parse(raw);
      assertExactCoverage(
        ingredients.map((ingredient) => ingredient.id),
        parsed.flatMap((group) => group.sourceIds)
      );
      return parsed;
    },
    async substitutions(input: SubstitutionInput) {
      const raw = await provider.requestJson(
        'gemini-3.1-flash-lite',
        buildSubstitutionsPrompt(input),
        600
      );
      return substitutionsResponse.parse(raw);
    }
  };
}
```

Run: `npm --prefix functions test -- aiService.test.ts`

Expected: PASS, 3 tests.

- [ ] **Step 3: Write failing callable orchestration tests**

Create `functions/test/aiCallables.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createAiHandlers } from '../src/callables/ai.js';

describe('AI callable handlers', () => {
  it('authorizes and reserves quota before tagging', async () => {
    const authorize = vi.fn(async () => ({ uid: 'u1', email: 'a@example.com' }));
    const reserve = vi.fn(async () => 1);
    const tagRecipes = vi.fn(async () => ({ results: [] }));
    const handlers = createAiHandlers({
      authorize,
      reserve,
      service: {
        tagRecipes,
        reminderFlags: vi.fn(),
        shoppingGroups: vi.fn(),
        substitutions: vi.fn()
      }
    });
    const data = {
      householdId: 'h1',
      recipes: [{
        recipeId: 'r1',
        title: 'Soup',
        totalMinutes: 30,
        ingredients: ['onion'],
        steps: ['Cook'],
        existingTags: []
      }]
    };

    await expect(handlers.tagRecipes({ auth: { uid: 'u1', token: {} }, data } as never))
      .resolves.toEqual({ results: [] });
    expect(authorize).toHaveBeenCalledWith(expect.anything(), 'h1');
    expect(reserve).toHaveBeenCalledWith('u1', 'tagRecipes', 1);
    expect(tagRecipes).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed input before authorization', async () => {
    const authorize = vi.fn();
    const handlers = createAiHandlers({
      authorize,
      reserve: vi.fn(),
      service: {
        tagRecipes: vi.fn(),
        reminderFlags: vi.fn(),
        shoppingGroups: vi.fn(),
        substitutions: vi.fn()
      }
    });
    await expect(handlers.tagRecipes({ auth: undefined, data: { householdId: 'h1', recipes: [] } } as never))
      .rejects.toMatchObject({ code: 'invalid-argument' });
    expect(authorize).not.toHaveBeenCalled();
  });
});
```

Run: `npm --prefix functions test -- aiCallables.test.ts`

Expected: FAIL because `createAiHandlers` does not exist.

- [ ] **Step 4: Implement and export the fixed-purpose callables**

Create `functions/src/callables/ai.ts` with one handler per contract. Use this exact orchestration pattern for all four handlers:

```ts
import { logger } from 'firebase-functions';
import { HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { ZodError } from 'zod';
import {
  reminderFlagsRequest,
  shoppingGroupsRequest,
  substitutionsRequest,
  tagRecipesRequest,
  type AiEndpoint
} from '../ai/contracts.js';

type AiService = ReturnType<typeof import('../ai/service.js').createAiService>;
type Authorize = (
  auth: CallableRequest<unknown>['auth'],
  householdId: string
) => Promise<{ uid: string; email: string }>;
type Reserve = (uid: string, endpoint: AiEndpoint, units: number) => Promise<number>;

export function createAiHandlers(deps: {
  authorize: Authorize;
  reserve: Reserve;
  service: AiService;
}) {
  const run = async <TInput extends { householdId: string }, TOutput>(
    request: CallableRequest<unknown>,
    endpoint: AiEndpoint,
    parse: (value: unknown) => TInput,
    invoke: (value: TInput) => Promise<TOutput>
  ): Promise<TOutput> => {
    try {
      const input = parse(request.data);
      const identity = await deps.authorize(request.auth, input.householdId);
      await deps.reserve(identity.uid, endpoint, 1);
      const startedAt = Date.now();
      const result = await invoke(input);
      logger.info('ai_call_complete', {
        uid: identity.uid,
        endpoint,
        durationMs: Date.now() - startedAt,
        outcome: 'success'
      });
      return result;
    } catch (error) {
      if (error instanceof HttpsError) throw error;
      if (error instanceof ZodError) {
        throw new HttpsError('invalid-argument', 'Invalid request or provider response.');
      }
      logger.error('ai_call_failed', {
        endpoint,
        errorCode: error instanceof Error ? error.name : 'unknown'
      });
      throw new HttpsError('internal', 'AI request failed.');
    }
  };

  return {
    tagRecipes: (request: CallableRequest<unknown>) =>
      run(request, 'tagRecipes', (value) => tagRecipesRequest.parse(value),
        (input) => deps.service.tagRecipes(input.recipes)),
    reminderFlags: (request: CallableRequest<unknown>) =>
      run(request, 'reminderFlags', (value) => reminderFlagsRequest.parse(value),
        (input) => deps.service.reminderFlags(input.recipes)),
    shoppingGroups: (request: CallableRequest<unknown>) =>
      run(request, 'shoppingGroups', (value) => shoppingGroupsRequest.parse(value),
        (input) => deps.service.shoppingGroups(input.ingredients)),
    substitutions: (request: CallableRequest<unknown>) =>
      run(request, 'substitutions', (value) => substitutionsRequest.parse(value),
        ({ householdId: _householdId, ...input }) => deps.service.substitutions(input))
  };
}
```

Create `functions/src/index.ts`:

```ts
import { initializeApp } from 'firebase-admin/app';
import { onCall } from 'firebase-functions/v2/https';
import { createAiService } from './ai/service.js';
import { requestGeminiJson } from './ai/geminiProvider.js';
import { authorizeHouseholdMember } from './authz.js';
import { createAiHandlers } from './callables/ai.js';
import { GEMINI_API_KEY } from './config.js';
import { firestoreQuotaStore, reserveQuota } from './quota.js';

initializeApp();

const aiService = createAiService({
  requestJson: (model, prompt, maxOutputTokens) =>
    requestGeminiJson({
      apiKey: GEMINI_API_KEY.value(),
      model,
      prompt,
      maxOutputTokens
    })
});
const quotaStore = firestoreQuotaStore();
const handlers = createAiHandlers({
  authorize: authorizeHouseholdMember,
  reserve: (uid, endpoint, units) =>
    reserveQuota(quotaStore, uid, endpoint, units),
  service: aiService
});
const aiOptions = {
  secrets: [GEMINI_API_KEY],
  enforceAppCheck: false,
  consumeAppCheckToken: false
} as const;

export const tagRecipes = onCall(aiOptions, handlers.tagRecipes);
export const reminderFlags = onCall(aiOptions, handlers.reminderFlags);
export const shoppingGroups = onCall(aiOptions, handlers.shoppingGroups);
export const substitutions = onCall(aiOptions, handlers.substitutions);
```

`enforceAppCheck` remains false in Phase 0 because the current mobile builds do not yet provision App Check. Authentication, allowlist, membership, quotas, schema caps, and `maxInstances` are mandatory now; App Check is a separately testable hardening follow-up.

Run: `npm --prefix functions test -- aiService.test.ts aiCallables.test.ts && npm --prefix functions run build`

Expected: PASS and exit 0.

- [ ] **Step 5: Commit**

```bash
git add functions/src/ai/prompts.ts functions/src/ai/service.ts functions/src/callables/ai.ts functions/src/index.ts functions/test/aiService.test.ts functions/test/aiCallables.test.ts
git commit -m "feat: add protected AI callables"
```

### Task 4: Route every mobile AI feature through callables

**Goal:** Make the app's four AI-assisted flows use authenticated MealWizard endpoints with no direct provider URL or paid-provider environment variable in client code.

**Files:**
- Create: `services/aiClient.ts`
- Create: `tests/aiClient.test.ts`
- Modify: `config/firebase.ts`
- Modify: `services/gemini.ts`
- Modify: `services/shoppingList.ts`
- Delete: `services/deepseek.ts`
- Create: `services/substitutions.ts`
- Modify: `services/generatorService.ts`
- Modify: `components/IngredientSubstitutionSheet.tsx`
- Modify: `eas.json`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `tsconfig.json`
- Modify: `app/(tabs)/shopping.tsx`
- Modify: `app/(tabs)/generate.tsx`
- Modify: `app/login.tsx`
- Modify: `scripts/evaluate-shopping-list.ts`
- Create: `scripts/lib/legacyGeminiOperator.ts`
- Modify: `scripts/tagRecipeIndex.ts`
- Modify: `scripts/test-tagger.ts`

**Acceptance Criteria:**
- [ ] Recipe tagging, reminder flags, shopping grouping, and substitutions all call Firebase Functions with the active `householdId`.
- [ ] Client source contains no `fetch` to Gemini/DeepSeek and no references to `EXPO_PUBLIC_GEMINI_API_KEY` or `EXPO_PUBLIC_DEEPSEEK_API_KEY`.
- [ ] Existing public service return shapes remain unchanged: tag/reminder maps, shopping groups, and substitution arrays.
- [ ] Missing household context fails locally before a paid endpoint call.
- [ ] The pre-existing four lint errors and four TypeScript errors captured at baseline `5c4d3ca` are corrected so Task 4 verification is fully green rather than merely regression-neutral.
- [ ] The existing scheduled tagger remains functional through a script-only temporary provider adapter; no operator script imports a mobile callable adapter, and Task 9 must replace/delete the temporary adapter when Secret Manager migration lands.

**Verify:** `npm test -- aiClient.test.ts && npm run lint && npx tsc --noEmit` → tests, lint, and type-check all exit 0.

**Steps:**

- [ ] **Step 1: Add root Vitest support and write failing callable-adapter tests**

Add to the root `package.json` scripts and devDependencies:

```json
{
  "scripts": {
    "test": "vitest run"
  },
  "devDependencies": {
    "vitest": "^3.2.4"
  }
}
```

Add an app-only exclusion to the root `tsconfig.json` so the independently built Functions package is not compiled with Expo's module settings:

```json
{
  "exclude": ["functions", ".phase0-dist", "node_modules"]
}
```

Create `tests/aiClient.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createAiClient } from '../services/aiClient';

describe('AI client', () => {
  it('sends household context to a fixed callable name', async () => {
    const invoke = vi.fn(async () => ({ data: { results: [] } }));
    const client = createAiClient(invoke);
    await expect(client.tagRecipes('house-1', [])).resolves.toEqual({ results: [] });
    expect(invoke).toHaveBeenCalledWith('tagRecipes', {
      householdId: 'house-1',
      recipes: []
    });
  });

  it('rejects missing household context locally', async () => {
    const invoke = vi.fn();
    const client = createAiClient(invoke);
    await expect(client.substitutions('', {
      ingredientName: 'cream',
      ingredientUnit: 'cup',
      recipeTitle: 'Soup',
      allIngredients: ['cream']
    })).rejects.toThrow('Household is required');
    expect(invoke).not.toHaveBeenCalled();
  });
});
```

Run: `npm install && npm test -- aiClient.test.ts`

Expected: FAIL because `services/aiClient.ts` does not exist.

- [ ] **Step 2: Export the regional Functions client and implement fixed callable names**

Modify `config/firebase.ts`:

```ts
import { getFunctions } from 'firebase/functions';

// existing app/auth/db initialization remains unchanged
const functions = getFunctions(app, 'europe-west1');

export { app, auth, db, functions };
```

Create `services/aiClient.ts`:

```ts
import { functions } from '@/config/firebase';
import { httpsCallable } from 'firebase/functions';

type Endpoint = 'tagRecipes' | 'reminderFlags' | 'shoppingGroups' | 'substitutions';
type Invoke = (endpoint: Endpoint, data: unknown) => Promise<{ data: unknown }>;

const firebaseInvoke: Invoke = async (endpoint, data) => {
  const callable = httpsCallable(functions, endpoint);
  return callable(data);
};

export function createAiClient(invoke: Invoke = firebaseInvoke) {
  const call = async <T>(endpoint: Endpoint, householdId: string, payload: object): Promise<T> => {
    if (!householdId) throw new Error('Household is required');
    const result = await invoke(endpoint, { householdId, ...payload });
    return result.data as T;
  };
  return {
    tagRecipes: (householdId: string, recipes: unknown[]) =>
      call<{ results: Array<{ id: string; tags: string[] }> }>(
        'tagRecipes', householdId, { recipes }
      ),
    reminderFlags: (householdId: string, recipes: unknown[]) =>
      call<{ results: Array<{ id: string; needsDefrost: boolean; needsMarinate: boolean }> }>(
        'reminderFlags', householdId, { recipes }
      ),
    shoppingGroups: (householdId: string, ingredients: unknown[]) =>
      call<unknown[]>('shoppingGroups', householdId, { ingredients }),
    substitutions: (householdId: string, input: object) =>
      call<{ substitutions: Array<{ name: string; adjustment: string; reason: string }> }>(
        'substitutions', householdId, input
      )
  };
}

export const aiClient = createAiClient();
```

Run: `npm test -- aiClient.test.ts`

Expected: PASS, 2 tests.

- [ ] **Step 3: Replace the three mobile provider services with adapters**

Replace provider transport and prompt code in `services/gemini.ts` with mapping-only wrappers:

```ts
import { aiClient } from './aiClient';
import type { Recipe } from './types';

export async function tagRecipesWithGemini(
  householdId: string,
  recipes: { recipeId: string; recipe: Recipe }[]
): Promise<Map<string, string[]>> {
  if (recipes.length === 0) return new Map();
  const input = recipes.map(({ recipeId, recipe }) => ({
    recipeId,
    title: recipe.title,
    totalMinutes: recipe.totalTime ? Number.parseInt(recipe.totalTime, 10) || null : null,
    ingredients: recipe.ingredients.map((ingredient) => ingredient.name),
    steps: recipe.instructions.map((step) => step.text.slice(0, 300)),
    existingTags: recipe.tags ?? []
  }));
  const output = new Map<string, string[]>();
  for (let index = 0; index < input.length; index += 25) {
    const result = await aiClient.tagRecipes(householdId, input.slice(index, index + 25));
    result.results.forEach((entry) => output.set(entry.id, entry.tags));
  }
  return output;
}

export async function getGeminiReminderFlags(
  householdId: string,
  recipes: { recipeId: string; recipe: Recipe }[]
): Promise<Map<string, { needsDefrost: boolean; needsMarinate: boolean }>> {
  if (recipes.length === 0) return new Map();
  const input = recipes.map(({ recipeId, recipe }) => ({
    recipeId,
    title: recipe.title,
    ingredients: recipe.ingredients.map((ingredient) => ingredient.name),
    steps: recipe.instructions.slice(0, 3).map((step) => step.text.slice(0, 300))
  }));
  const output = new Map<string, { needsDefrost: boolean; needsMarinate: boolean }>();
  for (let index = 0; index < input.length; index += 25) {
    const result = await aiClient.reminderFlags(householdId, input.slice(index, index + 25));
    result.results.forEach(({ id, needsDefrost, needsMarinate }) => {
      output.set(id, { needsDefrost, needsMarinate });
    });
  }
  return output;
}
```

In `services/shoppingList.ts`, remove `callGemini` imports and replace `getGeminiGroupings`:

```ts
import { aiClient } from './aiClient';

export async function getGeminiGroupings(
  householdId: string,
  rawIngredients: RawIngredient[]
): Promise<GeminiGroup[]> {
  const groups = await aiClient.shoppingGroups(householdId, rawIngredients.map(
    ({ id, name, quantity, unit }) => ({ id, name, quantity, unit })
  )) as GeminiGroup[];
  const coveredIds = new Set(groups.flatMap((group) => group.sourceIds));
  for (const raw of rawIngredients) {
    if (!coveredIds.has(raw.id)) {
      groups.push({
        canonicalName: raw.name.trim(),
        category: categoriseIngredient(raw.name),
        sourceIds: [raw.id]
      });
    }
  }
  return groups;
}
```

Create `services/substitutions.ts` and delete `services/deepseek.ts`:

```ts
import { aiClient } from './aiClient';

export interface SubstitutionResult {
  name: string;
  adjustment: string;
  reason: string;
}

const cache = new Map<string, SubstitutionResult[]>();

export async function getIngredientSubstitutions(
  householdId: string,
  ingredientName: string,
  ingredientUnit: string,
  recipeTitle: string,
  allIngredients: string[]
): Promise<SubstitutionResult[]> {
  const cacheKey = ${recipeTitle.trim().toLowerCase()}|${ingredientName.trim().toLowerCase()};
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  const result = await aiClient.substitutions(householdId, {
    ingredientName,
    ingredientUnit,
    recipeTitle,
    allIngredients
  });
  cache.set(cacheKey, result.substitutions);
  return result.substitutions;
}
```

Now that no mobile code reads them, delete these fields from every `eas.json` build-profile `env` object:

```text
EXPO_PUBLIC_GEMINI_API_KEY
EXPO_PUBLIC_DEEPSEEK_API_KEY
EXPO_PUBLIC_DEEPSEEK_MODEL
```

Keep `EXPO_PUBLIC_FIREBASE_*` and Google OAuth client IDs because they are intentionally public client configuration.

- [ ] **Step 4: Thread `householdId` through all callers**

In `services/generatorService.ts`, change the three AI calls:

```ts
const tagsById = await tagRecipesWithGemini(householdId, recipesToTag);
const groups = await getGeminiGroupings(householdId, rawIngredients);
const reminderFlags = await getGeminiReminderFlags(householdId, recipesForReminders);
```

In `components/IngredientSubstitutionSheet.tsx`, change the import, read the active household, and pass it first:

```tsx
import { useAuth } from '@/contexts/AuthContext';
import {
  getIngredientSubstitutions,
  type SubstitutionResult
} from '@/services/substitutions';

const { householdId } = useAuth();

if (!householdId) throw new Error('Household is required');
const results = await getIngredientSubstitutions(
  householdId,
  ingredient.name,
  ingredient.unit,
  recipeTitle,
  allIngredients
);
```

Run the leak-oriented source check:

```powershell
rg -n "EXPO_PUBLIC_(GEMINI|DEEPSEEK)|generativelanguage\.googleapis\.com|api\.deepseek\.com|callGemini" app components config contexts services eas.json
```

Expected: no matches.

Run: `npm test -- aiClient.test.ts && npm run lint && npx tsc --noEmit`

Expected: PASS and exit 0.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json config/firebase.ts services/aiClient.ts services/gemini.ts services/shoppingList.ts services/substitutions.ts services/deepseek.ts services/generatorService.ts components/IngredientSubstitutionSheet.tsx tests/aiClient.test.ts eas.json
git commit -m "refactor: route mobile AI through callables"
```

### Task 5: Move household membership mutations server-side

**Goal:** Make household creation, invite joining, and household switching authenticated backend transactions so clients never list households or add themselves to membership arrays.

**Files:**
- Create: `functions/src/callables/households.ts`
- Create: `functions/test/households.test.ts`
- Create: `services/householdClient.ts`
- Create: `tests/householdClient.test.ts`
- Modify: `functions/src/authz.ts`
- Modify: `functions/src/index.ts`
- Modify: `contexts/AuthContext.tsx`
- Modify: `app/register.tsx`
- Modify: `app/login.tsx`
- Modify: `services/firestoreService.ts`

**Acceptance Criteria:**
- [ ] Create, join, and switch require an authenticated, allowlisted identity with `email_verified === true`.
- [ ] Join/switch accept only an exact normalized invite code and atomically update both household members and `users/{uid}.householdId`.
- [ ] The mobile app performs no household collection query or membership-array write.
- [ ] Invalid invites preserve the existing user-facing registration cleanup/error behavior.
- [ ] Google first sign-in creates the profile and household through the backend.
- [ ] Password registration sends a Firebase verification email and cannot create/join a household until a refreshed verified token is present; unverified sessions are signed out with a stable, actionable message.
- [ ] After verification, password users can resume their intended create-or-join onboarding without bypassing the allowlist or verified backend guard.

**Verify:** `npm --prefix functions test -- households.test.ts && npm test -- householdClient.test.ts && npx tsc --noEmit` → all tests pass and TypeScript exits 0.

**Steps:**

- [ ] **Step 1: Add a reusable authenticated/allowlisted guard and failing household tests**

Add to `functions/src/authz.ts`:

```ts
export async function authorizeAllowlistedUser(
  auth: AuthData,
  lookups: Pick<AuthzLookups, 'isAllowlisted'> = firestoreAuthzLookups()
): Promise<AuthorizedIdentity> {
  if (!auth) throw new HttpsError('unauthenticated', 'Sign in is required.');
  const email = typeof auth.token.email === 'string'
    ? auth.token.email.toLowerCase().trim()
    : '';
  if (!email || !(await lookups.isAllowlisted(email))) {
    throw new HttpsError('permission-denied', 'This account is not approved.');
  }
  return { uid: auth.uid, email };
}
```

Refactor `authorizeHouseholdMember` to call `authorizeAllowlistedUser` first, then check membership.

Create `functions/test/households.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createHouseholdHandlers } from '../src/callables/households.js';

const auth = {
  uid: 'u1',
  token: { email: 'user@example.com', email_verified: true }
};

describe('household callables', () => {
  it('creates a household and profile for the authenticated identity', async () => {
    const create = vi.fn(async () => ({
      householdId: 'h1',
      inviteCode: 'ABC12345'
    }));
    const handlers = createHouseholdHandlers({
      authorize: vi.fn(async () => ({ uid: 'u1', email: 'user@example.com' })),
      create,
      join: vi.fn()
    });
    await expect(handlers.create({ auth, data: {} } as never)).resolves.toEqual({
      householdId: 'h1',
      inviteCode: 'ABC12345'
    });
    expect(create).toHaveBeenCalledWith('u1', 'user@example.com');
  });

  it('normalizes an invite before an atomic join', async () => {
    const join = vi.fn(async () => 'h2');
    const handlers = createHouseholdHandlers({
      authorize: vi.fn(async () => ({ uid: 'u1', email: 'user@example.com' })),
      create: vi.fn(),
      join
    });
    await expect(handlers.join({
      auth,
      data: { inviteCode: ' ab-c1 23 ' }
    } as never)).resolves.toEqual({ householdId: 'h2' });
    expect(join).toHaveBeenCalledWith('u1', 'user@example.com', 'ABC123');
  });

  it('returns not-found for an invalid invite', async () => {
    const handlers = createHouseholdHandlers({
      authorize: vi.fn(async () => ({ uid: 'u1', email: 'user@example.com' })),
      create: vi.fn(),
      join: vi.fn(async () => null)
    });
    await expect(handlers.join({
      auth,
      data: { inviteCode: 'BADCODE1' }
    } as never)).rejects.toMatchObject({ code: 'not-found' });
  });
});
```

Run: `npm --prefix functions test -- households.test.ts`

Expected: FAIL because `createHouseholdHandlers` does not exist.

- [ ] **Step 2: Implement household transactions and callable handlers**

Create `functions/src/callables/households.ts`:

```ts
import { randomBytes } from 'node:crypto';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { z } from 'zod';

const inviteRequest = z.object({
  inviteCode: z.string().trim().min(6).max(20)
}).strict();

function normalizeInvite(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export interface HouseholdMutations {
  create(uid: string, email: string): Promise<{ householdId: string; inviteCode: string }>;
  join(uid: string, email: string, inviteCode: string): Promise<string | null>;
}

export function firestoreHouseholdMutations(): HouseholdMutations {
  const db = getFirestore();
  return {
    async create(uid, email) {
      const householdRef = db.collection('households').doc();
      const inviteCode = randomBytes(5).toString('hex').toUpperCase();
      await db.runTransaction(async (transaction) => {
        transaction.create(householdRef, { members: [uid], inviteCode });
        transaction.set(db.doc($users/${uid}), {
          email,
          householdId: householdRef.id
        });
      });
      return { householdId: householdRef.id, inviteCode };
    },
    async join(uid, email, inviteCode) {
      const matches = await db.collection('households')
        .where('inviteCode', '==', inviteCode)
        .limit(1)
        .get();
      if (matches.empty) return null;
      const householdRef = matches.docs[0].ref;
      await db.runTransaction(async (transaction) => {
        const household = await transaction.get(householdRef);
        if (!household.exists) throw new HttpsError('not-found', 'Invalid invite code.');
        transaction.update(householdRef, {
          members: FieldValue.arrayUnion(uid)
        });
        transaction.set(db.doc($users/${uid}), {
          email,
          householdId: householdRef.id
        }, { merge: true });
      });
      return householdRef.id;
    }
  };
}

type Authorize = (
  auth: CallableRequest<unknown>['auth']
) => Promise<{ uid: string; email: string }>;

export function createHouseholdHandlers(deps: {
  authorize: Authorize;
  create: HouseholdMutations['create'];
  join: HouseholdMutations['join'];
}) {
  const join = async (request: CallableRequest<unknown>) => {
    const parsed = inviteRequest.safeParse(request.data);
    if (!parsed.success) throw new HttpsError('invalid-argument', 'Invalid invite code.');
    const identity = await deps.authorize(request.auth);
    const inviteCode = normalizeInvite(parsed.data.inviteCode);
    if (inviteCode.length < 6 || inviteCode.length > 20) {
      throw new HttpsError('invalid-argument', 'Invalid invite code.');
    }
    const householdId = await deps.join(identity.uid, identity.email, inviteCode);
    if (!householdId) throw new HttpsError('not-found', 'Invalid invite code.');
    return { householdId };
  };
  return {
    create: async (request: CallableRequest<unknown>) => {
      if (request.data !== undefined && (
        typeof request.data !== 'object' ||
        request.data === null ||
        Object.keys(request.data as object).length > 0
      )) {
        throw new HttpsError('invalid-argument', 'No request fields are accepted.');
      }
      const identity = await deps.authorize(request.auth);
      return deps.create(identity.uid, identity.email);
    },
    join,
    switch: join
  };
}
```

Modify `functions/src/index.ts`:

```ts
import { authorizeAllowlistedUser } from './authz.js';
import {
  createHouseholdHandlers,
  firestoreHouseholdMutations
} from './callables/households.js';

const householdMutations = firestoreHouseholdMutations();
const householdHandlers = createHouseholdHandlers({
  authorize: authorizeAllowlistedUser,
  create: householdMutations.create,
  join: householdMutations.join
});

export const createHousehold = onCall(householdHandlers.create);
export const joinHousehold = onCall(householdHandlers.join);
export const switchHousehold = onCall(householdHandlers.switch);
```

Run: `npm --prefix functions test -- households.test.ts`

Expected: PASS, 3 tests.

- [ ] **Step 3: Write and implement the mobile household adapter**

Create `tests/householdClient.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createHouseholdClient } from '../services/householdClient';

it('maps not-found join errors to null', async () => {
  const invoke = vi.fn(async () => {
    throw Object.assign(new Error('invalid'), { code: 'functions/not-found' });
  });
  const client = createHouseholdClient(invoke);
  await expect(client.join('BADCODE1')).resolves.toBeNull();
});

it('returns the created household response', async () => {
  const invoke = vi.fn(async () => ({
    data: { householdId: 'h1', inviteCode: 'ABC12345' }
  }));
  const client = createHouseholdClient(invoke);
  await expect(client.create()).resolves.toEqual({
    householdId: 'h1',
    inviteCode: 'ABC12345'
  });
});
```

Create `services/householdClient.ts`:

```ts
import { functions } from '@/config/firebase';
import { httpsCallable } from 'firebase/functions';

type HouseholdEndpoint = 'createHousehold' | 'joinHousehold' | 'switchHousehold';
type Invoke = (
  endpoint: HouseholdEndpoint,
  data: object
) => Promise<{ data: unknown }>;

const firebaseInvoke: Invoke = (endpoint, data) =>
  httpsCallable(functions, endpoint)(data);

export function createHouseholdClient(invoke: Invoke = firebaseInvoke) {
  const joinLike = async (
    endpoint: 'joinHousehold' | 'switchHousehold',
    inviteCode: string
  ): Promise<string | null> => {
    try {
      const result = await invoke(endpoint, { inviteCode }) as {
        data: { householdId: string }
      };
      return result.data.householdId;
    } catch (error) {
      if ((error as { code?: string }).code === 'functions/not-found') return null;
      throw error;
    }
  };
  return {
    async create() {
      const result = await invoke('createHousehold', {}) as {
        data: { householdId: string; inviteCode: string }
      };
      return result.data;
    },
    join: (inviteCode: string) => joinLike('joinHousehold', inviteCode),
    switch: (inviteCode: string) => joinLike('switchHousehold', inviteCode)
  };
}

export const householdClient = createHouseholdClient();
```

Run: `npm test -- householdClient.test.ts`

Expected: PASS, 2 tests.

- [ ] **Step 4: Complete verified password onboarding and replace direct household mutations**

Before any password-created account can call `householdClient.create()` or
`householdClient.join()`, update `contexts/AuthContext.tsx` and the register/login
screens to enforce ownership of the allowlisted address:

- Call Firebase `sendEmailVerification` immediately after password account creation.
- Preserve the user's pending create-or-join intent locally until verification;
  never place the raw password or an ID token in storage.
- Do not call a household mutation or write a user profile for the unverified account.
- Sign out the unverified account and return a stable verification-required result
  that `app/register.tsx` displays as an actionable “check your email” message.
- On password login, reload the Firebase user/token. If `emailVerified` is false,
  sign out and show the same stable message without reading a profile or calling a
  household mutation.
- Once the refreshed identity is verified, resume the pending create-or-join intent
  through `householdClient`, clear it only after success, and load the resulting
  profile/household. Google identities continue through their existing verified flow.
- Add focused root tests proving the sequencing: unverified registration sends the
  email and stops before mutation; unverified login signs out; verified resume calls
  exactly the intended mutation; invalid join retains a recoverable error path.

In `contexts/AuthContext.tsx`:

```tsx
import { householdClient } from '@/services/householdClient';

// Email registration:
const joinedId = await householdClient.join(existingInviteCode.trim());
const result = await householdClient.create();

// Do not call saveUserProfile here; the transaction already wrote it.

// First Google sign-in:
const { householdId: hId, inviteCode: code } = await householdClient.create();

// Household switching:
const newId = await householdClient.switch(inviteCode);
```

Remove `createHousehold`, `joinHousehold`, `switchHousehold`, and `saveUserProfile` plus their now-unused Firestore imports from `services/firestoreService.ts`. Keep `getHousehold` and `getUserProfile` as read operations.

Run:

```powershell
rg -n "collection\(db, 'households'\).*where|arrayUnion\(userId\)|saveUserProfile|createHousehold\(userId|joinHousehold\(userId" app components config contexts services
```

Expected: no matches.

Run: `npm --prefix functions test -- households.test.ts && npm test -- householdClient.test.ts && npx tsc --noEmit`

Expected: PASS and exit 0.

- [ ] **Step 5: Commit**

```bash
git add functions/src/authz.ts functions/src/callables/households.ts functions/src/index.ts functions/test/households.test.ts services/householdClient.ts tests/householdClient.test.ts contexts/AuthContext.tsx app/register.tsx app/login.tsx services/firestoreService.ts
git commit -m "feat: protect household membership mutations"
```

### Task 6: Bridge legacy recipe writes through the backend

**Goal:** Preserve the current pre-catalogue generator by routing its narrowly validated recipe create/label/reminder writes through authorized callables before direct client catalogue writes are denied.

**Files:**
- Modify: `functions/src/ai/contracts.ts`
- Modify: `functions/src/quota.ts`
- Create: `functions/src/callables/legacyRecipes.ts`
- Create: `functions/test/legacyRecipes.test.ts`
- Create: `services/legacyRecipeClient.ts`
- Create: `tests/legacyRecipeClient.test.ts`
- Modify: `functions/src/index.ts`
- Modify: `services/firestoreService.ts`
- Modify: `services/recipeScraperService.ts`
- Modify: `services/generatorService.ts`
- Modify: `components/RecipeDetailModal.tsx`

**Acceptance Criteria:**
- [ ] A current-household member can create one bounded legacy recipe only from the trusted source list and receives its server-generated document ID.
- [ ] A current-household member can update only `course`, controlled `tags`, `needsDefrost`, and `needsMarinate` on one legacy recipe.
- [ ] The bridge cannot delete recipes, bulk-update recipes, choose a document ID, write membership fields, or accept arbitrary Firestore fields.
- [ ] Current runtime generation, manual label editing, and reminder caching use the bridge and no longer call Firestore recipe writes directly.
- [ ] The bridge is quota-limited and explicitly removed in Phase 5 when catalogue-only generation cuts over.

**Verify:** `npm --prefix functions test -- legacyRecipes.test.ts && npm test -- legacyRecipeClient.test.ts && npx tsc --noEmit` → bridge tests pass and TypeScript exits 0.

**Steps:**

- [ ] **Step 1: Add exact legacy schemas and failing handler tests**

Add to `functions/src/ai/contracts.ts`:

```ts
const optionalUrl = z.string().url().max(2048).optional();
const legacyIngredient = z.object({
  name: ingredientName,
  quantity: z.number().finite().min(0).max(1_000_000),
  unit: z.string().max(40),
  notes: z.string().max(300).optional()
}).strict();
const legacyInstruction = z.object({
  text: z.string().trim().min(1).max(5_000),
  imageUrl: optionalUrl,
  videoEmbedUrl: optionalUrl,
  isHeader: z.boolean().optional()
}).strict();
const legacyTag = z.enum([
  'Breakfast', 'Lunch', 'Dinner', 'Side', 'Snack', 'Salad',
  'Asian', 'Mexican', 'Mediterranean', 'Italian', 'Indian',
  'Healthy', 'Vegetarian', 'Kid Friendly'
]);

export const legacyRecipeSchema = z.object({
  title: shortText,
  sourceUrl: z.string().url().max(2048),
  imageUrl: optionalUrl,
  videoEmbedUrl: optionalUrl,
  prepTime: z.string().max(80),
  cookTime: z.string().max(80),
  totalTime: z.string().max(80).optional(),
  originalServings: z.number().positive().max(10_000),
  course: z.array(shortText).max(20).optional(),
  tags: z.array(legacyTag).max(14).optional(),
  description: z.string().max(5_000).optional(),
  cuisine: z.string().max(100).optional(),
  difficulty: z.string().max(100).optional(),
  ingredients: z.array(legacyIngredient).min(1).max(200),
  ingredientGroups: z.array(z.object({
    name: z.string().max(200),
    ingredients: z.array(legacyIngredient).max(200)
  }).strict()).max(30).optional(),
  instructions: z.array(legacyInstruction).min(1).max(150),
  notes: z.string().max(20_000),
  nutrition: z.object({
    calories: z.number().finite().min(0).max(1_000_000),
    protein: z.number().finite().min(0).max(1_000_000),
    carbs: z.number().finite().min(0).max(1_000_000),
    fat: z.number().finite().min(0).max(1_000_000)
  }).strict(),
  needsDefrost: z.boolean().optional(),
  needsMarinate: z.boolean().optional()
}).strict();

export const saveLegacyRecipeRequest = householdRequest.extend({
  recipe: legacyRecipeSchema
}).strict();

export const updateLegacyRecipeMetadataRequest = householdRequest.extend({
  recipeId: z.string().min(1).max(160),
  course: z.array(shortText).max(20).optional(),
  tags: z.array(legacyTag).max(14).optional(),
  needsDefrost: z.boolean().optional(),
  needsMarinate: z.boolean().optional()
}).strict().refine((value) =>
  value.course !== undefined ||
  value.tags !== undefined ||
  value.needsDefrost !== undefined ||
  value.needsMarinate !== undefined,
  'At least one metadata field is required'
);
```

Extend the quota endpoint union and limits in `functions/src/ai/contracts.ts` and `functions/src/quota.ts`:

```ts
export type QuotaEndpoint =
  | AiEndpoint
  | 'legacyRecipeCreate'
  | 'legacyRecipeMetadata';

const DAILY_LIMITS: Record<QuotaEndpoint, number> = {
  tagRecipes: 100,
  reminderFlags: 100,
  shoppingGroups: 40,
  substitutions: 80,
  legacyRecipeCreate: 100,
  legacyRecipeMetadata: 200
};
```

Change `quotaDocumentId` and `reserveQuota` from `AiEndpoint` to `QuotaEndpoint`.

Create `functions/test/legacyRecipes.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createLegacyRecipeHandlers } from '../src/callables/legacyRecipes.js';

const recipe = {
  title: 'Soup',
  sourceUrl: 'https://www.recipetineats.com/soup/',
  prepTime: '10 min',
  cookTime: '20 min',
  totalTime: '30 min',
  originalServings: 4,
  ingredients: [{ name: 'onion', quantity: 1, unit: '' }],
  instructions: [{ text: 'Cook.' }],
  notes: '',
  nutrition: { calories: 100, protein: 2, carbs: 20, fat: 1 }
};

describe('legacy recipe bridge', () => {
  it('authorizes, quotas, and creates with a server ID', async () => {
    const create = vi.fn(async () => 'server-id');
    const reserve = vi.fn(async () => 1);
    const handlers = createLegacyRecipeHandlers({
      authorize: vi.fn(async () => ({ uid: 'u1', email: 'user@example.com' })),
      reserve,
      create,
      update: vi.fn()
    });
    await expect(handlers.save({
      auth: { uid: 'u1', token: {} },
      data: { householdId: 'h1', recipe }
    } as never)).resolves.toEqual({ recipeId: 'server-id' });
    expect(reserve).toHaveBeenCalledWith('u1', 'legacyRecipeCreate', 1);
    expect(create).toHaveBeenCalledWith(recipe);
  });

  it('rejects non-trusted source hosts before writing', async () => {
    const create = vi.fn();
    const handlers = createLegacyRecipeHandlers({
      authorize: vi.fn(async () => ({ uid: 'u1', email: 'user@example.com' })),
      reserve: vi.fn(),
      create,
      update: vi.fn()
    });
    await expect(handlers.save({
      auth: { uid: 'u1', token: {} },
      data: {
        householdId: 'h1',
        recipe: { ...recipe, sourceUrl: 'https://attacker.example/recipe' }
      }
    } as never)).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(create).not.toHaveBeenCalled();
  });

  it('updates only the schema-approved metadata fields', async () => {
    const update = vi.fn(async () => undefined);
    const handlers = createLegacyRecipeHandlers({
      authorize: vi.fn(async () => ({ uid: 'u1', email: 'user@example.com' })),
      reserve: vi.fn(async () => 1),
      create: vi.fn(),
      update
    });
    await handlers.update({
      auth: { uid: 'u1', token: {} },
      data: {
        householdId: 'h1',
        recipeId: 'r1',
        tags: ['Dinner'],
        needsDefrost: true
      }
    } as never);
    expect(update).toHaveBeenCalledWith('r1', {
      tags: ['Dinner'],
      needsDefrost: true
    });
  });
});
```

Run: `npm --prefix functions test -- legacyRecipes.test.ts`

Expected: FAIL because `createLegacyRecipeHandlers` does not exist.

- [ ] **Step 2: Implement the narrow Admin SDK bridge**

Create `functions/src/callables/legacyRecipes.ts`:

```ts
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import {
  saveLegacyRecipeRequest,
  updateLegacyRecipeMetadataRequest,
  type QuotaEndpoint
} from '../ai/contracts.js';

const TRUSTED_HOSTS = new Set([
  'www.recipetineats.com',
  'www.budgetbytes.com',
  'thewoksoflife.com',
  'www.themediterraneandish.com',
  'www.spendwithpennies.com',
  'cafedelites.com',
  'www.skinnytaste.com',
  'pinchofyum.com',
  'natashaskitchen.com',
  'www.seriouseats.com',
  'akispetretzikis.com',
  'cooking.nytimes.com',
  'www.americastestkitchen.com'
]);

type Identity = { uid: string; email: string };
type Authorize = (
  auth: CallableRequest<unknown>['auth'],
  householdId: string
) => Promise<Identity>;
type Reserve = (
  uid: string,
  endpoint: QuotaEndpoint,
  units: number
) => Promise<number>;
type LegacyRecipe = ReturnType<typeof saveLegacyRecipeRequest.parse>['recipe'];
type LegacyMetadata = Omit<
  ReturnType<typeof updateLegacyRecipeMetadataRequest.parse>,
  'householdId' | 'recipeId'
>;

export interface LegacyRecipeStore {
  create(recipe: LegacyRecipe): Promise<string>;
  update(recipeId: string, metadata: LegacyMetadata): Promise<void>;
}

export function firestoreLegacyRecipeStore(): LegacyRecipeStore {
  const db = getFirestore();
  return {
    async create(recipe) {
      const ref = db.collection('recipes').doc();
      await ref.create({
        ...recipe,
        scrapedAt: FieldValue.serverTimestamp(),
        legacyWriteBridge: true
      });
      return ref.id;
    },
    async update(recipeId, metadata) {
      await db.doc($recipes/${recipeId}).update({
        ...metadata,
        legacyMetadataUpdatedAt: FieldValue.serverTimestamp()
      });
    }
  };
}

export function createLegacyRecipeHandlers(deps: {
  authorize: Authorize;
  reserve: Reserve;
  create: LegacyRecipeStore['create'];
  update: LegacyRecipeStore['update'];
}) {
  return {
    save: async (request: CallableRequest<unknown>) => {
      const parsed = saveLegacyRecipeRequest.safeParse(request.data);
      if (!parsed.success) throw new HttpsError('invalid-argument', 'Invalid recipe.');
      const source = new URL(parsed.data.recipe.sourceUrl);
      if (source.protocol !== 'https:' || !TRUSTED_HOSTS.has(source.hostname.toLowerCase())) {
        throw new HttpsError('invalid-argument', 'Untrusted recipe source.');
      }
      const identity = await deps.authorize(request.auth, parsed.data.householdId);
      await deps.reserve(identity.uid, 'legacyRecipeCreate', 1);
      return { recipeId: await deps.create(parsed.data.recipe) };
    },
    update: async (request: CallableRequest<unknown>) => {
      const parsed = updateLegacyRecipeMetadataRequest.safeParse(request.data);
      if (!parsed.success) {
        throw new HttpsError('invalid-argument', 'Invalid recipe metadata.');
      }
      const identity = await deps.authorize(request.auth, parsed.data.householdId);
      await deps.reserve(identity.uid, 'legacyRecipeMetadata', 1);
      const { householdId: _householdId, recipeId, ...metadata } = parsed.data;
      await deps.update(recipeId, metadata);
      return { recipeId };
    }
  };
}
```

Modify `functions/src/index.ts`:

```ts
import {
  createLegacyRecipeHandlers,
  firestoreLegacyRecipeStore
} from './callables/legacyRecipes.js';

const legacyRecipeStore = firestoreLegacyRecipeStore();
const legacyRecipeHandlers = createLegacyRecipeHandlers({
  authorize: authorizeHouseholdMember,
  reserve: (uid, endpoint, units) =>
    reserveQuota(quotaStore, uid, endpoint, units),
  create: legacyRecipeStore.create,
  update: legacyRecipeStore.update
});

export const saveLegacyRecipe = onCall(legacyRecipeHandlers.save);
export const updateLegacyRecipeMetadata = onCall(legacyRecipeHandlers.update);
```

Run: `npm --prefix functions test -- legacyRecipes.test.ts`

Expected: PASS, 3 tests.

- [ ] **Step 3: Write and implement the mobile bridge adapter**

Create `tests/legacyRecipeClient.test.ts`:

```ts
import { expect, it, vi } from 'vitest';
import { createLegacyRecipeClient } from '../services/legacyRecipeClient';

it('strips client IDs and dates before saving', async () => {
  const invoke = vi.fn(async () => ({ data: { recipeId: 'server-id' } }));
  const client = createLegacyRecipeClient(invoke);
  const recipe = {
    id: 'client-id',
    title: 'Soup',
    sourceUrl: 'https://www.recipetineats.com/soup/',
    prepTime: '10 min',
    cookTime: '20 min',
    originalServings: 4,
    ingredients: [{ name: 'onion', quantity: 1, unit: '' }],
    instructions: [{ text: 'Cook.' }],
    notes: '',
    nutrition: { calories: 100, protein: 2, carbs: 20, fat: 1 },
    scrapedAt: new Date('2026-07-13T00:00:00Z')
  };
  await expect(client.save('h1', recipe)).resolves.toBe('server-id');
  expect(invoke).toHaveBeenCalledWith('saveLegacyRecipe', {
    householdId: 'h1',
    recipe: expect.not.objectContaining({ id: 'client-id', scrapedAt: expect.anything() })
  });
});
```

Create `services/legacyRecipeClient.ts`:

```ts
import { functions } from '@/config/firebase';
import type { Recipe } from './types';
import { httpsCallable } from 'firebase/functions';

type Endpoint = 'saveLegacyRecipe' | 'updateLegacyRecipeMetadata';
type Invoke = (endpoint: Endpoint, data: object) => Promise<{ data: unknown }>;
const firebaseInvoke: Invoke = (endpoint, data) =>
  httpsCallable(functions, endpoint)(data);

export function createLegacyRecipeClient(invoke: Invoke = firebaseInvoke) {
  return {
    async save(householdId: string, recipe: Recipe): Promise<string> {
      if (!householdId) throw new Error('Household is required');
      const { id: _id, scrapedAt: _scrapedAt, ...serializable } = recipe;
      const result = await invoke('saveLegacyRecipe', {
        householdId,
        recipe: JSON.parse(JSON.stringify(serializable))
      }) as { data: { recipeId: string } };
      return result.data.recipeId;
    },
    async update(
      householdId: string,
      recipeId: string,
      metadata: {
        course?: string[];
        tags?: string[];
        needsDefrost?: boolean;
        needsMarinate?: boolean;
      }
    ): Promise<void> {
      if (!householdId) throw new Error('Household is required');
      await invoke('updateLegacyRecipeMetadata', {
        householdId,
        recipeId,
        ...metadata
      });
    }
  };
}

export const legacyRecipeClient = createLegacyRecipeClient();
```

Run: `npm test -- legacyRecipeClient.test.ts`

Expected: PASS.

- [ ] **Step 4: Replace every direct legacy recipe write**

In `services/firestoreService.ts`, import `legacyRecipeClient` and change:

```ts
export async function saveRecipe(householdId: string, recipe: Recipe): Promise<string> {
  return legacyRecipeClient.save(householdId, recipe);
}

export async function updateRecipeCourse(
  householdId: string,
  recipeId: string,
  course: string[]
): Promise<void> {
  return legacyRecipeClient.update(householdId, recipeId, { course });
}

export async function updateRecipeTags(
  householdId: string,
  recipeId: string,
  tags: string[]
): Promise<void> {
  return legacyRecipeClient.update(householdId, recipeId, { tags });
}

export async function updateRecipeFlags(
  householdId: string,
  recipeId: string,
  flags: { needsDefrost?: boolean; needsMarinate?: boolean }
): Promise<void> {
  return legacyRecipeClient.update(householdId, recipeId, flags);
}
```

Add `householdId: string` to `ScrapeRequest` in `services/recipeScraperService.ts` and pass it to both `saveRecipe(request.householdId, recipe)` sites.

In `services/generatorService.ts`:

- Add `householdId` to every `ScrapeRequest` object.
- Pass `householdId` to `updateRecipeTags`, `getGeminiGroupings`, `getGeminiReminderFlags`, and `updateRecipeFlags`.

In `components/RecipeDetailModal.tsx`:

```tsx
const { householdId } = useAuth();
if (!householdId || !recipe?.id) return;
await legacyRecipeClient.update(householdId, recipe.id, {
  course: localCourse,
  tags: localTags
});
```

Run:

```powershell
rg -n "addDoc\(collection\(db, 'recipes'\)|setDoc\(doc\(db, 'recipes'|updateDoc\(doc\(db, 'recipes'|deleteDoc\(doc\(db, 'recipes'" app components config contexts services
```

Expected: no matches.

Run: `npm --prefix functions test -- legacyRecipes.test.ts && npm test -- legacyRecipeClient.test.ts && npx tsc --noEmit`

Expected: PASS and exit 0.

- [ ] **Step 5: Commit**

```bash
git add functions/src/ai/contracts.ts functions/src/quota.ts functions/src/callables/legacyRecipes.ts functions/test/legacyRecipes.test.ts functions/src/index.ts services/legacyRecipeClient.ts tests/legacyRecipeClient.test.ts services/firestoreService.ts services/recipeScraperService.ts services/generatorService.ts components/RecipeDetailModal.tsx
git commit -m "feat: protect legacy recipe writes"
```

### Task 7: Harden and emulator-test Firestore rules

**Goal:** Prove that clients cannot list households, mutate membership, write/delete global recipes or the legacy index, or access another household's data.

**Files:**
- Modify: `firestore.rules`
- Create: `tests/firestore.rules.test.ts`
- Modify: `package.json`
- Modify: `firebase.json`

**Acceptance Criteria:**
- [ ] Authenticated members can get their household and read/write its existing app subcollections.
- [ ] Non-members cannot read the household or its subcollections.
- [ ] No client can list households or create/update/delete a household.
- [ ] Authenticated clients can read legacy recipes/index documents but cannot create/update/delete them.
- [ ] A user can read only their own profile; profile writes are backend-only.
- [ ] Allowlist supports single-document get but denies collection list.

**Verify:** `npm run test:rules` → Firebase emulator starts, the authorization matrix passes, and the command exits 0.

**Steps:**

- [ ] **Step 1: Install emulator test support and write the failing authorization matrix**

Add to root `package.json`:

```json
{
  "scripts": {
    "test:rules:vitest": "vitest run tests/firestore.rules.test.ts",
    "test:rules": "firebase emulators:exec --only firestore \"npm run test:rules:vitest\""
  },
  "devDependencies": {
    "@firebase/rules-unit-testing": "^4.0.1",
    "firebase-tools": "^14.9.0"
  }
}
```

Create `tests/firestore.rules.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment
} from '@firebase/rules-unit-testing';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc
} from 'firebase/firestore';
import { afterAll, beforeAll, describe, it } from 'vitest';

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'mealwizard-rules-test',
    firestore: {
      host: '127.0.0.1',
      port: 8080,
      rules: readFileSync('firestore.rules', 'utf8')
    }
  });
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'households/h1'), {
      members: ['member'],
      inviteCode: 'ABC12345'
    });
    await setDoc(doc(db, 'households/h1/cookbook/r1'), { recipeId: 'r1' });
    await setDoc(doc(db, 'users/member'), { email: 'member@example.com', householdId: 'h1' });
    await setDoc(doc(db, 'recipes/r1'), { title: 'Soup' });
    await setDoc(doc(db, 'recipeIndex/site/recipes/r1'), { url: 'https://example.com/r1' });
    await setDoc(doc(db, 'allowlist/member@example.com'), { enabled: true });
  });
});

afterAll(async () => env.cleanup());

describe('household isolation', () => {
  it('allows member get and subcollection access', async () => {
    const db = env.authenticatedContext('member').firestore();
    await assertSucceeds(getDoc(doc(db, 'households/h1')));
    await assertSucceeds(getDoc(doc(db, 'households/h1/cookbook/r1')));
    await assertSucceeds(setDoc(doc(db, 'households/h1/shoppingList/i1'), {
      name: 'Milk',
      checked: false
    }));
  });

  it('denies outsider reads and all client household mutations', async () => {
    const outsider = env.authenticatedContext('outsider').firestore();
    const member = env.authenticatedContext('member').firestore();
    await assertFails(getDoc(doc(outsider, 'households/h1')));
    await assertFails(getDoc(doc(outsider, 'households/h1/cookbook/r1')));
    await assertFails(getDocs(collection(member, 'households')));
    await assertFails(updateDoc(doc(member, 'households/h1'), {
      members: ['member', 'outsider']
    }));
    await assertFails(setDoc(doc(member, 'households/h2'), {
      members: ['member'],
      inviteCode: 'NEW12345'
    }));
  });
});

describe('global and profile data', () => {
  it('allows authenticated catalogue reads but denies writes and deletes', async () => {
    const db = env.authenticatedContext('member').firestore();
    await assertSucceeds(getDoc(doc(db, 'recipes/r1')));
    await assertSucceeds(getDoc(doc(db, 'recipeIndex/site/recipes/r1')));
    await assertFails(updateDoc(doc(db, 'recipes/r1'), { title: 'Changed' }));
    await assertFails(deleteDoc(doc(db, 'recipes/r1')));
    await assertFails(setDoc(doc(db, 'recipeIndex/site/recipes/r2'), { url: 'x' }));
  });

  it('allows only owner profile reads and no client profile writes', async () => {
    const member = env.authenticatedContext('member').firestore();
    const outsider = env.authenticatedContext('outsider').firestore();
    await assertSucceeds(getDoc(doc(member, 'users/member')));
    await assertFails(getDoc(doc(outsider, 'users/member')));
    await assertFails(updateDoc(doc(member, 'users/member'), { householdId: 'h2' }));
  });

  it('allows a direct allowlist get but denies enumeration', async () => {
    const anonymous = env.unauthenticatedContext().firestore();
    await assertSucceeds(getDoc(doc(anonymous, 'allowlist/member@example.com')));
    await assertFails(getDocs(collection(anonymous, 'allowlist')));
  });
});
```

Run: `npm install && npm run test:rules`

Expected: FAIL against the current permissive rules.

- [ ] **Step 2: Replace the rules with the hardened policy**

Replace `firestore.rules`:

```text
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function signedIn() {
      return request.auth != null;
    }

    function isHouseholdMember(householdId) {
      return signedIn()
        && request.auth.uid in get(
          /databases/$(database)/documents/households/$(householdId)
        ).data.members;
    }

    match /users/{userId} {
      allow get: if signedIn() && request.auth.uid == userId;
      allow list, create, update, delete: if false;
    }

    match /households/{householdId} {
      allow get: if signedIn() && request.auth.uid in resource.data.members;
      allow list, create, update, delete: if false;

      match /mealPlan/{document=**} {
        allow read, write: if isHouseholdMember(householdId);
      }
      match /shoppingList/{document=**} {
        allow read, write: if isHouseholdMember(householdId);
      }
      match /cookbook/{document=**} {
        allow read, write: if isHouseholdMember(householdId);
      }
      match /settings/{document=**} {
        allow read, write: if isHouseholdMember(householdId);
      }
      match /generationResult/{document=**} {
        allow read, write: if isHouseholdMember(householdId);
      }
      match /state/{document=**} {
        allow read, write: if isHouseholdMember(householdId);
      }
    }

    match /recipes/{recipeId} {
      allow read: if signedIn();
      allow create, update, delete: if false;
    }

    match /recipeIndex/{site}/recipes/{recipeId} {
      allow read: if signedIn();
      allow create, update, delete: if false;
    }

    match /allowlist/{email} {
      allow get: if true;
      allow list, create, update, delete: if false;
    }

    match /aiUsage/{document=**} {
      allow read, write: if false;
    }
  }
}
```

Run: `npm run test:rules`

Expected: PASS, all tests.

- [ ] **Step 3: Ensure emulator configuration points to the same rules**

Keep `firebase.json` Firestore and emulator sections exactly as created in Task 1; add no alternate rules path. Run:

```powershell
firebase emulators:exec --only firestore "npm run test:rules:vitest"
```

Expected: emulator logs `All emulators ready`, Vitest passes, and the emulator shuts down cleanly.

- [ ] **Step 4: Commit**

```bash
git add firestore.rules tests/firestore.rules.test.ts package.json package-lock.json firebase.json
git commit -m "fix: enforce Firestore security boundaries"
```

### Task 8: Preserve unavailable-recipe history

**Goal:** Remove every client path that can globally delete recipes and show a stable “Recipe unavailable” state without deleting meal-plan or cookbook references when a recipe read is missing.

**Files:**
- Create: `tests/dataSafety.test.ts`
- Modify: `components/SettingsModal.tsx`
- Modify: `services/firestoreService.ts`
- Modify: `app/(tabs)/index.tsx`
- Modify: `app/(tabs)/cookbook.tsx`

**Acceptance Criteria:**
- [ ] Settings contains no Clear Recipe Cache control.
- [ ] Client data services export no single/global recipe delete operation.
- [ ] A missing recipe marks its meal-plan/cookbook row unavailable and leaves the reference document intact.
- [ ] Explicit user-initiated removal of a meal-plan or cookbook item still works.
- [ ] Loading and missing states are visually distinct.

**Verify:** `npm test -- dataSafety.test.ts && npm run lint && npx tsc --noEmit` → regression tests, lint, and type-check pass.

**Steps:**

- [ ] **Step 1: Write the failing source-level regression tests**

Create `tests/dataSafety.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');

describe('catalogue data safety', () => {
  it('has no global or single recipe deletion client API', () => {
    const service = read('services/firestoreService.ts');
    expect(service).not.toMatch(/export async function clearAllCachedRecipes/);
    expect(service).not.toMatch(/export async function deleteRecipe/);
  });

  it('has no destructive cache control', () => {
    const settings = read('components/SettingsModal.tsx');
    expect(settings).not.toContain('Clear Recipe Cache');
    expect(settings).not.toContain('clearAllCachedRecipes');
  });

  it('does not self-delete missing historical references', () => {
    const calendar = read('app/(tabs)/index.tsx');
    const cookbook = read('app/(tabs)/cookbook.tsx');
    expect(calendar).not.toContain('Self-healing');
    expect(calendar).not.toMatch(/missingIds[\s\S]{0,800}deleteMealPlanEntry/);
    expect(cookbook).not.toContain('Self-healing');
    expect(cookbook).not.toMatch(/missingIds[\s\S]{0,800}removeFromCookbook/);
    expect(calendar).toContain('Recipe unavailable');
    expect(cookbook).toContain('Recipe unavailable');
  });
});
```

Run: `npm test -- dataSafety.test.ts`

Expected: FAIL against the existing clear/self-heal paths.

- [ ] **Step 2: Remove the global deletion UI and service operations**

In `components/SettingsModal.tsx`:

- Remove `clearAllCachedRecipes` from the Firestore service import.
- Remove the entire Cache section from its `<Text style={styles.sectionTitle}>Cache</Text>` heading through the closing clear-cache `</TouchableOpacity>`.
- Remove `clearCacheBtn` and `clearCacheText` style entries if they become unused.

In `services/firestoreService.ts` delete these complete exports:

```ts
export async function deleteRecipe(recipeId: string): Promise<void>
export async function clearAllCachedRecipes(): Promise<number>
```

Remove the now-unused `deleteDoc` import only if no household subcollection operation still uses it.

- [ ] **Step 3: Preserve missing meal-plan references**

In `app/(tabs)/index.tsx`, add missing-state tracking beside `recipes`:

```tsx
const [missingRecipeIds, setMissingRecipeIds] = useState<Set<string>>(new Set());
```

Replace the lazy-load completion block with:

```tsx
Promise.all(toLoad.map(getRecipe)).then((fetched) => {
  setRecipes((previous) => {
    const next = { ...previous };
    fetched.forEach((recipe, index) => {
      if (recipe) next[toLoad[index]] = recipe;
    });
    return next;
  });
  setMissingRecipeIds((previous) => {
    const next = new Set(previous);
    fetched.forEach((recipe, index) => {
      if (recipe) next.delete(toLoad[index]);
      else next.add(toLoad[index]);
    });
    return next;
  });
});
```

Where meal cards derive their label and press behavior, use:

```tsx
const recipe = recipes[entry.recipeId];
const recipeMissing = missingRecipeIds.has(entry.recipeId);
const recipeTitle = recipe?.title
  ?? (recipeMissing ? 'Recipe unavailable' : 'Loading…');

onPress={recipe ? () => setPreviewRecipe(recipe) : undefined}
disabled={!recipe}
```

Keep `handleDelete` unchanged so an explicit user action can still remove the meal-plan entry.

- [ ] **Step 4: Preserve missing cookbook references**

In `app/(tabs)/cookbook.tsx`, add:

```tsx
const [missingRecipeIds, setMissingRecipeIds] = useState<Set<string>>(new Set());
```

Use the same non-destructive lazy-load state update as the calendar and delete the self-heal `removeFromCookbook` loop. Pass the missing state into both card variants:

```tsx
<GridCard
  entry={entry}
  recipe={recipe}
  missing={missingRecipeIds.has(entry.recipeId)}
  colors={colors}
  onPress={() => recipe && setPreviewRecipe(recipe)}
  onStar={() => handleStarToggle(entry)}
/>
```

Add `missing: boolean` to `GridCard` and `ListRow` props. Render:

```tsx
{recipe ? (
  <Text style={[s.avatarText, { color: colors.primary }]}>{initials}</Text>
) : missing ? (
  <Ionicons name="alert-circle-outline" size={24} color={colors.textTertiary} />
) : (
  <ActivityIndicator size="small" color={colors.primary} />
)}

<Text style={[s.cardTitle, { color: colors.text }]} numberOfLines={2}>
  {recipe?.title ?? (missing ? 'Recipe unavailable' : 'Loading…')}
</Text>
```

Set each card's `disabled={missing || !recipe}`. Keep the existing star/remove functions available because they are explicit user actions on the historical reference.

Run: `npm test -- dataSafety.test.ts && npm run lint && npx tsc --noEmit`

Expected: PASS and exit 0.

- [ ] **Step 5: Commit**

```bash
git add tests/dataSafety.test.ts components/SettingsModal.tsx services/firestoreService.ts "app/(tabs)/index.tsx" "app/(tabs)/cookbook.tsx"
git commit -m "fix: preserve history when recipes are unavailable"
```

### Task 9: Secure operator tooling and scans

**Goal:** Keep the temporary scheduled tagger functional through Secret Manager, remove provider values from EAS configuration, and add an automated client source/export leak scan.

**Files:**
- Create: `scripts/lib/geminiAdmin.ts`
- Create: `scripts/scanClientSecrets.mjs`
- Create: `tests/clientSecretScan.test.ts`
- Modify: `scripts/tagRecipeIndex.ts`
- Modify: `scripts/test-tagger.ts`
- Modify: `scripts/evaluate-shopping-list.ts`
- Modify: `scripts/run-daily-crawl.ps1`
- Modify: `package.json`
- Modify: `.gitignore`

**Acceptance Criteria:**
- [ ] Operator AI scripts obtain `mealwizard-gemini-api-key` from Secret Manager using Application Default Credentials and never read an Expo/provider environment variable.
- [ ] The scheduled tagger's service account has accessor permission only on the Gemini secret; the unused DeepSeek secret is not granted to code.
- [ ] `eas.json` contains no Gemini/DeepSeek value or paid-provider key/model field.
- [ ] The scanner fails on provider environment names, direct provider hosts, `?key=` provider calls, and common DeepSeek key tokens in client source/export artifacts.
- [ ] The scheduled task has a conservative 16,000-write worst-case allocation (12,000 discovery plus at most 4,000 tag/cache writes), leaving at least 2,000 below the 18,000 ingestion ceiling, and remains a temporary Phase 0 bridge.

**Verify:** `npm test -- clientSecretScan.test.ts && npm run scan:client-secrets && npx tsc --noEmit` → tests and scan pass with `Client secret scan clean`.

**Steps:**

- [ ] **Step 1: Add the Secret Manager operator adapter**

Add to root `package.json`:

```json
{
  "scripts": {
    "scan:client-secrets": "node scripts/scanClientSecrets.mjs"
  },
  "devDependencies": {
    "@google-cloud/secret-manager": "^6.1.0",
    "tsx": "^4.20.3"
  }
}
```

Create `scripts/lib/geminiAdmin.ts`:

```ts
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { tagRecipesResponse, shoppingGroupsResponse } from '../../functions/src/ai/contracts';
import {
  buildShoppingGroupsPrompt,
  buildTagRecipesPrompt
} from '../../functions/src/ai/prompts';
import { requestGeminiJson } from '../../functions/src/ai/geminiProvider';

const secretClient = new SecretManagerServiceClient();
let cachedKey: string | null = null;

async function getGeminiKey(): Promise<string> {
  if (cachedKey) return cachedKey;
  const projectId = process.env.GOOGLE_CLOUD_PROJECT
    ?? process.env.GCLOUD_PROJECT
    ?? 'meal-wizard-ad202';
  const [version] = await secretClient.accessSecretVersion({
    name: $projects/${projectId}/secrets/mealwizard-gemini-api-key/versions/latest
  });
  const value = Buffer.from(version.payload?.data ?? []).toString('utf8').trim();
  if (!value) throw new Error('Gemini secret version is empty');
  cachedKey = value;
  return value;
}

export async function tagRecipesWithAdminGemini(
  recipes: Parameters<typeof buildTagRecipesPrompt>[0],
  model = 'gemini-3.1-flash-lite'
): Promise<Map<string, string[]>> {
  const raw = await requestGeminiJson<unknown>({
    apiKey: await getGeminiKey(),
    model,
    prompt: buildTagRecipesPrompt(recipes),
    maxOutputTokens: Math.min(32_000, 4_096 + recipes.length * 400)
  });
  const parsed = tagRecipesResponse.parse(raw);
  return new Map(parsed.results.map((entry) => [entry.id, entry.tags]));
}

export async function getAdminShoppingGroups(
  ingredients: Parameters<typeof buildShoppingGroupsPrompt>[0],
  model = 'gemini-3.5-flash'
) {
  const raw = await requestGeminiJson<unknown>({
    apiKey: await getGeminiKey(),
    model,
    prompt: buildShoppingGroupsPrompt(ingredients),
    maxOutputTokens: Math.min(65_536, 4_096 + ingredients.length * 200)
  });
  return shoppingGroupsResponse.parse(raw);
}
```

- [ ] **Step 2: Point all operator scripts at the admin adapter**

In `scripts/tagRecipeIndex.ts` and `scripts/test-tagger.ts`:

```ts
import { tagRecipesWithAdminGemini } from './lib/geminiAdmin';
```

In `scripts/tagRecipeIndex.ts`, convert the `valid` recipes to the same bounded input used by the callable:

```ts
const aiInput = valid.map(({ id: recipeId, recipe }) => ({
  recipeId,
  title: recipe.title,
  totalMinutes: recipe.totalTime ? Number.parseInt(recipe.totalTime, 10) || null : null,
  ingredients: recipe.ingredients.map((ingredient) => ingredient.name),
  steps: recipe.instructions.map((step) => step.text.slice(0, 300)),
  existingTags: recipe.tags ?? []
}));
const tagsById = await tagRecipesWithAdminGemini(aiInput, GEMINI_MODEL);
```

In `scripts/test-tagger.ts`, use its `recipes` array:

```ts
const aiInput = recipes.map(({ recipeId, recipe }) => ({
  recipeId,
  title: recipe.title,
  totalMinutes: recipe.totalTime ? Number.parseInt(recipe.totalTime, 10) || null : null,
  ingredients: recipe.ingredients.map((ingredient) => ingredient.name),
  steps: recipe.instructions.map((step) => step.text.slice(0, 300)),
  existingTags: recipe.tags ?? []
}));
const proResults = await tagRecipesWithAdminGemini(aiInput, proModel);
const flashLiteResults = await tagRecipesWithAdminGemini(aiInput, flashLiteModel);
```

In `scripts/evaluate-shopping-list.ts`:

```ts
import { getAdminShoppingGroups } from './lib/geminiAdmin';

const groups = await getAdminShoppingGroups(
  rawIngredients.map(({ id, name, quantity, unit }) => ({ id, name, quantity, unit })),
  model.id
);
```

At the start of `scripts/run-daily-crawl.ps1`, after resolving `$ProjectRoot`, require Application Default Credentials and keep the current write limit:

```powershell
$ServiceAccountPath = Join-Path $ProjectRoot 'service-account.json'
if (-not (Test-Path -LiteralPath $ServiceAccountPath)) {
  throw "service-account.json is required for Firestore and Secret Manager access."
}
$env:GOOGLE_APPLICATION_CREDENTIALS = $ServiceAccountPath
$env:GOOGLE_CLOUD_PROJECT = 'meal-wizard-ad202'
$DailyWriteCeiling = 18000
$DiscoveryWriteLimit = 12000
$TagLimitPerSite = 500
```

Use `$DiscoveryWriteLimit` for `buildRecipeIndex.ts --limit` and `$TagLimitPerSite` for `tagRecipeIndex.ts --limit`. The tagger can touch four sources and writes at most two documents per successful recipe, so `12,000 + (500 × 4 × 2) = 16,000` scheduled writes in the worst successful case, leaving at least 2,000 writes below the approved ingestion ceiling for normal app activity and bridge metadata.

Grant the existing local tagger identity access to only the Gemini secret:

```powershell
$serviceAccountEmail = (Get-Content -LiteralPath .\service-account.json -Raw | ConvertFrom-Json).client_email
gcloud secrets add-iam-policy-binding mealwizard-gemini-api-key --project meal-wizard-ad202 --member="serviceAccount:$serviceAccountEmail" --role="roles/secretmanager.secretAccessor"
```

Expected: Google Cloud reports the policy updated for `mealwizard-gemini-api-key`. Do not run the equivalent command for `mealwizard-deepseek-api-key` because no Phase 0 code uses DeepSeek.

- [ ] **Step 3: Verify tracked EAS configuration remains provider-free**

Confirm Task 4 removed these fields from every `eas.json` build-profile `env` object:

```text
EXPO_PUBLIC_GEMINI_API_KEY
EXPO_PUBLIC_DEEPSEEK_API_KEY
EXPO_PUBLIC_DEEPSEEK_MODEL
```

Expected: `rg -n "EXPO_PUBLIC_(GEMINI|DEEPSEEK)" eas.json` returns no matches. Keep `EXPO_PUBLIC_FIREBASE_*` and Google OAuth client IDs because these are intentionally public client configuration.

- [ ] **Step 4: Write the failing scanner test and implement the scanner**

Create `tests/clientSecretScan.test.ts`:

```ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

it('fails when an exported bundle contains a provider key name', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mealwizard-secret-scan-'));
  directories.push(directory);
  writeFileSync(join(directory, 'bundle.js'), 'const x="EXPO_PUBLIC_GEMINI_API_KEY"');
  const result = spawnSync(process.execPath, [
    'scripts/scanClientSecrets.mjs',
    directory
  ], { encoding: 'utf8' });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('EXPO_PUBLIC_GEMINI_API_KEY');
});

it('passes a clean export directory', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mealwizard-secret-scan-'));
  directories.push(directory);
  writeFileSync(join(directory, 'bundle.js'), 'const endpoint="tagRecipes"');
  const result = spawnSync(process.execPath, [
    'scripts/scanClientSecrets.mjs',
    directory
  ], { encoding: 'utf8' });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Client secret scan clean');
});
```

Create `scripts/scanClientSecrets.mjs`:

```js
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';

const defaultTargets = [
  'app', 'components', 'config', 'contexts', 'services', 'eas.json'
];
const targets = (process.argv.slice(2).length
  ? process.argv.slice(2)
  : defaultTargets).map(resolve);
const textExtensions = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.json', '.map', '.html'
]);
const forbidden = [
  /EXPO_PUBLIC_GEMINI_API_KEY/g,
  /EXPO_PUBLIC_DEEPSEEK_API_KEY/g,
  /EXPO_PUBLIC_DEEPSEEK_MODEL/g,
  /generativelanguage\.googleapis\.com/g,
  /api\.deepseek\.com/g,
  /:generateContent\?key=/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g
];

function filesAt(path) {
  const stat = statSync(path);
  if (stat.isFile()) return [path];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
    filesAt(resolve(path, entry.name))
  );
}

const findings = [];
for (const target of targets) {
  for (const file of filesAt(target)) {
    if (!textExtensions.has(extname(file).toLowerCase())) continue;
    const text = readFileSync(file, 'utf8');
    for (const pattern of forbidden) {
      pattern.lastIndex = 0;
      if (pattern.test(text)) findings.push(${file}: ${pattern.source});
    }
  }
}

if (findings.length) {
  console.error('Paid-provider material found in client artifacts:');
  findings.forEach((finding) => console.error($- ${finding}));
  process.exit(1);
}
console.log($Client secret scan clean (${targets.length} target(s)).);
```

Add `.phase0-dist/` to `.gitignore`.

Run: `npm test -- clientSecretScan.test.ts && npm run scan:client-secrets`

Expected: PASS and `Client secret scan clean`.

- [ ] **Step 5: Verify the temporary schedule can access the secret without exposing it**

Run a one-item tagger check:

```powershell
npx tsx scripts/tagRecipeIndex.ts --site cooking.nytimes.com --limit 1
```

Expected: output names the model and reports a tagger summary without logging any provider key, prompt, or response body. If the site has no untagged entries, run against the first indexed source reported by:

```powershell
npx tsx scripts/tagRecipeIndex.ts --limit 1
```

Run: `npm test -- clientSecretScan.test.ts && npm run scan:client-secrets && npx tsc --noEmit`

Expected: PASS and exit 0.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/geminiAdmin.ts scripts/scanClientSecrets.mjs tests/clientSecretScan.test.ts scripts/tagRecipeIndex.ts scripts/test-tagger.ts scripts/evaluate-shopping-list.ts scripts/run-daily-crawl.ps1 package.json package-lock.json .gitignore
git commit -m "fix: remove provider secrets from client tooling"
```

### Task 10: Deploy, smoke-test, scan, and revoke old keys

**Goal:** Capture a Phase 0 evidence record from emulator tests, deployed callables/rules, a clean exported client bundle, live authorized and unauthorized smoke tests, preserved missing-recipe references, and confirmed old-key revocation; pass only when every result is green before Phase 1 begins.

> **USER-ORDERED GATE — NON-SKIPPABLE.** This task was requested by the user in the current conversation. It MUST NOT be closed by walking around it, by declaring it "verified inline", or by substituting a cheaper check. Close only after every item in `acceptanceCriteria` has been re-validated independently, with output captured.

**Files:**
- Create: `docs/superpowers/verification/phase-0-security-evidence.md`
- Modify: `docs/superpowers/specs/2026-07-13-unified-recipe-catalog-design.md`

**Acceptance Criteria:**
- [ ] `npm run verify:phase0` passes functions tests/build, client tests/lint/type-check, Firestore emulator rules tests, and the client source scan.
- [ ] Firebase deploy succeeds for Functions and Firestore rules in `meal-wizard-ad202`, and deployed logs show successful calls without prompts, ingredients, responses, or secrets.
- [ ] An authenticated allowlisted household member can use all four AI features and create/join/switch a household.
- [ ] Unauthenticated/non-member calls fail, client recipe writes/deletes fail, and membership-array writes fail.
- [ ] A missing-recipe simulation leaves the meal-plan and cookbook documents present and shows “Recipe unavailable”.
- [ ] A fresh Expo export scans clean, and the replacement preview build uses callables rather than direct provider requests.
- [ ] The existing scheduled tagger either completes its Secret Manager smoke test or is paused explicitly until Phase 1.
- [ ] The old Gemini key is disabled/revoked and the old DeepSeek key is revoked; replacement secret versions remain enabled.
- [ ] Evidence is recorded in `docs/superpowers/verification/phase-0-security-evidence.md` with command, timestamp, pass/fail, and sanitized output for each check.

**Verify:** `npm run verify:phase0` plus `firebase deploy --only functions,firestore:rules --project meal-wizard-ad202` and the signed-in app smoke matrix → every automated command exits 0, every live row is PASS, bundle scan is clean, and both old-key rows say REVOKED.

**Steps:**

- [ ] **Step 1: Add the aggregate local verification command**

Add to root `package.json`:

```json
{
  "scripts": {
    "test:client": "vitest run tests --exclude tests/firestore.rules.test.ts",
    "build:functions": "npm --prefix functions run build",
    "test:functions": "npm --prefix functions test",
    "verify:phase0": "npm run test:functions && npm run build:functions && npm run test:client && npm run test:rules && npm run lint && tsc --noEmit && npm run scan:client-secrets"
  }
}
```

Run: `npm run verify:phase0`

Expected: all suites pass and the final line includes `Client secret scan clean`.

- [ ] **Step 2: Deploy the server boundary**

Confirm the replacement Gemini secret exists without printing its value:

```powershell
gcloud secrets versions list mealwizard-gemini-api-key --project meal-wizard-ad202 --filter="state=ENABLED" --format="value(name)"
```

Expected: at least one enabled version number.

Deploy:

```powershell
firebase deploy --only functions,firestore:rules --project meal-wizard-ad202
```

Expected: deployment reports success for `tagRecipes`, `reminderFlags`, `shoppingGroups`, `substitutions`, `createHousehold`, `joinHousehold`, `switchHousehold`, `saveLegacyRecipe`, `updateLegacyRecipeMetadata`, and Firestore rules.

- [ ] **Step 3: Run the live authorization and feature smoke matrix**

Using the replacement preview build and an allowlisted account:

1. Generate a plan that triggers recipe tagging.
2. Confirm the plan to trigger shopping grouping and reminder flags.
3. Open one ingredient substitution.
4. Create a temporary household, join it from the second allowlisted account, and switch back.
5. Attempt an unauthenticated callable invocation; record `unauthenticated`.
6. Attempt an authenticated non-member AI invocation; record `permission-denied`.
7. Attempt client SDK updates to `recipes/{id}` and `households/{id}.members`; record Firestore `permission-denied`.

Inspect sanitized logs:

```powershell
firebase functions:log --project meal-wizard-ad202 --only tagRecipes,reminderFlags,shoppingGroups,substitutions,createHousehold,joinHousehold,switchHousehold
```

Expected: success/error metadata includes endpoint, UID, duration, quota, and outcome; it contains no provider key, `prompt` field, ingredient list, or provider response.

- [ ] **Step 4: Prove missing recipe references survive**

In the Firestore console, choose one temporary test meal-plan reference and one temporary test cookbook reference. Point each test record to `phase0-missing-recipe`, which must not exist in `/recipes`. Reopen Calendar and Cookbook.

Expected:

- Both screens show `Recipe unavailable`.
- The two reference documents remain present after refresh.
- Restore or explicitly remove only the two temporary test records after capturing evidence.

- [ ] **Step 5: Build and scan a fresh client export**

Run:

```powershell
npx expo export --platform web --output-dir .phase0-dist
node scripts/scanClientSecrets.mjs .phase0-dist
```

Expected: export succeeds and prints `Client secret scan clean`.

Create a replacement preview build:

```powershell
eas build --profile preview --platform android
```

Expected: EAS reports a successful preview artifact. Install it and repeat one substitution plus one generated-plan confirmation, proving the built client uses deployed callables.

- [ ] **Step 6: Verify the schedule bridge, then revoke old credentials**

Run:

```powershell
npx tsx scripts/tagRecipeIndex.ts --limit 1
```

Expected: the tagger reaches Secret Manager and exits 0 without exposing the secret. If it cannot be repaired without broadening secret access, disable the Windows scheduled task and record `PAUSED UNTIL PHASE 1`; do not restore an Expo key.

After all earlier steps are green, use the provider consoles to:

1. Disable/revoke the old Gemini key that appeared in earlier builds/history.
2. Revoke the old DeepSeek key.
3. Leave the replacement `mealwizard-gemini-api-key` Secret Manager version enabled.
4. Leave `mealwizard-deepseek-api-key` stored but unused and without a runtime accessor grant.
5. Review provider usage for unexpected calls during the observation window.

Expected: evidence rows read `old-gemini-key=REVOKED` and `old-deepseek-key=REVOKED`.

- [ ] **Step 7: Write the evidence record and mark the design ready for Phase 1**

Create `docs/superpowers/verification/phase-0-security-evidence.md` with this completed table:

```markdown
# Phase 0 Security Evidence

| Check | Timestamp (UTC) | Result | Sanitized evidence |
|---|---:|---|---|
| Local Phase 0 suite |  | PASS |  |
| Firestore emulator matrix |  | PASS |  |
| Functions/rules deployment |  | PASS |  |
| Four authorized AI flows |  | PASS |  |
| Unauthorized callable/rules attempts |  | PASS |  |
| Missing-reference preservation |  | PASS |  |
| Client export secret scan |  | PASS |  |
| Preview-build smoke |  | PASS |  |
| Scheduled tagger |  | PASS or PAUSED UNTIL PHASE 1 |  |
| Old Gemini key |  | REVOKED |  |
| Old DeepSeek key |  | REVOKED |  |
```

Do not paste key values, provider responses, full prompts, or ingredient payloads into the evidence document.

Change the design document status to:

```markdown
**Status:** Phase 0 verified; Phase 1 catalogue foundation approved to begin
```

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json docs/superpowers/verification/phase-0-security-evidence.md docs/superpowers/specs/2026-07-13-unified-recipe-catalog-design.md
git commit -m "docs: record Phase 0 security verification"
```
