/**
 * #2984 — inviteUser and createUserInvitation refuse out-of-range expiresInDays / maxActivations with a typed
 * BAD_USER_INPUT (cor:api:260:01) instead of an INTERNAL_SERVER_ERROR from `new Date(...)` (Holger V49: expiresInDays
 * 1-10, default 10; maxActivations 2-1000, default 2; 0 and an explicit 1 refused).
 * Answers are read off the GraphQL wire (ApolloServer + formatGraphQLError), as the issue's acceptance asks.
 */
import { ApolloServer } from '@apollo/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { formatGraphQLError } from '../formatError.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

const graphql = new ApolloServer<Context>({ typeDefs, resolvers, formatError: formatGraphQLError });

type Answer = { data: any; error: { message: string; extensions: Record<string, unknown> } | null };

async function ask(c: Context, query: string, variables: Record<string, unknown>): Promise<Answer> {
  const res = await graphql.executeOperation({ query, variables }, { contextValue: c });
  if (res.body.kind !== 'single') throw new Error('unexpected incremental response');
  const { data, errors } = res.body.singleResult;
  const e = errors?.[0];
  const { stacktrace: _drop, ...extensions } = (e?.extensions ?? {}) as Record<string, unknown>;
  return { data: data ? Object.values(data)[0] ?? null : null, error: e ? { message: e.message, extensions } : null };
}

const INVITE_USER = `mutation($e: Int, $m: Int) { inviteUser(expiresInDays: $e, maxActivations: $m) { id expiresAt maxActivations } }`;
const INVITE_ORG = `mutation($o: ID!, $e: Int, $m: Int) { createUserInvitation(orgId: $o, memberRole: READER, expiresInDays: $e, maxActivations: $m) { id expiresAt maxActivations } }`;

let adminId: string;
let readerId: string;
let orgId: string;

const ctx = (userId: string): Context => ({ db, userId, roles: ['READER'] }) as Context;
const DAY = 24 * 60 * 60 * 1000;

type Wire = { name: string; run: (userId: string, args: { e?: number | null; m?: number | null }) => Promise<Answer> };
const wires: Wire[] = [
  { name: 'inviteUser', run: (u, { e, m }) => ask(ctx(u), INVITE_USER, { e, m }) },
  { name: 'createUserInvitation', run: (u, { e, m }) => ask(ctx(u), INVITE_ORG, { o: orgId, e, m }) },
];

afterEach(() => vi.restoreAllMocks());

beforeEach(async () => {
  await cleanDb(db);
  const users = await Promise.all([1, 2].map((n) => db.user.create({
    data: { id: generateId(), githubId: 298400 + n, githubUsername: `invite-limits-${n}-${generateId()}` },
  })));
  [adminId, readerId] = users.map((u) => u.id);
  orgId = (await db.organization.create({
    data: { id: generateId(), urn: `invite-limits-${generateId()}`, name: 'Invite limits org' },
  })).id;
  await db.orgMember.createMany({ data: [
    { id: generateId(), organizationId: orgId, userId: adminId, role: 'ADMIN' },
    { id: generateId(), organizationId: orgId, userId: readerId, role: 'READER' },
  ] });
});

describe.each(wires)('#2984 $name limits', ({ run }) => {
  const refused: Array<[string, { e?: number; m?: number }, RegExp]> = [
    ['expiresInDays 99999999', { e: 99999999 }, /expiresInDays/],
    ['expiresInDays 11', { e: 11 }, /expiresInDays/],
    ['expiresInDays 0', { e: 0 }, /expiresInDays/],
    ['expiresInDays -1', { e: -1 }, /expiresInDays/],
    ['maxActivations 1001', { m: 1001 }, /maxActivations/],
    ['maxActivations 1', { m: 1 }, /maxActivations/],
    ['maxActivations 0', { m: 0 }, /maxActivations/],
    ['maxActivations -1', { m: -1 }, /maxActivations/],
  ];

  it.each(refused)('%s is a typed BAD_USER_INPUT naming the argument and range, no requestId, no row', async (_n, args, named) => {
    const fault = vi.spyOn(console, 'error').mockImplementation(() => {});
    const before = await db.userInvitation.count();
    const a = await run(adminId, args);
    expect(a.error?.extensions.code).toBe('BAD_USER_INPUT');
    expect(a.error?.extensions).not.toHaveProperty('requestId');
    expect(a.error?.message).toMatch(named);
    expect(a.error?.message).toMatch(/\d+ to \d+/);
    expect(a.data).toBeNull();
    expect(await db.userInvitation.count()).toBe(before);
    expect(fault).not.toHaveBeenCalledWith('[graphql] internal_fault', expect.anything());
  });

  it('the boundaries still create: expiresInDays 1 and 10, maxActivations 2 and 1000', async () => {
    for (const [e, m] of [[1, 2], [10, 1000]] as const) {
      const a = await run(adminId, { e, m });
      expect(a.error).toBeNull();
      expect(a.data.maxActivations).toBe(m);
      expect(Math.abs(new Date(a.data.expiresAt).getTime() - (Date.now() + e * DAY))).toBeLessThan(5000);
    }
  });

  it('both omitted, and both null, give a 10-day expiry and two activations', async () => {
    for (const args of [{}, { e: null, m: null }]) {
      const a = await run(adminId, args);
      expect(a.error).toBeNull();
      expect(Math.abs(new Date(a.data.expiresAt).getTime() - (Date.now() + 10 * DAY))).toBeLessThan(5000);
      expect(a.data.maxActivations).toBe(2);
    }
  });

  it('an invitation row written before the ruling (null expiry, one activation) is untouched', async () => {
    const old = await db.userInvitation.create({ data: { id: generateId(), slug: generateId(), maxActivations: 1, expiresAt: null } });
    await run(adminId, {});
    const row = await db.userInvitation.findUniqueOrThrow({ where: { id: old.id } });
    expect(row.expiresAt).toBeNull();
    expect(row.maxActivations).toBe(1);
  });
});

describe('#2984 the org role gate is not turned into an oracle', () => {
  it('a non-admin gets the same refusal for an out-of-range value as for a valid one, and no row', async () => {
    const before = await db.userInvitation.count();
    const valid = await ask(ctx(readerId), INVITE_ORG, { o: orgId, e: 5, m: 3 });
    const bad = await ask(ctx(readerId), INVITE_ORG, { o: orgId, e: 99999999, m: 5000 });
    expect(valid.error).not.toBeNull();
    expect(valid.error?.extensions.code).not.toBe('BAD_USER_INPUT');
    expect(bad.error).toEqual(valid.error);
    expect(await db.userInvitation.count()).toBe(before);
  });

  it('inviteUser signed out is UNAUTHENTICATED whatever the values', async () => {
    const res = await graphql.executeOperation(
      { query: INVITE_USER, variables: { e: 99999999, m: 5000 } },
      { contextValue: { db, roles: [] } as unknown as Context },
    );
    if (res.body.kind !== 'single') throw new Error('unexpected incremental response');
    expect(res.body.singleResult.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
  });
});
