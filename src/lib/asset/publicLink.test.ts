/**
 * #1667 / cor:dmo:060:15 — the per-asset public-link switch.
 *
 * Pins: the class-manager matrix (writer vs manager, strict personal/private ownership, session /
 * encrypted / worker / system exclusions), refusals that change neither flag nor audit, the audit row,
 * every availability x flag x origin combination on Asset.publicUrl / publicLinkAvailable, and the real
 * anonymous GET /assets/:id twins (OFF, outer OFF, missing, blocked, pending, deleted, encrypted).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { requestActorStorage } from '../requestActor.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
import { mountPublicAssetRoutes } from '../../api/assetPublic.js';
import { setAssetPublicLink, canManageAssetPublicLink, PUBLIC_LINK_MEMORY_SELECT } from './publicLink.js';

const mintGetUrlMock = vi.hoisted(() => vi.fn());
vi.mock('../../integrations/r2/client.js', () => ({ mintGetUrl: mintGetUrlMock }));

const M = resolvers.Mutation as unknown as {
  setAssetPublicLink: (p: unknown, a: { assetRef: string; enabled: boolean }, c: Context) => Promise<{ id: string; publicLinkEnabled: boolean }>;
};
const A = (resolvers as unknown as { Asset: Record<string, (a: unknown, args: unknown, c: Context) => unknown> }).Asset;

const ctxOf = (userId: string | undefined, extra: Partial<Context> = {}): Context =>
  ({ db, userId, roles: ['READER'], ...extra }) as Context;

let n = 0;
let org: { id: string; urn: string };
let u: Record<'admin' | 'ownerRole' | 'writer' | 'reader' | 'outsider' | 'platform' | 'appOwner' | 'appMember' | 'groupOwner' | 'owner', { id: string }>;
let knowledge: { id: string };
let app: { id: string };

async function mkUser(name: string, roles: string[] = ['READER']) {
  return db.user.create({ data: { id: generateId(), githubId: 80_000 + ++n, githubUsername: `pl-${name}-${n}`, roles: roles as never }, select: { id: true } });
}

async function mkAsset(memoryId: string, over: Partial<{ scanStatus: 'PENDING' | 'CLEAN' | 'BLOCKED'; deletedAt: Date | null; publicLinkEnabled: boolean }> = {}) {
  const id = generateId();
  await db.asset.create({
    data: {
      id, memoryId, filename: 'r.pdf', mimeType: 'application/pdf', sizeBytes: 1, storageKey: `k-${id}`,
      scanStatus: over.scanStatus ?? 'CLEAN', deletedAt: over.deletedAt ?? null, publicLinkEnabled: over.publicLinkEnabled ?? false,
    },
  });
  return id;
}

const flagOf = async (id: string) => (await db.asset.findUniqueOrThrow({ where: { id } })).publicLinkEnabled;
const audits = (id: string) => db.assetPublicLinkAudit.findMany({ where: { assetId: id } });

beforeEach(async () => {
  await cleanDb(db);
  process.env.ASSET_PUBLIC_HOTLINK_ENABLED = 'true';
  process.env.BASE_URL = 'https://hadron.example';
  const sfx = `${Date.now()}${++n}`;
  org = await db.organization.create({ data: { id: generateId(), name: 'pl-org', urn: `pl-org-${sfx}.com` } });
  u = {
    admin: await mkUser('admin'), ownerRole: await mkUser('orgowner'), writer: await mkUser('writer'), reader: await mkUser('reader'),
    outsider: await mkUser('out'), platform: await mkUser('plat', ['ADMIN']), appOwner: await mkUser('appowner'),
    appMember: await mkUser('appmember'), groupOwner: await mkUser('grpowner'), owner: await mkUser('owner'),
  };
  await db.orgMember.createMany({ data: [
    { organizationId: org.id, userId: u.admin.id, role: 'ADMIN' },
    { organizationId: org.id, userId: u.ownerRole.id, role: 'OWNER' },
    { organizationId: org.id, userId: u.writer.id, role: 'CONTRIBUTOR' },
    { organizationId: org.id, userId: u.reader.id, role: 'READER' },
    { organizationId: org.id, userId: u.appOwner.id, role: 'CONTRIBUTOR' },
    { organizationId: org.id, userId: u.appMember.id, role: 'CONTRIBUTOR' },
    { organizationId: org.id, userId: u.groupOwner.id, role: 'CONTRIBUTOR' },
  ] });
  knowledge = await db.memory.create({ data: { id: generateId(), class: 'knowledge', organizationId: org.id, urn: `${org.urn}:k`, name: 'k', visibility: 'ORGANIZATION' } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'A', urn: `${org.urn}:a` } });
  await db.appMember.createMany({ data: [
    { appId: app.id, userId: u.appOwner.id, role: 'owner' },
    { appId: app.id, userId: u.appMember.id, role: 'member' },
  ] });
});

describe('who may switch the link (the class-manager matrix)', () => {
  it('org knowledge memory: ADMIN and OWNER may; a CONTRIBUTOR who can write may not', async () => {
    for (const [who, ok] of [['admin', true], ['ownerRole', true], ['writer', false], ['reader', false]] as const) {
      const id = await mkAsset(knowledge.id);
      const call = M.setAssetPublicLink({}, { assetRef: id, enabled: true }, ctxOf(u[who].id));
      if (ok) {
        expect((await call).publicLinkEnabled).toBe(true);
        expect(await flagOf(id)).toBe(true);
      } else {
        await expect(call).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
        expect(await flagOf(id)).toBe(false);
        expect(await audits(id)).toHaveLength(0);
      }
    }
  });

  it('a caller who cannot read the memory gets the missing-asset answer, not a permission answer', async () => {
    const id = await mkAsset(knowledge.id);
    await expect(M.setAssetPublicLink({}, { assetRef: id, enabled: true }, ctxOf(u.outsider.id))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(M.setAssetPublicLink({}, { assetRef: 'nope', enabled: true }, ctxOf(u.outsider.id))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await audits(id)).toHaveLength(0);
  });

  it('a platform admin may where the table gives an org ADMIN (org-owned memory)', async () => {
    const id = await mkAsset(knowledge.id);
    expect((await M.setAssetPublicLink({}, { assetRef: id, enabled: true }, ctxOf(u.platform.id, { roles: ['ADMIN'] }))).publicLinkEnabled).toBe(true);
  });

  it('an unauthenticated call and an App-key principal are refused', async () => {
    const id = await mkAsset(knowledge.id);
    await expect(setAssetPublicLink(ctxOf(undefined), id, true)).rejects.toThrow('Unauthenticated');
    await expect(setAssetPublicLink(ctxOf(undefined, { appId: app.id, appKeyId: generateId() }), id, true)).rejects.toThrow();
    expect(await flagOf(id)).toBe(false);
  });

  it('impersonation never switches (identity-scoped)', async () => {
    const id = await mkAsset(knowledge.id);
    await expect(M.setAssetPublicLink({}, { assetRef: id, enabled: true }, ctxOf(u.admin.id, { impersonation: { orgId: org.id } as never }))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await flagOf(id)).toBe(false);
  });

  it('personal and private memory: only the owning user; a platform admin never', async () => {
    for (const cls of ['personal', 'private'] as const) {
      const mem = await db.memory.create({ data: { id: generateId(), class: cls, userId: u.owner.id, urn: `${org.urn}:${cls}-${n++}`, name: cls, organizationId: org.id } });
      const id = await mkAsset(mem.id);
      await expect(M.setAssetPublicLink({}, { assetRef: id, enabled: true }, ctxOf(u.platform.id, { roles: ['ADMIN'] }))).rejects.toMatchObject({ code: expect.stringMatching(/NOT_FOUND|PERMISSION_DENIED/) });
      await expect(M.setAssetPublicLink({}, { assetRef: id, enabled: true }, ctxOf(u.admin.id))).rejects.toBeDefined();
      expect(await flagOf(id)).toBe(false);
      expect((await M.setAssetPublicLink({}, { assetRef: id, enabled: true }, ctxOf(u.owner.id))).publicLinkEnabled).toBe(true);
    }
  });

  it('group memory: a group owner member or the org ADMIN; not a plain group member', async () => {
    const grp = await db.memory.create({ data: { id: generateId(), class: 'group', organizationId: org.id, urn: `${org.urn}:grp`, name: 'grp', visibility: 'GROUP' } });
    await db.memoryMember.createMany({ data: [
      { memoryId: grp.id, userId: u.groupOwner.id, role: 'owner' },
      { memoryId: grp.id, userId: u.writer.id, role: 'writer' },
    ] });
    const idW = await mkAsset(grp.id);
    await expect(M.setAssetPublicLink({}, { assetRef: idW, enabled: true }, ctxOf(u.writer.id))).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(await flagOf(idW)).toBe(false);
    expect((await M.setAssetPublicLink({}, { assetRef: idW, enabled: true }, ctxOf(u.groupOwner.id))).publicLinkEnabled).toBe(true);
    const idA = await mkAsset(grp.id);
    expect((await M.setAssetPublicLink({}, { assetRef: idA, enabled: true }, ctxOf(u.admin.id))).publicLinkEnabled).toBe(true);
  });

  it('App team space: whoever manages the App (owner-role member, org admin); not a plain member', async () => {
    const team = await db.memory.create({ data: { id: generateId(), class: 'app', appId: app.id, organizationId: org.id, urn: `${org.urn}:team`, name: 'team' } });
    const id = await mkAsset(team.id);
    await expect(M.setAssetPublicLink({}, { assetRef: id, enabled: true }, ctxOf(u.appMember.id))).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(await flagOf(id)).toBe(false);
    expect((await M.setAssetPublicLink({}, { assetRef: id, enabled: true }, ctxOf(u.appOwner.id))).publicLinkEnabled).toBe(true);
    expect((await M.setAssetPublicLink({}, { assetRef: id, enabled: false }, ctxOf(u.admin.id))).publicLinkEnabled).toBe(false);
  });

  it('session memory, worker working memory and system memory are refused even for the manager', async () => {
    const agent = await db.agent.create({ data: { organizationId: org.id, name: 'ag', urn: `${org.urn}:ag`, visibility: 'ORGANIZATION' } });
    const session = await db.memory.create({ data: { id: generateId(), class: 'app', appId: app.id, userMemoryOfAgentId: agent.id, organizationId: org.id, urn: `${org.urn}:sess`, name: 'sess' } });
    const workerMem = await db.memory.create({ data: { id: generateId(), class: 'app', appId: app.id, organizationId: org.id, urn: `${org.urn}:wk`, name: 'wk' } });
    await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name: 'Wk', slug: 'wk', memoryId: workerMem.id } });
    const system = await db.memory.create({ data: { id: generateId(), class: 'system', organizationId: org.id, urn: `${org.urn}:sys`, name: 'sys' } });
    for (const m of [session, workerMem, system]) {
      const id = await mkAsset(m.id);
      const mem = await db.memory.findUniqueOrThrow({ where: { id: m.id }, select: PUBLIC_LINK_MEMORY_SELECT });
      expect(await canManageAssetPublicLink(ctxOf(u.admin.id), mem)).toBe(false);
      expect(await canManageAssetPublicLink(ctxOf(u.appOwner.id), mem)).toBe(false);
      await expect(M.setAssetPublicLink({}, { assetRef: id, enabled: true }, ctxOf(u.admin.id))).rejects.toBeDefined();
      expect(await flagOf(id)).toBe(false);
      expect(await audits(id)).toHaveLength(0);
    }
  });

  it('an encrypted memory is refused, and canManagePublicLink is false there', async () => {
    const enc = await db.memory.create({ data: { id: generateId(), class: 'knowledge', organizationId: org.id, urn: `${org.urn}:enc`, name: 'enc', visibility: 'ORGANIZATION', isEncrypted: true } });
    const id = await mkAsset(enc.id);
    await expect(M.setAssetPublicLink({}, { assetRef: id, enabled: true }, ctxOf(u.admin.id))).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(await flagOf(id)).toBe(false);
    expect(await audits(id)).toHaveLength(0);
    expect(await A.canManagePublicLink({ memoryId: enc.id, deletedAt: null }, {}, ctxOf(u.admin.id))).toBe(false);
  });

  it('a deleted or staged asset is a missing asset', async () => {
    const del = await mkAsset(knowledge.id, { deletedAt: new Date() });
    await expect(M.setAssetPublicLink({}, { assetRef: del, enabled: true }, ctxOf(u.admin.id))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const staged = generateId();
    await db.asset.create({ data: { id: staged, memoryId: null, filename: 's', mimeType: 'a/b', sizeBytes: 1, storageKey: `k-${staged}` } });
    await expect(M.setAssetPublicLink({}, { assetRef: staged, enabled: true }, ctxOf(u.admin.id))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('authority is rechecked inside the transaction', () => {
  it('a manager revoked between the request and the write cannot switch (forced mutation)', async () => {
    const id = await mkAsset(knowledge.id);
    const stale = ctxOf(u.admin.id, { roles: ['READER'] });
    await db.orgMember.updateMany({ where: { organizationId: org.id, userId: u.admin.id }, data: { role: 'READER' } });
    await expect(M.setAssetPublicLink({}, { assetRef: id, enabled: true }, stale)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(await flagOf(id)).toBe(false);
    expect(await audits(id)).toHaveLength(0);
  });

  it('a soft-deleted org membership does not authorize', async () => {
    const id = await mkAsset(knowledge.id);
    await db.orgMember.updateMany({ where: { organizationId: org.id, userId: u.admin.id }, data: { deletedAt: new Date() } });
    await expect(M.setAssetPublicLink({}, { assetRef: id, enabled: true }, ctxOf(u.admin.id))).rejects.toBeDefined();
    expect(await flagOf(id)).toBe(false);
  });

  it('a memory transferred to another org before the write: the former manager is refused', async () => {
    const id = await mkAsset(knowledge.id);
    const other = await db.organization.create({ data: { id: generateId(), name: 'o2', urn: `pl-o2-${Date.now()}.com` } });
    await db.memory.update({ where: { id: knowledge.id }, data: { organizationId: other.id } });
    await expect(M.setAssetPublicLink({}, { assetRef: id, enabled: true }, ctxOf(u.admin.id))).rejects.toBeDefined();
    expect(await flagOf(id)).toBe(false);
  });
});

describe('audit', () => {
  it('records actor, new and previous value for every successful call, including a no-op', async () => {
    const id = await mkAsset(knowledge.id);
    await M.setAssetPublicLink({}, { assetRef: id, enabled: true }, ctxOf(u.admin.id));
    await M.setAssetPublicLink({}, { assetRef: id, enabled: true }, ctxOf(u.ownerRole.id));
    await M.setAssetPublicLink({}, { assetRef: id, enabled: false }, ctxOf(u.admin.id));
    const rows = (await audits(id)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    expect(rows.map((r) => [r.actorUserId, r.enabled, r.previouslyEnabled, r.memoryId])).toEqual([
      [u.admin.id, true, false, knowledge.id],
      [u.ownerRole.id, true, true, knowledge.id],
      [u.admin.id, false, true, knowledge.id],
    ]);
    expect(await flagOf(id)).toBe(false);
  });

  it('the audit outlives the hard-deleted asset', async () => {
    const id = await mkAsset(knowledge.id);
    await M.setAssetPublicLink({}, { assetRef: id, enabled: true }, ctxOf(u.admin.id));
    await db.asset.delete({ where: { id } });
    expect(await audits(id)).toHaveLength(1);
  });
});

describe('Asset fields: every availability x flag x origin combination', () => {
  const combos: Array<[outer: boolean, flag: boolean, origin: boolean]> = [];
  for (const o of [true, false]) for (const f of [true, false]) for (const b of [true, false]) combos.push([o, f, b]);

  it.each(combos)('outer=%s flag=%s origin=%s', async (outer, flag, origin) => {
    process.env.ASSET_PUBLIC_HOTLINK_ENABLED = outer ? 'true' : 'false';
    if (origin) process.env.BASE_URL = 'https://hadron.example'; else delete process.env.BASE_URL;
    const id = await mkAsset(knowledge.id, { publicLinkEnabled: flag });
    const row = await db.asset.findUniqueOrThrow({ where: { id } });
    const ctx = ctxOf(u.writer.id);
    expect(A.publicLinkAvailable(row, {}, ctx)).toBe(outer);
    expect(row.publicLinkEnabled).toBe(flag);
    expect(await A.publicUrl(row, {}, ctx)).toBe(outer && flag && origin ? `https://hadron.example/assets/${id}` : null);
  });

  it('an ordinary writer sees canManagePublicLink false while a manager sees true, regardless of flag or outer gate', async () => {
    process.env.ASSET_PUBLIC_HOTLINK_ENABLED = 'false';
    const id = await mkAsset(knowledge.id, { publicLinkEnabled: true });
    const row = { memoryId: knowledge.id, deletedAt: null, id };
    expect(await A.canManagePublicLink(row, {}, ctxOf(u.writer.id))).toBe(false);
    expect(await A.canManagePublicLink(row, {}, ctxOf(u.admin.id))).toBe(true);
    expect(await A.canManagePublicLink(row, {}, ctxOf(u.outsider.id))).toBe(false);
    expect(await A.canManagePublicLink(row, {}, ctxOf(undefined))).toBe(false);
  });

  it('switching ON with the outer gate OFF is recorded and still serves nothing', async () => {
    process.env.ASSET_PUBLIC_HOTLINK_ENABLED = 'false';
    const id = await mkAsset(knowledge.id);
    const res = await M.setAssetPublicLink({}, { assetRef: id, enabled: true }, ctxOf(u.admin.id));
    expect(res.publicLinkEnabled).toBe(true);
    expect(await A.publicUrl(await db.asset.findUniqueOrThrow({ where: { id } }), {}, ctxOf(u.admin.id))).toBeNull();
  });
});

describe('anonymous GET /assets/:id (real HTTP)', () => {
  let server: Server;
  let base: string;
  const get = (path: string) => fetch(`${base}${path}`, { redirect: 'manual' });

  beforeEach(async () => {
    mintGetUrlMock.mockReset();
    mintGetUrlMock.mockResolvedValue('https://store.example/presigned');
    const app2 = express();
    mountPublicAssetRoutes(app2, db);
    await new Promise<void>((r) => { server = app2.listen(0, '127.0.0.1', () => r()); });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterEach(async () => { await new Promise<void>((r) => server.close(() => r())); });

  async function bareNotFound(id: string) {
    const res = await get(`/assets/${id}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
  }

  it('default OFF: an existing CLEAN asset answers the bare 404, identical to a missing one', async () => {
    const id = await mkAsset(knowledge.id);
    await bareNotFound(id);
    await bareNotFound('does-not-exist');
    expect(mintGetUrlMock).not.toHaveBeenCalled();
  });

  it('switched ON by a manager it redirects; switched OFF again it is the bare 404', async () => {
    const id = await mkAsset(knowledge.id);
    await M.setAssetPublicLink({}, { assetRef: id, enabled: true }, ctxOf(u.admin.id));
    const ok = await get(`/assets/${id}`);
    expect(ok.status).toBe(302);
    expect(ok.headers.get('location')).toBe('https://store.example/presigned');
    await M.setAssetPublicLink({}, { assetRef: id, enabled: false }, ctxOf(u.admin.id));
    await bareNotFound(id);
  });

  it('flag ON but outer gate OFF: the bare 404', async () => {
    const id = await mkAsset(knowledge.id, { publicLinkEnabled: true });
    process.env.ASSET_PUBLIC_HOTLINK_ENABLED = 'false';
    await bareNotFound(id);
  });

  it('flag ON and no canonical origin: the route still serves (origin only gates publicUrl)', async () => {
    delete process.env.BASE_URL;
    const id = await mkAsset(knowledge.id, { publicLinkEnabled: true });
    expect((await get(`/assets/${id}`)).status).toBe(302);
  });

  it('flag ON but blocked / pending / deleted / encrypted / deleted-memory: all the same bare 404', async () => {
    const enc = await db.memory.create({ data: { id: generateId(), class: 'knowledge', organizationId: org.id, urn: `${org.urn}:enc2`, name: 'enc2', visibility: 'ORGANIZATION', isEncrypted: true } });
    const gone = await db.memory.create({ data: { id: generateId(), class: 'knowledge', organizationId: org.id, urn: `${org.urn}:gone`, name: 'gone', visibility: 'ORGANIZATION', deletedAt: new Date() } });
    const ids = [
      await mkAsset(knowledge.id, { publicLinkEnabled: true, scanStatus: 'BLOCKED' }),
      await mkAsset(knowledge.id, { publicLinkEnabled: true, scanStatus: 'PENDING' }),
      await mkAsset(knowledge.id, { publicLinkEnabled: true, deletedAt: new Date() }),
      await mkAsset(enc.id, { publicLinkEnabled: true }),
      await mkAsset(gone.id, { publicLinkEnabled: true }),
    ];
    for (const id of ids) await bareNotFound(id);
    expect(mintGetUrlMock).not.toHaveBeenCalled();
  });
});

describe('migration default', () => {
  it('every asset created without the flag starts OFF', async () => {
    const id = generateId();
    await db.asset.create({ data: { id, memoryId: knowledge.id, filename: 'f', mimeType: 'a/b', sizeBytes: 1, storageKey: `k-${id}` } });
    expect(await flagOf(id)).toBe(false);
  });
});

describe('review findings on #2287', () => {
  it('P1: a caller pinned to App A cannot publish an asset in its own App-B personal/private memory', async () => {
    const appB = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'B', urn: `${org.urn}:b` } });
    const agent = await db.agent.create({ data: { organizationId: org.id, name: 'agb', urn: `${org.urn}:agb`, visibility: 'ORGANIZATION' } });
    for (const cls of ['personal', 'private'] as const) {
      const mem = await db.memory.create({ data: { id: generateId(), class: cls, userId: u.owner.id, appId: appB.id, userMemoryOfAgentId: agent.id, urn: `${org.urn}:${cls}-b`, name: cls, organizationId: org.id } });
      const id = await mkAsset(mem.id);
      await expect(M.setAssetPublicLink({}, { assetRef: id, enabled: true }, ctxOf(u.owner.id, { appId: app.id }))).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(await flagOf(id)).toBe(false);
      expect(await audits(id)).toHaveLength(0);
      const row = await db.memory.findUniqueOrThrow({ where: { id: mem.id }, select: PUBLIC_LINK_MEMORY_SELECT });
      expect(await canManageAssetPublicLink(ctxOf(u.owner.id, { appId: app.id }), row)).toBe(false);
    }
  });

  it('P2 (R113): a bound worker session of the App manager is refused on the team space', async () => {
    const team = await db.memory.create({ data: { id: generateId(), class: 'app', appId: app.id, organizationId: org.id, urn: `${org.urn}:team2`, name: 'team2' } });
    const id = await mkAsset(team.id);
    await requestActorStorage.run({ workerId: generateId(), agentId: null }, async () => {
      await expect(M.setAssetPublicLink({}, { assetRef: id, enabled: true }, ctxOf(u.appOwner.id))).rejects.toBeDefined();
    });
    expect(await flagOf(id)).toBe(false);
    expect(await audits(id)).toHaveLength(0);
  });

  /** Hold `statements` uncommitted in one tx, run `during` while it is held, then commit it. */
  async function heldWhile(statements: (tx: any) => Promise<void>, during: () => Promise<unknown>) {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let held!: () => void;
    const holding = new Promise<void>((r) => { held = r; });
    const blocker = db.$transaction(async (tx) => { await statements(tx); held(); await gate; });
    await holding;
    const call = during();
    const settled = call.then(() => 'done', () => 'done');
    // The call must be parked behind the held row lock, not decided from a stale read.
    expect(await Promise.race([settled, new Promise((r) => setTimeout(() => r('waiting'), 400))])).toBe('waiting');
    release();
    await blocker;
    return call;
  }

  it('P3: a demotion queued behind the manager lock wait is seen: the former manager is refused', async () => {
    const id = await mkAsset(knowledge.id);
    // The demoting tx holds the membership row; the switch call parks on its FOR SHARE, then must re-decide.
    const outcome = heldWhile(
      async (tx) => { await tx.$executeRaw`UPDATE org_members SET role = 'READER' WHERE organization_id = ${org.id} AND user_id = ${u.admin.id}`; },
      () => M.setAssetPublicLink({}, { assetRef: id, enabled: true }, ctxOf(u.admin.id)),
    );
    await expect(outcome).rejects.toBeDefined();
    expect(await flagOf(id)).toBe(false);
    expect(await audits(id)).toHaveLength(0);
  });

  it('P3: an asset deleted while the call waits on its row lock is a missing asset, and nothing is audited', async () => {
    const id = await mkAsset(knowledge.id);
    const outcome = heldWhile(
      async (tx) => { await tx.$executeRaw`UPDATE assets SET deleted_at = now() WHERE id = ${id}`; },
      () => M.setAssetPublicLink({}, { assetRef: id, enabled: true }, ctxOf(u.admin.id)),
    );
    await expect(outcome).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await flagOf(id)).toBe(false);
    expect(await audits(id)).toHaveLength(0);
  });
});
