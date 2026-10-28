import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { canReadMemoryRecord, requireMemoryWriteAccess } from './resolvers.helpers.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import { lockAuthorityAnchors } from '../../../lib/auth/authorityAnchors.js';
import { waitForLockWaiters } from '../../../test/lockWait.js';
import { typeDefs } from './typeDefs.js';
import { buildSchema, graphql } from 'graphql';

const M = resolvers.Mutation as any;
let org: any, foreign: any, app: any, agent: any;
let admin: any, owner: any, member: any, revoked: any, outsider: any, participant: any;
const ctx = (u?: string, extra: Partial<Context> = {}): Context => ({ db, userId: u, roles: [], ...extra });
const create = (c = ctx(admin.id), args: any = {}) => {
  expect(M.createAppMemory, 'new creation operation must exist').toBeTypeOf('function');
  return M.createAppMemory({}, { appRef: app.id, name: 'App Notes', ...args }, c);
};
const refused = async (c: Context, args: any = {}, code = 'FORBIDDEN') => {
  const count = await db.memory.count();
  await expect(create(c, args)).rejects.toMatchObject({ extensions: { code } });
  expect(await db.memory.count()).toBe(count);
};
beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { name: 'App tenant', urn: 'app2661.test' } });
  foreign = await db.organization.create({ data: { name: 'Agent tenant', urn: 'agent2661.test' } });
  const user = (n: number) => db.user.create({ data: { githubId: 266100+n, githubUsername: `u2661-${n}`, roles: ['READER'] } });
  [admin, owner, member, revoked, outsider, participant] = await Promise.all([1,2,3,4,5,6].map(user));
  await db.orgMember.createMany({ data: [
    { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
    { organizationId: org.id, userId: owner.id, role: 'OWNER' },
    { organizationId: org.id, userId: member.id, role: 'CONTRIBUTOR' },
    { organizationId: org.id, userId: revoked.id, role: 'ADMIN', deletedAt: new Date() },
    { organizationId: foreign.id, userId: outsider.id, role: 'ADMIN' },
  ] });
  app = await db.app.create({ data: { name: 'App', urn: `${org.urn}:app`, organizationId: org.id } });
  agent = await db.agent.create({ data: { name: 'Foreign Agent', urn: `${foreign.urn}:agent`, organizationId: foreign.id } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  await db.appMember.create({ data: { appId: app.id, userId: participant.id, role: 'reader' } });
});

describe('#2661 new free-standing app memory', () => {
  for (const role of ['admin','owner']) it(`${role} creates the ruled row with participant read/write and tenant isolation`, async () => {
    const row = await create(ctx(role === 'admin' ? admin.id : owner.id));
    const listed = await (resolvers.Query as any).memories({}, { filter: { memoryClasses: ['app'] } }, ctx(participant.id));
    expect(listed.items.map((m: any) => m.id)).toContain(row.id);
    expect(row).toMatchObject({ class: 'app', organizationId: org.id, appId: app.id, isInstallMemory: false,
      installOfAgentId: null, userId: null, userMemoryOfAgentId: null, sharedMemoryOfAgentId: null, visibility: null });
    expect(row.urn).toBe(`${org.urn}:app-notes`);
    expect(await db.agentMemoryItem.count({ where: { memoryId: row.id } })).toBe(0);
    for (const u of [member, participant]) {
      expect(await canReadMemoryRecord(ctx(u.id), row)).toBe(true);
      await expect(requireMemoryWriteAccess(ctx(u.id), row.id)).resolves.toBeUndefined();
    }
    expect(await canReadMemoryRecord(ctx(outsider.id), row)).toBe(false);
    await expect(requireMemoryWriteAccess(ctx(outsider.id), row.id)).rejects.toThrow();
    expect(await db.memory.count({ where: { organizationId: foreign.id } })).toBe(0);
  });
  for (const principal of ['member','revoked','other-org','app-key','worker','impersonation','run','anonymous','invalid-session']) {
    it(`refuses ${principal} without writes`, async () => {
      const c: Record<string, Context> = {
        member: ctx(member.id), revoked: ctx(revoked.id), 'other-org': ctx(outsider.id),
        'app-key': ctx(admin.id, { appId: app.id, appKeyId: generateId() }),
        worker: ctx(admin.id, { sessionId: generateId() }),
        impersonation: ctx(admin.id, { impersonation: { orgId: org.id } as any }),
        'invalid-session': ctx(admin.id, { sessionBindingRefused: true }),
        run: ctx(admin.id, { clientId: 'run:test', appId: app.id }), anonymous: ctx(undefined, {roles:['ADMIN']}),
      };
      await refused(c[principal]);
    });
  }
  it('refuses an empty name before writing', async () => {
    await refused(ctx(admin.id), {name:'   '}, 'BAD_USER_INPUT');
  });
  it('refuses a user-owned App with a typed answer even for its owner', async () => {
    const personal = await db.app.create({ data: { name: 'Own', urn: 'u2661:own', ownerUserId: admin.id } });
    await db.appAgent.create({ data: { appId: personal.id, agentId: agent.id } });
    await refused(ctx(admin.id), { appRef: personal.id }, 'USER_OWNED_APP_UNSUPPORTED');
  });
  it('refuses an App with no installed Agent', async () => {
    await db.appAgent.deleteMany({ where: { appId: app.id } });
    await refused(ctx(admin.id), {}, 'AGENT_NOT_INSTALLED');
  });
  it('MCP preserves the no-Agent and user-owned refusal answers', async () => {
    const auth = { userId: admin.id, roles: [] as any[], clientId: `user:${admin.id}` };
    await db.appAgent.deleteMany({where:{appId:app.id}});
    expect(await createTestableMcpServer(auth).callToolText('hadron_create_app_memory', {app:app.id,name:'No Agent'})).toBe('Error: This App has no Agent installed.');
    const own = await db.app.create({data:{name:'Own',urn:'u2661:own',ownerUserId:admin.id}});
    expect(await createTestableMcpServer(auth).callToolText('hadron_create_app_memory', {app:own.id,name:'Own'})).toBe('Error: Creating an app memory for a user-owned App is not yet supported.');
    expect(await db.memory.count()).toBe(0);
  });
  it('does not count a deleted Agent as an installation', async () => {
    await db.agent.update({ where: { id: agent.id }, data: { deletedAt: new Date() } });
    await refused(ctx(admin.id), {}, 'AGENT_NOT_INSTALLED');
  });
  it('refuses deleted/uninstalled Apps before writing', async () => {
    for (const field of ['deletedAt','uninstalledAt']) {
      await db.app.update({ where: { id: app.id }, data: { deletedAt: null, uninstalledAt: null, [field]: new Date() } });
      await expect(create()).rejects.toThrow();
      expect(await db.memory.count()).toBe(0);
    }
  });
  it('GraphQL exposes creation only, no existing-memory or agent selector', async () => {
    const schema = buildSchema(typeDefs);
    const op = schema.getMutationType()!.getFields().createAppMemory;
    expect(op, 'GraphQL operation exists').toBeDefined();
    expect(op.args.map(a => a.name)).toEqual(['appRef','name','shortDescription','description','tags']);
    const result = await graphql({ schema, source: 'mutation($a:ID!){createAppMemory(appRef:$a,name:"Wire Notes"){id class}}',
      variableValues: { a: app.id }, rootValue: { createAppMemory: (args: any) => create(ctx(admin.id), args) } });
    expect(result.errors).toBeUndefined();
    expect((result.data as any).createAppMemory.class).toBe('app');
  });
  it('MCP delegates creation and preserves refusal text for all denied principals', async () => {
    const server = createTestableMcpServer({ userId: admin.id, roles: [], clientId: `user:${admin.id}` });
    expect(await server.callToolText('hadron_create_app_memory', { app: app.id, name: 'MCP Notes' })).toContain('Memory created:');
    for (const c of [ctx(member.id), ctx(revoked.id), ctx(outsider.id), ctx(admin.id,{sessionId:generateId()}),
      ctx(admin.id,{impersonation:{orgId:org.id} as any}), ctx(undefined,{appId:app.id}), ctx(admin.id,{clientId:'run:x',appId:app.id})]) {
      const count = await db.memory.count();
      let message = '';
      try { await create(c); } catch (e) { message = (e as Error).message; }
      expect(message).toBe('Forbidden');
      const text = await createTestableMcpServer(c as any).callToolText('hadron_create_app_memory', { app: app.id, name: 'Refused' });
      expect(text).toContain(message);
      expect(await db.memory.count()).toBe(count);
    }
  });
  for (const race of ['uninstall','revoke','transfer']) it(`waits for concurrent ${race}, then refuses with no memory`, async () => {
    expect(M.createAppMemory).toBeTypeOf('function');
    let release!: () => void, held!: () => void;
    const gate = new Promise<void>(r => release=r), ready = new Promise<void>(r => held=r);
    const revoker = db.$transaction(async tx => {
      await lockAuthorityAnchors(tx, [{kind: race !== 'revoke' ? 'app':'org', id: race !== 'revoke' ? app.id:org.id}], 'exclusive');
      if (race === 'uninstall') await tx.appAgent.deleteMany({where:{appId:app.id}});
      else if (race === 'transfer') await tx.app.update({where:{id:app.id},data:{organizationId:foreign.id}});
      else await tx.orgMember.updateMany({where:{organizationId:org.id,userId:admin.id},data:{deletedAt:new Date()}});
      held(); await gate;
    });
    await ready;
    let settled = false;
    const pending = create().then(() => 'created', (e: unknown) => e).finally(() => { settled = true; });
    try {
      // A bypass must fail an assertion, not leave a revoker hanging until
      // the test timeout. Always release and join both transactions.
      await waitForLockWaiters(db, 1, 1000).catch(() => undefined);
      expect(settled, 'creator must wait for the authority revoker').toBe(false);
    } finally { release(); await revoker; await pending; }
    expect(await pending).toMatchObject({extensions:{code:race === 'uninstall'?'AGENT_NOT_INSTALLED':'FORBIDDEN'}});
    expect(await db.memory.count()).toBe(0);
  });
});
