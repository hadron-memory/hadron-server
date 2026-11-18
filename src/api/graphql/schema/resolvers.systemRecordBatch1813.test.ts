/**
 * #1813 — a record list batches the system-memory grant lookups without changing one verdict.
 *
 * `canReadMemoryRecord` ran the whole grant fold once per system record, and the fold itself loops the
 * caller's Apps, so a list cost records x Apps queries. The batch memoizes the principal-keyed lookups for the
 * life of ONE list. This is the read gate for system memory records (cor:dmo:050:03/:13, #1807), so the proof
 * is a differential: for every audience, the batched list answers exactly what the unbatched point read does.
 *
 * What stays linear on purpose (asserted as a bound, not as O(1)): the per-record memory, Agent and org rows,
 * and the install-memory row checks.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import type { Context } from './resolvers.js';
import { canReadMemoryRecord, filterReadableMemoryRecords } from './resolvers.helpers.js';

type Row = Awaited<ReturnType<typeof db.memory.create>>;

let orgId: string;
let foreignOrgId: string;
let users: Record<string, string>;
let apps: string[];
let rows: Row[];
let agents: string[];

/** A db whose every model operation is counted — the only handle the gate sees, so every query it makes is. */
function counted() {
  const counter = { n: 0 };
  const client = db.$extends({
    query: { $allOperations: ({ args, query }) => { counter.n += 1; return query(args); } },
  }) as unknown as typeof db;
  return { client, counter };
}

async function build(records: number, appCount: number) {
  await cleanDb(db);
  const org = await db.organization.create({ data: { name: 'Batch 1813', urn: 'batch1813.test' } });
  const foreign = await db.organization.create({ data: { name: 'Foreign 1813', urn: 'foreign1813.test' } });
  orgId = org.id;
  foreignOrgId = foreign.id;
  users = {};
  const mk = async (handle: string, role: 'ADMIN' | 'READER', roles: string[] = ['READER']) => {
    const user = await db.user.create({ data: { handle: `b1813-${handle}`, roles: roles as never } });
    await db.orgMember.create({ data: { organizationId: orgId, userId: user.id, role } });
    users[handle] = user.id;
  };
  await mk('manager', 'ADMIN');
  await mk('participant', 'READER');
  await mk('reader', 'READER');
  await mk('platform', 'READER', ['ADMIN']);

  apps = [];
  for (let a = 0; a < appCount; a++) {
    const app = await db.app.create({ data: { name: `App ${a}`, urn: `batch1813.test:app${a}`, organizationId: orgId } });
    apps.push(app.id);
    await db.appMember.create({ data: { appId: app.id, userId: users.participant, role: 'member' } });
  }
  rows = [];
  agents = [];
  for (let i = 0; i < records; i++) {
    const memory = await db.memory.create({ data: { name: `Sys ${i}`, urn: `batch1813.test:sys${i}`, organizationId: orgId, class: 'system' } });
    const agent = await db.agent.create({ data: { name: `Agent ${i}`, urn: `batch1813.test:agent${i}`, organizationId: orgId, systemMemoryId: memory.id } });
    for (const appId of apps) await db.appAgent.create({ data: { appId, agentId: agent.id } });
    rows.push(memory);
    agents.push(agent.id);
  }
}

const ctxOf = (who: string, extra: Partial<Context> = {}): Context =>
  ({ db, userId: users[who], roles: who === 'platform' ? ['ADMIN'] : ['READER'], ...extra });

/** The unbatched per-row answer: the gate the list must agree with. */
const pointIds = async (ctx: Context, candidates: Row[]) => {
  const verdicts = await Promise.all(candidates.map(row => canReadMemoryRecord(ctx, row)));
  return candidates.filter((_, i) => verdicts[i]).map(row => row.id);
};
const listIds = async (ctx: Context, candidates: Row[]) =>
  (await filterReadableMemoryRecords(ctx, candidates)).map(row => row.id);

describe('#1813 batched system-record list vs per-row gate', () => {
  beforeEach(async () => { await build(3, 2); });

  it.each(['manager', 'participant', 'reader', 'platform'])('%s: the list answers exactly what the point read does', async who => {
    const ctx = ctxOf(who);
    expect(await listIds(ctx, rows)).toEqual(await pointIds(ctx, rows));
  });

  it('positive and denied controls: the participant and the manager read all, the plain reader none', async () => {
    const all = rows.map(r => r.id);
    expect(await listIds(ctxOf('participant'), rows)).toEqual(all);
    expect(await listIds(ctxOf('manager'), rows)).toEqual(all);
    expect(await listIds(ctxOf('reader'), rows)).toEqual([]);
  });

  it('a mixed list keeps each record on its own verdict', async () => {
    // One record whose Agent is not installed anywhere: the participant loses exactly that one.
    await db.appAgent.deleteMany({ where: { agentId: agents[1] } });
    const ctx = ctxOf('participant');
    const ids = await listIds(ctx, rows);
    expect(ids).toEqual([rows[0].id, rows[2].id]);
    expect(ids).toEqual(await pointIds(ctx, rows));
  });

  it('tenant pairing: a manager of org A is not admitted to a memory the Agent pointer pairs with org B', async () => {
    const stray = await db.memory.create({ data: { name: 'Stray', urn: 'foreign1813.test:stray', organizationId: foreignOrgId, class: 'system' } });
    // The Agent is org A's, its pointer names org B's memory: a mismatched tenant is no admission path.
    await db.agent.create({ data: { name: 'Mismatch', urn: 'batch1813.test:mismatch', organizationId: orgId, systemMemoryId: stray.id } });
    const ctx = ctxOf('manager');
    expect(await pointIds(ctx, [stray])).toEqual([]);
    expect(await listIds(ctx, [stray])).toEqual([]);
    expect(await listIds(ctx, [...rows, stray])).toEqual(rows.map(r => r.id));
  });

  it('impersonation scopes get their own answer: the org restriction survives the all-memories manager call', async () => {
    const inside = ctxOf('manager', { impersonation: { orgId } } as Partial<Context>);
    const outside = ctxOf('manager', { impersonation: { orgId: foreignOrgId } } as Partial<Context>);
    expect(await listIds(inside, rows)).toEqual(await pointIds(inside, rows));
    expect(await listIds(outside, rows)).toEqual(await pointIds(outside, rows));
    expect(await listIds(outside, rows)).toEqual([]);
  });

  it('a revocation committed between two lists is seen by the second (no cross-request memo)', async () => {
    const ctx = ctxOf('participant');
    expect(await listIds(ctx, rows)).toHaveLength(3);
    await db.appMember.deleteMany({ where: { userId: users.participant } });
    expect(await listIds(ctx, rows)).toEqual(await pointIds(ctx, rows));
    expect(await listIds(ctx, rows)).toEqual([]);
  });
});

describe('#1813 query count', () => {
  /** Queries one participant list read costs, for `records` system records across `appCount` Apps. */
  async function listCost(records: number, appCount: number) {
    await build(records, appCount);
    const { client, counter } = counted();
    const ids = await listIds({ ...ctxOf('participant'), db: client }, rows);
    expect(ids).toHaveLength(records);
    return counter.n;
  }

  it('the marginal cost of one more record does not grow with the number of Apps', async () => {
    // Per-record rows (memory, Agent, org) stay linear in records; the App fold must not.
    const perRecord = async (appCount: number) => ((await listCost(6, appCount)) - (await listCost(2, appCount))) / 4;
    const few = await perRecord(1);
    const many = await perRecord(4);
    expect(many).toBeLessThanOrEqual(few + 1);
    expect(many).toBeLessThanOrEqual(5);
  });

  it('the fixed cost does not multiply records by Apps', async () => {
    const small = await listCost(2, 2);
    const large = await listCost(8, 4);
    // Linear in records (<=5 per record) plus a bounded App-dependent constant; records x Apps would be far beyond this.
    expect(large).toBeLessThanOrEqual(small + 6 * 5 + 4 * 12);
  });
});
