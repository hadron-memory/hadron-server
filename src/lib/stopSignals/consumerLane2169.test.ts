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

  it('a signal that covers nobody is not refused (a worker scope on a retired worker is not found, a team of one with no lane)', async () => {
    await dueWakes(ctx(max.id), { accepts: ['STOP'] });
    expect(await set(ctx(max.id), { level: 'PAUSE_DISPATCH', scope: 'WORKER', worker: 'Liam' })).toMatchObject({ live: true });
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
    const reg1 = await db.hostRegistration.findFirstOrThrow({ where: { appId: app.id, hostId: 'orca1' }, select: { id: true } });
    expect(JSON.stringify(e?.extensions)).toContain(reg1.id);
    expect(JSON.stringify(e?.extensions)).not.toContain(await orca2Reg().then((r) => r.id));
    await dueWakes(keyCtx(orca1Key), { accepts: ['STOP'] });
    expect(await set(ctx(max.id), { level: 'PAUSE', scope: 'TEAM', worker: 'Ada' })).toMatchObject({ live: true });
  });

  it('a refusal names the count and lanes, never worker text', async () => {
    await dueWakes(ctx(max.id), { accepts: ['STOP'] });
    const e = await refusal(set(ctx(max.id), { level: 'PAUSE', scope: 'HOST', host: 'orca2' }));
    expect(e?.extensions?.code).toBe('STOP_SIGNAL_UNAVAILABLE');
    expect(e?.extensions).toMatchObject({ workers: 1, lanes: [(await orca2Reg()).id] });
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
