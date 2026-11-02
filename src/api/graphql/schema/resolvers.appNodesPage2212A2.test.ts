/**
 * #2212 slice A2 — `appNodesPage`, the additive page sibling of `appNodes`
 * (cor:api:120:04). The old field stays exactly as it was.
 *
 * Pins, one per gate item:
 *   (1) pages of 7 over 25 nodes in two memories cover every id exactly once, in (loc, id) order;
 *       two same-loc nodes in two memories paged at limit 1 are neither repeated nor skipped
 *   (2) `total` equals the old field's count for the same filter; `limit: 0` is count-only and
 *       decrypts, marks and records nothing
 *   (3) participant-only parity with `appNodes`; an outsider, an unknown ref and a malformed ref get the
 *       SAME error on both fields; the deleted-org arm is `[]` / the empty page
 *   (4) an inheritance-excluded node is in neither `items` nor `total`; a row dropped by the post-read
 *       `retainEffective` re-check never ends paging early (`hasMore` from raw rows)
 *   (5) `includeDeleted` without recovery authority adds nothing to `total`; with it, the page agrees
 *   (6) `memoryIds` / `memoryClasses` in the filter are still BAD_USER_INPUT
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

const hooks: { afterScope?: () => Promise<void> } = {};
vi.mock('../../../lib/effectiveSystemMemory.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../lib/effectiveSystemMemory.js')>();
  return {
    ...mod,
    effectiveScope: async (...args: Parameters<typeof mod.effectiveScope>) => {
      const out = await mod.effectiveScope(...args);
      const hook = hooks.afterScope;
      hooks.afterScope = undefined;
      if (hook) await hook();
      return out;
    },
  };
});

const Q = resolvers.Query as any;
const ids = (rows: { id: string }[]) => rows.map((r) => r.id);
const settle = () => new Promise((r) => setTimeout(r, 200));

let org: { id: string; urn: string };
let appId: string;
let agentId: string;
let memA: string;
let memB: string;
let member: string;
let participant: string;
let outsider: string;

const asUser = (userId: string): Context => ({ db, userId, roles: ['READER'] }) as Context;

async function nodeIn(memoryId: string, loc: string, extra: Record<string, unknown> = {}) {
  return db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, content: loc, ...extra } });
}
const key = (r: { loc: string; id: string }) => `${r.loc}\u0000${r.id}`;
const sortedLocId = <T extends { loc: string; id: string }>(rows: T[]) =>
  [...rows].sort((x, y) => (x.loc < y.loc ? -1 : x.loc > y.loc ? 1 : x.id < y.id ? -1 : x.id > y.id ? 1 : 0));

beforeEach(async () => {
  await cleanDb(db);
  hooks.afterScope = undefined;
  const sfx = generateId().slice(-8);
  org = await db.organization.create({ data: { name: 'ap', urn: `ap-${sfx}.example` }, select: { id: true, urn: true } });
  member = (await db.user.create({ data: { handle: `apm-${sfx}`, roles: ['READER'] } })).id;
  participant = (await db.user.create({ data: { handle: `app-${sfx}`, roles: ['READER'] } })).id;
  outsider = (await db.user.create({ data: { handle: `apo-${sfx}`, roles: ['READER'] } })).id;
  await db.orgMember.create({ data: { organizationId: org.id, userId: member, role: 'READER' } });
  memA = (await db.memory.create({ data: { organizationId: org.id, class: 'knowledge', name: 'A', urn: `${org.urn}:a` } })).id;
  memB = (await db.memory.create({ data: { organizationId: org.id, class: 'knowledge', name: 'B', urn: `${org.urn}:b` } })).id;
  const app = await db.app.create({ data: { name: 'App', urn: `${org.urn}:app`, organizationId: org.id } });
  appId = app.id;
  agentId = (await db.agent.create({ data: { name: 'Ag', urn: `${org.urn}:ag`, organizationId: org.id } })).id;
  await db.appAgent.create({ data: { appId, agentId } });
  await db.agentMemoryItem.createMany({ data: [
    { agentId, memoryId: memA, role: 'read-write' },
    { agentId, memoryId: memB, role: 'read-write' },
  ] });
  await db.appMember.create({ data: { appId, userId: participant, role: 'member' } });
});

async function seed25() {
  for (let i = 0; i < 25; i++) await nodeIn(i % 2 ? memA : memB, `n${String(i).padStart(2, '0')}`, { isRunnable: i % 5 === 0 });
}
const oldAll = (c: Context, filter?: unknown) => Q.appNodes({}, { appRef: appId, filter, limit: 200 }, c);

describe('appNodesPage — paging (pin 1)', () => {
  it('pages of 7 over 25 nodes in two memories cover every id once, in loc,id order', async () => {
    await seed25();
    const c = asUser(member);
    const old = await oldAll(c);
    expect(old).toHaveLength(25);
    const seen: { id: string; loc: string }[] = [];
    for (let offset = 0; offset < 25; offset += 7) {
      const p = await Q.appNodesPage({}, { appRef: appId, limit: 7, offset }, c);
      expect(p.total).toBe(25);
      expect(p.hasMore).toBe(offset + p.items.length < 25);
      seen.push(...p.items);
    }
    expect(seen.map(key)).toEqual(sortedLocId(old).map(key));
    expect(new Set(ids(seen)).size).toBe(25);
  });

  it('same loc in two memories, paged at limit 1, is neither repeated nor skipped', async () => {
    const a = await nodeIn(memA, 'dup');
    const b = await nodeIn(memB, 'dup');
    await nodeIn(memA, 'zz');
    const seen: string[] = [];
    for (let offset = 0; offset < 3; offset++) {
      seen.push(...ids((await Q.appNodesPage({}, { appRef: appId, limit: 1, offset }, asUser(member))).items));
    }
    expect(seen.slice(0, 2)).toEqual([a.id, b.id].sort());
    expect(new Set(seen).size).toBe(3);
  });

  it('size edges: omitted 20, negative 0, over-cap 200, past the end empty', async () => {
    for (let i = 0; i < 230; i++) await nodeIn(memA, `m${String(i).padStart(3, '0')}`);
    const c = asUser(member);
    expect((await Q.appNodesPage({}, { appRef: appId }, c)).items).toHaveLength(20);
    expect((await Q.appNodesPage({}, { appRef: appId, limit: null }, c)).items).toHaveLength(20);
    expect((await Q.appNodesPage({}, { appRef: appId, limit: -3 }, c)).items).toHaveLength(0);
    const big = await Q.appNodesPage({}, { appRef: appId, limit: 5000 }, c);
    expect([big.items.length, big.total, big.hasMore]).toEqual([200, 230, true]);
    const past = await Q.appNodesPage({}, { appRef: appId, limit: 20, offset: 999 }, c);
    expect([past.items.length, past.total, past.hasMore]).toEqual([0, 230, false]);
  });
});

describe('appNodesPage — total and count-only (pin 2)', () => {
  it('total equals the old field count for the same filter; limit 0 is count-only and records no reads', async () => {
    await seed25();
    const c = asUser(member);
    const filter = { isRunnable: true };
    const old = await oldAll(c, filter);
    expect(old.length).toBe(5);
    await settle();
    await db.usageEvent.deleteMany({});
    const zero = await Q.appNodesPage({}, { appRef: appId, filter, limit: 0 }, c);
    expect([zero.items.length, zero.total, zero.hasMore]).toEqual([0, 5, true]);
    await settle();
    expect(await db.usageEvent.count()).toBe(0);
    const page = await Q.appNodesPage({}, { appRef: appId, filter, limit: 2 }, c);
    expect(page.total).toBe(5);
    await settle();
    expect(await db.usageEvent.count()).toBe(2); // only the returned rows are reads
  });
});

describe('appNodesPage — admission parity (pin 3)', () => {
  it('a participant-only AppMember sees the same set through the page as through appNodes', async () => {
    await seed25();
    const c = asUser(participant);
    const old = await oldAll(c);
    const page = await Q.appNodesPage({}, { appRef: appId, limit: 200 }, c);
    expect(page.total).toBe(old.length);
    expect(ids(page.items)).toEqual(ids(sortedLocId(old)));
  });

  it.each([
    ['outsider', () => asUser(outsider), () => appId],
    ['unknown app ref', () => asUser(member), () => generateId()],
    ['malformed app ref', () => asUser(member), () => 'not a ref ::: !!'],
  ])('%s gets the SAME refusal on both fields', async (_n, who, ref) => {
    const oldErr = await Q.appNodes({}, { appRef: ref() }, who()).then(() => null, (e: any) => e);
    expect(oldErr).not.toBeNull();
    const pageErr = await Q.appNodesPage({}, { appRef: ref() }, who()).then(() => null, (e: any) => e);
    expect(pageErr).not.toBeNull();
    expect(pageErr.message).toBe(oldErr.message);
    expect(pageErr.extensions?.code).toBe(oldErr.extensions?.code);
  });

  it('a soft-deleted organization is [] on the old field and the empty page on the new one', async () => {
    await seed25();
    await db.organization.update({ where: { id: org.id }, data: { deletedAt: new Date() } });
    expect(await oldAll(asUser(member))).toEqual([]);
    expect(await Q.appNodesPage({}, { appRef: appId }, asUser(member))).toEqual({ items: [], total: 0, hasMore: false });
  });

  it('an App with an empty accessible scope is [] on the old field and the empty page on the new one', async () => {
    await db.agentMemoryItem.deleteMany({});
    await db.appAgent.deleteMany({});
    const c = asUser(member);
    expect(await oldAll(c)).toEqual([]);
    expect(await Q.appNodesPage({}, { appRef: appId }, c)).toEqual({ items: [], total: 0, hasMore: false });
  });
});

describe('appNodesPage — inheritance (pin 4)', () => {
  it('an inheritance-excluded node is in neither items nor total, and a retainEffective drop does not end paging early', async () => {
    const baseMem = (await db.memory.create({ data: { class: 'system', organizationId: org.id, name: 'base', urn: `${org.urn}:base-system` } })).id;
    const base = await db.agent.create({ data: { name: 'Base', urn: `${org.urn}:base`, organizationId: org.id, visibility: 'ORGANIZATION', systemMemoryId: baseMem } });
    const childMem = (await db.memory.create({ data: { class: 'system', organizationId: org.id, name: 'child', urn: `${org.urn}:child-system` } })).id;
    const child = await db.agent.create({ data: { name: 'Child', urn: `${org.urn}:child`, organizationId: org.id, visibility: 'ORGANIZATION', systemMemoryId: childMem, extendsAgentId: base.id } });
    await db.appAgent.create({ data: { appId, agentId: child.id } });
    const keep = await nodeIn(baseMem, 'tasks:a-keep');
    const shipBase = await nodeIn(baseMem, 'tasks:b-ship');
    const lateBase = await nodeIn(baseMem, 'tasks:c-late');
    const shipOverride = await nodeIn(childMem, 'tasks:b-ship'); // overrides the base: base copy excluded now
    const c = asUser(member);
    const all = await Q.appNodesPage({}, { appRef: appId, limit: 200, filter: { locPrefix: 'tasks:' } }, c);
    expect(ids(all.items)).not.toContain(shipBase.id);
    expect(ids(all.items)).toEqual(expect.arrayContaining([keep.id, lateBase.id, shipOverride.id]));
    expect(all.total).toBe(all.items.length);

    // Drop `lateBase` AFTER the snapshot (a concurrent override): retainEffective removes it from the page.
    hooks.afterScope = async () => { await nodeIn(childMem, 'tasks:c-late'); };
    const first = await Q.appNodesPage({}, { appRef: appId, limit: 2, offset: 0, filter: { locPrefix: 'tasks:' } }, c);
    expect(ids(first.items)).not.toContain(lateBase.id);
    // raw rows (2) were read: more remain by total, so paging must continue even though items < raw rows.
    expect(first.hasMore).toBe(2 < first.total);
    expect(first.hasMore).toBe(true);
  });
});

describe('appNodesPage — recovery (pin 5)', () => {
  it('includeDeleted without recovery authority adds nothing to total; with it, the page agrees with appNodes', async () => {
    await nodeIn(memA, 'live');
    await nodeIn(memA, 'gone', { deletedAt: new Date('2026-01-01') });
    const filter = { includeDeleted: true };
    const reader = asUser(member);
    const rp = await Q.appNodesPage({}, { appRef: appId, filter }, reader);
    expect(rp.total).toBe(1);
    expect(rp.items).toHaveLength(1);
    const org2 = await db.user.create({ data: { handle: `apw-${generateId().slice(-6)}`, roles: ['READER'] } });
    await db.orgMember.create({ data: { organizationId: org.id, userId: org2.id, role: 'CONTRIBUTOR' } });
    const writer = asUser(org2.id);
    const old = await oldAll(writer, filter);
    const wp = await Q.appNodesPage({}, { appRef: appId, filter, limit: 200 }, writer);
    expect(wp.total).toBe(old.length);
    expect(ids(wp.items)).toEqual(ids(sortedLocId(old)));
    expect(wp.total).toBe(2);
  });
});

describe('appNodesPage — unsupported filter fields (pin 6)', () => {
  it.each([{ memoryIds: ['x'] }, { memoryClasses: ['knowledge'] }])('%j is BAD_USER_INPUT', async (filter) => {
    await expect(Q.appNodesPage({}, { appRef: appId, filter }, asUser(member))).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    await expect(Q.appNodes({}, { appRef: appId, filter }, asUser(member))).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  });
});
