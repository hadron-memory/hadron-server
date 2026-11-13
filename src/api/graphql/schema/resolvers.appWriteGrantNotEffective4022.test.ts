/**
 * #4022 (N1 of #2716; ruling V79, hrn:node:hadronmemory.com:specs:cor:agt:010:01): `appMemoryWriteGrants` marks a live
 * grant whose target memory can no longer take a write grant as NOT effective, with the reason.
 *
 * Red first. On main `AppMemoryWriteGrant` has no `notEffective` / `notEffectiveReason`, so every mark assertion fails
 * (undefined); the CONTROL cases pin what must not move and are green on main by design.
 *
 * Pinned (gate: Xabat's CHECKED, V79 items 1-3):
 *  - one computation: the mark is `grantTargetRefusal(app, memory) !== null` on an unrevoked row, judged at read, for
 *    EVERY reason (system, encrypted, tenancy, ...), never a copy of the predicate;
 *  - derived, nothing stored: the mark goes away when the memory qualifies again; no row changes;
 *  - concealment: where `memoryUrn` is withheld the mark and the reason are withheld too (null), so they tell the
 *    caller nothing about a memory they cannot see; the list's owner-only filter and refusals are unchanged.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { GRANT_MEMORY_SELECT, grantTargetRefusal } from '../../../lib/appWriteGrant.js';
import { resolvers } from './resolvers.js';
import { project } from './resolvers.appWriteGrant.js';

vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
beforeEach(async () => { await cleanDb(db); });

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
const PREFIX = 'reports:team-progress';

async function fixture() {
  const org = await db.organization.create({ data: { name: 'Mark Org', urn: 'mark4022.test' } });
  const mgr = await db.user.create({ data: { handle: 'mark-mgr' } });
  await db.orgMember.create({ data: { userId: mgr.id, organizationId: org.id, role: 'ADMIN' } });
  const app = await db.app.create({ data: { name: 'Mark App', urn: 'mark4022.test:app', organizationId: org.id } });
  await db.appMember.create({ data: { appId: app.id, userId: mgr.id, role: 'owner' } });
  const mem = (urn: string, extra: Record<string, unknown> = {}) =>
    db.memory.create({ data: { name: urn.split(':')[1], urn, class: 'knowledge', ...(extra.class ? {} : { visibility: 'ORGANIZATION' }), organizationId: org.id, ...extra } as never });
  const dest = await mem('mark4022.test:dest');
  const personal = await mem('mark4022.test:mine', { class: 'personal', userId: mgr.id });
  const system = await mem('mark4022.test:sys', { class: 'system' });
  const foreignOrg = await db.organization.create({ data: { name: 'Foreign', urn: 'foreign4022.test' } });
  const ctx = { db, userId: mgr.id, roles: [] as never[] };
  return { org, mgr, app, dest, personal, system, foreignOrg, ctx, mem };
}
type F = Awaited<ReturnType<typeof fixture>>;

/** A row as it could exist: written directly, since the set door now refuses a target that cannot take one. */
const rowOn = (f: F, memoryId: string, extra: Record<string, unknown> = {}) =>
  db.appMemoryWriteGrant.create({ data: { appId: f.app.id, memoryId, prefix: PREFIX, grantedBy: f.mgr.id, ...extra } });
const list = (f: F, ctx: unknown = f.ctx, includeRevoked = false) => Q.appMemoryWriteGrants({}, { appRef: f.app.id, includeRevoked }, ctx) as Promise<any[]>;
const markOf = (g: any) => ({ notEffective: g.notEffective, reason: g.notEffectiveReason });

describe('#4022 the listing marks a grant that cannot take effect', () => {
  it('a grant that predates the system-memory rule lists as not effective, reason system', async () => {
    const f = await fixture();
    await rowOn(f, f.system.id);
    expect((await list(f)).map(markOf)).toEqual([{ notEffective: true, reason: 'system' }]);
  });

  it('a grant on a memory later encrypted is marked (a second reason); the mark goes when it qualifies again; no row changes', async () => {
    const f = await fixture();
    const row = await rowOn(f, f.dest.id);
    expect((await list(f)).map(markOf)).toEqual([{ notEffective: false, reason: null }]);
    await db.memory.update({ where: { id: f.dest.id }, data: { isEncrypted: true } });
    expect((await list(f)).map(markOf)).toEqual([{ notEffective: true, reason: 'encrypted' }]);
    await db.memory.update({ where: { id: f.dest.id }, data: { isEncrypted: false } });
    expect((await list(f)).map(markOf)).toEqual([{ notEffective: false, reason: null }]);
    expect(await db.appMemoryWriteGrant.findUnique({ where: { id: row.id } })).toEqual(row);
  });

  it('a grant on a memory that moved to another org is marked, reason tenancy', async () => {
    const f = await fixture();
    await rowOn(f, f.dest.id);
    await db.memory.update({ where: { id: f.dest.id }, data: { organizationId: f.foreignOrg.id } });
    expect((await list(f)).map(markOf)).toEqual([{ notEffective: true, reason: 'tenancy' }]);
  });

  it('CONTROL: a grant on a writable memory carries no mark', async () => {
    const f = await fixture();
    await rowOn(f, f.dest.id);
    const [g] = await list(f);
    expect(markOf(g)).toEqual({ notEffective: false, reason: null });
    expect(g.memoryUrn).toBe('hrn:mem:mark4022.test:dest');
  });

  it('one computation: for every memory state the mark equals grantTargetRefusal on the same row', async () => {
    const f = await fixture();
    const enc = await f.mem('mark4022.test:vault', { isEncrypted: true });
    const foreign = await db.memory.create({ data: { name: 'foreign', urn: 'foreign4022.test:mem', class: 'knowledge', visibility: 'ORGANIZATION', organizationId: f.foreignOrg.id } as never });
    const encPersonal = await f.mem('mark4022.test:vm', { class: 'personal', userId: f.mgr.id, isEncrypted: true });
    const memories = [f.dest, f.personal, f.system, enc, foreign, encPersonal];
    for (const m of memories) await rowOn(f, m.id);
    const app = await db.app.findUniqueOrThrow({ where: { id: f.app.id }, select: { id: true, organizationId: true, ownerUserId: true } });
    const listed = await list(f);
    expect(listed).toHaveLength(memories.length);
    for (const m of memories) {
      const full = await db.memory.findUniqueOrThrow({ where: { id: m.id }, select: GRANT_MEMORY_SELECT });
      const expected = grantTargetRefusal(app, full);
      const g = listed.find((x) => x.memoryUrn === `hrn:mem:${m.urn}`)!;
      expect(markOf(g)).toEqual({ notEffective: expected !== null, reason: expected });
    }
    expect(new Set(listed.map((g) => g.notEffectiveReason))).toEqual(new Set([null, 'system', 'encrypted', 'tenancy']));
  });

  it('a revoked row carries no mark: the mark is about a live grant', async () => {
    const f = await fixture();
    await rowOn(f, f.system.id, { revokedAt: new Date(), revokedBy: f.mgr.id });
    expect((await list(f)).length).toBe(0);
    expect((await list(f, f.ctx, true)).map(markOf)).toEqual([{ notEffective: false, reason: null }]);
  });

  it('set and revoke answer the same projection: a fresh grant is unmarked', async () => {
    const f = await fixture();
    const set = await M.setAppMemoryWriteGrant({}, { appRef: f.app.id, memoryRef: f.dest.id, prefix: PREFIX }, f.ctx);
    expect(markOf(set)).toEqual({ notEffective: false, reason: null });
    const ended = await M.revokeAppMemoryWriteGrant({}, { id: set.id }, f.ctx);
    expect(markOf(ended)).toEqual({ notEffective: false, reason: null });
  });
});

describe('#4022 concealment: the mark never tells a caller about a memory they cannot see', () => {
  it('the owner sees the reason on their own personal memory; a peer manager does not see the row at all', async () => {
    const f = await fixture();
    await rowOn(f, f.personal.id);
    await db.memory.update({ where: { id: f.personal.id }, data: { isEncrypted: true } });
    expect((await list(f)).map(markOf)).toEqual([{ notEffective: true, reason: 'encrypted' }]);
    const peer = await db.user.create({ data: { handle: 'mark-peer' } });
    await db.appMember.create({ data: { appId: f.app.id, userId: peer.id, role: 'owner' } });
    expect(await list(f, { db, userId: peer.id, roles: [] })).toEqual([]);
  });

  it('revoking as a manager who is not the owner returns the row with the URN, the mark and the reason all withheld', async () => {
    const f = await fixture();
    const row = await rowOn(f, f.personal.id);
    await db.memory.update({ where: { id: f.personal.id }, data: { isEncrypted: true } });
    const peer = await db.user.create({ data: { handle: 'mark-peer' } });
    await db.appMember.create({ data: { appId: f.app.id, userId: peer.id, role: 'owner' } });
    const r = await M.revokeAppMemoryWriteGrant({}, { id: row.id }, { db, userId: peer.id, roles: [] });
    expect(r.memoryUrn).toBeNull();
    expect(r.notEffective ?? null).toBeNull();
    expect(r.notEffectiveReason ?? null).toBeNull();
    expect(r.revokedAt).toBeInstanceOf(Date);
  });

  it('the projection itself withholds URN, mark and reason on an UNREVOKED row of a memory the viewer does not own (no door reaches this today; it is the guard)', async () => {
    const f = await fixture();
    const row = await rowOn(f, f.personal.id);
    await db.memory.update({ where: { id: f.personal.id }, data: { isEncrypted: true } });
    const memory = await db.memory.findUniqueOrThrow({ where: { id: f.personal.id }, select: { ...GRANT_MEMORY_SELECT, urn: true } });
    const app = await db.app.findUniqueOrThrow({ where: { id: f.app.id }, select: { id: true, organizationId: true, ownerUserId: true } });
    const peer = await db.user.create({ data: { handle: 'mark-peer2' } });
    expect(project(row, memory, app, peer.id)).toMatchObject({ memoryUrn: null, notEffective: null, notEffectiveReason: null });
    expect(project(row, memory, app, f.mgr.id)).toMatchObject({ notEffective: true, notEffectiveReason: 'encrypted' });
  });

  it('CONTROL: a caller who may not list is refused exactly as before', async () => {
    const f = await fixture();
    await rowOn(f, f.system.id);
    const stranger = await db.user.create({ data: { handle: 'mark-stranger' } });
    await expect(list(f, { db, userId: stranger.id, roles: [] })).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
  });
});
