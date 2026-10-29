import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
/**
 * #2169 (S6b) — the stop-notice consumer's server half. Two keys replace the process-wide DARK switch (cor:agt:090:04, R95):
 * the OFFER keys on the call (`dueWakes(accepts: [STOP])`), and the SET keys on the serving lane of every worker the new
 * signal would cover (a lane has a fresh declaration, recorded by a declaring `dueWakes` call).
 *
 * Cast: Ada heads a team; Liam and Dan report to her. orca1's registration lists Ada and Dan, orca2's lists Kit. Liam is on
 * no registration, so he is on the unhosted lane. Max manages the App; Mia holds the workers.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { randomBytes } from 'node:crypto';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { APP_KEY_PREFIX, hashAppKey } from '../../middleware/auth.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { coveringSignals } from './state.js';
import { pendingStopNotices } from './delivery.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));
vi.mock('../bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] }) as Context;
async function refusal(p: Promise<unknown>): Promise<GraphQLError | null> {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(GraphQLError); return e as GraphQLError; }
  return null;
}

let app: { id: string };
let max: { id: string };
let mia: { id: string };
let ada: { id: string };
let liam: { id: string };
let dan: { id: string };
let kit: { id: string };
let orca1Key: { id: string };
let orca2Key: { id: string };
let plainKey: { id: string };
let agentId: string;

async function mkKey(label: string) {
  const raw = `${APP_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
  return db.appKey.create({ data: { id: generateId(), appId: app.id, keyHash: hashAppKey(raw), keyPreview: raw.slice(-4), label }, select: { id: true } });
}
const keyCtx = (k: { id: string }): Context => ({ db, appId: app.id, appKeyId: k.id, organizationId: undefined, roles: [] }) as Context;

beforeEach(async () => {
  await cleanDb(db);
  delete process.env.DISABLE_TASK_MATCHER;
  const n = Math.floor(Math.random() * 1_000_000);
  const org = await db.organization.create({ data: { name: 'Lane', urn: `lane2169-${n}.example` }, select: { id: true, urn: true } });
  const u = (k: number, name: string) =>
    db.user.create({ data: { githubId: k * 1_000_000 + n, githubUsername: `l69-${name}-${n}`, roles: ['READER'] }, select: { id: true } });
  max = await u(81, 'max');
  mia = await u(82, 'mia');
  await db.orgMember.create({ data: { organizationId: org.id, userId: max.id, role: 'ADMIN' } });
  agentId = (await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(max.id))).id;
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `${org.urn}:team` }, select: { id: true } });
  await db.appMember.create({ data: { appId: app.id, userId: mia.id, role: 'member' } });
  const w = (name: string, role: string, extra: Record<string, unknown> = {}) =>
    db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId, name, slug: name.toLowerCase(), role, heldByUserId: mia.id, heldAt: new Date(), ...extra }, select: { id: true } });
  ada = await w('Ada', 'coordinator');
  liam = await w('Liam', 'engineer', { reportsToWorkerId: ada.id });
  dan = await w('Dan', 'engineer', { reportsToWorkerId: ada.id });
  kit = await w('Kit', 'engineer');
  orca1Key = await mkKey('orca1');
  orca2Key = await mkKey('orca2');
  plainKey = await mkKey('plain');
  await M.grantAppKeyScope({}, { id: orca1Key.id, scope: 'host:operate', hostId: 'orca1' }, ctx(max.id));
  await M.grantAppKeyScope({}, { id: orca2Key.id, scope: 'host:operate', hostId: 'orca2' }, ctx(max.id));
  for (const k of [orca1Key, orca2Key, plainKey]) {
    await db.appKeyScope.create({ data: { id: generateId(), appKeyId: k.id, scope: 'attention:deliver', grantedByUserId: max.id } });
  }
  await M.registerHost({}, { input: { appRef: app.id, label: 'Orca 1', pollIntervalSeconds: 600, workers: [{ worker: ada.id, family: 'claude' }, { worker: dan.id, family: 'claude' }] } }, keyCtx(orca1Key));
  await M.registerHost({}, { input: { appRef: app.id, label: 'Orca 2', pollIntervalSeconds: 600, workers: [{ worker: kit.id, family: 'claude' }] } }, keyCtx(orca2Key));
});

const set = (c: Context, input: Record<string, unknown>) => M.setTeamStopSignal({}, { input: { appRef: app.id, ...input } }, c);
const lift = (c: Context, id: string) => M.liftTeamStopSignal({}, { appRef: app.id, id }, c);
const dueWakes = (c: Context, extra: Record<string, unknown> = {}) => Q.dueWakes({}, { appRef: app.id, ...extra }, c);
const signals = () => db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*)::bigint AS n FROM team_stop_signals WHERE app_id = ${app.id}`.then((r) => Number(r[0]!.n));
const declarations = () => db.$queryRaw<Array<{ lane: string; declaredAt: Date }>>`SELECT lane, declared_at AS "declaredAt" FROM stop_consumer_declarations WHERE app_id = ${app.id} ORDER BY lane`;
const orca2Reg = () => db.hostRegistration.findFirstOrThrow({ where: { appId: app.id, hostId: 'orca2' }, select: { id: true } });
const covered = async () => [...(await coveringSignals(db, app.id, null, new Date())).keys()].sort();
const stopKinds = (page: any) => page.wakes.flatMap((w: any) => w.reasons.map((r: any) => r.kind)).filter((k: string) => k === 'STOP');

describe('A3.1 — undeclared: every set is refused STOP_SIGNAL_UNAVAILABLE, nothing recorded', () => {
  it('every level at every scope, for a person', async () => {
    for (const level of ['PAUSE_DISPATCH', 'PAUSE', 'HALT']) {
      expect((await refusal(set(ctx(max.id), { level, scope: 'WORKER', worker: 'Dan' })))?.extensions?.code).toBe('STOP_SIGNAL_UNAVAILABLE');
      expect((await refusal(set(ctx(max.id), { level, scope: 'TEAM', worker: 'Ada' })))?.extensions?.code).toBe('STOP_SIGNAL_UNAVAILABLE');
      expect((await refusal(set(ctx(max.id), { level, scope: 'HOST', host: 'orca1' })))?.extensions?.code).toBe('STOP_SIGNAL_UNAVAILABLE');
    }
    expect(await signals()).toBe(0);
    expect(await covered()).toEqual([]);
  });

  it('a host key is refused too, and the refusal is RECORDED as a stop use (cor:agt:070:07)', async () => {
    expect((await refusal(set(keyCtx(orca1Key), { level: 'HALT', scope: 'HOST' })))?.extensions?.code).toBe('STOP_SIGNAL_UNAVAILABLE');
    expect(await db.hostKeyUse.count({ where: { appKeyId: orca1Key.id, action: 'stop', refusedCode: 'STOP_SIGNAL_UNAVAILABLE' } })).toBe(1);
    expect(await signals()).toBe(0);
  });

  it('A3.6 the earlier gates still answer first, so only a caller who could set one learns the lane state', async () => {
    expect((await refusal(set(ctx(mia.id), { level: 'PAUSE', scope: 'TEAM', worker: 'Ada' })))?.extensions?.code).not.toBe('STOP_SIGNAL_UNAVAILABLE');
    expect((await refusal(set(keyCtx(orca1Key), { level: 'PAUSE', scope: 'HOST' })))?.extensions?.code).toBe('STOP_SIGNAL_SCOPE_FORBIDDEN');
    expect((await refusal(set(keyCtx(orca1Key), { level: 'HALT', scope: 'HOST', host: 'orca2' })))?.extensions?.code).toBe('HOST_SCOPE_REQUIRED');
  });
});

describe('A3.2 — a declared, served lane', () => {
  it('a manager call declares the unhosted lane: a signal covering only Liam is then set', async () => {
    await dueWakes(ctx(max.id), { accepts: ['STOP'] });
    expect((await declarations()).map((d) => d.lane)).toEqual(['unhosted']);
    expect(await set(ctx(max.id), { level: 'PAUSE', scope: 'WORKER', worker: 'Liam' })).toMatchObject({ live: true });
  });

  it('the host key serving orca1 declares its registration: a HALT on orca1 (Ada, Dan) is then set by the key and by a person', async () => {
    await dueWakes(keyCtx(orca1Key), { accepts: ['STOP'] });
    const reg = await db.hostRegistration.findFirstOrThrow({ where: { appId: app.id, hostId: 'orca1' }, select: { id: true } });
    expect((await declarations()).map((d) => d.lane)).toEqual([reg.id]);
    expect(await set(keyCtx(orca1Key), { level: 'HALT', scope: 'HOST' })).toMatchObject({ live: true, setByHostKey: true });
    expect(await set(ctx(max.id), { level: 'PAUSE', scope: 'WORKER', worker: 'Dan' })).toMatchObject({ live: true });
  });

  it('a signal that covers nobody is not refused: a HOST signal on a registration that lists no worker, with nothing declared', async () => {
    const orca3Key = await mkKey('orca3');
    await M.grantAppKeyScope({}, { id: orca3Key.id, scope: 'host:operate', hostId: 'orca3' }, ctx(max.id));
    await M.registerHost({}, { input: { appRef: app.id, label: 'Orca 3', pollIntervalSeconds: 600, workers: [] } }, keyCtx(orca3Key));
    const s = await set(ctx(max.id), { level: 'PAUSE', scope: 'HOST', host: 'orca3' });
    expect(s).toMatchObject({ live: true });
    expect(await covered()).toEqual([]);
    expect(await declarations()).toEqual([]);
  });

  it('a declaration is recorded even when nothing is due (an idle consumer must still count as serving)', async () => {
    const page = await dueWakes(ctx(max.id), { accepts: ['STOP'] });
    expect(page.wakes).toEqual([]);
    expect((await declarations()).length).toBe(1);
  });

  it('a person who only holds workers (not a manager) does not declare the unhosted lane', async () => {
    await dueWakes(ctx(mia.id), { accepts: ['STOP'] });
    expect(await declarations()).toEqual([]);
  });

  it('a non-host key with attention:deliver declares the unhosted lane', async () => {
    await dueWakes(keyCtx(plainKey), { accepts: ['STOP'] });
    expect((await declarations()).map((d) => d.lane)).toEqual(['unhosted']);
  });
});

describe('A3.3 — per lane', () => {
  it('a TEAM set covering Kit-free Ada/Liam/Dan needs orca1 AND unhosted; a HOST set on orca2 (Kit) names orca2 when it is undeclared', async () => {
    await dueWakes(ctx(max.id), { accepts: ['STOP'] });
    const e = await refusal(set(ctx(max.id), { level: 'PAUSE', scope: 'TEAM', worker: 'Ada' }));
    expect(e?.extensions?.code).toBe('STOP_SIGNAL_UNAVAILABLE'); // Ada and Dan are on orca1, which has not declared
    expect(e?.extensions).toMatchObject({ workers: 2, lanes: ['orca1'] });
    await dueWakes(keyCtx(orca1Key), { accepts: ['STOP'] });
    expect(await set(ctx(max.id), { level: 'PAUSE', scope: 'TEAM', worker: 'Ada' })).toMatchObject({ live: true });
  });

  it('a refusal names the count and the lanes by host id, never worker text', async () => {
    await dueWakes(ctx(max.id), { accepts: ['STOP'] });
    const e = await refusal(set(ctx(max.id), { level: 'PAUSE', scope: 'HOST', host: 'orca2' }));
    expect(e?.extensions?.code).toBe('STOP_SIGNAL_UNAVAILABLE');
    expect(e?.extensions).toMatchObject({ workers: 1, lanes: ['orca2'] });
    expect(e?.message).not.toMatch(/Kit/);
  });
});

describe('A3.4 — stale declarations', () => {
  it('older than the window refuses; a fresh one after it succeeds', async () => {
    await dueWakes(ctx(max.id), { accepts: ['STOP'] });
    await db.$executeRaw`UPDATE stop_consumer_declarations SET declared_at = now() AT TIME ZONE 'utc' - interval '11 minutes' WHERE app_id = ${app.id}`;
    expect((await refusal(set(ctx(max.id), { level: 'PAUSE', scope: 'WORKER', worker: 'Liam' })))?.extensions?.code).toBe('STOP_SIGNAL_UNAVAILABLE');
    await dueWakes(ctx(max.id), { accepts: ['STOP'] });
    expect(await set(ctx(max.id), { level: 'PAUSE', scope: 'WORKER', worker: 'Liam' })).toMatchObject({ live: true });
  });
});

describe('A3.5 — the offer is per call', () => {
  const dueStop = async () => {
    await dueWakes(ctx(max.id), { accepts: ['STOP'] });
    await set(ctx(max.id), { level: 'PAUSE', scope: 'WORKER', worker: 'Liam' });
  };

  it('with accepts omitted no STOP reason is returned and no declaration is written', async () => {
    await dueStop();
    await db.$executeRaw`DELETE FROM stop_consumer_declarations WHERE app_id = ${app.id}`;
    const page = await dueWakes(ctx(max.id));
    expect(stopKinds(page)).toEqual([]);
    expect(await declarations()).toEqual([]);
  });

  it('with accepts: [STOP] the newest undelivered notice is returned', async () => {
    await dueStop();
    const page = await dueWakes(ctx(max.id), { accepts: ['STOP'] });
    expect(stopKinds(page)).toEqual(['STOP']);
  });

  it('accepts without STOP declares nothing', async () => {
    await dueWakes(ctx(max.id), { accepts: ['TICK'] });
    expect(await declarations()).toEqual([]);
  });
});

describe('A3.7 — lift and list with nothing declared', () => {
  it('lift of a recorded signal and the list both still work after every declaration is gone', async () => {
    await dueWakes(ctx(max.id), { accepts: ['STOP'] });
    const s = await set(ctx(max.id), { level: 'PAUSE', scope: 'WORKER', worker: 'Liam' });
    await db.$executeRaw`DELETE FROM stop_consumer_declarations WHERE app_id = ${app.id}`;
    expect((await Q.teamStopSignals({}, { appRef: app.id }, ctx(max.id))).signals.length).toBe(1);
    expect((await lift(ctx(max.id), s.id)).changed).toBe(true);
  });
});

describe('the refusal rolls the set back whole', () => {
  it('no signal row, no notice event and no coverage rows remain', async () => {
    await refusal(set(ctx(max.id), { level: 'PAUSE', scope: 'TEAM', worker: 'Ada' }));
    expect(await signals()).toBe(0);
    expect(await db.agentTeamEvent.count({ where: { appId: app.id, type: { startsWith: 'stop.' } } })).toBe(0);
    expect(await db.teamStopCoverage.count({ where: { appId: app.id } })).toBe(0);
  });
});

describe('fix head — #2432 findings', () => {
  it('BLIND P2-1 / LOCAL P2 (pagination): a narrowed poll, a page with more behind it and a tail-only page declare nothing; only a call that read the lane from its start to its end does', async () => {
    await dueWakes(ctx(max.id), { accepts: ['STOP'], workerRefs: [liam.id] });
    expect(await declarations()).toEqual([]);
    await dueWakes(keyCtx(orca1Key), { accepts: ['STOP'], workerRefs: [dan.id] });
    expect(await declarations()).toEqual([]);
    const first = await dueWakes(ctx(max.id), { accepts: ['STOP'], first: 2 });
    expect(first.pageInfo.hasNextPage).toBe(true);
    expect(await declarations()).toEqual([]);
    // The tail alone (Andi's probe): it reads to the end but skipped the prefix.
    const tail = await dueWakes(ctx(max.id), { accepts: ['STOP'], first: 2, after: first.pageInfo.endCursor });
    expect(tail.pageInfo.hasNextPage).toBe(false);
    expect(await declarations()).toEqual([]);
    expect((await refusal(set(ctx(max.id), { level: 'PAUSE', scope: 'WORKER', worker: 'Liam' })))?.extensions?.code).toBe('STOP_SIGNAL_UNAVAILABLE');
    await dueWakes(ctx(max.id), { accepts: ['STOP'], first: 200 });
    expect((await declarations()).map((d) => d.lane)).toEqual(['unhosted']);
  });

  it('BLIND P2-2: a host registration keeps its id when it registers again, so a declaration names the registration its poll served', async () => {
    const before = await orca2Reg();
    await M.registerHost({}, { input: { appRef: app.id, label: 'Orca 2', pollIntervalSeconds: 600, workers: [{ worker: kit.id, family: 'claude' }, { worker: liam.id, family: 'claude' }] } }, keyCtx(orca2Key));
    expect((await orca2Reg()).id).toBe(before.id);
  });

  it('SECOND P2: a PAUSE_DISPATCH on Liam tells his coordinator Ada (orca1): refused until orca1 declares, though Liam\'s own lane is served', async () => {
    await dueWakes(ctx(max.id), { accepts: ['STOP'] });
    const e = await refusal(set(ctx(max.id), { level: 'PAUSE_DISPATCH', scope: 'WORKER', worker: 'Liam' }));
    expect(e?.extensions).toMatchObject({ code: 'STOP_SIGNAL_UNAVAILABLE', lanes: ['orca1'] });
    expect(await signals()).toBe(0);
    await dueWakes(keyCtx(orca1Key), { accepts: ['STOP'] });
    expect(await set(ctx(max.id), { level: 'PAUSE_DISPATCH', scope: 'WORKER', worker: 'Liam' })).toMatchObject({ live: true });
  });

  it('LOCAL P2: a worker whose only host is lost is not served by a non-host key\'s unhosted declaration, nor by a manager\'s', async () => {
    await db.hostRegistration.update({ where: { id: (await orca2Reg()).id }, data: { lostAt: new Date() } });
    await dueWakes(keyCtx(plainKey), { accepts: ['STOP'] });
    await dueWakes(ctx(max.id), { accepts: ['STOP'] });
    const e = await refusal(set(ctx(max.id), { level: 'PAUSE', scope: 'WORKER', worker: 'Kit' }));
    expect(e?.extensions).toMatchObject({ code: 'STOP_SIGNAL_UNAVAILABLE', workers: 1, lanes: ['orca2'] });
  });

  it('§10 P2-1: another App\'s unhosted declaration does not serve this App', async () => {
    const orgId = (await db.app.findUniqueOrThrow({ where: { id: app.id } })).organizationId;
    const appB = await db.app.create({ data: { organizationId: orgId, name: 'B', urn: `b-${generateId()}` }, select: { id: true } });
    await Q.dueWakes({}, { appRef: appB.id, accepts: ['STOP'] }, ctx(max.id));
    expect(await declarations()).toEqual([]);
    expect((await refusal(set(ctx(max.id), { level: 'PAUSE', scope: 'WORKER', worker: 'Liam' })))?.extensions?.code).toBe('STOP_SIGNAL_UNAVAILABLE');
  });

  it('§10 P2-2: a host key declares only its OWN registration', async () => {
    await dueWakes(keyCtx(orca2Key), { accepts: ['STOP'] });
    expect((await declarations()).map((d) => d.lane)).toEqual([(await orca2Reg()).id]);
    expect((await refusal(set(ctx(max.id), { level: 'PAUSE', scope: 'WORKER', worker: 'Dan' })))?.extensions?.code).toBe('STOP_SIGNAL_UNAVAILABLE');
  });

  it('§10 P2-3: every covered worker is checked: orca1 declared, unhosted not, TEAM Ada is refused for Liam alone', async () => {
    await dueWakes(keyCtx(orca1Key), { accepts: ['STOP'] });
    const e = await refusal(set(ctx(max.id), { level: 'PAUSE', scope: 'TEAM', worker: 'Ada' }));
    expect(e?.extensions).toMatchObject({ code: 'STOP_SIGNAL_UNAVAILABLE', workers: 1, lanes: ['unhosted'] });
  });
});

describe('fix head 2 — #2432 cycle-2 findings', () => {
  it('SECOND / QA P2: a fresh declaration does not survive its host being lost', async () => {
    await dueWakes(keyCtx(orca2Key), { accepts: ['STOP'] });
    expect(await set(ctx(max.id), { level: 'PAUSE_DISPATCH', scope: 'WORKER', worker: 'Kit' })).toMatchObject({ live: true }); // served while live (Kit's coordinator is none: he is covered and told nobody)
    await db.teamStopSignal.deleteMany({ where: { appId: app.id } });
    await db.hostRegistration.update({ where: { id: (await orca2Reg()).id }, data: { lostAt: new Date() } });
    const e = await refusal(set(ctx(max.id), { level: 'PAUSE', scope: 'WORKER', worker: 'Kit' }));
    expect(e?.extensions).toMatchObject({ code: 'STOP_SIGNAL_UNAVAILABLE', workers: 1, lanes: ['orca2'] });
  });
});

describe('fix head 3 — §10 delta pins (Ralion, test-only)', () => {
  it('both host keys declare their OWN registration, whichever row the App lists first', async () => {
    const reg1 = await db.hostRegistration.findFirstOrThrow({ where: { appId: app.id, hostId: 'orca1' }, select: { id: true } });
    await dueWakes(keyCtx(orca1Key), { accepts: ['STOP'] });
    await dueWakes(keyCtx(orca2Key), { accepts: ['STOP'] });
    expect((await declarations()).map((d) => d.lane).sort()).toEqual([reg1.id, (await orca2Reg()).id].sort());
  });

  it('covered workers a PAUSE_DISPATCH does not tell are checked: orca1 declared, TEAM Ada refused for Liam', async () => {
    await dueWakes(keyCtx(orca1Key), { accepts: ['STOP'] });
    const e = await refusal(set(ctx(max.id), { level: 'PAUSE_DISPATCH', scope: 'TEAM', worker: 'Ada' }));
    expect(e?.extensions).toMatchObject({ code: 'STOP_SIGNAL_UNAVAILABLE', workers: 1, lanes: ['unhosted'] });
    expect(await signals()).toBe(0);
  });
});

// #2433 / cor:agt:090:04: declaration freshness belongs to the lane, not a
// snapshot of its workers. The accepted wait ends at the next declaring poll;
// it is not a promise of delivery within the declaration's freshness window.
describe('#2433 — a worker joins after its lane declared', () => {
  it.each(['host', 'unhosted'] as const)('%s lane accepts the set, keeps the notice pending, then offers it on the next declaring poll', async lane => {
    const consumer = lane === 'host' ? keyCtx(orca2Key) : ctx(max.id);
    const first = await dueWakes(consumer, { accepts: ['STOP'], first: 200 });
    expect(first.pageInfo.hasNextPage).toBe(false);
    expect(first.wakes).toEqual([]);
    const declaration = await declarations();
    expect(declaration).toHaveLength(1);
    expect(declaration[0]!.lane).toBe(lane === 'host' ? (await orca2Reg()).id : 'unhosted');

    let joined: { id: string };
    if (lane === 'host') {
      // Liam was not in the registration the first call read (only Kit was).
      const registration = await orca2Reg();
      expect(await db.hostRegistrationWorker.count({ where: { registrationId: registration.id, workerId: liam.id } })).toBe(0);
      joined = liam;
      await M.registerHost({}, { input: { appRef: app.id, label: 'Orca 2', pollIntervalSeconds: 600,
        workers: [{ worker: kit.id, family: 'claude' }, { worker: joined.id, family: 'claude' }] } }, consumer);
      expect((await orca2Reg()).id).toBe(registration.id);
    } else {
      // This worker did not exist during the unhosted lane's first poll.
      joined = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId,
        name: 'Newcomer', slug: 'newcomer', role: 'engineer', heldByUserId: mia.id, heldAt: new Date() }, select: { id: true } });
    }
    // Joining does not manufacture another declaring poll.
    expect(await declarations()).toEqual(declaration);
    const signal = await set(ctx(max.id), { level: 'PAUSE', scope: 'WORKER', worker: joined.id });
    expect(signal).toMatchObject({ live: true });
    expect(await covered()).toContain(joined.id);
    const notice = (await pendingStopNotices(db, app.id, [joined.id])).get(joined.id);
    expect(notice).toMatchObject({ workerId: joined.id, signalId: signal.id, level: 'pause', notice: 'stop' });
    expect(await db.workerDeliveryTaskEvent.count({ where: { workerId: joined.id, eventId: notice!.eventId } })).toBe(0);

    // A non-accepting call cannot offer the waiting notice or refresh the lane.
    expect(stopKinds(await dueWakes(consumer, { first: 200 }))).toEqual([]);
    expect(await declarations()).toEqual(declaration);
    expect((await pendingStopNotices(db, app.id, [joined.id])).get(joined.id)?.eventId).toBe(notice!.eventId);

    const next = await dueWakes(consumer, { accepts: ['STOP'], first: 200 });
    expect(next.pageInfo.hasNextPage).toBe(false);
    const offered = next.wakes.filter((w: any) => w.worker.id === joined.id);
    expect(offered).toHaveLength(1);
    expect(offered[0].reasons).toEqual([expect.objectContaining({ kind: 'STOP', stop: expect.objectContaining({
      eventId: notice!.eventId, signalId: signal.id, level: 'PAUSE', notice: 'STOP',
    }) })]);
    // Offered is not acknowledged or typed by a host: it remains undelivered.
    expect((await pendingStopNotices(db, app.id, [joined.id])).get(joined.id)?.eventId).toBe(notice!.eventId);
  });
});
