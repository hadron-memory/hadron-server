/** S7 (#2023): the one standby definition. TS and SQL twins agree row for row; the integration with S1's renderer and S5's enumeration. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '../../generated/prisma/index.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { setS7AvailableForTest } from './s7Availability.js';
import { generateId } from '../id.js';
import type { Context } from '../../api/graphql/schema/resolvers.js';
import { batchProofPayload, loadDeliveryBatches } from './deliveryBatch.js';
import { acknowledgeBatchProofs } from './acknowledge.js';
import { signBatchProof } from './wakeProof.js';
import { enumeratePendingDelivery } from './pendingDelivery.js';
import { raiseDeliveredOnAssignment } from './standbyAssignment.js';
import { loadDeliverySettings } from './deliverySettings.js';
import { setS7AvailableForTest as setAvail } from './s7Availability.js';
import { StandbyCoverageClassifier, standbyAdmits, standbyAdmitsSql, onStandbySql, workerStandby } from './standby.js';

vi.mock('../bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const HEAD = 'head-worker-id';
const ENVELOPES: unknown[] = [
  { mentions: ['target'], authorUserId: 'u1' },                                  // human, direct
  { mentions: ['target'], authorUserId: 'u1', authorWorkerId: null },
  { mentions: ['target'], authorWorkerId: HEAD, authorName: 'Head' },            // head, direct
  { mentions: ['target'], authorWorkerId: 'peer' },                              // peer worker
  { mentions: ['target'], authorSystem: true },                                  // system
  { mentions: ['target'], authorSystem: true, authorUserId: 'u1' },
  { mentions: ['target'] },                                                      // no author at all
  { mentions: ['all'], broadcastWakes: true, authorUserId: 'u1' },               // human broadcast: held
  { mentions: ['all'], broadcastWakes: true, authorWorkerId: HEAD },             // head broadcast: held
  { mentions: ['target', 'all'], broadcastWakes: true, authorWorkerId: HEAD },   // direct + broadcast: direct wins
  { mentions: ['other'], authorUserId: 'u1' },
  { mentions: 'target', authorUserId: 'u1' },
  { authorUserId: 'u1' },
  { mentions: ['target'], authorUserId: 7 },
  { mentions: ['target'], authorWorkerId: 7, authorUserId: 'u1' },
  null, 'garbage', [],
];

describe('standbyAdmits and its SQL twin', () => {
  it('admits only a DIRECT mention from a human or the head', () => {
    expect(ENVELOPES.map((d) => standbyAdmits(d, ['target'], HEAD))).toEqual([
      true, true, true, false, false, false, false, false, false, true, false, false, false, false, true, false, false, false,
    ]);
  });
  it('agrees with standbyAdmits on every row', async () => {
    for (const tokens of [['target'], [], ['target', 'other']]) {
      const values = Prisma.join(ENVELOPES.map((d, i) => Prisma.sql`(${i}::int, ${JSON.stringify(d)}::jsonb)`));
      const got = await db.$queryRaw<Array<{ i: number; hit: boolean | null }>>(Prisma.sql`
        SELECT i, ${standbyAdmitsSql(Prisma.sql`d`, Prisma.sql`${tokens}::text[]`, HEAD)} AS hit FROM (VALUES ${values}) AS v(i, d) ORDER BY i`);
      expect(got.map((r) => r.hit === true), JSON.stringify(tokens)).toEqual(ENVELOPES.map((d) => standbyAdmits(d, tokens, HEAD)));
    }
  });
});

const posted = new Date('2026-10-19T10:00:00Z');
const ready = new Date('2026-10-19T11:00:00Z');
let orgId: string, appId: string, agentId: string, holderId: string, caller: Context, registrationId: string, channelId: string, memoryId: string, rootId: string;
let app: { id: string; urn: string; organizationId: string | null; ownerUserId: string | null };
let n = 0;
const mkWorker = async (name: string, extra: Record<string, unknown> = {}) => {
  const w = await db.worker.create({ data: { id: generateId(), appId, agentId, name, slug: name.toLowerCase(), signature: '', trailer: '', heldByUserId: holderId, heldAt: posted, ...extra } });
  await db.hostRegistrationWorker.create({ data: { registrationId, workerId: w.id, family: 'codex' } });
  await db.registerEntry.create({ data: { id: generateId(), appId, channelId, attendeeWorkerId: w.id, role: 'BOTH' } });
  return w;
};
const say = async (body: string, extra: Record<string, unknown> = {}) => {
  const seq = ++n;
  await db.node.create({ data: { id: generateId(), memoryId, loc: `chats:team:messages:${seq}`, name: `${seq}`, nodeType: 'chat-message', seq, messageChannelId: channelId, content: body, createdAt: new Date(posted.getTime() + seq), data: { authorName: 'Ada', mentions: ['target'], ...extra } } });
  await db.channel.update({ where: { id: channelId }, data: { lastSeq: seq, lastMessageAt: posted } });
  return seq;
};
let peerWorker: { id: string } | null = null;
const peer = async () => (peerWorker ??= await db.worker.create({ data: { id: generateId(), appId, agentId, name: 'Peer', slug: 'peer', signature: '', trailer: '' } }));
const setSwitch = (on: boolean) => db.app.update({ where: { id: appId }, data: { deliveryStandbyEnabled: on } });
const load = () => loadDeliveryBatches({ ctx: caller, app, hostId: 'host-a', now: ready });
const enumerate = () => enumeratePendingDelivery({ ctx: caller, app, hostId: 'host-a', now: ready, first: 1000 });

beforeEach(async () => {
  setS7AvailableForTest(true); // these exercise the mechanism; the inert contract is pinned in inertS7a.test.ts
  await cleanDb(db); n = 0; peerWorker = null;
  const org = await db.organization.create({ data: { id: generateId(), name: 'Standby', urn: `standby-${generateId()}.com` } });
  orgId = org.id;
  holderId = (await db.user.create({ data: { id: generateId(), githubId: 99800, githubUsername: `sb-${generateId()}`, roles: ['READER'] } })).id;
  agentId = (await db.agent.create({ data: { id: generateId(), organizationId: orgId, name: 'Standby', urn: `${org.urn}:agent`, visibility: 'ORGANIZATION' } })).id;
  app = await db.app.create({ data: { id: generateId(), organizationId: orgId, name: 'Standby', urn: `${org.urn}:app` } });
  appId = app.id;
  await db.appAgent.create({ data: { appId, agentId } });
  await db.appMember.create({ data: { appId, userId: holderId, role: 'member' } });
  const key = await db.appKey.create({ data: { id: generateId(), appId, keyHash: `sb-${generateId()}`, keyPreview: 'test' } });
  caller = { db, appId, appKeyId: key.id, roles: [] };
  const memory = await db.memory.create({ data: { id: generateId(), organizationId: orgId, name: 'Shared', urn: `${org.urn}:shared`, class: 'app', appId, sharedMemoryOfAgentId: agentId } });
  memoryId = memory.id;
  const { ensureChannelWithRoot } = await import('../channels.js');
  const made = await ensureChannelWithRoot(db, { memoryId, loc: 'chats:team', name: 'team', createdBy: holderId });
  channelId = made.channel.id; rootId = made.rootId;
  registrationId = (await db.hostRegistration.create({ data: { id: generateId(), appId, hostId: 'host-a', label: 'a', pollIntervalSeconds: 60, refreshedAt: ready } })).id;
});

describe('workerStandby and onStandbySql', () => {
  it('follows the predicate: switch, reportsTo, head status, tasks, retirement; TS and SQL agree at each step', async () => {
    const head = await mkWorker('Head');
    const mid = await mkWorker('Mid', { reportsToWorkerId: head.id });
    const leaf = await mkWorker('Leaf', { reportsToWorkerId: mid.id });
    const both = async (id: string) => {
      const ts = (await workerStandby(db, id)).onStandby;
      const sql = (await db.$queryRaw<Array<{ b: boolean }>>(Prisma.sql`SELECT ${onStandbySql(Prisma.sql`w`)} AS b FROM workers w WHERE w.id = ${id}`))[0]!.b;
      expect(sql, 'SQL twin').toBe(ts);
      return ts;
    };
    for (const w of [head, mid, leaf]) expect(await both(w.id), 'switch off').toBe(false);
    await setSwitch(true);
    expect(await both(head.id), 'no reportsTo: never').toBe(false);
    expect(await both(mid.id), 'a head reporting upward: never').toBe(false);
    expect(await both(leaf.id)).toBe(true);
    const task = await db.agentTask.create({ data: { id: generateId(), appId, title: 't', ownerUserId: holderId, assigneeWorkerId: leaf.id, assignedAt: posted, status: 'pending' } });
    expect(await both(leaf.id), 'pending task').toBe(false);
    await db.agentTask.update({ where: { id: task.id }, data: { status: 'started', startedAt: posted } });
    expect(await both(leaf.id), 'started task').toBe(false);
    await db.agentTask.update({ where: { id: task.id }, data: { status: 'finished', finishedAt: ready, resultOutcome: 'done' } });
    expect(await both(leaf.id), 'finished task').toBe(true);
    await db.worker.update({ where: { id: leaf.id }, data: { retiredAt: ready } });
    expect(await both(leaf.id), 'retired worker').toBe(false);
    expect(await both(mid.id), 'last report retired: head status lost').toBe(true);
    await db.worker.update({ where: { id: head.id }, data: { retiredAt: ready } });
    expect(await both(mid.id), 'its head retired: ordinary delivery').toBe(false);
  });
});

describe('S1 integration: the renderer filters, the enumeration keeps', () => {
  it('renders only the four kinds to a standby worker, while the complete enumeration retains every held message', async () => {
    const head = await mkWorker('Head');
    const target = await mkWorker('Target', { reportsToWorkerId: head.id });
    await setSwitch(true);
    await say('human', { authorUserId: holderId });            // 1 admitted
    await say('peer', { authorWorkerId: (await peer()).id });        // 2 held
    await say('system', { authorSystem: true });                // 3 held
    await say('from head', { authorWorkerId: head.id });        // 4 admitted
    await say('broadcast', { mentions: ['all'], broadcastWakes: true, authorUserId: holderId }); // 5 held
    const page = await load();
    const mine = page.batches.find((b) => b.workerId === target.id)!;
    expect(mine.ranges[0]!.seqs).toEqual([1, 4]);
    expect(mine.overflow).toBe(0);
    const items = (await enumerate()).items.filter((i) => i.workerId === target.id).map((i) => i.seq);
    expect(items, "S5 keeps the held messages").toEqual([1, 2, 3, 4, 5]);
    // the head is not on standby: ordinary delivery
    expect((await load()).batches.find((b) => b.workerId === head.id)!.ranges[0]!.seqs, 'the head gets only the broadcast').toEqual([5]);
  });
  it('switch off: nobody is on standby', async () => {
    const head = await mkWorker('Head');
    const target = await mkWorker('Target', { reportsToWorkerId: head.id });
    await say('peer', { authorWorkerId: (await peer()).id });
    expect((await load()).batches.find((b) => b.workerId === target.id)!.ranges[0]!.seqs).toEqual([1]);
  });
  it('count and overflow are filtered too: 12 held + 1 admitted renders one message, overflow 0', async () => {
    const head = await mkWorker('Head');
    const target = await mkWorker('Target', { reportsToWorkerId: head.id });
    await setSwitch(true);
    for (let i = 0; i < 12; i++) await say(`peer-${i}`, { authorWorkerId: (await peer()).id });
    await say('human', { authorUserId: holderId });
    const b = (await load()).batches.find((x) => x.workerId === target.id)!;
    expect(b.ranges[0]!.seqs).toEqual([13]);
    expect(b.overflow).toBe(0);
  });
});

describe('isolation drops the worker from S1 before any channel scan', () => {
  it('holds batches and enumeration while live; releases ONE batch on clear and on expiry', async () => {
    const target = await mkWorker('Target');
    for (let i = 0; i < 12; i++) await say(`m-${i}`);
    await db.workerWakeSettings.create({ data: { workerId: target.id, isolatedUntil: new Date(ready.getTime() + 3600_000), isolatedAt: posted, isolatedByUserId: holderId } });
    expect((await load()).batches).toEqual([]);
    expect((await enumerate()).items).toEqual([]);
    await db.workerWakeSettings.update({ where: { workerId: target.id }, data: { isolatedUntil: null } });
    const cleared = (await load()).batches;
    expect(cleared).toHaveLength(1);
    expect(cleared[0]!.ranges[0]).toMatchObject({ fromSeq: 1, seqs: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] });
    expect(cleared[0]!.overflow).toBe(2);
    await db.workerWakeSettings.update({ where: { workerId: target.id }, data: { isolatedUntil: new Date(ready.getTime() - 1) } });
    expect((await load()).batches, 'expired reads as not isolated').toHaveLength(1);
  });
  it('a self-pause alone is NOT an isolation and adds no S1 batch filtering', async () => {
    const target = await mkWorker('Target');
    await say('m');
    await db.workerWakeSettings.create({ data: { workerId: target.id, pausedUntil: new Date(ready.getTime() + 3600_000) } });
    expect((await load()).batches).toHaveLength(1);
  });
});

describe('StandbyCoverageClassifier (S5 seam)', () => {
  it('answers held per message, and refuses a claim it cannot verify', async () => {
    const head = await mkWorker('Head');
    const target = await mkWorker('Target', { reportsToWorkerId: head.id });
    await say('human', { authorUserId: holderId });
    await say('peer', { authorWorkerId: (await peer()).id });
    const ch = await db.channel.findUniqueOrThrow({ where: { id: channelId } });
    const ask = (seq: number, headWorkerId = head.id) => StandbyCoverageClassifier(db, { workerId: target.id, channelId, incarnation: ch.incarnation, seq, headWorkerId });
    await expect(ask(1)).rejects.toThrow(/STANDBY_COVERAGE_MISMATCH/); // switch off
    await setSwitch(true);
    expect(await ask(1)).toEqual({ held: false, headWorkerId: head.id });
    expect(await ask(2)).toEqual({ held: true, headWorkerId: head.id });
    await expect(ask(2, 'someone-else')).rejects.toThrow(/STANDBY_COVERAGE_MISMATCH/);
    await expect(ask(99)).rejects.toThrow(/STANDBY_COVERAGE_MISMATCH/);
  });
});

describe('legacy wakes (dueWakes)', () => {
  const wakesFor = async (id: string) => {
    const { computeDueWakes } = await import('./dueWakes.js');
    const res = await computeDueWakes({ ctx: { db, userId: holderId, roles: ['READER'] } as Context, app, reader: { manager: true, userId: holderId }, requester: { userId: holderId }, now: new Date(Date.now() + 3_600_000) });
    return res.wakes.filter((w: any) => w.workerId === id || w.worker?.id === id);
  };
  it('a live isolation makes the worker not due; an expired one does not', async () => {
    const target = await mkWorker('Target');
    await say('hello', { authorUserId: holderId });
    expect(await wakesFor(target.id)).toHaveLength(1);
    await db.agentTeamEvent.deleteMany({}); await db.workerWakeAck.deleteMany({});
    await db.workerWakeSettings.create({ data: { workerId: target.id, isolatedUntil: new Date(Date.now() + 7_200_000) } });
    expect(await wakesFor(target.id)).toHaveLength(0);
    await db.workerWakeSettings.update({ where: { workerId: target.id }, data: { isolatedUntil: new Date(Date.now() - 1000) } });
    expect(await wakesFor(target.id)).toHaveLength(1);
  });
  it('a standby worker is woken only by a direct mention from a person or its head', async () => {
    const head = await mkWorker('Head');
    const target = await mkWorker('Target', { reportsToWorkerId: head.id });
    await setSwitch(true);
    await say('peer', { authorWorkerId: (await peer()).id });
    await say('broadcast', { mentions: ['all'], broadcastWakes: true, authorUserId: holderId });
    expect(await wakesFor(target.id), 'only held kinds').toHaveLength(0);
    await say('from head', { authorWorkerId: head.id });
    expect(await wakesFor(target.id)).toHaveLength(1);
  });
});

describe('the assignment raise (R90)', () => {
  const assign = async (workerId: string, extra: { fail?: boolean } = {}) => {
    const taskId = generateId();
    await db.$transaction(async (tx) => {
      await tx.agentTask.create({ data: { id: taskId, appId, title: 'Do the thing', ownerUserId: holderId, assigneeWorkerId: workerId, assignedAt: ready, status: 'pending' } });
      const { appendTaskEvent } = await import('../agentTasks/events.js');
      await appendTaskEvent(tx, { appId, taskId, actor: { userId: holderId, workerId: null, agentId: null }, event: { type: 'task.assigned', assignee: { workerId }, closeSessionWhenDone: true } as never });
      if (extra.fail) throw new Error('rollback');
    });
    return taskId;
  };
  const markOf = async (workerId: string) => (await db.workerDeliveryChannel.findUnique({ where: { workerId_channelId: { workerId, channelId } } }))?.deliveredThroughSeq ?? 0;
  const eventOf = (taskId: string) => db.agentTeamEvent.findFirstOrThrow({ where: { taskId, type: 'task.assigned' } });

  it('raises delivered past 5 held messages, leaves read alone, and returns the count once on the task wake', async () => {
    const head = await mkWorker('Head');
    const target = await mkWorker('Target', { reportsToWorkerId: head.id });
    await setSwitch(true);
    for (let i = 0; i < 5; i++) await say(`peer-${i}`, { authorWorkerId: (await peer()).id });
    await db.channelReadState.create({ data: { id: generateId(), workerId: target.id, appId, channelId, lastSeenSeq: 0 } });
    const taskId = await assign(target.id);
    expect(await markOf(target.id)).toBe(5);
    expect((await db.channelReadState.findFirstOrThrow({ where: { workerId: target.id, channelId } })).lastSeenSeq).toBe(0);
    expect(((await eventOf(taskId)).payload as Record<string, unknown>).standbyHeld).toBe(5);
    const { pendingTaskWakes } = await import('../agentTasks/taskWakes.js');
    const wakes = (await pendingTaskWakes(db, [target.id], ready)).get(target.id)!;
    expect(wakes).toHaveLength(1); expect(wakes[0]!.standbyHeld).toBe(5);
    // once: after the event's delivery is recorded it is no longer pending
    await db.$executeRaw`INSERT INTO worker_delivery_task_events (worker_id, event_id, chain_index, delivered_at) VALUES (${target.id}, ${wakes[0]!.eventId}, 0, now())`;
    expect((await pendingTaskWakes(db, [target.id], ready)).get(target.id) ?? []).toHaveLength(0);
  });
  it('stops one short of an admitted, undelivered message', async () => {
    const head = await mkWorker('Head');
    const target = await mkWorker('Target', { reportsToWorkerId: head.id });
    await setSwitch(true);
    await say('peer-1', { authorWorkerId: (await peer()).id });   // 1 held
    await say('peer-2', { authorWorkerId: (await peer()).id });   // 2 held
    await say('human', { authorUserId: holderId });               // 3 admitted
    await say('peer-4', { authorWorkerId: (await peer()).id });   // 4 held
    const taskId = await assign(target.id);
    expect(await markOf(target.id)).toBe(2);
    expect(((await eventOf(taskId)).payload as Record<string, unknown>).standbyHeld).toBe(2);
    expect((await load()).batches.find((b) => b.workerId === target.id)!.ranges[0]!.seqs, 'the admitted message is still due; the worker is no longer on standby, so 4 is ordinary').toEqual([3, 4]);
  });
  it('raises nothing when the worker was not on standby: switch off, already busy, or a head', async () => {
    const head = await mkWorker('Head');
    const target = await mkWorker('Target', { reportsToWorkerId: head.id });
    await say('peer', { authorWorkerId: (await peer()).id });
    await assign(target.id);                                      // switch off
    expect(await markOf(target.id)).toBe(0);
    await setSwitch(true);
    await assign(target.id);                                      // now busy with the first task
    expect(await markOf(target.id)).toBe(0);
    await assign(head.id);                                        // a head is never on standby
    expect(await markOf(head.id)).toBe(0);
  });
  it('rolls back with a refused assignment: no mark, no event', async () => {
    const head = await mkWorker('Head');
    const target = await mkWorker('Target', { reportsToWorkerId: head.id });
    await setSwitch(true);
    await say('peer', { authorWorkerId: (await peer()).id });
    await expect(assign(target.id, { fail: true })).rejects.toThrow('rollback');
    expect(await markOf(target.id)).toBe(0);
    expect(await db.agentTeamEvent.count({ where: { type: 'task.assigned' } })).toBe(0);
  });
  it('no acknowledgement entry point reaches the raise (it is not an ack)', async () => {
    const { readFileSync } = await import('node:fs');
    for (const f of ['acknowledge.ts', 'wakeProof.ts']) {
      expect(readFileSync(new URL(`./${f}`, import.meta.url), 'utf8'), f).not.toMatch(/standbyAssignment|raiseDeliveredOnAssignment/);
    }
  });
});

describe('S7a is inert: persisted state activates nothing (Diego #25404, Ada #25407)', () => {
  it('a STORED standby=true: not effective, nobody is on standby, the renderer holds nothing, the assignment raise advances nothing', async () => {
    const head = await mkWorker('Head');
    const target = await mkWorker('Target', { reportsToWorkerId: head.id });
    await setSwitch(true); // raw row, as a pre-existing or seeded App would carry
    setAvail(false);
    expect(await loadDeliverySettings(db, appId)).toMatchObject({ standbyEnabled: true, standbyEffective: false });
    expect((await workerStandby(db, target.id)).onStandby).toBe(false);
    expect((await db.$queryRaw<Array<{ b: boolean }>>(Prisma.sql`SELECT ${onStandbySql(Prisma.sql`w`)} AS b FROM workers w WHERE w.id = ${target.id}`))[0]!.b).toBe(false);
    await say('human', { authorUserId: holderId });
    await say('peer', { authorWorkerId: (await peer()).id });
    const mine = (await load()).batches.find((b) => b.workerId === target.id)!;
    expect(mine.ranges[0]!.seqs, 'ordinary delivery: the peer message is NOT held').toEqual([1, 2]);
    const task = await db.agentTask.create({ data: { id: generateId(), appId, title: 't', ownerUserId: holderId, assigneeWorkerId: target.id, assignedAt: posted, status: 'pending' } });
    expect(await db.$transaction((tx) => raiseDeliveredOnAssignment(tx, { workerId: target.id, taskId: task.id, actor: { userId: holderId, workerId: null }, now: ready }))).toBe(0);
    expect(await db.workerDeliveryChannel.count({ where: { workerId: target.id } })).toBe(0);
  });
  it('a STORED live isolation does not drop the worker from delivery', async () => {
    const target = await mkWorker('Target');
    await say('hello', { authorUserId: holderId });
    await db.workerWakeSettings.create({ data: { workerId: target.id, isolatedUntil: new Date(ready.getTime() + 3_600_000), isolatedAt: ready, isolatedByUserId: holderId } });
    setAvail(false);
    expect((await load()).batches.some((b) => b.workerId === target.id), 'inert: still delivered').toBe(true);
    setAvail(true);
    expect((await load()).batches.some((b) => b.workerId === target.id), 'mechanism (S7b): dropped').toBe(false);
  });
});

describe('S7b (#2130): an ordinary batch ack must not pass a held message (George P2, #2114) — red on the enabled path', () => {
  it.fails('held seq 1 + admitted seq 2: after the real batch ack the held message is still in the complete enumeration', async () => {
    const head = await mkWorker('Head');
    const target = await mkWorker('Target', { reportsToWorkerId: head.id });
    await setSwitch(true);
    await say('peer', { authorWorkerId: (await peer()).id });   // 1 held
    await say('human', { authorUserId: holderId });             // 2 admitted
    const mine = (await load()).batches.find((b) => b.workerId === target.id)!;
    expect(mine.ranges[0]!.seqs).toEqual([2]);
    const proof = signBatchProof(batchProofPayload(mine, { appId, hostId: 'host-a', appKeyId: caller.appKeyId!, now: ready }));
    await acknowledgeBatchProofs({ ctx: { ...caller, userId: holderId } as Context, requester: { appKeyId: caller.appKeyId! }, acks: [{ proof }], mayAckBatch: async () => true, now: ready });
    const after = (await enumerate()).items.filter((i) => i.workerId === target.id).map((i) => i.seq);
    expect(after, 'the held message was never rendered or counted, so it must stay pending').toContain(1);
  });
});
