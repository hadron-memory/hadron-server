/** S7 (#2023, R85): isolateWorker / clearWorkerIsolation — the authority matrix, bounds, and the worker's own pause left alone. */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { setS7AvailableForTest } from '../../../lib/tickers/s7Availability.js';
import { generateId } from '../../../lib/id.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
const ctx = (userId?: string, extra: Partial<Context> = {}): Context => ({ db, userId, roles: ['READER'], ...extra });
const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(GraphQLError); return String((e as GraphQLError).extensions?.code); }
  throw new Error('expected a refusal');
};
let admin: { id: string }, holder: { id: string }, member: { id: string }, outsider: { id: string };
let orgId: string;
let app: { id: string }, agentId: string, liam: { id: string }, anne: { id: string };
const asWorker = (w: { id: string }, fn: () => Promise<any>) => runAsActor({ workerId: w.id, agentId }, fn);
const row = () => db.workerWakeSettings.findUnique({ where: { workerId: liam.id } });
const hours = (n: number) => new Date(Date.now() + n * 3_600_000);
const isolate = (c: Context, until?: Date) => M.isolateWorker({}, { workerRef: liam.id, ...(until ? { until } : {}) }, c);
const clear = (c: Context) => M.clearWorkerIsolation({}, { workerRef: liam.id }, c);

beforeEach(async () => {
  setS7AvailableForTest(true); // mechanism tests; the inert contract is pinned in inertS7a.test.ts
  await cleanDb(db);
  const s = `${Date.now()}-${Math.floor(Math.random() * 1e5)}`;
  const org = await db.organization.create({ data: { id: generateId(), name: 'iso', urn: `iso-${s}.com` } });
  const u = async (n: number) => (await db.user.create({ data: { id: generateId(), githubId: 97_000 + n, githubUsername: `iso-${n}-${s}`, roles: ['READER'] }, select: { id: true } }));
  [admin, holder, member, outsider] = [await u(1), await u(2), await u(3), await u(4)];
  orgId = org.id;
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  agentId = (await M.createAgent({}, { orgId: org.id, name: 'Iso Agent' }, ctx(admin.id))).id;
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Iso', urn: `${org.urn}:team` } });
  for (const x of [holder, member]) await db.appMember.create({ data: { appId: app.id, userId: x.id, role: 'member' } });
  const w = (name: string, extra: object = {}) => db.worker.create({ data: { id: generateId(), appId: app.id, agentId, name, slug: name.toLowerCase(), signature: '', trailer: '', ...extra }, select: { id: true } });
  liam = await w('Liam', { heldByUserId: holder.id, heldAt: new Date() });
  anne = await w('Anne');
});

describe('isolateWorker authority', () => {
  it('a manager and the holder, as themselves, can set, extend, shorten and clear', async () => {
    const a = await isolate(ctx(admin.id), hours(1));
    expect(a.isolatedByUserId).toBe(admin.id);
    const b = await isolate(ctx(holder.id), hours(3));
    expect(b).toMatchObject({ isolatedByUserId: holder.id });
    expect((await row())!.isolatedUntil!.getTime()).toBeGreaterThan(hours(2).getTime());
    await isolate(ctx(admin.id), hours(1));
    expect((await row())!.isolatedUntil!.getTime()).toBeLessThan(hours(2).getTime());
    const cleared = await clear(ctx(holder.id));
    expect(cleared).toMatchObject({ isolatedUntil: null, isolatedAt: null, isolatedByUserId: null });
  });
  it('refuses everyone else, with the row unchanged', async () => {
    const refusals: Array<[string, () => Promise<unknown>]> = [
      ['participant who is neither', () => isolate(ctx(member.id))],
      ['the worker\'s own session', () => asWorker(liam, () => isolate(ctx(holder.id)))],
      ["a manager's worker session", () => asWorker(anne, () => isolate(ctx(admin.id)))],
      ['the holder acting through another worker', () => asWorker(anne, () => isolate(ctx(holder.id)))],
      ['an impersonation', () => isolate(ctx(admin.id, { impersonation: { sessionId: generateId(), actorUserId: outsider.id, orgId: orgId, expiresAt: hours(1) } } as never))],
    ];
    for (const [who, call] of refusals) {
      const code = await codeOf(call());
      expect({ who, code: ['WORKER_ISOLATION_FORBIDDEN', 'FORBIDDEN'].includes(code) }).toEqual({ who, code: true });
    }
    for (const [who, call] of [['an outsider', () => isolate(ctx(outsider.id))], ['an App key', () => isolate(ctx(undefined, { appId: app.id } as never))]] as const) {
      expect({ who, refused: await codeOf(call()) !== '' }).toEqual({ who, refused: true });
    }
    expect(await row()).toBeNull();
  });
  it('the same matrix holds for clearing: a live isolation survives every refused clear', async () => {
    await isolate(ctx(admin.id), hours(2));
    const before = (await row())!.isolatedUntil!.getTime();
    for (const call of [() => clear(ctx(member.id)), () => asWorker(liam, () => clear(ctx(holder.id))), () => asWorker(anne, () => clear(ctx(admin.id)))]) await codeOf(call());
    expect((await row())!.isolatedUntil!.getTime()).toBe(before);
  });
  it('a revoked holder (no longer a participant) is refused', async () => {
    await db.appMember.deleteMany({ where: { appId: app.id, userId: holder.id } });
    await codeOf(isolate(ctx(holder.id)));
    expect(await row()).toBeNull();
  });
});

describe('isolateWorker bounds and the worker\'s own pause', () => {
  it('defaults to two hours; refuses a past time and one beyond seven days', async () => {
    const r = await isolate(ctx(admin.id));
    const ms = r.isolatedUntil.getTime() - Date.now();
    expect(ms).toBeGreaterThan(2 * 3_600_000 - 60_000); expect(ms).toBeLessThanOrEqual(2 * 3_600_000);
    expect(await codeOf(isolate(ctx(admin.id), new Date(Date.now() - 1000)))).toBe('BAD_USER_INPUT');
    expect(await codeOf(isolate(ctx(admin.id), new Date(Date.now() + 8 * 86_400_000)))).toBe('BAD_USER_INPUT');
  });
  it('R85: never touches paused_until; the worker still sets and ends its own pause while isolated', async () => {
    const pause = hours(5);
    await asWorker(liam, () => M.setWorkerWakeSettings({}, { workerRef: liam.id, input: { pausedUntil: pause } }, ctx(holder.id)));
    await isolate(ctx(admin.id), hours(1));
    expect((await row())!.pausedUntil!.getTime()).toBe(pause.getTime());
    await asWorker(liam, () => M.setWorkerWakeSettings({}, { workerRef: liam.id, input: { clearPause: true } }, ctx(holder.id)));
    expect(await row()).toMatchObject({ pausedUntil: null });
    expect((await row())!.isolatedUntil).not.toBeNull();
    await clear(ctx(admin.id));
    expect((await row())!.pausedUntil).toBeNull();
  });
  it('setWorkerWakeSettings never writes the isolation columns', async () => {
    await isolate(ctx(admin.id), hours(1));
    const before = await row();
    await M.setWorkerWakeSettings({}, { workerRef: liam.id, input: { mentions: 'OFF' } }, ctx(admin.id));
    expect(await row()).toMatchObject({ isolatedUntil: before!.isolatedUntil, isolatedAt: before!.isolatedAt, isolatedByUserId: before!.isolatedByUserId });
  });
  it('clearing when nothing is set answers the unchanged settings', async () => {
    expect(await clear(ctx(admin.id))).toMatchObject({ isolatedUntil: null });
  });
  it('reads: isolated is live-only, and carries the setter handle', async () => {
    await isolate(ctx(admin.id), hours(1));
    const s = await Q.workerWakeSettings({}, { workerRef: liam.id }, ctx(member.id));
    const F = (resolvers as any).WorkerWakeSettings;
    expect(F.isolated(s)).toBe(true);
    expect(await F.isolatedByHandle(s, {}, ctx(member.id))).toBe((await db.user.findUniqueOrThrow({ where: { id: admin.id } })).handle);
    expect(F.isolated({ isolatedUntil: new Date(Date.now() - 1) })).toBe(false);
  });
});

describe('S7a is inert (Ada #25399, #25407)', () => {
  it('isolating is refused with the typed error and the row is unchanged; a clear still works', async () => {
    setS7AvailableForTest(false);
    let err: unknown;
    try { await isolate(ctx(admin.id), hours(1)); } catch (e) { err = e; }
    expect((err as GraphQLError).extensions?.code).toBe('WORKER_ISOLATION_UNAVAILABLE');
    expect(await row()).toBeNull();
    expect(await clear(ctx(admin.id))).toMatchObject({ isolatedUntil: null });
  });
  it('a STORED live isolation projects as none', async () => {
    await db.workerWakeSettings.create({ data: { workerId: liam.id, isolatedUntil: hours(1), isolatedAt: new Date(), isolatedByUserId: admin.id } });
    setS7AvailableForTest(false);
    expect(await clear(ctx(admin.id))).toMatchObject({ isolatedUntil: null, isolatedAt: null, isolatedByUserId: null });
    await db.workerWakeSettings.update({ where: { workerId: liam.id }, data: { isolatedUntil: hours(1), isolatedAt: new Date(), isolatedByUserId: admin.id } });
    const out = await (resolvers as any).Query.workerWakeSettings?.({}, { workerRef: liam.id }, ctx(admin.id)).catch(() => null);
    if (out) expect(out.isolatedUntil).toBeNull();
  });
});
