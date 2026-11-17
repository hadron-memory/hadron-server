/**
 * #3036 (cor:agt:090:04 r10, V21) — a worker's stop notices are two streams that never supersede each other: its own
 * level (`pause`/`halt`) and coordinator notices (`pause-dispatch`, one stream per signal). The offer is the own-level
 * notice first, then coordinator notices oldest first; the return stays one per worker. The resume-drop is per stream
 * (Proposed r10).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
import { pendingStopNotices } from './delivery.js';
import { appendStopNotice, type StopNoticeKind } from './notices.js';
import type { StopLevel } from './state.js';

vi.mock('../bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

let appId: string;
let liam: string;
let ada: string;
let clock: number;

beforeEach(async () => {
  await cleanDb(db);
  const n = `${Date.now()}-${Math.floor(Math.random() * 1e5)}`;
  const org = await db.organization.create({ data: { id: generateId(), name: 'ns', urn: `ns-${n}.com` } });
  const user = await db.user.create({ data: { id: generateId(), githubId: 97_000 + Math.floor(Math.random() * 1e6), githubUsername: `ns-${n}`, roles: ['READER'] }, select: { id: true } });
  const agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team`, visibility: 'ORGANIZATION' } });
  const app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` }, select: { id: true } });
  appId = app.id;
  const w = (name: string) => db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId, agentId: agent.id, name, slug: name.toLowerCase(), heldByUserId: user.id, heldAt: new Date() }, select: { id: true } });
  liam = (await w('Liam')).id;
  ada = (await w('Ada')).id;
  clock = Date.now() - 3_600_000;
});

/** Record one notice to `workerId` at a strictly later time than the last; returns its event id. */
async function notice(workerId: string, signalId: string, level: StopLevel, kind: StopNoticeKind): Promise<string> {
  clock += 1000;
  await db.$transaction((tx) => appendStopNotice(tx, { appId, recipient: { workerId }, signalId, level, notice: kind, at: new Date(clock) }));
  const e = await db.agentTeamEvent.findFirstOrThrow({ where: { appId, type: 'stop.notice', subjectWorkerId: workerId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true } });
  return e.id;
}
const deliver = (workerId: string, eventId: string) =>
  db.workerDeliveryTaskEvent.create({ data: { workerId, eventId, chainIndex: 0, deliveredAt: new Date() } });
const offered = async (workerId = liam) => (await pendingStopNotices(db, appId, [workerId])).get(workerId);

describe('#3036 two streams, offered in order', () => {
  it('S14: an undelivered own halt, then a coordinator pause-dispatch: the halt is offered first, then the coordinator notice', async () => {
    const halt = await notice(liam, 'own-halt', 'halt', 'stop');
    const coord = await notice(liam, 'coord-1', 'pause-dispatch', 'stop');
    expect((await offered())?.eventId).toBe(halt);
    await deliver(liam, halt);
    expect((await offered())?.eventId).toBe(coord);
  });

  it('reverse order: a coordinator notice first, then an own halt: the halt is offered first, the coordinator notice next', async () => {
    const coord = await notice(liam, 'coord-1', 'pause-dispatch', 'stop');
    const halt = await notice(liam, 'own-halt', 'halt', 'stop');
    expect((await offered())?.eventId).toBe(halt);
    await deliver(liam, halt);
    expect((await offered())?.eventId).toBe(coord);
  });

  it('two pause-dispatch signals: neither supersedes the other; oldest first', async () => {
    const a = await notice(liam, 'coord-a', 'pause-dispatch', 'stop');
    const b = await notice(liam, 'coord-b', 'pause-dispatch', 'stop');
    expect((await offered())?.eventId).toBe(a);
    await deliver(liam, a);
    expect((await offered())?.eventId).toBe(b);
  });

  it('the same signal: a newer coordinator notice supersedes an older undelivered one', async () => {
    const stop = await notice(liam, 'coord-a', 'pause-dispatch', 'stop');
    const other = await notice(liam, 'coord-b', 'pause-dispatch', 'stop');
    const resume = await notice(liam, 'coord-a', 'pause-dispatch', 'resume');
    // a's stop is superseded by a's resume, which is dropped (never delivered a stop); b's stop remains.
    const got = await offered();
    expect(got?.eventId).toBe(other);
    expect(got?.eventId).not.toBe(stop);
    expect(got?.eventId).not.toBe(resume);
    await deliver(liam, other);
    expect(await offered()).toBeUndefined();
  });

  it('an own-level notice does not hide behind a newer coordinator notice, nor a coordinator one behind a newer own (workers are independent)', async () => {
    const adaHalt = await notice(ada, 'ada-halt', 'halt', 'stop');
    await notice(liam, 'coord-1', 'pause-dispatch', 'stop');
    const map = await pendingStopNotices(db, appId, [ada, liam]);
    expect(map.get(ada)?.eventId).toBe(adaHalt);
    expect(map.get(liam)?.level).toBe('pause-dispatch');
  });
});

describe('#3036 Proposed r10: the resume-drop is per stream', () => {
  it('Proposed r10: a delivered coordinator stop does not make an own-level resume deliverable', async () => {
    const coord = await notice(liam, 'coord-1', 'pause-dispatch', 'stop');
    await deliver(liam, coord);
    await notice(liam, 'own-pause', 'pause', 'stop'); // never delivered
    await notice(liam, 'own-pause', 'pause', 'resume');
    // The own stream's last delivered notice is none: the own stop and its resume are dropped together.
    expect(await offered()).toBeUndefined();
  });

  it('Proposed r10: a delivered own-level stop does not make a coordinator resume deliverable', async () => {
    const own = await notice(liam, 'own-pause', 'pause', 'stop');
    await deliver(liam, own);
    await notice(liam, 'coord-1', 'pause-dispatch', 'stop'); // never delivered
    await notice(liam, 'coord-1', 'pause-dispatch', 'resume');
    expect(await offered()).toBeUndefined();
  });

  it('Proposed r10: a coordinator resume is judged against the SAME signal, not another coordinator signal', async () => {
    const a = await notice(liam, 'coord-a', 'pause-dispatch', 'stop');
    await deliver(liam, a);
    await notice(liam, 'coord-b', 'pause-dispatch', 'stop'); // never delivered
    await notice(liam, 'coord-b', 'pause-dispatch', 'resume');
    expect(await offered()).toBeUndefined();
  });

  it('control: a resume after a delivered stop in its own stream is still offered', async () => {
    const own = await notice(liam, 'own-pause', 'pause', 'stop');
    await deliver(liam, own);
    const resume = await notice(liam, 'own-pause', 'pause', 'resume');
    expect((await offered())?.eventId).toBe(resume);
  });
});

describe('#3036 the discriminator', () => {
  it('only a pause-dispatch notice is a coordinator notice: a pause-dispatch is never offered ahead of an own-level one', async () => {
    const coord = await notice(liam, 'coord-1', 'pause-dispatch', 'stop');
    const own = await notice(liam, 'own-pause', 'pause', 'stop');
    const got = await offered();
    expect(got?.eventId).toBe(own);
    expect(got?.level).toBe('pause');
    // And the reverse: if a pause-dispatch notice were recorded as own-level (the stream key) it would supersede.
    // Both survive here only because the stream is read off payload.level.
    await deliver(liam, own);
    expect((await offered())?.eventId).toBe(coord);
  });
});
