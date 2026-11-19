/** #2406 / cor:aut:020:02: caller timeouts must be positive; omission and the App ceiling retain their meaning. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));
const server = new ApolloServer<Context>({ typeDefs, resolvers });
let appId: string;
let agentId: string;
const start = async (timeout?: number | null, withApp = true) => {
  const out = await server.executeOperation({
    query: 'mutation($a: ID!, $t: Int) { startAgentSession(agentId: $a, sessionTimeoutSeconds: $t) { id expiresAt } }',
    variables: { a: agentId, ...(timeout === undefined ? {} : { t: timeout }) },
  }, { contextValue: { db, roles: [], ...(withApp ? { appId } : {}) } });
  if (out.body.kind !== 'single') throw new Error('incremental response');
  return out.body.singleResult;
};

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { name: 'timeout2406', urn: 'timeout2406' } });
  const agent = await db.agent.create({ data: { organizationId: org.id, urn: 'timeout2406:agent', name: 'Agent', type: 'CHATBOT' } });
  const app = await db.app.create({ data: { organizationId: org.id, urn: 'timeout2406:app', name: 'App', sessionTimeoutSeconds: 900 } });
  agentId = agent.id; appId = app.id;
  await db.appAgent.create({ data: { appId, agentId } });
});

describe('#2406 startAgentSession timeout', () => {
  it.each([true, false])('refuses 0 and -1 without provisioning when agentSessionsExpire=%s', async expire => {
    await db.app.update({ where: { id: appId }, data: { agentSessionsExpire: expire } });
    const before = { sessions: await db.session.count(), memories: await db.memory.count(), users: await db.user.count() };
    for (const t of [0, -1]) {
      const out = await start(t);
      expect(out.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
      expect({ sessions: await db.session.count(), memories: await db.memory.count(), users: await db.user.count() }).toEqual(before);
    }
  });
  it.each([undefined, null])('omitted/null %s uses the App timeout', async t => {
    const before = Date.now();
    const out = await start(t);
    expect(out.errors).toBeUndefined();
    const expires = new Date((out.data as any).startAgentSession.expiresAt).getTime();
    expect(expires).toBeGreaterThanOrEqual(before + 900_000);
    expect(expires).toBeLessThanOrEqual(Date.now() + 900_000);
  });
  it('no-expiry App keeps null/omitted expiry; positive requests still respect the ceiling', async () => {
    await db.app.update({ where: { id: appId }, data: { agentSessionsExpire: false } });
    for (const t of [null, undefined]) {
      const out = await start(t); expect(out.errors).toBeUndefined();
      expect((out.data as any).startAgentSession.expiresAt).toBeNull();
    }
    for (const [requested, seconds] of [[1, 1], [99_999, 900]]) {
      const before = Date.now(); const out = await start(requested); expect(out.errors).toBeUndefined();
      const expiry = new Date((out.data as any).startAgentSession.expiresAt).getTime();
      expect(expiry).toBeGreaterThanOrEqual(before + seconds * 1000);
      expect(expiry).toBeLessThanOrEqual(Date.now() + seconds * 1000);
    }
  });
  it('the missing App-key gate still runs before input validation', async () => {
    const valid = await start(60, false); const invalid = await start(0, false);
    expect(invalid.errors?.[0]?.message).toBe(valid.errors?.[0]?.message);
    expect(invalid.errors?.[0]?.extensions?.code).not.toBe('BAD_USER_INPUT');
  });
});
