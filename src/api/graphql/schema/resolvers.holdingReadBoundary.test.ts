import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAppAgent, createDbAppWithKey, createDbAppMember } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { drainNodeUsage } from '../../../lib/usageRecorder.js';
import { runAuthContext } from '../../../lib/auth/runPrincipal.js';
import { canReadMemory } from '../../../mcp/access-control.js';
import { resolvers, type Context } from './resolvers.js';
import { getAccessibleMemoryIds, requireMemoryWriteAccess } from './resolvers.helpers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));
const user = (id: string): Context => ({ db, userId: id, roles: [], clientId: `github:${id}` });
let a: { id: string }, b: { id: string }, org: { id: string };
let app: { id: string }, agent: { id: string };

beforeEach(async () => {
  await cleanDb(db);
  a = await db.user.create({ data: { githubId: 508301, githubUsername: 'holding-author', handle: 'holding-author' } });
  b = await db.user.create({ data: { githubId: 508302, githubUsername: 'holding-owner', handle: 'holding-owner' } });
  org = await db.organization.create({ data: { name: 'Holding boundary', urn: 'holding-boundary' } });
  await db.orgMember.createMany({ data: [
    { organizationId: org.id, userId: a.id, role: 'CONTRIBUTOR' },
    { organizationId: org.id, userId: b.id, role: 'ADMIN' },
  ] });
  await db.principalGrant.create({ data: { principalType: 'USER', principalId: a.id, organizationId: org.id, actions: ['memory.create'] } });
  app = await db.app.create({ data: { name: 'Owner app', urn: 'holding-owner:app', ownerUserId: b.id } });
  agent = await db.agent.create({ data: { name: 'Owner agent', urn: 'holding-owner:agent', ownerUserId: b.id } });
  await createDbAppAgent(db, app.id, agent.id);
  await createDbAppMember(db, app.id, b.id, 'owner');
});

async function transferred(memoryClass: 'personal' | 'private') {
  const memory = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'Transferred notes', memoryClass: 'knowledge' }, user(a.id));
  expect(memory.createdBy).toBe(a.id);
  const result = await resolvers.Mutation.transferMemoryOwnership(null, { memoryRef: memory.id, userRef: b.id, targetClass: memoryClass }, user(b.id));
  expect(result.applied).toBe(true);
  await resolvers.Mutation.attachMemoryToApp(null, { memoryRef: memory.id, appRef: app.id, agentRef: agent.id }, user(b.id));
  const node = await resolvers.Mutation.createNode(null, { input: { memoryId: memory.id, loc: 'owner-note', name: 'Owner note', content: 'Written by the owner after transfer' } }, user(b.id));
  await db.orgMember.deleteMany({ where: { userId: a.id } });
  expect(await db.memory.findUniqueOrThrow({ where: { id: memory.id } })).toMatchObject({ class: memoryClass, createdBy: a.id, userId: b.id, ownerUserId: b.id, organizationId: null, appId: app.id, userMemoryOfAgentId: agent.id });
  return { memory, node };
}

async function protectedState(memoryId: string) {
  return {
    memory: await db.memory.findUniqueOrThrow({ where: { id: memoryId } }),
    nodes: await db.node.findMany({ where: { memoryId }, select: { id: true, loc: true, name: true, content: true, revSeq: true, contentRevSeq: true, deletedAt: true } }),
    revisions: await db.nodeRevision.count({ where: { memoryId } }),
    logs: await db.memoryLogEntry.count({ where: { memoryId } }),
    usage: await db.usageEvent.count({ where: { memoryId } }),
  };
}

async function point(nodeId: string, ctx: Context) {
  return resolvers.Query.node(null, { ref: nodeId }, ctx);
}
async function list(ctx: Context) {
  const result = await resolvers.Query.findNodes(null, { filter: { locPrefix: 'owner-note' } }, ctx);
  return result.hits.map(hit => hit.node.id);
}

describe('creator holdings preserve the current read boundary', () => {
  for (const memoryClass of ['personal', 'private'] as const) {
    it(`${memoryClass}: former creator is concealed on point and list; current owner reads`, async () => {
      const { memory, node } = await transferred(memoryClass);
      expect(await point(node.id, user(b.id))).toMatchObject({ id: node.id, content: 'Written by the owner after transfer' });
      expect(await list(user(b.id))).toContain(node.id);
      await drainNodeUsage(db);
      const before = await protectedState(memory.id);
      expect(await canReadMemory(db, user(a.id), memory.id)).toBe(false);
      expect(await canReadMemory(db, user(b.id), memory.id)).toBe(true);
      await expect(requireMemoryWriteAccess(user(a.id), memory.id)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
      expect.soft(await point(node.id, user(a.id))).toBeNull();
      expect.soft(await list(user(a.id))).not.toContain(node.id);
      expect.soft(await getAccessibleMemoryIds(user(a.id))).not.toContain(memory.id);
      await drainNodeUsage(db);
      expect(await protectedState(memory.id)).toEqual(before);
    });
  }

  it('preserves a knowledge holding creator without current org membership and excludes impersonation', async () => {
    const memory = await db.memory.create({ data: { urn: 'holding-boundary:knowledge-holding', name: 'Knowledge holding', class: 'knowledge', organizationId: org.id, visibility: 'ORGANIZATION', createdBy: a.id, userMemoryOfAgentId: agent.id } });
    const node = await resolvers.Mutation.createNode(null, { input: { memoryId: memory.id, loc: 'owner-note', name: 'Knowledge note', content: 'Creator holding remains readable' } }, user(a.id));
    await db.orgMember.deleteMany({ where: { userId: a.id } });
    expect(await getAccessibleMemoryIds(user(a.id))).toContain(memory.id);
    expect(await point(node.id, user(a.id))).toMatchObject({ id: node.id });
    expect(await list(user(a.id))).toContain(node.id);
    const impersonation = { orgId: generateId(), sessionId: generateId(), actorUserId: b.id, expiresAt: new Date(Date.now() + 60000) };
    expect(await getAccessibleMemoryIds({ ...user(a.id), impersonation })).not.toContain(memory.id);
    expect(await point(node.id, { ...user(a.id), impersonation })).toBeNull();
    expect(await list({ ...user(a.id), impersonation })).not.toContain(node.id);
  });

  it('keeps anonymous app-class session reads on the bound-session path', async () => {
    const installed = await db.agent.create({ data: { name: 'Session agent', urn: 'holding-boundary:session-agent', organizationId: org.id } });
    const { app: sessionApp, appKey } = await createDbAppWithKey(db, 'session-app', org.id);
    await createDbAppAgent(db, sessionApp.id, installed.id);
    const key: Context = { db, appId: sessionApp.id, appKeyId: appKey.id, roles: [] };
    const session = await resolvers.Mutation.startAgentSession(null, { agentId: installed.id }, key);
    const bound = (): Context => ({ ...key, sessionId: session.id });
    const memory = await db.memory.findUniqueOrThrow({ where: { id: session.memoryId! } });
    expect(memory.class).toBe('app');
    expect(bound().userId).toBeUndefined();
    const node = await resolvers.Mutation.createNode(null, { input: { memoryId: memory.id, loc: 'owner-note', name: 'Session note', content: 'Bound session content' } }, bound());
    expect(await getAccessibleMemoryIds(bound())).toContain(memory.id);
    expect(await point(node.id, bound())).toMatchObject({ id: node.id, content: 'Bound session content' });
    expect(await list(bound())).toContain(node.id);
    expect(await getAccessibleMemoryIds({ ...key })).not.toContain(memory.id);
    expect(await point(node.id, { ...key })).toBeNull();
    expect(await list({ ...key })).not.toContain(node.id);
  });

  it('uses actual app/run principal shapes and denies a platform administrator another owner’s strict row', async () => {
    const { memory, node } = await transferred('personal');
    const keyRow = await db.appKey.create({ data: { appId: app.id, keyHash: 'a'.repeat(64), keyPreview: 'test' } });
    const key: Context = { db, appId: app.id, appKeyId: keyRow.id, roles: [] };
    const run = (userId: string | null): Context => ({ db, ...runAuthContext({ id: generateId(), appId: app.id, userId, organizationId: org.id }) });
    const administrator = await db.user.create({ data: { githubId: 508303, githubUsername: 'holding-admin', handle: 'holding-admin', roles: ['ADMIN'] } });
    for (const ctx of [key, run(null), run(a.id), { ...user(administrator.id), roles: ['ADMIN'] } as Context]) {
      expect.soft(await point(node.id, ctx)).toBeNull();
      expect.soft(await list({ ...ctx })).not.toContain(node.id);
      expect(await canReadMemory(db, ctx, memory.id)).toBe(false);
    }
  });
});
