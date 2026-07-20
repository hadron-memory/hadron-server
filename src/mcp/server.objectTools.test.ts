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
    // numeric desc: Letta(10) then Beta(2).
    expect(found.map((o: any) => o.name)).toEqual(['Letta', 'Beta']);

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
