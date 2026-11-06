/**
 * #3509 (cor:agt:100:03 r7, ruling 0185): OVERDUE means the worker was REACHED and did not respond.
 *
 * A worker with an enabled ticker subscription is judged on the wakes actually delivered to it
 * (`worker_delivery_ticks.acked_at`), not on a cadence: OVERDUE when a wake was delivered after the clock start,
 * no check of a channel that ticker covers has followed, and more than 5 minutes have passed. The response is held
 * on the same row (`responded_at`), written by a check and cleared by a newer delivery. A worker with no enabled
 * ticker keeps the settings timer. Delivered rows are seeded directly: real wake delivery is not reachable here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from './id.js';
import { WORKER_SIGNATURE_DEFAULTS } from './workerSignature.js';
import { ensureChannelWithRoot } from './channels.js';
import { loadWorkerCheckStatuses } from './workerCheckStatus.js';
import { stampChannelCheck, stampTeamChannelChecks } from './channelReadState.js';
import { evaluateDarkWorkers } from './agentTasks/darkWorker.js';
import { acknowledgeWakes } from './tickers/acknowledge.js';
import { signWakeProof, type WakeProof } from './tickers/wakeProof.js';
import type { Context } from '../api/graphql/schema/resolvers.helpers.js';

vi.mock('../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const MIN = 60_000;
const T0 = new Date();
const at = (m: number) => new Date(T0.getTime() + m * MIN);

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
  org = await db.organization.create({ data: { id: generateId(), name: 'o3509', urn: `o3509-${suffix}.com` } });
  user = await db.user.create({ data: { id: generateId(), githubId: 350_900 + Math.floor(Math.random() * 1000), githubUsername: `u3509-${suffix}`, roles: ['READER'] } });
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
    data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name: 'Liam', slug: 'liam', role: 'engineer', heldByUserId: user.id, heldAt: new Date() },
    select: { id: true },
  });
  await db.registerEntry.create({ data: { id: generateId(), appId: app.id, channelId: team.id, attendeeWorkerId: worker.id, role: 'BOTH' } });
});

/** A live session started `minutesAgo` before T0 and an open task, so the worker is expected to check. */
async function seat(sessionStartedMinutesAgo: number) {
  await db.session.create({ data: { id: generateId(), appId: app.id, userId: user.id, workerId: worker.id, agentId: agent.id, type: 'DEVELOPER', startedAt: at(-sessionStartedMinutesAgo), updatedAt: at(-1) } });
  await db.agentTask.create({ data: { appId: app.id, title: 'T', ownerUserId: user.id, assigneeWorkerId: worker.id, assignedAt: at(-sessionStartedMinutesAgo) } });
}
async function ticker(cadenceMinutes: number, over: Record<string, unknown> = {}) {
  const t = await db.ticker.create({ data: { tickCode: 'tick.fixture', id: generateId(), appId: app.id, ownerUserId: user.id, name: `T${cadenceMinutes}`, slug: `t${cadenceMinutes}-${generateId().slice(-4)}`, cadenceSeconds: cadenceMinutes * 60, anchorAt: at(-600), ...over } });
  await db.tickerSubscription.create({ data: { tickerId: t.id, workerId: worker.id } });
  return t;
}
/** A wake delivered to the worker at `minutes` (relative to T0) for this ticker. */
const delivered = (tickerId: string, minutes: number, k = 1) =>
  db.workerDeliveryTick.create({ data: { workerId: worker.id, tickerId, lastAckedTick: k, ackedAt: at(minutes), ackedByUserId: user.id } });
const status = async (now: Date) => (await loadWorkerCheckStatuses(db, { appId: app.id, teamChannelId: team.id, now })).get(worker.id)!.status;
const alarms = () => db.agentTeamEvent.findMany({ where: { subjectWorkerId: worker.id, type: 'alarm.dark-worker' } });
const responded = (tickerId: string) => db.$queryRaw<Array<{ r: Date | null }>>`SELECT responded_at AS r FROM worker_delivery_ticks WHERE worker_id = ${worker.id} AND ticker_id = ${tickerId}`.then((r) => r[0]?.r ?? null);

describe('#3509 OVERDUE is measured from a delivered wake', () => {
  it('row 1: a worker on a 30-minute ticker that answers each wake never reads OVERDUE and raises no alarm', async () => {
    await seat(120);
    const t = await ticker(30);
    for (const [wake, now] of [[-1, 28], [29, 58], [59, 88]] as const) {
      await delivered(t.id, wake, wake + 2);
      await stampChannelCheck(db, worker.id, team.id); // the check follows the wake; its DB-clock time is T0-ish
      await db.$executeRaw`UPDATE worker_delivery_ticks SET responded_at = ${at(wake + 1)}::timestamp WHERE worker_id = ${worker.id}`;
      expect(await status(at(now))).toBe('OK');
      await evaluateDarkWorkers(db, at(now));
    }
    expect(await alarms()).toHaveLength(0);
  });

  it('row 2: a delivered wake not answered within 5 minutes reads OVERDUE, with one alarm for the episode', async () => {
    await seat(12); // settings timer alone (25 min) would still say OK
    const t = await ticker(30);
    await delivered(t.id, -10);
    expect(await status(at(0))).toBe('OVERDUE');
    await evaluateDarkWorkers(db, at(0));
    await evaluateDarkWorkers(db, at(1));
    expect((await alarms()).filter((e) => (e.payload as any)?.reason === 'overdue')).toHaveLength(1);
  });

  it('row 2: OK at exactly 5 minutes after the delivery, OVERDUE one millisecond later', async () => {
    await seat(12);
    const t = await ticker(30);
    await delivered(t.id, -5);
    expect(await status(at(0))).toBe('OK');
    expect(await status(new Date(T0.getTime() + 1))).toBe('OVERDUE');
  });

  it('row 3: a check clears it (the response lands on the ticker row)', async () => {
    await seat(12);
    const t = await ticker(30);
    await delivered(t.id, -10);
    expect(await status(at(0))).toBe('OVERDUE');
    expect(await stampChannelCheck(db, worker.id, team.id)).toBe(true);
    expect(await responded(t.id)).not.toBeNull();
    expect(await status(at(1))).toBe('OK');
  });

  it('row 4: a worker on a ticker that has never been delivered a wake is not OVERDUE', async () => {
    await seat(120); // main: 120 min since the session started > 25 min => OVERDUE
    await ticker(30);
    expect(await status(at(0))).toBe('OK');
  });

  it('row 5: an old delivery from before the clock start (a new session) does not count', async () => {
    const t = await ticker(30);
    await delivered(t.id, -200);
    await seat(12);
    expect(await status(at(0))).toBe('OK');
  });

  it('row 6: each ticker is judged on its own wakes', async () => {
    await seat(120);
    const slow = await ticker(30);
    const fast = await ticker(5);
    await delivered(slow.id, -3);
    await delivered(fast.id, -3);
    expect(await status(at(0))).toBe('OK'); // both inside the 5 minutes
    await stampChannelCheck(db, worker.id, team.id); // answers both
    await delivered(fast.id, 10, 2); // a newer fast wake, unanswered
    expect(await status(at(14))).toBe('OK');
    expect(await status(at(16))).toBe('OVERDUE'); // the fast ticker's own silence
    await db.$executeRaw`UPDATE worker_delivery_ticks SET responded_at = ${at(17)}::timestamp WHERE ticker_id = ${fast.id}`;
    expect(await status(at(18))).toBe('OK'); // and its answer clears it; the slow ticker's earlier answer stands
  });

  it('row 7: a check fills the response only on tickers covering that channel (none named = the team channel)', async () => {
    await seat(120);
    const everywhere = await ticker(30);
    const onTeam = await ticker(30, { channelIds: [team.id] });
    const elsewhere = await ticker(30, { channelIds: [other.id] });
    for (const t of [everywhere, onTeam, elsewhere]) await delivered(t.id, -10);
    await stampChannelCheck(db, worker.id, team.id);
    expect(await responded(everywhere.id)).not.toBeNull();
    expect(await responded(onTeam.id)).not.toBeNull();
    expect(await responded(elsewhere.id)).toBeNull();
  });

  it('row 7: the inbox read (every team channel of the App) fills it too', async () => {
    await seat(120);
    const t = await ticker(30);
    await delivered(t.id, -10);
    expect(await stampTeamChannelChecks(db, worker.id)).toBe(1);
    expect(await responded(t.id)).not.toBeNull();
  });

  it('row 8: PENDING (no task) and NO_SESSION still win over a delivered, unanswered wake', async () => {
    const t = await ticker(30);
    await delivered(t.id, -10);
    expect(await status(at(0))).toBe('NO_SESSION');
    await db.session.create({ data: { id: generateId(), appId: app.id, userId: user.id, workerId: worker.id, agentId: agent.id, type: 'DEVELOPER', startedAt: at(-30), updatedAt: at(-1) } });
    expect(await status(at(0))).toBe('PENDING'); // no task
  });

  it('row 9: an every-tick wake expects a response too', async () => {
    await seat(12);
    const t = await ticker(30, { reasons: ['every-tick'] });
    await delivered(t.id, -10);
    expect(await status(at(0))).toBe('OVERDUE');
  });

  it('row 10: a worker with no enabled ticker keeps the settings timer', async () => {
    await seat(120);
    await db.app.update({ where: { id: app.id }, data: { deliveryCheckPeriodSeconds: 600, deliveryFailedChecksToOverdue: 2 } });
    await db.session.updateMany({ where: { workerId: worker.id }, data: { startedAt: at(-25) } });
    await db.agentTask.updateMany({ where: { assigneeWorkerId: worker.id }, data: { assignedAt: at(-25) } });
    expect(await status(at(0))).toBe('OK'); // exactly 25 minutes
    expect(await status(new Date(T0.getTime() + 1))).toBe('OVERDUE');
  });

  it('row 10: a disabled ticker does not count as a ticker subscription', async () => {
    await seat(120);
    const t = await ticker(30, { enabled: false });
    await delivered(t.id, -1);
    expect(await status(at(0))).toBe('OVERDUE'); // settings timer: 120 min > 25
  });
});

describe('#3509 the response column and the acknowledgement write path', () => {
  const ctx = (): Context => ({ db, userId: user.id, roles: ['ADMIN'] });
  const proof = (tickerId: string, k: number, issuedAt: number, wakeKey: string) => signWakeProof({
    v: 3, kind: 'wake-proof', appId: app.id, workerId: worker.id, requester: { userId: user.id },
    channels: [], ticks: [{ tickerId, k }], tasks: [], exempt: false, issuedAt, wakeKey,
  } satisfies WakeProof);
  const ack = (p: string, now: Date) => acknowledgeWakes({ ctx: ctx(), requester: { userId: user.id }, proofs: [p], now, mayReadWorker: async () => true });

  it('a newer delivery clears the previous response; a repeat of the same one does not', async () => {
    const t = await ticker(30);
    const n = new Date();
    await ack(proof(t.id, 1, n.getTime() - 1000, 'w1'), n);
    await stampChannelCheck(db, worker.id, team.id);
    expect(await responded(t.id)).not.toBeNull();
    await ack(proof(t.id, 1, n.getTime() - 500, 'w1b'), new Date(n.getTime() + 1000)); // same tick: nothing moves
    expect(await responded(t.id)).not.toBeNull();
    await ack(proof(t.id, 2, n.getTime() + 1000, 'w2'), new Date(n.getTime() + 2000));
    expect(await responded(t.id)).toBeNull();
  });

  it('a refused (stale) proof writes no delivery and no response', async () => {
    const t = await ticker(30);
    const n = new Date();
    await expect(ack(proof(t.id, 1, n.getTime() + 61_000, 'stale'), n)).rejects.toMatchObject({ extensions: { code: 'WAKE_PROOF_STALE' } });
    expect(await db.workerDeliveryTick.count({ where: { workerId: worker.id } })).toBe(0);
  });
});
