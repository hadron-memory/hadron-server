/**
 * #5266: four doors answered a bad reference with INTERNAL_SERVER_ERROR (a raw database fault or a plain Error). Each now answers a typed
 * code that never quotes the caller's value (#5225): revokeAppKey(id) APP_KEY_NOT_FOUND (as grantAppKeyScope answers it), startSession
 * parentSessionId / prevSessionId SESSION_NOT_FOUND (the same for a missing and an unreadable session), startSession with a taken id
 * SESSION_ID_TAKEN (Proposed in cor:dmo:070:05; a repeat of the caller's OWN id is the same, no resume), node(ref) / object(ref) with a URN
 * of another kind BAD_USER_INPUT. cor:api:140:01 (a raw not-found must not leak as INTERNAL_SERVER_ERROR), 140:02, 260:01.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { GraphQLError } from 'graphql';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
const NEEDLE = 'CANARY_5266_value';
let userId: string, otherId: string;
const ctx = (as: string = userId): Context => ({ db, userId: as, roles: ['READER'] } as unknown as Context);
const refusal = async (p: Promise<unknown>) => {
  const e = await p.then(() => { throw new Error('expected a refusal'); }, (err) => err);
  // A typed refusal is a GraphQLError with its own code; anything else (a raw database fault, a plain Error) is what the wire calls INTERNAL_SERVER_ERROR.
  return e instanceof GraphQLError
    ? { message: e.message, extensions: (e.extensions ?? {}) as Record<string, unknown> }
    : { message: 'Internal server error.', extensions: { code: 'INTERNAL_SERVER_ERROR' } as Record<string, unknown> };
};
const codeOf = (f: { extensions?: Record<string, unknown> }) => String(f.extensions?.code);
const quotes = (f: { message: string; extensions?: Record<string, unknown> }) => JSON.stringify({ m: f.message, x: f.extensions }).includes(NEEDLE);

beforeEach(async () => {
  await cleanDb(db);
  userId = (await db.user.create({ data: { email: `${generateId()}@s6.test`, handle: 'door-a' } })).id;
  otherId = (await db.user.create({ data: { email: `${generateId()}@s6.test`, handle: 'door-b' } })).id;
});

describe('#5266 revokeAppKey with an unknown key id, as a person', () => {
  it('answers APP_KEY_NOT_FOUND, not INTERNAL_SERVER_ERROR, and never quotes the id', async () => {
    const f = await refusal(M.revokeAppKey({}, { id: NEEDLE }, ctx()));
    expect(codeOf(f)).toBe('APP_KEY_NOT_FOUND');
    expect(quotes(f)).toBe(false);
  });
});

describe('#5266 startSession with an unknown parent or previous session', () => {
  it.each(['parentSessionId', 'prevSessionId'])('%s: SESSION_NOT_FOUND before anything is written', async (field) => {
    const before = await db.session.count();
    const f = await refusal(M.startSession({}, { input: { id: generateId(), tool: 'vitest', [field]: NEEDLE } }, ctx()));
    expect(codeOf(f)).toBe('SESSION_NOT_FOUND');
    expect(quotes(f)).toBe(false);
    expect(await db.session.count()).toBe(before);
  });

  it.each(['parentSessionId', 'prevSessionId'])('%s: a session the caller may not read answers exactly as a missing one', async (field) => {
    const theirs = generateId();
    await M.startSession({}, { input: { id: theirs, tool: 'vitest' } }, ctx(otherId));
    const unreadable = await refusal(M.startSession({}, { input: { id: generateId(), tool: 'vitest', [field]: theirs } }, ctx()));
    const missing = await refusal(M.startSession({}, { input: { id: generateId(), tool: 'vitest', [field]: generateId() } }, ctx()));
    expect(codeOf(unreadable)).toBe('SESSION_NOT_FOUND');
    expect(unreadable.message).toBe(missing.message);
    expect(unreadable.extensions).toEqual(missing.extensions);
  });

  it('a readable parent still binds (the check is not a blanket refusal)', async () => {
    const mine = generateId();
    await M.startSession({}, { input: { id: mine, tool: 'vitest' } }, ctx());
    const child = await M.startSession({}, { input: { id: generateId(), tool: 'vitest', parentSessionId: mine } }, ctx());
    expect(child.parentSessionId).toBe(mine);
  });
});

describe('#5266 startSession with an id that is already taken', () => {
  it('answers SESSION_ID_TAKEN for the caller\'s own repeat (no resume) and for another person\'s id alike, naming nothing', async () => {
    const mine = generateId(), theirs = generateId();
    await M.startSession({}, { input: { id: mine, tool: 'vitest' } }, ctx());
    await M.startSession({}, { input: { id: theirs, tool: 'vitest' } }, ctx(otherId));
    const own = await refusal(M.startSession({}, { input: { id: mine, tool: 'vitest' } }, ctx()));
    const foreign = await refusal(M.startSession({}, { input: { id: theirs, tool: 'vitest' } }, ctx()));
    expect(codeOf(own)).toBe('SESSION_ID_TAKEN');
    expect(foreign.message).toBe(own.message);
    expect(foreign.extensions).toEqual(own.extensions);
    expect(JSON.stringify(own)).not.toContain(mine);
    expect(JSON.stringify(foreign)).not.toContain(theirs);
    expect(await db.session.count()).toBe(2);
  });
});

describe('#5266 node(ref) and object(ref) with a URN of another kind', () => {
  it.each(['node', 'object'])('%s: BAD_USER_INPUT naming the expected kind, never the value', async (door) => {
    const f = await refusal(Q[door]({}, { ref: `hrn:mem:acme.test:${NEEDLE}` }, ctx()));
    expect(codeOf(f)).toBe('BAD_USER_INPUT');
    expect(f.message).toContain('node URN');
    expect(quotes(f)).toBe(false);
  });
});
