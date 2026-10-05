/** #1626: every listed record must pass cor:acl:010:01's point-read gate. */
import { beforeEach, describe, expect, it } from 'vitest';
import { buildSchema, defaultFieldResolver, graphql } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
import { canReadMemoryRecord } from './resolvers.helpers.js';

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
  await db.worker.create({ data: { appId: app.id, agentId: agent.id, name: 'List worker', slug: 'list-worker', memoryId: rows.worker.id, heldByUserId: users.holder, heldAt: new Date() } });
  await db.memoryMember.create({ data: { memoryId: rows.group.id, userId: users.groupMember, role: 'reader' } });
  for (const name of ['knowledge', 'worker']) {
    await db.agentMemoryItem.create({ data: { agentId: agent.id, memoryId: rows[name].id, role: 'read' } });
  }
});

describe('#1626 record/list parity', () => {
  it.each(['reader', 'contributor', 'appMember', 'holder', 'admin', 'groupMember', 'platformAdmin'])('%s receives only readable records, with positive controls', async name => {
    const ctx: Context = { db, userId: users[name], roles: name === 'platformAdmin' ? ['ADMIN'] : ['READER'] };
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
});
