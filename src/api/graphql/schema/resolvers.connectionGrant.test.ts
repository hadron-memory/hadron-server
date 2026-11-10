/**
 * #593 — ConnectionGrant enforcement gate + owner-only management surface.
 *
 * The gate (`requireEmailConnection`) is exercised DIRECTLY across the
 * cross-tenant matrix (owner vs non-owner user vs granted App vs revoked/expired/
 * out-of-scope), because it is the one chokepoint every mail/calendar op flows
 * through. The create/list/revoke management surface is exercised via GraphQL.
 *
 * Key security properties pinned here:
 *  - Fail-closed in App contexts (Option B): an on-behalf-of-OWNER run still
 *    needs a covering grant.
 *  - Unmapped ops are owner-only (grantees can never reach delete/move/…).
 *  - Cross-org delegation is allowed (grant row is the sole authority).
 *  - List/read is owner-scoped with no existence oracle.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';

vi.mock('../../../lib/emailClient.js', () => ({
  runEmailOperation: vi.fn(async () => ({})),
  deleteToolConnection: vi.fn(async () => {}),
  createToolConnection: vi.fn(async () => ({})),
  subscribeToolFolder: vi.fn(async () => ({})),
}));

import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { typeDefs } from './typeDefs.js';
import { resolvers, type Context } from './resolvers.js';
import { ConnectionNotFoundError, requireEmailConnection } from './resolvers.helpers.js';
import { waitForLockWaitersOfType } from '../../../test/lockWait.js';

const server = new ApolloServer<Context>({ typeDefs, resolvers });
async function gql(query: string, ctx: Partial<Context>, variables?: Record<string, unknown>) {
  const res = await server.executeOperation({ query, variables }, { contextValue: { db, ...ctx } as Context });
  if (res.body.kind !== 'single') throw new Error('unexpected');
  return res.body.singleResult;
}

let owner: string, stranger: string;
let orgA: string, orgB: string;
let connId: string, otherConnId: string;
let grantedApp: string, otherApp: string;

async function mkApp(name: string, org: string): Promise<string> {
  const app = await db.app.create({ data: { id: generateId(), name, urn: `${org}:${name}`, organizationId: org } });
  return app.id;
}
async function mkGrant(data: { connectionId: string; granteeAppId: string; scopes: string[]; expiresAt?: Date | null; deletedAt?: Date | null }) {
  return db.connectionGrant.create({
    data: {
      id: generateId(),
      connectionId: data.connectionId,
      granteeAppId: data.granteeAppId,
      grantedByUserId: owner,
      scopes: data.scopes,
      expiresAt: data.expiresAt ?? null,
      deletedAt: data.deletedAt ?? null,
    },
  });
}
const ownerCtx = (): Partial<Context> => ({ userId: owner, roles: ['READER'] });
const appCtx = (appId: string, userId?: string): Partial<Context> => ({ appId, userId, roles: [] });
// Direct gate calls need `db` on the Context (the GraphQL harness injects it).
const gate = (ctx: Partial<Context>, conn: string, op: string) =>
  requireEmailConnection({ db, ...ctx } as Context, conn, op);

beforeEach(async () => {
  vi.clearAllMocks();
  await cleanDb(db);
  const u1 = await db.user.create({ data: { id: generateId(), githubId: 6931, githubUsername: 'cg-owner' } });
  const u2 = await db.user.create({ data: { id: generateId(), githubId: 6932, githubUsername: 'cg-stranger' } });
  owner = u1.id; stranger = u2.id;
  const a = await db.organization.create({ data: { id: generateId(), name: 'cg-orgA', urn: 'cg-orga' } });
  const b = await db.organization.create({ data: { id: generateId(), name: 'cg-orgB', urn: 'cg-orgb' } });
  orgA = a.id; orgB = b.id;
  const conn = await db.exchangeConnection.create({
    data: { organizationId: orgA, userId: owner, mailboxEmail: 'owner@ex.com', toolConnectionId: 'tool-1', createdBy: owner },
  });
  connId = conn.id;
  const other = await db.exchangeConnection.create({
    data: { organizationId: orgA, userId: owner, mailboxEmail: 'other@ex.com', toolConnectionId: 'tool-2', createdBy: owner },
  });
  otherConnId = other.id;
  // Grantee Apps live in a DIFFERENT org (orgB) — cross-org delegation is intended.
  grantedApp = await mkApp('granted-app', orgB);
  otherApp = await mkApp('other-app', orgB);
});

describe('#593 gate — requireEmailConnection(ctx, connId, operation)', () => {
  it('interactive owner (no appId) is allowed for EVERY op, including unmapped ones', async () => {
    for (const op of ['list-messages', 'send-draft', 'delete-message', 'move-message']) {
      await expect(gate(ownerCtx(), connId, op)).resolves.toMatchObject({ id: connId });
    }
  });

  it('a non-owner user is denied', async () => {
    await expect(gate({ userId: stranger, roles: [] }, connId, 'list-messages')).rejects.toThrow('Forbidden');
  });

  it('a granted App is allowed within scope and denied outside it', async () => {
    await mkGrant({ connectionId: connId, granteeAppId: grantedApp, scopes: ['mail.read'] });
    // in scope
    await expect(gate(appCtx(grantedApp), connId, 'list-messages')).resolves.toMatchObject({ id: connId });
    // out of scope (has mail.read, wants mail.send)
    await expect(gate(appCtx(grantedApp), connId, 'send-draft')).rejects.toThrow('Forbidden');
  });

  it('mail.send grantee cannot read', async () => {
    await mkGrant({ connectionId: connId, granteeAppId: grantedApp, scopes: ['mail.send'] });
    await expect(gate(appCtx(grantedApp), connId, 'list-messages')).rejects.toThrow('Forbidden');
    await expect(gate(appCtx(grantedApp), connId, 'reply-to-message')).resolves.toMatchObject({ id: connId });
  });

  it('a revoked (soft-deleted) grant does not authorize', async () => {
    await mkGrant({ connectionId: connId, granteeAppId: grantedApp, scopes: ['mail.read'], deletedAt: new Date() });
    await expect(gate(appCtx(grantedApp), connId, 'list-messages')).rejects.toThrow('Forbidden');
  });

  it('expiry: expired denies, perpetual (null) allows', async () => {
    await mkGrant({ connectionId: connId, granteeAppId: grantedApp, scopes: ['mail.read'], expiresAt: new Date(Date.now() - 1000) });
    await expect(gate(appCtx(grantedApp), connId, 'list-messages')).rejects.toThrow('Forbidden');
    await db.connectionGrant.deleteMany({});
    await mkGrant({ connectionId: connId, granteeAppId: grantedApp, scopes: ['mail.read'], expiresAt: null });
    await expect(gate(appCtx(grantedApp), connId, 'list-messages')).resolves.toMatchObject({ id: connId });
  });

  it('FAIL-CLOSED: an unmapped op is denied even for a grantee holding every scope', async () => {
    await mkGrant({ connectionId: connId, granteeAppId: grantedApp, scopes: ['mail.read', 'mail.send', 'calendar.read', 'calendar.freebusy'] });
    for (const op of ['delete-message', 'move-message', 'mark-read', 'flag-message', 'categorize-message']) {
      await expect(gate(appCtx(grantedApp), connId, op)).rejects.toThrow('Forbidden');
    }
  });

  it('Option B: on-behalf-of-OWNER run still needs a grant (appId set)', async () => {
    // ctx carries appId AND userId=owner — the fail-closed App path applies.
    await expect(gate(appCtx(grantedApp, owner), connId, 'list-messages')).rejects.toThrow('Forbidden');
    await mkGrant({ connectionId: connId, granteeAppId: grantedApp, scopes: ['mail.read'] });
    await expect(gate(appCtx(grantedApp, owner), connId, 'list-messages')).resolves.toMatchObject({ id: connId });
  });

  it('App-only principal with no grant is denied', async () => {
    await expect(gate(appCtx(grantedApp), connId, 'list-messages')).rejects.toThrow('Forbidden');
  });

  it('a grant for a different App / different connection does not authorize', async () => {
    await mkGrant({ connectionId: connId, granteeAppId: grantedApp, scopes: ['mail.read'] });
    // wrong app
    await expect(gate(appCtx(otherApp), connId, 'list-messages')).rejects.toThrow('Forbidden');
    // wrong connection
    await expect(gate(appCtx(grantedApp), otherConnId, 'list-messages')).rejects.toThrow('Forbidden');
  });

  it('cross-org grantee (App in org B, connection in org A) is allowed — grant is sole authority', async () => {
    await mkGrant({ connectionId: connId, granteeAppId: grantedApp, scopes: ['mail.read'] });
    await expect(gate(appCtx(grantedApp), connId, 'list-messages')).resolves.toMatchObject({ id: connId, organizationId: orgA });
  });

  it('a soft-deleted connection is judged absent before any grant (#2782: absence answers as the denial does)', async () => {
    await db.exchangeConnection.update({ where: { id: connId }, data: { deletedAt: new Date() } });
    await mkGrant({ connectionId: connId, granteeAppId: grantedApp, scopes: ['mail.read'] });
    await expect(gate(appCtx(grantedApp), connId, 'list-messages')).rejects.toBeInstanceOf(ConnectionNotFoundError);
  });

  it('a grant to an UNINSTALLED App no longer authorizes (uninstall drops delegation)', async () => {
    await mkGrant({ connectionId: connId, granteeAppId: grantedApp, scopes: ['mail.read'] });
    await expect(gate(appCtx(grantedApp), connId, 'list-messages')).resolves.toMatchObject({ id: connId });
    await db.app.update({ where: { id: grantedApp }, data: { uninstalledAt: new Date() } });
    await expect(gate(appCtx(grantedApp), connId, 'list-messages')).rejects.toThrow('Forbidden');
  });
});

describe('#593 management surface (GraphQL, owner-only)', () => {
  const CREATE = `mutation($c: String!, $a: String!, $s: [String!]!, $e: String) {
    createConnectionGrant(connectionRef: $c, appRef: $a, scopes: $s, expiresAt: $e) {
      id connectionId granteeAppId granteeAppName scopes expiresAt
    } }`;

  it('owner creates a grant; grantee is a scalar projection (no App object)', async () => {
    const r = await gql(CREATE, ownerCtx(), { c: connId, a: grantedApp, s: ['mail.read'] });
    expect(r.errors).toBeUndefined();
    const g = r.data?.createConnectionGrant as Record<string, unknown>;
    expect(g.granteeAppId).toBe(grantedApp);
    expect(g.granteeAppName).toBe('granted-app');
    expect(g.scopes).toEqual(['mail.read']);
    // The gate now authorizes that App within scope.
    await expect(gate(appCtx(grantedApp), connId, 'list-messages')).resolves.toMatchObject({ id: connId });
  });

  it('rejects unknown scopes, past expiry, and a missing grantee App', async () => {
    const bad1 = await gql(CREATE, ownerCtx(), { c: connId, a: grantedApp, s: ['mail.delete'] });
    expect(bad1.errors?.[0].message).toMatch(/Unknown scope/);
    const bad2 = await gql(CREATE, ownerCtx(), { c: connId, a: grantedApp, s: ['mail.read'], e: new Date(Date.now() - 1000).toISOString() });
    expect(bad2.errors?.[0].message).toMatch(/future/);
    const bad3 = await gql(CREATE, ownerCtx(), { c: connId, a: generateId(), s: ['mail.read'] });
    expect(bad3.errors?.[0].message).toMatch(/Grantee App not found/);
    const bad4 = await gql(CREATE, ownerCtx(), { c: connId, a: grantedApp, s: [] });
    expect(bad4.errors?.[0].message).toMatch(/at least one scope/i);
  });

  it('a non-owner cannot create a grant on a connection they do not own', async () => {
    const r = await gql(CREATE, { userId: stranger, roles: [] }, { c: connId, a: grantedApp, s: ['mail.read'] });
    expect(r.errors?.[0].message).toMatch(/not found/i); // no existence oracle
  });

  it('an App / on-behalf-of-OWNER context CANNOT manage grants (no self-bootstrap)', async () => {
    // Both userId=owner AND appId set — an autonomous context must not be able
    // to grant itself mailbox access, or Option B is defeated.
    const created = await gql(CREATE, { userId: owner, appId: grantedApp, roles: [] }, { c: connId, a: grantedApp, s: ['mail.read'] });
    expect(created.errors?.[0].message).toMatch(/not found/i);
    // And it cannot revoke, either.
    const grant = await mkGrant({ connectionId: connId, granteeAppId: grantedApp, scopes: ['mail.read'] });
    const REVOKE = `mutation($r: ID!) { revokeConnectionGrant(ref: $r) }`;
    const revoked = await gql(REVOKE, { userId: owner, appId: grantedApp, roles: [] }, { r: grant.id });
    expect(revoked.errors?.[0].message).toMatch(/forbidden/i);
    // The grant is untouched → the gate still (correctly) denies the App anyway
    // because App-context ops need a grant AND this App has one; that's fine —
    // the point is management was refused.
    const still = await db.connectionGrant.findFirst({ where: { id: grant.id, deletedAt: null } });
    expect(still).not.toBeNull();
  });

  it('rejects a timezone-naive expiresAt (must carry Z or an offset)', async () => {
    const naive = await gql(CREATE, ownerCtx(), { c: connId, a: grantedApp, s: ['mail.read'], e: '2999-01-01T00:00:00' });
    expect(naive.errors?.[0].message).toMatch(/ISO-8601 timestamp with a timezone/);
    const ok = await gql(CREATE, ownerCtx(), { c: connId, a: grantedApp, s: ['mail.read'], e: '2999-01-01T00:00:00Z' });
    expect(ok.errors).toBeUndefined();
  });

  it('list is owner-scoped — a stranger sees an empty page (BOLA)', async () => {
    await mkGrant({ connectionId: connId, granteeAppId: grantedApp, scopes: ['mail.read'] });
    const LIST = `query($c: String) { connectionGrants(connectionRef: $c) { total items { id } } }`;
    const mine = await gql(LIST, ownerCtx(), { c: connId });
    expect((mine.data?.connectionGrants as { total: number }).total).toBe(1);
    const theirs = await gql(LIST, { userId: stranger, roles: [] }, { c: connId });
    expect((theirs.data?.connectionGrants as { total: number }).total).toBe(0);
  });

  it('owner revokes → gate denies afterward; a non-owner cannot revoke', async () => {
    const grant = await mkGrant({ connectionId: connId, granteeAppId: grantedApp, scopes: ['mail.read'] });
    const REVOKE = `mutation($r: ID!) { revokeConnectionGrant(ref: $r) }`;
    const strangerTry = await gql(REVOKE, { userId: stranger, roles: [] }, { r: grant.id });
    expect(strangerTry.errors?.[0].message).toMatch(/not found/i);
    const ok = await gql(REVOKE, ownerCtx(), { r: grant.id });
    expect(ok.data?.revokeConnectionGrant).toBe(true);
    await expect(gate(appCtx(grantedApp), connId, 'list-messages')).rejects.toThrow('Forbidden');
  });
});

describe('#1551 connection grant revocation fence', () => {
  it('connection deletion waits for an in-flight grant, then makes it unusable', async () => {
    await db.orgMember.create({ data: {
      id: generateId(), organizationId: orgA, userId: owner, role: 'ADMIN',
    } });
    let release!: () => void;
    let held!: () => void;
    const holdGate = new Promise<void>((resolve) => { release = resolve; });
    const locked = new Promise<void>((resolve) => { held = resolve; });
    const holder = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM exchange_connections WHERE id = ${connId} FOR UPDATE`;
      held();
      await holdGate;
    }, { timeout: 20_000 });
    await locked;

    const grant = resolvers.Mutation.createConnectionGrant(null, {
      connectionRef: connId, appRef: grantedApp, scopes: ['mail.read'],
    }, { db, ...ownerCtx() } as Context);
    try {
      await waitForLockWaitersOfType(db, 'transactionid', 1);
      let deleted = false;
      const deletion = resolvers.Mutation.deleteExchangeConnection(null, { id: connId },
        { db, ...ownerCtx() } as Context).then((value: unknown) => { deleted = true; return value; });
      await waitForLockWaitersOfType(db, 'advisory', 1);
      expect(deleted).toBe(false);
      release();
      await holder;
      await grant;
      await deletion;
      expect((await db.exchangeConnection.findUniqueOrThrow({ where: { id: connId } })).deletedAt).not.toBeNull();
      await expect(gate(appCtx(grantedApp), connId, 'list-messages')).rejects.toBeInstanceOf(ConnectionNotFoundError);
    } finally {
      release();
      await Promise.allSettled([holder, grant]);
    }

  });
});
