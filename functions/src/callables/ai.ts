import { logger } from 'firebase-functions';
import {
  HttpsError,
  type CallableRequest,
} from 'firebase-functions/v2/https';
import { z } from 'zod';

import {
  reminderFlagsRequest,
  shoppingGroupsRequest,
  substitutionsRequest,
  tagRecipesRequest,
  type AiEndpoint,
  type ReminderFlagsInput,
  type ShoppingGroupsInput,
  type SubstitutionsInput,
  type TagRecipesInput,
} from '../ai/contracts.js';

type AuthData = CallableRequest<unknown>['auth'];
type AuthorizedIdentity = { uid: string; email: string };
type FailureClass = 'authorization' | 'quota' | 'service';

interface AiCallableService {
  tagRecipes(input: TagRecipesInput['recipes']): Promise<unknown>;
  reminderFlags(input: ReminderFlagsInput['recipes']): Promise<unknown>;
  shoppingGroups(input: ShoppingGroupsInput['ingredients']): Promise<unknown>;
  substitutions(
    input: Omit<SubstitutionsInput, 'householdId'>,
  ): Promise<unknown>;
}

interface AiHandlerDependencies {
  authorize(
    auth: AuthData,
    householdId: string,
  ): Promise<AuthorizedIdentity>;
  reserve(uid: string, endpoint: AiEndpoint, units: number): Promise<unknown>;
  service: AiCallableService;
}

function parseRequest<T>(schema: z.ZodType<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', 'Invalid request.');
  }
  return parsed.data;
}

function logFailure(endpoint: AiEndpoint, failureClass: FailureClass): void {
  logger.info('ai_callable', {
    endpoint,
    outcome: 'failed',
    failureClass,
  });
}

function preserveHttpsError(error: unknown): HttpsError {
  if (error instanceof HttpsError) return error;
  return new HttpsError('internal', 'AI request failed.');
}

async function invoke<T>(
  request: CallableRequest<unknown>,
  input: T & { householdId: string },
  endpoint: AiEndpoint,
  dependencies: AiHandlerDependencies,
  callService: (input: T) => Promise<unknown>,
): Promise<unknown> {
  const startedAt = Date.now();
  let identity: AuthorizedIdentity;
  try {
    identity = await dependencies.authorize(request.auth, input.householdId);
  } catch (error) {
    logFailure(endpoint, 'authorization');
    throw preserveHttpsError(error);
  }

  try {
    await dependencies.reserve(identity.uid, endpoint, 1);
  } catch (error) {
    logFailure(endpoint, 'quota');
    throw preserveHttpsError(error);
  }

  try {
    const output = await callService(input);
    logger.info('ai_callable', {
      uid: identity.uid,
      endpoint,
      durationMs: Math.max(0, Date.now() - startedAt),
      outcome: 'success',
    });
    return output;
  } catch {
    logFailure(endpoint, 'service');
    throw new HttpsError('internal', 'AI request failed.');
  }
}

export function createAiHandlers(dependencies: AiHandlerDependencies) {
  return {
    async tagRecipes(request: CallableRequest<unknown>) {
      const input = parseRequest(tagRecipesRequest, request.data);
      return invoke(
        request,
        input,
        'tagRecipes',
        dependencies,
        ({ recipes }) => dependencies.service.tagRecipes(recipes),
      );
    },

    async reminderFlags(request: CallableRequest<unknown>) {
      const input = parseRequest(reminderFlagsRequest, request.data);
      return invoke(
        request,
        input,
        'reminderFlags',
        dependencies,
        ({ recipes }) => dependencies.service.reminderFlags(recipes),
      );
    },

    async shoppingGroups(request: CallableRequest<unknown>) {
      const input = parseRequest(shoppingGroupsRequest, request.data);
      return invoke(
        request,
        input,
        'shoppingGroups',
        dependencies,
        ({ ingredients }) => dependencies.service.shoppingGroups(ingredients),
      );
    },

    async substitutions(request: CallableRequest<unknown>) {
      const input = parseRequest(substitutionsRequest, request.data);
      return invoke(
        request,
        input,
        'substitutions',
        dependencies,
        ({ householdId: _householdId, ...serviceInput }) =>
          dependencies.service.substitutions(serviceInput),
      );
    },
  };
}
