/**
 * #3045 (cor:agt:090:04 V20) — a live `pause-dispatch`'s coordinators are live, both ways: a worker that becomes one of
 * its coordinators gets the stop notice then; one that stops being one gets one resume, unless another live
 * `pause-dispatch` still names it, in which case no resume is sent and its undelivered notice of the signal is dropped.
 * Who the coordinators are (H24) is the definition `pauseDispatchRecipients` computes today, unchanged here.
 *
 * Cast (as stopSignals2022.test.ts): Ada heads a team, Liam and Dan report to her; Kit is outside every team.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { APP_KEY_PREFIX, hashAppKey } from '../../middleware/auth.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
import { declareAllStopLanes } from '../../test/stopLanes.js';
import { pendingStopNotices } from './delivery.js';
import { serveEveryAgent } from '../../test/servedBootPrompt.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));
vi.mock('../bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const M = resolvers.Mutation as any;
const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] }) as Context;

let org: { id: string; urn: string };
let app: { id: string };
let agentId: string;
let max: { id: string };
let mia: { id: string };
let ada: { id: string };
let liam: { id: string };
let dan: { id: string };
let kit: { id: string };
let orca1: { id: string };
let orca2: { id: string };
let plainKey: { id: string };

async function mkKey(label: string) {
  const raw = `${APP_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
  return db.appKey.create({ data: { id: generateId(), appId: app.id, keyHash: hashAppKey(raw), keyPreview: raw.slice(-4), label }, select: { id: true } });
}
const keyCtx = (k: { id: string }): Context => ({ db, appId: app.id, appKeyId: k.id, organizationId: org.id, roles: [] }) as Context;

beforeEach(async () => {
  await cleanDb(db);
  delete process.env.DISABLE_TASK_MATCHER;
  const n = Math.floor(Math.random() * 1_000_000);
  org = await db.organization.create({ data: { name: 'Stop', urn: `stop2022-${n}.example` }, select: { id: true, urn: true } });
  const u = (k: number, name: string) =>
    db.user.create({ data: { githubId: k * 1_000_000 + n, githubUsername: `s22-${name}-${n}`, roles: ['READER'] }, select: { id: true } });
  max = await u(71, 'max');
  mia = await u(72, 'mia');
  await db.orgMember.create({ data: { organizationId: org.id, userId: max.id, role: 'ADMIN' } });
  const agent = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(max.id));
  agentId = agent.id;
  await serveEveryAgent(db); // #2712: binds are served
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `${org.urn}:team` }, select: { id: true } });
  await db.appMember.create({ data: { appId: app.id, userId: mia.id, role: 'member' } });
  const w = (name: string, role: string, extra: Record<string, unknown> = {}) =>
    db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId, name, slug: name.toLowerCase(), role, heldByUserId: mia.id, heldAt: new Date(), ...extra }, select: { id: true } });
  ada = await w('Ada', 'coordinator');
  liam = await w('Liam', 'engineer', { reportsToWorkerId: ada.id });
  dan = await w('Dan', 'engineer', { reportsToWorkerId: ada.id });
  kit = await w('Kit', 'engineer');
  orca1 = await mkKey('orca1');
  orca2 = await mkKey('orca2');
  plainKey = await mkKey('plain');
  await M.grantAppKeyScope({}, { id: orca1.id, scope: 'host:operate', hostId: 'orca1' }, ctx(max.id));
  await M.grantAppKeyScope({}, { id: orca2.id, scope: 'host:operate', hostId: 'orca2' }, ctx(max.id));
  await M.registerHost({}, { input: { appRef: app.id, label: 'Orca 1', pollIntervalSeconds: 600, workers: [{ worker: ada.id, family: 'claude' }, { worker: dan.id, family: 'claude' }] } }, keyCtx(orca1));
  await M.registerHost({}, { input: { appRef: app.id, label: 'Orca 2', pollIntervalSeconds: 600, workers: [{ worker: kit.id, family: 'claude' }] } }, keyCtx(orca2));
  // #2173/#2169: setting a signal is refused while a lane has no fresh stop-consumer declaration. This file tests signals
  // themselves, so every lane is declared here; consumerLane2169.test.ts tests the refusal.
  await declareAllStopLanes(db, app.id);
});


const set = (c: Context, input: Record<string, unknown>) => M.setTeamStopSignal({}, { input: { appRef: app.id, ...input } }, c);
const lift = (c: Context, id: string) => M.liftTeamStopSignal({}, { appRef: app.id, id }, c);
const reportsTo = (w: { id: string }, to: { id: string } | null) => M.setWorkerReportsTo({}, { workerRef: w.id, reportsTo: to?.id ?? null }, ctx(max.id));
/** A worker's coordinator notices, oldest first, as `signal:notice` with the signal named by its label. */
async function told(w: { id: string }, label: Record<string, string>): Promise<string[]> {
  const rows = await db.agentTeamEvent.findMany({ where: { appId: app.id, type: 'stop.notice', subjectWorkerId: w.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  return rows.map((r) => {
    const p = r.payload as { signalId: string; notice: string };
    return `${label[p.signalId] ?? p.signalId}:${p.notice}`;
  });
}
const deliver = async (w: { id: string }) => {
  const e = await db.agentTeamEvent.findMany({ where: { appId: app.id, type: 'stop.notice', subjectWorkerId: w.id }, select: { id: true } });
  for (const { id } of e) await db.workerDeliveryTaskEvent.create({ data: { workerId: w.id, eventId: id, chainIndex: 0, deliveredAt: new Date() } });
};

describe('#3045 cor:agt:090:04 V20 — the coordinator set of a live pause-dispatch', () => {
  it('S12: Dan moves from Ada to Liam under a worker pause-dispatch on Dan: Liam gets the notice, Ada one resume', async () => {
    const s = await set(ctx(max.id), { level: 'PAUSE_DISPATCH', scope: 'WORKER', worker: 'Dan' });
    const L = { [s.id]: 'D' };
    expect(await told(ada, L)).toEqual(['D:stop']);
    await reportsTo(dan, liam);
    expect(await told(liam, L)).toEqual(['D:stop']);
    expect(await told(ada, L)).toEqual(['D:stop', 'D:resume']);
    expect(await told(dan, L)).toEqual([]);
  });

  it('no change of the set sends nothing: a second reconcile, and a move between two lines naming the same coordinator', async () => {
    const s = await set(ctx(max.id), { level: 'PAUSE_DISPATCH', scope: 'WORKER', worker: 'Dan' });
    await reportsTo(kit, ada); // Kit joins Ada's team: Dan's coordinator is still Ada
    await reportsTo(kit, null);
    expect(await told(ada, { [s.id]: 'D' })).toEqual(['D:stop']);
    expect(await told(kit, { [s.id]: 'D' })).toEqual([]);
  });

  it('a coordinator that leaves and returns is told again; it was resumed in between (one notice per change)', async () => {
    const s = await set(ctx(max.id), { level: 'PAUSE_DISPATCH', scope: 'WORKER', worker: 'Dan' });
    const L = { [s.id]: 'D' };
    await reportsTo(dan, liam);
    await reportsTo(dan, ada);
    expect(await told(ada, L)).toEqual(['D:stop', 'D:resume', 'D:stop']);
    expect(await told(liam, L)).toEqual(['D:stop', 'D:resume']);
  });

  it('suppression: Ada leaves signal A but signal B still names her: no resume for A, and A\'s undelivered notice is dropped', async () => {
    const a = await set(ctx(max.id), { level: 'PAUSE_DISPATCH', scope: 'WORKER', worker: 'Dan' });
    const b = await set(ctx(max.id), { level: 'PAUSE_DISPATCH', scope: 'WORKER', worker: 'Liam' });
    const L = { [a.id]: 'A', [b.id]: 'B' };
    expect(await told(ada, L)).toEqual(['A:stop', 'B:stop']);
    await reportsTo(dan, liam);
    expect(await told(ada, L).then((x) => x.filter((n) => n.endsWith(':resume')))).toEqual([]);
    // Liam gains A, and B too: B covers Liam and Dan now reports to him (the definition, unchanged).
    expect(await told(liam, L)).toEqual(['A:stop', 'B:stop']);
    // A's stop was never delivered to Ada and no longer applies: only B's is offered, then nothing.
    const offered = await pendingStopNotices(db, app.id, [ada.id]);
    expect(offered.get(ada.id)?.signalId).toBe(b.id);
  });

  it('suppression, delivered: Ada was told A and leaves it while B names her: still no resume for A', async () => {
    const a = await set(ctx(max.id), { level: 'PAUSE_DISPATCH', scope: 'WORKER', worker: 'Dan' });
    const b = await set(ctx(max.id), { level: 'PAUSE_DISPATCH', scope: 'WORKER', worker: 'Liam' });
    await deliver(ada);
    await reportsTo(dan, liam);
    expect(await told(ada, { [a.id]: 'A', [b.id]: 'B' })).toEqual(['A:stop', 'B:stop']);
  });

  it('suppression ends: when B is lifted Ada is no longer named by anything, and she leaves A at the next change', async () => {
    const a = await set(ctx(max.id), { level: 'PAUSE_DISPATCH', scope: 'WORKER', worker: 'Dan' });
    const b = await set(ctx(max.id), { level: 'PAUSE_DISPATCH', scope: 'WORKER', worker: 'Liam' });
    await lift(ctx(max.id), b.id);
    await reportsTo(dan, liam);
    const L = { [a.id]: 'A', [b.id]: 'B' };
    expect(await told(ada, L)).toEqual(['A:stop', 'B:stop', 'B:resume', 'A:resume']);
  });

  it('trigger, coverage: a worker joining a team under a team pause-dispatch makes Liam a coordinator', async () => {
    const s = await set(ctx(max.id), { level: 'PAUSE_DISPATCH', scope: 'TEAM', worker: 'Ada' });
    const L = { [s.id]: 'T' };
    expect(await told(liam, L)).toEqual([]);
    await reportsTo(kit, liam); // Kit is now covered, and Liam is someone covered workers report to
    expect(await told(liam, L)).toEqual(['T:stop']);
    expect(await told(ada, L)).toEqual(['T:stop']);
  });

  it('trigger, host registration: re-registering a host under a host pause-dispatch changes who is told', async () => {
    const s = await set(ctx(max.id), { level: 'PAUSE_DISPATCH', scope: 'HOST', host: 'orca2' });
    const L = { [s.id]: 'H' };
    expect(await told(ada, L)).toEqual([]); // Kit alone: no one above it, the manager is told
    await M.registerHost({}, { input: { appRef: app.id, label: 'Orca 2', pollIntervalSeconds: 600, workers: [{ worker: kit.id, family: 'claude' }, { worker: dan.id, family: 'claude' }] } }, keyCtx(orca2));
    expect(await told(ada, L)).toEqual(['H:stop']);
    await M.registerHost({}, { input: { appRef: app.id, label: 'Orca 2', pollIntervalSeconds: 600, workers: [{ worker: kit.id, family: 'claude' }] } }, keyCtx(orca2));
    expect(await told(ada, L)).toEqual(['H:stop', 'H:resume']);
  });

  it('an ended signal is no longer live: a later change sends nothing for it', async () => {
    const s = await set(ctx(max.id), { level: 'PAUSE_DISPATCH', scope: 'WORKER', worker: 'Dan' });
    await lift(ctx(max.id), s.id);
    await reportsTo(dan, liam);
    expect(await told(ada, { [s.id]: 'D' })).toEqual(['D:stop', 'D:resume']);
    expect(await told(liam, { [s.id]: 'D' })).toEqual([]);
  });

  it('an own-level pause stream is untouched by a coordinator change (V21): Dan keeps his one pause notice', async () => {
    await set(ctx(max.id), { level: 'PAUSE', scope: 'WORKER', worker: 'Dan' });
    await set(ctx(max.id), { level: 'PAUSE_DISPATCH', scope: 'WORKER', worker: 'Dan' });
    await reportsTo(dan, liam);
    const rows = await db.agentTeamEvent.findMany({ where: { appId: app.id, type: 'stop.notice', subjectWorkerId: dan.id } });
    expect(rows.map((r) => (r.payload as { level: string }).level)).toEqual(['pause']);
  });
});
