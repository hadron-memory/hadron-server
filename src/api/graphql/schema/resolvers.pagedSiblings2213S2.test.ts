/**
 * #2213 S2 — the authority / inventory list pages (`appKeysPage`,
 * `myUserApiKeysPage`, `myAgentSubscriptionsPage`, `agentSubscriptionsPage`),
 * additive siblings of the four unpaged lists. Spec:
 * hrn:node:hadronmemory.com:specs:cor:api:120:04 (and :02 for the envelope).
 *
 * What this file pins, per field:
 *   - 25 rows paged at 7 cover every row once, in the old field's order, with
 *     `hasMore` false on the last page; the size edges of `pageArgs`.
 *   - Each refusal is the old field's refusal, code AND message, so a refused
 *     caller learns nothing from `total`.
 *   - `total` counts the same `where` as the items: revoked app keys out of both,
 *     hidden user keys only with `includeHidden`, another tenant's rows in neither.
 *   - Rows sharing one `createdAt` page with no repeat or gap (the tiebreak:
 *     `id` for keys, the other half of the composite key for subscriptions).
 *   - Count and page run in one RepeatableRead batch with database take/skip.
 *   - The old fields still return the complete set above 20, in the same order.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { typeDefs } from './typeDefs.js';
import { resolvers, type Context } from './resolvers.js';

const Q = resolvers.Query as any;
const server = new ApolloServer<Context>({ typeDefs, resolvers });

async function gql(query: string, ctx: Partial<Context>) {
  const res = await server.executeOperation({ query }, { contextValue: { db, ...ctx } as Context });
  if (res.body.kind !== 'single') throw new Error('unexpected');
  return res.body.singleResult;
}

/** The refusal a call ends in, as `{ code, message }`, or null when it resolves. */
async function refusal(p: Promise<unknown>): Promise<{ code: unknown; message: string } | null> {
  try { await p; } catch (e) {
    const err = e as GraphQLError;
    return { code: err.extensions?.code, message: err.message };
  }
  return null;
}

const ONE_INSTANT = new Date('2026-01-01T00:00:00Z');
const imp = (actorUserId: string): Partial<Context> => ({
  impersonation: { sessionId: generateId(), actorUserId, orgId: generateId(), expiresAt: new Date(Date.now() + 60_000) } as never,
});

/** Walk every page at `size`, checking total and hasMore on each, and return the rows in order. */
async function walk<T>(read: (offset: number) => Promise<{ items: T[]; total: number; hasMore: boolean }>, expectedTotal: number, size: number): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; offset < expectedTotal; offset += size) {
    const p = await read(offset);
    expect(p.total).toBe(expectedTotal);
    expect(p.hasMore).toBe(offset + p.items.length < expectedTotal);
    out.push(...p.items);
  }
  const past = await read(expectedTotal);
  expect(past).toEqual({ items: [], total: expectedTotal, hasMore: false });
  return out;
}

async function sizeEdges(read: (args: Record<string, unknown>) => Promise<{ items: unknown[]; total: number; hasMore: boolean }>, total: number) {
  expect((await read({})).items).toHaveLength(Math.min(20, total));
  expect((await read({ limit: null, offset: null })).items).toHaveLength(Math.min(20, total));
  expect(await read({ limit: 0 })).toEqual({ items: [], total, hasMore: total > 0 });
  expect(await read({ limit: -3 })).toEqual({ items: [], total, hasMore: total > 0 });
  const capped = await read({ limit: 100_000 });
  expect(capped.items).toHaveLength(Math.min(200, total));
  const negOffset = await read({ limit: 2, offset: -9 });
  expect(negOffset.items).toEqual((await read({ limit: 2, offset: 0 })).items);
}

// ── appKeysPage ────────────────────────────────────────────────────────────

describe('appKeysPage', () => {
  let users: Record<string, string>;
  let appId: string;
  let otherAppId: string;
  const ctx = (name: string, extra: Partial<Context> = {}): Context => ({ db, userId: users[name], roles: ['READER'], ...extra });

  async function seedKeys(target: string, n: number, over: Record<string, unknown> = {}) {
    await db.appKey.createMany({
      data: Array.from({ length: n }, () => ({ id: generateId(), appId: target, keyHash: generateId(), keyPreview: 'test', createdAt: ONE_INSTANT, ...over })),
    });
  }

  beforeEach(async () => {
    await cleanDb(db);
    users = {};
    for (const name of ['owner', 'member', 'admin', 'outsider']) {
      users[name] = (await db.user.create({ data: { id: generateId(), handle: `k2-${generateId()}`, roles: ['READER'] } })).id;
    }
    const org = await db.organization.create({ data: { urn: `k2-${generateId()}`, name: 'Keys S2' } });
    await db.orgMember.create({ data: { organizationId: org.id, userId: users.admin!, role: 'ADMIN' } });
    appId = (await db.app.create({ data: { urn: `${org.urn}:a`, name: 'A', organizationId: org.id } })).id;
    otherAppId = (await db.app.create({ data: { urn: `${org.urn}:b`, name: 'B', organizationId: org.id } })).id;
    await db.appMember.create({ data: { appId, userId: users.owner!, role: 'owner' } });
    await db.appMember.create({ data: { appId, userId: users.member!, role: 'member' } });
  });

  afterEach(() => vi.restoreAllMocks());

  it('25 keys paged at 7 cover every key once, in the old field\'s order, all on one createdAt', async () => {
    await seedKeys(appId, 25);
    const old = await Q.appKeys({}, { appRef: appId }, ctx('admin'));
    expect(old).toHaveLength(25);
    const seen = await walk((offset) => Q.appKeysPage({}, { appRef: appId, limit: 7, offset }, ctx('admin')), 25, 7);
    expect(seen.map((k: any) => k.id)).toEqual(old.map((k: any) => k.id));
    expect(new Set(seen.map((k: any) => k.id)).size).toBe(25);
  });

  it('the old field orders newest first, then by id descending on a tie', async () => {
    await seedKeys(appId, 6);
    await seedKeys(appId, 2, { createdAt: new Date('2026-02-01T00:00:00Z') });
    const old = await Q.appKeys({}, { appRef: appId }, ctx('admin'));
    const expected = [...old].sort((a: any, b: any) => (b.createdAt - a.createdAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    expect(old.map((k: any) => k.id)).toEqual(expected.map((k: any) => k.id));
  });

  it('size edges', async () => {
    await seedKeys(appId, 205);
    await sizeEdges((a) => Q.appKeysPage({}, { appRef: appId, ...a }, ctx('admin')), 205);
  });

  it('revoked keys and another App\'s keys are in neither items nor total', async () => {
    await seedKeys(appId, 3);
    await seedKeys(appId, 2, { revokedAt: new Date() });
    await seedKeys(otherAppId, 4);
    const p = await Q.appKeysPage({}, { appRef: appId, limit: 50 }, ctx('admin'));
    expect(p.total).toBe(3);
    expect(p.items).toHaveLength(3);
    expect(p.items.every((k: any) => k.appId === appId && k.revokedAt === null)).toBe(true);
  });

  it('every refusal is the old field\'s refusal, code and message', async () => {
    await seedKeys(appId, 3);
    const cases: [string, () => Context, (() => Promise<unknown>) | null][] = [
      ['plain member', () => ctx('member'), null],
      ['outsider', () => ctx('outsider'), null],
      ['impersonated admin', () => ctx('admin', imp(users.owner!)), null],
      ['the App\'s own key', () => ({ db, appId, roles: [] } as Context), null],
    ];
    for (const [label, c] of cases) {
      const old = await refusal(Q.appKeys({}, { appRef: appId }, c()));
      expect(old, label).not.toBeNull();
      expect(await refusal(Q.appKeysPage({}, { appRef: appId }, c())), label).toEqual(old);
      expect(await refusal(Q.appKeysPage({}, { appRef: appId, limit: 0 }, c())), label).toEqual(old);
    }
    // A bound worker acting for a manager is refused too (#1744, provisional).
    await runAsActor({ workerId: generateId(), agentId: generateId() }, async () => {
      const old = await refusal(Q.appKeys({}, { appRef: appId }, ctx('admin')));
      expect(old).not.toBeNull();
      expect(await refusal(Q.appKeysPage({}, { appRef: appId }, ctx('admin')))).toEqual(old);
    });
    // An unknown App ref fails the same way on both.
    const unknown = generateId();
    const oldUnknown = await refusal(Q.appKeys({}, { appRef: unknown }, ctx('admin')));
    expect(oldUnknown).not.toBeNull();
    expect(await refusal(Q.appKeysPage({}, { appRef: unknown }, ctx('admin')))).toEqual(oldUnknown);
  });

  it('admits exactly the managers the old field admits', async () => {
    await seedKeys(appId, 2);
    for (const name of ['owner', 'admin']) {
      const p = await Q.appKeysPage({}, { appRef: appId }, ctx(name));
      expect(p.total, name).toBe(2);
    }
    const platformAdmin = (await db.user.create({ data: { id: generateId(), handle: `k2p-${generateId()}`, roles: ['ADMIN'] } })).id;
    const pa: Context = { db, userId: platformAdmin, roles: ['ADMIN'] };
    expect((await Q.appKeysPage({}, { appRef: appId }, pa)).total).toBe((await Q.appKeys({}, { appRef: appId }, pa)).length);
  });

  it('runs count and page in one RepeatableRead batch with database take/skip', async () => {
    await seedKeys(appId, 30);
    const find = vi.spyOn(db.appKey, 'findMany');
    const tx = vi.spyOn(db, '$transaction');
    await Q.appKeysPage({}, { appRef: appId, limit: 10, offset: 5 }, ctx('admin'));
    expect(find).toHaveBeenCalledWith(expect.objectContaining({ take: 10, skip: 5 }));
    expect(tx).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ isolationLevel: 'RepeatableRead' }));
  });

  it('answers over GraphQL with no extensions.warnings; the old field stays whole above 20', async () => {
    await seedKeys(appId, 25);
    const page = await gql(`query { appKeysPage(appRef: "${appId}") { total hasMore items { id } } }`, ctx('admin'));
    expect(page.errors).toBeUndefined();
    expect(page.extensions?.warnings).toBeUndefined();
    expect(page.data!.appKeysPage).toMatchObject({ total: 25, hasMore: true });
    const old = await gql(`query { appKeys(appRef: "${appId}") { id } }`, ctx('admin'));
    expect((old.data!.appKeys as unknown[]).length).toBe(25);
  });
});

// ── myUserApiKeysPage ──────────────────────────────────────────────────────

describe('myUserApiKeysPage', () => {
  let user: string;
  let other: string;
  const ctx = (userId?: string, extra: Partial<Context> = {}): Context => ({ db, userId, roles: ['READER'], ...extra });

  async function seedUserKeys(userId: string, n: number, over: Record<string, unknown> = {}) {
    await db.userApiKey.createMany({
      data: Array.from({ length: n }, () => ({ id: generateId(), userId, keyHash: generateId(), keyPreview: 'test', oauthScopes: [], createdAt: ONE_INSTANT, ...over })),
    });
  }

  beforeEach(async () => {
    await cleanDb(db);
    user = (await db.user.create({ data: { id: generateId(), handle: `u2-${generateId()}` } })).id;
    other = (await db.user.create({ data: { id: generateId(), handle: `u2o-${generateId()}` } })).id;
  });

  afterEach(() => vi.restoreAllMocks());

  it('25 keys paged at 7 cover every key once, in the old field\'s order, all on one createdAt', async () => {
    await seedUserKeys(user, 25);
    const old = await Q.myUserApiKeys({}, {}, ctx(user));
    expect(old).toHaveLength(25);
    const seen = await walk((offset) => Q.myUserApiKeysPage({}, { limit: 7, offset }, ctx(user)), 25, 7);
    expect(seen.map((k: any) => k.id)).toEqual(old.map((k: any) => k.id));
  });

  it('size edges', async () => {
    await seedUserKeys(user, 203);
    await sizeEdges((a) => Q.myUserApiKeysPage({}, a, ctx(user)), 203);
  });

  it('revoked keys stay listed; hidden keys only with includeHidden, in items and total alike; another user\'s keys never', async () => {
    await seedUserKeys(user, 3);
    await seedUserKeys(user, 2, { revokedAt: new Date() });
    await seedUserKeys(user, 4, { revokedAt: new Date(), hiddenAt: new Date() });
    await seedUserKeys(other, 5);
    const visible = await Q.myUserApiKeysPage({}, { limit: 50 }, ctx(user));
    expect(visible.total).toBe(5);
    expect(visible.items.every((k: any) => k.userId === user && k.hiddenAt === null)).toBe(true);
    const all = await Q.myUserApiKeysPage({}, { includeHidden: true, limit: 50 }, ctx(user));
    expect(all.total).toBe(9);
    expect(all.items).toHaveLength(9);
    expect(all.items.map((k: any) => k.id)).toEqual((await Q.myUserApiKeys({}, { includeHidden: true }, ctx(user))).map((k: any) => k.id));
    expect((await Q.myUserApiKeysPage({}, { includeHidden: false, limit: 50 }, ctx(user))).total).toBe(5);
  });

  it('no user and impersonation are refused exactly as the old field refuses them', async () => {
    await seedUserKeys(user, 2);
    for (const [label, c] of [['no user', ctx(undefined)], ['impersonation', ctx(user, imp(other))]] as const) {
      const old = await refusal(Q.myUserApiKeys({}, {}, c));
      expect(old, label).not.toBeNull();
      expect(await refusal(Q.myUserApiKeysPage({}, {}, c)), label).toEqual(old);
      expect(await refusal(Q.myUserApiKeysPage({}, { limit: 0, includeHidden: true }, c)), label).toEqual(old);
    }
  });

  it('runs count and page in one RepeatableRead batch with database take/skip', async () => {
    await seedUserKeys(user, 30);
    const find = vi.spyOn(db.userApiKey, 'findMany');
    const tx = vi.spyOn(db, '$transaction');
    await Q.myUserApiKeysPage({}, { limit: 10, offset: 5 }, ctx(user));
    expect(find).toHaveBeenCalledWith(expect.objectContaining({ take: 10, skip: 5 }));
    expect(tx).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ isolationLevel: 'RepeatableRead' }));
  });

  it('answers over GraphQL with no extensions.warnings; the old field stays whole above 20', async () => {
    await seedUserKeys(user, 25);
    const page = await gql(`query { myUserApiKeysPage(includeHidden: false) { total hasMore items { id } } }`, ctx(user));
    expect(page.errors).toBeUndefined();
    expect(page.extensions?.warnings).toBeUndefined();
    expect(page.data!.myUserApiKeysPage).toMatchObject({ total: 25, hasMore: true });
    const old = await gql(`query { myUserApiKeys { id } }`, ctx(user));
    expect((old.data!.myUserApiKeys as unknown[]).length).toBe(25);
  });
});

// ── myAgentSubscriptionsPage / agentSubscriptionsPage ─────────────────────

describe('agent subscription pages', () => {
  let org: { id: string; urn: string };
  let admin: string;
  let reader: string;
  let outsider: string;
  let subscriber: string;
  let agent: { id: string };
  let otherAgent: { id: string };
  const ctx = (userId?: string, extra: Partial<Context> = {}): Context => ({ db, userId, roles: ['READER'], ...extra });

  async function newUser(prefix: string) {
    return (await db.user.create({ data: { id: generateId(), handle: `${prefix}-${generateId()}` } })).id;
  }
  async function newAgent(name: string) {
    return db.agent.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:${name}`, name, type: 'CHATBOT', surfaces: ['api'] } });
  }
  /** n subscribers to one agent, all on one createdAt. */
  async function seedSubscribers(agentId: string, n: number) {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) ids.push(await newUser('sub'));
    // Inserted in descending id order, so a tie the query leaves unordered comes back unsorted.
    const rows = [...ids].sort().reverse().map((userId) => ({ userId, agentId, createdAt: ONE_INSTANT }));
    for (const data of rows) await db.agentSubscription.create({ data });
    return ids;
  }
  /** One user subscribed to n agents, all on one createdAt. */
  async function seedSubscriptions(userId: string, n: number) {
    const agents: string[] = [];
    for (let i = 0; i < n; i++) agents.push((await newAgent(`ag-${generateId().slice(-10).toLowerCase()}`)).id);
    // Inserted in descending id order, so a tie the query leaves unordered comes back unsorted.
    const rows = [...agents].sort().reverse().map((agentId) => ({ userId, agentId, createdAt: ONE_INSTANT }));
    for (const data of rows) await db.agentSubscription.create({ data });
    return agents;
  }

  beforeEach(async () => {
    await cleanDb(db);
    org = await db.organization.create({ data: { id: generateId(), name: 's2-org', urn: `s2-org-${generateId()}` } });
    admin = await newUser('adm');
    reader = await newUser('rdr');
    outsider = await newUser('out');
    subscriber = await newUser('me');
    await db.orgMember.create({ data: { organizationId: org.id, userId: admin, role: 'ADMIN' } });
    await db.orgMember.create({ data: { organizationId: org.id, userId: reader, role: 'READER' } });
    agent = await newAgent('main-bot');
    otherAgent = await newAgent('other-bot');
  });

  afterEach(() => vi.restoreAllMocks());

  describe('myAgentSubscriptionsPage', () => {
    it('25 subscriptions paged at 7 cover every row once, in the old field\'s order, all on one createdAt', async () => {
      await seedSubscriptions(subscriber, 25);
      const old = await Q.myAgentSubscriptions({}, {}, ctx(subscriber));
      expect(old).toHaveLength(25);
      const seen = await walk((offset) => Q.myAgentSubscriptionsPage({}, { limit: 7, offset }, ctx(subscriber)), 25, 7);
      expect(seen.map((s: any) => s.agentId)).toEqual(old.map((s: any) => s.agentId));
      expect(new Set(seen.map((s: any) => s.agentId)).size).toBe(25);
    });

    it('the old field breaks a createdAt tie by agentId ascending', async () => {
      await seedSubscriptions(subscriber, 6);
      const old = await Q.myAgentSubscriptions({}, {}, ctx(subscriber));
      const agentIds = old.map((s: any) => s.agentId);
      expect(agentIds).toEqual([...agentIds].sort());
    });

    it('size edges', async () => {
      await seedSubscriptions(subscriber, 21);
      await sizeEdges((a) => Q.myAgentSubscriptionsPage({}, a, ctx(subscriber)), 21);
    });

    it('another user\'s subscriptions are in neither items nor total', async () => {
      await seedSubscriptions(subscriber, 2);
      await seedSubscribers(agent.id, 3);
      const p = await Q.myAgentSubscriptionsPage({}, { limit: 50 }, ctx(subscriber));
      expect(p.total).toBe(2);
      expect(p.items.every((s: any) => s.userId === subscriber)).toBe(true);
    });

    it('no user, or an impersonated caller, gets the empty page where the old field gives []', async () => {
      await seedSubscriptions(subscriber, 3);
      const empty = { items: [], total: 0, hasMore: false };
      for (const c of [ctx(undefined), ctx(subscriber, imp(admin))]) {
        expect(await Q.myAgentSubscriptions({}, {}, c)).toEqual([]);
        expect(await Q.myAgentSubscriptionsPage({}, {}, c)).toEqual(empty);
        expect(await Q.myAgentSubscriptionsPage({}, { limit: 0 }, c)).toEqual(empty);
      }
    });

    it('runs count and page in one RepeatableRead batch with database take/skip', async () => {
      await seedSubscriptions(subscriber, 12);
      const find = vi.spyOn(db.agentSubscription, 'findMany');
      const tx = vi.spyOn(db, '$transaction');
      await Q.myAgentSubscriptionsPage({}, { limit: 4, offset: 3 }, ctx(subscriber));
      expect(find).toHaveBeenCalledWith(expect.objectContaining({ take: 4, skip: 3 }));
      expect(tx).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ isolationLevel: 'RepeatableRead' }));
    });

    it('answers over GraphQL with no extensions.warnings', async () => {
      await seedSubscriptions(subscriber, 22);
      const page = await gql(`query { myAgentSubscriptionsPage { total hasMore items { agentId } } }`, ctx(subscriber));
      expect(page.errors).toBeUndefined();
      expect(page.extensions?.warnings).toBeUndefined();
      expect(page.data!.myAgentSubscriptionsPage).toMatchObject({ total: 22, hasMore: true });
      const old = await gql(`query { myAgentSubscriptions { agentId } }`, ctx(subscriber));
      expect((old.data!.myAgentSubscriptions as unknown[]).length).toBe(22);
    });
  });

  describe('agentSubscriptionsPage', () => {
    it('25 subscribers paged at 7 cover every row once, in the old field\'s order, all on one createdAt', async () => {
      await seedSubscribers(agent.id, 25);
      const old = await Q.agentSubscriptions({}, { agentRef: agent.id }, ctx(admin));
      expect(old).toHaveLength(25);
      const seen = await walk((offset) => Q.agentSubscriptionsPage({}, { agentRef: agent.id, limit: 7, offset }, ctx(admin)), 25, 7);
      expect(seen.map((s: any) => s.userId)).toEqual(old.map((s: any) => s.userId));
      expect(new Set(seen.map((s: any) => s.userId)).size).toBe(25);
    });

    it('the old field breaks a createdAt tie by userId ascending', async () => {
      await seedSubscribers(agent.id, 6);
      const old = await Q.agentSubscriptions({}, { agentRef: agent.id }, ctx(admin));
      const userIds = old.map((s: any) => s.userId);
      expect(userIds).toEqual([...userIds].sort());
    });

    it('size edges', async () => {
      await seedSubscribers(agent.id, 21);
      await sizeEdges((a) => Q.agentSubscriptionsPage({}, { agentRef: agent.id, ...a }, ctx(admin)), 21);
    });

    it('another agent\'s subscribers are in neither items nor total', async () => {
      await seedSubscribers(agent.id, 2);
      await seedSubscribers(otherAgent.id, 3);
      const p = await Q.agentSubscriptionsPage({}, { agentRef: agent.id, limit: 50 }, ctx(admin));
      expect(p.total).toBe(2);
      expect(p.items.every((s: any) => s.agentId === agent.id)).toBe(true);
    });

    it('every refusal is the old field\'s refusal, code and message', async () => {
      await seedSubscribers(agent.id, 2);
      const cases: [string, Context, string][] = [
        ['org reader (not ADMIN)', ctx(reader), agent.id],
        ['outsider (agent unreadable)', ctx(outsider), agent.id],
        ['unknown agent', ctx(admin), generateId()],
        ['no user', ctx(undefined), agent.id],
      ];
      for (const [label, c, ref] of cases) {
        const old = await refusal(Q.agentSubscriptions({}, { agentRef: ref }, c));
        expect(old, label).not.toBeNull();
        expect(await refusal(Q.agentSubscriptionsPage({}, { agentRef: ref }, c)), label).toEqual(old);
        expect(await refusal(Q.agentSubscriptionsPage({}, { agentRef: ref, limit: 0 }, c)), label).toEqual(old);
      }
    });

    it('runs count and page in one RepeatableRead batch with database take/skip', async () => {
      await seedSubscribers(agent.id, 12);
      const find = vi.spyOn(db.agentSubscription, 'findMany');
      const tx = vi.spyOn(db, '$transaction');
      await Q.agentSubscriptionsPage({}, { agentRef: agent.id, limit: 4, offset: 3 }, ctx(admin));
      expect(find).toHaveBeenCalledWith(expect.objectContaining({ take: 4, skip: 3 }));
      expect(tx).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ isolationLevel: 'RepeatableRead' }));
    });

    it('answers over GraphQL with no extensions.warnings', async () => {
      await seedSubscribers(agent.id, 22);
      const page = await gql(`query { agentSubscriptionsPage(agentRef: "${agent.id}") { total hasMore items { userId } } }`, ctx(admin));
      expect(page.errors).toBeUndefined();
      expect(page.extensions?.warnings).toBeUndefined();
      expect(page.data!.agentSubscriptionsPage).toMatchObject({ total: 22, hasMore: true });
      const old = await gql(`query { agentSubscriptions(agentRef: "${agent.id}") { userId } }`, ctx(admin));
      expect((old.data!.agentSubscriptions as unknown[]).length).toBe(22);
    });
  });
});
