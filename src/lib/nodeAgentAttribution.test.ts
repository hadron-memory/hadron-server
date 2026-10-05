/** #1610: the Worker / Agent behind node writes, beside the user. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from './id.js';
import { currentActor, emptyActor, requestActorStorage, runAsActor } from './requestActor.js';
import { clearNodeAuthorship } from './nodeAuthorship.js';
import { mintUserApiKey, resolveAuthContext } from '../middleware/auth.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let user: { id: string };
let other: { id: string };
let memory: { id: string };
let agent: { id: string };
let worker: { id: string };
let session: { id: string };

const as = (userId = user.id): Context => ({ db, userId, roles: [] });
const W = () => ({ workerId: worker.id, agentId: agent.id });
const A = () => ({ workerId: null, agentId: agent.id });
const NOBODY = { workerId: null, agentId: null };
const attribution = (id: string) => db.node.findUniqueOrThrow({
  where: { id },
  select: { createdByWorkerId: true, createdByAgentId: true, updatedByWorkerId: true, updatedByAgentId: true },
});
const makeNode = (loc: string) => db.node.create({
  data: { id: generateId(), memoryId: memory.id, loc, name: `Title ${loc}`, content: `Body ${loc}`, createdBy: user.id },
});

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Attr Org', urn: 'attr.example' } });
  user = await db.user.create({ data: { githubId: 161001, githubUsername: 'attr-user', handle: 'attr-user', roles: [] } });
  other = await db.user.create({ data: { githubId: 161002, githubUsername: 'attr-other', handle: 'attr-other', roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'ADMIN' } });
  memory = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'attribution' }, as());
  agent = await db.agent.create({ data: { id: generateId(), urn: 'attr.example:server-engineer', name: 'server-engineer', organizationId: org.id } });
  const app = await db.app.create({ data: { id: generateId(), name: 'Team', urn: 'attr.example:team', organizationId: org.id } });
  worker = await db.worker.create({ data: { id: generateId(), appId: app.id, agentId: agent.id, name: 'Dara', slug: 'dara' } });
  session = await db.session.create({
    data: { id: generateId(), appId: app.id, userId: user.id, workerId: worker.id, agentId: agent.id, type: 'DEVELOPER', startedAt: new Date() },
  });
});

describe('the central node stamp (#1610)', () => {
  it('records the creating worker and agent, and nothing outside an actor', async () => {
    const byWorker = await runAsActor(W(), () => makeNode('w:1'));
    expect(await attribution(byWorker.id)).toEqual({
      createdByWorkerId: worker.id, createdByAgentId: agent.id, updatedByWorkerId: null, updatedByAgentId: null,
    });
    const plain = await makeNode('p:1');
    expect(await attribution(plain.id)).toEqual({
      createdByWorkerId: null, createdByAgentId: null, updatedByWorkerId: null, updatedByAgentId: null,
    });
  });

  it('records the last authored editor, and clears it when no agent is behind a later edit', async () => {
    const n = await makeNode('e:1');
    await runAsActor(A(), () => db.node.update({ where: { id: n.id }, data: { content: 'agent edit' } }));
    expect(await attribution(n.id)).toMatchObject({ updatedByWorkerId: null, updatedByAgentId: agent.id });
    await runAsActor(W(), () => db.node.updateMany({ where: { id: n.id }, data: { name: 'worker edit' } }));
    expect(await attribution(n.id)).toMatchObject({ updatedByWorkerId: worker.id, updatedByAgentId: agent.id });
    await db.node.update({ where: { id: n.id }, data: { content: 'human edit' } });
    expect(await attribution(n.id)).toMatchObject({ updatedByWorkerId: null, updatedByAgentId: null });
  });

  it('stamps nothing for operational writes or the reconcile clearing authorship', async () => {
    const n = await runAsActor(W(), () => makeNode('o:1'));
    await runAsActor(W(), () => db.node.update({ where: { id: n.id }, data: { content: 'authored' } }));
    await runAsActor(NOBODY, async () => {
      await db.node.update({ where: { id: n.id }, data: { embeddingPendingAt: new Date() } });
      await db.node.update({ where: { id: n.id }, data: { ...clearNodeAuthorship() } });
    });
    expect(await attribution(n.id)).toMatchObject({ updatedByWorkerId: worker.id, updatedByAgentId: agent.id });
  });

  it('keeps a value the caller set explicitly', async () => {
    const n = await runAsActor(W(), () => db.node.create({
      data: { id: generateId(), memoryId: memory.id, loc: 'x:1', name: 'x', createdByWorkerId: null, createdByAgentId: null },
    }));
    expect(await attribution(n.id)).toMatchObject({ createdByWorkerId: null, createdByAgentId: null });
  });
});

describe('revision snapshots (#1610)', () => {
  it('records the worker and agent behind the edit through the GraphQL write path', async () => {
    const n = await makeNode('r:1');
    await runAsActor(W(), () => resolvers.Mutation.updateNode(null, { input: { id: n.id, content: 'changed' } }, as()));
    const rev = await db.nodeRevision.findFirstOrThrow({ where: { nodeId: n.id }, orderBy: { revNo: 'desc' } });
    expect(rev).toMatchObject({ editedBy: user.id, editedByWorkerId: worker.id, editedByAgentId: agent.id });
    expect(await attribution(n.id)).toMatchObject({ updatedByWorkerId: worker.id, updatedByAgentId: agent.id });
  });
});

describe('the actor comes only from a validated session binding (#1610)', () => {
  const req = (authorization: string, sessionId?: string) => ({
    headers: { authorization, ...(sessionId ? { 'x-hadron-session': sessionId } : {}) },
  }) as unknown as Request;

  it('publishes the worker and agent of the caller own live session', async () => {
    const { rawKey } = await mintUserApiKey(db, { userId: user.id, label: null, createdBy: user.id, issuedVia: 'test' });
    const seen = await requestActorStorage.run(emptyActor(), async () => {
      const ctx = await resolveAuthContext(req(`Bearer ${rawKey}`, session.id), db);
      expect(ctx.sessionId).toBe(session.id);
      return { ...currentActor() };
    });
    expect(seen).toEqual({ workerId: worker.id, agentId: agent.id });
  });

  it('publishes nobody for another user session, an ended session, or no session', async () => {
    const { rawKey } = await mintUserApiKey(db, { userId: other.id, label: null, createdBy: other.id, issuedVia: 'test' });
    const foreign = await requestActorStorage.run(emptyActor(), async () => {
      await resolveAuthContext(req(`Bearer ${rawKey}`, session.id), db);
      return { ...currentActor() };
    });
    expect(foreign).toEqual(NOBODY);

    const { rawKey: own } = await mintUserApiKey(db, { userId: user.id, label: null, createdBy: user.id, issuedVia: 'test' });
    await db.session.update({ where: { id: session.id }, data: { endedAt: new Date() } });
    const ended = await requestActorStorage.run(emptyActor(), async () => {
      await resolveAuthContext(req(`Bearer ${own}`, session.id), db);
      return { ...currentActor() };
    });
    expect(ended).toEqual(NOBODY);
    const unbound = await requestActorStorage.run(emptyActor(), async () => {
      await resolveAuthContext(req(`Bearer ${own}`), db);
      return { ...currentActor() };
    });
    expect(unbound).toEqual(NOBODY);
  });
});

describe('GraphQL reads resolve public identity only (#1610)', () => {
  it('names the worker and agent with canonical URNs, and null when unset', async () => {
    const n = await runAsActor(W(), () => makeNode('g:1'));
    const row = await db.node.findUniqueOrThrow({ where: { id: n.id } });
    const ctx = as();
    expect(await resolvers.Node.createdByWorker(row, {}, ctx)).toEqual({
      id: worker.id, name: 'Dara', urn: 'hrn:worker:attr.example:team:dara',
    });
    expect(await resolvers.Node.createdByAgent(row, {}, ctx)).toMatchObject({
      id: agent.id, name: 'server-engineer', urn: expect.stringMatching(/^hrn:agent:attr\.example:server-engineer$/),
    });
    expect(await resolvers.Node.updatedByWorker(row, {}, ctx)).toBeNull();
    // A slim parent reads the column from the live row in its own memory only.
    const slim = { id: row.id, memoryId: generateId() };
    expect(await resolvers.Node.createdByWorker(slim, {}, ctx)).toBeNull();
    expect(await resolvers.Node.createdByWorker({ id: row.id, memoryId: row.memoryId }, {}, ctx)).toMatchObject({ id: worker.id });
  });
});
