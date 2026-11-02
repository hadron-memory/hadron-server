import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
/**
 * #3077 — WHY a worker reads NO_SESSION (`WorkerCheckStatus.noSessionReason`):
 * IDLE, ENDED or NEVER_BOUND, per the CHECKED gate (issue comment 6554106259)
 * and Victor's spec check (6554090681, home cor:agt:100:03).
 *
 * - IDLE: an open (`endedAt` null), undeleted, not auto-expired session whose
 *   promised `expiresAt` has not passed, and which is not live (driven outside
 *   its type's idle window).
 * - ENDED: otherwise, any undeleted Session row: ended, auto-expired, or past
 *   its `expiresAt` with `endedAt` still null (Pin A).
 * - NEVER_BOUND: no undeleted Session row (Pin B). Soft-deleted sessions count
 *   for nothing, as in the bind gate and `Worker.lastActiveAt` (gate amendment
 *   on the issue, after chat #60698).
 *
 * Acceptance 2 is the differential: "has a reason" equals "no open undeleted
 * session is live by `isSessionLive`", read the way startSession's WORKER_TAKEN
 * gate reads it (cor:agt:020:11, one computation).
 *
 * Every timestamp is relative to the real now, since the surfaces read the clock.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { ensureChannelWithRoot } from '../../../lib/channels.js';
import { isSessionLive, loadLastEventBySession } from '../../../lib/sessionActivity.js';
import { loadNoSessionReasons } from '../../../lib/workerCheckStatus.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
import type { AuthContext } from '../../../middleware/auth.js';
import { createTestableMcpServer } from '../../../mcp/server.js';

vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const Q = resolvers.Query as any;
const F = resolvers as any;
const MIN = 60_000;
const HOUR = 60 * MIN;
const ago = (ms: number) => new Date(Date.now() - ms);
const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] }) as Context;

let org: { id: string; urn: string };
let member: { id: string };
let outsider: { id: string };
let app: { id: string; urn: string };
let agent: { id: string };
const w: Record<string, { id: string }> = {};

async function mkUser(n: number) {
  return db.user.create({
    data: { id: generateId(), githubId: 93_077_00 + n, githubUsername: `nsr-${n}-${Date.now()}-${Math.floor(Math.random() * 1e5)}`, roles: ['READER'] },
    select: { id: true },
  });
}

type Shape = {
  type?: 'DEVELOPER' | 'CHATBOT' | 'AUTOMATION' | 'EDGE';
  /** A usage event on the session; `counts: false` is attribution, not activity (#1653). */
  event?: { at: Date; counts: boolean };
  startedAt: Date;
  updatedAt?: Date | null;
  endedAt?: Date | null;
  expiresAt?: Date | null;
  autoExpiredAt?: Date | null;
  deletedAt?: Date | null;
};

/**
 * One worker per scenario, each with the sessions that make it. The expected
 * reason is the gate's classification; `null` means the worker is not
 * NO_SESSION (a live session), so it has no reason.
 */
const SCENARIOS: Record<string, { sessions: Shape[]; reason: 'IDLE' | 'ENDED' | 'NEVER_BOUND' | null }> = {
  // Open, undeleted, driven 26h ago: outside the 24h DEVELOPER window.
  Idle: { sessions: [{ startedAt: ago(30 * HOUR), updatedAt: ago(26 * HOUR) }], reason: 'IDLE' },
  // Ended by endSession.
  Ended: { sessions: [{ startedAt: ago(3 * HOUR), updatedAt: ago(2 * HOUR), endedAt: ago(2 * HOUR) }], reason: 'ENDED' },
  // Pin A (Victor): the promised expiry has passed but the reaper has not
  // stamped endedAt. Freshly driven, so `bound && !live` would call it idle.
  Expired: { sessions: [{ startedAt: ago(10 * MIN), updatedAt: ago(1 * MIN), expiresAt: ago(30_000) }], reason: 'ENDED' },
  // Pin A variant: idle AND past its expiry still reads ENDED (expiry wins).
  ExpiredIdle: { sessions: [{ startedAt: ago(30 * HOUR), updatedAt: ago(26 * HOUR), expiresAt: ago(HOUR) }], reason: 'ENDED' },
  // Gate amendment: a soft-deleted session counts for nothing, even an open fresh one.
  Deleted: { sessions: [{ startedAt: ago(10 * MIN), updatedAt: ago(1 * MIN), deletedAt: ago(1 * MIN) }], reason: 'NEVER_BOUND' },
  // Gate amendment: every session soft-deleted (an ended one and an idle open one) reads NEVER_BOUND.
  AllDeleted: {
    sessions: [
      { startedAt: ago(50 * HOUR), updatedAt: ago(48 * HOUR), endedAt: ago(48 * HOUR), deletedAt: ago(HOUR) },
      { startedAt: ago(30 * HOUR), updatedAt: ago(26 * HOUR), deletedAt: ago(HOUR) },
    ],
    reason: 'NEVER_BOUND',
  },
  // Gate item 3: a pre-#1114 reaped row (autoExpiredAt + endedAt).
  Reaped: { sessions: [{ startedAt: ago(40 * HOUR), updatedAt: ago(30 * HOUR), endedAt: ago(30 * HOUR), autoExpiredAt: ago(30 * HOUR) }], reason: 'ENDED' },
  // Gate item 3: auto-expired with endedAt left null, and stale, counts as ended, never idle.
  AutoExpiredOpen: { sessions: [{ startedAt: ago(40 * HOUR), updatedAt: ago(30 * HOUR), autoExpiredAt: ago(30 * HOUR) }], reason: 'ENDED' },
  // Several sessions: an idle open one beats an ended one.
  IdleAndEnded: {
    sessions: [
      { startedAt: ago(50 * HOUR), updatedAt: ago(48 * HOUR), endedAt: ago(48 * HOUR) },
      { startedAt: ago(30 * HOUR), updatedAt: ago(26 * HOUR) },
    ],
    reason: 'IDLE',
  },
  // A deleted open session does not make an ended worker idle.
  EndedAndDeletedIdle: {
    sessions: [
      { startedAt: ago(5 * HOUR), updatedAt: ago(4 * HOUR), endedAt: ago(4 * HOUR) },
      { startedAt: ago(30 * HOUR), updatedAt: ago(26 * HOUR), deletedAt: ago(HOUR) },
    ],
    reason: 'ENDED',
  },
  // Never bound.
  Never: { sessions: [], reason: 'NEVER_BOUND' },
  // Live (driven a minute ago), beside an old ended session: no reason.
  Live: {
    sessions: [
      { startedAt: ago(50 * HOUR), updatedAt: ago(48 * HOUR), endedAt: ago(48 * HOUR) },
      { startedAt: ago(60 * MIN), updatedAt: ago(1 * MIN) },
    ],
    reason: null,
  },
  // Joost P3: liveness through a usage event. Stale row, recent counting event: live, no reason.
  LiveByEvent: { sessions: [{ startedAt: ago(30 * HOUR), updatedAt: ago(26 * HOUR), event: { at: ago(1 * MIN), counts: true } }], reason: null },
  // Same, but the event is attribution only (#1653): not live, so IDLE.
  IdleDespiteAttribution: { sessions: [{ startedAt: ago(30 * HOUR), updatedAt: ago(26 * HOUR), event: { at: ago(1 * MIN), counts: false } }], reason: 'IDLE' },
  // Joost P3: another session type's window. AUTOMATION, driven 26h ago: outside the default 24h window, IDLE.
  IdleAutomation: { sessions: [{ type: 'AUTOMATION', startedAt: ago(30 * HOUR), updatedAt: ago(26 * HOUR) }], reason: 'IDLE' },
  // AUTOMATION driven an hour ago: live, no reason.
  LiveAutomation: { sessions: [{ type: 'AUTOMATION', startedAt: ago(2 * HOUR), updatedAt: ago(HOUR) }], reason: null },
  // Live with a future expiry: no reason.
  LiveExpiring: { sessions: [{ startedAt: ago(60 * MIN), updatedAt: ago(1 * MIN), expiresAt: new Date(Date.now() + HOUR) }], reason: null },
};

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({ data: { id: generateId(), name: 'nsr-org', urn: `nsr-${suffix}.com` } });
  member = await mkUser(1);
  outsider = await mkUser(2);
  agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'Engineer', urn: `${org.urn}:engineer`, visibility: 'ORGANIZATION' } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  await db.appMember.create({ data: { appId: app.id, userId: member.id, role: 'member' } });
  const memory = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:team-shared`, name: 'shared', class: 'app', appId: app.id, sharedMemoryOfAgentId: agent.id },
  });
  await ensureChannelWithRoot(db, { memoryId: memory.id, loc: 'chats:team', name: 'team', createdBy: member.id, asDefaultOfAppId: app.id });
  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    w[name] = await db.worker.create({
      data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name, slug: name.toLowerCase(), role: 'engineer', heldByUserId: member.id },
      select: { id: true },
    });
    for (const { event, ...s } of scenario.sessions) {
      const id = generateId();
      await db.session.create({
        data: { id, appId: app.id, userId: member.id, workerId: w[name].id, agentId: agent.id, type: 'DEVELOPER', ...s },
      });
      if (event) await db.usageEvent.create({ data: { id: generateId(), sessionId: id, type: 'read', createdAt: event.at, countsAsActivity: event.counts } });
    }
  }
});

async function workerStatus(name: string, userId = member.id) {
  const worker = await Q.worker({}, { ref: w[name].id }, ctx(userId));
  return F.Worker.checkStatus(worker, {}, ctx(userId));
}
async function rosterStatuses(userId = member.id) {
  const r = await Q.teamRoster({}, { appRef: app.id }, ctx(userId));
  const out = new Map<string, any>();
  for (const e of r.workers) out.set(e.name, await F.TeamRosterEntry.checkStatus(e, {}, ctx(userId)));
  return out;
}

/** Liveness exactly as startSession's WORKER_TAKEN gate reads it: open, undeleted rows through isSessionLive. */
async function takenByGate(workerId: string): Promise<boolean> {
  const open = await db.session.findMany({
    where: { workerId, endedAt: null, deletedAt: null },
    select: { id: true, startedAt: true, updatedAt: true, type: true, autoExpiredAt: true, endedAt: true, expiresAt: true },
  });
  const events = await loadLastEventBySession(db as never, open.map((s) => s.id));
  const now = new Date();
  return open.some((s) => isSessionLive(s, events.get(s.id), now));
}

describe('acceptance 1: each fixture yields its reason, on worker get and on the roster', () => {
  it.each(Object.entries(SCENARIOS))('%s', async (name, scenario) => {
    const single = await workerStatus(name);
    const roster = (await rosterStatuses()).get(name);
    for (const s of [single, roster]) {
      expect(s, `${name}: checkStatus must be readable by an App member`).not.toBeNull();
      expect(s.noSessionReason ?? null, `${name}: wrong noSessionReason`).toBe(scenario.reason);
      if (scenario.reason) expect(s.status).toBe('NO_SESSION');
      else expect(s.status).not.toBe('NO_SESSION');
    }
  });

  it('PENDING, OK and OVERDUE carry no reason', async () => {
    // Live is PENDING NO_TASK (no task). Assign one and it is OK; then let the clock run out and it is OVERDUE.
    expect(await workerStatus('Live')).toMatchObject({ status: 'PENDING', pendingReason: 'NO_TASK', noSessionReason: null });
    await db.agentTask.create({ data: { appId: app.id, title: 'T', ownerUserId: member.id, assigneeWorkerId: w.Live.id, assignedAt: ago(2 * MIN) } });
    expect(await workerStatus('Live')).toMatchObject({ status: 'OK', noSessionReason: null });
    await db.agentTask.updateMany({ where: { assigneeWorkerId: w.Live.id }, data: { assignedAt: ago(3 * HOUR) } });
    await db.session.updateMany({ where: { workerId: w.Live.id, endedAt: null }, data: { startedAt: ago(3 * HOUR) } });
    expect(await workerStatus('Live')).toMatchObject({ status: 'OVERDUE', noSessionReason: null });
  });
});

describe('acceptance 2: the differential — has a reason exactly when the WORKER_TAKEN gate finds no live session', () => {
  it('holds for every fixture', async () => {
    const roster = await rosterStatuses();
    for (const name of Object.keys(SCENARIOS)) {
      const taken = await takenByGate(w[name].id);
      const single = await workerStatus(name);
      expect(single.noSessionReason !== null, `${name}: worker get reason vs !isSessionLive`).toBe(!taken);
      expect(roster.get(name).noSessionReason !== null, `${name}: roster reason vs !isSessionLive`).toBe(!taken);
    }
  });

  it('Pin B: NEVER_BOUND exactly when the worker has no undeleted Session row, i.e. exactly when Worker.lastActiveAt is null', async () => {
    for (const name of Object.keys(SCENARIOS)) {
      const rows = await db.session.count({ where: { workerId: w[name].id, deletedAt: null } });
      const neverBound = (await workerStatus(name)).noSessionReason === 'NEVER_BOUND';
      expect(neverBound, `${name}: vs undeleted rows`).toBe(rows === 0);
      const worker = await Q.worker({}, { ref: w[name].id }, ctx(member.id));
      expect(neverBound, `${name}: vs lastActiveAt`).toBe((await F.Worker.lastActiveAt(worker, {}, ctx(member.id))) === null);
    }
  });
});

describe('the expiry boundary, on a controlled clock (R5, cor:agt:020:03)', () => {
  it('expiresAt exactly now has ended the session: ENDED, as isSessionLive says not live; one ms earlier it is IDLE', async () => {
    const at = new Date(Date.now() - 2 * HOUR);
    const row = { type: 'DEVELOPER' as const, startedAt: new Date(at.getTime() - 30 * HOUR), updatedAt: new Date(at.getTime() - 26 * HOUR), expiresAt: at };
    await db.session.create({ data: { id: generateId(), appId: app.id, userId: member.id, workerId: w.Never.id, agentId: agent.id, ...row } });
    expect(isSessionLive(row, null, at)).toBe(false);
    expect((await loadNoSessionReasons(db, [w.Never.id], at)).get(w.Never.id)).toBe('ENDED');
    const before = new Date(at.getTime() - 1);
    expect(isSessionLive(row, null, before)).toBe(false); // idle, not yet expired
    expect((await loadNoSessionReasons(db, [w.Never.id], before)).get(w.Never.id)).toBe('IDLE');
  });
});

describe('acceptance 3: GraphQL and MCP give the same reason', () => {
  const authOf = (userId: string) => ({ userId, appId: app.id, roles: ['READER'], clientId: `user:${userId}` }) as AuthContext;
  const mcp = (userId = member.id) =>
    createTestableMcpServer(authOf(userId), { sessionId: `nsr-${generateId()}`, cachedAppResolution: { kind: 'multi-app' } });
  const words = (r: string) => r.toLowerCase().replace(/_/g, ' ');

  it('hadron_get_worker shows the reason in the long form, as it shows a PENDING reason', async () => {
    for (const name of ['Idle', 'Ended', 'Expired', 'Never']) {
      const reason = (await workerStatus(name)).noSessionReason as string;
      const out = await mcp().callToolText('hadron_get_worker', { workerRef: w[name].id });
      expect(out, name).toContain(`Check status: NO_SESSION (${words(reason)}; never checked)`);
    }
  });

  it('hadron_team_roster shows the short form check NO_SESSION (<reason>)', async () => {
    const out = (await mcp().callTool('hadron_team_roster', { appRef: app.id })).content[0].text;
    expect(out).toMatch(/Idle — [A-Z_]+: [^\n]*check NO_SESSION \(idle\)/);
    expect(out).toMatch(/Ended — [A-Z_]+: [^\n]*check NO_SESSION \(ended\)/);
    expect(out).toMatch(/Never — [A-Z_]+: [^\n]*check NO_SESSION \(never bound\)/);
    expect(out).toMatch(/Live — [A-Z_]+: [^\n]*check PENDING \(no task\)/);
  });
});

describe('acceptance 4: the reason discloses nothing new', () => {
  it('a caller who cannot read checkStatus gets null, never NEVER_BOUND (cor:agt:020:11 rule 5)', async () => {
    for (const name of ['Idle', 'Ended', 'Never']) {
      const worker = await db.worker.findUniqueOrThrow({ where: { id: w[name].id } });
      expect(await F.Worker.checkStatus(worker, {}, ctx(outsider.id)), name).toBeNull();
    }
  });

  // Riana §10 P3-1: hadron_get_worker serves the profile tier to any signed-in
  // user who names the worker, so its check status must come through the
  // masked resolver. A stranger (no membership, no App binding) sees the
  // worker but no check status and no reason.
  it('hadron_get_worker to a stranger shows the worker but no check status or reason', async () => {
    const strangerAuth = { userId: outsider.id, roles: ['READER'], clientId: `user:${outsider.id}` } as AuthContext;
    for (const name of ['Idle', 'Ended', 'Never']) {
      const server = createTestableMcpServer(strangerAuth, { sessionId: `nsr-${generateId()}`, cachedAppResolution: { kind: 'multi-app' } });
      const out = await server.callToolText('hadron_get_worker', { workerRef: w[name].id });
      expect(out, `${name}: the stranger must still get the profile, or this pin proves nothing`).toContain(w[name].id);
      expect(out, name).not.toMatch(/Check status|NO_SESSION|never bound|never checked/);
    }
  });

  it('the SDL adds only the closed reason enum: no session id or timestamp', () => {
    const block = /type WorkerCheckStatus \{([\s\S]*?)\n  \}/.exec(typeDefs)?.[1] ?? '';
    const fields = [...block.matchAll(/^\s+(\w+):/gm)].map((m) => m[1]);
    expect(fields).toEqual(['status', 'pendingReason', 'noSessionReason', 'lastCheckedAt']);
    expect(block).toMatch(/noSessionReason: WorkerNoSessionReason\n/);
    const en = /enum WorkerNoSessionReason \{([\s\S]*?)\n  \}/.exec(typeDefs)?.[1] ?? '';
    expect([...en.matchAll(/^\s+([A-Z_]+)$/gm)].map((m) => m[1])).toEqual(['IDLE', 'ENDED', 'NEVER_BOUND']);
  });
});
