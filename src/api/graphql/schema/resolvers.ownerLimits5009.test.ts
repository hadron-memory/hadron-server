/** #5009 (Billing A7a): ownerLimits, setOwnerLimits, clearOwnerLimits, and the rows' end with their owner. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { approvedMergeProof } from '../../../test/mergeConsent.js';
import { generateId } from '../../../lib/id.js';
import { reloadOwnerDefaultLimitsForTests } from '../../../lib/ownerLimits/defaults.js';
import { OWNER_LIMIT_KEY_LIST, OWNER_LIMIT_KEYS } from '../../../lib/ownerLimits/keys.js';
import { deleteUserAccount } from '../../../controller/operations/deleteUser.js';
import { orgMutations } from './resolvers.mutation.org.js';
import { formatGraphQLError } from '../formatError.js';
import { typeDefs } from './typeDefs.js';
import { resolvers, type Context } from './resolvers.js';

const server = new ApolloServer<Context>({ typeDefs, resolvers, formatError: formatGraphQLError });
interface Result { data?: Record<string, any> | null; errors?: ReadonlyArray<{ message: string; extensions?: Record<string, unknown> }> }
async function gql(query: string, ctx: Partial<Context>, variables?: Record<string, unknown>): Promise<Result> {
  const res = await server.executeOperation({ query, variables }, { contextValue: { db, ...ctx } as Context });
  if (res.body.kind !== 'single') throw new Error('unexpected');
  return res.body.singleResult as Result;
}
const codeOf = (r: Result) => r.errors?.[0]?.extensions?.code ?? null;

const READ = `query($orgRef: String, $userRef: ID) { ownerLimits(orgRef: $orgRef, userRef: $userRef) { key limit used } }`;
const SET = `mutation($input: SetOwnerLimitsInput!) { setOwnerLimits(input: $input) { key limit used } }`;
const CLEAR = `mutation($input: ClearOwnerLimitsInput!) { clearOwnerLimits(input: $input) { key limit used } }`;

let admin: string, orgOwner: string, orgAdmin: string, contributor: string, reader: string, revoked: string, p: string, q: string;
let orgId: string;
const ctxOf = (userId: string, roles: string[] = ['READER']): Partial<Context> => ({ userId, roles: roles as never });
const adminCtx = () => ctxOf(admin, ['ADMIN']);
const src = { sourceType: 'manual', sourceId: 'ticket-1', note: 'test' };
const set = (input: Record<string, unknown>, ctx = adminCtx()) => gql(SET, ctx, { input: { ...src, ...input } });
const clear = (input: Record<string, unknown>, ctx = adminCtx()) => gql(CLEAR, ctx, { input: { ...src, ...input } });
const row = (r: Result, field: string, key: string) => r.data?.[field].find((x: { key: string }) => x.key === key);
const keysOf = async (where: Record<string, unknown>) => (await db.ownerLimit.findMany({ where })).map((r) => r.key).sort();

beforeEach(async () => {
  await cleanDb(db);
  reloadOwnerDefaultLimitsForTests({});
  const mk = async (name: string, roles: string[] = ['READER']) =>
    (await db.user.create({ data: { id: generateId(), handle: name, email: `${name}@example.test`, name: `Name ${name}`, roles: roles as never } })).id;
  admin = await mk('ol-admin', ['ADMIN']);
  [orgOwner, orgAdmin, contributor, reader, revoked, p, q] = await Promise.all(
    ['ol-orgowner', 'ol-orgadmin', 'ol-contrib', 'ol-reader', 'ol-revoked', 'ol-p', 'ol-q'].map((n) => mk(n)));
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'olr', urn: 'olr-org' } })).id;
  for (const [userId, role, deletedAt] of [
    [orgOwner, 'OWNER', null], [orgAdmin, 'ADMIN', null], [contributor, 'CONTRIBUTOR', null], [reader, 'READER', null], [revoked, 'ADMIN', new Date()],
  ] as const) await db.orgMember.create({ data: { organizationId: orgId, userId, role, deletedAt } });
});
afterEach(() => { vi.restoreAllMocks(); reloadOwnerDefaultLimitsForTests({ OWNER_DEFAULT_LIMITS: '' }); });

describe('#5009 ownerLimits', () => {
  it('reports one row per registry key with the effective limit and the amount used', async () => {
    reloadOwnerDefaultLimitsForTests({ OWNER_DEFAULT_LIMITS: '{"organization":{"nodes":10}}' });
    const m = await db.memory.create({ data: { id: generateId(), name: 'm', urn: 'olr-org:m', class: 'knowledge', organizationId: orgId } });
    await db.node.create({ data: { id: generateId(), memoryId: m.id, loc: 'n', name: 'n' } });
    const read = () => gql(READ, ctxOf(orgAdmin), { orgRef: orgId });
    const first = await read();
    expect(first.errors).toBeUndefined();
    expect(first.data!.ownerLimits.map((x: { key: string }) => x.key)).toEqual([...OWNER_LIMIT_KEY_LIST]);
    expect(row(first, 'ownerLimits', 'nodes')).toEqual({ key: 'nodes', limit: '10', used: '1' });
    expect(row(first, 'ownerLimits', 'memories')).toEqual({ key: 'memories', limit: null, used: '1' });
    await set({ orgRef: 'hrn:org:olr-org', limits: [{ key: 'nodes', limit: '9223372036854775807' }] });
    expect(row(await read(), 'ownerLimits', 'nodes').limit).toBe('9223372036854775807');
    await set({ orgRef: orgId, limits: [{ key: 'nodes', limit: null }] });
    expect(row(await read(), 'ownerLimits', 'nodes').limit).toBeNull();
    await clear({ orgRef: orgId, keys: ['nodes'] });
    expect(row(await read(), 'ownerLimits', 'nodes').limit).toBe('10');
  });

  it('who may read an organization', async () => {
    for (const ctx of [adminCtx(), ctxOf(orgOwner), ctxOf(orgAdmin)]) expect(codeOf(await gql(READ, ctx, { orgRef: orgId }))).toBeNull();
    const impersonated = { ...ctxOf(orgAdmin, []), impersonation: { orgId: generateId() } } as unknown as Partial<Context>;
    for (const ctx of [ctxOf(contributor), ctxOf(reader), ctxOf(revoked), ctxOf(p), { roles: [] }, { appId: 'a', appKeyId: 'k', roles: [] }, impersonated]) {
      expect(codeOf(await gql(READ, ctx as Partial<Context>, { orgRef: orgId }))).toBe('FORBIDDEN');
    }
  });

  it('who may read a person', async () => {
    const own = ctxOf(p);
    for (const ctx of [adminCtx(), own, { ...own, appId: 'selected-app' }]) expect(codeOf(await gql(READ, ctx, { userRef: p }))).toBeNull();
    expect(codeOf(await gql(READ, own, { userRef: 'hrn:user:ol-p' }))).toBeNull();
    const refused: Array<[string, Partial<Context>, string]> = [
      ['another person', own, q],
      ['an unknown person', own, generateId()],
      ['an unknown handle', own, 'hrn:user:nobody-here'],
      ['a ref that names nothing', own, 'a:b:c'],
      ['an unstorable ref', own, 'a\u0000b'],
      ['an org admin of nobody', ctxOf(orgAdmin), p],
      ['an App key', { appId: 'a', appKeyId: 'k', roles: [] }, p],
      ['an App key that carries a user', { ...own, appId: 'a', appKeyId: 'k' }, p],
      ['an impersonated session', { ...ctxOf(p, []), impersonation: { orgId } } as unknown as Partial<Context>, p],
      ['a headless run on their behalf', { ...ctxOf(p, []), appId: 'a', clientId: 'run:r1' }, p],
      ['nobody', { roles: [] }, p],
    ];
    const answers = new Set<string>();
    for (const [name, ctx, userRef] of refused) {
      const r = await gql(READ, ctx, { userRef });
      expect(codeOf(r), name).toBe('FORBIDDEN');
      answers.add(JSON.stringify([r.errors![0].message, r.errors![0].extensions!.code]));
    }
    expect(answers.size).toBe(1);
    expect(codeOf(await gql(READ, adminCtx(), { userRef: generateId() }))).toBe('USER_NOT_FOUND');
    await db.user.update({ where: { id: p }, data: { deletedAt: new Date() } });
    expect(codeOf(await gql(READ, own, { userRef: p }))).toBe('FORBIDDEN');
  });

  it('exactly one ref', async () => {
    for (const ctx of [adminCtx(), ctxOf(p), { roles: [] }]) {
      expect(codeOf(await gql(READ, ctx as Partial<Context>, {}))).toBe('BAD_USER_INPUT');
      expect(codeOf(await gql(READ, ctx as Partial<Context>, { orgRef: orgId, userRef: p }))).toBe('BAD_USER_INPUT');
    }
  });
});

describe('#5009 setOwnerLimits and clearOwnerLimits', () => {
  it('upserts: a second set leaves one row with the second value and source', async () => {
    const first = await set({ userRef: p, limits: [{ key: 'nodes', limit: '5' }] });
    expect(row(first, 'setOwnerLimits', 'nodes')).toEqual({ key: 'nodes', limit: '5', used: '0' });
    const before = await db.ownerLimit.findFirstOrThrow();
    await set({ userRef: 'hrn:user:ol-p', limits: [{ key: 'nodes', limit: '7' }], sourceType: 'stripe-subscription', sourceId: 'sub', note: 'two' });
    const rows = await db.ownerLimit.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: before.id, key: 'nodes', limitValue: 7n, ownerUserId: p, organizationId: null,
      sourceType: 'stripe-subscription', sourceId: 'sub', note: 'two', createdBy: admin, updatedBy: admin,
    });
  });

  const three = async () => {
    await set({ orgRef: orgId, limits: [{ key: 'nodes', limit: '1' }], sourceType: 'stripe-subscription' });
    await set({ orgRef: orgId, limits: [{ key: 'apps', limit: '2' }] });
    await set({ userRef: p, limits: [{ key: 'nodes', limit: '1' }], sourceType: 'stripe-subscription' });
  };

  it('replace with onlySourceType deletes only unnamed rows of that source', async () => {
    await three();
    await set({ orgRef: orgId, replace: true, onlySourceType: 'stripe-subscription', limits: [{ key: 'memories', limit: '3' }] });
    expect(await keysOf({ organizationId: orgId })).toEqual(['apps', 'memories']);
    expect(await keysOf({ ownerUserId: p })).toEqual(['nodes']);
  });

  it('replace deletes every unnamed row; without replace none', async () => {
    await three();
    await set({ orgRef: orgId, limits: [{ key: 'memories', limit: '3' }] });
    expect(await keysOf({ organizationId: orgId })).toEqual(['apps', 'memories', 'nodes']);
    await set({ orgRef: orgId, replace: true, limits: [{ key: 'memories', limit: '3' }] });
    expect(await keysOf({ organizationId: orgId })).toEqual(['memories']);
    expect(await keysOf({ ownerUserId: p })).toEqual(['nodes']);
  });

  it('clear: the named keys, all keys, and only one source', async () => {
    await three();
    const r = await clear({ orgRef: orgId, keys: ['nodes'] });
    expect(r.data!.clearOwnerLimits).toHaveLength(OWNER_LIMIT_KEY_LIST.length);
    expect(await keysOf({ organizationId: orgId })).toEqual(['apps']);
    await three();
    await clear({ orgRef: orgId, onlySourceType: 'stripe-subscription' });
    expect(await keysOf({ organizationId: orgId })).toEqual(['apps']);
    await three();
    await clear({ orgRef: orgId, keys: ['nodes', 'apps'], onlySourceType: 'manual' });
    expect(await keysOf({ organizationId: orgId })).toEqual(['nodes']);
    await three();
    await clear({ orgRef: orgId });
    expect(await keysOf({ organizationId: orgId })).toEqual([]);
    expect(await keysOf({ ownerUserId: p })).toEqual(['nodes']);
  });

  it('only a platform admin writes', async () => {
    const impersonatedAdmin = { ...ctxOf(admin, []), impersonation: { orgId } } as unknown as Partial<Context>;
    for (const ctx of [ctxOf(orgOwner), ctxOf(orgAdmin), ctxOf(p), { roles: [] }, { appId: 'a', appKeyId: 'k', roles: [] }, impersonatedAdmin]) {
      for (const ref of [{ orgRef: orgId }, { userRef: p }, { userRef: generateId() }, {}]) {
        expect(codeOf(await set({ ...ref, limits: [{ key: 'nodes', limit: '1' }] }, ctx as Partial<Context>))).toBe('FORBIDDEN');
        expect(codeOf(await clear(ref, ctx as Partial<Context>))).toBe('FORBIDDEN');
      }
    }
    expect(await db.ownerLimit.count()).toBe(0);
  });

  it('a platform admin demoted since sign-in writes nothing', async () => {
    await db.user.update({ where: { id: admin }, data: { roles: ['READER'] } });
    expect(codeOf(await set({ userRef: p, limits: [{ key: 'nodes', limit: '1' }] }))).toBe('FORBIDDEN');
    expect(codeOf(await clear({ userRef: p }))).toBe('FORBIDDEN');
    expect(await db.ownerLimit.count()).toBe(0);
  });

  it.each<[string, Record<string, unknown>]>([
    ['an unknown key', { limits: [{ key: 'nodez', limit: '1' }] }],
    ['an inherited key name', { limits: [{ key: 'toString', limit: '1' }] }],
    ['a negative', { limits: [{ key: 'nodes', limit: '-1' }] }],
    ['a fraction', { limits: [{ key: 'nodes', limit: '1.5' }] }],
    ['a sign', { limits: [{ key: 'nodes', limit: '+5' }] }],
    ['an empty limit', { limits: [{ key: 'nodes', limit: '' }] }],
    ['an int8 overflow', { limits: [{ key: 'nodes', limit: '9223372036854775808' }] }],
    ['a duplicate key', { limits: [{ key: 'nodes', limit: '1' }, { key: 'nodes', limit: '2' }] }],
    ['one bad key among good ones', { limits: [{ key: 'nodes', limit: '1' }, { key: 'nodez', limit: '2' }] }],
    ['both refs', { orgRef: 'x', limits: [{ key: 'nodes', limit: '1' }] }],
    ['neither ref', { userRef: null, limits: [{ key: 'nodes', limit: '1' }] }],
    ['a blank source type', { sourceType: ' ', limits: [{ key: 'nodes', limit: '1' }] }],
    ['a blank source id', { sourceId: '', limits: [{ key: 'nodes', limit: '1' }] }],
    ['a blank note', { note: '\n', limits: [{ key: 'nodes', limit: '1' }] }],
    ['an unstorable note', { note: 'a\u0000b', limits: [{ key: 'nodes', limit: '1' }] }],
    ['onlySourceType without replace', { onlySourceType: 'manual', limits: [{ key: 'nodes', limit: '1' }] }],
    ['a blank onlySourceType', { replace: true, onlySourceType: ' ', limits: [{ key: 'nodes', limit: '1' }] }],
  ])('setOwnerLimits refuses %s and writes no row', async (_name, input) => {
    expect(codeOf(await set({ userRef: p, ...input }))).toBe('BAD_USER_INPUT');
    expect(await db.ownerLimit.count()).toBe(0);
  });

  it.each<[string, Record<string, unknown>]>([
    ['an unknown key', { keys: ['nodez'] }],
    ['an inherited key name', { keys: ['toString'] }],
    ['an empty key list, which is not every key', { keys: [] }],
    ['a duplicate key', { keys: ['nodes', 'nodes'] }],
    ['both refs', { orgRef: 'x' }],
    ['neither ref', { userRef: null }],
    ['a blank note', { note: '' }],
    ['a blank source type', { sourceType: '' }],
    ['a blank source id', { sourceId: ' ' }],
    ['a blank onlySourceType', { onlySourceType: '' }],
  ])('clearOwnerLimits refuses %s and deletes nothing', async (_name, input) => {
    await set({ userRef: p, limits: [{ key: 'nodes', limit: '1' }] });
    expect(codeOf(await clear({ userRef: p, ...input }))).toBe('BAD_USER_INPUT');
    expect(await db.ownerLimit.count()).toBe(1);
  });

  it('refuses a key the registry reports but does not let anyone set', async () => {
    const entry = OWNER_LIMIT_KEYS.apps as { settable: boolean };
    entry.settable = false;
    try {
      expect(codeOf(await set({ userRef: p, limits: [{ key: 'apps', limit: '1' }] }))).toBe('BAD_USER_INPUT');
    } finally { entry.settable = true; }
  });

  it('a deleted owner gets no row, also when the deletion commits while the write waits', async () => {
    await db.organization.update({ where: { id: orgId }, data: { deletedAt: new Date() } });
    expect(codeOf(await set({ orgRef: orgId, limits: [{ key: 'nodes', limit: '1' }] }))).toBe('ORGANIZATION_NOT_FOUND');
    await db.user.update({ where: { id: q }, data: { deletedAt: new Date() } });
    expect(codeOf(await set({ userRef: q, limits: [{ key: 'nodes', limit: '1' }] }))).toBe('USER_NOT_FOUND');
    let pending!: Promise<Result>;
    await db.$transaction(async (tx) => {
      await tx.user.update({ where: { id: p }, data: { deletedAt: new Date() } });
      pending = set({ userRef: p, limits: [{ key: 'nodes', limit: '1' }] });
      for (const until = Date.now() + 8_000; Date.now() < until;) {
        const [{ n }] = await db.$queryRaw<Array<{ n: bigint }>>`
          SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%FROM users%FOR SHARE%'`;
        if (n > 0n) return;
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error('the write never waited on the owner row');
    }, { timeout: 20_000 });
    expect(codeOf(await pending)).toBe('FORBIDDEN');
    expect(await db.ownerLimit.count()).toBe(0);
  });

  it('two concurrent sets of one key leave one row', async () => {
    const rs = await Promise.all(['1', '2', '3', '4'].map((limit) => set({ userRef: p, limits: [{ key: 'nodes', limit }] })));
    expect(rs.map(codeOf)).toEqual([null, null, null, null]);
    expect(await db.ownerLimit.count()).toBe(1);
  });
});

describe('#5009 the change log', () => {
  const lines = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((c) => String(c[0]))
    .filter((l) => l.includes('owner.limits.changed')).map((l) => JSON.parse(l) as Record<string, unknown>);
  const spyLog = () => vi.spyOn(console, 'log').mockImplementation(() => {});

  it('one line per changed key with no personal data; an unchanged set writes none', async () => {
    const spy = spyLog();
    await set({ userRef: p, limits: [{ key: 'nodes', limit: '5' }, { key: 'apps', limit: null }], note: 'for Name ol-p' });
    expect(lines(spy).sort((a, b) => String(a.key).localeCompare(String(b.key)))).toEqual([
      { event: 'owner.limits.changed', actorId: admin, ownerType: 'user', ownerId: p, key: 'apps', oldLimit: 'none', newLimit: 'unlimited', sourceType: 'manual', sourceId: 'ticket-1' },
      { event: 'owner.limits.changed', actorId: admin, ownerType: 'user', ownerId: p, key: 'nodes', oldLimit: 'none', newLimit: '5', sourceType: 'manual', sourceId: 'ticket-1' },
    ]);
    for (const [l] of spy.mock.calls) expect(String(l)).not.toMatch(/ol-p|example\.test/);
    spy.mockClear();
    await set({ userRef: p, limits: [{ key: 'nodes', limit: '5' }], sourceId: 'ticket-2' });
    expect(lines(spy)).toEqual([]);
    await set({ userRef: p, limits: [{ key: 'nodes', limit: '6' }], replace: true });
    expect(lines(spy).map((l) => [l.key, l.oldLimit, l.newLimit])).toEqual([['nodes', '5', '6'], ['apps', 'unlimited', 'none']]);
    spy.mockClear();
    await clear({ userRef: p });
    expect(lines(spy).map((l) => [l.key, l.oldLimit, l.newLimit])).toEqual([['nodes', '6', 'none']]);
  });

  it('a refused write logs nothing', async () => {
    const spy = spyLog();
    await set({ userRef: p, limits: [{ key: 'nodez', limit: '5' }] });
    expect(lines(spy)).toEqual([]);
  });
});

describe('#5009 the rows end with their owner', () => {
  const lines = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((c) => String(c[0]))
    .filter((l) => l.includes('owner.limits.changed')).map((l) => JSON.parse(l) as Record<string, unknown>);
  const seed = async () => {
    await set({ orgRef: orgId, limits: [{ key: 'nodes', limit: '1' }] });
    await set({ userRef: p, limits: [{ key: 'nodes', limit: '2' }] });
    await set({ userRef: q, limits: [{ key: 'nodes', limit: '3' }, { key: 'apps', limit: '4' }] });
  };

  it('deleteOrganization', async () => {
    await seed();
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await orgMutations.deleteOrganization({}, { ref: orgId }, { db, ...adminCtx() } as Context);
    expect(await db.ownerLimit.count({ where: { organizationId: orgId } })).toBe(0);
    expect(await db.ownerLimit.count()).toBe(3);
    expect(lines(spy)).toEqual([{
      event: 'owner.limits.changed', actorId: admin, ownerType: 'organization', ownerId: orgId, key: 'nodes', oldLimit: '1', newLimit: 'none', reason: 'owner-deleted',
    }]);
  });

  it('deleteUser, with the organizations that go with the account', async () => {
    await seed();
    const solo = (await db.organization.create({ data: { id: generateId(), name: 'solo', urn: 'olr-solo' } })).id;
    await db.orgMember.create({ data: { organizationId: solo, userId: p, role: 'OWNER' } });
    await set({ orgRef: solo, limits: [{ key: 'apps', limit: '9' }] });
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await deleteUserAccount(db, { targetUserId: p, actorUserId: p });
    expect(await db.ownerLimit.count({ where: { OR: [{ ownerUserId: p }, { organizationId: solo }] } })).toBe(0);
    expect(await db.ownerLimit.count()).toBe(3);
    expect(lines(spy).map((l) => [l.ownerId, l.key, l.reason, l.actorId]).sort()).toEqual(
      [[p, 'nodes', 'owner-deleted', p], [solo, 'apps', 'owner-deleted', p]].sort());
  });

  /** Hold the person's authority anchor, start `act`, prove it waits there, then commit a limit row it cannot see. */
  async function rowDuringWait(act: () => Promise<unknown>) {
    let running!: Promise<unknown>;
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtext('authorization:user'), hashtext(${p}))`;
      running = act();
      running.catch(() => {});
      for (const until = Date.now() + 8_000; ;) {
        const [{ n }] = await db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted
          AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`;
        if (n > 0n) break;
        if (Date.now() > until) throw new Error('the operation never waited');
        await new Promise((r) => setTimeout(r, 5));
      }
      await tx.ownerLimit.create({ data: { id: generateId(), ownerUserId: p, key: 'nodes', limitValue: 1n, sourceType: 's', sourceId: 'i', note: 'n' } });
    }, { timeout: 20_000 });
    await running;
    expect(await db.ownerLimit.count({ where: { ownerUserId: p } })).toBe(0);
  }

  it('deleteUser also removes a row that committed while the deletion waited', () =>
    rowDuringWait(() => deleteUserAccount(db, { targetUserId: p, actorUserId: p })));

  it('mergeUsers also removes a row that committed while the merge waited', async () => {
    const consentProof = await approvedMergeProof(db, p, q, admin);
    await rowDuringWait(async () =>
      orgMutations.mergeUsers({}, { input: { source: p, target: q, consentProof } }, { db, ...adminCtx() } as Context));
  });

  it('mergeUsers keeps the survivor rows and removes the other account rows', async () => {
    await seed();
    const consentProof = await approvedMergeProof(db, p, q, admin);
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await orgMutations.mergeUsers({}, { input: { source: p, target: q, consentProof } }, { db, ...adminCtx() } as Context);
    expect((await db.ownerLimit.findMany({ where: { ownerUserId: q } })).map((r) => [r.key, r.limitValue]).sort()).toEqual([['apps', 4n], ['nodes', 3n]]);
    expect(await db.ownerLimit.count({ where: { ownerUserId: p } })).toBe(0);
    expect(lines(spy)).toEqual([{
      event: 'owner.limits.changed', actorId: admin, ownerType: 'user', ownerId: p, key: 'nodes', oldLimit: '2', newLimit: 'none', reason: 'account-merge',
    }]);
  });

  it('mergeUsers moves the audit stamps of rows the merged person wrote', async () => {
    await set({ orgRef: orgId, limits: [{ key: 'nodes', limit: '1' }] });
    await db.ownerLimit.updateMany({ data: { createdBy: p, updatedBy: p } });
    const consentProof = await approvedMergeProof(db, p, q, admin);
    await orgMutations.mergeUsers({}, { input: { source: p, target: q, consentProof } }, { db, ...adminCtx() } as Context);
    expect(await db.ownerLimit.findFirstOrThrow()).toMatchObject({ createdBy: q, updatedBy: q });
  });
});
