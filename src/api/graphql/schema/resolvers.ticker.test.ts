import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
/**
 * #1747 — Tickers S1 (epic #1659): models, App settings, CRUD, the §5
 * authorization matrix, the may-subscribe-workers grant and its announcement.
 *
 * One case per PRINCIPAL SHAPE for each act (plan §5): the holder; a member who
 * is not the holder; a manager by each `managesApp` arm; the worker's own
 * session; another worker's session; the grantee's session with a person behind
 * it; an App key. A worker acts through its session, which these tests
 * reproduce with `runAsActor` — the same holder the auth middleware fills.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { resolvers, type Context } from './resolvers.js';
import { teamChatMutations } from './resolvers.teamChat.js';
import { extractMentions } from '../../../lib/teamChatMentions.js';
import { resolveTickerRef } from '../../../lib/tickers/tickerRef.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
const F = resolvers as any;

function ctx(userId?: string, extra: Partial<Context> = {}): Context {
  return { db, userId, roles: ['READER'], ...extra };
}

async function expectCode(p: Promise<unknown>, code: string) {
  try {
    await p;
    expect.fail(`expected rejection with extensions.code=${code}`);
  } catch (e) {
    expect(e).toBeInstanceOf(GraphQLError);
    expect((e as GraphQLError).extensions?.code).toBe(code);
  }
}

let org: { id: string; urn: string };
let admin: { id: string };
let appOwner: { id: string };
let member: { id: string };
let liamHolder: { id: string };
let coordHolder: { id: string };
let outsider: { id: string };
let teamAgent: { id: string };
let app: { id: string; urn: string };
let otherApp: { id: string; urn: string };
let anne: { id: string };
let liam: { id: string };
let rook: { id: string };
let retired: { id: string };
let zed: { id: string };

const asWorker = (w: { id: string }, fn: () => Promise<any>): Promise<any> =>
  runAsActor({ workerId: w.id, agentId: teamAgent.id }, fn);

async function user(suffix: string, n: number) {
  return db.user.create({
    data: { id: generateId(), githubId: 96_000 + n, githubUsername: `tk-${n}-${suffix}`, roles: ['READER'] },
    select: { id: true },
  });
}

async function worker(appId: string, name: string, extra: Record<string, unknown> = {}) {
  return db.worker.create({
    data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId, agentId: teamAgent.id, name, slug: name.toLowerCase(), ...extra },
    select: { id: true },
  });
}

const createTicker = (c: Context, input: Record<string, unknown> = {}, appRef = app.id) =>
  M.createTicker({}, { appRef, input: { name: 'Engineering', cadenceSeconds: 600, ...input } }, c);
const subscribe = (c: Context, t: { id: string }, w: { id: string }) =>
  M.subscribeWorker({}, { tickerRef: t.id, workerRef: w.id }, c);
const unsubscribe = (c: Context, t: { id: string }, w: { id: string }) =>
  M.unsubscribeWorker({}, { tickerRef: t.id, workerRef: w.id }, c);
const setSettings = (c: Context, input: Record<string, unknown>) =>
  M.setAppTickerSettings({}, { appRef: app.id, input }, c);
const grant = (c: Context, w: { id: string }, appRef = app.id) =>
  M.grantApp({}, { appRef, workerRef: w.id, name: 'TICKER_SUBSCRIBE_WORKERS' }, c);
const revoke = (c: Context, w: { id: string }) =>
  M.revokeAppGrant({}, { appRef: app.id, workerRef: w.id, name: 'TICKER_SUBSCRIBE_WORKERS' }, c);
const liveSubs = (tickerId: string) => db.tickerSubscription.findMany({ where: { tickerId, endedAt: null } });

let post: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({ data: { id: generateId(), name: 'tk-org', urn: `tk-org-${suffix}.com` } });
  admin = await user(suffix, 1);
  appOwner = await user(suffix, 2);
  member = await user(suffix, 3);
  liamHolder = await user(suffix, 4);
  coordHolder = await user(suffix, 5);
  outsider = await user(suffix, 6);
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  const created = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(admin.id));
  teamAgent = { id: created.id };
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  otherApp = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Other', urn: `${org.urn}:other` } });
  for (const [u, role] of [[appOwner, 'owner'], [member, 'member'], [liamHolder, 'member'], [coordHolder, 'member']] as const) {
    await db.appMember.create({ data: { appId: app.id, userId: u.id, role } });
  }
  anne = await worker(app.id, 'Anne', { heldByUserId: coordHolder.id, heldAt: new Date() });
  liam = await worker(app.id, 'Liam', { heldByUserId: liamHolder.id, heldAt: new Date() });
  rook = await worker(app.id, 'Rook');
  retired = await worker(app.id, 'Old', { retiredAt: new Date() });
  zed = await worker(otherApp.id, 'Zed');
  // The grant announcement posts to team chat; most tests don't care about the chat itself.
  post = vi.spyOn(teamChatMutations, 'createTeamChatMessage').mockResolvedValue({} as never);
});

afterEach(() => {
  post.mockRestore();
});

describe('tickers — create, read, URN, slug', () => {
  it('creates a ticker owned by the caller (never an argument), with a computed URN', async () => {
    const t = await createTicker(ctx(member.id));
    expect(t).toMatchObject({ name: 'Engineering', slug: 'engineering', cadenceSeconds: 600, relevance: 'ALL', enabled: true });
    expect(t.ownerUserId).toBe(member.id);
    expect(t.createdBy).toBe(member.id);
    expect(await F.Ticker.urn(t, {}, ctx(member.id))).toBe(`hrn:ticker:${org.urn}:team:engineering`);
    expect(await Q.ticker({}, { ref: `hrn:ticker:${org.urn}:team:engineering` }, ctx(member.id))).toMatchObject({ id: t.id });
    expect(await Q.ticker({}, { ref: t.id }, ctx(member.id))).toMatchObject({ id: t.id });
  });

  it('a session bound to a worker of the App creates a worker-owned ticker, attributed (#1610)', async () => {
    const t = await asWorker(liam, () => createTicker(ctx(liamHolder.id)));
    expect(t).toMatchObject({ ownerWorkerId: liam.id, ownerUserId: null, createdByWorkerId: liam.id, createdByAgentId: teamAgent.id });
  });

  it('refuses a caller who is not a participant, like an absent App', async () => {
    await expectCode(createTicker(ctx(outsider.id)), 'APP_NOT_FOUND');
    await expectCode(createTicker(ctx(undefined)), 'APP_NOT_FOUND');
    await expectCode(createTicker(ctx(admin.id), {}, generateId()), 'APP_NOT_FOUND');
  });

  it('refuses an App key (a bare key is no participant)', async () => {
    await expectCode(createTicker(ctx(undefined, { appId: app.id } as Partial<Context>)), 'APP_NOT_FOUND');
    // #2931: the line above has no appKeyId, so it is "no user", not a key. A real key, holding host:operate (which
    // now READS its host's tickers), still creates none.
    const key = await db.appKey.create({ data: { id: generateId(), appId: app.id, keyHash: `h-${generateId()}`, keyPreview: 'abcd' }, select: { id: true } });
    await M.grantAppKeyScope({}, { id: key.id, scope: 'host:operate', hostId: 'orca1' }, ctx(admin.id));
    await expectCode(createTicker({ db, appId: app.id, appKeyId: key.id, roles: [] }), 'APP_NOT_FOUND');
  });

  it('a duplicate live name is refused ignoring case; the name is reusable after delete, the slug is not', async () => {
    const first = await createTicker(ctx(member.id));
    await expectCode(createTicker(ctx(member.id), { name: 'ENGINEERING' }), 'TICKER_NAME_TAKEN');
    expect(await M.deleteTicker({}, { ref: first.id }, ctx(member.id))).toBe(true);
    const again = await createTicker(ctx(member.id));
    expect(again.slug).toBe('engineering-2');
    const third = await createTicker(ctx(member.id), { name: 'Engineering!' });
    expect(third.slug).toBe('engineering-3');
    // The deleted ticker is no longer listed or readable by the public query, but its
    // permanent slug still resolves as an identity (history).
    expect(await Q.ticker({}, { ref: first.id }, ctx(member.id))).toBeNull();
    expect((await resolveTickerRef(db, `hrn:ticker:${org.urn}:team:engineering`)).id).toBe(first.id);
    expect((await Q.tickers({}, { appRef: app.id }, ctx(member.id))).map((t: any) => t.id).sort()).toEqual([again.id, third.id].sort());
  });

  it('a name that slugifies to nothing still creates, with the fallback slug', async () => {
    expect((await createTicker(ctx(member.id), { name: '!!!' })).slug).toBe('ticker');
  });

  it('the cadence must be within [App floor, 86400]', async () => {
    await expectCode(createTicker(ctx(member.id), { cadenceSeconds: 119 }), 'TICKER_CADENCE_OUT_OF_RANGE');
    await expectCode(createTicker(ctx(member.id), { cadenceSeconds: 86_401 }), 'TICKER_CADENCE_OUT_OF_RANGE');
    await expectCode(createTicker(ctx(member.id), { cadenceSeconds: 600.5 }), 'TICKER_CADENCE_OUT_OF_RANGE');
    await expect(createTicker(ctx(member.id), { cadenceSeconds: 120 })).resolves.toBeTruthy();
    await expect(createTicker(ctx(member.id), { name: 'Daily', cadenceSeconds: 86_400 })).resolves.toBeTruthy();
  });

  it('the live-ticker cap is enforced, and a manager raising it admits one more', async () => {
    await setSettings(ctx(admin.id), { liveCap: 2 });
    await createTicker(ctx(member.id), { name: 'A' });
    await createTicker(ctx(member.id), { name: 'B' });
    await expectCode(createTicker(ctx(member.id), { name: 'C' }), 'TICKER_LIMIT_REACHED');
    await setSettings(ctx(admin.id), { liveCap: 3 });
    await expect(createTicker(ctx(member.id), { name: 'C' })).resolves.toBeTruthy();
    // A deleted ticker frees a slot.
    const [a] = await Q.tickers({}, { appRef: app.id }, ctx(member.id));
    await M.deleteTicker({}, { ref: a.id }, ctx(member.id));
    await expect(createTicker(ctx(member.id), { name: 'D' })).resolves.toBeTruthy();
  });

  it('concurrent creates cannot overshoot the cap', async () => {
    await setSettings(ctx(admin.id), { liveCap: 3 });
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) => createTicker(ctx(member.id), { name: `T${i}` })),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    expect(await db.ticker.count({ where: { appId: app.id, deletedAt: null } })).toBe(3);
  });

  it('validates quiet hours at save: every invalid shape is refused', async () => {
    const ok = { timezone: 'America/Los_Angeles', windows: [{ days: [1, 2, 3, 4, 5], from: '22:00', to: '07:00' }] };
    await expect(createTicker(ctx(member.id), { quietHours: ok })).resolves.toMatchObject({ quietHours: ok });
    const bad: Array<[string, unknown]> = [
      ['not an object', 'nope'],
      ['unknown zone', { timezone: 'Mars/Olympus', windows: ok.windows }],
      ['no windows', { timezone: 'UTC', windows: [] }],
      ['bad time', { timezone: 'UTC', windows: [{ days: [1], from: '25:00', to: '07:00' }] }],
      ['bad day', { timezone: 'UTC', windows: [{ days: [0], from: '01:00', to: '02:00' }] }],
      ['no days', { timezone: 'UTC', windows: [{ days: [], from: '01:00', to: '02:00' }] }],
      ['dup day', { timezone: 'UTC', windows: [{ days: [1, 1], from: '01:00', to: '02:00' }] }],
      ['zero length', { timezone: 'UTC', windows: [{ days: [1], from: '03:00', to: '03:00' }] }],
      ['overlap', { timezone: 'UTC', windows: [{ days: [1], from: '01:00', to: '05:00' }, { days: [1], from: '04:00', to: '06:00' }] }],
      ['overnight overlap', { timezone: 'UTC', windows: [{ days: [1], from: '22:00', to: '03:00' }, { days: [2], from: '02:00', to: '04:00' }] }],
      ['wrap overlap sunday', { timezone: 'UTC', windows: [{ days: [7], from: '23:00', to: '02:00' }, { days: [1], from: '01:00', to: '03:00' }] }],
      ['15 windows', { timezone: 'UTC', windows: Array.from({ length: 15 }, (_, i) => ({ days: [(i % 7) + 1], from: `${String(i).padStart(2, '0')}:00`, to: `${String(i).padStart(2, '0')}:30` })) }],
    ];
    for (const [label, quietHours] of bad) {
      await expectCode(createTicker(ctx(member.id), { name: `Q ${label}`, quietHours }), 'TICKER_QUIET_HOURS_INVALID');
    }
    // Back-to-back windows share an edge but do not overlap (a window excludes its end).
    await expect(
      createTicker(ctx(member.id), {
        name: 'Edge', quietHours: { timezone: 'UTC', windows: [{ days: [1], from: '01:00', to: '02:00' }, { days: [1], from: '02:00', to: '03:00' }] },
      }),
    ).resolves.toBeTruthy();
  });

  it('refuses a channel the caller cannot read', async () => {
    await expectCode(createTicker(ctx(member.id), { channelIds: [generateId()] }), 'BAD_USER_INPUT');
  });

  it('refuses impersonation (read-only)', async () => {
    await expectCode(
      createTicker(ctx(member.id, { impersonation: { sessionId: generateId(), actorUserId: admin.id, orgId: org.id, expiresAt: new Date(Date.now() + 60_000) } } as Partial<Context>)),
      'FORBIDDEN',
    );
  });
});

describe('tickers — edit and delete', () => {
  it('the owner, the owning worker\'s holder, and each manager arm may edit; others may not', async () => {
    const mine = await createTicker(ctx(member.id), { name: 'Mine' });
    const lw = await asWorker(liam, () => createTicker(ctx(liamHolder.id), { name: 'Liams' }));
    // owner
    await expect(M.updateTicker({}, { ref: mine.id, input: { cadenceSeconds: 900 } }, ctx(member.id))).resolves.toMatchObject({ cadenceSeconds: 900 });
    // a member who is not the owner
    await expectCode(M.updateTicker({}, { ref: mine.id, input: { enabled: false } }, ctx(coordHolder.id)), 'FORBIDDEN');
    // the owning worker itself
    await expect(asWorker(liam, () => M.updateTicker({}, { ref: lw.id, input: { enabled: false } }, ctx(liamHolder.id)))).resolves.toMatchObject({ enabled: false });
    // another worker's session
    await expectCode(asWorker(anne, () => M.updateTicker({}, { ref: lw.id, input: { enabled: true } }, ctx(coordHolder.id))), 'FORBIDDEN');
    // the owning worker's holder, as a person
    await expect(M.updateTicker({}, { ref: lw.id, input: { enabled: true } }, ctx(liamHolder.id))).resolves.toMatchObject({ enabled: true });
    // managers: App owner-role member, org ADMIN
    await expect(M.updateTicker({}, { ref: mine.id, input: { name: 'Renamed' } }, ctx(appOwner.id))).resolves.toMatchObject({ name: 'Renamed', slug: 'mine' });
    await expect(M.updateTicker({}, { ref: mine.id, input: { enabled: false } }, ctx(admin.id))).resolves.toMatchObject({ enabled: false });
    // a manager's holder-style access does not pass through a worker session
    await expectCode(asWorker(anne, () => M.updateTicker({}, { ref: mine.id, input: { enabled: true } }, ctx(admin.id))), 'FORBIDDEN');
    // a non-participant: concealed
    await expectCode(M.updateTicker({}, { ref: mine.id, input: { enabled: true } }, ctx(outsider.id)), 'TICKER_NOT_FOUND');
    await expectCode(M.deleteTicker({}, { ref: mine.id }, ctx(coordHolder.id)), 'FORBIDDEN');
  });

  it('renaming checks the live-name rule against other tickers only; the slug is permanent', async () => {
    const a = await createTicker(ctx(member.id), { name: 'Alpha' });
    await createTicker(ctx(member.id), { name: 'Beta' });
    await expectCode(M.updateTicker({}, { ref: a.id, input: { name: 'beta' } }, ctx(member.id)), 'TICKER_NAME_TAKEN');
    const renamed = await M.updateTicker({}, { ref: a.id, input: { name: 'ALPHA' } }, ctx(member.id));
    expect(renamed).toMatchObject({ name: 'ALPHA', slug: 'alpha' });
  });

  it('clears quiet hours and channels explicitly, never by absence', async () => {
    const quietHours = { timezone: 'UTC', windows: [{ days: [1], from: '01:00', to: '02:00' }] };
    const t = await createTicker(ctx(member.id), { quietHours });
    const same = await M.updateTicker({}, { ref: t.id, input: { enabled: false } }, ctx(member.id));
    expect(same.quietHours).toEqual(quietHours);
    const cleared = await M.updateTicker({}, { ref: t.id, input: { clearQuietHours: true } }, ctx(member.id));
    expect(cleared.quietHours).toBeNull();
    await expectCode(M.updateTicker({}, { ref: t.id, input: { quietHours, clearQuietHours: true } }, ctx(member.id)), 'BAD_USER_INPUT');
  });

  it('delete ends the subscriptions TICKER_DELETED and keeps the history', async () => {
    const t = await createTicker(ctx(member.id));
    await subscribe(ctx(liamHolder.id), t, liam);
    await subscribe(ctx(admin.id), t, rook);
    await M.deleteTicker({}, { ref: t.id }, ctx(member.id));
    const rows = await db.tickerSubscription.findMany({ where: { tickerId: t.id } });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.endedReason === 'TICKER_DELETED' && r.endedAt && r.endedBy === member.id)).toBe(true);
    await expectCode(M.updateTicker({}, { ref: t.id, input: { enabled: true } }, ctx(member.id)), 'TICKER_NOT_FOUND');
  });
});

describe('App ticker settings', () => {
  it('defaults, and only whoever manages the App may change them', async () => {
    expect(await Q.appTickerSettings({}, { appRef: app.id }, ctx(member.id))).toMatchObject({
      minCadenceSeconds: 120, selfSubscribeCadenceSeconds: 600, liveCap: 20, dailyWakeBudget: 864, dailyWakeBudgetDerived: true,
    });
    await expectCode(setSettings(ctx(member.id), { liveCap: 5 }), 'FORBIDDEN');
    await expectCode(asWorker(anne, () => setSettings(ctx(coordHolder.id), { liveCap: 5 })), 'FORBIDDEN');
    await expectCode(setSettings(ctx(outsider.id), { liveCap: 5 }), 'APP_NOT_FOUND');
    await expect(setSettings(ctx(appOwner.id), { liveCap: 5 })).resolves.toMatchObject({ liveCap: 5 });
    await expect(setSettings(ctx(admin.id), { liveCap: 6 })).resolves.toMatchObject({ liveCap: 6 });
  });

  it('refuses out-of-range values', async () => {
    const m = ctx(admin.id);
    await expectCode(setSettings(m, { minCadenceSeconds: 59 }), 'TICKER_SETTINGS_OUT_OF_RANGE');
    await expectCode(setSettings(m, { selfSubscribeCadenceSeconds: 119 }), 'TICKER_SETTINGS_OUT_OF_RANGE');
    await expectCode(setSettings(m, { selfSubscribeCadenceSeconds: 86_401 }), 'TICKER_SETTINGS_OUT_OF_RANGE');
    await expectCode(setSettings(m, { liveCap: 101 }), 'TICKER_SETTINGS_OUT_OF_RANGE');
    await expectCode(setSettings(m, { liveCap: 0 }), 'TICKER_SETTINGS_OUT_OF_RANGE');
    await expectCode(setSettings(m, { wakeDailyBudget: -1 }), 'TICKER_SETTINGS_OUT_OF_RANGE');
    await expect(setSettings(m, { minCadenceSeconds: 60, liveCap: 100, selfSubscribeCadenceSeconds: 60 })).resolves.toBeTruthy();
    // The floor cannot move above the self-subscription cadence it bounds.
    await expectCode(setSettings(m, { minCadenceSeconds: 3000 }), 'TICKER_SETTINGS_OUT_OF_RANGE');
  });

  it('raising the floor above a live ticker is refused, naming it; lowering it is fine', async () => {
    await createTicker(ctx(member.id), { name: 'Fast', cadenceSeconds: 120 });
    await expectCode(setSettings(ctx(admin.id), { minCadenceSeconds: 300 }), 'TICKER_SETTINGS_CONFLICT');
    try {
      await setSettings(ctx(admin.id), { minCadenceSeconds: 300 });
    } catch (e) {
      expect((e as GraphQLError).extensions?.tickers).toEqual(['fast']);
    }
    await expect(setSettings(ctx(admin.id), { minCadenceSeconds: 60 })).resolves.toMatchObject({ minCadenceSeconds: 60 });
  });

  it('derives the daily budget from the roster (workers not retired) unless one is set', async () => {
    // anne, liam, rook are the roster ('Old' is retired): 3 workers x (86400 / 600) x 2, subscribed or not
    expect(await Q.appTickerSettings({}, { appRef: app.id }, ctx(member.id))).toMatchObject({ dailyWakeBudget: 864, dailyWakeBudgetDerived: true });
    expect(await setSettings(ctx(admin.id), { wakeDailyBudget: 10 })).toMatchObject({ dailyWakeBudget: 10, dailyWakeBudgetDerived: false });
    expect(await setSettings(ctx(admin.id), { clearWakeDailyBudget: true })).toMatchObject({ dailyWakeBudget: 864, dailyWakeBudgetDerived: true });
  });
});

describe('subscribe / unsubscribe — the §5 matrix', () => {
  let fast: { id: string };
  let slow: { id: string };
  beforeEach(async () => {
    fast = await createTicker(ctx(member.id), { name: 'Fast', cadenceSeconds: 120 });
    slow = await createTicker(ctx(member.id), { name: 'Slow', cadenceSeconds: 600 });
  });

  it('the holder (as a person) and every manager arm subscribe any ticker', async () => {
    await expect(subscribe(ctx(liamHolder.id), fast, liam)).resolves.toMatchObject({ announcement: null });
    await expect(subscribe(ctx(appOwner.id), fast, rook)).resolves.toBeTruthy();
    await expect(subscribe(ctx(admin.id), fast, anne)).resolves.toBeTruthy();
    expect(await liveSubs(fast.id)).toHaveLength(3);
    // A holder's or manager's own subscribe posts nothing.
    expect(post).not.toHaveBeenCalled();
  });

  it('a member who is not the holder is refused, whether the worker is held or not', async () => {
    await expectCode(subscribe(ctx(member.id), slow, liam), 'SUBSCRIBE_FORBIDDEN');
    await expectCode(subscribe(ctx(member.id), slow, rook), 'SUBSCRIBE_FORBIDDEN');
    await expectCode(subscribe(ctx(liamHolder.id), slow, anne), 'SUBSCRIBE_FORBIDDEN');
    expect(await liveSubs(slow.id)).toHaveLength(0);
  });

  it('R3: a worker subscribes itself only at or below the self-subscription cadence', async () => {
    const own = ctx(liamHolder.id);
    await expectCode(asWorker(liam, () => subscribe(own, fast, liam)), 'SUBSCRIBE_CADENCE_NEEDS_HOLDER');
    await expect(asWorker(liam, () => subscribe(own, slow, liam))).resolves.toBeTruthy();
    // Its holder, as a person, may put it on the fast one.
    await expect(subscribe(ctx(liamHolder.id), fast, liam)).resolves.toBeTruthy();
    // A manager lowers the self-subscription cadence to 300 and the worker's own 300 s subscription succeeds.
    const mid = await createTicker(ctx(member.id), { name: 'Mid', cadenceSeconds: 300 });
    await expectCode(asWorker(liam, () => subscribe(own, mid, liam)), 'SUBSCRIBE_CADENCE_NEEDS_HOLDER');
    // An unheld worker has no holder behind its spend, so the self arm is closed to it altogether.
    await expectCode(asWorker(rook, () => subscribe(ctx(admin.id), mid, rook)), 'SUBSCRIBE_FORBIDDEN');
    await setSettings(ctx(admin.id), { selfSubscribeCadenceSeconds: 300 });
    await expect(asWorker(liam, () => subscribe(own, mid, liam))).resolves.toBeTruthy();
  });

  it('a worker may always unsubscribe itself, even from a ticker faster than its self limit', async () => {
    await subscribe(ctx(liamHolder.id), fast, liam);
    await expect(asWorker(liam, () => unsubscribe(ctx(liamHolder.id), fast, liam))).resolves.toBeTruthy();
    expect(await liveSubs(fast.id)).toHaveLength(0);
    const ended = await db.tickerSubscription.findFirstOrThrow({ where: { tickerId: fast.id } });
    expect(ended).toMatchObject({ endedReason: 'UNSUBSCRIBED', endedByWorkerId: liam.id });
  });

  it('another worker\'s session cannot subscribe a worker (no grant)', async () => {
    await expectCode(asWorker(rook, () => subscribe(ctx(member.id), slow, liam)), 'SUBSCRIBE_FORBIDDEN');
    // and a manager acting THROUGH a worker session does not inherit management
    await expectCode(asWorker(rook, () => subscribe(ctx(admin.id), slow, liam)), 'SUBSCRIBE_FORBIDDEN');
  });

  it('is idempotent for a live subscription and refuses unsubscribing one that does not exist', async () => {
    const a = await subscribe(ctx(admin.id), slow, liam);
    const b = await subscribe(ctx(admin.id), slow, liam);
    expect(b.subscription.id).toBe(a.subscription.id);
    expect(await liveSubs(slow.id)).toHaveLength(1);
    await expectCode(unsubscribe(ctx(admin.id), slow, rook), 'SUBSCRIPTION_NOT_FOUND');
    // Re-subscribing after an unsubscribe makes a new row; the history stays.
    await unsubscribe(ctx(admin.id), slow, liam);
    const c = await subscribe(ctx(admin.id), slow, liam);
    expect(c.subscription.id).not.toBe(a.subscription.id);
    expect(await db.tickerSubscription.count({ where: { tickerId: slow.id, workerId: liam.id } })).toBe(2);
  });

  it('workers of another App, retired workers and absent ones are not subscribable', async () => {
    await expectCode(subscribe(ctx(admin.id), slow, zed), 'WORKER_NOT_FOUND');
    await expectCode(subscribe(ctx(admin.id), slow, { id: generateId() }), 'WORKER_NOT_FOUND');
    await expectCode(subscribe(ctx(admin.id), slow, retired), 'WORKER_RETIRED');
  });

  it('a non-participant sees TICKER_NOT_FOUND', async () => {
    await expectCode(subscribe(ctx(outsider.id), slow, liam), 'TICKER_NOT_FOUND');
  });

  it('the database refuses a subscription for a worker of another App', async () => {
    await expect(
      db.tickerSubscription.create({ data: { tickerId: slow.id, workerId: zed.id } }),
    ).rejects.toThrow(/is not in the ticker's App/);
  });

  it('retiring a worker ends its subscriptions WORKER_RETIRED', async () => {
    await subscribe(ctx(admin.id), slow, rook);
    await M.retireWorker({}, { workerRef: rook.id }, ctx(admin.id));
    expect(await liveSubs(slow.id)).toHaveLength(0);
    expect((await db.tickerSubscription.findFirstOrThrow({ where: { tickerId: slow.id } })).endedReason).toBe('WORKER_RETIRED');
  });

  it('nothing ends a subscription for dormancy: a long-idle worker keeps it', async () => {
    await subscribe(ctx(admin.id), slow, liam);
    await db.session.updateMany({ where: { workerId: liam.id }, data: { updatedAt: new Date('2020-01-01') } });
    expect(await liveSubs(slow.id)).toHaveLength(1);
  });
});

describe('the may-subscribe-workers grant (N1, N2, Q13, Q14)', () => {
  let fast: { id: string };
  beforeEach(async () => {
    fast = await createTicker(ctx(member.id), { name: 'Fast', cadenceSeconds: 120 });
    await grant(ctx(admin.id), anne);
  });
  const anneCtx = () => ctx(coordHolder.id);

  it('is given and revoked only by whoever manages the App; revoking what was never given is refused', async () => {
    await expectCode(grant(ctx(member.id), liam), 'APP_GRANT_FORBIDDEN');
    await expectCode(asWorker(anne, () => grant(anneCtx(), liam)), 'APP_GRANT_FORBIDDEN');
    await expectCode(revoke(ctx(member.id), anne), 'APP_GRANT_FORBIDDEN');
    await expectCode(grant(ctx(outsider.id), liam), 'APP_NOT_FOUND');
    await expectCode(revoke(ctx(admin.id), liam), 'APP_GRANT_NOT_FOUND');
    const given = await grant(ctx(appOwner.id), liam);
    expect(F.AppGrant.name(given)).toBe('TICKER_SUBSCRIBE_WORKERS');
  });

  it('is idempotent (one live row), refuses a retired grantee and another App\'s worker', async () => {
    const again = await grant(ctx(admin.id), anne);
    expect(again.revokedAt).toBeNull();
    expect(await db.appGrant.count({ where: { granteeWorkerId: anne.id, revokedAt: null } })).toBe(1);
    await expectCode(grant(ctx(admin.id), retired), 'WORKER_RETIRED');
    await expectCode(grant(ctx(admin.id), zed), 'WORKER_NOT_FOUND');
    await expectCode(
      M.grantApp({}, { appRef: app.id, workerRef: anne.id, name: 'NOPE' }, ctx(admin.id)),
      'BAD_USER_INPUT',
    );
  });

  it('the grantee subscribes OTHER workers at any cadence, recording the worker and the person', async () => {
    const r = await asWorker(anne, () => subscribe(anneCtx(), fast, liam));
    expect(r.announcement).toBe('POSTED');
    const row = await db.tickerSubscription.findFirstOrThrow({ where: { tickerId: fast.id, workerId: liam.id } });
    expect(row).toMatchObject({ createdByWorkerId: anne.id, viaGrantPersonId: coordHolder.id });
    expect(row.viaGrantId).toBeTruthy();
    expect(await F.TickerSubscription.viaGrant(row)).toBe(true);
    await expect(asWorker(anne, () => unsubscribe(anneCtx(), fast, liam))).resolves.toMatchObject({ announcement: 'POSTED' });
    const ended = await db.tickerSubscription.findFirstOrThrow({ where: { tickerId: fast.id, workerId: liam.id } });
    expect(ended).toMatchObject({ endedReason: 'UNSUBSCRIBED', endedByWorkerId: anne.id, endedViaGrantPersonId: coordHolder.id });
  });

  it('N1: it never reaches the grantee itself', async () => {
    await expectCode(asWorker(anne, () => subscribe(anneCtx(), fast, anne)), 'SUBSCRIBE_CADENCE_NEEDS_HOLDER');
    expect(await liveSubs(fast.id)).toHaveLength(0);
  });

  it('N1: it never changes wake settings, reportsTo or someone else\'s ticker', async () => {
    await expectCode(
      asWorker(anne, () => M.setWorkerWakeSettings({}, { workerRef: liam.id, input: { mentions: 'OFF' } }, anneCtx())),
      'WAKE_SETTINGS_FORBIDDEN',
    );
    await expectCode(
      asWorker(anne, () => M.setWorkerWakeSettings({}, { workerRef: liam.id, input: { pausedUntil: new Date(Date.now() + 3_600_000) } }, anneCtx())),
      'WAKE_SETTINGS_FORBIDDEN',
    );
    await expectCode(
      asWorker(anne, () => M.setWorkerReportsTo({}, { workerRef: liam.id, reportsTo: anne.id }, anneCtx())),
      'WORKER_REPORTS_TO_FORBIDDEN',
    );
    await expectCode(asWorker(anne, () => M.updateTicker({}, { ref: fast.id, input: { enabled: false } }, anneCtx())), 'FORBIDDEN');
    await expectCode(asWorker(anne, () => M.deleteTicker({}, { ref: fast.id }, anneCtx())), 'FORBIDDEN');
  });

  it('N2: an App key bound to the grantee\'s session cannot subscribe another worker', async () => {
    await expectCode(
      asWorker(anne, () => subscribe(ctx(undefined, { appId: app.id } as Partial<Context>), fast, liam)),
      'TICKER_NOT_FOUND',
    );
    expect(await liveSubs(fast.id)).toHaveLength(0);
  });

  it('N2: a revoked grant refuses at the next call', async () => {
    await asWorker(anne, () => subscribe(anneCtx(), fast, liam));
    await revoke(ctx(admin.id), anne);
    await expectCode(asWorker(anne, () => unsubscribe(anneCtx(), fast, liam)), 'SUBSCRIBE_FORBIDDEN');
    await expectCode(asWorker(anne, () => subscribe(anneCtx(), fast, rook)), 'SUBSCRIBE_FORBIDDEN');
    // Re-granting makes a new row.
    await grant(ctx(admin.id), anne);
    expect(await db.appGrant.count({ where: { granteeWorkerId: anne.id } })).toBe(2);
    await expect(asWorker(anne, () => subscribe(anneCtx(), fast, rook))).resolves.toBeTruthy();
  });

  it('a person acting as themselves is not the grantee: the grant is the worker\'s, not the holder\'s', async () => {
    await expectCode(subscribe(anneCtx(), fast, liam), 'SUBSCRIBE_FORBIDDEN');
  });

  it('Q13: a worker nobody holds is subscribed by a manager and by the grant, by no one else', async () => {
    await expect(subscribe(ctx(admin.id), fast, rook)).resolves.toBeTruthy();
    await unsubscribe(ctx(admin.id), fast, rook);
    await expect(asWorker(anne, () => subscribe(anneCtx(), fast, rook))).resolves.toBeTruthy();
    await unsubscribe(ctx(admin.id), fast, rook);
    await expectCode(subscribe(ctx(member.id), fast, rook), 'SUBSCRIBE_FORBIDDEN');
    await expectCode(asWorker(liam, () => subscribe(ctx(liamHolder.id), fast, rook)), 'SUBSCRIBE_FORBIDDEN');
  });

  it('Q14: the post names the worker and ticker and mentions the holder; an unheld target mentions nobody', async () => {
    await asWorker(anne, () => subscribe(anneCtx(), fast, liam));
    const held = post.mock.calls.at(-1)![1] as { appRef: string; body: string };
    expect(held.appRef).toBe(app.id);
    expect(held.body).toContain('@liam');
    expect(held.body).toContain('Fast');
    expect(held.body).toContain('subscribed');
    await asWorker(anne, () => subscribe(anneCtx(), fast, rook));
    const unheld = post.mock.calls.at(-1)![1] as { body: string };
    expect(unheld.body).toContain('**Rook**');
    expect(unheld.body).not.toContain('@rook');
    // Posted only when something changed: a repeat is a no-op, not a second announcement.
    const before = post.mock.calls.length;
    await expect(asWorker(anne, () => subscribe(anneCtx(), fast, rook))).resolves.toMatchObject({ announcement: null });
    expect(post.mock.calls.length).toBe(before);
  });

  it('Q14: with the post forced to fail, the subscription stands and the result says FAILED', async () => {
    post.mockRejectedValue(new Error('chat down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const r = await asWorker(anne, () => subscribe(anneCtx(), fast, liam));
    warn.mockRestore();
    expect(r.announcement).toBe('FAILED');
    expect(await liveSubs(fast.id)).toHaveLength(1);
  });

  it('the database refuses a grant for a worker of another App, and an unknown name', async () => {
    await expect(db.appGrant.create({ data: { appId: app.id, granteeWorkerId: zed.id, name: 'ticker.subscribe-workers' } })).rejects.toThrow(/is not in the App/);
    await expect(db.appGrant.create({ data: { appId: app.id, granteeWorkerId: liam.id, name: 'other' } })).rejects.toThrow(/chk_app_grants_shape/);
  });
});

describe('wake settings', () => {
  it('defaults when none are set, and is lazily created on the first change', async () => {
    expect(await Q.workerWakeSettings({}, { workerRef: liam.id }, ctx(member.id))).toMatchObject({ mentions: 'IMMEDIATE', pausedUntil: null });
    expect(await db.workerWakeSettings.count()).toBe(0);
    const r = await M.setWorkerWakeSettings({}, { workerRef: liam.id, input: { mentions: 'OFF' } }, ctx(liamHolder.id));
    expect(r).toMatchObject({ mentions: 'OFF' });
    expect(await db.workerWakeSettings.count()).toBe(1);
  });

  it('the worker itself, its holder and every manager arm may change them, in either direction', async () => {
    const until = new Date(Date.now() + 4 * 3_600_000);
    await expect(asWorker(liam, () => M.setWorkerWakeSettings({}, { workerRef: liam.id, input: { pausedUntil: until } }, ctx(liamHolder.id)))).resolves.toMatchObject({ pausedUntil: until });
    await expect(M.setWorkerWakeSettings({}, { workerRef: liam.id, input: { clearPause: true } }, ctx(liamHolder.id))).resolves.toMatchObject({ pausedUntil: null });
    await expect(M.setWorkerWakeSettings({}, { workerRef: liam.id, input: { mentions: 'OFF' } }, ctx(appOwner.id))).resolves.toMatchObject({ mentions: 'OFF' });
    await expect(M.setWorkerWakeSettings({}, { workerRef: liam.id, input: { mentions: 'IMMEDIATE' } }, ctx(admin.id))).resolves.toMatchObject({ mentions: 'IMMEDIATE' });
  });

  it('refuses a member who is not the holder, another worker, and a non-participant', async () => {
    const set = (c: Context) => M.setWorkerWakeSettings({}, { workerRef: liam.id, input: { mentions: 'OFF' } }, c);
    await expectCode(set(ctx(member.id)), 'WAKE_SETTINGS_FORBIDDEN');
    await expectCode(asWorker(rook, () => set(ctx(member.id))), 'WAKE_SETTINGS_FORBIDDEN');
    await expectCode(set(ctx(outsider.id)), 'WORKER_NOT_FOUND');
    await expectCode(
      M.setWorkerWakeSettings({}, { workerRef: liam.id, input: { mentions: 'ON_TICK' } }, ctx(liamHolder.id)),
      'BAD_USER_INPUT',
    );
  });

  it('reports the fastest live subscription on an enabled ticker as the effective cadence', async () => {
    const a = await createTicker(ctx(member.id), { name: 'A', cadenceSeconds: 900 });
    const b = await createTicker(ctx(member.id), { name: 'B', cadenceSeconds: 300 });
    await subscribe(ctx(admin.id), a, liam);
    await subscribe(ctx(admin.id), b, liam);
    const w = { workerId: liam.id };
    expect(await F.WorkerWakeSettings.effectiveCadenceSeconds(w, {}, ctx(member.id))).toBe(300);
    await M.updateTicker({}, { ref: b.id, input: { enabled: false } }, ctx(member.id));
    expect(await F.WorkerWakeSettings.effectiveCadenceSeconds(w, {}, ctx(member.id))).toBe(900);
    expect((await F.WorkerWakeSettings.subscriptions(w, {}, ctx(member.id))).length).toBe(2);
  });
});

describe('reads and attribution', () => {
  it('lists subscribers with who subscribed each, paged', async () => {
    const t = await createTicker(ctx(member.id));
    await subscribe(ctx(admin.id), t, liam);
    await subscribe(ctx(admin.id), t, rook);
    const p1 = await F.Ticker.subscribers(t, { first: 1 }, ctx(member.id));
    expect(p1.items).toHaveLength(1);
    expect(p1.hasNextPage).toBe(true);
    const p2 = await F.Ticker.subscribers(t, { first: 1, after: p1.endCursor }, ctx(member.id));
    expect(p2.items).toHaveLength(1);
    expect(p2.hasNextPage).toBe(false);
    const by = await F.TickerSubscription.createdBy(p1.items[0], {}, ctx(member.id));
    expect(by).toBeTruthy();
  });

  it('a non-participant lists nothing and reads no ticker', async () => {
    const t = await createTicker(ctx(member.id));
    await expectCode(Q.tickers({}, { appRef: app.id }, ctx(outsider.id)), 'APP_NOT_FOUND');
    expect(await Q.ticker({}, { ref: t.id }, ctx(outsider.id))).toBeNull();
    await expectCode(Q.workerWakeSettings({}, { workerRef: liam.id }, ctx(outsider.id)), 'WORKER_NOT_FOUND');
    await expectCode(Q.appTickerSettings({}, { appRef: app.id }, ctx(outsider.id)), 'APP_NOT_FOUND');
  });

  it('stamps every mutation through the actor (#1610)', async () => {
    const t = await asWorker(liam, () => createTicker(ctx(liamHolder.id)));
    const u = await asWorker(liam, () => M.updateTicker({}, { ref: t.id, input: { enabled: false } }, ctx(liamHolder.id)));
    expect(u).toMatchObject({ updatedBy: liamHolder.id, updatedByWorkerId: liam.id, updatedByAgentId: teamAgent.id });
    await asWorker(liam, () => M.deleteTicker({}, { ref: t.id }, ctx(liamHolder.id)));
    expect(await db.ticker.findUniqueOrThrow({ where: { id: t.id } })).toMatchObject({ deletedBy: liamHolder.id, deletedByWorkerId: liam.id });
  });
});

describe('over the wire (SDL and resolvers agree)', () => {
  it('runs the whole flow through GraphQL: create, subscribe, read, settings, grant, delete', async () => {
    const { ApolloServer } = await import('@apollo/server');
    const { typeDefs } = await import('./typeDefs.js');
    const server = new ApolloServer<Context>({ typeDefs, resolvers });
    const run = async (query: string, variables: Record<string, unknown>, userId: string) => {
      const res = await server.executeOperation({ query, variables }, { contextValue: ctx(userId) });
      if (res.body.kind !== 'single') throw new Error('unexpected incremental result');
      return res.body.singleResult;
    };
    const created = await run(
      `mutation($a: String!, $i: TickerInput!) { createTicker(appRef: $a, input: $i) {
         id urn name slug cadenceSeconds relevance enabled quietHours owner { id name } app { id }
         channels { id } subscribers { items { id } hasNextPage endCursor } } }`,
      { a: app.id, i: { name: 'Wire', cadenceSeconds: 600, relevance: 'MENTIONS', quietHours: { timezone: 'UTC', windows: [{ days: [1], from: '01:00', to: '02:00' }] } } },
      member.id,
    );
    expect(created.errors).toBeUndefined();
    const t = (created.data as any).createTicker;
    expect(t).toMatchObject({ urn: `hrn:ticker:${org.urn}:team:wire`, slug: 'wire', relevance: 'MENTIONS', channels: [] });
    expect(t.owner.id).toBe(member.id);

    const sub = await run(
      `mutation($t: String!, $w: String!) { subscribeWorker(tickerRef: $t, workerRef: $w) {
         announcement subscription { id viaGrant endedReason worker { id } ticker { id } createdBy { id } } } }`,
      { t: t.urn, w: liam.id }, admin.id,
    );
    expect(sub.errors).toBeUndefined();
    expect((sub.data as any).subscribeWorker.subscription).toMatchObject({ viaGrant: false, endedReason: null, worker: { id: liam.id }, ticker: { id: t.id } });

    const read = await run(
      `query($a: String!, $w: String!) { tickers(appRef: $a) { id subscribers { items { worker { id } } } }
         appTickerSettings(appRef: $a) { minCadenceSeconds liveCap dailyWakeBudget dailyWakeBudgetDerived }
         workerWakeSettings(workerRef: $w) { mentions pausedUntil effectiveCadenceSeconds subscriptions { id } } }`,
      { a: app.id, w: liam.id }, member.id,
    );
    expect(read.errors).toBeUndefined();
    expect((read.data as any).workerWakeSettings).toMatchObject({ mentions: 'IMMEDIATE', effectiveCadenceSeconds: 600 });
    expect((read.data as any).appTickerSettings).toMatchObject({ minCadenceSeconds: 120, dailyWakeBudgetDerived: true });

    const set = await run(
      `mutation($w: String!, $a: String!) {
         setWorkerWakeSettings(workerRef: $w, input: { mentions: OFF }) { mentions }
         setAppTickerSettings(appRef: $a, input: { liveCap: 7 }) { liveCap }
         grantApp(appRef: $a, workerRef: $w, name: TICKER_SUBSCRIBE_WORKERS) { name revokedAt }
       }`,
      { w: liam.id, a: app.id }, admin.id,
    );
    expect(set.errors).toBeUndefined();
    expect(set.data).toMatchObject({ grantApp: { name: 'TICKER_SUBSCRIBE_WORKERS' }, setAppTickerSettings: { liveCap: 7 } });

    const refused = await run(`mutation($t: String!) { deleteTicker(ref: $t) }`, { t: t.id }, coordHolder.id);
    expect(refused.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
    const deleted = await run(`mutation($t: String!) { deleteTicker(ref: $t) }`, { t: t.id }, member.id);
    expect(deleted.errors).toBeUndefined();
    expect((deleted.data as any).deleteTicker).toBe(true);
  });
});

// ── Cycle 1: the reviews of 0ba6ede5 (Rook §10, Diego, the local seat) ────────

describe('cycle 1 — a cadence or relevance edit re-runs the subscribe rule (R3)', () => {
  it('a worker cannot speed up a ticker it subscribed itself to', async () => {
    const own = ctx(liamHolder.id);
    const t = await asWorker(liam, () => createTicker(own, { name: 'Mine', cadenceSeconds: 600 }));
    await asWorker(liam, () => subscribe(own, t, liam));
    await expectCode(asWorker(liam, () => M.updateTicker({}, { ref: t.id, input: { cadenceSeconds: 120 } }, own)), 'TICKER_CADENCE_NEEDS_CONSENT');
    expect((await db.ticker.findUniqueOrThrow({ where: { id: t.id } })).cadenceSeconds).toBe(600);
  });

  it('an owner cannot speed up a ticker past another worker\'s holder, and the refusal names the worker', async () => {
    const t = await createTicker(ctx(member.id), { name: 'Shared', cadenceSeconds: 600 });
    await subscribe(ctx(liamHolder.id), t, liam);
    try {
      await M.updateTicker({}, { ref: t.id, input: { cadenceSeconds: 120 } }, ctx(member.id));
      expect.fail('expected a refusal');
    } catch (e) {
      expect((e as GraphQLError).extensions?.code).toBe('TICKER_CADENCE_NEEDS_CONSENT');
      expect((e as GraphQLError).message).toContain('Liam');
    }
    // A manager passes, as on subscribe; a slow-down is always fine.
    await expect(M.updateTicker({}, { ref: t.id, input: { cadenceSeconds: 120 } }, ctx(appOwner.id))).resolves.toMatchObject({ cadenceSeconds: 120 });
    await expect(M.updateTicker({}, { ref: t.id, input: { cadenceSeconds: 900 } }, ctx(member.id))).resolves.toMatchObject({ cadenceSeconds: 900 });
  });

  it('an owner who holds every subscriber may speed it up', async () => {
    const t = await createTicker(ctx(coordHolder.id), { name: 'Mine', cadenceSeconds: 600 });
    await subscribe(ctx(coordHolder.id), t, anne);
    await expect(M.updateTicker({}, { ref: t.id, input: { cadenceSeconds: 120 } }, ctx(coordHolder.id))).resolves.toMatchObject({ cadenceSeconds: 120 });
  });

  it('raising relevance to ALL also needs the subscribers\' consent (it raises spend)', async () => {
    const t = await createTicker(ctx(member.id), { name: 'Quiet', cadenceSeconds: 600, relevance: 'MENTIONS' });
    await subscribe(ctx(liamHolder.id), t, liam);
    await expectCode(M.updateTicker({}, { ref: t.id, input: { relevance: 'ALL' } }, ctx(member.id)), 'TICKER_CADENCE_NEEDS_CONSENT');
    await expect(M.updateTicker({}, { ref: t.id, input: { relevance: 'ALL' } }, ctx(appOwner.id))).resolves.toMatchObject({ relevance: 'ALL' });
  });

  it('the subscribe-workers grant does not pay for a speed-up (it is announced nowhere)', async () => {
    await grant(ctx(admin.id), anne);
    const t = await asWorker(anne, () => createTicker(ctx(coordHolder.id), { name: 'Annes', cadenceSeconds: 600 }));
    await subscribe(ctx(liamHolder.id), t, liam);
    await expectCode(asWorker(anne, () => M.updateTicker({}, { ref: t.id, input: { cadenceSeconds: 120 } }, ctx(coordHolder.id))), 'TICKER_CADENCE_NEEDS_CONSENT');
  });
});

describe('cycle 1 — concurrency (the local seat, Diego)', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('settings writers, and settings against create, never deadlock', async () => {
    for (let i = 0; i < 3; i++) {
      const r = await Promise.allSettled([
        setSettings(ctx(admin.id), { liveCap: 20 + i }),
        setSettings(ctx(appOwner.id), { liveCap: 30 + i }),
        createTicker(ctx(member.id), { name: `Race ${i}` }),
      ]);
      expect(r.map((x) => (x.status === 'rejected' ? String((x as PromiseRejectedResult).reason) : 'ok'))).toEqual(['ok', 'ok', 'ok']);
    }
  });

  it('a cadence edit cannot slip under a floor raised at the same time', async () => {
    const t = await createTicker(ctx(member.id), { name: 'Edge', cadenceSeconds: 200 });
    const [edit, floor] = await Promise.allSettled([
      M.updateTicker({}, { ref: t.id, input: { cadenceSeconds: 130 } }, ctx(member.id)),
      setSettings(ctx(admin.id), { minCadenceSeconds: 180 }),
    ]);
    const now = await db.ticker.findUniqueOrThrow({ where: { id: t.id } });
    const settings = await db.app.findUniqueOrThrow({ where: { id: app.id }, select: { tickerMinCadenceSeconds: true } });
    expect(now.cadenceSeconds).toBeGreaterThanOrEqual(settings.tickerMinCadenceSeconds);
    expect([edit.status, floor.status]).toContain('fulfilled');
  });

  it('two renames to one name, and a rename against a create, end in TICKER_NAME_TAKEN, never a raw database error', async () => {
    const a = await createTicker(ctx(member.id), { name: 'Alpha' });
    const b = await createTicker(ctx(member.id), { name: 'Beta' });
    const renames = await Promise.allSettled([
      M.updateTicker({}, { ref: a.id, input: { name: 'Gamma' } }, ctx(member.id)),
      M.updateTicker({}, { ref: b.id, input: { name: 'Gamma' } }, ctx(member.id)),
    ]);
    expect(renames.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = renames.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((lost.reason as GraphQLError).extensions?.code).toBe('TICKER_NAME_TAKEN');

    const mixed = await Promise.allSettled([
      M.updateTicker({}, { ref: a.id, input: { name: 'Delta' } }, ctx(member.id)),
      createTicker(ctx(member.id), { name: 'Delta' }),
    ]);
    expect(mixed.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost2 = mixed.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((lost2.reason as GraphQLError).extensions?.code).toBe('TICKER_NAME_TAKEN');
  });

  it('concurrent first grants are idempotent: every caller gets the one live grant', async () => {
    const calls = await Promise.allSettled([1, 2, 3, 4].map((i) => grant(ctx(i % 2 ? admin.id : appOwner.id), liam)));
    expect(calls.map((c) => c.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled', 'fulfilled']);
    const ids = new Set(calls.map((c) => (c as PromiseFulfilledResult<{ id: string }>).value.id));
    expect(ids.size).toBe(1);
    expect(await db.appGrant.count({ where: { granteeWorkerId: liam.id, revokedAt: null } })).toBe(1);
  });

  it('holder authority over a worker-owned ticker is held through the write: a release in flight is waited for', async () => {
    const lw = await asWorker(liam, () => createTicker(ctx(liamHolder.id), { name: 'Liams' }));
    let releaseGate!: () => void;
    const gate = new Promise<void>((r) => { releaseGate = r; });
    let lockedUp!: () => void;
    const locked = new Promise<void>((r) => { lockedUp = r; });
    // A release that has updated the worker row but not yet committed.
    const releasing = db.$transaction(async (tx) => {
      await tx.worker.update({ where: { id: liam.id }, data: { heldByUserId: null, heldAt: null } });
      lockedUp();
      await gate;
    });
    await locked;
    let settled = false;
    const edit = M.updateTicker({}, { ref: lw.id, input: { enabled: false } }, ctx(liamHolder.id)).then(
      (v: unknown) => { settled = true; return { ok: v }; },
      (e: unknown) => { settled = true; return { err: e }; },
    );
    let waited: boolean;
    try {
      await sleep(500);
      waited = !settled; // the edit waits for the release instead of using a revoked authority
    } finally {
      releaseGate(); // always, so a failure cannot strand the barrier
    }
    await releasing;
    expect(waited).toBe(true);
    const out = await edit;
    expect('err' in out && (out.err as GraphQLError).extensions?.code).toBe('FORBIDDEN');
  });
});

describe('cycle 1 — an unheld worker cannot subscribe itself (Diego P2-3)', () => {
  it('a worker that was released keeps its session but not the self arm', async () => {
    const slow = await createTicker(ctx(member.id), { name: 'Slow', cadenceSeconds: 600 });
    await M.releaseWorker({}, { workerRef: liam.id }, ctx(liamHolder.id));
    expect((await db.worker.findUniqueOrThrow({ where: { id: liam.id } })).heldByUserId).toBeNull();
    await expectCode(asWorker(liam, () => subscribe(ctx(liamHolder.id), slow, liam)), 'SUBSCRIBE_FORBIDDEN');
    expect(await liveSubs(slow.id)).toHaveLength(0);
    // A manager still can, and the worker may still leave.
    await subscribe(ctx(admin.id), slow, liam);
    await expect(asWorker(liam, () => unsubscribe(ctx(liamHolder.id), slow, liam))).resolves.toBeTruthy();
  });
});

describe('cycle 1 — a grant is spent on a holder\'s behalf (Rook, #1751 P3-2)', () => {
  it('a released grantee\'s session cannot use the grant', async () => {
    await grant(ctx(admin.id), anne);
    const t = await createTicker(ctx(member.id), { name: 'Fast', cadenceSeconds: 120 });
    await M.releaseWorker({}, { workerRef: anne.id }, ctx(coordHolder.id));
    await expectCode(asWorker(anne, () => subscribe(ctx(coordHolder.id), t, liam)), 'SUBSCRIBE_FORBIDDEN');
    // Held by someone else, the person behind the session must be that holder.
    await db.worker.update({ where: { id: anne.id }, data: { heldByUserId: member.id, heldAt: new Date() } });
    await expectCode(asWorker(anne, () => subscribe(ctx(coordHolder.id), t, liam)), 'SUBSCRIBE_FORBIDDEN');
    await expect(asWorker(anne, () => subscribe(ctx(member.id), t, liam))).resolves.toBeTruthy();
  });
});

describe('cycle 1 — the grant announcement mentions only the holder (Rook P2-3, Diego P2-6)', () => {
  it('a ticker or worker name carrying mention tokens injects nothing', async () => {
    await grant(ctx(admin.id), anne);
    const t = await createTicker(ctx(member.id), { name: 'standup @all @dan \\@rook', cadenceSeconds: 120 });
    await asWorker(anne, () => subscribe(ctx(coordHolder.id), t, liam));
    const held = post.mock.calls.at(-1)![1] as { body: string };
    expect(extractMentions(held.body)).toEqual(['liam']);
    await asWorker(anne, () => subscribe(ctx(coordHolder.id), t, rook));
    const unheld = post.mock.calls.at(-1)![1] as { body: string };
    expect(extractMentions(unheld.body)).toEqual([]);
  });
});

describe('cycle 1 — time zones are validated by the consumer (local P2-4)', () => {
  it('accepts valid IANA aliases and refuses offsets and invented zones', async () => {
    const windows = [{ days: [1], from: '22:00', to: '23:00' }];
    await expect(createTicker(ctx(member.id), { name: 'Alias', quietHours: { timezone: 'US/Pacific', windows } })).resolves.toBeTruthy();
    await expect(createTicker(ctx(member.id), { name: 'Utc', quietHours: { timezone: 'Etc/UTC', windows } })).resolves.toBeTruthy();
    for (const timezone of ['Mars/Base', '+01:00', '', 'UTC+1']) {
      await expectCode(createTicker(ctx(member.id), { name: `Z ${timezone}`, quietHours: { timezone, windows } }), 'TICKER_QUIET_HOURS_INVALID');
    }
  });
});


describe('#2068 (R49/R54) — a ticker has reasons: a closed, never-empty list', () => {
  it('defaults to [read-team-channel]; every-tick is stored and shown; the list is closed and de-duplicated in set order', async () => {
    const plain = await createTicker(ctx(member.id), { name: 'Plain' });
    expect(plain.reasons).toEqual(['read-team-channel']);
    expect(await F.Ticker.reasons(plain)).toEqual(['READ_TEAM_CHANNEL']);
    const every = await createTicker(ctx(member.id), { name: 'Every', reasons: ['EVERY_TICK', 'every-tick', 'READ_TEAM_CHANNEL'] });
    expect(every.reasons).toEqual(['read-team-channel', 'every-tick']);
    expect(await F.Ticker.reasons(every)).toEqual(['READ_TEAM_CHANNEL', 'EVERY_TICK']);
  });

  it('an empty or unknown reasons list is refused on create and update, writing nothing', async () => {
    await expectCode(createTicker(ctx(member.id), { name: 'None', reasons: [] }), 'BAD_USER_INPUT');
    await expectCode(createTicker(ctx(member.id), { name: 'Odd', reasons: ['sometimes'] }), 'BAD_USER_INPUT');
    expect(await db.ticker.count()).toBe(0);
    const t = await createTicker(ctx(member.id), { name: 'Mine' });
    await expectCode(M.updateTicker({}, { ref: t.id, input: { reasons: [] } }, ctx(member.id)), 'BAD_USER_INPUT');
    await expectCode(M.updateTicker({}, { ref: t.id, input: { reasons: ['whenever'] } }, ctx(member.id)), 'BAD_USER_INPUT');
    expect((await db.ticker.findUniqueOrThrow({ where: { id: t.id } })).reasons).toEqual(['read-team-channel']);
  });

  it('an update that omits reasons keeps them; every-tick can be added and removed again', async () => {
    const t = await createTicker(ctx(member.id), { name: 'Cycle' });
    const rename = await M.updateTicker({}, { ref: t.id, input: { name: 'Cycle2' } }, ctx(member.id));
    expect(rename.reasons).toEqual(['read-team-channel']);
    const on = await M.updateTicker({}, { ref: t.id, input: { reasons: ['EVERY_TICK'] } }, ctx(member.id));
    expect(on.reasons).toEqual(['every-tick']);
    expect((await M.updateTicker({}, { ref: t.id, input: { cadenceSeconds: 900 } }, ctx(member.id))).reasons).toEqual(['every-tick']);
    const off = await M.updateTicker({}, { ref: t.id, input: { reasons: ['READ_TEAM_CHANNEL'] } }, ctx(member.id));
    expect(off.reasons).toEqual(['read-team-channel']);
  });

  it('adding every-tick is a widening: a subscriber its editor could not subscribe at the new terms refuses the change, atomically', async () => {
    const fast = await createTicker(ctx(member.id), { name: 'Fast', cadenceSeconds: 120 });
    await subscribe(ctx(liamHolder.id), fast, liam); // the holder, as a person, may put Liam on the fast ticker
    await expectCode(M.updateTicker({}, { ref: fast.id, input: { reasons: ['EVERY_TICK'], name: 'Fast2' } }, ctx(member.id)), 'TICKER_CADENCE_NEEDS_CONSENT');
    const row = await db.ticker.findUniqueOrThrow({ where: { id: fast.id } });
    expect(row.reasons).toEqual(['read-team-channel']);
    expect(row.name).toBe('Fast');
    // A manager could subscribe Liam at the new terms, so the change passes for them.
    await expect(M.updateTicker({}, { ref: fast.id, input: { reasons: ['EVERY_TICK'] } }, ctx(appOwner.id))).resolves.toMatchObject({ reasons: ['every-tick'] });
    // Narrowing back to read-team-channel is never a widening.
    await expect(M.updateTicker({}, { ref: fast.id, input: { reasons: ['READ_TEAM_CHANNEL'] } }, ctx(member.id))).resolves.toMatchObject({ reasons: ['read-team-channel'] });
  });

  it('who may set reasons is who may edit the ticker: a non-owner is refused, an outsider and another App concealed, nothing changes', async () => {
    const t = await createTicker(ctx(member.id), { name: 'Guarded' });
    await expectCode(M.updateTicker({}, { ref: t.id, input: { reasons: ['EVERY_TICK'] } }, ctx(coordHolder.id)), 'FORBIDDEN');
    await expectCode(M.updateTicker({}, { ref: t.id, input: { reasons: ['EVERY_TICK'] } }, ctx(outsider.id)), 'TICKER_NOT_FOUND');
    await expectCode(createTicker(ctx(outsider.id), { name: 'X', reasons: ['EVERY_TICK'] }), 'APP_NOT_FOUND');
    expect((await db.ticker.findUniqueOrThrow({ where: { id: t.id } })).reasons).toEqual(['read-team-channel']);
    // The list and the single read show the same reasons to a participant.
    const listed = (await Q.tickers({}, { appRef: app.id }, ctx(member.id))).find((x: any) => x.id === t.id);
    expect(await F.Ticker.reasons(listed)).toEqual(['READ_TEAM_CHANNEL']);
  });
});

// #2756 — a name is typed into a worker's terminal by the wake nudge, so it must not carry
// control characters or line breaks. Pins run through every write door the name reaches.
describe('tickers — name refuses control characters (#2756)', () => {
  const BAD: Array<[string, string]> = [
    ['LF', 'a\nb'], ['CR', 'a\rb'], ['TAB', 'a\tb'], ['ESC', 'a\u001b[2Jb'], ['NUL', 'a\u0000b'],
    ['DEL', 'a\u007fb'], ['C1 NEL', 'a\u0085b'], ['C1 CSI', 'a\u009bb'], ['U+2028', 'a\u2028b'], ['U+2029', 'a\u2029b'],
  ];

  for (const [label, name] of BAD) {
    it(`createTicker refuses ${label} with BAD_USER_INPUT and stores nothing`, async () => {
      await expectCode(createTicker(ctx(member.id), { name }), 'BAD_USER_INPUT');
      expect(await db.ticker.count({ where: { appId: app.id } })).toBe(0);
    });

    it(`updateTicker refuses ${label} and leaves name and slug unchanged`, async () => {
      const t = await createTicker(ctx(member.id));
      await expectCode(M.updateTicker({}, { ref: t.id, input: { name, cadenceSeconds: 900 } }, ctx(member.id)), 'BAD_USER_INPUT');
      const row = await db.ticker.findUniqueOrThrow({ where: { id: t.id } });
      expect(row).toMatchObject({ name: 'Engineering', slug: 'engineering', cadenceSeconds: 600 });
    });
  }

  it('still accepts ordinary Unicode (accents, CJK, emoji, inner spaces)', async () => {
    for (const name of ['Équipe café', '工程团队', 'Ops 🚀 team']) {
      await expect(createTicker(ctx(member.id), { name })).resolves.toMatchObject({ name });
    }
  });
});
