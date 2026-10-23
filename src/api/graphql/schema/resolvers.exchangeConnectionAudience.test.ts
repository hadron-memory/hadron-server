/**
 * hadron-internal#18 — who sees an org's exchange connections, and when
 * `testExchangeConnection` writes their status.
 *
 * What this file pins:
 *   - `Organization.exchangeConnections` answers what `Query.exchangeConnections`
 *     answers for the same principal: the same audience, the same rows, the same
 *     order (org ADMIN/OWNER, platform admin, impersonation under the shared
 *     `requireOrgRole`). The envelope differs by design: the direct query refuses
 *     `FORBIDDEN`; the nested non-null list returns `[]` so an admitted parent
 *     keeps its other fields. A masked `[]` looks exactly like a real empty list.
 *   - Only the gate's own FORBIDDEN is masked; a database fault still errors.
 *   - `testExchangeConnection` gates before any provider call and before any
 *     status write: a denied, missing or deleted connection is a uniform typed
 *     FORBIDDEN with no write. Provider failures keep their own typed error.
 *     Both status writes re-check the gate under the connection fence, so a
 *     delete or revocation during the provider call leaves no write.
 *
 * The provider tool is mocked at the emailClient seam.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';

vi.mock('../../../lib/emailClient.js', () => ({
  runEmailOperation: vi.fn(async () => ({ messages: [] })),
  deleteToolConnection: vi.fn(async () => {}),
  createToolConnection: vi.fn(async () => ({})),
  subscribeToolFolder: vi.fn(async () => ({})),
}));

import { runEmailOperation } from '../../../lib/emailClient.js';
import { typeDefs } from './typeDefs.js';
import { resolvers, type Context } from './resolvers.js';

const server = new ApolloServer<Context>({ typeDefs, resolvers });

async function run(query: string, ctx: Partial<Context>) {
  const res = await server.executeOperation({ query }, { contextValue: { db, ...ctx } as Context });
  if (res.body.kind !== 'single') throw new Error('unexpected');
  return res.body.singleResult;
}

let orgId: string;
let otherOrgId: string;
let memoryId: string;
let users: Record<'owner' | 'admin' | 'orgOwner' | 'reader' | 'contributor' | 'revoked' | 'outsider' | 'platform', string>;
let ownerConnectionId: string;
let adminConnectionId: string;

async function mkUser(handle: string, githubId: number, roles: string[] = []) {
  const u = await db.user.create({
    data: { id: generateId(), handle, githubId, githubUsername: handle, name: handle, roles: roles as never },
  });
  return u.id;
}

beforeEach(async () => {
  vi.clearAllMocks();
  await cleanDb(db);
  users = {
    owner: await mkUser('connowner', 9201),
    admin: await mkUser('connadmin', 9202),
    orgOwner: await mkUser('connorgowner', 9203),
    reader: await mkUser('connreader', 9204),
    contributor: await mkUser('conncontrib', 9205),
    revoked: await mkUser('connrevoked', 9206),
    outsider: await mkUser('connoutsider', 9207),
    platform: await mkUser('connplatform', 9208, ['ADMIN']),
  };
  orgId = (await db.organization.create({
    data: { id: generateId(), name: 'Conn Org', urn: 'connorg.test', createdBy: users.orgOwner },
  })).id;
  otherOrgId = (await db.organization.create({
    data: { id: generateId(), name: 'Other Org', urn: 'connother.test', createdBy: users.outsider },
  })).id;
  await db.orgMember.createMany({
    data: [
      { organizationId: orgId, userId: users.owner, role: 'CONTRIBUTOR' },
      { organizationId: orgId, userId: users.admin, role: 'ADMIN' },
      { organizationId: orgId, userId: users.orgOwner, role: 'OWNER' },
      { organizationId: orgId, userId: users.reader, role: 'READER' },
      { organizationId: orgId, userId: users.contributor, role: 'CONTRIBUTOR' },
      { organizationId: orgId, userId: users.revoked, role: 'ADMIN', deletedAt: new Date() },
      { organizationId: otherOrgId, userId: users.outsider, role: 'ADMIN' },
    ],
  });
  ownerConnectionId = (await db.exchangeConnection.create({
    data: { organizationId: orgId, userId: users.owner, mailboxEmail: 'owner@example.com', toolConnectionId: 'tool-1', createdBy: users.owner },
  })).id;
  // Same createdAt on purpose: the shared order must break the tie the same way on both surfaces.
  const tied = (await db.exchangeConnection.findUniqueOrThrow({ where: { id: ownerConnectionId } })).createdAt;
  adminConnectionId = (await db.exchangeConnection.create({
    data: { organizationId: orgId, userId: users.admin, mailboxEmail: 'admin@example.com', toolConnectionId: 'tool-2', createdBy: users.admin, createdAt: tied },
  })).id;
  // A deleted row never shows on either surface.
  await db.exchangeConnection.create({
    data: { organizationId: orgId, userId: users.admin, mailboxEmail: 'gone@example.com', toolConnectionId: 'tool-3', createdBy: users.admin, deletedAt: new Date() },
  });
  memoryId = (await db.memory.create({
    data: { id: generateId(), name: 'Conn Knowledge', urn: 'connorg.test:knowledge', organizationId: orgId, class: 'knowledge', visibility: 'ORGANIZATION' },
  })).id;
});

const DIRECT = () => `query { exchangeConnections(orgId: "${orgId}") { id } }`;
const BY_REF = () => `query { organization(ref: "${orgId}") { id name members { id } exchangeConnections { id } } }`;
const LIST = () => `query { organizations { items { id name exchangeConnections { id } } } }`;
const VIA_MEMORY = () => `query { memory(ref: "${memoryId}") { id organization { id exchangeConnections { id } } } }`;

const ctxFor = (who: keyof typeof users): Partial<Context> =>
  who === 'platform' ? { userId: users.platform, roles: ['ADMIN'] } : { userId: users[who] };

function ids(rows: { id: string }[] | null | undefined) {
  return (rows ?? []).map((r) => r.id);
}

async function directRows(ctx: Partial<Context>): Promise<string[] | 'FORBIDDEN'> {
  const r = await run(DIRECT(), ctx);
  if (r.errors?.length) {
    expect(r.errors[0].extensions?.code).toBe('FORBIDDEN');
    return 'FORBIDDEN';
  }
  return ids(r.data?.exchangeConnections as { id: string }[]);
}

describe('Organization.exchangeConnections follows the direct query (same audience, same rows)', () => {
  it('ADMIN, OWNER and platform admin see the same rows, in the same order, on every surface', async () => {
    for (const who of ['admin', 'orgOwner', 'platform'] as const) {
      const ctx = ctxFor(who);
      const direct = await directRows(ctx);
      expect(direct).toEqual([ownerConnectionId, adminConnectionId].sort());

      const byRef = await run(BY_REF(), ctx);
      expect(byRef.errors).toBeUndefined();
      expect(ids((byRef.data?.organization as { exchangeConnections: { id: string }[] }).exchangeConnections)).toEqual(direct);

      const viaMemory = await run(VIA_MEMORY(), ctx);
      expect(viaMemory.errors).toBeUndefined();
      const memOrg = (viaMemory.data?.memory as { organization: { exchangeConnections: { id: string }[] } | null }).organization;
      expect(ids(memOrg?.exchangeConnections)).toEqual(direct);
    }
    // organizations lists the caller's member orgs; the platform admin is not a member here.
    for (const who of ['admin', 'orgOwner'] as const) {
      const list = await run(LIST(), ctxFor(who));
      expect(list.errors).toBeUndefined();
      const items = (list.data?.organizations as { items: { id: string; exchangeConnections: { id: string }[] }[] }).items;
      expect(ids(items.find((o) => o.id === orgId)?.exchangeConnections)).toEqual([ownerConnectionId, adminConnectionId].sort());
    }
  });

  it('a live member below ADMIN gets [] nested (the parent survives) and FORBIDDEN direct', async () => {
    for (const who of ['reader', 'contributor', 'owner'] as const) {
      const ctx = ctxFor(who);
      expect(await directRows(ctx)).toBe('FORBIDDEN');

      const byRef = await run(BY_REF(), ctx);
      expect(byRef.errors).toBeUndefined();
      const org = byRef.data?.organization as { id: string; name: string; members: unknown[]; exchangeConnections: unknown[] };
      expect(org.id).toBe(orgId);
      expect(org.name).toBe('Conn Org');
      expect(org.members.length).toBeGreaterThan(0);
      expect(org.exchangeConnections).toEqual([]);

      const list = await run(LIST(), ctx);
      expect(list.errors).toBeUndefined();
      const items = (list.data?.organizations as { items: { id: string; exchangeConnections: unknown[] }[] }).items;
      expect(items.find((o) => o.id === orgId)?.exchangeConnections).toEqual([]);

      const viaMemory = await run(VIA_MEMORY(), ctx);
      expect(viaMemory.errors).toBeUndefined();
      expect((viaMemory.data?.memory as { organization: { exchangeConnections: unknown[] } }).organization.exchangeConnections).toEqual([]);
    }
  });

  it('a masked [] is indistinguishable from an org with no connections', async () => {
    const masked = await run(BY_REF(), ctxFor('reader'));
    await db.exchangeConnection.updateMany({ where: { organizationId: orgId }, data: { deletedAt: new Date() } });
    const empty = await run(BY_REF(), ctxFor('admin'));
    expect((masked.data?.organization as { exchangeConnections: unknown }).exchangeConnections)
      .toEqual((empty.data?.organization as { exchangeConnections: unknown }).exchangeConnections);
  });

  it('a revoked member, an outsider and an App key are refused on the parent, as before', async () => {
    for (const ctx of [ctxFor('revoked'), ctxFor('outsider'), { appId: generateId(), clientId: 'app-key' }] as Partial<Context>[]) {
      const byRef = await run(BY_REF(), ctx);
      expect(byRef.data?.organization ?? null).toBeNull();
      expect(byRef.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
      expect(await directRows(ctx)).toBe('FORBIDDEN');
    }
  });

  it('impersonation follows the same predicate on both surfaces', async () => {
    const imp = (target: string, scopedOrg: string): Partial<Context> => ({
      userId: target,
      roles: [],
      impersonation: { orgId: scopedOrg, sessionId: 'support', actorUserId: users.platform, expiresAt: new Date(Date.now() + 3_600_000) } as never,
    });
    // Scoped to this org, target is a READER: [] nested, FORBIDDEN direct.
    const asReader = imp(users.reader, orgId);
    expect(await directRows(asReader)).toBe('FORBIDDEN');
    const readerView = await run(BY_REF(), asReader);
    expect((readerView.data?.organization as { exchangeConnections: unknown[] }).exchangeConnections).toEqual([]);
    // Scoped to this org, target is an ADMIN: the same rows on both.
    const asAdmin = imp(users.admin, orgId);
    const direct = await directRows(asAdmin);
    expect(direct).toEqual([ownerConnectionId, adminConnectionId].sort());
    const adminView = await run(BY_REF(), asAdmin);
    expect(ids((adminView.data?.organization as { exchangeConnections: { id: string }[] }).exchangeConnections)).toEqual(direct);
    // Scoped to another org: the parent is refused.
    const elsewhere = await run(BY_REF(), imp(users.admin, otherOrgId));
    expect(elsewhere.data?.organization ?? null).toBeNull();
  });

  it('a database fault on the list surfaces as an error, never as []', async () => {
    const spy = vi.spyOn(db.exchangeConnection, 'findMany').mockRejectedValueOnce(new Error('boom: db down'));
    try {
      const byRef = await run(BY_REF(), ctxFor('admin'));
      expect(byRef.errors?.length).toBeGreaterThan(0);
      expect(byRef.data?.organization ?? null).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});

const TEST = (id: string) => `mutation { testExchangeConnection(id: "${id}") }`;

async function statusOf(id: string) {
  return db.exchangeConnection.findUniqueOrThrow({
    where: { id },
    select: { syncStatus: true, lastError: true, lastSyncAt: true, updatedAt: true },
  });
}

describe('testExchangeConnection writes status only for an authorized test', () => {
  it('a non-owner, an impersonated owner and an App key without a grant get FORBIDDEN, no provider call, no write', async () => {
    const before = await statusOf(ownerConnectionId);
    const callers: Partial<Context>[] = [
      ctxFor('admin'),
      ctxFor('platform'),
      { userId: users.owner, roles: [], impersonation: { orgId, sessionId: 'support', actorUserId: users.platform, expiresAt: new Date(Date.now() + 3_600_000) } as never },
      { appId: generateId(), clientId: 'app-key' },
    ];
    for (const ctx of callers) {
      const r = await run(TEST(ownerConnectionId), ctx);
      expect(r.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
      expect(r.errors?.[0]?.message).toBe('Forbidden');
    }
    expect(vi.mocked(runEmailOperation)).not.toHaveBeenCalled();
    expect(await statusOf(ownerConnectionId)).toEqual(before);
  });

  it('a missing or deleted connection answers exactly like a denied one, and writes nothing', async () => {
    // The owner's own connection, deleted: the owner is the one caller who
    // would pass the gate if the row were live.
    const deleted = await db.exchangeConnection.create({
      data: { organizationId: orgId, userId: users.owner, mailboxEmail: 'owner-old@example.com', toolConnectionId: 'tool-old', createdBy: users.owner, deletedAt: new Date() },
    });
    const before = await statusOf(deleted.id);
    const denied = await run(TEST(ownerConnectionId), ctxFor('admin'));
    expect(denied.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
    for (const id of [generateId(), deleted.id]) {
      const r = await run(TEST(id), ctxFor('owner'));
      expect(r.errors?.[0]?.extensions?.code).toBe(denied.errors?.[0]?.extensions?.code);
      expect(r.errors?.[0]?.message).toBe(denied.errors?.[0]?.message);
    }
    expect(vi.mocked(runEmailOperation)).not.toHaveBeenCalled();
    expect(await statusOf(deleted.id)).toEqual(before);
  });

  it('the owner: success writes OK; a provider failure writes ERROR and keeps its own typed error', async () => {
    const ok = await run(TEST(ownerConnectionId), ctxFor('owner'));
    expect(ok.errors).toBeUndefined();
    expect(ok.data?.testExchangeConnection).toBe(true);
    const afterOk = await statusOf(ownerConnectionId);
    expect(afterOk.syncStatus).toBe('OK');
    expect(afterOk.lastError).toBeNull();
    expect(afterOk.lastSyncAt).not.toBeNull();

    vi.mocked(runEmailOperation).mockRejectedValueOnce(
      new GraphQLError('Mailbox token expired.', { extensions: { code: 'EMAIL_TOOL_ERROR', provider: 'ms-exchange' } }),
    );
    const failed = await run(TEST(ownerConnectionId), ctxFor('owner'));
    expect(failed.errors?.[0]?.extensions?.code).toBe('EMAIL_TOOL_ERROR');
    expect(failed.errors?.[0]?.message).toBe('Mailbox token expired.');
    const afterFail = await statusOf(ownerConnectionId);
    expect(afterFail.syncStatus).toBe('ERROR');
    expect(afterFail.lastError).toBe('Mailbox token expired.');
  });

  it('a connection deleted while the provider call is in flight gets no status write', async () => {
    for (const outcome of ['success', 'failure'] as const) {
      const conn = await db.exchangeConnection.create({
        data: { organizationId: orgId, userId: users.owner, mailboxEmail: `race-${outcome}@example.com`, toolConnectionId: `tool-race-${outcome}`, createdBy: users.owner },
      });
      let release!: () => void;
      const held = new Promise<void>((r) => { release = r; });
      vi.mocked(runEmailOperation).mockImplementationOnce(async () => {
        await held;
        if (outcome === 'failure') throw new GraphQLError('Provider down.', { extensions: { code: 'EMAIL_TOOL_ERROR' } });
        return { messages: [] };
      });
      const pending = run(TEST(conn.id), ctxFor('owner'));
      await vi.waitFor(() => expect(vi.mocked(runEmailOperation)).toHaveBeenCalled());
      await db.exchangeConnection.update({ where: { id: conn.id }, data: { deletedAt: new Date() } });
      const before = await statusOf(conn.id);
      release();
      await pending;
      expect(await statusOf(conn.id)).toEqual(before);
      vi.mocked(runEmailOperation).mockClear();
    }
  });

  it('a grant revoked while the provider call is in flight gets no status write', async () => {
    const appId = (await db.app.create({ data: { id: generateId(), name: 'mailapp', urn: 'connorg.test:mailapp', organizationId: orgId } })).id;
    const grant = await db.connectionGrant.create({
      data: { id: generateId(), connectionId: ownerConnectionId, granteeAppId: appId, grantedByUserId: users.owner, scopes: ['mail.read'] },
    });
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    vi.mocked(runEmailOperation).mockImplementationOnce(async () => { await held; return { messages: [] }; });
    const pending = run(TEST(ownerConnectionId), { appId, clientId: 'app-key' });
    await vi.waitFor(() => expect(vi.mocked(runEmailOperation)).toHaveBeenCalled());
    await db.connectionGrant.update({ where: { id: grant.id }, data: { deletedAt: new Date() } });
    const before = await statusOf(ownerConnectionId);
    release();
    await pending;
    expect(await statusOf(ownerConnectionId)).toEqual(before);
  });

  it('a database fault during the status write surfaces as an error, never as success', async () => {
    const spy = vi.spyOn(db, '$transaction').mockRejectedValueOnce(new Error('boom: db down'));
    try {
      const r = await run(TEST(ownerConnectionId), ctxFor('owner'));
      expect(r.errors?.length).toBeGreaterThan(0);
      expect(r.data?.testExchangeConnection ?? null).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});
