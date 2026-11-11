/**
 * #3680 (cor:agt:100:03 rev 12, Vera's V78 under ruling 0265): a wake is answered by a check of a channel its ticker
 * covers made at or after the wake was ISSUED (the proof's server-signed issuedAt, taken as no later than the server's
 * clock at the acknowledgement). Acknowledging a wake never erases a check made since it was issued.
 *
 * The defect: the host types a wake, waits ~30s for the terminal to confirm the submit, then acknowledges it. A worker
 * that read the team channel inside that gap had its response stamped on the PREVIOUS tick's row, and the ack's
 * "newer delivery starts a new wait" reset it to NULL, so the worker read OVERDUE five minutes later (Xylon 3/3 on
 * 2026-11-11, issue comment 6791008971).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
import { ensureChannelWithRoot } from '../channels.js';
import { loadWorkerCheckStatuses } from '../workerCheckStatus.js';
import { stampChannelCheck } from '../channelReadState.js';
import { acknowledgeWakes } from './acknowledge.js';
import { signWakeProof, type WakeProof } from './wakeProof.js';
import type { Context } from '../../api/graphql/schema/resolvers.helpers.js';

vi.mock('../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const MIN = 60_000;

let org: { id: string; urn: string };
let app: { id: string };
let user: { id: string };
let agent: { id: string };
let team: { id: string };
let other: { id: string };
let worker: { id: string };

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({ data: { id: generateId(), name: 'o3680', urn: `o3680-${suffix}.com` } });
  user = await db.user.create({ data: { id: generateId(), githubId: 368_000 + Math.floor(Math.random() * 1000), githubUsername: `u3680-${suffix}`, roles: ['READER'] } });
  agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'Eng', urn: `${org.urn}:eng`, visibility: 'ORGANIZATION' } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'ADMIN' } });
  await db.appMember.create({ data: { appId: app.id, userId: user.id, role: 'member' } });
  const memory = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:shared`, name: 'shared', class: 'app', appId: app.id, sharedMemoryOfAgentId: agent.id },
  });
  team = (await ensureChannelWithRoot(db, { memoryId: memory.id, loc: 'chats:team', name: 'team', createdBy: user.id, asDefaultOfAppId: app.id })).channel;
  other = (await ensureChannelWithRoot(db, { memoryId: memory.id, loc: 'chats:other', name: 'other', createdBy: user.id })).channel;
  worker = await db.worker.create({
    data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name: 'Xyla', slug: 'xyla', role: 'engineer', heldByUserId: user.id, heldAt: new Date() },
    select: { id: true },
  });
  await db.registerEntry.create({ data: { id: generateId(), appId: app.id, channelId: team.id, attendeeWorkerId: worker.id, role: 'BOTH' } });
  // A live session and an open task from well before the test, so the worker is expected to check.
  const start = new Date(Date.now() - 120 * MIN);
  await db.session.create({ data: { id: generateId(), appId: app.id, userId: user.id, workerId: worker.id, agentId: agent.id, type: 'DEVELOPER', startedAt: start, updatedAt: new Date() } });
  await db.agentTask.create({ data: { appId: app.id, title: 'T', ownerUserId: user.id, assigneeWorkerId: worker.id, assignedAt: start } });
});

async function ticker(over: Record<string, unknown> = {}) {
  const t = await db.ticker.create({ data: { tickCode: 'tick.fixture', id: generateId(), appId: app.id, ownerUserId: user.id, name: `T-${generateId().slice(-6)}`, slug: `t-${generateId().slice(-6)}`, cadenceSeconds: 1800, anchorAt: new Date(Date.now() - 600 * MIN), ...over } });
  await db.tickerSubscription.create({ data: { tickerId: t.id, workerId: worker.id } });
  return t;
}
const ctx = (): Context => ({ db, userId: user.id, roles: ['ADMIN'] });
const proof = (tickerId: string, k: number, issuedAt: number) => signWakeProof({
  v: 3, kind: 'wake-proof', appId: app.id, workerId: worker.id, requester: { userId: user.id },
  channels: [], ticks: [{ tickerId, k }], tasks: [], exempt: false, issuedAt, wakeKey: `w-${tickerId}-${k}-${issuedAt}`,
} satisfies WakeProof);
const ack = (p: string, now = new Date()) => acknowledgeWakes({ ctx: ctx(), requester: { userId: user.id }, proofs: [p], now, mayReadWorker: async () => true });
const responded = (tickerId: string) => db.$queryRaw<Array<{ r: Date | null }>>`SELECT responded_at AS r FROM worker_delivery_ticks WHERE worker_id = ${worker.id} AND ticker_id = ${tickerId}`.then((r) => r[0]?.r ?? null);
const status = async (now: Date) => (await loadWorkerCheckStatuses(db, { appId: app.id, teamChannelId: team.id, now })).get(worker.id)!.status;
/** The database clock, which stamps checks; issue times are compared against it. */
const dbNow = async () => (await db.$queryRaw<Array<{ n: Date }>>`SELECT now() AS n`)[0]!.n;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('#3680 the acknowledgement keeps a response made since the wake was issued', () => {
  it('a check between the wake\'s issue and its (later) ack answers it: the worker stays OK past 5 minutes', async () => {
    const t = await ticker();
    await ack(proof(t.id, 1, Date.now() - 60_000)); // an earlier tick, delivered
    const issued = Date.now() - 1000; // the new wake is issued, typed ...
    await sleep(20);
    expect(await stampChannelCheck(db, worker.id, team.id)).toBe(true); // ... the worker reads the channel at once ...
    await sleep(20);
    await ack(proof(t.id, 2, issued)); // ... and only then does the host's ack land
    expect(await responded(t.id)).not.toBeNull();
    expect(await status(new Date(Date.now() + 6 * MIN))).toBe('OK');
  });

  it('the first delivery of a ticker keeps a check made since its issue too', async () => {
    const t = await ticker();
    const issued = Date.now() - 1000;
    await sleep(20);
    await stampChannelCheck(db, worker.id, team.id);
    await sleep(20);
    await ack(proof(t.id, 1, issued));
    expect(await responded(t.id)).not.toBeNull();
    expect(await status(new Date(Date.now() + 6 * MIN))).toBe('OK');
  });

  it('control: a check BEFORE the wake was issued never answers it (OVERDUE after 5 minutes)', async () => {
    const t = await ticker();
    await ack(proof(t.id, 1, Date.now() - 60_000));
    await stampChannelCheck(db, worker.id, team.id);
    await sleep(50);
    const issued = (await dbNow()).getTime() + 20; // issued after the check, on the same clock
    await sleep(40);
    await ack(proof(t.id, 2, issued));
    expect(await responded(t.id)).toBeNull();
    expect(await status(new Date(Date.now() + 6 * MIN))).toBe('OVERDUE');
  });

  it('a check since the issue answers only tickers covering that channel', async () => {
    const elsewhere = await ticker({ channelIds: [other.id] });
    const onTeam = await ticker({ channelIds: [team.id] });
    const issued = Date.now() - 1000;
    await sleep(20);
    await stampChannelCheck(db, worker.id, team.id);
    await sleep(20);
    await ack(proof(elsewhere.id, 1, issued));
    await ack(proof(onTeam.id, 1, issued));
    expect(await responded(elsewhere.id)).toBeNull();
    expect(await responded(onTeam.id)).not.toBeNull();
  });

  it('a check by ANOTHER worker since the issue does not answer this worker\'s wake', async () => {
    const t = await ticker();
    const peer = await db.worker.create({
      data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name: 'Peer', slug: 'peer', role: 'engineer', heldByUserId: user.id, heldAt: new Date() },
      select: { id: true },
    });
    const issued = Date.now() - 1000;
    await sleep(20);
    expect(await stampChannelCheck(db, peer.id, team.id)).toBe(true);
    await sleep(20);
    await ack(proof(t.id, 1, issued));
    expect(await responded(t.id)).toBeNull();
  });

  it('an issue time ahead of the server clock is taken as the server clock at the ack', async () => {
    const t = await ticker();
    const now = await dbNow();
    // A check stamped after the ack's own clock reading but before an issuedAt that leads it (the 60s lead #3022 allows).
    await stampChannelCheck(db, worker.id, team.id);
    await db.$executeRaw`UPDATE channel_read_states SET last_checked_at = ((now() AT TIME ZONE 'UTC') + interval '20 seconds') WHERE worker_id = ${worker.id}`;
    await ack(proof(t.id, 1, now.getTime() + 50_000), now);
    expect(await responded(t.id)).not.toBeNull();
  });

  it('a repeat acknowledgement of the same tick still never moves the response', async () => {
    const t = await ticker();
    await ack(proof(t.id, 1, Date.now() - 60_000));
    expect(await responded(t.id)).toBeNull();
    await sleep(20);
    await stampChannelCheck(db, worker.id, team.id);
    const first = await responded(t.id);
    expect(first).not.toBeNull();
    await ack(proof(t.id, 1, Date.now() - 500));
    expect(await responded(t.id)).toEqual(first);
  });
});

// Andi's LOCAL P2 on #3946 at f21d0920 (findings:ack-subquery-snapshot-can-erase-queued-check): the ack's response
// subquery reads its statement's snapshot, so a check still uncommitted when the ack statement starts is invisible to
// it. On an EXISTING delivery row the two then meet on that row's lock, and whichever order they take it in, the
// check made since the issue must survive. A third transaction holds the row so both queue deterministically; the
// queue is observed in pg_stat_activity, not guessed with sleeps.
describe('#3680 a check racing the acknowledgement on an existing delivery row', () => {
  /** Hold the delivery row FOR UPDATE until `release` is called. */
  async function holdRow(tickerId: string) {
    let held!: () => void;
    let release!: () => void;
    const locked = new Promise<void>((r) => { held = r; });
    const gate = new Promise<void>((r) => { release = r; });
    const done = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT worker_id FROM worker_delivery_ticks WHERE worker_id = ${worker.id} AND ticker_id = ${tickerId} FOR UPDATE`;
      held();
      await gate;
    }, { timeout: 20_000 });
    await locked;
    return { release, done };
  }
  /** Wait until a statement containing `fragment` is waiting on a lock. */
  async function queued(fragment: string) {
    const end = Date.now() + 8000;
    while (Date.now() < end) {
      const [{ n }] = await db.$queryRaw<Array<{ n: bigint }>>`
        SELECT count(*)::bigint AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE ${'%' + fragment + '%'}`;
      if (Number(n) > 0) return;
      await sleep(20);
    }
    throw new Error(`never saw a statement queued: ${fragment}`);
  }

  it('the check queues on the row BEFORE the ack: the ack must not overwrite it with its stale snapshot', async () => {
    const t = await ticker();
    await ack(proof(t.id, 1, Date.now() - 60_000));
    const issued = Date.now() - 1000;
    const hold = await holdRow(t.id);
    let check: Promise<boolean> | undefined;
    let delivery: ReturnType<typeof ack> | undefined;
    try {
      check = stampChannelCheck(db, worker.id, team.id);
      await queued('WITH stamped AS'); // its read-state write is done but uncommitted
      delivery = ack(proof(t.id, 2, issued));
      await queued('INSERT INTO worker_delivery_ticks');
    } finally {
      hold.release();
    }
    await hold.done;
    expect(await check).toBe(true);
    await delivery;
    expect(await responded(t.id)).not.toBeNull();
    expect(await status(new Date(Date.now() + 6 * MIN))).toBe('OK');
  });

  it('the ack queues on the row BEFORE the check: the check still answers the newer wake', async () => {
    const t = await ticker();
    await ack(proof(t.id, 1, Date.now() - 60_000));
    const issued = Date.now() - 1000;
    const hold = await holdRow(t.id);
    let check: Promise<boolean> | undefined;
    let delivery: ReturnType<typeof ack> | undefined;
    try {
      delivery = ack(proof(t.id, 2, issued));
      await queued('INSERT INTO worker_delivery_ticks');
      check = stampChannelCheck(db, worker.id, team.id);
      await queued('WITH stamped AS');
    } finally {
      hold.release();
    }
    await hold.done;
    await delivery;
    expect(await check).toBe(true);
    expect(await responded(t.id)).not.toBeNull();
    expect(await status(new Date(Date.now() + 6 * MIN))).toBe('OK');
  });
});
