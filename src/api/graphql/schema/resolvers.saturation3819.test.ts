/**
 * #3819 slice 1 (hrn:node:hadronmemory.com:specs:cor:agt:060:13 to :16, Proposed; Vera V1-V8, V37-V51) — failed-match
 * saturation on the utilization read, the saturation episode, its evaluator, one alarm per episode, and its acknowledgement.
 * Slice 2 (#4777: the wake-roles list and the wake) is not built here: no wake is pinned.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer as httpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { createServer } from '../../../server.js';
import { USER_API_KEY_PREFIX, hashUserApiKey } from '../../../middleware/auth.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { purgeMatchOutcomes, recordMatchOutcome, type MatchOutcomeKind } from '../../../lib/agentTasks/matchOutcomes.js';
import type { Requirements } from '../../../lib/agentTasks/matcher.js';
import { taskStallTick } from '../../../jobs/taskStallEvaluator.js';
import { resolvers, type Context } from './resolvers.js';
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const Q = resolvers.Query as any;
const M = resolvers.Mutation as any;
const HOUR = 3_600_000;
const TYPE = 'alarm.saturation';
const ago = (h: number) => new Date(Date.now() - h * HOUR);
/** A DbInstant (naive UTC, microseconds) for `recordMatchOutcome`'s decision time. */
const inst = (d: Date) => `${d.toISOString().slice(0, 23).replace('T', ' ')}000`;
let appId: string, agentId: string, memberId: string, adminId: string;
const ctx = (userId = memberId): Context => ({ db, userId, roles: ['READER'] });

async function saturation() {
  // Dynamic, so each pin fails on its own assertion on main (the module does not exist there).
  return import('../../../lib/agentTasks/saturation.js');
}
async function evaluate(now = new Date()): Promise<string[]> {
  return (await saturation()).evaluateSaturation(db, now);
}
async function alarms() {
  return db.agentTeamEvent.findMany({ where: { appId, type: TYPE }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
}
type Episode = { id: string; family: string; tier: string; role: string; eventId: string; openedAt: Date; endedAt: Date | null };
async function episodes(): Promise<Episode[]> {
  return db.$queryRaw<Episode[]>`
    SELECT id, family, tier, role, event_id AS "eventId", opened_at AS "openedAt", ended_at AS "endedAt"
    FROM saturation_episodes WHERE app_id = ${appId} ORDER BY opened_at, id`;
}
const open = async () => (await episodes()).filter((e) => e.endedAt === null);

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { name: 'Saturation', urn: `sat-${generateId()}.test` } });
  adminId = (await db.user.create({ data: { handle: `sa-${generateId()}`, roles: ['READER'] } })).id;
  memberId = (await db.user.create({ data: { handle: `sm-${generateId()}`, roles: ['READER'] } })).id;
  await db.orgMember.create({ data: { organizationId: org.id, userId: adminId, role: 'ADMIN' } });
  agentId = (await M.createAgent({}, { orgRef: org.id, name: 'Saturation Agent' }, ctx(adminId))).id;
  appId = (await db.app.create({ data: { organizationId: org.id, name: 'Saturation', urn: `sat-${generateId()}.test:team` } })).id;
  await db.appMember.create({ data: { appId, userId: memberId, role: 'member' } });
});

/** A bound worker: family claude, model claude-sonnet-5-5 (tier mid), role server-engineer unless told otherwise. */
async function worker(opts: { family?: string; model?: string | null; role?: string } = {}) {
  const id = generateId();
  await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id, appId, agentId, name: `Worker-${id}`, slug: `worker-${id}`, role: opts.role ?? 'server-engineer', heldByUserId: memberId } });
  await db.session.create({ data: { id: generateId(), appId, agentId, workerId: id, family: opts.family ?? 'claude', llmModel: opts.model === undefined ? 'claude-sonnet-5-5' : opts.model, startedAt: ago(48), updatedAt: ago(48) } });
  return id;
}
async function task(workerId: string) {
  return db.agentTask.create({ data: { appId, title: 'Synthetic task', ownerUserId: memberId, assigneeWorkerId: workerId, assignedAt: ago(48), createdAt: ago(48) } });
}
const SERVER_MID: Requirements = { familyIn: ['claude'], minTier: 'mid', role: 'server-engineer' };
/** One decided outcome against every combination `req` names, decided `hoursAgo` hours ago. */
async function outcome(req: Requirements, kind: MatchOutcomeKind, hoursAgo: number, reason = 'NOBODY_FREE') {
  await recordMatchOutcome(db, appId, req, kind, kind === 'NO_WORKER' ? reason : null, inst(ago(hoursAgo)));
}
async function read(args: Record<string, unknown> = {}, c = ctx()) {
  return Q.teamUtilization({}, { appRef: appId, ...args }, c);
}
const key = (r: { family: string | null; tier: string | null; role: string | null }) => [r.family, r.tier, r.role];

describe('#3819 slice 1 — the read (cor:agt:060:13)', () => {
  it('4 eligible, 3 busy: 0.75, not saturated, lastMatchFailure null', async () => {
    const ids = await Promise.all([worker(), worker(), worker(), worker()]);
    await Promise.all(ids.slice(0, 3).map((w) => task(w)));
    expect((await read()).combinations).toEqual([
      { family: 'claude', tier: 'mid', role: 'server-engineer', eligibleWorkers: 4, busyWorkers: 3, utilization: 0.75, saturated: false, lastMatchFailure: null },
    ]);
  });

  it('a no-worker outcome inside the window saturates the row (utilization 1) and lastMatchFailure carries its time and reason', async () => {
    await worker();
    await outcome(SERVER_MID, 'NO_WORKER', 2, 'NOBODY_FREE');
    const [row] = (await read()).combinations;
    expect(row).toMatchObject({ family: 'claude', tier: 'mid', role: 'server-engineer', eligibleWorkers: 1, busyWorkers: 0, utilization: 1, saturated: true });
    expect(row.lastMatchFailure?.reason).toBe('NOBODY_FREE');
    expect(Math.abs(new Date(row.lastMatchFailure.at).getTime() - ago(2).getTime())).toBeLessThan(60_000);
  });

  it('a no-worker outcome outside the window does not saturate the read, but the episode stays open (:15)', async () => {
    await worker();
    await outcome(SERVER_MID, 'NO_WORKER', 30);
    const [row] = (await read({ windowHours: 24 })).combinations;
    expect(row).toMatchObject({ eligibleWorkers: 1, utilization: 0, saturated: false, lastMatchFailure: null });
    await evaluate();
    expect((await open()).map(key)).toEqual([['claude', 'mid', 'server-engineer']]);
    // The 48-hour read sees it.
    expect((await read({ windowHours: 48 })).combinations[0]).toMatchObject({ saturated: true, utilization: 1 });
  });

  it('a later MATCHED clears lastMatchFailure and the failure saturation', async () => {
    await worker();
    await outcome(SERVER_MID, 'NO_WORKER', 3);
    await outcome(SERVER_MID, 'MATCHED', 1);
    expect((await read()).combinations[0]).toMatchObject({ saturated: false, utilization: 0, lastMatchFailure: null });
  });

  it('a combination with no workers and a current no-worker outcome appears on the ranked list; the most recent failure ranks first', async () => {
    await worker(); // claude/mid/server-engineer: eligible, idle
    await outcome({ familyIn: ['codex'], minTier: 'high', role: 'qa-engineer' }, 'NO_WORKER', 5);
    await outcome({ familyIn: ['glm'], minTier: 'low', role: 'docs-engineer' }, 'NO_WORKER', 1);
    const rows = (await read()).combinations;
    expect(rows.map(key)).toEqual([['glm', 'low', 'docs-engineer'], ['codex', 'high', 'qa-engineer'], ['claude', 'mid', 'server-engineer']]);
    expect(rows[0]).toMatchObject({ eligibleWorkers: 0, busyWorkers: 0, utilization: 1, saturated: true });
    expect(rows[0].lastMatchFailure.reason).toBe('NOBODY_FREE');
  });

  it('equal utilization: the most recent failure first, then a saturated row with no failure, then fewest eligible', async () => {
    const paused = await worker({ family: 'codex', model: 'gpt-6.1-sol' });
    await db.modelFamilyAvailability.create({ data: { appId, family: 'codex', state: 'unavailable', reason: 'other', setByUserId: memberId, setAt: ago(1) } });
    void paused;
    await worker(); // claude/mid/server-engineer, eligible
    await outcome(SERVER_MID, 'NO_WORKER', 4);
    await outcome({ familyIn: ['glm'], minTier: 'low', role: 'docs-engineer' }, 'NO_WORKER', 2);
    const rows = (await read()).combinations;
    // All three at utilization 1: glm (failure 2 h ago), claude (4 h ago), codex (paused: no failure).
    expect(rows.map((r: any) => r.family)).toEqual(['glm', 'claude', 'codex']);
  });

  it('a task that left the family open puts a family-null row on the list (gate ruling 7067106396)', async () => {
    await outcome({ role: 'server-engineer' }, 'NO_WORKER', 1);
    const rows = (await read()).combinations;
    expect(rows.map(key)).toEqual([[null, null, 'server-engineer']]);
    expect(rows[0]).toMatchObject({ saturated: true, utilization: 1, eligibleWorkers: 0 });
  });

  it('a task naming no tier lands on the tier-null row (V37)', async () => {
    await worker({ model: null }); // tier unknown: the tier-null row
    await outcome({ familyIn: ['claude'], role: 'server-engineer' }, 'NO_WORKER', 1);
    const rows = (await read()).combinations;
    expect(rows.map(key)).toEqual([['claude', null, 'server-engineer']]);
    expect(rows[0]).toMatchObject({ eligibleWorkers: 1, saturated: true, utilization: 1 });
  });

  it('filters narrow the outcome-only rows too', async () => {
    await outcome({ familyIn: ['codex'], minTier: 'high', role: 'qa-engineer' }, 'NO_WORKER', 1);
    await outcome({ familyIn: ['glm'], minTier: 'low', role: 'docs-engineer' }, 'NO_WORKER', 1);
    expect((await read({ family: 'codex' })).combinations.map(key)).toEqual([['codex', 'high', 'qa-engineer']]);
    expect((await read({ tier: 'low' })).combinations.map(key)).toEqual([['glm', 'low', 'docs-engineer']]);
    expect((await read({ role: 'qa-engineer' })).combinations.map(key)).toEqual([['codex', 'high', 'qa-engineer']]);
  });

  it('another App\'s outcome never reaches this App\'s list', async () => {
    const other = await db.app.create({ data: { name: 'Other', urn: `sat-${generateId()}.test:other`, ownerUserId: memberId } });
    await recordMatchOutcome(db, other.id, SERVER_MID, 'NO_WORKER', 'NOBODY_FREE');
    expect((await read()).combinations).toEqual([]);
  });

  it('the real GraphQL field carries lastMatchFailure and a null family', async () => {
    await outcome({ role: 'server-engineer' }, 'NO_WORKER', 1, 'NO_ROLE');
    const k = `${USER_API_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
    await db.userApiKey.create({ data: { userId: memberId, oauthScopes: [], keyHash: hashUserApiKey(k), keyPreview: k.slice(-4) } });
    const server = httpServer(await createServer());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const r = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/graphql`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${k}` },
        body: JSON.stringify({ query: 'query($app:ID!){teamUtilization(appRef:$app){combinations{family tier role eligibleWorkers saturated utilization lastMatchFailure{at reason}}}}', variables: { app: appId } }),
      }).then((x) => x.json()) as any;
      expect(r.errors).toBeUndefined();
      expect(r.data.teamUtilization.combinations).toEqual([
        { family: null, tier: null, role: 'server-engineer', eligibleWorkers: 0, saturated: true, utilization: 1, lastMatchFailure: { at: expect.any(String), reason: 'NO_ROLE' } },
      ]);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});

describe('#3819 slice 1 — episodes and the alarm (cor:agt:060:14, :15)', () => {
  it('S1: the first no-worker outcome records one alarm, task-less, App-owned, with its combination', async () => {
    await outcome(SERVER_MID, 'NO_WORKER', 1);
    const raised = await evaluate();
    const list = await alarms();
    expect(list).toHaveLength(1);
    expect(raised).toEqual([list[0].id]);
    expect(list[0]).toMatchObject({ appId, taskId: null, subjectWorkerId: null, severity: 'alarm', acknowledgedAt: null });
    expect(list[0].payload).toMatchObject({ family: 'claude', tier: 'mid', role: 'server-engineer', reason: 'no-worker' });
    const eps = await episodes();
    expect(eps).toHaveLength(1);
    expect(eps[0]).toMatchObject({ family: 'claude', tier: 'mid', role: 'server-engineer', eventId: list[0].id, endedAt: null });
  });

  it('S2: a second outcome in the episode records no second alarm', async () => {
    await outcome(SERVER_MID, 'NO_WORKER', 2);
    await evaluate();
    await outcome(SERVER_MID, 'NO_WORKER', 1);
    expect(await evaluate()).toEqual([]);
    expect(await alarms()).toHaveLength(1);
    expect(await open()).toHaveLength(1);
  });

  it('S3: a match ends the episode, and the next failure records a new alarm', async () => {
    await outcome(SERVER_MID, 'NO_WORKER', 3);
    await evaluate();
    await outcome(SERVER_MID, 'MATCHED', 2);
    await evaluate();
    expect(await open()).toEqual([]);
    expect((await episodes())[0].endedAt).not.toBeNull();
    await outcome(SERVER_MID, 'NO_WORKER', 1);
    await evaluate();
    expect(await alarms()).toHaveLength(2);
    expect(await open()).toHaveLength(1);
  });

  it('S4: the only eligible worker marked unavailable opens an episode; back, with no outcome current, it closes', async () => {
    const w = await worker();
    expect(await evaluate()).toEqual([]);
    await db.workerAvailability.create({ data: { workerId: w, state: 'unavailable', reason: 'other', setBy: 'worker', setAt: ago(1) } });
    expect(await evaluate()).toHaveLength(1);
    expect((await alarms())[0].payload).toMatchObject({ family: 'claude', tier: 'mid', role: 'server-engineer', reason: 'none-eligible' });
    await db.workerAvailability.deleteMany({ where: { workerId: w } });
    await evaluate();
    expect(await open()).toEqual([]);
    expect(await alarms()).toHaveLength(1);
  });

  it('gaining an eligible worker does NOT end an episode while the latest outcome is no worker', async () => {
    await outcome(SERVER_MID, 'NO_WORKER', 1);
    await evaluate();
    await worker();
    await evaluate();
    expect(await open()).toHaveLength(1);
  });

  it('S5: two concurrent raises for one combination record exactly one alarm and one episode (the open-episode index)', async () => {
    const { raiseSaturation } = await saturation();
    const now = new Date();
    const combo = { family: 'claude', tier: 'mid', role: 'server-engineer' };
    const results = await Promise.all([
      raiseSaturation(db, appId, combo, 'none-eligible', now),
      raiseSaturation(db, appId, combo, 'none-eligible', now),
      raiseSaturation(db, appId, combo, 'none-eligible', now),
    ]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect(await alarms()).toHaveLength(1);
    expect(await open()).toHaveLength(1);
  });

  it('S5: two concurrent evaluator passes record one alarm', async () => {
    await outcome(SERVER_MID, 'NO_WORKER', 1);
    const now = new Date();
    await Promise.all([evaluate(now), evaluate(now), evaluate(now)]);
    expect(await alarms()).toHaveLength(1);
  });

  it('the database refuses a second OPEN episode for one combination, and admits one after the first ended', async () => {
    const { raiseSaturation } = await saturation();
    const combo = { family: 'claude', tier: '', role: '' };
    const id = await raiseSaturation(db, appId, { family: 'claude', tier: null, role: null }, 'none-eligible', new Date());
    expect(id).not.toBeNull();
    const eventId = generateId();
    await db.$executeRaw`INSERT INTO agent_team_events (id, app_id, type, severity, chain, payload) VALUES (${eventId}, ${appId}, ${TYPE}, 'alarm', '[]'::jsonb, '{}'::jsonb)`;
    await expect(db.$executeRaw`INSERT INTO saturation_episodes (id, app_id, family, tier, role, event_id, opened_at)
      VALUES (${generateId()}, ${appId}, ${combo.family}, ${combo.tier}, ${combo.role}, ${eventId}, now())`).rejects.toThrow(/23505[\s\S]*Key \(app_id, family, tier, role\)/);
    await db.$executeRaw`UPDATE saturation_episodes SET ended_at = opened_at WHERE app_id = ${appId}`;
    // The refused insert above did not commit, so its event is free to carry the next episode.
    await db.$executeRaw`INSERT INTO saturation_episodes (id, app_id, family, tier, role, event_id, opened_at)
      VALUES (${generateId()}, ${appId}, ${combo.family}, ${combo.tier}, ${combo.role}, ${eventId}, now())`;
    expect(await open()).toHaveLength(1);
  });

  it('a no-worker outcome aged past 168 hours ends the episode, the row still present', async () => {
    await outcome(SERVER_MID, 'NO_WORKER', 167);
    await evaluate();
    expect(await open()).toHaveLength(1);
    await db.$executeRaw`UPDATE agent_match_outcomes SET decided_at = decided_at - interval '2 hours' WHERE app_id = ${appId}`;
    expect(await db.agentMatchOutcome.count({ where: { appId } })).toBe(1);
    await evaluate();
    expect(await open()).toEqual([]);
  });

  it('a no-worker outcome aged past 168 hours ends the episode after the purge took its row', async () => {
    await outcome(SERVER_MID, 'NO_WORKER', 167);
    await evaluate();
    await db.$executeRaw`UPDATE agent_match_outcomes SET decided_at = decided_at - interval '2 hours' WHERE app_id = ${appId}`;
    expect(await purgeMatchOutcomes(db)).toBe(1);
    await evaluate();
    expect(await open()).toEqual([]);
  });

  it('a combination with no workers is saturated only by its outcome: under 168 hours it stays open', async () => {
    await outcome(SERVER_MID, 'NO_WORKER', 100);
    await evaluate();
    await evaluate();
    expect(await open()).toHaveLength(1);
  });

  it('a task naming two families and two roles alarms each combination it names', async () => {
    await outcome({ familyIn: ['claude', 'codex'], minTier: 'mid', roles: ['qa-engineer', 'server-engineer'] }, 'NO_WORKER', 1);
    expect(await evaluate()).toHaveLength(4);
    expect((await open()).map(key).sort()).toEqual([
      ['claude', 'mid', 'qa-engineer'], ['claude', 'mid', 'server-engineer'], ['codex', 'mid', 'qa-engineer'], ['codex', 'mid', 'server-engineer'],
    ]);
  });

  it('a task naming no tier alarms the tier-null row (V37); an open family alarms the family-null row', async () => {
    await outcome({ familyIn: ['claude'], role: 'server-engineer' }, 'NO_WORKER', 1);
    await outcome({ role: 'qa-engineer' }, 'NO_WORKER', 1);
    await evaluate();
    const payloads = (await alarms()).map((a) => a.payload as Record<string, unknown>);
    expect(payloads.map((p) => [p.family, p.tier, p.role]).sort((a, b) => String(a[2]).localeCompare(String(b[2])))).toEqual([[null, null, 'qa-engineer'], ['claude', null, 'server-engineer']]);
    expect((await open()).map(key).sort()).toEqual([['', '', 'qa-engineer'], ['claude', '', 'server-engineer']]);
  });

  it('a paused family alarms each of its combinations on the list, once each (V42)', async () => {
    await worker({ role: 'server-engineer' });
    await worker({ role: 'qa-engineer' });
    await worker({ family: 'codex', model: 'gpt-6.1-sol', role: 'qa-engineer' });
    expect(await evaluate()).toEqual([]);
    await db.modelFamilyAvailability.create({ data: { appId, family: 'claude', state: 'unavailable', reason: 'other', setByUserId: memberId, setAt: ago(1) } });
    expect(await evaluate()).toHaveLength(2);
    expect((await open()).map(key).sort()).toEqual([['claude', 'mid', 'qa-engineer'], ['claude', 'mid', 'server-engineer']]);
    expect(await evaluate()).toEqual([]);
  });

  it('a retired last worker with no current outcome raises no alarm and ENDS its open episode (FIT 1)', async () => {
    const w = await worker();
    await db.workerAvailability.create({ data: { workerId: w, state: 'unavailable', reason: 'other', setBy: 'worker', setAt: ago(1) } });
    await evaluate();
    expect(await open()).toHaveLength(1);
    await db.worker.update({ where: { id: w }, data: { retiredAt: new Date() } });
    expect(await evaluate()).toEqual([]);
    expect(await open()).toEqual([]);
    expect(await alarms()).toHaveLength(1);
    expect((await read()).combinations).toEqual([]);
  });

  it('a retired worker alone, never saturated, raises nothing', async () => {
    const w = await worker();
    await db.worker.update({ where: { id: w }, data: { retiredAt: new Date() } });
    expect(await evaluate()).toEqual([]);
    expect(await episodes()).toEqual([]);
  });

  it('an uninstalled App raises nothing and its open episode ends', async () => {
    await outcome(SERVER_MID, 'NO_WORKER', 1);
    await evaluate();
    await db.app.update({ where: { id: appId }, data: { uninstalledAt: new Date() } });
    await evaluate();
    expect(await open()).toEqual([]);
    await outcome({ familyIn: ['codex'], role: 'qa-engineer' }, 'NO_WORKER', 1);
    expect(await evaluate()).toEqual([]);
  });

  it('the stall evaluator tick runs the pass and reports it; the alarm wakes nobody in slice 1', async () => {
    await outcome(SERVER_MID, 'NO_WORKER', 1);
    const r = await taskStallTick(db, new Date());
    expect((r as any).saturationRaised).toBe(1);
    const [alarm] = await alarms();
    expect(alarm.chain).toEqual([]);
    expect(await db.agentTeamAlarmSchedule.count({ where: { eventId: alarm.id } })).toBe(0);
  });

  it('the roster audience reads the alarm in the App\'s event stream', async () => {
    await outcome(SERVER_MID, 'NO_WORKER', 1);
    await evaluate();
    const page = await Q.agentTeamEvents({}, { appRef: appId, alarmsOnly: true }, ctx());
    const events = Array.isArray(page) ? page : page.events ?? page.items;
    expect(events.map((e: any) => e.type)).toContain(TYPE);
  });
});

describe('#3819 slice 1 — acknowledgement (cor:agt:060:16, cor:agt:050:24)', () => {
  async function raised() {
    await outcome(SERVER_MID, 'NO_WORKER', 1);
    await evaluate();
    const [alarm] = await alarms();
    return alarm;
  }
  const rowOf = async (id: string) => {
    const [{ row }] = await db.$queryRaw<{ row: Record<string, unknown> }[]>`SELECT to_jsonb(e) AS row FROM agent_team_events e WHERE id = ${id}`;
    return row;
  };
  const withoutAck = (row: Record<string, unknown>) => {
    const { acknowledged_at, acknowledged_by_user_id, acknowledged_by_worker_id, ...rest } = row;
    void acknowledged_at; void acknowledged_by_user_id; void acknowledged_by_worker_id;
    return rest;
  };

  it('the App\'s manager acknowledges: who and when are recorded, the row is otherwise unchanged, the episode stays open', async () => {
    const alarm = await raised();
    const before = await rowOf(alarm.id);
    await M.acknowledgeAlarm({}, { eventId: alarm.id }, ctx(adminId));
    const after = await rowOf(alarm.id);
    expect(after.acknowledged_at).not.toBeNull();
    expect(after.acknowledged_by_user_id).toBe(adminId);
    expect(withoutAck(after)).toEqual(withoutAck(before));
    expect(await open()).toHaveLength(1);
    expect(await db.alarmEscalationEnd.count({ where: { eventId: alarm.id } })).toBe(0);
  });

  it('acknowledging an alarm whose episode ENDED records no escalation end (chain-less: freezeEndedEscalation leaves it alone)', async () => {
    const alarm = await raised();
    await outcome(SERVER_MID, 'MATCHED', 0);
    await evaluate();
    expect(await open()).toEqual([]);
    const before = await rowOf(alarm.id);
    await M.acknowledgeAlarm({}, { eventId: alarm.id }, ctx(adminId));
    expect(await db.alarmEscalationEnd.count({ where: { eventId: alarm.id } })).toBe(0);
    expect(withoutAck(await rowOf(alarm.id))).toEqual(withoutAck(before));
  });

  it('an ended saturation episode is never recorded as an escalation end by the pass either', async () => {
    const alarm = await raised();
    await outcome(SERVER_MID, 'MATCHED', 0);
    await taskStallTick(db, new Date());
    expect(await db.alarmEscalationEnd.count({ where: { eventId: alarm.id } })).toBe(0);
  });

  it('a participant who does not manage the App is refused ALARM_NOT_IN_CHAIN and the row is unchanged', async () => {
    const alarm = await raised();
    const before = await rowOf(alarm.id);
    await expect(M.acknowledgeAlarm({}, { eventId: alarm.id }, ctx(memberId))).rejects.toMatchObject({ extensions: { code: 'ALARM_NOT_IN_CHAIN' } });
    expect(await rowOf(alarm.id)).toEqual(before);
  });
});
