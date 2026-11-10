/** #3818 V24/V25: supersession evidence is explicit; successor disclosure uses the current read gate. */
import { ApolloServer } from '@apollo/server';
import { beforeEach, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { serveAgentBootPrompt } from '../../../test/servedBootPrompt.js';
import { validateSessionBinding } from '../../../middleware/auth.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn() }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn() }));
const M = resolvers.Mutation as any;
const server = new ApolloServer<Context>({ typeDefs, resolvers });
let owner: { id: string }, stranger: { id: string }, app: { id: string }, worker: { id: string };
const ctx = (userId = owner.id): Context => ({ db, userId, roles: ['READER'] });
async function bind(force = false) {
  return M.startSession({}, { input: { id: generateId(), workerRef: worker.id, tool: 'codex', force } }, ctx());
}
async function displaced() {
  const a = await bind();
  const old = new Date(Date.now() - 72 * 3600000);
  await db.session.update({ where: { id: a.id }, data: { startedAt: old, updatedAt: old, summary: 'driver summary' } });
  return { a, b: await bind() };
}
beforeEach(async () => {
  await cleanDb(db);
  owner = await db.user.create({ data: { handle: `owner3818-${generateId()}`, roles: ['READER'] } });
  stranger = await db.user.create({ data: { handle: `stranger3818-${generateId()}`, roles: ['READER'] } });
  app = await db.app.create({ data: { ownerUserId: owner.id, name: 'Supersede', urn: `hrn:app:test:supersede-${generateId()}` } });
  const agent = await db.agent.create({ data: { ownerUserId: owner.id, name: 'Role', urn: `hrn:agent:test:role-${generateId()}` } });
  await serveAgentBootPrompt(db, agent.id, 'Synthetic boot prompt.');
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name: 'Test', slug: 'test', heldByUserId: owner.id } });
});
it('records the immediate successor atomically, preserving summary and previous chain', async () => {
  const { a, b } = await displaced();
  expect(await db.session.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({
    endReason: 'superseded', supersededBySessionId: b.id, summary: 'driver summary', autoExpiredAt: null,
  });
  expect(b.prevSessionId).toBe(a.id);
});
it('refuses a stale execution binding with current session id and start time for its reader', async () => {
  const { a, b } = await displaced();
  await expect(validateSessionBinding(db, ctx(), a.id)).rejects.toMatchObject({ extensions: {
    code: 'SESSION_SUPERSEDED', sessionId: b.id, startedAt: b.startedAt.toISOString(),
  } });
});
it('knowing the old id alone discloses neither successor id nor start time', async () => {
  const { a } = await displaced();
  await expect(validateSessionBinding(db, ctx(stranger.id), a.id)).rejects.toMatchObject({ extensions: { code: 'SESSION_SUPERSEDED' } });
  try { await validateSessionBinding(db, ctx(stranger.id), a.id); expect.fail('must refuse'); }
  catch (e) { expect((e as any).extensions).toEqual({ code: 'SESSION_SUPERSEDED' }); }
});
it('publishes the stored successor on an ended record only if the successor is readable now', async () => {
  const { a, b } = await displaced();
  const query = 'query($id:ID!){ session(id:$id){ id supersededBySessionId } }';
  const read = async () => {
    const r = await server.executeOperation({ query, variables: { id: a.id } }, { contextValue: ctx() });
    if (r.body.kind !== 'single') throw new Error('incremental response');
    expect(r.body.singleResult.errors).toBeUndefined();
    return r.body.singleResult.data;
  };
  expect(await read()).toEqual({ session: { id: a.id, supersededBySessionId: b.id } });
  // Old row remains self-readable, while the successor now belongs to a different user without an App read leg.
  await db.session.update({ where: { id: b.id }, data: { userId: stranger.id, appId: null } });
  expect(await read()).toEqual({ session: { id: a.id, supersededBySessionId: null } });
});
it.each(['ended', 'expired'] as const)('keeps ordinary %s binding answers unchanged', async endReason => {
  const a = await bind();
  await db.session.update({ where: { id: a.id }, data: { endedAt: new Date(), endReason } });
  expect(await validateSessionBinding(db, ctx(), a.id)).toBeNull();
});
it('still refuses a live takeover without force; explicit force supplies supersession evidence', async () => {
  const a = await bind();
  await expect(bind()).rejects.toMatchObject({ extensions: { code: 'WORKER_TAKEN' } });
  expect(await db.session.count({ where: { workerId: worker.id } })).toBe(1);
  const b = await bind(true);
  expect((await db.session.findUniqueOrThrow({ where: { id: a.id } })) as any).toMatchObject({ supersededBySessionId: b.id });
});
