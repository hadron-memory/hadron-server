/**
 * #2206 — writes to an Agent's own system memory follow whoever manages the Agent (cor:dmo:050:13), on GraphQL and MCP,
 * with or without a selected App:
 *  - case 1: an org-owned Agent's org ADMIN/OWNER (MCP refused them; GraphQL with an App selected too);
 *  - case 2: a platform admin on a USER-owned Agent's system memory (both refused). Until #1734 builds that admin's
 *    content read, the write is not a read: its response carries only what the admin supplied plus identity, and the
 *    carriers that move or reveal content (move, merge, search-replace) refuse as for an unreadable memory.
 * App participation, runs, App keys and impersonation never gain the write; install memories keep their own audience.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbAppAgent, createDbAppMember, createDbAppWithKey } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { safeNodeUrnV2 } from '../lib/urnEmit.js';
import type { AuthContext } from '../middleware/auth.js';
import { canReadMemory, canWriteToMemory } from './access-control.js';
import { createTestableMcpServer } from './server.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { requireMemoryWriteAccess } from '../api/graphql/schema/resolvers.helpers.js';
import { typeDefs } from '../api/graphql/schema/typeDefs.js';
import { lockAuthorityAnchors } from '../lib/auth/authorityAnchors.js';
import { waitForLockWaitersOfType } from '../test/lockWait.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const M = resolvers.Mutation as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<any>>;
const SECRET = { content: 'SECRET-BODY', abstract: 'SECRET-ABS', data: { secret: 'SECRET-DATA' }, tags: ['secret-tag'] };

type User = { id: string; roles: string[] };
let org: { id: string };
let u: Record<'orgAdmin' | 'orgOwner' | 'contributor' | 'reader' | 'foreignAdmin' | 'nonmember' | 'platform' | 'revoked' | 'member' | 'agentOwner', User>;
let orgAgent: { id: string; systemMemoryId: string };
let userAgent: { id: string; systemMemoryId: string };
let app: { id: string };
let install: { id: string };
let scratch: { id: string; urn: string };

const authOf = (user: User, extra: Partial<AuthContext> = {}) =>
  ({ userId: user.id, roles: user.roles, clientId: `user:${user.id}`, ...extra }) as AuthContext;
const ctxOf = (user: User, extra: Partial<Context> = {}) => ({ db, ...authOf(user), ...extra }) as unknown as Context;
const runOf = (user: User) => ({ userId: user.id, appId: app.id, roles: user.roles, clientId: `run:${generateId()}` }) as AuthContext;
const mcp = (auth: AuthContext) => createTestableMcpServer(auth, { sessionId: `sw-${generateId()}`, cachedAppResolution: { kind: 'multi-app' } });
const text = (r: { content: Array<{ text: string }> }) => r.content.map((c) => c.text).join('\n');
const memUrn = async (memoryId: string) => (await db.memory.findUniqueOrThrow({ where: { id: memoryId }, select: { urn: true } })).urn;
const nodeUrn = async (memoryId: string, loc: string) => safeNodeUrnV2(await memUrn(memoryId), loc);

async function user(name: string, roles: string[] = ['READER']): Promise<User> {
  const row = await db.user.create({ data: { id: generateId(), name, handle: `${name}-${generateId().slice(-6).toLowerCase()}`, roles: roles as any } });
  return { id: row.id, roles };
}

/** A node with content the platform admin must never get back: content, abstract, data, tags and an edge. */
async function secretNode(memoryId: string, loc = 'def') {
  const node = await db.node.create({ data: { id: generateId(), memoryId, loc, name: 'Secret Title', ...SECRET } });
  const peer = await db.node.create({ data: { id: generateId(), memoryId, loc: `${loc}-peer`, name: 'Peer', content: 'peer' } });
  await db.edge.create({ data: { id: generateId(), memoryId, loc: `${loc}:secret-edge`, sourceId: node.id, targetId: peer.id, name: 'secret-edge' } });
  return node;
}

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'SW Org', urn: `sw-${generateId().toLowerCase()}.example` } });
  const other = await db.organization.create({ data: { id: generateId(), name: 'SW Other', urn: `swo-${generateId().toLowerCase()}.example` } });
  u = {
    orgAdmin: await user('org-admin'), orgOwner: await user('org-owner'), contributor: await user('contrib'), reader: await user('reader'),
    foreignAdmin: await user('foreign'), nonmember: await user('nonmember'), platform: await user('platform', ['ADMIN']),
    revoked: await user('revoked'), member: await user('member'), agentOwner: await user('agent-owner'),
  };
  await db.orgMember.createMany({ data: [
    { organizationId: org.id, userId: u.orgAdmin.id, role: 'ADMIN' },
    { organizationId: org.id, userId: u.orgOwner.id, role: 'OWNER' },
    { organizationId: org.id, userId: u.contributor.id, role: 'CONTRIBUTOR' },
    { organizationId: org.id, userId: u.reader.id, role: 'READER' },
    { organizationId: org.id, userId: u.revoked.id, role: 'ADMIN', deletedAt: new Date() },
    { organizationId: other.id, userId: u.foreignAdmin.id, role: 'ADMIN' },
  ] });
  const a = await M.createAgent({}, { orgId: org.id, name: 'Org Agent' }, ctxOf(u.orgAdmin));
  orgAgent = { id: a.id, systemMemoryId: a.systemMemoryId };
  const ua = await M.createAgent({}, { name: 'Personal Agent' }, ctxOf(u.agentOwner));
  userAgent = { id: ua.id, systemMemoryId: ua.systemMemoryId };
  ({ app } = await createDbAppWithKey(db, 'sw-app', org.id));
  await createDbAppAgent(db, app.id, orgAgent.id);
  await createDbAppMember(db, app.id, u.member.id, 'member');
  install = await db.memory.create({
    data: { id: generateId(), class: 'system', name: 'install', urn: `${org.id.toLowerCase()}:sw-install`, organizationId: org.id, appId: app.id, installOfAgentId: orgAgent.id, isInstallMemory: true },
  });
  // A memory the platform admin may read and write: where an exfiltrating move or merge would land.
  const s = await db.memory.create({ data: { id: generateId(), class: 'knowledge', name: 'scratch', urn: `${org.id.toLowerCase()}:sw-scratch`, organizationId: org.id, visibility: 'ORGANIZATION' } });
  scratch = { id: s.id, urn: s.urn };
});

describe('#2206 case 1: an org-owned Agent\'s system memory is written by its org ADMIN/OWNER, on every transport', () => {
  it('the shared gate, with and without a selected App: managers yes, everyone else no', async () => {
    const m = orgAgent.systemMemoryId;
    for (const who of ['orgAdmin', 'orgOwner'] as const) {
      expect(await canWriteToMemory(db, authOf(u[who]), m), `${who} unselected`).toBe(true);
      expect(await canWriteToMemory(db, authOf(u[who], { appId: app.id }), m), `${who} selected`).toBe(true);
    }
    expect(await canWriteToMemory(db, authOf(u.platform), m)).toBe(true); // unchanged: platform admins manage every Agent
    for (const who of ['contributor', 'reader', 'foreignAdmin', 'nonmember', 'revoked', 'member'] as const) {
      expect(await canWriteToMemory(db, authOf(u[who]), m), `${who} unselected`).toBe(false);
      expect(await canWriteToMemory(db, authOf(u[who], { appId: app.id }), m), `${who} selected`).toBe(false);
    }
    // A run acting for the org admin, a session-bound App key, and an impersonated admin are not managers.
    expect(await canWriteToMemory(db, runOf(u.orgAdmin), m)).toBe(false);
    expect(await canWriteToMemory(db, { appId: app.id, sessionId: generateId(), roles: [], clientId: 'app' } as AuthContext, m)).toBe(false);
    expect(await canWriteToMemory(db, authOf(u.orgAdmin, { impersonation: { orgId: org.id } } as Partial<AuthContext>), m)).toBe(false);
  });

  it('GraphQL agrees, with and without a selected App', async () => {
    const m = orgAgent.systemMemoryId;
    await expect(requireMemoryWriteAccess(ctxOf(u.orgAdmin), m)).resolves.toBeUndefined();
    await expect(requireMemoryWriteAccess(ctxOf(u.orgAdmin, { appId: app.id }), m)).resolves.toBeUndefined();
    await expect(requireMemoryWriteAccess(ctxOf(u.contributor, { appId: app.id }), m)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    await expect(requireMemoryWriteAccess(ctxOf(u.member), m)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    await expect(requireMemoryWriteAccess(ctxOf(u.revoked), m)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
  });

  it('MCP hadron_create_node and hadron_update_node by the org ADMIN land', async () => {
    const urn = await nodeUrn(orgAgent.systemMemoryId, 'mcp-made');
    const created = text(await mcp(authOf(u.orgAdmin)).callTool('hadron_create_node', { urn, name: 'Made', content: 'body' }));
    expect(created).toMatch(/Node saved/);
    const updated = text(await mcp(authOf(u.orgOwner)).callTool('hadron_update_node', { urn, name: 'Renamed' }));
    expect(updated).toMatch(/updated/i);
    expect(await db.node.findFirstOrThrow({ where: { memoryId: orgAgent.systemMemoryId, loc: 'mcp-made' } })).toMatchObject({ name: 'Renamed', content: 'body' });
    const refused = text(await mcp(authOf(u.contributor)).callTool('hadron_create_node', { urn: await nodeUrn(orgAgent.systemMemoryId, 'nope'), name: 'No' }));
    expect(refused).not.toMatch(/Node saved/);
    expect(await db.node.count({ where: { memoryId: orgAgent.systemMemoryId, loc: 'nope' } })).toBe(0);
  });

  it('the org manager reads the memory, so a write returns the full projection', async () => {
    const node = await secretNode(orgAgent.systemMemoryId);
    const out = await M.updateNode(null, { input: { id: node.id, name: 'New Title' } }, ctxOf(u.orgAdmin, { appId: app.id }));
    expect(out).toMatchObject({ name: 'New Title', content: SECRET.content, abstract: SECRET.abstract });
  });

  it('install memories keep their own audience: the new arm never reaches them', async () => {
    expect(await canWriteToMemory(db, authOf(u.orgAdmin), install.id)).toBe(false);
    expect(await canWriteToMemory(db, authOf(u.platform), install.id)).toBe(false);
  });
});

describe('#2206 case 2: a platform admin writes a user-owned Agent\'s system memory, and the write is never a read', () => {
  it('the shared gate: the platform admin and the owner; nobody else; no other user-owned row', async () => {
    const m = userAgent.systemMemoryId;
    expect(await canWriteToMemory(db, authOf(u.platform), m)).toBe(true);
    expect(await canWriteToMemory(db, authOf(u.platform, { appId: app.id }), m)).toBe(true);
    await expect(requireMemoryWriteAccess(ctxOf(u.platform), m)).resolves.toBeUndefined();
    await expect(requireMemoryWriteAccess(ctxOf(u.platform, { appId: app.id }), m)).resolves.toBeUndefined();
    expect(await canWriteToMemory(db, authOf(u.agentOwner), m)).toBe(true);
    for (const who of ['orgAdmin', 'foreignAdmin', 'nonmember', 'member'] as const) {
      expect(await canWriteToMemory(db, authOf(u[who]), m), who).toBe(false);
      await expect(requireMemoryWriteAccess(ctxOf(u[who]), m), who).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    }
    expect(await canWriteToMemory(db, runOf(u.platform), m)).toBe(false);
    expect(await canWriteToMemory(db, authOf(u.platform, { impersonation: { orgId: org.id } } as Partial<AuthContext>), m)).toBe(false);
    // The owner's other user-owned rows stay the owner's: a system row no live Agent points at, and a soft-deleted
    // Agent's dangling system memory.
    const orphan = await db.memory.create({ data: { id: generateId(), class: 'system', name: 'orphan', urn: `${generateId().toLowerCase()}:orphan`, ownerUserId: u.agentOwner.id } });
    expect(await canWriteToMemory(db, authOf(u.platform), orphan.id)).toBe(false);
    const gone = await M.createAgent({}, { name: 'Gone Agent' }, ctxOf(u.agentOwner));
    await db.agent.update({ where: { id: gone.id }, data: { deletedAt: new Date() } });
    expect(await canWriteToMemory(db, authOf(u.platform), gone.systemMemoryId)).toBe(false);
    // The read rules do not move: the admin still cannot read the memory's content.
    expect(await canReadMemory(db, authOf(u.platform), m)).toBe(false);
  });

  /** One GraphQL operation through the real SDL, so the serialized response is what is pinned. */
  async function gql(ctx: Context, query: string, variables: Record<string, unknown>) {
    const server = new ApolloServer<Context>({ typeDefs, resolvers: resolvers as any });
    const r = await server.executeOperation({ query, variables }, { contextValue: ctx });
    if (r.body.kind !== 'single') throw new Error('expected single response');
    return r.body.singleResult;
  }
  const NODE_FIELDS = 'id loc name content abstract data tags outgoingEdges { id } incomingEdges { id } memory { id } commentSummary { comments }';

  it.each([false, true])('GraphQL updateNode, a partial write (selected App: %s): lands; the response discloses nothing it did not supply', async (selected) => {
    const node = await secretNode(userAgent.systemMemoryId);
    const res = await gql(ctxOf(u.platform, selected ? { appId: app.id } : {}),
      `mutation($input: UpdateNodeInput!) { updateNode(input: $input) { ${NODE_FIELDS} } }`, { input: { id: node.id, name: 'Admin Title' } });
    expect(res.errors).toBeUndefined();
    const out = (res.data as any).updateNode;
    expect(JSON.stringify(out)).not.toMatch(/SECRET|secret-tag|Secret Title/);
    expect(out).toMatchObject({ id: node.id, loc: 'def', content: null, abstract: null, tags: [], outgoingEdges: [], incomingEdges: [], memory: null });
    expect(await db.node.findUniqueOrThrow({ where: { id: node.id } })).toMatchObject({ name: 'Admin Title', content: SECRET.content, abstract: SECRET.abstract });
    // The owner's identical write returns the full projection (positive control).
    const own = await gql(ctxOf(u.agentOwner), `mutation($input: UpdateNodeInput!) { updateNode(input: $input) { ${NODE_FIELDS} } }`, { input: { id: node.id, name: 'Owner Title' } });
    expect((own.data as any).updateNode).toMatchObject({ name: 'Owner Title', content: SECRET.content, tags: SECRET.tags });
  });

  it('GraphQL createNode by the platform admin: lands; the response holds what was supplied, never more', async () => {
    const res = await gql(ctxOf(u.platform), `mutation($input: CreateNodeInput!) { createNode(input: $input) { ${NODE_FIELDS} } }`,
      { input: { memoryId: userAgent.systemMemoryId, loc: 'admin-made', name: 'Admin Made', content: 'admin body' } });
    expect(res.errors).toBeUndefined();
    expect((res.data as any).createNode).toMatchObject({ loc: 'admin-made', memory: null });
    expect(await db.node.count({ where: { memoryId: userAgent.systemMemoryId, loc: 'admin-made', content: 'admin body' } })).toBe(1);
  });

  it('MCP hadron_update_node / hadron_update_node_data / hadron_create_node: they land and render identity only', async () => {
    const node = await secretNode(userAgent.systemMemoryId);
    const urn = await nodeUrn(userAgent.systemMemoryId, 'def');
    const s = mcp(authOf(u.platform));
    const outs = [
      text(await s.callTool('hadron_update_node', { urn, name: 'Mcp Title' })),
      text(await s.callTool('hadron_update_node_data', { nodeUrn: urn, data: { extra: 1 } })),
      text(await s.callTool('hadron_create_node', { urn: await nodeUrn(userAgent.systemMemoryId, 'mcp-admin'), name: 'Mcp Admin', content: 'x' })),
    ];
    for (const out of outs) {
      expect(out).not.toMatch(/SECRET|secret-tag|Secret Title|refused|forbidden|not found/i);
      expect(out).toContain('hrn:node:');
    }
    expect(await db.node.findUniqueOrThrow({ where: { id: node.id } })).toMatchObject({ name: 'Mcp Title', content: SECRET.content });
  });

  it('move, merge and search-replace (dryRun too) refuse the write-only admin as for a memory it cannot see; the owner succeeds', async () => {
    const node = await secretNode(userAgent.systemMemoryId);
    const urn = await nodeUrn(userAgent.systemMemoryId, 'def');
    const before = await db.node.findUniqueOrThrow({ where: { id: node.id } });
    const errOf = (p: Promise<unknown>) => p.then(() => 'NO_ERROR', (e: any) => `${e?.extensions?.code ?? e?.code ?? 'ERROR'}: ${e?.message}`);
    const refusals = [
      await errOf(M.moveNode(null, { sourceRef: node.id, targetMemoryRef: scratch.id }, ctxOf(u.platform))),
      await errOf(M.mergeNodes(null, { input: { source: node.id, target: (await db.node.create({ data: { id: generateId(), memoryId: scratch.id, loc: 'merge-into', name: 'T', content: 't' } })).id, include: ['CONTENT'] } }, ctxOf(u.platform))),
      await errOf(M.searchReplaceInNodes(null, { input: { oldText: 'SECRET', newText: 'X', memoryIds: [userAgent.systemMemoryId], fields: ['content', 'abstract'], dryRun: true } }, ctxOf(u.platform))),
      await errOf(M.searchReplaceInNodes(null, { input: { oldText: 'SECRET', newText: 'X', nodeIds: [node.id], fields: ['content'] } }, ctxOf(u.platform))),
    ];
    for (const r of refusals) {
      expect(r).not.toBe('NO_ERROR');
      expect(r).toMatch(/NOT_FOUND/);
      expect(r).not.toMatch(/SECRET|Secret Title/);
    }
    const s = mcp(authOf(u.platform));
    for (const out of [
      text(await s.callTool('hadron_move_node', { urn, targetUrn: safeNodeUrnV2(scratch.urn, 'stolen') })),
      text(await s.callTool('hadron_replace_text', { oldText: 'SECRET', newText: 'X', nodeUrns: [urn], fields: ['content'], dryRun: true })),
      text(await s.callTool('hadron_replace_text', { oldText: 'SECRET', newText: 'X', memoryUrns: [`hrn:mem:${await memUrn(userAgent.systemMemoryId)}`], fields: ['content'], dryRun: true })),
    ]) {
      expect(out).toMatch(/not[ _]found/i);
      expect(out).not.toMatch(/SECRET|secret-tag|Secret Title|match/i);
    }
    expect(await db.node.findUniqueOrThrow({ where: { id: node.id } })).toMatchObject({ memoryId: before.memoryId, loc: before.loc, content: SECRET.content, deletedAt: null });
    expect(await db.node.count({ where: { memoryId: scratch.id, loc: { in: ['def', 'stolen'] } } })).toBe(0);
    // Already read-gated carriers stay refused.
    expect(await errOf(M.createEdge(null, { sourceRef: node.id, targetRef: (await db.node.findFirstOrThrow({ where: { memoryId: userAgent.systemMemoryId, loc: 'def-peer' } })).id, name: 'x' }, ctxOf(u.platform)))).not.toBe('NO_ERROR');
    // The owner may search their own memory.
    const own = await M.searchReplaceInNodes(null, { input: { oldText: 'SECRET', newText: 'SECRET', memoryIds: [userAgent.systemMemoryId], fields: ['content'], dryRun: true } }, ctxOf(u.agentOwner));
    expect(JSON.stringify(own)).toMatch(/def/);
  });

  it('a refused admin write rolls back and its refusal carries no existing content', async () => {
    const node = await secretNode(userAgent.systemMemoryId);
    const res = await M.updateNode(null, { input: { id: node.id, name: 'Late', expectedRevision: 99 } }, ctxOf(u.platform)).then(() => null, (e: any) => e);
    expect(res).not.toBeNull();
    expect(String(res?.message)).not.toMatch(/SECRET|Secret Title/);
    expect(await db.node.findUniqueOrThrow({ where: { id: node.id } })).toMatchObject({ name: 'Secret Title', content: SECRET.content });
  });
});

describe('#2233 BLIND P2 (Gene): the platform arm is decided on live authority, inside the write\'s own transaction', () => {
  it('stale request roles grant nothing: a demoted or deleted actor is refused though its request still says ADMIN', async () => {
    const m = userAgent.systemMemoryId;
    await db.user.update({ where: { id: u.platform.id }, data: { roles: ['READER'] } });
    expect(await canWriteToMemory(db, authOf(u.platform), m)).toBe(false);
    await expect(requireMemoryWriteAccess(ctxOf(u.platform), m)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    await db.user.update({ where: { id: u.platform.id }, data: { roles: ['ADMIN'], deletedAt: new Date() } });
    expect(await canWriteToMemory(db, authOf(u.platform), m)).toBe(false);
  });

  it('a demotion racing the write wins: the write waits on the actor anchor, then is refused on the live role; nothing written', async () => {
    const node = await secretNode(userAgent.systemMemoryId);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let held!: () => void;
    const isHeld = new Promise<void>((r) => { held = r; });
    // updateUserRoles' shape: the actor's user anchor exclusive, then the role change, committed after the writer queued.
    const demotion = db.$transaction(async (tx) => {
      await lockAuthorityAnchors(tx, [{ kind: 'user', id: u.platform.id }], 'exclusive');
      await tx.user.update({ where: { id: u.platform.id }, data: { roles: ['READER'] } });
      held();
      await gate;
    }, { timeout: 20_000 });
    await isHeld;
    // The pre-transaction gate saw ADMIN (the demotion is uncommitted); the deciding one runs after it commits.
    const writing = M.updateNode(null, { input: { id: node.id, name: 'Raced' } }, ctxOf(u.platform)).then(() => 'wrote', (e: any) => e);
    try {
      await waitForLockWaitersOfType(db, 'advisory', 1);
    } finally {
      release();
      await demotion;
    }
    const out = await writing;
    expect(out).not.toBe('wrote');
    expect(await db.node.findUniqueOrThrow({ where: { id: node.id } })).toMatchObject({ name: 'Secret Title' });
    // Control: the owner's write is unaffected by the platform actor's demotion.
    await M.updateNode(null, { input: { id: node.id, name: 'Owner Raced' } }, ctxOf(u.agentOwner));
    expect((await db.node.findUniqueOrThrow({ where: { id: node.id } })).name).toBe('Owner Raced');
  });
});

describe('#2233 §10 P3s (Ralion): the tenant match and the orphan narrowing are pinned', () => {
  it('P3-1: an Agent whose pointer names ANOTHER owner\'s system memory gives the platform admin no write to it', async () => {
    const victim = await user('victim');
    const theirs = await db.memory.create({ data: { id: generateId(), class: 'system', name: 'theirs', urn: `${generateId().toLowerCase()}:theirs`, ownerUserId: victim.id } });
    await db.agent.create({ data: { id: generateId(), name: 'Crossed', urn: `${generateId().toLowerCase()}:crossed`, ownerUserId: u.agentOwner.id, systemMemoryId: theirs.id } });
    expect(await canWriteToMemory(db, authOf(u.platform), theirs.id)).toBe(false);
    await expect(requireMemoryWriteAccess(ctxOf(u.platform), theirs.id)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
  });

  it('P3-2: an org ADMIN no longer writes an org-owned system row no live Agent points at, on GraphQL unselected or selected', async () => {
    const orphan = await db.memory.create({ data: { id: generateId(), class: 'system', name: 'org-orphan', urn: `${org.id.toLowerCase()}:org-orphan`, organizationId: org.id } });
    await expect(requireMemoryWriteAccess(ctxOf(u.orgAdmin), orphan.id)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    await expect(requireMemoryWriteAccess(ctxOf(u.orgAdmin, { appId: app.id }), orphan.id)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    expect(await canWriteToMemory(db, authOf(u.orgAdmin), orphan.id)).toBe(false);
    // A soft-deleted Agent's definition is an orphan too.
    await db.agent.update({ where: { id: orgAgent.id }, data: { deletedAt: new Date() } });
    await expect(requireMemoryWriteAccess(ctxOf(u.orgAdmin), orgAgent.systemMemoryId)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
  });
});

describe('#2233 parity (Xan): MCP\'s deciding write is fenced and rechecked on live authority too', () => {
  /** Hold `anchor` exclusively while `revoke` runs uncommitted, start `write`, prove it queued, then commit the revocation. */
  async function raced(anchor: { kind: 'user' | 'org'; id: string }, revoke: (tx: any) => Promise<unknown>, write: () => Promise<string>) {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let held!: () => void;
    const isHeld = new Promise<void>((r) => { held = r; });
    const revocation = db.$transaction(async (tx) => {
      await lockAuthorityAnchors(tx, [anchor], 'exclusive');
      await revoke(tx);
      held();
      await gate;
    }, { timeout: 20_000 });
    await isHeld;
    const writing = write();
    try {
      await waitForLockWaitersOfType(db, 'advisory', 1);
    } finally {
      release();
      await revocation;
    }
    return writing;
  }

  it.each(['hadron_update_node', 'hadron_create_node'] as const)('%s: a platform demotion racing the write wins; nothing written', async (tool) => {
    await secretNode(userAgent.systemMemoryId);
    const urn = await nodeUrn(userAgent.systemMemoryId, tool === 'hadron_update_node' ? 'def' : 'mcp-raced');
    const out = await raced({ kind: 'user', id: u.platform.id },
      (tx) => tx.user.update({ where: { id: u.platform.id }, data: { roles: ['READER'] } }),
      async () => text(await mcp(authOf(u.platform)).callTool(tool, { urn, name: 'Raced', ...(tool === 'hadron_create_node' ? { content: 'x' } : {}) })));
    expect(out).not.toMatch(/Node saved|updated:/i);
    expect(out).not.toMatch(/SECRET/);
    expect(await db.node.findFirstOrThrow({ where: { memoryId: userAgent.systemMemoryId, loc: 'def' } })).toMatchObject({ name: 'Secret Title' });
    expect(await db.node.count({ where: { memoryId: userAgent.systemMemoryId, loc: 'mcp-raced' } })).toBe(0);
  });

  it('hadron_create_node: an org ADMIN\'s membership revoked racing the write wins; nothing written', async () => {
    const urn = await nodeUrn(orgAgent.systemMemoryId, 'mcp-org-raced');
    const out = await raced({ kind: 'org', id: org.id },
      (tx) => tx.orgMember.updateMany({ where: { organizationId: org.id, userId: u.orgAdmin.id }, data: { deletedAt: new Date() } }),
      async () => text(await mcp(authOf(u.orgAdmin)).callTool('hadron_create_node', { urn, name: 'Raced', content: 'x' })));
    expect(out).not.toMatch(/Node saved/);
    expect(await db.node.count({ where: { memoryId: orgAgent.systemMemoryId, loc: 'mcp-org-raced' } })).toBe(0);
  });
});
