export type HouseholdEndpoint =
  | 'createHousehold'
  | 'joinHousehold'
  | 'switchHousehold';

export type HouseholdInvoke = (
  endpoint: HouseholdEndpoint,
  data: Record<string, unknown>,
) => Promise<unknown>;

export interface CreatedHousehold {
  householdId: string;
  inviteCode: string;
}

export const VERIFICATION_REQUIRED_CODE = 'auth/email-verification-required';
export const INVALID_INVITE_CODE = 'household/invalid-invite';

export type PendingHouseholdIntent = {
  version: 1;
  uid: string;
  email: string;
} & ({
  action: 'create';
} | {
  action: 'join';
  inviteCode: string;
});

export interface PendingHouseholdIntentStore {
  load(): Promise<PendingHouseholdIntent | null>;
  save(intent: PendingHouseholdIntent): Promise<void>;
  clear(): Promise<void>;
}

export interface KeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface PasswordOnboardingUser {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  reload(): Promise<void>;
  getIdToken(forceRefresh?: boolean): Promise<string>;
  delete(): Promise<void>;
}

interface PasswordHouseholds {
  create(): Promise<CreatedHousehold>;
  join(inviteCode: string): Promise<string | null>;
  switch(inviteCode: string): Promise<string | null>;
}

export interface PasswordOnboardingDependencies {
  isEmailAllowed(email: string): Promise<boolean>;
  createUser(email: string, password: string): Promise<PasswordOnboardingUser>;
  signIn(email: string, password: string): Promise<PasswordOnboardingUser>;
  sendVerification(user: PasswordOnboardingUser): Promise<void>;
  signOut(): Promise<void>;
  pendingIntents: PendingHouseholdIntentStore;
  households: PasswordHouseholds;
}

export interface PasswordLoginResult {
  user: PasswordOnboardingUser;
  household: CreatedHousehold | { householdId: string } | null;
}

function codedError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function normalizedEmail(value: string): string {
  return value.trim().toLowerCase();
}

const PENDING_INTENT_KEY = '@mealwizard/pending-household-onboarding/v1';

function isPendingHouseholdIntent(value: unknown): value is PendingHouseholdIntent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== 1
    || typeof candidate.uid !== 'string'
    || candidate.uid.length === 0
    || candidate.uid.length > 128
    || typeof candidate.email !== 'string'
    || candidate.email.length === 0
    || candidate.email.length > 254
    || normalizedEmail(candidate.email) !== candidate.email
  ) {
    return false;
  }
  if (candidate.action === 'create') {
    return isExactObject(candidate, ['action', 'email', 'uid', 'version']);
  }
  return candidate.action === 'join'
    && isExactObject(candidate, [
      'action',
      'email',
      'inviteCode',
      'uid',
      'version',
    ])
    && typeof candidate.inviteCode === 'string'
    && candidate.inviteCode.length > 0
    && candidate.inviteCode.length <= 64
    && candidate.inviteCode.trim() === candidate.inviteCode;
}

export function createAsyncStoragePendingIntentStore(
  storage: KeyValueStorage,
): PendingHouseholdIntentStore {
  return {
    async load() {
      const serialized = await storage.getItem(PENDING_INTENT_KEY);
      if (!serialized) return null;
      try {
        const value: unknown = JSON.parse(serialized);
        return isPendingHouseholdIntent(value) ? value : null;
      } catch {
        return null;
      }
    },
    async save(intent) {
      if (!isPendingHouseholdIntent(intent)) {
        throw new Error('Invalid pending household intent');
      }
      await storage.setItem(PENDING_INTENT_KEY, JSON.stringify(intent));
    },
    async clear() {
      await storage.removeItem(PENDING_INTENT_KEY);
    },
  };
}

function verificationRequired(): Error & { code: string } {
  return codedError(
    VERIFICATION_REQUIRED_CODE,
    'Verify your email before signing in. Check your inbox, then log in again.',
  );
}

export function createPasswordOnboarding(
  dependencies: PasswordOnboardingDependencies,
) {
  let busy = false;

  return {
    isBusy() {
      return busy;
    },

    async register(
      emailValue: string,
      password: string,
      inviteCodeValue?: string,
    ): Promise<never> {
      busy = true;
      try {
        const email = normalizedEmail(emailValue);
        if (!email || !(await dependencies.isEmailAllowed(email))) {
          throw new Error('Access Denied');
        }

        const user = await dependencies.createUser(email, password);
        const inviteCode = inviteCodeValue?.trim();
        const intent: PendingHouseholdIntent = inviteCode
          ? {
              version: 1,
              uid: user.uid,
              email,
              action: 'join',
              inviteCode,
            }
          : {
              version: 1,
              uid: user.uid,
              email,
              action: 'create',
            };
        await dependencies.pendingIntents.save(intent);
        try {
          await dependencies.sendVerification(user);
        } finally {
          await dependencies.signOut();
        }
        throw verificationRequired();
      } finally {
        busy = false;
      }
    },

    async login(emailValue: string, password: string): Promise<PasswordLoginResult> {
      busy = true;
      try {
        const requestedEmail = normalizedEmail(emailValue);
        if (!requestedEmail || !(await dependencies.isEmailAllowed(requestedEmail))) {
          throw new Error('Access Denied');
        }

        const user = await dependencies.signIn(requestedEmail, password);
        await user.reload();
        await user.getIdToken(true);

        if (user.emailVerified !== true) {
          try {
            await dependencies.sendVerification(user);
          } finally {
            await dependencies.signOut();
          }
          throw verificationRequired();
        }

        const authenticatedEmail = typeof user.email === 'string'
          ? normalizedEmail(user.email)
          : '';
        if (!authenticatedEmail) {
          await dependencies.signOut();
          throw new Error('Access Denied');
        }

        const pending = await dependencies.pendingIntents.load();
        if (
          !pending
          || pending.uid !== user.uid
          || pending.email !== authenticatedEmail
        ) {
          return { user, household: null };
        }

        if (pending.action === 'create') {
          const household = await dependencies.households.create();
          await dependencies.pendingIntents.clear();
          return { user, household };
        }

        const householdId = await dependencies.households.join(pending.inviteCode);
        if (!householdId) {
          await user.delete();
          await dependencies.pendingIntents.clear();
          throw codedError(
            INVALID_INVITE_CODE,
            'Invalid invite code. Please check and register again.',
          );
        }

        await dependencies.pendingIntents.clear();
        return { user, household: { householdId } };
      } finally {
        busy = false;
      }
    },
  };
}

const firebaseInvoke: HouseholdInvoke = async (endpoint, data) => {
  const [{ httpsCallable }, { functions }] = await Promise.all([
    import('firebase/functions'),
    import('../config/firebase'),
  ]);
  const response = await httpsCallable<Record<string, unknown>, unknown>(
    functions,
    endpoint,
  )(data);
  return response.data;
};

function isExactObject(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const actual = Object.keys(value).sort();
  return actual.length === keys.length
    && actual.every((key, index) => key === [...keys].sort()[index]);
}

function isHouseholdId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function parseCreatedHousehold(
  endpoint: HouseholdEndpoint,
  value: unknown,
): CreatedHousehold {
  if (
    !isExactObject(value, ['householdId', 'inviteCode'])
    || !isHouseholdId(value.householdId)
    || typeof value.inviteCode !== 'string'
    || !/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6,20}$/.test(value.inviteCode)
  ) {
    throw new Error(`Invalid response from ${endpoint}`);
  }
  return {
    householdId: value.householdId,
    inviteCode: value.inviteCode,
  };
}

function parseHouseholdId(endpoint: HouseholdEndpoint, value: unknown): string {
  if (
    !isExactObject(value, ['householdId'])
    || !isHouseholdId(value.householdId)
  ) {
    throw new Error(`Invalid response from ${endpoint}`);
  }
  return value.householdId;
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'functions/not-found';
}

export function createHouseholdClient(invoke: HouseholdInvoke = firebaseInvoke) {
  const joinLike = async (
    endpoint: 'joinHousehold' | 'switchHousehold',
    inviteCode: string,
  ): Promise<string | null> => {
    try {
      return parseHouseholdId(
        endpoint,
        await invoke(endpoint, { inviteCode }),
      );
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  };

  return {
    async create(): Promise<CreatedHousehold> {
      return parseCreatedHousehold(
        'createHousehold',
        await invoke('createHousehold', {}),
      );
    },
    join(inviteCode: string) {
      return joinLike('joinHousehold', inviteCode);
    },
    switch(inviteCode: string) {
      return joinLike('switchHousehold', inviteCode);
    },
  };
}

export const householdClient = createHouseholdClient();
