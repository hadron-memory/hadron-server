/**
 * #4537: `endAgentSession` refuses a session it cannot end with the typed, uniform `SESSION_NOT_FOUND`
 * (FIT on #4537 by the specs engineer, per hrn:node:hadronmemory.com:specs:cor:api:140:01 and
 * hrn:node:hadronmemory.com:specs:cor:api:260:01).
 *
 * Before the fix the not-found path threw a plain `Error('Session not found')`, which the GraphQL error boundary
 * genericizes to INTERNAL_SERVER_ERROR with a request id, so a mistyped id read as a server fault (CLI exit 1).
 * The refusal must be identical for an unknown id, a live session of another App and a soft-deleted session, so the
 * answer is no existence oracle; SESSION_APP_MISMATCH / SESSION_NOT_IN_APP would be one and must not appear.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError, type GraphQLFormattedError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { formatGraphQLError, isTrustedRefusal } from '../formatError.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn() }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn() }));

const M = resolvers.Mutation as any;
let appA: { id: string };
let appB: { id: string };
const appCtx = (appId: string): Context => ({ db, appId, roles: [] });
const openSession = (appId: string, over: Record<string, unknown> = {}) =>
  db.session.create({ data: { id: generateId(), type: 'CHATBOT', appId, createdBy: appId, ...over } });

/** What the wire carries: the resolver's error through the server's real formatError boundary. */
async function wireRefusal(sessionId: string, appId: string): Promise<{ thrown: unknown; wire: GraphQLFormattedError }> {
  let thrown: unknown;
  try {
    await M.endAgentSession({}, { sessionId }, appCtx(appId));
  } catch (e) {
    thrown = e;
  }
  expect(thrown, 'endAgentSession must refuse').toBeDefined();
  // Apollo wraps a resolver error in a located GraphQLError; a plain Error arrives with its default code.
  const located = thrown instanceof GraphQLError
    ? new GraphQLError(thrown.message, { path: ['endAgentSession'], originalError: thrown, extensions: thrown.extensions })
    : new GraphQLError((thrown as Error).message, { path: ['endAgentSession'], originalError: thrown as Error });
  const formatted: GraphQLFormattedError = {
    message: located.message,
    path: ['endAgentSession'],
    extensions: { code: (located.extensions?.code as string | undefined) ?? 'INTERNAL_SERVER_ERROR' },
  };
  return { thrown, wire: formatGraphQLError(formatted, located) };
}

beforeEach(async () => {
  await cleanDb(db);
  const owner = await db.user.create({ data: { id: generateId(), handle: `o-${generateId()}`, roles: ['READER'] } });
  appA = await db.app.create({ data: { ownerUserId: owner.id, name: 'A', urn: `hrn:app:test:a-${generateId()}` } });
  appB = await db.app.create({ data: { ownerUserId: owner.id, name: 'B', urn: `hrn:app:test:b-${generateId()}` } });
});

describe('endAgentSession typed not-found #4537', () => {
  it('refuses an unknown session id with SESSION_NOT_FOUND, kept on the wire (not INTERNAL_SERVER_ERROR)', async () => {
    const { thrown, wire } = await wireRefusal(generateId(), appA.id);
    expect((thrown as GraphQLError).extensions?.code).toBe('SESSION_NOT_FOUND');
    expect(isTrustedRefusal(thrown)).toBe(true);
    expect(wire).toMatchObject({ message: 'Session not found', extensions: { code: 'SESSION_NOT_FOUND' } });
    expect(wire.extensions).not.toHaveProperty('requestId');
  });

  it('refuses a LIVE session of another App identically, and leaves it open', async () => {
    const foreign = await openSession(appB.id);
    const unknown = await wireRefusal(generateId(), appA.id);
    const other = await wireRefusal(foreign.id, appA.id);
    expect(other.wire.extensions?.code).toBe('SESSION_NOT_FOUND');
    expect(other.wire).toEqual(unknown.wire); // same code, same message, same extensions: no existence oracle
    expect((await db.session.findUniqueOrThrow({ where: { id: foreign.id } })).endedAt).toBeNull();
  });

  it('refuses a soft-deleted session of the caller\'s own App identically, and does not end it', async () => {
    const deleted = await openSession(appA.id, { deletedAt: new Date() });
    const unknown = await wireRefusal(generateId(), appA.id);
    const gone = await wireRefusal(deleted.id, appA.id);
    expect(gone.wire.extensions?.code).toBe('SESSION_NOT_FOUND');
    expect(gone.wire).toEqual(unknown.wire);
    expect((await db.session.findUniqueOrThrow({ where: { id: deleted.id } })).endedAt).toBeNull();
  });

  it('a session with no App answers the same not-found', async () => {
    const orphan = await db.session.create({ data: { id: generateId(), type: 'DEVELOPER' } });
    const unknown = await wireRefusal(generateId(), appA.id);
    const none = await wireRefusal(orphan.id, appA.id);
    expect(none.wire.extensions?.code).toBe('SESSION_NOT_FOUND');
    expect(none.wire).toEqual(unknown.wire);
  });

  it('still ends its own session and re-ends it idempotently with true', async () => {
    const own = await openSession(appA.id);
    expect(await M.endAgentSession({}, { sessionId: own.id }, appCtx(appA.id))).toBe(true);
    const ended = await db.session.findUniqueOrThrow({ where: { id: own.id } });
    expect(ended.endedAt).not.toBeNull();
    expect(await M.endAgentSession({}, { sessionId: own.id }, appCtx(appA.id))).toBe(true);
    expect((await db.session.findUniqueOrThrow({ where: { id: own.id } })).endedAt).toEqual(ended.endedAt);
  });

  it('keeps the no-App-Key refusal FORBIDDEN, judged before any lookup', async () => {
    const own = await openSession(appA.id);
    const err = await M.endAgentSession({}, { sessionId: own.id }, { db, roles: [] }).catch((e: unknown) => e);
    expect((err as GraphQLError).extensions?.code).toBe('FORBIDDEN');
    expect((err as GraphQLError).message).toBe('Forbidden: App Key required');
  });
});
