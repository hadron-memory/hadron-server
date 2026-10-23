import { WORKER_SIGNATURE_DEFAULTS } from './workerSignature.js';
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
import { createTestableMcpServer } from '../mcp/server.js';
import { createNode as scaffoldNode } from '../controller/operations/createNode.js';
import { assertNoNestedNodeWrite } from '../integrations/db/client.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let user: { id: string };
let other: { id: string };
let memory: { id: string; urn: string };
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
  worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name: 'Dara', slug: 'dara' } });
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
      const { workerId, agentId } = currentActor();
      return { workerId, agentId }; // the Worker / Agent; the authenticated user is pinned in requestActor.userId2176.test.ts
    });
    expect(seen).toEqual({ workerId: worker.id, agentId: agent.id });
  });

  it('also publishes the authenticated user, whatever the session binding says (#2176)', async () => {
    const { rawKey } = await mintUserApiKey(db, { userId: user.id, label: null, createdBy: user.id, issuedVia: 'test' });
    const { rawKey: foreignKey } = await mintUserApiKey(db, { userId: other.id, label: null, createdBy: other.id, issuedVia: 'test' });
    const own = await requestActorStorage.run(emptyActor(), async () => { await resolveAuthContext(req(`Bearer ${rawKey}`, session.id), db); return currentActor().userId; });
    expect(own).toBe(user.id);
    // a session that is not the caller's binds no worker, but the caller is still the caller
    const foreign = await requestActorStorage.run(emptyActor(), async () => { await resolveAuthContext(req(`Bearer ${foreignKey}`, session.id), db); return currentActor(); });
    expect(foreign.userId).toBe(other.id);
    expect(foreign.workerId).toBeNull();
  });

  it('publishes nobody for another user session, an ended session, or no session', async () => {
    const { rawKey } = await mintUserApiKey(db, { userId: other.id, label: null, createdBy: other.id, issuedVia: 'test' });
    const foreign = await requestActorStorage.run(emptyActor(), async () => {
      await resolveAuthContext(req(`Bearer ${rawKey}`, session.id), db);
      const { workerId, agentId } = currentActor();
      return { workerId, agentId }; // the Worker / Agent; the authenticated user is pinned in requestActor.userId2176.test.ts
    });
    expect(foreign).toEqual(NOBODY);

    const { rawKey: own } = await mintUserApiKey(db, { userId: user.id, label: null, createdBy: user.id, issuedVia: 'test' });
    await db.session.update({ where: { id: session.id }, data: { endedAt: new Date() } });
    const ended = await requestActorStorage.run(emptyActor(), async () => {
      await resolveAuthContext(req(`Bearer ${own}`, session.id), db);
      const { workerId, agentId } = currentActor();
      return { workerId, agentId }; // the Worker / Agent; the authenticated user is pinned in requestActor.userId2176.test.ts
    });
    expect(ended).toEqual(NOBODY);
    const unbound = await requestActorStorage.run(emptyActor(), async () => {
      await resolveAuthContext(req(`Bearer ${own}`), db);
      const { workerId, agentId } = currentActor();
      return { workerId, agentId }; // the Worker / Agent; the authenticated user is pinned in requestActor.userId2176.test.ts
    });
    expect(unbound).toEqual(NOBODY);
  });
});

describe('a dormant session neither binds nor attributes (DY-5, #1665 both doors)', () => {
  it('header door: a no-expiry session idle past its App threshold publishes nobody', async () => {
    const { rawKey } = await mintUserApiKey(db, { userId: user.id, label: null, createdBy: user.id, issuedVia: 'test' });
    await db.$executeRaw`UPDATE sessions SET started_at = now() - interval '400 days', updated_at = now() - interval '400 days' WHERE id = ${session.id}`;
    const seen = await requestActorStorage.run(emptyActor(), async () => {
      const ctx = await resolveAuthContext({ headers: { authorization: `Bearer ${rawKey}`, 'x-hadron-session': session.id } } as unknown as Request, db);
      expect(ctx.sessionId).toBeUndefined();
      const { workerId, agentId } = currentActor();
      return { workerId, agentId }; // the Worker / Agent; the authenticated user is pinned in requestActor.userId2176.test.ts
    });
    expect(seen).toEqual(NOBODY);
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

describe('revision and MCP reads (#1610)', () => {
  it('NodeRevision names the worker behind the edit it records', async () => {
    const n = await makeNode('rv:1');
    await runAsActor(W(), () => resolvers.Mutation.updateNode(null, { input: { id: n.id, content: 'changed' } }, as()));
    const rev = await db.nodeRevision.findFirstOrThrow({ where: { nodeId: n.id }, orderBy: { revNo: 'desc' } });
    expect(await resolvers.NodeRevision.editedByWorker(rev, {}, as())).toMatchObject({ id: worker.id, name: 'Dara' });
    expect(await resolvers.NodeRevision.editedByAgent(rev, {}, as())).toMatchObject({ id: agent.id });
  });

  it('hadron_get_node prints who created and last edited the node, and nothing when no actor was behind it', async () => {
    const lines = async (loc: string) => {
      const mcp = createTestableMcpServer({ userId: user.id, roles: [], clientId: `user:${user.id}` });
      const text = await mcp.callToolText('hadron_get_node', { urn: `hrn:node:${memory.urn}:${loc}` });
      return text.split('\n').filter((line) => line.startsWith('Created by:') || line.startsWith('Last edited by:'));
    };
    const n = await runAsActor(W(), () => makeNode('m:1'));
    await runAsActor(A(), () => db.node.update({ where: { id: n.id }, data: { content: 'agent edit' } }));
    expect(await lines('m:1')).toEqual([
      'Created by: worker Dara (hrn:worker:attr.example:team:dara)',
      expect.stringMatching(/^Last edited by: agent server-engineer \(hrn:agent:attr\.example:server-engineer\)$/),
    ]);
    await makeNode('m:2');
    expect(await lines('m:2')).toEqual([]);
  });
});

describe('#1658 review cycle', () => {
  it('fails closed for a slim parent without its memory, or whose row was deleted', async () => {
    const n = await runAsActor(W(), () => makeNode('s:1'));
    const ctx = as();
    expect(await resolvers.Node.createdByWorker({ id: n.id }, {}, ctx)).toBeNull();
    await db.node.update({ where: { id: n.id }, data: { deletedAt: new Date() } });
    expect(await resolvers.Node.createdByWorker({ id: n.id, memoryId: n.memoryId }, {}, as())).toBeNull();
  });

  it('memory scaffolding runs as the system, even inside a worker request', async () => {
    const scaffold = await runAsActor(W(), () => scaffoldNode({ memoryId: memory.id, loc: 'scaffold', name: 'scaffold' }));
    expect(await attribution(scaffold.id)).toEqual({
      createdByWorkerId: null, createdByAgentId: null, updatedByWorkerId: null, updatedByAgentId: null,
    });
  });

  it('stamps through every Node write method', async () => {
    await runAsActor(W(), async () => {
      await db.node.createMany({ data: [{ id: generateId(), memoryId: memory.id, loc: 'cm:1', name: 'cm' }] });
      await db.node.createManyAndReturn({ data: [{ id: generateId(), memoryId: memory.id, loc: 'cm:2', name: 'cm' }] });
      await db.node.upsert({
        where: { loc_memoryId: { loc: 'up:1', memoryId: memory.id } },
        create: { id: generateId(), memoryId: memory.id, loc: 'up:1', name: 'up' }, update: {},
      });
    });
    for (const loc of ['cm:1', 'cm:2', 'up:1']) {
      const row = await db.node.findFirstOrThrow({ where: { memoryId: memory.id, loc } });
      expect(await attribution(row.id), loc).toMatchObject({ createdByWorkerId: worker.id, createdByAgentId: agent.id });
    }
    await runAsActor(A(), async () => {
      await db.node.upsert({
        where: { loc_memoryId: { loc: 'up:1', memoryId: memory.id } },
        create: { id: generateId(), memoryId: memory.id, loc: 'up:1', name: 'up' }, update: { content: 'edited' },
      });
      await db.node.updateManyAndReturn({ where: { memoryId: memory.id, loc: 'cm:1' }, data: { content: 'edited' } });
    });
    for (const loc of ['up:1', 'cm:1']) {
      const row = await db.node.findFirstOrThrow({ where: { memoryId: memory.id, loc } });
      expect(await attribution(row.id), loc).toMatchObject({ updatedByWorkerId: null, updatedByAgentId: agent.id });
    }
  });

  it('keeps concurrent requests apart: each write records its own actor', async () => {
    const other = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: (await db.worker.findUniqueOrThrow({ where: { id: worker.id } })).appId, agentId: agent.id, name: 'Iris', slug: 'iris' } });
    const [a, b] = await Promise.all([
      runAsActor(W(), async () => { await new Promise((r) => setTimeout(r, 20)); return makeNode('c:1'); }),
      runAsActor({ workerId: other.id, agentId: agent.id }, () => makeNode('c:2')),
    ]);
    expect((await attribution(a.id)).createdByWorkerId).toBe(worker.id);
    expect((await attribution(b.id)).createdByWorkerId).toBe(other.id);
  });

  it('refuses a nested Node write through another model, which the Node hooks would never see', async () => {
    expect(() => assertNoNestedNodeWrite('Memory', { nodes: { create: [{ loc: 'x', name: 'x' }] } })).toThrow(/Nested Node write through Memory\.nodes/);
    expect(() => assertNoNestedNodeWrite('Edge', { target: { connectOrCreate: {} } })).toThrow(/Edge\.target/);
    expect(() => assertNoNestedNodeWrite('Edge', { target: { connect: { id: 'n1' } } })).not.toThrow();
    expect(() => assertNoNestedNodeWrite('Organization', { nodes: { create: {} } })).not.toThrow();
    // And it is wired into the client: a real nested create is refused before it reaches the DB.
    await expect(db.memory.update({
      where: { id: memory.id }, data: { nodes: { create: [{ id: generateId(), loc: 'nested', name: 'nested' }] } },
    })).rejects.toThrow(/Nested Node write through Memory\.nodes/);
  });
});
