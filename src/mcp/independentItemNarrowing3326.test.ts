/**
 * #3326: the independent user item ceiling is narrowed to the candidate item memories. Contract unchanged
 * (cor:dmo:050:09, cor:acl:010:01/:02, cor:dmo:060:09, cor:acl:020:01); the pins count work, never time.
 *
 * Fixture: a user who is a live org CONTRIBUTOR (so a great many org memories are independently readable and writable),
 * an Agent that carries exactly TWO items, one org memory the user reaches and one it does not.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbAppWithKey } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { getAppMemoryAccess, getPrincipalAppMemoryAccess } from './access-control.js';
import { independentUserItemAccess } from '../lib/auth/independentUserItemAccess.js';

const MANY = 30; // org memories the user can read and write independently, none of them an item
const PUBLICS = 10; // PUBLIC knowledge memories, readable by everyone
const SUBSCRIBED = 5; // PUBLIC memories subscribed to the user's org at CONTRIBUTOR, readable and writable that way

async function fixture() {
  const org = await db.organization.create({ data: { name: 'Pins3326', urn: `pins-${generateId().toLowerCase()}.example` } });
  const other = await db.organization.create({ data: { name: 'Other3326', urn: `other-${generateId().toLowerCase()}.example` } });
  const user = await db.user.create({ data: { handle: `pins-${generateId().toLowerCase()}`, roles: ['READER'] } });
  await db.orgMember.create({ data: { userId: user.id, organizationId: org.id, role: 'CONTRIBUTOR' } });
  const system = await db.memory.create({ data: { urn: `${org.urn}:system`, name: 'system', class: 'system', organizationId: org.id } });
  const agent = await db.agent.create({ data: { urn: `${org.urn}:agent`, name: 'agent', organizationId: org.id, systemMemoryId: system.id } });
  const knowledge = (urn: string, organizationId: string, visibility: 'ORGANIZATION' | 'PUBLIC' = 'ORGANIZATION') =>
    db.memory.create({ data: { urn, name: urn, class: 'knowledge', organizationId, visibility } });
  const reachable = await knowledge(`${org.urn}:item-reachable`, org.id);
  const unreachable = await knowledge(`${other.urn}:item-unreachable`, other.id);
  const unrelatedIds: string[] = [];
  for (let i = 0; i < MANY; i++) unrelatedIds.push((await knowledge(`${org.urn}:bulk-${i}`, org.id)).id);
  for (let i = 0; i < PUBLICS; i++) unrelatedIds.push((await knowledge(`${other.urn}:public-${i}`, other.id, 'PUBLIC')).id);
  // Subscribed to the user's org at CONTRIBUTOR: independently writable through the subscription arm, none an item.
  for (let i = 0; i < SUBSCRIBED; i++) {
    const m = await knowledge(`${other.urn}:subscribed-${i}`, other.id, 'PUBLIC');
    unrelatedIds.push(m.id);
    await db.memorySubscription.create({ data: { organizationId: org.id, memoryId: m.id, role: 'CONTRIBUTOR' } });
  }
  await db.agentMemoryItem.createMany({ data: [reachable, unreachable].map(m => ({ agentId: agent.id, memoryId: m.id, role: 'read-write' })) });
  const { app } = await createDbAppWithKey(db, 'first', org.id);
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  await db.appMember.create({ data: { appId: app.id, userId: user.id, role: 'member' } });
  return { org, other, user, system, agent, reachable, unreachable, app, unrelatedIds };
}
let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => { await cleanDb(db); f = await fixture(); });

/** Rows returned by every memory.findMany issued while `run` executes, plus how many queries issued them. */
async function memoryRows<T>(run: () => Promise<T>) {
  const spy = vi.spyOn(db.memory, 'findMany');
  try {
    const result = await run();
    const batches = await Promise.all(spy.mock.results.map(r => r.value as Promise<unknown[]>));
    const ids = new Set(batches.flat().flatMap(row => (row as { id?: string }).id ? [(row as { id: string }).id] : []));
    return { result, queries: batches.length, rows: batches.reduce((n, b) => n + b.length, 0), ids };
  } finally { spy.mockRestore(); }
}

describe('#3326 bounded work (rows and queries, not time)', () => {
  it('many independently readable memories, two candidate items: the independent set is bounded to the candidates', async () => {
    const { result, rows, ids } = await memoryRows(() => getAppMemoryAccess(db, f.app.id, { callerUserId: f.user.id }));
    // Behavior: the reachable item folds, the unreachable one does not.
    expect(result.get(f.reachable.id)).toBe('READ_WRITE');
    expect(result.has(f.unreachable.id)).toBe(false);
    // Work: none of the 45 unrelated readable memories is ever loaded (main loads all of them), and the rest stays small.
    expect(f.unrelatedIds).toHaveLength(MANY + PUBLICS + SUBSCRIBED);
    expect(f.unrelatedIds.filter(id => ids.has(id))).toEqual([]);
    expect(rows).toBeLessThanOrEqual(6);
  });

  it('no item: no independent lookup at all, and an empty candidate list issues no query', async () => {
    await db.agentMemoryItem.deleteMany({ where: { agentId: f.agent.id } });
    const none = await memoryRows(() => getAppMemoryAccess(db, f.app.id, { callerUserId: f.user.id }));
    const members = vi.spyOn(db.orgMember, 'findMany');
    const agents = vi.spyOn(db.agent, 'findMany');
    const empty = await memoryRows(() => independentUserItemAccess(db, f.user.id, []));
    expect(empty.result.size).toBe(0);
    expect(empty.queries).toBe(0);
    expect(members).not.toHaveBeenCalled(); // the early return comes before any membership or Agent lookup
    expect(agents).not.toHaveBeenCalled();
    members.mockRestore(); agents.mockRestore();
    expect(none.rows).toBeLessThanOrEqual(2); // the live system memory lookup only
  });
});

describe('#3326 the narrowed answer is the full answer restricted to the candidates', () => {
  it('equals the complete computation for exactly the candidate ids, with no other key', async () => {
    const owned = await db.memory.create({ data: { urn: `${f.org.urn}:owned`, name: 'owned', class: 'knowledge', ownerUserId: f.user.id, visibility: 'ORGANIZATION' } });
    // Reachable through the owner arm and through a managed Agent's system memory, yet NOT candidates: they must not appear.
    const strayOwned = await db.memory.create({ data: { urn: `${f.org.urn}:stray-owned`, name: 'stray owned', class: 'knowledge', ownerUserId: f.user.id, visibility: 'ORGANIZATION' } });
    const third = await db.organization.create({ data: { name: 'Third3326', urn: `third-${generateId().toLowerCase()}.example` } });
    await db.orgMember.create({ data: { userId: f.user.id, organizationId: third.id, role: 'ADMIN' } });
    const strayMemory = await db.memory.create({ data: { urn: `${third.urn}:system`, name: 'stray system', class: 'system', organizationId: third.id } });
    await db.agent.create({ data: { urn: `${third.urn}:agent`, name: 'stray agent', organizationId: third.id, systemMemoryId: strayMemory.id } });
    const full = await independentUserItemAccess(db, f.user.id);
    expect(full.has(strayOwned.id)).toBe(true);
    expect(full.has(strayMemory.id)).toBe(true);
    expect(full.size).toBeGreaterThan(MANY);
    const candidates = [f.reachable.id, f.unreachable.id, owned.id, generateId()];
    const narrowed = await independentUserItemAccess(db, f.user.id, candidates);
    expect([...narrowed.keys()].sort()).toEqual(candidates.filter(id => full.has(id)).sort());
    for (const [id, level] of narrowed) expect(level).toBe(full.get(id));
    expect(narrowed.get(owned.id)).toBe('READ_WRITE');
  });

  it('keeps the levels: reader reads, contributor and subscription writers write, a revoked membership nothing', async () => {
    const sub = await db.memory.create({ data: { urn: `${f.other.urn}:sub`, name: 'sub', class: 'knowledge', organizationId: f.other.id, visibility: 'PUBLIC' } });
    await db.memorySubscription.create({ data: { organizationId: f.org.id, memoryId: sub.id, role: 'CONTRIBUTOR' } });
    const ids = [f.reachable.id, sub.id];
    const before = await independentUserItemAccess(db, f.user.id, ids);
    expect(before.get(f.reachable.id)).toBe('READ_WRITE');
    expect(before.get(sub.id)).toBe('READ_WRITE');
    await db.orgMember.updateMany({ where: { userId: f.user.id }, data: { role: 'READER' } });
    const reader = await independentUserItemAccess(db, f.user.id, ids);
    expect(reader.get(f.reachable.id)).toBe('READ_ONLY');
    expect(reader.get(sub.id)).toBe('READ_ONLY');
    await db.orgMember.updateMany({ where: { userId: f.user.id }, data: { deletedAt: new Date() } });
    const revoked = await independentUserItemAccess(db, f.user.id, ids);
    expect(revoked.has(f.reachable.id)).toBe(false);
    expect(revoked.get(sub.id)).toBe('READ_ONLY'); // PUBLIC stays readable without any membership, never writable
  });
});

describe('#3326 no cross-request caching: revocation is observed on the next request', () => {
  it('a principal fold after the membership is revoked loses the item the previous fold granted', async () => {
    const principal = { userId: f.user.id, appId: f.app.id };
    expect((await getPrincipalAppMemoryAccess(db, principal)).get(f.reachable.id)).toBe('READ_WRITE');
    await db.orgMember.updateMany({ where: { userId: f.user.id }, data: { deletedAt: new Date() } });
    expect((await getPrincipalAppMemoryAccess(db, principal)).has(f.reachable.id)).toBe(false);
  });
});

describe('#3326 several Apps: per-memory reuse never confuses one memory\'s level with another\'s', () => {
  it('an unselected user folding two Apps with overlapping items gets each memory its own level', async () => {
    const pub = await db.memory.create({ data: { urn: `${f.other.urn}:item-public`, name: 'public item', class: 'knowledge', organizationId: f.other.id, visibility: 'PUBLIC' } });
    const system2 = await db.memory.create({ data: { urn: `${f.org.urn}:system2`, name: 'system2', class: 'system', organizationId: f.org.id } });
    const agent2 = await db.agent.create({ data: { urn: `${f.org.urn}:agent2`, name: 'agent2', organizationId: f.org.id, systemMemoryId: system2.id } });
    // The unreachable item is listed FIRST (items are created in this order), so a store that keyed every candidate by the
    // batch's first answer would drop the reachable one; App 2's Agent overlaps App 1 on the reachable item and adds one more.
    await db.agentMemoryItem.deleteMany({ where: { agentId: f.agent.id } });
    for (const m of [f.unreachable, f.reachable, pub]) await db.agentMemoryItem.create({ data: { agentId: f.agent.id, memoryId: m.id, role: 'read-write' } });
    for (const m of [f.reachable, pub]) await db.agentMemoryItem.create({ data: { agentId: agent2.id, memoryId: m.id, role: 'read-write' } });
    const { app: app2 } = await createDbAppWithKey(db, 'second', f.org.id);
    await db.appAgent.create({ data: { appId: app2.id, agentId: agent2.id } });
    await db.appMember.create({ data: { appId: app2.id, userId: f.user.id, role: 'member' } });
    const access = await getPrincipalAppMemoryAccess(db, { userId: f.user.id });
    expect(access.get(f.reachable.id)).toBe('READ_WRITE'); // the contributor writes the org memory
    expect(access.get(pub.id)).toBe('READ_ONLY'); // PUBLIC without a subscription is only read, even under a read-write item
    expect(access.has(f.unreachable.id)).toBe(false);
  });
});
