import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
/**
 * #2949 — an unchanged outstanding due wake is handed out again EXACTLY (dueWakes.ts, "handed out AGAIN, exactly"):
 * its TICK reasons come out in one stable order, whatever order the subscription rows come back in, so the proof is
 * byte-identical and the reservation row keeps its stored wake. Identity, budget and acknowledgement were already
 * order-insensitive (wakeIdentity sorts), so an acknowledgement of a proof listing the ticks in another order still
 * acknowledges, and a genuinely new reason still joins the outstanding wake.
 *
 * The subscription read has no ORDER BY. At a small fixture the planner walks `ticker_subscriptions_live_uniq`, which
 * happens to yield ticker-id order; at production scale it may scan the heap (QA saw 4 of 99 polls reordered at 83
 * tickers). `rowsIn` stands in for that plan: the same rows, handed back in another order.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { ensureChannelWithRoot } from '../channels.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { teamChatMutations } from '../../api/graphql/schema/resolvers.teamChat.js';
import { computeDueWakes } from './dueWakes.js';
import { signWakeProof, verifyWakeProof } from './wakeProof.js';

vi.mock('../bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const M = resolvers.Mutation as any;
const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] }) as Context;

let org: { id: string; urn: string };
let manager: { id: string };
let holder: { id: string };
let app: { id: string };
let agent: { id: string };
let liam: { id: string };
let post: ReturnType<typeof vi.spyOn>;

async function mkUser(n: number) {
  return db.user.create({ data: { id: generateId(), githubId: 97_900 + n, githubUsername: `ro-${n}-${Date.now()}-${Math.floor(Math.random() * 1e5)}`, roles: ['READER'] }, select: { id: true } });
}
const mkTicker = (name: string, over: Record<string, unknown> = {}) =>
  db.ticker.create({ data: { tickCode: 'tick.fixture', id: generateId(), appId: app.id, ownerUserId: manager.id, name, slug: `ro-${generateId().slice(-6)}`, cadenceSeconds: 600, anchorAt: new Date(Date.now() - 3600_000), reasons: ['every-tick'], ...over } });
const subscribe = (tickerId: string) =>
  db.tickerSubscription.create({ data: { id: generateId(), tickerId, workerId: liam.id, createdBy: manager.id } });

/** Moves one subscription row to the end of the table (delete and re-insert, same id), as subscription churn can. */
async function moveToEnd(tickerId: string): Promise<void> {
  const row = await db.tickerSubscription.findFirstOrThrow({ where: { tickerId, workerId: liam.id } });
  await db.tickerSubscription.delete({ where: { id: row.id } });
  await db.tickerSubscription.create({ data: row });
}
const physicalOrder = async () =>
  (await db.$queryRaw<Array<{ ticker_id: string }>>`SELECT ticker_id FROM ticker_subscriptions WHERE worker_id = ${liam.id}`).map((r) => r.ticker_id);

/**
 * A context whose subscription read returns the same rows in the order `arrange` picks, as a heap-order plan would.
 * Everything else reads through the real client.
 */
function rowsIn(arrange: (rows: Array<{ tickerId: string }>) => Array<{ tickerId: string }>): Context {
  const subs = new Proxy(db.tickerSubscription, {
    get(target, prop, recv) {
      if (prop !== 'findMany') return Reflect.get(target, prop, recv);
      return async (args: unknown) => arrange(await (target.findMany as (a: unknown) => Promise<Array<{ tickerId: string }>>)(args));
    },
  });
  const client = new Proxy(db, { get: (t, p, r) => (p === 'tickerSubscription' ? subs : Reflect.get(t, p, r)) });
  return { ...ctx(manager.id), db: client as typeof db };
}
const byId = (rows: Array<{ tickerId: string }>) => [...rows].sort((a, b) => a.tickerId.localeCompare(b.tickerId));
const reversed = (rows: Array<{ tickerId: string }>) => byId(rows).reverse();

const NOW = new Date(Date.now() + 1000);
const read = (now = NOW, c: Context = ctx(manager.id)) => computeDueWakes({ ctx: c, app: { id: app.id, organizationId: org.id, ownerUserId: null }, reader: { manager: true, userId: manager.id }, requester: { userId: manager.id }, now });
const tickOrder = (proof: string) => verifyWakeProof(proof).ticks.map((t) => t.tickerId);
const reasonOrder = (wake: { reasons: Array<{ kind: string; tickerId?: string }> }) => wake.reasons.filter((r) => r.kind === 'TICK').map((r) => r.tickerId);
const reservation = () => db.appWakeReservation.findUniqueOrThrow({ where: { workerId: liam.id } });

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({ data: { id: generateId(), name: 'ro-org', urn: `ro-org-${suffix}.com` } });
  [manager, holder] = [await mkUser(1), await mkUser(2)];
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: manager.id, role: 'ADMIN' } });
  agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team`, visibility: 'ORGANIZATION' } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  await db.appMember.create({ data: { appId: app.id, userId: holder.id, role: 'member' } });
  const memory = await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:team-shared`, name: 'shared', class: 'app', appId: app.id, sharedMemoryOfAgentId: agent.id } });
  const ch = await ensureChannelWithRoot(db, { memoryId: memory.id, loc: 'chats:team', name: 'team', createdBy: manager.id });
  liam = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name: 'Liam', slug: 'liam', heldByUserId: holder.id, heldAt: new Date() }, select: { id: true } });
  await db.registerEntry.create({ data: { id: generateId(), appId: app.id, channelId: ch.channel.id, attendeeWorkerId: liam.id, role: 'BOTH' } });
  post = vi.spyOn(teamChatMutations, 'createTeamChatMessage').mockResolvedValue({} as never);
});
afterEach(() => post.mockRestore());

describe('#2949 an unchanged outstanding wake is re-handed byte-identical', () => {
  it('the subscription rows come back in another order on the next read: same proof, same reason order, same stored wake', async () => {
    const tickers = [await mkTicker('A'), await mkTicker('B'), await mkTicker('C')];
    for (const t of tickers) await subscribe(t.id);
    const first = await read(NOW, rowsIn(byId));
    expect(first.wakes).toHaveLength(1);
    const before = await reservation();

    const again = await read(NOW, rowsIn(reversed));
    expect(again.wakes).toHaveLength(1);
    expect(again.wakes[0]!.proof).toBe(first.wakes[0]!.proof);
    expect(reasonOrder(again.wakes[0]!.wake as never)).toEqual(reasonOrder(first.wakes[0]!.wake as never));
    const after = await reservation();
    expect(after.wakeKey).toBe(before.wakeKey);
    expect(JSON.stringify(after.wake)).toBe(JSON.stringify(before.wake));
    expect(after.absorbedKeys).toEqual(before.absorbedKeys);
  });

  it('control on the real plan: a subscription row physically moved to the end of the table between two reads', async () => {
    const tickers = [await mkTicker('A'), await mkTicker('B'), await mkTicker('C')];
    for (const t of tickers) await subscribe(t.id);
    const first = await read();
    expect(first.wakes).toHaveLength(1);
    const before = await reservation();

    // Churn: the first-read row order is no longer the table's order.
    const firstTickOrder = tickOrder(first.wakes[0]!.proof);
    const was = await physicalOrder();
    await moveToEnd(firstTickOrder[0]!);
    expect(await physicalOrder()).not.toEqual(was);

    const again = await read();
    expect(again.wakes).toHaveLength(1);
    expect(again.wakes[0]!.proof).toBe(first.wakes[0]!.proof);
    expect(reasonOrder(again.wakes[0]!.wake as never)).toEqual(reasonOrder(first.wakes[0]!.wake as never));
    const after = await reservation();
    expect(after.wakeKey).toBe(before.wakeKey);
    expect(JSON.stringify(after.wake)).toBe(JSON.stringify(before.wake));
    expect(after.absorbedKeys).toEqual(before.absorbedKeys);
  });

  it('the order is the tickers\' id order, whatever order the rows were inserted in', async () => {
    const tickers = [await mkTicker('A'), await mkTicker('B'), await mkTicker('C'), await mkTicker('D')];
    for (const t of [...tickers].reverse()) await subscribe(t.id);
    const { wakes } = await read(NOW, rowsIn(reversed));
    const sorted = tickers.map((t) => t.id).sort();
    expect(tickOrder(wakes[0]!.proof)).toEqual(sorted);
    expect(reasonOrder(wakes[0]!.wake as never)).toEqual(sorted);
  });

  it('a proof listing the same ticks in another order still acknowledges the outstanding wake, once', async () => {
    const tickers = [await mkTicker('A'), await mkTicker('B')];
    for (const t of tickers) await subscribe(t.id);
    const { wakes } = await read();
    const p = verifyWakeProof(wakes[0]!.proof);
    const reordered = signWakeProof({ ...p, ticks: [...p.ticks].reverse() });
    expect(reordered).not.toBe(wakes[0]!.proof);
    const ack = await M.acknowledgeWakes({}, { proofs: [reordered] }, ctx(manager.id));
    expect(ack.acknowledged).toBe(1);
    for (const t of tickers) {
      const row = await db.workerDeliveryTick.findFirstOrThrow({ where: { workerId: liam.id, tickerId: t.id } });
      expect(row.lastAckedTick).toBeGreaterThanOrEqual(1);
    }
    const days = await db.appWakeDay.findMany({ where: { appId: app.id } });
    expect(days.reduce((n, d) => n + d.wakes, 0)).toBe(1);
  });

  it('a genuinely new reason still joins the outstanding wake (absorb path unchanged), in the stable order', async () => {
    const [a, b] = [await mkTicker('A'), await mkTicker('B')];
    await subscribe(a.id);
    const first = await read();
    expect(tickOrder(first.wakes[0]!.proof)).toEqual([a.id]);
    await subscribe(b.id);
    const again = await read();
    expect(again.wakes).toHaveLength(1);
    expect(tickOrder(again.wakes[0]!.proof)).toEqual([a.id, b.id].sort());
    const res = await reservation();
    expect(res.absorbedKeys).toContain(verifyWakeProof(first.wakes[0]!.proof).wakeKey);
  });
});
