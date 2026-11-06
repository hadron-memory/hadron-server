/**
 * Object store MCP tools (#745): hadron_create_object / _get_object /
 * _update_object / _delete_object / _find_objects — thin wrappers over the
 * GraphQL object resolvers. Covers the CRUD + query round-trip, the natural
 * key, and that conformance / reserved-key errors surface as tool-error text.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { createTestableMcpServer } from './server.js';
import type { AuthContext } from '../middleware/auth.js';

let adminId: string;
let orgId: string;
let memId: string;
let memUrn: string;
const admin = (): Context => ({ db, roles: ['ADMIN'], userId: adminId } as Context);
const adminAuth = (): AuthContext => ({ userId: adminId, roles: ['ADMIN'], clientId: `user:${adminId}` });
const call = (tool: string, args: Record<string, unknown>): Promise<string> =>
  createTestableMcpServer(adminAuth()).callToolText(tool, args);

const schema = {
  objectTypes: {
    competitor: { fields: { name: { type: 'text', required: true }, stage: { type: 'text' }, fundingUsd: { type: 'number' } } },
  },
};

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'omcp-org', urn: 'omcp-org' } });
  orgId = org.id;
  const a = await db.user.create({ data: { githubId: 6611, githubUsername: 'omcp-admin', roles: ['ADMIN'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: a.id, role: 'ADMIN' } });
  adminId = a.id;
  const mem = await resolvers.Mutation.createMemory({}, { orgId, name: 'intel' }, admin());
  memId = mem.id;
  memUrn = mem.urn;
  await (resolvers.Mutation as any).updateMemory(null, { id: memId, schema }, admin());
});

describe('object store MCP tools', () => {
  it('create → get → update → find → delete round-trip', async () => {
    const created = JSON.parse(await call('hadron_create_object', { memoryUrn: memUrn, type: 'competitor', fields: { name: 'Letta', stage: 'seed' } }));
    expect(created).toMatchObject({ type: 'competitor', name: 'Letta', stage: 'seed' });
    const id = created.id as string;

    const got = JSON.parse(await call('hadron_get_object', { ref: id }));
    expect(got).toMatchObject({ id, name: 'Letta' });

    const updated = JSON.parse(await call('hadron_update_object', { ref: id, fields: { stage: 'series-a', fundingUsd: 10 } }));
    expect(updated).toMatchObject({ name: 'Letta', stage: 'series-a', fundingUsd: 10 });

    await call('hadron_create_object', { memoryUrn: memUrn, type: 'competitor', fields: { name: 'Beta', stage: 'series-a', fundingUsd: 2 } });
    const found = JSON.parse(await call('hadron_find_objects', { memoryUrn: memUrn, type: 'competitor', match: { stage: 'series-a' }, sort: { fundingUsd: 'desc' } }));
    // The tool returns { objects, total }. numeric desc: Letta(10) then Beta(2).
    expect(found.objects.map((o: any) => o.name)).toEqual(['Letta', 'Beta']);
    expect(found.total).toBe(2);

    expect(await call('hadron_delete_object', { ref: id })).toMatch(/deleted/i);
    expect(await call('hadron_get_object', { ref: id })).toMatch(/not found/i);
  });

  it('creates with a natural key → human-meaningful loc', async () => {
    const created = JSON.parse(await call('hadron_create_object', { memoryUrn: memUrn, type: 'competitor', fields: { name: 'Letta' }, key: 'letta' }));
    const node = await db.node.findUnique({ where: { id: created.id } });
    expect(node!.loc).toBe('competitor:letta');
  });

  it('surfaces a schema-conformance violation as tool-error text', async () => {
    const text = await call('hadron_create_object', { memoryUrn: memUrn, type: 'competitor', fields: { stage: 'seed' } }); // missing required name
    expect(text).toMatch(/Error:/);
    expect(text).toMatch(/name/i);
  });

  it('surfaces a reserved-field-name error', async () => {
    const text = await call('hadron_create_object', { memoryUrn: memUrn, type: 'competitor', fields: { id: 'x', name: 'n' } });
    expect(text).toMatch(/Error:/);
    expect(text).toMatch(/reserved/i);
  });
});

describe('findObjects exact totals (#2514)', () => {
  async function seed() {
    for (const [name, stage, fundingUsd] of [['A', 'seed', 1], ['B', 'seed', 2], ['C', 'grown', 3]] as const) {
      await call('hadron_create_object', { memoryUrn: memUrn, type: 'competitor', key: name.toLowerCase(), fields: { name, stage, fundingUsd } });
    }
  }

  it.each([
    [{ fundingUsd: 1 }, 1],
    [{ fundingUsd: 99 }, 0],
    [undefined, 3],
  ])('returns the full total for match %j', async (match, total) => {
    await seed();
    const found = JSON.parse(await call('hadron_find_objects', { memoryUrn: memUrn, type: 'competitor', match }));
    expect(found.objects).toHaveLength(total);
    expect(found.total).toBe(total);
  });

  it('counts before paging and keeps match, where and sorting composed', async () => {
    await seed();
    const args = { memoryUrn: memUrn, type: 'competitor', match: { stage: 'seed' }, where: { path: ['fundingUsd'], as: 'number', gte: 1 }, sort: { fundingUsd: 'desc' }, limit: 1 };
    const first = JSON.parse(await call('hadron_find_objects', args));
    const second = JSON.parse(await call('hadron_find_objects', { ...args, offset: 1 }));
    const past = JSON.parse(await call('hadron_find_objects', { ...args, offset: 9 }));
    expect(first.objects.map((o: { name: string }) => o.name)).toEqual(['B']);
    expect(second.objects.map((o: { name: string }) => o.name)).toEqual(['A']);
    expect(past.objects).toEqual([]);
    expect([first.total, second.total, past.total]).toEqual([2, 2, 2]);
  });

  it('excludes deleted rows, other collections and other memories from totals', async () => {
    await seed();
    const c = await db.node.findFirstOrThrow({ where: { memoryId: memId, loc: 'competitor:c' } });
    await call('hadron_delete_object', { ref: c.id });
    await db.node.create({ data: { id: generateId(), memoryId: memId, loc: 'other:x', name: 'other', nodeType: 'info', objectType: 'other', properties: { stage: 'seed' } } });
    const foreign = await resolvers.Mutation.createMemory({}, { orgId, name: 'foreign' }, admin());
    await db.node.create({ data: { id: generateId(), memoryId: foreign.id, loc: 'competitor:x', name: 'foreign', nodeType: 'info', objectType: 'competitor', properties: { stage: 'seed' } } });
    for (const match of [undefined, { stage: 'seed' }]) {
      const found = JSON.parse(await call('hadron_find_objects', { memoryUrn: memUrn, type: 'competitor', match }));
      expect(found.total).toBe(2);
      expect(found.objects).toHaveLength(2);
    }
  });
});
