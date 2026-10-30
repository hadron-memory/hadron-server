/** #2843 / cor:acl:010:01 — D2: the actual user-owned App owner may create a NEW app memory. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { canReadMemoryRecord, requireMemoryWriteAccess } from './resolvers.helpers.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import { lockAuthorityAnchors } from '../../../lib/auth/authorityAnchors.js';
import { waitForLockWaiters } from '../../../test/lockWait.js';
import * as rootFs from '../../../integrations/localFs/saveNodeToFs.js';

const M = resolvers.Mutation as any;
let owner: any, stranger: any, participant: any, app: any, agent: any;
const ctx = (userId = owner.id, extra: Partial<Context> = {}): Context => ({ db, userId, roles: [], ...extra });
const create = (c = ctx(), args: any = {}) => M.createAppMemory({}, { appRef: app.id, name: 'Owner Notes', shortDescription: 'Short', description: 'Full', tags: ['owner'], ...args }, c);
const caught = async (promise: Promise<unknown>) => { try { await promise; throw new Error('expected refusal'); } catch (e) { return e; } };
const denied = async (c: Context, args: any = {}, code = 'FORBIDDEN') => {
  await expect(create(c, args)).rejects.toMatchObject({ extensions: { code } });
  expect(await db.memory.count()).toBe(0);
  expect(await db.node.count()).toBe(0);
};
beforeEach(async () => {
  await cleanDb(db);
  const person = (n: number) => db.user.create({ data: { githubId: 284300 + n, githubUsername: `u2843-${n}`, roles: ['READER'] } });
  [owner, stranger, participant] = await Promise.all([1,2,3].map(person));
  app = await db.app.create({ data: { name: 'Own', urn: 'u2843:own', ownerUserId: owner.id } });
  agent = await db.agent.create({ data: { name: 'Own agent', urn: 'u2843:agent', ownerUserId: owner.id } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  await db.appMember.create({ data: { appId: app.id, userId: participant.id, role: 'owner' } });
});
afterEach(() => vi.restoreAllMocks());

describe('#2843 owner creation and boundaries', () => {
  it('creates the exact tenant shape, flat URN, metadata and root atomically, with participant access', async () => {
    const row = await create();
    expect(row).toMatchObject({ class: 'app', organizationId: null, ownerUserId: owner.id, appId: app.id,
      urn: 'u2843:owner-notes', name: 'Owner Notes', shortDescription: 'Short', description: 'Full', tags: ['owner'], createdBy: owner.id,
      isInstallMemory: false, installOfAgentId: null, userId: null, userMemoryOfAgentId: null, sharedMemoryOfAgentId: null, visibility: null });
    expect(await db.memory.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ ownerUserId: owner.id, organizationId: null, appId: app.id });
    expect(await db.node.findMany({ where: { memoryId: row.id } })).toMatchObject([{ loc: 'Owner Notes', name: 'Owner Notes', description: 'Root node for this memory.' }]);
    expect(await db.agentMemoryItem.count({ where: { memoryId: row.id } })).toBe(0);
    for (const user of [owner, participant]) {
      expect(await canReadMemoryRecord(ctx(user.id), row)).toBe(true);
      await expect(requireMemoryWriteAccess(ctx(user.id), row.id)).resolves.toBeUndefined();
    }
    expect(await canReadMemoryRecord(ctx(stranger.id), row)).toBe(false);
    await expect(requireMemoryWriteAccess(ctx(stranger.id), row.id)).rejects.toThrow();
    // Existing mint collision convention, not a new URI grammar or attach door.
    expect((await create()).urn).not.toBe(row.urn);
  });
  it('conceals stranger versus unknown App byte-for-byte, even with an invalid root and no installation', async () => {
    await db.appAgent.deleteMany({ where: { appId: app.id } });
    const a = await caught(create(ctx(stranger.id), { name: '../secret' }));
    const b = await caught(create(ctx(stranger.id), { appRef: generateId(), name: '../secret' }));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a).toMatchObject({ message: 'Forbidden', extensions: { code: 'FORBIDDEN' } });
    expect(await db.memory.count()).toBe(0);
  });
  it('refuses an OWNER-role App member who is not the actual owner', async () => { await denied(ctx(participant.id)); });
  for (const role of ['ADMIN', 'OWNER']) it(`refuses a platform ${role} who is not the owner`, async () => {
    await db.user.update({ where: { id: stranger.id }, data: { roles: [role] as any } });
    await denied(ctx(stranger.id, { roles: [role] as any }));
  });
  for (const principal of ['app-key','bound-session','refused-binding','impersonation','run-with-user']) it(`refuses owner via ${principal}`, async () => {
    const extra: Record<string, Partial<Context>> = {
      'app-key': { appKeyId: generateId(), appId: app.id }, 'bound-session': { sessionId: generateId() },
      'refused-binding': { sessionBindingRefused: true }, impersonation: { impersonation: { orgId: generateId() } as any },
      'run-with-user': { clientId: 'run:2843', appId: app.id },
    };
    await denied(ctx(owner.id, extra[principal]));
  });
  for (const state of ['missing-agent','deleted-agent','deleted-app','uninstalled-app']) it(`refuses ${state} with no writes`, async () => {
    if (state === 'missing-agent') await db.appAgent.deleteMany({ where: { appId: app.id } });
    if (state === 'deleted-agent') await db.agent.update({ where: { id: agent.id }, data: { deletedAt: new Date() } });
    if (state === 'deleted-app') await db.app.update({ where: { id: app.id }, data: { deletedAt: new Date() } });
    if (state === 'uninstalled-app') await db.app.update({ where: { id: app.id }, data: { uninstalledAt: new Date() } });
    await denied(ctx(), {}, state.endsWith('agent') ? 'AGENT_NOT_INSTALLED' : 'FORBIDDEN');
  });
  it('rolls back Memory and root on injected root projection failure', async () => {
    vi.spyOn(rootFs, 'saveNodeToFs').mockResolvedValue({ error: '2843 root failure' });
    await expect(create()).rejects.toThrow('2843 root failure');
    expect(await db.memory.count()).toBe(0); expect(await db.node.count()).toBe(0);
  });
  it('retains root validation after owner authorization', async () => { await denied(ctx(), {name:'../invalid'}, 'BAD_USER_INPUT'); });
});

describe('#2843 committed competing writes under real authority anchor waits', () => {
  for (const race of ['transfer','org-transfer','uninstall-agent','delete','uninstall-app','unchanged']) it(`reloads after ${race}`, async () => {
    let release!: () => void, held!: () => void;
    const gate = new Promise<void>(r => release = r), ready = new Promise<void>(r => held = r);
    const org = race === 'org-transfer' ? await db.organization.create({ data: {name:'New',urn:'new2843.test'} }) : null;
    // The same caller could authorize in the new tenant: only the observed tuple comparison must defeat this stale create.
    if (org) await db.orgMember.create({data:{organizationId:org.id,userId:owner.id,role:'ADMIN'}});
    const revoker = db.$transaction(async tx => {
      await lockAuthorityAnchors(tx, [{ kind: 'app', id: app.id }], 'exclusive');
      if (race === 'transfer') await tx.app.update({ where: {id:app.id}, data: {ownerUserId:stranger.id} });
      if (race === 'org-transfer') await tx.app.update({ where: {id:app.id}, data: {ownerUserId:null,organizationId:org!.id} });
      if (race === 'uninstall-agent') await tx.appAgent.deleteMany({ where: {appId:app.id} });
      if (race === 'delete') await tx.app.update({ where: {id:app.id}, data: {deletedAt:new Date()} });
      if (race === 'uninstall-app') await tx.app.update({ where: {id:app.id}, data: {uninstalledAt:new Date()} });
      held(); await gate;
    });
    await ready;
    let settled = false;
    const pending = create().then((row: unknown) => ({row}), (error: unknown) => ({error})).finally(() => { settled = true; });
    try {
      await waitForLockWaiters(db, 1, 2000);
      expect(settled, 'creator must really wait behind the competing App writer').toBe(false);
    } finally { release(); await revoker; await pending; }
    const result = await pending;
    if (race === 'unchanged') { expect(result).toHaveProperty('row'); expect(await db.memory.count()).toBe(1); expect(await db.node.count()).toBe(1); }
    else {
      expect(result).toMatchObject({ error: { extensions: { code: race === 'uninstall-agent' ? 'AGENT_NOT_INSTALLED' : 'FORBIDDEN' } } });
      expect(await db.memory.count()).toBe(0); expect(await db.node.count()).toBe(0);
    }
  });
});

describe('#2843 real MCP tool delegation', () => {
  const tool = (auth: any, name = 'MCP Owner') => createTestableMcpServer(auth).callToolText('hadron_create_app_memory', { app: app.id, name });
  it('owner success persists the same tenant row and root', async () => {
    expect(await tool(ctx())).toContain('Memory created:');
    const row = await db.memory.findFirstOrThrow({ where: {appId:app.id} });
    expect(row).toMatchObject({ ownerUserId:owner.id,organizationId:null,class:'app',createdBy:owner.id });
    expect(await db.node.count({where:{memoryId:row.id}})).toBe(1);
  });
  it('no Agent has the same refusal', async () => {
    await db.appAgent.deleteMany({where:{appId:app.id}});
    expect(await tool(ctx())).toBe('Error: This App has no Agent installed.');
    expect(await db.memory.count()).toBe(0);
  });
  for (const principal of ['stranger','app-key','session','refused-binding','impersonation','run-with-user']) it(`preserves ${principal} refusal`, async () => {
    const auth: Record<string, any> = {
      stranger: ctx(stranger.id), 'app-key': ctx(owner.id,{appKeyId:generateId(),appId:app.id}),
      session: ctx(owner.id,{sessionId:generateId()}), 'refused-binding': ctx(owner.id,{sessionBindingRefused:true}),
      impersonation: ctx(owner.id,{impersonation:{orgId:generateId()} as any}), 'run-with-user': ctx(owner.id,{clientId:'run:2843',appId:app.id}),
    };
    expect(await tool(auth[principal])).toBe('Error: Forbidden');
    expect(await db.memory.count()).toBe(0); expect(await db.node.count()).toBe(0);
  });
});
