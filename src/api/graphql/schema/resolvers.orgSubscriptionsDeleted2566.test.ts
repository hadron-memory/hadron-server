import { beforeEach, describe, expect, it } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

// #2566: a memory soft-delete does not tombstone its subscriptions, and the
// platform-admin shortcut in canReadMemoryRecord leaves the memory tombstone to
// its callers, so Organization.subscriptions listed a deleted memory for them.
const server = new ApolloServer<Context>({ typeDefs, resolvers });
const principals = ['orgReader', 'platformAdmin'] as const;
type Principal = typeof principals[number];
let users: Record<Principal, string>;
let customer: string;
let liveMemory: string;
let liveSubscription: string;
let deletedMemory: string;

const ctx = (p: Principal): Context => ({ db, userId: users[p], roles: p === 'platformAdmin' ? ['ADMIN'] : ['READER'] });

async function query(p: Principal, source: string, variables: Record<string, unknown> = {}) {
  const result = await server.executeOperation({ query: source, variables }, { contextValue: ctx(p) });
  if (result.body.kind !== 'single') throw new Error('unexpected incremental result');
  return result.body.singleResult;
}

beforeEach(async () => {
  await cleanDb(db);
  const vendor = (await db.organization.create({ data: { name: 'Vendor 2566', urn: 'vendor-2566' } })).id;
  customer = (await db.organization.create({ data: { name: 'Customer 2566', urn: 'customer-2566' } })).id;
  users = {} as Record<Principal, string>;
  for (const p of principals) {
    users[p] = (await db.user.create({ data: { handle: `s2566-${p.toLowerCase()}`, roles: p === 'platformAdmin' ? ['ADMIN'] : ['READER'] } })).id;
  }
  await db.orgMember.create({ data: { organizationId: customer, userId: users.orgReader, role: 'READER' } });
  const make = (name: string) => db.memory.create({ data: {
    organizationId: vendor, name, urn: `vendor-2566:${name}`, class: 'knowledge', visibility: 'PUBLIC',
  } });
  liveMemory = (await make('live')).id;
  deletedMemory = (await make('gone')).id;
  liveSubscription = (await db.memorySubscription.create({ data: { memoryId: liveMemory, organizationId: customer, createdAt: new Date('2026-01-01') } })).id;
  await db.memorySubscription.create({ data: { memoryId: deletedMemory, organizationId: customer, createdAt: new Date('2026-01-02') } });
  // Soft-delete the memory only; its subscription row stays live.
  await db.memory.update({ where: { id: deletedMemory }, data: { deletedAt: new Date() } });
});

describe('#2566 Organization.subscriptions and soft-deleted memories', () => {
  it.each(principals)('eager path: %s sees only the surviving subscription, memory non-null, no errors', async p => {
    const r = await query(p, 'query($ref: ID!) { organization(ref: $ref) { id subscriptions { id memory { id name } } } }', { ref: customer });
    expect(r.errors).toBeUndefined();
    expect(r.data?.organization).toEqual({ id: customer, subscriptions: [
      { id: liveSubscription, memory: { id: liveMemory, name: 'live' } },
    ] });
  });

  it.each(principals)('lazy path: %s sees only the surviving subscription', async p => {
    const rows = await resolvers.Organization.subscriptions({ id: customer }, {}, ctx(p));
    expect(rows.map(row => row.id)).toEqual([liveSubscription]);
  });

  it('direct memory(ref:) still refuses the deleted memory for the platform admin (the control)', async () => {
    const r = await query('platformAdmin', 'query($ref: ID!) { memory(ref: $ref) { id } }', { ref: deletedMemory });
    expect(r.data?.memory ?? null).toBeNull();
  });
});
