import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
/** #2025 / cor:agt:080:05,:19 — settings and the real S1/S5 typed timing seams. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { setS7AvailableForTest } from '../../../lib/tickers/s7Availability.js';
import { generateId } from '../../../lib/id.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { lockAuthorityAnchors } from '../../../lib/auth/authorityAnchors.js';
import { waitForLockWaitersOfType } from '../../../test/lockWait.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const Q = resolvers.Query as any, M = resolvers.Mutation as any;
let orgId: string, appId: string, foreignAppId: string, agentId: string, workerId: string;
let manager: { id: string }, owner: { id: string }, member: { id: string }, outsider: { id: string };
const ctx = (userId?: string, extra: Partial<Context> = {}): Context => ({ db, userId, roles: ['READER'], ...extra });
const get = (c = ctx(manager.id), appRef = appId) => Promise.resolve().then(() => Q.appDeliverySettings({}, { appRef }, c));
const set = (input: Record<string, unknown>, c = ctx(manager.id), appRef = appId) =>
  Promise.resolve().then(() => M.setAppDeliverySettings({}, { appRef, input }, c));
const oldSet = (input: Record<string, unknown>) => M.setAppTickerSettings({}, { appRef: appId, input }, ctx(manager.id));
const defaults = { batchWindowSeconds: 120, busyDelaySeconds: 600, stuckWindowSeconds: 900, standbyEnabled: false, standbyEffective: false, checkPeriodSeconds: 600, failedChecksToOverdue: 2, darkAlarmWindowSeconds: 1800 };
async function code(p: Promise<unknown>, expected: string) {
  await expect(p).rejects.toMatchObject({ extensions: { code: expected } });
}

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { name: 'Delivery settings', urn: `delivery-${generateId()}.example` } });
  orgId = org.id;
  const user = () => db.user.create({ data: { handle: `settings-${generateId()}`, roles: ['READER'] } });
  [manager, owner, member, outsider] = await Promise.all([user(), user(), user(), user()]);
  await db.orgMember.create({ data: { organizationId: orgId, userId: manager.id, role: 'ADMIN' } });
  appId = (await db.app.create({ data: { name: 'Team', urn: `${org.urn}:team`, organizationId: orgId } })).id;
  foreignAppId = (await db.app.create({ data: { name: 'Foreign', urn: `foreign-${generateId()}:team`, ownerUserId: outsider.id } })).id;
  await db.appMember.create({ data: { appId, userId: owner.id, role: 'owner' } });
  await db.appMember.create({ data: { appId, userId: member.id, role: 'member' } });
  agentId = (await db.agent.create({ data: { name: 'Agent', urn: `${org.urn}:agent`, organizationId: orgId } })).id;
  workerId = (await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId, agentId, name: 'Builder', slug: 'builder', heldByUserId: manager.id, heldAt: new Date() } })).id;
});

describe('delivery settings #2025', () => {
  it('persists new App defaults and exposes them to a participant', async () => {
    const row = await db.app.findUniqueOrThrow({ where: { id: appId } }) as any;
    expect(row).toMatchObject({ deliveryBusyDelaySeconds: 600, deliveryStuckWindowSeconds: 900, deliveryStandbyEnabled: false });
    expect(await get(ctx(member.id))).toEqual(defaults);
  });
  it('supports each human manager arm, including a personal App owner', async () => {
    expect(await set({ busyDelaySeconds: 500 })).toMatchObject({ busyDelaySeconds: 500 });
    expect(await set({ busyDelaySeconds: 450 }, ctx(owner.id))).toMatchObject({ busyDelaySeconds: 450 });
    expect(await set({ busyDelaySeconds: 400 }, ctx(outsider.id), foreignAppId)).toMatchObject({ busyDelaySeconds: 400 });
  });
  it('patches independently, preserves omission, permits empty patch and explicit reset', async () => {
    expect(await set({ batchWindowSeconds: 180, busyDelaySeconds: 300, stuckWindowSeconds: 700 })).toEqual({ ...defaults, batchWindowSeconds: 180, busyDelaySeconds: 300, stuckWindowSeconds: 700 });
    expect(await set({ busyDelaySeconds: 250 })).toMatchObject({ batchWindowSeconds: 180, busyDelaySeconds: 250, stuckWindowSeconds: 700 });
    expect(await set({})).toMatchObject({ batchWindowSeconds: 180, busyDelaySeconds: 250 });
    expect(await set({ batchWindowSeconds: 120 })).toMatchObject({ batchWindowSeconds: 120, busyDelaySeconds: 250 });
    expect((await Q.appTickerSettings({}, { appRef: appId }, ctx(manager.id))).minCadenceSeconds).toBe(120);
  });
  it('concurrent disjoint patches retain both fields', async () => {
    await Promise.all([set({ busyDelaySeconds: 500 }), set({ stuckWindowSeconds: 1000 })]);
    expect(await get()).toMatchObject({ busyDelaySeconds: 500, stuckWindowSeconds: 1000 });
  });
  it.each(['batchWindowSeconds', 'busyDelaySeconds', 'stuckWindowSeconds', 'standbyEnabled'])('explicit null %s is refused without a partial write', async (field) => {
    const before = await db.app.findUniqueOrThrow({ where: { id: appId } });
    await code(set({ busyDelaySeconds: 500, [field]: null }), 'BAD_USER_INPUT');
    expect(await db.app.findUniqueOrThrow({ where: { id: appId } })).toEqual(before);
  });
  it('rejects unknown keys and malformed scalar patches at the shared service', async () => {
    await code(set({ draft: 'must not be echoed or stored' }), 'BAD_USER_INPUT');
    for (const input of [{ busyDelaySeconds: '10' }, { busyDelaySeconds: 1.5 }, { busyDelaySeconds: 0 }, { busyDelaySeconds: -1 }, { busyDelaySeconds: 86401 }, { stuckWindowSeconds: 604801 }, { stuckWindowSeconds: 0 }]) {
      await code(set(input), 'DELIVERY_SETTINGS_OUT_OF_RANGE');
    }
    expect(await get()).toEqual(defaults);
  });
  it('honors scalar and strict relation boundaries and the existing floor/self/ticker limits', async () => {
    expect(await set({ batchWindowSeconds: 60, busyDelaySeconds: 1, stuckWindowSeconds: 62 })).toMatchObject({ stuckWindowSeconds: 62 });
    await code(set({ stuckWindowSeconds: 61 }), 'DELIVERY_SETTINGS_CONFLICT');
    await code(set({ batchWindowSeconds: 59 }), 'TICKER_SETTINGS_OUT_OF_RANGE');
    await code(set({ batchWindowSeconds: 601, stuckWindowSeconds: 1000 }), 'TICKER_SETTINGS_OUT_OF_RANGE');
    expect(await set({ busyDelaySeconds: 86400, stuckWindowSeconds: 604800 })).toMatchObject({ busyDelaySeconds: 86400, stuckWindowSeconds: 604800 });
    await oldSet({ selfSubscribeCadenceSeconds: 86400 });
    expect(await set({ batchWindowSeconds: 86400 })).toMatchObject({ batchWindowSeconds: 86400 });
  });
  it('the old ticker writer cannot bypass the new timing relation', async () => {
    await code(oldSet({ minCadenceSeconds: 300 }), 'DELIVERY_SETTINGS_CONFLICT'); // 900 is not > 600 + 300
    expect((await Q.appTickerSettings({}, { appRef: appId }, ctx(manager.id))).minCadenceSeconds).toBe(120);
  });
  it('retains live-ticker conflicts on the new writer', async () => {
    await M.createTicker({}, { appRef: appId, input: { name: 'Fast', cadenceSeconds: 120 } }, ctx(member.id));
    await code(set({ batchWindowSeconds: 180 }), 'TICKER_SETTINGS_CONFLICT');
  });
  it('S7a is inert: enabling standby is refused with the typed error and nothing is written', async () => {
    await code(set({ standbyEnabled: true }), 'DELIVERY_STANDBY_UNAVAILABLE');
    expect(await set({ standbyEnabled: false })).toEqual(defaults);
  });
  it('S7: the standby switch is accepted and effective once on (S7b); off restores the defaults', async () => {
    setS7AvailableForTest(true);
    try {
    expect(await set({ standbyEnabled: true })).toEqual({ ...defaults, standbyEnabled: true, standbyEffective: true });
    expect(await set({ standbyEnabled: false })).toEqual(defaults);
    } finally { setS7AvailableForTest(false); }
  });
  it('refuses ordinary members, keys, impersonation, invalid bindings and foreign Apps', async () => {
    await code(set({ busyDelaySeconds: 500 }, ctx(member.id)), 'FORBIDDEN');
    await code(set({ busyDelaySeconds: 500 }, ctx(outsider.id)), 'APP_NOT_FOUND');
    await code(set({ busyDelaySeconds: 500 }, ctx(manager.id), foreignAppId), 'APP_NOT_FOUND');
    await code(set({ busyDelaySeconds: 500 }, ctx(manager.id, { impersonation: { orgId, sessionId: generateId(), actorUserId: outsider.id, expiresAt: new Date(Date.now() + 60000) } })), 'FORBIDDEN');
    await code(set({ busyDelaySeconds: 500 }, ctx(manager.id, { sessionBindingRefused: true })), 'SESSION_NOT_BOUND');
    await code(runAsActor({ workerId, agentId }, () => set({ busyDelaySeconds: 500 })), 'FORBIDDEN');
    const key = await db.appKey.create({ data: { appId, label: 'Host', keyHash: generateId(), keyPreview: 'test' } });
    for (const scoped of [false, true]) {
      if (scoped) await db.appKeyScope.create({ data: { id: generateId(), appKeyId: key.id, scope: 'attention:deliver', grantedByUserId: manager.id } });
      const keyCtx = ctx(undefined, { appId, appKeyId: key.id });
      await code(set({ busyDelaySeconds: 500 }, keyCtx), 'APP_NOT_FOUND');
      await code(get(keyCtx), 'APP_NOT_FOUND');
    }
    expect(await get()).toEqual(defaults);
  });
  it('rechecks an App owner demoted while the writer waits on the authority anchor', async () => {
    expect(typeof M.setAppDeliverySettings).toBe('function');
    let release!: () => void, locked!: () => void;
    const hold = new Promise<void>((r) => { release = r; }), ready = new Promise<void>((r) => { locked = r; });
    const blocker = db.$transaction(async (tx) => {
      await lockAuthorityAnchors(tx, [{ kind: 'app', id: appId }, { kind: 'org', id: orgId }], 'exclusive');
      locked(); await hold;
      await tx.appMember.update({ where: { appId_userId: { appId, userId: owner.id } }, data: { role: 'member' } });
    }, { timeout: 20000 });
    await ready;
    const writing = set({ busyDelaySeconds: 500 }, ctx(owner.id));
    try { await waitForLockWaitersOfType(db, 'advisory'); } finally { release(); }
    await blocker; await code(writing, 'FORBIDDEN');
    expect(await get()).toEqual(defaults);
  });
  it('refuses revoked Org membership and read-only uninstalled Apps', async () => {
    await db.orgMember.update({ where: { organizationId_userId: { organizationId: orgId, userId: manager.id } }, data: { deletedAt: new Date() } });
    await code(set({ busyDelaySeconds: 500 }), 'APP_NOT_FOUND');
    await db.app.update({ where: { id: appId }, data: { uninstalledAt: new Date() } });
    await code(set({ busyDelaySeconds: 500 }, ctx(owner.id)), 'APP_UNINSTALLED');
  });
  it('S1/S5 consume persisted nondefault settings through the shared timing module, not CRUD-only values', async () => {
    await set({ batchWindowSeconds: 180, busyDelaySeconds: 300, stuckWindowSeconds: 700 });
    const path = new URL('../../../lib/tickers/batchTiming.js', import.meta.url).href;
    const { loadDeliverySettings, batchTiming, deliveryStuckAt } = await import(/* @vite-ignore */ path);
    const settings = await loadDeliverySettings(db, appId);
    const posted = new Date('2026-10-18T10:00:00Z'), busyUntil = new Date('2026-10-18T10:04:00Z');
    expect(batchTiming(settings, { oldestPostedAt: posted })).toEqual({ deliverAfter: new Date('2026-10-18T10:03:00Z'), busyDeadline: new Date('2026-10-18T10:05:00Z') });
    expect(batchTiming(settings, { oldestPostedAt: posted, busyUntil })).toEqual({ deliverAfter: busyUntil, busyDeadline: new Date('2026-10-18T10:05:00Z') });
    expect(deliveryStuckAt(settings, posted)).toEqual(new Date('2026-10-18T10:11:40Z'));
    expect(batchTiming(settings, { oldestPostedAt: posted }).busyDeadline).toEqual(new Date('2026-10-18T10:05:00Z'));
    const longBusy = new Date('2026-10-18T10:20:00Z');
    expect(batchTiming(settings, { oldestPostedAt: posted, busyUntil: longBusy })).toEqual({ deliverAfter: new Date('2026-10-18T10:05:00Z'), busyDeadline: new Date('2026-10-18T10:05:00Z') });
    await set({ busyDelaySeconds: 60 });
    const shortBusy = await loadDeliverySettings(db, appId);
    expect(batchTiming(shortBusy, { oldestPostedAt: posted, busyUntil: longBusy })).toEqual({ deliverAfter: new Date('2026-10-18T10:03:00Z'), busyDeadline: new Date('2026-10-18T10:01:00Z') });
    // Idle batching also remains a floor when its window ends after the busy deadline.
    expect(batchTiming(shortBusy, { oldestPostedAt: posted, lastDueMessageAt: posted }).deliverAfter).toEqual(new Date('2026-10-18T10:03:00Z'));
    await set({ busyDelaySeconds: 250, stuckWindowSeconds: 800 });
    const next = await loadDeliverySettings(db, appId);
    expect(batchTiming(next, { oldestPostedAt: posted, busyUntil }).busyDeadline).toEqual(new Date('2026-10-18T10:04:10Z'));
    expect(deliveryStuckAt(next, posted)).toEqual(new Date('2026-10-18T10:13:20Z'));
  });
  it('S1 first-due window never slides under steady arrivals and overflow retains its own post time', async () => {
    const { loadDeliverySettings, batchTiming, deliveryStuckAt } = await import('../../../lib/tickers/batchTiming.js');
    const settings = await loadDeliverySettings(db, appId);
    const first = new Date('2026-10-18T10:00:00Z');
    const busyUntil = new Date('2026-10-18T11:00:00Z');
    for (let seconds = 0; seconds <= 900; seconds += 60) {
      // Arrival metadata is deliberately varied; only the first still-due post may anchor timing.
      const arrival = { oldestPostedAt: first, lastDueMessageAt: new Date(first.getTime() + seconds * 1000) };
      const idle = batchTiming(settings, arrival);
      const busy = batchTiming(settings, { ...arrival, busyUntil });
      expect(idle.deliverAfter).toEqual(new Date('2026-10-18T10:02:00Z'));
      expect(busy.deliverAfter).toEqual(new Date('2026-10-18T10:10:00Z'));
      expect(busy.busyDeadline).toEqual(new Date('2026-10-18T10:10:00Z'));
      expect(busy.deliverAfter.getTime()).toBeLessThan(deliveryStuckAt(settings, first).getTime());
    }
    // Overflow after a delivery keeps the oldest remaining message's original post, not delivery time.
    const overflow = { oldestPostedAt: new Date('2026-10-18T10:01:00Z'), lastDueMessageAt: new Date('2026-10-18T10:09:00Z') };
    expect(batchTiming(settings, overflow).deliverAfter).toEqual(new Date('2026-10-18T10:03:00Z'));
  });
  it('GraphQL and MCP select and return the same contract; MCP requires a named plain session', async () => {
    const { ApolloServer } = await import('@apollo/server');
    const { typeDefs } = await import('./typeDefs.js');
    const server = new ApolloServer<Context>({ typeDefs, resolvers });
    try {
      const r = await server.executeOperation({ query: 'mutation($a:String!,$i:AppDeliverySettingsInput!){setAppDeliverySettings(appRef:$a,input:$i){batchWindowSeconds busyDelaySeconds stuckWindowSeconds standbyEnabled standbyEffective checkPeriodSeconds failedChecksToOverdue darkAlarmWindowSeconds}}', variables: { a: appId, i: { busyDelaySeconds: 500 } } }, { contextValue: ctx(manager.id) });
      expect(r.body.kind).toBe('single');
      if (r.body.kind !== 'single') throw new Error('unexpected multipart result');
      expect(r.body.singleResult.errors).toBeUndefined();
      expect(r.body.singleResult.data?.setAppDeliverySettings).toEqual({ ...defaults, busyDelaySeconds: 500 });
      const { createTestableMcpServer } = await import('../../../mcp/server.js');
      const mcp = createTestableMcpServer({ userId: manager.id, roles: ['READER'], clientId: `user:${manager.id}` } as never, { sessionId: generateId(), cachedAppResolution: { kind: 'multi-app' } });
      const plain = await db.session.create({ data: { id: generateId(), userId: manager.id } });
      const text = (r: any) => r.content[0].text;
      expect(text(await mcp.callTool('hadron_delivery_settings_get', { appRef: appId }))).toContain('"busyDelaySeconds":500');
      expect(text(await mcp.callTool('hadron_delivery_settings_set', { appRef: appId, input: { busyDelaySeconds: 450 } }))).toMatch(/^\[session_required\]/);
      expect(text(await mcp.callTool('hadron_delivery_settings_set', { appRef: appId, session: plain.id, input: { busyDelaySeconds: 450 } }))).toContain('"busyDelaySeconds":450');
      expect(text(await mcp.callTool('hadron_delivery_settings_set', { appRef: appId, session: plain.id, input: { busyDelaySeconds: null } }))).toMatch(/^\[bad_user_input\]/);
    } finally { await server.stop(); }
  });
});

describe('#2138 §3.2 — channel-check settings', () => {
  it('defaults to 600 s and 2 missed periods', async () => {
    expect(await get()).toMatchObject({ checkPeriodSeconds: 600, failedChecksToOverdue: 2 });
  });

  it('a manager changes both; omitted settings and the other fields are preserved', async () => {
    const before = await get();
    const out = await set({ checkPeriodSeconds: 300, failedChecksToOverdue: 3 });
    expect(out).toMatchObject({ checkPeriodSeconds: 300, failedChecksToOverdue: 3, busyDelaySeconds: before.busyDelaySeconds, stuckWindowSeconds: before.stuckWindowSeconds });
    expect(await set({ failedChecksToOverdue: 1 })).toMatchObject({ checkPeriodSeconds: 300, failedChecksToOverdue: 1 });
    expect(await get()).toMatchObject({ checkPeriodSeconds: 300, failedChecksToOverdue: 1 });
  });

  it('refuses failedChecksToOverdue below 1 (and above 100), a period outside 60..86400, non-integers and null, changing nothing', async () => {
    for (const input of [{ failedChecksToOverdue: 0 }, { failedChecksToOverdue: -1 }, { failedChecksToOverdue: 101 }, { failedChecksToOverdue: 1.5 },
      { checkPeriodSeconds: 59 }, { checkPeriodSeconds: 86_401 }, { checkPeriodSeconds: 600.5 }]) {
      await expect(set(input)).rejects.toMatchObject({ extensions: { code: 'DELIVERY_SETTINGS_OUT_OF_RANGE' } });
    }
    await expect(set({ checkPeriodSeconds: null })).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    expect(await get()).toMatchObject({ checkPeriodSeconds: 600, failedChecksToOverdue: 2 });
  });

  it('only whoever manages the App changes them', async () => {
    await expect(set({ checkPeriodSeconds: 300 }, ctx(member.id))).rejects.toThrow();
    expect(await get()).toMatchObject({ checkPeriodSeconds: 600 });
  });

  it('the database bound holds under a bypassing write', async () => {
    await expect(db.$executeRaw`UPDATE apps SET delivery_failed_checks_to_overdue = 0 WHERE id = ${appId}`).rejects.toThrow();
    await expect(db.$executeRaw`UPDATE apps SET delivery_check_period_seconds = 30 WHERE id = ${appId}`).rejects.toThrow();
  });
});

describe('#2138 §3.6 — the team pause', () => {
  const pause = (paused: boolean, c = ctx(manager.id)) => Promise.resolve().then(() => M.setTeamPause({}, { appRef: appId, paused }, c));
  const flag = async () => (await db.app.findUniqueOrThrow({ where: { id: appId } })).teamPausedAt;

  it('whoever manages the App pauses and resumes; both are idempotent and a repeat keeps the original time', async () => {
    expect(await flag()).toBeNull();
    const first = await pause(true);
    expect(first.teamPausedAt).toBeInstanceOf(Date);
    await new Promise((r) => setTimeout(r, 15));
    expect((await pause(true)).teamPausedAt).toEqual(first.teamPausedAt);
    expect(await pause(false)).toEqual({ teamPausedAt: null });
    expect(await pause(false)).toEqual({ teamPausedAt: null });
    expect(await flag()).toBeNull();
  });

  it('lifting it records when it ended (teamResumedAt, which restarts every check clock); a repeat lift or a fresh pause keeps/clears nothing else', async () => {
    const resumed = async () => (await db.app.findUniqueOrThrow({ where: { id: appId } })).teamResumedAt;
    expect(await resumed()).toBeNull();
    await pause(true);
    expect(await resumed()).toBeNull();
    await pause(false);
    const at = await resumed();
    expect(at).toBeInstanceOf(Date);
    await new Promise((r) => setTimeout(r, 15));
    await pause(false); // already resumed: a no-op, the time stays
    expect(await resumed()).toEqual(at);
  });

  it('a worker cannot lift it, nor can a plain member, an outsider or an App key', async () => {
    await pause(true);
    await code(runAsActor({ workerId, agentId }, () => pause(false)), 'FORBIDDEN');
    await expect(pause(false, ctx(member.id))).rejects.toThrow();
    await expect(pause(false, ctx(outsider.id))).rejects.toThrow();
    expect(await flag()).toBeInstanceOf(Date);
  });

  it('is separate from the worker\'s own pause: ending the team pause clears no self-pause, and a self-pause does not set the team flag', async () => {
    const until = new Date(Date.now() + 3600_000);
    await db.workerWakeSettings.create({ data: { workerId, pausedUntil: until } });
    expect(await flag()).toBeNull();
    await pause(true);
    await pause(false);
    expect((await db.workerWakeSettings.findUniqueOrThrow({ where: { workerId } })).pausedUntil).toEqual(until);
  });

  it('is exposed on the App and has an MCP twin', async () => {
    await pause(true);
    const { typeDefs } = await import('./typeDefs.js');
    expect(typeDefs).toContain('teamPausedAt: DateTime');
    const { TICKER_WRITE_TOOLS } = await import('../../../mcp/tickerTools.js');
    expect(TICKER_WRITE_TOOLS).toContain('hadron_set_team_pause');
  });
});

describe('#2138 follow-up — LIVE_CHECK is a TickerReason over the wire', () => {
  const wire = async (query: string, variables: Record<string, unknown>) => {
    const { ApolloServer } = await import('@apollo/server');
    const { typeDefs } = await import('./typeDefs.js');
    const server = new ApolloServer<Context>({ typeDefs, resolvers });
    try {
      const r = await server.executeOperation({ query, variables }, { contextValue: ctx(manager.id) });
      if (r.body.kind !== 'single') throw new Error('unexpected multipart result');
      return r.body.singleResult;
    } finally { await server.stop(); }
  };

  it('createTicker accepts LIVE_CHECK (alone and with the others), stores live-check, and reading it back names LIVE_CHECK', async () => {
    const created = await wire(
      'mutation($a:String!,$i:TickerInput!){createTicker(appRef:$a,input:$i){id reasons}}',
      { a: appId, i: { name: 'Team check', cadenceSeconds: 600, relevance: 'MENTIONS', reasons: ['READ_TEAM_CHANNEL', 'LIVE_CHECK'] } },
    );
    expect(created.errors).toBeUndefined();
    expect((created.data as any).createTicker.reasons).toEqual(['READ_TEAM_CHANNEL', 'LIVE_CHECK']);
    const id = (created.data as any).createTicker.id;
    expect((await db.ticker.findUniqueOrThrow({ where: { id } })).reasons).toEqual(['read-team-channel', 'live-check']);
    const read = await wire('query($a:String!){tickers(appRef:$a){id reasons}}', { a: appId });
    expect(read.errors).toBeUndefined();
    expect((read.data as any).tickers.find((t: any) => t.id === id).reasons).toEqual(['READ_TEAM_CHANNEL', 'LIVE_CHECK']);
  });

  it('a ticker that is only live-check reads back, and updateTicker can switch it to and from LIVE_CHECK', async () => {
    const created = await wire('mutation($a:String!,$i:TickerInput!){createTicker(appRef:$a,input:$i){id reasons}}',
      { a: appId, i: { name: 'Only live', cadenceSeconds: 600, reasons: ['LIVE_CHECK'] } });
    expect(created.errors).toBeUndefined();
    const id = (created.data as any).createTicker.id;
    expect((created.data as any).createTicker.reasons).toEqual(['LIVE_CHECK']);
    const patched = await wire('mutation($r:String!,$p:TickerPatch!){updateTicker(ref:$r,input:$p){reasons}}',
      { r: id, p: { reasons: ['EVERY_TICK'] } });
    expect(patched.errors).toBeUndefined();
    expect((patched.data as any).updateTicker.reasons).toEqual(['EVERY_TICK']);
    const back = await wire('mutation($r:String!,$p:TickerPatch!){updateTicker(ref:$r,input:$p){reasons}}', { r: id, p: { reasons: ['LIVE_CHECK'] } });
    expect(back.errors).toBeUndefined();
    expect((back.data as any).updateTicker.reasons).toEqual(['LIVE_CHECK']);
  });

  it('an unknown reason is still refused by the schema', async () => {
    const r = await wire('mutation($a:String!,$i:TickerInput!){createTicker(appRef:$a,input:$i){id}}',
      { a: appId, i: { name: 'Bad', cadenceSeconds: 600, reasons: ['NOPE'] } });
    expect(r.errors?.length).toBeGreaterThan(0);
  });
});

describe('#2755 — darkAlarmWindowSeconds', () => {
  it('defaults to 1800 s, is changed alone by a manager and preserved by other patches', async () => {
    expect(await get()).toMatchObject({ darkAlarmWindowSeconds: 1800 });
    expect(await set({ darkAlarmWindowSeconds: 900 })).toMatchObject({ darkAlarmWindowSeconds: 900, stuckWindowSeconds: 900, checkPeriodSeconds: 600 });
    expect(await set({ busyDelaySeconds: 500 })).toMatchObject({ darkAlarmWindowSeconds: 900 });
    expect(await get()).toMatchObject({ darkAlarmWindowSeconds: 900 });
  });

  it('is independent of stuckWindowSeconds: no DELIVERY_SETTINGS_CONFLICT relation', async () => {
    expect(await set({ darkAlarmWindowSeconds: 300 })).toMatchObject({ darkAlarmWindowSeconds: 300, stuckWindowSeconds: 900 });
  });

  it('refuses a window outside 300..86400, a non-integer and null, changing nothing', async () => {
    for (const input of [{ darkAlarmWindowSeconds: 299 }, { darkAlarmWindowSeconds: 86_401 }, { darkAlarmWindowSeconds: 1800.5 }]) {
      await expect(set(input)).rejects.toMatchObject({ extensions: { code: 'DELIVERY_SETTINGS_OUT_OF_RANGE' } });
    }
    await expect(set({ darkAlarmWindowSeconds: null })).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    expect(await get()).toMatchObject({ darkAlarmWindowSeconds: 1800 });
  });

  it('only whoever manages the App changes it', async () => {
    await expect(set({ darkAlarmWindowSeconds: 600 }, ctx(member.id))).rejects.toThrow();
    expect(await get()).toMatchObject({ darkAlarmWindowSeconds: 1800 });
  });

  it('the database bound holds under a bypassing write', async () => {
    await expect(db.$executeRaw`UPDATE apps SET delivery_dark_alarm_window_seconds = 10 WHERE id = ${appId}`).rejects.toThrow();
  });
});
