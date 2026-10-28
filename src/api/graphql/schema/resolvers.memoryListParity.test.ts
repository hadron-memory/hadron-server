import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
/** #1626: every listed record must pass cor:acl:010:01's point-read gate. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSchema, defaultFieldResolver, graphql } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
import { canReadMemoryRecord, filterReadableMemoryRecords } from './resolvers.helpers.js';

const schema = buildSchema(typeDefs);
let orgId: string;
let appId: string;
let rows: Record<string, Awaited<ReturnType<typeof db.memory.create>>>;
let users: Record<string, string>;

/** Execute the real fields, including Organization.memories on eager-loaded parents. */
async function query(source: string, ctx: Context) {
  const result = await graphql({
    schema, source, contextValue: ctx,
    fieldResolver: (parent, args, context, info) => {
      const fields = resolvers[info.parentType.name as keyof typeof resolvers] as Record<string, Function> | undefined;
      const resolver = fields?.[info.fieldName];
      return typeof resolver === 'function'
        ? resolver(parent, args, context, info)
        : defaultFieldResolver(parent, args, context, info);
    },
  });
  expect(result.errors).toBeUndefined();
  return result.data as any;
}

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { name: 'List parity', urn: 'list-parity.test' } });
  orgId = org.id;
  users = {};
  for (const [index, name] of ['reader', 'contributor', 'appMember', 'holder', 'admin', 'groupMember', 'platformAdmin'].entries()) {
    const user = await db.user.create({ data: { githubId: 162600 + index, handle: `list-${name.toLowerCase()}`, roles: name === 'platformAdmin' ? ['ADMIN'] : ['READER'] } });
    users[name] = user.id;
    await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: name === 'admin' ? 'ADMIN' : name === 'contributor' ? 'CONTRIBUTOR' : 'READER' } });
  }
  const app = await db.app.create({ data: { name: 'List app', urn: `${org.urn}:list-app`, organizationId: org.id } });
  appId = app.id;
  const agent = await db.agent.create({ data: { name: 'List agent', urn: `${org.urn}:list-agent`, organizationId: org.id } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  await db.appMember.create({ data: { appId: app.id, userId: users.appMember, role: 'reader' } });
  rows = {};
  for (const name of ['knowledge', 'group', 'team', 'standalone', 'worker', 'session', 'appKnowledge', 'appGroup', 'personal', 'private']) {
    const appClass = ['team', 'standalone', 'worker', 'session'].includes(name);
    const cls = appClass ? 'app' : name === 'appKnowledge' ? 'knowledge' : name === 'appGroup' ? 'group' : name;
    rows[name] = await db.memory.create({ data: {
      name, urn: `${org.urn}:${name.toLowerCase()}`, organizationId: org.id,
      class: cls as any,
      visibility: cls === 'group' ? 'GROUP' : cls === 'knowledge' ? 'ORGANIZATION' : null,
      appId: appClass || name.startsWith('app') ? app.id : null,
      sharedMemoryOfAgentId: name === 'team' ? agent.id : null,
      userMemoryOfAgentId: name === 'session' ? agent.id : null,
      userId: ['personal', 'private'].includes(name) ? users.admin : null,
    } });
  }
  await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name: 'List worker', slug: 'list-worker', memoryId: rows.worker.id, heldByUserId: users.holder, heldAt: new Date() } });
  await db.memoryMember.create({ data: { memoryId: rows.group.id, userId: users.groupMember, role: 'reader' } });
  for (const name of ['knowledge', 'worker']) {
    await db.agentMemoryItem.create({ data: { agentId: agent.id, memoryId: rows[name].id, role: 'read' } });
  }
});

describe('#1626 record/list parity', () => {
  it.each(['reader', 'contributor', 'appMember', 'holder', 'admin', 'groupMember', 'platformAdmin'])('%s receives only readable records, with positive controls', async name => {
    const ctx: Context = { db, userId: users[name], roles: name === 'platformAdmin' ? ['ADMIN'] : ['READER'] };
    const candidates = Object.values(rows);
    const pointVerdicts = await Promise.all(candidates.map(row => canReadMemoryRecord(ctx, row)));
    expect((await filterReadableMemoryRecords(ctx, candidates)).map(row => row.id)).toEqual(
      candidates.filter((_, index) => pointVerdicts[index]).map(row => row.id),
    );
    const result = await query(`{
      memories(limit: 100) { total items { id } }
      organization(ref: "${orgId}") { memories { id } }
      organizations(filter: { memberOnly: true }) { items { memories { id } } }
    }`, ctx);
    const lists: Array<Array<{ id: string }>> = [result.memories.items, result.organization.memories, result.organizations.items[0].memories];
    for (const list of lists) {
      expect(list.map(row => row.id)).toContain(rows.knowledge.id);
      for (const row of list) {
        const memory = await db.memory.findUniqueOrThrow({ where: { id: row.id } });
        expect(await canReadMemoryRecord(ctx, memory), `${name}: ${memory.name}`).toBe(true);
      }
    }
    const ids = lists[0].map(row => row.id);
    expect(result.memories.total).toBe(ids.length);
    expect(ids.includes(rows.team.id)).toBe(['contributor', 'appMember', 'admin', 'platformAdmin'].includes(name));
    expect(ids.includes(rows.standalone.id)).toBe(['contributor', 'appMember', 'admin', 'platformAdmin'].includes(name));
    expect(ids.includes(rows.worker.id)).toBe(['holder', 'admin', 'platformAdmin'].includes(name));
    expect(ids).not.toContain(rows.session.id);
    for (const [index, list] of lists.entries()) {
      // The default top-level list remains a membership slice even for a
      // platform admin; org fields may use the point-read admin bypass.
      expect(list.some(row => row.id === rows.group.id)).toBe(name === 'groupMember' || (index > 0 && name === 'platformAdmin'));
    }
    const expectedOrgIds = [rows.knowledge.id, ...(['groupMember', 'platformAdmin'].includes(name) ? [rows.group.id] : [])].sort();
    for (const list of lists.slice(1)) {
      // Org pages intentionally exclude all App-internal and strict-owner
      // rows through ORG_INCLUDE, even for an entitled manager/owner.
      expect(list.map(row => row.id).sort()).toEqual(expectedOrgIds);
    }
    const fallback = await resolvers.Organization.memories({ id: orgId }, {}, ctx);
    expect(fallback.map(row => row.id).sort()).toEqual(expectedOrgIds);
    // Record visibility of app-scoped knowledge intentionally differs from
    // node reach; this fix must preserve that established record contract.
    expect(ids).toContain(rows.appKnowledge.id);
    expect(ids).not.toContain(rows.appGroup.id);
    if (!['admin'].includes(name)) {
      expect(ids).not.toContain(rows.personal.id);
      expect(ids).not.toContain(rows.private.id);
    }
    const page = await query('{ memories(limit: 1, offset: 1) { total items { id } } }', ctx);
    expect(page.memories.total).toBe(ids.length);
    expect(page.memories.items).toEqual(result.memories.items.slice(1, 2));
    const count = await query('{ memories(limit: 0) { total items { id } } }', ctx);
    expect(count.memories).toEqual({ total: ids.length, items: [] });
  });

  it('gates Organization.memories when the parent was not eagerly loaded', async () => {
    const ctx: Context = { db, userId: users.reader, roles: ['READER'] };
    const result = await resolvers.Organization.memories({ id: orgId }, {}, ctx);
    expect(result.map(row => row.id)).toEqual([rows.knowledge.id]);
  });

  it('an agent attachment cannot list a worker record to an App member', async () => {
    const ctx: Context = { db, userId: users.appMember, appId, roles: ['READER'] };
    const result = await query('{ memories { total items { id } } }', ctx);
    expect(result.memories).toEqual({ total: 1, items: [{ id: rows.knowledge.id }] });
    const manager: Context = { db, userId: users.admin, appId, roles: ['READER'] };
    const allowed = await query('{ memories { items { id } } }', manager);
    expect(allowed.memories.items.map((row: { id: string }) => row.id)).toContain(rows.worker.id);
  });

  it('DS bounds platform-admin lists across two orgs while external AppMembers discover their own App', async () => {
    const otherOrg = await db.organization.create({ data: { name: 'Other org', urn: 'list-other.test' } });
    const otherApp = await db.app.create({ data: { name: 'Other app', urn: 'list-other.test:app', organizationId: otherOrg.id } });
    const agent = await db.agent.create({ data: { name: 'Other agent', urn: 'list-other.test:agent', organizationId: otherOrg.id } });
    await db.appAgent.create({ data: { appId: otherApp.id, agentId: agent.id } });
    const team = await db.memory.create({ data: { name: 'Other team', urn: 'list-other.test:team', organizationId: otherOrg.id, appId: otherApp.id, class: 'app', sharedMemoryOfAgentId: agent.id } });
    const worker = await db.memory.create({ data: { name: 'Other worker', urn: 'list-other.test:worker', organizationId: otherOrg.id, appId: otherApp.id, class: 'app' } });
    await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: otherApp.id, agentId: agent.id, name: 'Other worker', slug: 'other', memoryId: worker.id } });
    const external = await db.user.create({ data: { handle: 'list-external', roles: ['READER'] } });
    await db.appMember.create({ data: { appId: otherApp.id, userId: external.id, role: 'reader' } });
    const nonMemberAdmin = await db.user.create({ data: { handle: 'list-non-member-admin', roles: ['ADMIN'] } });
    const memberAdminCtx: Context = { db, userId: users.platformAdmin, roles: ['ADMIN'] };
    const nonMemberCtx: Context = { db, userId: nonMemberAdmin.id, roles: ['ADMIN'] };
    for (const ctx of [memberAdminCtx, nonMemberCtx]) {
      const result = await query('{ memories { items { id } } }', ctx);
      const ids = result.memories.items.map((row: { id: string }) => row.id);
      expect(ids).not.toContain(team.id);
      expect(ids).not.toContain(worker.id);
      expect(ids.includes(rows.team.id)).toBe(ctx === memberAdminCtx);
      expect(ids.includes(rows.worker.id)).toBe(ctx === memberAdminCtx);
      // DS does not narrow direct reads. DT still excludes others' personal
      // and private rows before the admin bypass (existing shared gate).
      expect(await canReadMemoryRecord(ctx, team)).toBe(true);
      expect(await canReadMemoryRecord(ctx, worker)).toBe(true);
      expect(await canReadMemoryRecord(ctx, rows.personal)).toBe(false);
      expect(await canReadMemoryRecord(ctx, rows.private)).toBe(false);
    }
    const externalCtx: Context = { db, userId: external.id, roles: ['READER'] };
    const result = await query('{ memories { total items { id } } }', externalCtx);
    expect(result.memories).toEqual({ total: 1, items: [{ id: team.id }] });
    // An API-invalid app subscription is not a list grant, even when the
    // recipient is a member of its subscribing org.
    await db.memorySubscription.create({ data: { memoryId: worker.id, organizationId: orgId, role: 'READER' } });
    const subscribed = await query('{ memories { items { id } } }', { db, userId: users.reader, roles: ['READER'] });
    expect(subscribed.memories.items.map((row: { id: string }) => row.id)).not.toContain(worker.id);
    // The new AppMember scope cannot widen an explicitly selected org.
    const scoped = await query(`{ memories(orgId: "${orgId}") { total items { id } } }`, externalCtx);
    expect(scoped.memories).toEqual({ total: 0, items: [] });
  });

  it('org record filtering batches membership and access-set reads rather than doing one point read per row', async () => {
    for (let index = 0; index < 5; index++) {
      await db.memory.create({ data: { name: `group-${index}`, urn: `list-parity.test:group-${index}`, organizationId: orgId, class: 'group', visibility: 'GROUP' } });
      await db.memory.create({ data: { name: `knowledge-${index}`, urn: `list-parity.test:knowledge-${index}`, organizationId: orgId, class: 'knowledge', visibility: 'ORGANIZATION' } });
    }
    const memberPoint = vi.spyOn(db.orgMember, 'findFirst');
    const memoryPoint = vi.spyOn(db.memory, 'findUnique');
    try {
      const result = await resolvers.Organization.memories({ id: orgId }, {}, { db, userId: users.reader, roles: ['READER'] });
      expect(result).toHaveLength(6);
      expect(memberPoint).not.toHaveBeenCalled();
      expect(memoryPoint).not.toHaveBeenCalled();
    } finally {
      memberPoint.mockRestore();
      memoryPoint.mockRestore();
    }
  });

  it('a completed list batch cannot authorize a later list after membership revocation', async () => {
    const ctx: Context = { db, userId: users.groupMember, roles: ['READER'] };
    expect((await resolvers.Organization.memories({ id: orgId }, {}, ctx)).map(row => row.id).sort()).toEqual([rows.knowledge.id, rows.group.id].sort());
    await db.memoryMember.delete({ where: { memoryId_userId: { memoryId: rows.group.id, userId: users.groupMember } } });
    await db.orgMember.updateMany({ where: { organizationId: orgId, userId: users.groupMember }, data: { deletedAt: new Date() } });
    expect(await resolvers.Organization.memories({ id: orgId }, {}, ctx)).toEqual([]);
  });
});
