/**
 * #4937 (hrn:node:hadronmemory.com:specs:cor:agt:050:31) — an App's report of whether work exists OUTSIDE Hadron: its set door
 * (`reportExternalTasks`, whoever manages the App, cor:dmo:050:12) and its read door (`externalTasksReport`, the roster
 * audience, cor:agt:050:21, :23). What the report does to the cadence alarm is pinned in `leadCadence2763.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { DISABLED_TEAM_TOOLS } from '../../../mcp/disabledTools.js';
import { mcpExternalTasksReportArgs, registerAgentTaskTools } from '../../../mcp/agentTaskTools.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const Q = resolvers.Query as any;
const M = resolvers.Mutation as any;

let appId: string, otherAppId: string, agentId: string;
let ownerId: string, orgAdminId: string, orgOwnerId: string, platformAdminId: string, memberId: string, outsiderId: string;
let keyId: string;
const ctx = (userId: string, extra: Partial<Context> = {}): Context => ({ db, userId, roles: ['READER'], ...extra });
const keyCtx = (): Context => ({ db, appId, appKeyId: keyId, roles: [] });
const failure = async (p: Promise<unknown>) => {
  try { await p; return null; } catch (e) {
    expect(e).toBeInstanceOf(GraphQLError);
    const g = e as GraphQLError;
    return { message: g.message, extensions: g.extensions };
  }
};
const code = async (p: Promise<unknown>) => (await failure(p))?.extensions?.code ?? 'RESOLVED';
const report = (exist: unknown, c: Context, app = appId) => M.reportExternalTasks({}, { appRef: app, exist }, c);
const read = (c: Context, app = appId) => Q.externalTasksReport({}, { appRef: app }, c);
const row = () => db.app.findUniqueOrThrow({ where: { id: appId }, select: { externalTasksExist: true, externalTasksReportedAt: true, externalTasksReportedBy: true } });

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
  const org = await db.organization.create({ data: { name: 'External tasks', urn: `et-${n}.test` } });
  await db.orgMember.createMany({ data: [
    { organizationId: org.id, userId: orgAdminId, role: 'ADMIN' },
    { organizationId: org.id, userId: orgOwnerId, role: 'OWNER' },
  ] });
  agentId = (await M.createAgent({}, { orgRef: org.id, name: 'ET Agent' }, ctx(orgAdminId))).id;
  appId = (await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `et-${n}.test:team` } })).id;
  otherAppId = (await db.app.create({ data: { organizationId: org.id, name: 'Other', urn: `et-${n}.test:other` } })).id;
  await db.appMember.createMany({ data: [
    { appId, userId: ownerId, role: 'owner' },
    { appId, userId: memberId, role: 'member' },
    { appId: otherAppId, userId: memberId, role: 'member' },
  ] });
  keyId = (await db.appKey.create({ data: { id: generateId(), appId, keyHash: `h-${generateId()}`, keyPreview: 'abcd' } })).id;
});

describe('#4937 the report: never reported by default, made by whoever manages the App', () => {
  it('is null (never reported) by default and a participant reads it', async () => {
    expect(await read(ctx(memberId))).toEqual({ appId, exist: null, reportedAt: null });
  });

  it.each([
    ['the App owner (an owner-role member)', () => ownerId],
    ['an org ADMIN', () => orgAdminId],
    ['an org OWNER', () => orgOwnerId],
    ['a platform admin', () => platformAdminId],
  ])('%s reports, and a new report replaces the old one; the read returns what is stored', async (_label, who) => {
    const c = ctx(who(), who() === platformAdminId ? { roles: ['READER', 'ADMIN'] } : {});
    const first = await report(true, c);
    expect(first).toMatchObject({ appId, exist: true });
    expect(first.reportedAt).toBeInstanceOf(Date);
    expect(await read(ctx(memberId))).toEqual(first);
    expect(await report(false, c)).toMatchObject({ appId, exist: false });
    expect(await row()).toMatchObject({ externalTasksExist: false, externalTasksReportedBy: who() });
  });

  it('a report of false is a report: it opts the App in with nothing pending, so it reads false and not null', async () => {
    expect(await report(false, ctx(ownerId))).toMatchObject({ exist: false });
    expect((await read(ctx(memberId))).exist).toBe(false);
  });

  it('the time is the database clock, not the caller\'s, and the record is per App', async () => {
    const before = Date.now();
    await report(true, ctx(ownerId));
    const at = (await row()).externalTasksReportedAt as Date;
    expect(Math.abs(at.getTime() - before)).toBeLessThan(60_000);
    expect((await db.app.findUniqueOrThrow({ where: { id: otherAppId } })).externalTasksExist).toBeNull();
  });

  it.each([
    ['a string', 'true'],
    ['a number', 1],
    ['null', null],
    ['undefined', undefined],
  ])('refuses %s as BAD_USER_INPUT before any write', async (_label, exist) => {
    await report(true, ctx(ownerId));
    const before = await row();
    expect(await code(report(exist, ctx(ownerId)))).toBe('BAD_USER_INPUT');
    expect(await row()).toEqual(before);
  });

  it('a participant who does not manage the App is refused APP_MANAGER_REQUIRED, and the record is unchanged', async () => {
    expect(await code(report(true, ctx(memberId)))).toBe('APP_MANAGER_REQUIRED');
    expect((await row()).externalTasksExist).toBeNull();
  });

  it('a bound worker reporting is refused, even when its holder manages the App, without an instruction', async () => {
    const id = generateId();
    await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id, appId, agentId, name: `W-${id}`, slug: `w-${id}`, role: 'triager', heldByUserId: memberId } });
    const s = await db.session.create({ data: { id: generateId(), appId, agentId, workerId: id, family: 'claude', llmModel: 'claude-sonnet-5-5', startedAt: new Date(), updatedAt: new Date() } });
    await db.appMember.update({ where: { appId_userId: { appId, userId: memberId } }, data: { role: 'owner' } });
    expect(await code(runAsActor({ workerId: id, agentId }, () => report(true, ctx(memberId, { sessionId: s.id }))))).toBe('APP_MANAGER_REQUIRED');
    expect((await row()).externalTasksExist).toBeNull();
  });

  it('a caller who cannot see the App gets APP_NOT_FOUND, byte-identical to a missing App, on the report and the read', async () => {
    const missing = generateId();
    const setHidden = await failure(report(true, ctx(outsiderId)));
    const setMissing = await failure(report(true, ctx(outsiderId), missing));
    expect(setHidden?.extensions?.code).toBe('APP_NOT_FOUND');
    expect(JSON.stringify(setHidden).split(appId).join('<ref>')).toBe(JSON.stringify(setMissing).split(missing).join('<ref>'));
    const readHidden = await failure(read(ctx(outsiderId)));
    const readMissing = await failure(read(ctx(outsiderId), missing));
    expect(JSON.stringify(readHidden).split(appId).join('<ref>')).toBe(JSON.stringify(readMissing).split(missing).join('<ref>'));
    expect((await row()).externalTasksExist).toBeNull();
  });

  it('the read answers exactly as the roster does, for an outsider, a participant and the App key', async () => {
    for (const c of [ctx(outsiderId), ctx(memberId), keyCtx()]) {
      const roster = await failure(Q.teamRoster({}, { appRef: appId }, c));
      expect(await failure(read(c)), JSON.stringify(c.userId ?? c.appKeyId)).toEqual(roster);
    }
  });

  it('the App key is refused exactly as on setAgentTaskStallSchedule (no App-key scope in this slice)', async () => {
    const precedent = await failure(M.setAgentTaskStallSchedule({}, { appRef: appId, input: { notStartedMinutes: 33 } }, keyCtx()));
    const mine = await failure(report(true, keyCtx()));
    expect(precedent, 'the precedent refuses the App key').not.toBeNull();
    expect(mine?.extensions?.code).toBe(precedent?.extensions?.code);
    expect((await row()).externalTasksExist).toBeNull();
  });

  it('reporting the stored answer again changes nothing: no write, the first report\'s time and reporter stay', async () => {
    await report(true, ctx(ownerId));
    const before = await row();
    await new Promise((r) => setTimeout(r, 20));
    await report(true, ctx(orgAdminId));
    expect(await row()).toEqual(before);
  });

  it('concurrent reports by several managers all resolve: the writer takes the App row exclusive, so none deadlocks (40P01)', async () => {
    const results = await Promise.allSettled(Array.from({ length: 18 }, (_, i) => report(i % 2 === 0, ctx(i % 3 === 0 ? ownerId : orgAdminId))));
    expect(results.filter((r) => r.status === 'rejected').map((r) => (r as PromiseRejectedResult).reason?.message)).toEqual([]);
    expect(typeof (await row()).externalTasksExist).toBe('boolean');
  }, 30000);

  it('does not write the stall schedule row (the record is on the App)', async () => {
    await report(true, ctx(ownerId));
    expect(await db.agentTaskStallSchedule.count({ where: { appId } })).toBe(0);
  });
});

describe('#4937 the MCP door: registered disabled, as the team cut requires (#3082 R1)', () => {
  it('the report and read tools are registered through the team cut, never listed', () => {
    registerAgentTaskTools({} as never, { db, auth: {} } as never);
    expect(DISABLED_TEAM_TOOLS).toEqual(expect.arrayContaining(['hadron_external_tasks_report_set', 'hadron_external_tasks_report']));
  });

  it('the report tool forwards appRef and exist unchanged and drops its own session argument', () => {
    expect(mcpExternalTasksReportArgs({ session: 's-1', appRef: 'team-app', exist: false })).toEqual({ appRef: 'team-app', exist: false });
    expect(Object.keys(mcpExternalTasksReportArgs({ session: 's-1', appRef: 'a', exist: true })).sort()).toEqual(['appRef', 'exist']);
  });
});
