import { beforeEach, describe, expect, it } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

const server = new ApolloServer<Context>({ typeDefs, resolvers });
const principals = ['reader', 'orgReader', 'outsider', 'platformAdmin'] as const;
type Principal = typeof principals[number];
let users: Record<Principal, string>;
let vendor: string;
let customer: string;
let memory: string;
let publicMemory: string;
let subscription: string;
let publicSubscription: string;
let app: string;

function ctx(principal: Principal): Context {
  return { db, userId: users[principal], roles: principal === 'platformAdmin' ? ['ADMIN'] : ['READER'] };
}

async function query(principal: Principal, source: string, variables: Record<string, unknown> = {}) {
  const result = await server.executeOperation({ query: source, variables }, { contextValue: ctx(principal) });
  if (result.body.kind !== 'single') throw new Error('unexpected incremental result');
  return result.body.singleResult;
}

beforeEach(async () => {
  await cleanDb(db);
  vendor = (await db.organization.create({ data: { name: 'Vendor 2557', urn: 'vendor-2557', policy: { secret: 'VENDOR' } } })).id;
  customer = (await db.organization.create({ data: { name: 'Customer 2557', urn: 'customer-2557', policy: { secret: 'CUSTOMER' } } })).id;
  users = {} as Record<Principal, string>;
  for (const principal of principals) {
    users[principal] = (await db.user.create({ data: { handle: `s1-${principal.toLowerCase()}`, roles: principal === 'platformAdmin' ? ['ADMIN'] : ['READER'] } })).id;
  }
  for (const principal of ['reader', 'orgReader'] as const) {
    await db.orgMember.create({ data: { organizationId: customer, userId: users[principal], role: 'READER' } });
  }
  const makeMemory = (name: string) => db.memory.create({ data: {
    organizationId: vendor, name, urn: `vendor-2557:${name}`, class: 'knowledge', visibility: 'PUBLIC',
  } });
  memory = (await makeMemory('changed')).id;
  publicMemory = (await makeMemory('public')).id;
  // The subscription was valid when created. A later class/visibility change
  // leaves a row but no longer grants every subscriber access (GROUP's own
  // MemoryMember audience wins). ORGANIZATION knowledge alone stays readable
  // through a live subscription, so it would not be a denial control.
  subscription = (await db.memorySubscription.create({ data: { memoryId: memory, organizationId: customer, createdAt: new Date('2026-01-01') } })).id;
  publicSubscription = (await db.memorySubscription.create({ data: { memoryId: publicMemory, organizationId: customer, createdAt: new Date('2026-01-02') } })).id;
  await db.memory.update({ where: { id: memory }, data: { class: 'group', visibility: 'GROUP' } });
  await db.memoryMember.create({ data: { memoryId: memory, userId: users.reader, role: 'reader' } });
  app = (await db.app.create({ data: { organizationId: vendor, name: 'Vendor App', urn: 'vendor-2557:app' } })).id;
  // App participation does not confer membership of its owning org.
  await db.appMember.create({ data: { appId: app, userId: users.reader, role: 'member' } });
});

describe('#2557 subscription parent paths', () => {
  it('applies the same filter when Organization has no eager subscriptions', async () => {
    const result = await resolvers.Organization.subscriptions({ id: customer }, {}, ctx('orgReader'));
    expect(result.map(row => row.id)).toEqual([publicSubscription]);
  });

  it.each(principals)('Organization.subscriptions filters by %s memory access without null bubbling', async principal => {
    const direct = await query(principal, 'query($ref: ID!) { memory(ref: $ref) { id } }', { ref: memory });
    const canRead = principal === 'reader' || principal === 'platformAdmin';
    expect(direct.data?.memory).toEqual(canRead ? { id: memory } : null);
    const result = await query(principal, 'query($ref: ID!) { organization(ref: $ref) { id subscriptions { id memory { id name } } } }', { ref: customer });
    if (principal === 'outsider') {
      expect(result.data?.organization).toBeNull();
      expect(result.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
    } else {
      expect(result.errors).toBeUndefined();
      expect(result.data?.organization).toEqual({ id: customer, subscriptions: [
        ...(canRead ? [{ id: subscription, memory: { id: memory, name: 'changed' } }] : []),
        { id: publicSubscription, memory: { id: publicMemory, name: 'public' } },
      ] });
    }
  });

  it.each(principals)('Memory.subscriptions preserves the non-null memory for %s', async principal => {
    const result = await query(principal, 'query($ref: ID!) { memory(ref: $ref) { id subscriptions { id memory { id } } } }', { ref: memory });
    expect(result.errors).toBeUndefined();
    expect(result.data?.memory).toEqual(principal === 'reader' || principal === 'platformAdmin'
      ? { id: memory, subscriptions: [{ id: subscription, memory: { id: memory } }] }
      : null);
  });

  for (const operation of ['createMemorySubscription', 'updateMemorySubscription'] as const) {
    it.each(principals)(`${operation} checks %s memory access before returning a nested memory`, async principal => {
      const hidden = await query(principal, `mutation($memory: String!, $org: String!) { ${operation}(memoryRef: $memory, orgRef: $org, role: READER) { id memory { id } } }`, { memory, org: customer });
      // A memory reader can still lack mutation authority. Hidden callers must
      // receive the same NOT_FOUND as a missing ref, before org authorization.
      if (principal === 'platformAdmin' && operation === 'updateMemorySubscription') {
        expect(hidden.errors).toBeUndefined();
        expect(hidden.data?.[operation]).toEqual({ id: subscription, memory: { id: memory } });
      } else {
        expect(hidden.errors).toHaveLength(1);
        const hiddenMemory = principal === 'orgReader' || principal === 'outsider';
        expect(hidden.errors?.[0]?.extensions?.code).toBe(hiddenMemory
          ? 'NOT_FOUND'
          : operation === 'createMemorySubscription' ? 'SUBSCRIPTION_REQUIRES_PUBLIC_MEMORY' : 'FORBIDDEN');
        if (!hiddenMemory && operation === 'createMemorySubscription') {
          // #2572: the PUBLIC-only check now carries its own typed code. Pin
          // the reason as well, so an unrelated fault cannot satisfy it.
          expect(hidden.errors?.[0]?.message).toBe('Only public memories can be subscribed to by other organizations');
        }
        if (principal === 'orgReader' || principal === 'outsider') {
          const missing = await query(principal, `mutation($org: String!) { ${operation}(memoryRef: "vendor-2557:missing", orgRef: $org, role: READER) { memory { id } } }`, { org: customer });
          expect(missing.errors?.[0]?.extensions?.code).toBe(hidden.errors?.[0]?.extensions?.code);
        }
        expect(hidden.data).toBeNull();
      }

      // Positive control for an authorized principal on each real mutation.
      if (principal === 'platformAdmin') {
        if (operation === 'createMemorySubscription') {
          await db.memorySubscription.delete({ where: { id: publicSubscription } });
        }
        const allowed = await query(principal, `mutation($memory: String!, $org: String!) { ${operation}(memoryRef: $memory, orgRef: $org, role: READER) { memory { id } } }`, { memory: publicMemory, org: customer });
        expect(allowed.errors).toBeUndefined();
        expect(allowed.data?.[operation]).toEqual({ memory: { id: publicMemory } });
      }
    });
  }
});

describe('#2557 App.organization', () => {
  it.each(principals)('matches the direct organization gate for %s, ignoring eager rows', async principal => {
    const owningOrg = await db.organization.findUniqueOrThrow({ where: { id: vendor } });
    const result = await resolvers.App.organization({ organizationId: vendor, organization: owningOrg }, {}, ctx(principal));
    expect(result?.id ?? null).toBe(principal === 'platformAdmin' ? vendor : null);
    const lazy = await resolvers.App.organization({ organizationId: vendor }, {}, ctx(principal));
    expect(lazy?.id ?? null).toBe(principal === 'platformAdmin' ? vendor : null);
    const direct = await query(principal, 'query($ref: ID!) { organization(ref: $ref) { id } }', { ref: vendor });
    expect(direct.data?.organization).toEqual(principal === 'platformAdmin' ? { id: vendor } : null);
  });

  it('preserves the org for its member, and keeps org-less Apps null even with a supplied preload', async () => {
    await db.orgMember.create({ data: { organizationId: vendor, userId: users.reader, role: 'READER' } });
    const result = await query('reader', 'query($ref: ID!) { app(ref: $ref) { id organization { id policy } } }', { ref: app });
    expect(result.errors).toBeUndefined();
    expect(result.data?.app).toEqual({ id: app, organization: { id: vendor, policy: { secret: 'VENDOR' } } });
    expect(await resolvers.App.organization({ organizationId: null, organization: { id: vendor } }, {}, ctx('platformAdmin'))).toBeNull();
  });
});
