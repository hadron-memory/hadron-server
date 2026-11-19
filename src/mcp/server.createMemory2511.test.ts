/**
 * hadron_create_memory (#2511): the MCP door onto the createMemory mutation's
 * own core. Every refusal is pinned against the mutation's answer for the same
 * principal and input, so MCP can never do what the API refuses.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { createTestableMcpServer } from './server.js';
import type { AuthContext } from '../middleware/auth.js';

let orgId: string;
let orgUrn: string;
let adminId: string;
let memberId: string;
let outsiderId: string;
let appId: string;
let revokedId: string;

const ctxFor = (userId: string | undefined, extra: Partial<Context> = {}): Context =>
  ({ db, roles: [], userId, ...extra }) as Context;
const authFor = (userId: string): AuthContext => ({ userId, roles: [], clientId: `user:${userId}` });
const appKeyAuth = (): AuthContext => ({ appId, roles: [], clientId: `app:${appId}` });
const callAs = (auth: AuthContext, args: Record<string, unknown>): Promise<string> =>
  createTestableMcpServer(auth).callToolText('hadron_create_memory', args);
// The tool names the organization `org`; the mutation takes it as `orgId`.
const mutate = (ctx: Context, { org, ...rest }: Record<string, unknown>) =>
  (resolvers.Mutation as any).createMemory({}, { ...rest, ...(org ? { orgId: org } : {}) }, ctx);
const rejection = async (p: Promise<unknown>): Promise<string> => {
  try { await p; } catch (e) { return (e as Error).message; }
  throw new Error('expected a refusal');
};
const memoryCount = () => db.memory.count();

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'cm2511', urn: 'cm2511' } });
  orgId = org.id;
  orgUrn = org.urn;
  const admin = await db.user.create({ data: { githubId: 25111, githubUsername: 'cm-admin' } });
  const member = await db.user.create({ data: { githubId: 25112, githubUsername: 'cm-member' } });
  const outsider = await db.user.create({ data: { githubId: 25113, githubUsername: 'cm-outsider' } });
  const revoked = await db.user.create({ data: { githubId: 25114, githubUsername: 'cm-revoked' } });
  adminId = admin.id; memberId = member.id; outsiderId = outsider.id; revokedId = revoked.id;
  await db.orgMember.create({ data: { organizationId: orgId, userId: revokedId, role: 'CONTRIBUTOR', deletedAt: new Date() } });
  await db.orgMember.create({ data: { organizationId: orgId, userId: adminId, role: 'ADMIN' } });
  await db.orgMember.create({ data: { organizationId: orgId, userId: memberId, role: 'CONTRIBUTOR' } });
  const agent = await db.agent.create({ data: { id: generateId(), organizationId: orgId, name: 'A', urn: `${orgId}:a`, visibility: 'ORGANIZATION' } });
  const app = await db.app.create({ data: { id: generateId(), organizationId: orgId, name: 'A', urn: `${orgId}:a-app` } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  appId = app.id;
});

describe('hadron_create_memory round-trip', () => {
  const cases: Array<{ cls: string; args: Record<string, unknown>; as: () => string }> = [
    { cls: 'knowledge', args: { org: true, memoryClass: 'knowledge' }, as: () => adminId },
    { cls: 'group', args: { org: true, memoryClass: 'group' }, as: () => adminId },
    { cls: 'personal', args: { memoryClass: 'personal' }, as: () => memberId },
    { cls: 'private', args: { memoryClass: 'private' }, as: () => memberId },
  ];
  for (const c of cases) {
    it(`creates a ${c.cls} memory, lists it, and set_active_memory accepts it`, async () => {
      const uid = c.as();
      const auth = authFor(uid);
      const args = { ...c.args, name: `rt ${c.cls}`, ...(c.args.org ? { org: orgUrn } : {}) };
      const text = await callAs(auth, args);
      expect(text).not.toMatch(/Error/i);
      const row = await db.memory.findFirstOrThrow({ where: { name: `rt ${c.cls}` } });
      expect(row.class).toBe(c.cls);
      // Owner columns follow the mutation: Memory.userId is the personal/private owner.
      expect(row.userId).toBe(c.cls === 'personal' || c.cls === 'private' ? uid : null);
      if (c.cls === 'group') {
        expect(await db.memoryMember.count({ where: { memoryId: row.id, userId: uid, role: 'owner' } })).toBe(1);
      }
      const server = createTestableMcpServer(auth);
      expect(await server.callToolText('hadron_list_memories', {})).toContain(row.urn);
      expect(await server.callToolText('hadron_set_active_memory', { memoryUrn: row.urn })).toMatch(/Active memory set/);
    });
  }

  it('does not select the new memory and creates no App-scoped memory', async () => {
    // Selection is observable as the persisted per-client row, so pin it before
    // and after, with another memory already selected: creation must neither
    // replace that selection nor select the newcomer when none was chosen.
    const selectionOf = async (key: string) =>
      (await db.mcpSessionState.findUnique({ where: { userId_clientKey: { userId: memberId, clientKey: key } } }))?.memoryId ?? null;
    const serverFor = (key: string) => createTestableMcpServer(authFor(memberId), { clientKey: key });
    const other = await db.memory.create({
      data: { id: generateId(), name: 'already-selected', urn: `${orgId}:already-selected`, class: 'personal', userId: memberId, organizationId: orgId },
    });

    const selecting = serverFor('cm-selected');
    await selecting.callToolText('hadron_set_active_memory', { memoryUrn: other.urn });
    expect(await selectionOf('cm-selected')).toBe(other.id);
    // The live (in-process) selection is what hadron_run_task defaults to, so
    // probe it too: a volatile-only auto-select would persist nothing.
    const runBefore = await selecting.callToolText('hadron_run_task', {});
    expect(runBefore).toContain('already-selected');
    await selecting.callToolText('hadron_create_memory', { name: 'unselected', memoryClass: 'personal' });
    expect(await selecting.callToolText('hadron_run_task', {})).toBe(runBefore);
    const row = await db.memory.findFirstOrThrow({ where: { name: 'unselected' } });
    expect(row.appId).toBeNull();
    expect(row.userMemoryOfAgentId).toBeNull();
    expect(await selectionOf('cm-selected')).toBe(other.id);

    // With nothing selected beforehand, creating still selects nothing.
    const fresh = serverFor('cm-fresh');
    expect(await selectionOf('cm-fresh')).toBeNull();
    await fresh.callToolText('hadron_create_memory', { name: 'unselected-2', memoryClass: 'personal' });
    expect(await selectionOf('cm-fresh')).toBeNull();
    expect(await fresh.callToolText('hadron_set_active_memory', { memoryUrn: row.urn })).toMatch(/Active memory set/);
    expect(await selectionOf('cm-fresh')).toBe(row.id);
  });

  it('a live CONTRIBUTOR creates org-anchored personal and private memories through the membership gate', async () => {
    // Positive control: without it, every refusal pin below passes even if the
    // gate refused every member.
    for (const cls of ['personal', 'private'] as const) {
      const text = await callAs(authFor(memberId), { org: orgUrn, memoryClass: cls, name: `anchored ${cls}` });
      expect(text).toMatch(/Memory created/);
      const row = await db.memory.findFirstOrThrow({ where: { name: `anchored ${cls}` } });
      expect(row.class).toBe(cls);
      expect(row.userId).toBe(memberId);
      expect(row.organizationId).toBe(orgId);
      expect(row.appId).toBeNull();
    }
  });
});


describe('refusal parity with the createMemory mutation', () => {
  type Case = { label: string; principal: () => AuthContext; mutationCtx: () => Context; args: () => Record<string, unknown> };
  const cases: Case[] = [
    {
      label: 'knowledge without memory.create',
      principal: () => authFor(memberId), mutationCtx: () => ctxFor(memberId),
      args: () => ({ org: orgUrn, memoryClass: 'knowledge' }),
    },
    {
      label: 'group without memory.create',
      principal: () => authFor(memberId), mutationCtx: () => ctxFor(memberId),
      args: () => ({ org: orgUrn, memoryClass: 'group' }),
    },
    {
      label: 'caller outside the org (knowledge)',
      principal: () => authFor(outsiderId), mutationCtx: () => ctxFor(outsiderId),
      args: () => ({ org: orgUrn, memoryClass: 'knowledge' }),
    },
    {
      label: 'caller outside the org (personal)',
      principal: () => authFor(outsiderId), mutationCtx: () => ctxFor(outsiderId),
      args: () => ({ org: orgUrn, memoryClass: 'personal' }),
    },
    {
      label: 'revoked org membership (personal)',
      principal: () => authFor(revokedId), mutationCtx: () => ctxFor(revokedId),
      args: () => ({ org: orgUrn, memoryClass: 'personal' }),
    },
    {
      label: 'revoked org membership (private)',
      principal: () => authFor(revokedId), mutationCtx: () => ctxFor(revokedId),
      args: () => ({ org: orgUrn, memoryClass: 'private' }),
    },
    {
      label: 'platform ADMIN who is not an org member (personal): no admin bypass',
      principal: () => ({ ...authFor(outsiderId), roles: ['ADMIN'] }), mutationCtx: () => ctxFor(outsiderId, { roles: ['ADMIN'] }),
      args: () => ({ org: orgUrn, memoryClass: 'personal' }),
    },
    {
      label: 'org-less knowledge',
      principal: () => authFor(memberId), mutationCtx: () => ctxFor(memberId),
      args: () => ({ memoryClass: 'knowledge' }),
    },
    {
      label: 'org-less group',
      principal: () => authFor(memberId), mutationCtx: () => ctxFor(memberId),
      args: () => ({ memoryClass: 'group' }),
    },
    {
      label: 'system class',
      principal: () => authFor(adminId), mutationCtx: () => ctxFor(adminId),
      args: () => ({ org: orgUrn, memoryClass: 'system' }),
    },
    {
      label: 'app class',
      principal: () => authFor(adminId), mutationCtx: () => ctxFor(adminId),
      args: () => ({ org: orgUrn, memoryClass: 'app' }),
    },
    {
      label: 'group with a non-GROUP visibility',
      principal: () => authFor(adminId), mutationCtx: () => ctxFor(adminId),
      args: () => ({ org: orgUrn, memoryClass: 'group', visibility: 'ORGANIZATION' }),
    },
    {
      label: 'knowledge claiming GROUP visibility',
      principal: () => authFor(adminId), mutationCtx: () => ctxFor(adminId),
      args: () => ({ org: orgUrn, memoryClass: 'knowledge', visibility: 'GROUP' }),
    },
    {
      label: 'App-key caller, org-less personal',
      principal: () => appKeyAuth(), mutationCtx: () => ctxFor(undefined, { appId }),
      args: () => ({ memoryClass: 'personal' }),
    },
    {
      label: 'App-key caller, org-anchored personal',
      principal: () => appKeyAuth(), mutationCtx: () => ctxFor(undefined, { appId }),
      args: () => ({ org: orgUrn, memoryClass: 'personal' }),
    },
    {
      label: 'App-key caller, org-anchored private',
      principal: () => appKeyAuth(), mutationCtx: () => ctxFor(undefined, { appId }),
      args: () => ({ org: orgUrn, memoryClass: 'private' }),
    },
  ];
  for (const c of cases) {
    it(`${c.label}: the tool refuses with the mutation's answer and persists nothing`, async () => {
      const before = { memories: await memoryCount(), members: await db.memoryMember.count() };
      const mutationMessage = await rejection(mutate(c.mutationCtx(), { ...c.args(), name: 'parity-a' }));
      expect(await memoryCount()).toBe(before.memories);
      const text = await callAs(c.principal(), { ...c.args(), name: 'parity-b' });
      expect(text).toContain(mutationMessage);
      expect(await memoryCount()).toBe(before.memories);
      expect(await db.memoryMember.count()).toBe(before.members);
    });
  }

  it('the tool exposes no owner argument: a personal memory is always the caller\'s', async () => {
    // The unsupported owner arguments are ignored, not honored: creation
    // succeeds and the row belongs to the caller. An unrelated failure fails here.
    const server = createTestableMcpServer(authFor(memberId));
    const text = await server.callToolText('hadron_create_memory', {
      name: 'foreign', memoryClass: 'personal', userId: adminId, ownerUserId: adminId,
    });
    expect(text).toMatch(/Memory created/);
    const row = await db.memory.findFirstOrThrow({ where: { name: 'foreign' } });
    expect(row.userId).toBe(memberId);
    expect(await db.memory.count({ where: { userId: adminId } })).toBe(0);
  });
});

describe('success parity with the mutation', () => {
  it('stores the same class, visibility, vector defaults and ownership', async () => {
    const viaMutation = await mutate(ctxFor(adminId), { org: orgUrn, name: 'same-a', memoryClass: 'knowledge' });
    await callAs(authFor(adminId), { org: orgUrn, name: 'same-b', memoryClass: 'knowledge' });
    const viaTool = await db.memory.findFirstOrThrow({ where: { name: 'same-b' } });
    for (const k of ['class', 'visibility', 'vectorIndexEnabled', 'embeddingSource', 'organizationId', 'ownerUserId', 'userId', 'createdBy'] as const) {
      expect((viaTool as any)[k]).toEqual((viaMutation as any)[k]);
    }
  });
});
