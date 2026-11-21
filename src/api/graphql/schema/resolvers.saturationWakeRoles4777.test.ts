/**
 * #4777 (#3819 slice 2; hrn:node:hadronmemory.com:specs:cor:agt:060:16, Proposed; Vera V7, V39, V45, V51) — the App's
 * saturation-alarm wake-roles list: its set door (whoever manages the App, cor:dmo:050:12), its read door (the roster
 * audience, cor:agt:050:21, :23), and the wake a saturation alarm offers the App's listed workers when it is raised.
 *
 * The wake record: one `AgentTeamAlarmSchedule` row per woken worker, written in the transaction that raises the alarm
 * (slice 1's `raiseSaturation`), with the alarm's chain naming those workers. Delivery is the shared due-wake path, so
 * cor:agt:080:11 (who is never due) applies as for any alarm.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { recordMatchOutcome } from '../../../lib/agentTasks/matchOutcomes.js';
import type { Requirements } from '../../../lib/agentTasks/matcher.js';
import { pendingTaskWakes } from '../../../lib/agentTasks/taskWakes.js';
import { computeDueWakes } from '../../../lib/tickers/dueWakes.js';
import { DISABLED_TEAM_TOOLS } from '../../../mcp/disabledTools.js';
import { registerAgentTaskTools } from '../../../mcp/agentTaskTools.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const Q = resolvers.Query as any;
const M = resolvers.Mutation as any;
const HOUR = 3_600_000;
const TYPE = 'alarm.saturation';
const ago = (h: number) => new Date(Date.now() - h * HOUR);
const SERVER_MID: Requirements = { familyIn: ['claude'], minTier: 'mid', role: 'server-engineer' };

let appId: string, otherAppId: string, agentId: string, orgId: string;
let ownerId: string, orgAdminId: string, orgOwnerId: string, platformAdminId: string, memberId: string, outsiderId: string;
let keyId: string;
const ctx = (userId: string, extra: Partial<Context> = {}): Context => ({ db, userId, roles: ['READER'], ...extra });
const keyCtx = (): Context => ({ db, appId, appKeyId: keyId, roles: [] });

async function evaluate(now = new Date()): Promise<string[]> {
  return (await import('../../../lib/agentTasks/saturation.js')).evaluateSaturation(db, now);
}
async function alarms(app = appId) {
  return db.agentTeamEvent.findMany({ where: { appId: app, type: TYPE }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
}
const rows = (eventId: string) => db.agentTeamAlarmSchedule.findMany({ where: { eventId }, orderBy: { chainIndex: 'asc' } });
const chainWorkers = (chain: unknown) => (chain as Array<{ workerId?: string }>).map((p) => p.workerId);
const failure = async (p: Promise<unknown>) => {
  try { await p; return null; } catch (e) {
    expect(e).toBeInstanceOf(GraphQLError);
    const g = e as GraphQLError;
    return { message: g.message, extensions: g.extensions };
  }
};
const code = async (p: Promise<unknown>) => (await failure(p))?.extensions?.code ?? 'RESOLVED';

const setRoles = (roles: unknown, c: Context, app = appId) => M.setSaturationAlarmWakeRoles({}, { appRef: app, roles }, c);
const readRoles = (c: Context, app = appId) => Q.saturationAlarmWakeRoles({}, { appRef: app }, c);
const stored = async () => (await db.agentTaskStallSchedule.findUnique({ where: { appId } }))?.saturationWakeRoles ?? [];

beforeEach(async () => {
  await cleanDb(db);
  const n = generateId().slice(-8).toLowerCase();
  const user = (h: string, roles = ['READER']) => db.user.create({ data: { handle: `${h}-${n}`, roles: roles as never } }).then((u) => u.id);
  ownerId = await user('owner');
  orgAdminId = await user('oadmin');
  orgOwnerId = await user('oowner');
  platformAdminId = await user('padmin', ['READER', 'ADMIN']);
  memberId = await user('member');
  outsiderId = await user('outsider');
  const org = await db.organization.create({ data: { name: 'Wake roles', urn: `wr-${n}.test` } });
  orgId = org.id;
  await db.orgMember.createMany({ data: [
    { organizationId: org.id, userId: orgAdminId, role: 'ADMIN' },
    { organizationId: org.id, userId: orgOwnerId, role: 'OWNER' },
  ] });
  agentId = (await M.createAgent({}, { orgRef: org.id, name: 'Wake Agent' }, ctx(orgAdminId))).id;
  appId = (await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `wr-${n}.test:team` } })).id;
  otherAppId = (await db.app.create({ data: { organizationId: org.id, name: 'Other', urn: `wr-${n}.test:other` } })).id;
  await db.appMember.createMany({ data: [
    { appId, userId: ownerId, role: 'owner' },
    { appId, userId: memberId, role: 'member' },
    { appId: otherAppId, userId: memberId, role: 'member' },
  ] });
  keyId = (await db.appKey.create({ data: { id: generateId(), appId, keyHash: `h-${generateId()}`, keyPreview: 'abcd' } })).id;
});

/** A worker of `app` in `role`, held by the member, with one open session (so it is never dormant here). */
async function worker(role: string, app = appId, extra: { retiredAt?: Date } = {}) {
  const id = generateId();
  await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id, appId: app, agentId, name: `W-${id}`, slug: `w-${id}`, role, heldByUserId: memberId, ...extra } });
  await db.session.create({ data: { id: generateId(), appId: app, agentId, workerId: id, family: 'claude', llmModel: 'claude-sonnet-5-5', startedAt: ago(1), updatedAt: new Date() } });
  return id;
}
/** One no-worker outcome for SERVER_MID, which no worker here matches, so the evaluator raises one alarm. */
async function saturate(app = appId) {
  await recordMatchOutcome(db, app, SERVER_MID, 'NO_WORKER', 'NOBODY_FREE');
}

describe('#4777 the list: empty by default, set by whoever manages the App (cor:agt:060:16, cor:dmo:050:12)', () => {
  it('is empty by default and a participant reads it', async () => {
    expect(await readRoles(ctx(memberId))).toEqual({ appId, roles: [] });
  });

  it.each([
    ['the App owner (an owner-role member)', () => ownerId],
    ['an org ADMIN', () => orgAdminId],
    ['an org OWNER', () => orgOwnerId],
    ['a platform admin', () => platformAdminId],
  ])('%s sets, replaces and clears it, and the read returns what is stored', async (_label, who) => {
    const c = ctx(who(), who() === platformAdminId ? { roles: ['READER', 'ADMIN'] } : {});
    expect(await setRoles(['triager'], c)).toEqual({ appId, roles: ['triager'] });
    expect(await readRoles(ctx(memberId))).toEqual({ appId, roles: ['triager'] });
    expect(await setRoles(['qa-engineer', 'coordinator'], c)).toEqual({ appId, roles: ['coordinator', 'qa-engineer'] });
    expect(await setRoles([], c)).toEqual({ appId, roles: [] });
    expect(await stored()).toEqual([]);
  });

  it('collapses duplicates (after trimming and case) and keeps a role no worker holds', async () => {
    expect(await setRoles([' Triager ', 'triager', 'TRIAGER', 'nobody-has-this'], ctx(ownerId))).toEqual({ appId, roles: ['nobody-has-this', 'triager'] });
    expect(await stored()).toEqual(['nobody-has-this', 'triager']);
  });

  it.each([
    ['an empty name', ['']],
    ['a blank name', ['   ']],
    ['a name with a colon', ['a:b']],
    ['a name with inner whitespace', ['tri ager']],
    ['a name over 64 characters', ['x'.repeat(65)]],
    ['more than 32 distinct names', Array.from({ length: 33 }, (_, i) => `role-${i}`)],
    ['a null list', null],
  ])('refuses %s as BAD_USER_INPUT before any write', async (_label, roles) => {
    await setRoles(['triager'], ctx(ownerId));
    const before = await db.agentTaskStallSchedule.findUniqueOrThrow({ where: { appId } });
    expect(await code(setRoles(roles, ctx(ownerId)))).toBe('BAD_USER_INPUT');
    expect(await db.agentTaskStallSchedule.findUniqueOrThrow({ where: { appId } })).toEqual(before);
  });

  it('exactly 32 names of 64 characters are accepted', async () => {
    const roles = Array.from({ length: 32 }, (_, i) => `${String(i).padStart(2, '0')}${'r'.repeat(62)}`);
    expect((await setRoles(roles, ctx(ownerId))).roles).toHaveLength(32);
  });

  it('S3: a participant who does not manage the App is refused APP_MANAGER_REQUIRED, and the list is unchanged', async () => {
    await setRoles(['triager'], ctx(ownerId));
    expect(await code(setRoles(['member-role'], ctx(memberId)))).toBe('APP_MANAGER_REQUIRED');
    expect(await stored()).toEqual(['triager']);
  });

  it('a bound worker adding its own role is refused (S3), even when its holder manages the App, without an instruction', async () => {
    const w = await worker('triager');
    await db.appMember.update({ where: { appId_userId: { appId, userId: memberId } }, data: { role: 'owner' } });
    const s = await db.session.findFirstOrThrow({ where: { workerId: w } });
    const bound = ctx(memberId, { sessionId: s.id });
    expect(await code(runAsActor({ workerId: w, agentId }, () => setRoles(['triager'], bound)))).toBe('APP_MANAGER_REQUIRED');
    expect(await stored()).toEqual([]);
  });

  it('a caller who cannot see the App gets APP_NOT_FOUND, byte-identical to a missing App, on the set and the read', async () => {
    const missing = generateId();
    const setHidden = await failure(setRoles(['triager'], ctx(outsiderId)));
    const setMissing = await failure(setRoles(['triager'], ctx(outsiderId), missing));
    expect(setHidden?.extensions?.code).toBe('APP_NOT_FOUND');
    expect(JSON.stringify(setHidden).split(appId).join('<ref>')).toBe(JSON.stringify(setMissing).split(missing).join('<ref>'));
    const readHidden = await failure(readRoles(ctx(outsiderId)));
    const readMissing = await failure(readRoles(ctx(outsiderId), missing));
    expect(JSON.stringify(readHidden).split(appId).join('<ref>')).toBe(JSON.stringify(readMissing).split(missing).join('<ref>'));
    expect(await stored()).toEqual([]);
  });

  it('the read answers exactly as the roster does, for an outsider, a participant and the App key', async () => {
    const same = async (c: Context) => {
      const roster = await failure(Q.teamRoster({}, { appRef: appId }, c));
      const mine = await failure(readRoles(c));
      expect(mine, JSON.stringify(c.userId ?? c.appKeyId)).toEqual(roster);
    };
    await same(ctx(outsiderId));
    await same(ctx(memberId));
    await same(keyCtx());
  });

  it('the App key is admitted or refused exactly as on setAgentTaskStallSchedule', async () => {
    const precedent = await failure(M.setAgentTaskStallSchedule({}, { appRef: appId, input: { notStartedMinutes: 33 } }, keyCtx()));
    const mine = await failure(setRoles(['triager'], keyCtx()));
    expect(mine?.extensions?.code).toBe(precedent?.extensions?.code);
  });

  it('writing the stored list again (in any order or spelling) changes nothing: no write, no new updatedAt', async () => {
    await setRoles(['triager', 'qa'], ctx(ownerId));
    const before = await db.agentTaskStallSchedule.findUniqueOrThrow({ where: { appId } });
    await new Promise((r) => setTimeout(r, 20));
    await setRoles(['QA', ' triager', 'qa'], ctx(ownerId));
    expect(await db.agentTaskStallSchedule.findUniqueOrThrow({ where: { appId } })).toEqual(before);
    await setRoles([], ctx(orgAdminId));
    await setRoles([], ctx(orgAdminId));
    expect(await stored()).toEqual([]);
  });

  it('clearing a list that was never set writes no row', async () => {
    await setRoles([], ctx(ownerId));
    expect(await db.agentTaskStallSchedule.count({ where: { appId } })).toBe(0);
  });
});

describe('#4777 the wake (cor:agt:060:16; the wake record is agent_team_alarm_schedule, in the alarm\'s transaction)', () => {
  it('S1: with the list empty, the alarm wakes nobody and a participant still reads it', async () => {
    await worker('triager');
    await saturate();
    await evaluate();
    const [alarm] = await alarms();
    expect(alarm.chain).toEqual([]);
    expect(await rows(alarm.id)).toEqual([]);
    const page = await Q.agentTeamEvents({}, { appRef: appId, alarmsOnly: true, newestFirst: true }, ctx(memberId));
    const events = Array.isArray(page) ? page : page.events ?? page.items;
    expect(events.map((e: { type: string }) => e.type)).toContain(TYPE);
  });

  it('S2: with the list naming triager, each live triager of THIS App gets one woken row and one pending wake; nobody else does', async () => {
    const t1 = await worker('triager');
    const t2 = await worker('Triager'); // a role matches regardless of case, as the combination's role does
    const eng = await worker('server-engineer');
    const retired = await worker('triager', appId, { retiredAt: ago(1) });
    const foreign = await worker('triager', otherAppId);
    await setRoles(['triager'], ctx(ownerId));
    await saturate();
    await evaluate();
    const [alarm] = await alarms();
    expect(chainWorkers(alarm.chain).sort()).toEqual([t1, t2].sort());
    const r = await rows(alarm.id);
    expect(r).toHaveLength(2);
    for (const row of r) {
      expect(row.wokenAt).not.toBeNull();
      expect(row.wokenAt?.getTime()).toBe(alarm.createdAt.getTime());
    }
    const pending = await pendingTaskWakes(db, [t1, t2, eng, retired, foreign], new Date());
    expect([...pending.keys()].sort()).toEqual([t1, t2].sort());
    for (const w of [t1, t2]) {
      expect(pending.get(w)).toEqual([expect.objectContaining({ eventId: alarm.id, event: 'ALARM', handle: 'SATURATION' })]);
    }
  });

  it('a listed role with no worker wakes nobody, and the alarm is still recorded', async () => {
    await worker('server-engineer', otherAppId);
    await setRoles(['triager'], ctx(ownerId));
    await saturate();
    await evaluate();
    const [alarm] = await alarms();
    expect(alarm.chain).toEqual([]);
    expect(await rows(alarm.id)).toEqual([]);
  });

  it('a second no-worker outcome in the same episode records no alarm and offers no second wake', async () => {
    const t = await worker('triager');
    await setRoles(['triager'], ctx(ownerId));
    await saturate();
    await evaluate();
    await saturate();
    await evaluate();
    const list = await alarms();
    expect(list).toHaveLength(1);
    expect(await rows(list[0].id)).toHaveLength(1);
    expect((await pendingTaskWakes(db, [t], new Date())).get(t)).toHaveLength(1);
  });

  it('a list change after the alarm neither adds nor removes its wakes', async () => {
    const t = await worker('triager');
    const q = await worker('qa');
    await setRoles(['triager'], ctx(ownerId));
    await saturate();
    await evaluate();
    const [alarm] = await alarms();
    await setRoles(['qa'], ctx(ownerId));
    await evaluate();
    const after = await db.agentTeamEvent.findUniqueOrThrow({ where: { id: alarm.id } });
    expect(chainWorkers(after.chain)).toEqual([t]);
    expect(await rows(alarm.id)).toHaveLength(1);
    const pending = await pendingTaskWakes(db, [t, q], new Date());
    expect([...pending.keys()]).toEqual([t]);
  });

  it('an alarm raised before the list was set wakes nobody, and setting the list later wakes nobody for it', async () => {
    const t = await worker('triager');
    await saturate();
    await evaluate();
    await setRoles(['triager'], ctx(ownerId));
    await evaluate();
    const [alarm] = await alarms();
    expect(await rows(alarm.id)).toEqual([]);
    expect((await pendingTaskWakes(db, [t], new Date())).size).toBe(0);
  });

  it('cor:agt:080:11: a paused listed worker is not handed the wake; an unpaused one is', async () => {
    const live = await worker('triager');
    const paused = await worker('triager');
    await db.workerWakeSettings.create({ data: { workerId: paused, pausedUntil: new Date(Date.now() + 24 * HOUR) } });
    await setRoles(['triager'], ctx(ownerId));
    await saturate();
    await evaluate();
    const [alarm] = await alarms();
    const due = await computeDueWakes({
      ctx: ctx(ownerId), app: { id: appId, organizationId: orgId, ownerUserId: null },
      reader: { manager: true, userId: ownerId }, requester: { userId: ownerId }, preview: true,
    });
    const woken = (w: string) => due.wakes.some((d: any) => d.workerId === w && d.wake.reasons.some((r: any) => r.kind === 'TASK' && r.eventId === alarm.id));
    expect(woken(live)).toBe(true);
    expect(woken(paused)).toBe(false);
  });

  it('acknowledging the alarm changes nothing else: the wake is still pending, and a woken worker may not acknowledge it', async () => {
    const t = await worker('triager');
    await setRoles(['triager'], ctx(ownerId));
    await saturate();
    await evaluate();
    const [alarm] = await alarms();
    const s = await db.session.findFirstOrThrow({ where: { workerId: t } });
    expect(await code(runAsActor({ workerId: t, agentId }, () => M.acknowledgeAlarm({}, { eventId: alarm.id }, ctx(memberId, { sessionId: s.id })))))
      .toBe('ALARM_NOT_IN_CHAIN');
    await M.acknowledgeAlarm({}, { eventId: alarm.id }, ctx(ownerId));
    expect((await pendingTaskWakes(db, [t], new Date())).get(t)).toEqual([expect.objectContaining({ eventId: alarm.id })]);
  });

  it('a woken listed worker is not YOUR_MOVE on the roster (the wake is an offer; only a manager acknowledges)', async () => {
    const t = await worker('triager');
    await setRoles(['triager'], ctx(ownerId));
    await saturate();
    await evaluate();
    const { workers } = await Q.teamRoster({}, { appRef: appId }, ctx(memberId));
    const row = workers.find((w: { workerId: string }) => w.workerId === t);
    expect(row?.state).not.toBe('YOUR_MOVE');
  });

  it('another App\'s list never wakes this App\'s workers, and this App\'s alarm never wakes another App\'s', async () => {
    const t = await worker('triager');
    // A triager of the OTHER App, whose own list names triager: it must never enter this App's alarm.
    const foreign = await worker('triager', otherAppId);
    await setRoles(['triager'], ctx(orgAdminId), otherAppId);
    await setRoles(['qa'], ctx(orgAdminId));
    await saturate();
    await evaluate();
    const [alarm] = await alarms();
    expect(alarm.chain).toEqual([]);
    expect((await pendingTaskWakes(db, [t, foreign], new Date())).size).toBe(0);
  });
});

describe('#4777 the MCP door: registered disabled, as the team cut requires (#3082 R1)', () => {
  it('the set and read tools are registered through the team cut, never listed', () => {
    registerAgentTaskTools({} as never, { db, auth: {} } as never);
    expect(DISABLED_TEAM_TOOLS).toEqual(expect.arrayContaining(['hadron_saturation_wake_roles_set', 'hadron_saturation_wake_roles']));
  });
});
