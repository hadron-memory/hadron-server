/**
 * #4301 (follow-up to #4291; cor:agt:050:01, Proposed) — a task's applied run settings are those of the run the task
 * is on NOW. A reassignment of a STARTED task restamps them from the new assignee's newest open session, or clears
 * them when it has none or the assignee is a person; a bind fills a stamp that is empty and never overwrites one that
 * is set. On main a reassigned started task keeps the values of the worker that started it.
 *
 * Fixtures as in resolvers.runSettings4291.test.ts: Bo holds Kit (LONG_LIVED, coordinator) and Sam (SHORT_LIVED,
 * builder); orca1 registers both as claude.
 */


import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { lockWorkersForAssignment } from '../../../lib/agentTasks/workerLock.js';
import { matchQueuedTasks } from '../../../lib/agentTasks/matcher.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { serveEveryAgent } from '../../../test/servedBootPrompt.js';
import { resolvers, type Context } from './resolvers.js';
import { joinHostForKey } from '../../../test/agentTeamHost.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
const T = (resolvers as any).AgentTask;
const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] }) as Context;
const keyCtx = (k: { id: string }): Context => ({ db, appId: app.id, appKeyId: k.id, roles: [] }) as Context;

let org: { id: string; urn: string };
let admin: { id: string };
let bo: { id: string };
let app: { id: string };
let kit: { id: string };
let sam: { id: string };
let longAgent: string;
let shortAgent: string;
let orca1: { id: string };

type Record3 = { family: string | null; model: string | null; effort: string | null };
const setRecord = (w: { id: string }, r: Partial<Record3>) =>
  db.worker.update({ where: { id: w.id }, data: { lastUsedFamily: r.family ?? null, lastUsedModel: r.model ?? null, lastUsedEffort: (r.effort ?? null) as never } });
const recordOf = async (w: { id: string }): Promise<Record3> => {
  const r = await db.worker.findUniqueOrThrow({ where: { id: w.id } }) as any;
  return { family: r.lastUsedFamily, model: r.lastUsedModel, effort: r.lastUsedEffort };
};
const starts = (w: { id: string }) => db.hostOperation.findMany({ where: { workerId: w.id, type: 'worker.start' }, orderBy: { issuedAt: 'asc' } });
const startArgs = async (w: { id: string }) => (await starts(w)).map((o) => o.args as Record<string, string>);
const match = () => matchQueuedTasks(db, new Date(), { appId: app.id });
const assigneeOf = async (id: string) => (await db.agentTask.findUniqueOrThrow({ where: { id }, select: { assigneeWorkerId: true } })).assigneeWorkerId;

/** A queued task for a builder (Sam's role) or, with `role`, another role; `runSettings` and `requirements` as given. */
const queue = (runSettings: Record<string, unknown> | null, requirements: Record<string, unknown> = {}, role = 'builder') =>
  M.createAgentTask({}, { input: { appRef: app.id, title: 'Build', requirements: { role, ...requirements }, ...(runSettings ? { runSettings } : {}) } }, ctx(admin.id));
/** A task assigned by hand to `w`. */
const assignTo = (w: { id: string }, runSettings: Record<string, unknown> | null = null) =>
  M.createAgentTask({}, { input: { appRef: app.id, title: 'Build', assignee: { worker: w.id }, ...(runSettings ? { runSettings } : {}) } }, ctx(admin.id));

/** The host collects its operations and the holder binds with the grant, sending NO family, model or effort. */
async function bindFromStart(w: { id: string }, extra: Record<string, unknown> = {}) {
  const [op] = await starts(w);
  const got = (await M.collectHostOperations({}, { appRef: app.id }, keyCtx(orca1)) as Array<{ id: string; launchGrant: string | null }>).find((o) => o.id === op!.id);
  return M.startSession({}, { input: { id: generateId(), tool: 'claude-code', launchGrant: got!.launchGrant, ...extra } }, ctx(bo.id));
}
/** Bo binds `w` by name, with no host involved. */
const bind = (w: { id: string }, extra: Record<string, unknown> = {}) =>
  M.startSession({}, { input: { id: generateId(), appRef: app.id, workerRef: w.id, tool: 'claude-code', ...extra } }, ctx(bo.id));
const rosterRow = async (w: { id: string }) =>
  ((await Q.teamRoster({}, { appRef: app.id }, ctx(admin.id))).workers as any[]).find((r) => r.workerId === w.id);

beforeEach(async () => {
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1_000_000);
  org = await db.organization.create({ data: { id: generateId(), name: 'S14', urn: `s14-4291-${n}.example` }, select: { id: true, urn: true } });
  const u = (k: number, name: string) =>
    db.user.create({ data: { id: generateId(), githubId: 42_910_000 + k * 1000 + (n % 1000), githubUsername: `s14-${name}-${n}`, roles: ['READER'] }, select: { id: true } });
  admin = await u(1, 'admin');
  bo = await u(2, 'bo');
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  longAgent = (await M.createAgent({}, { orgRef: org.id, name: 'Coordinator' }, ctx(admin.id))).id;
  shortAgent = (await M.createAgent({}, { orgRef: org.id, name: 'Builder', lifecycle: 'SHORT_LIVED' }, ctx(admin.id))).id;
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` }, select: { id: true } });
  await db.appMember.create({ data: { appId: app.id, userId: bo.id, role: 'member' } });
  const w = (agentId: string, name: string, role: string) =>
    db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId, name, slug: name.toLowerCase(), role, heldByUserId: bo.id, heldAt: new Date() }, select: { id: true } });
  kit = await w(longAgent, 'Kit', 'coordinator');
  sam = await w(shortAgent, 'Sam', 'builder');
  orca1 = await db.appKey.create({ data: { id: generateId(), appId: app.id, keyHash: `h-${generateId()}`, keyPreview: 'abcd', label: 'orca1' }, select: { id: true } });
  await joinHostForKey(db, orca1.id, 'orca1');
  await M.grantAppKeyScope({}, { id: orca1.id, scope: 'host:operate', hostId: 'orca1' }, ctx(admin.id));
  await M.registerHost({}, { input: { appRef: app.id, label: 'Orca 1', pollIntervalSeconds: 600, workers: [
    { worker: kit.id, family: 'claude', worktrees: ['hadron-server/kit'] },
    { worker: sam.id, family: 'claude', worktrees: ['hadron-server/sam'] },
  ] } }, keyCtx(orca1));
  await serveEveryAgent(db); // #2712: binds are served the Agent's boot prompt
});

describe('#4301: a started task shows the settings of the run it is on now', () => {
  const CLAUDE = { family: 'claude', model: 'claude-sonnet-5-5', effort: 'LOW' };
  const CODEX = { family: 'codex', model: 'gpt-6.1', effort: 'HIGH' };
  const bindAs = (w: { id: string }, r: typeof CLAUDE) => bind(w, { family: r.family, llmModel: r.model, effort: r.effort });
  const row = (id: string) => db.agentTask.findUniqueOrThrow({ where: { id } });
  const applied = async (id: string) => T.appliedRunSettings(await row(id));
  const stored = async (id: string) => {
    const r = await row(id) as any;
    return { family: r.appliedFamily, model: r.appliedModel, effort: r.appliedEffort };
  };
  const NONE = { family: null, model: null, effort: null };
  const reassign = (id: string, assignee: Record<string, string>) => M.reassignAgentTask({}, { taskRef: id, assignee }, ctx(admin.id));
  /** Kit, bound as claude, holds a task it has started. */
  async function startedByKit() {
    const s = await bindAs(kit, CLAUDE);
    const t = await assignTo(kit);
    await runAsActor({ workerId: kit.id, agentId: longAgent }, () => M.startAgentTask({}, { taskRef: t.id }, { ...ctx(bo.id), sessionId: s.id } as Context));
    expect(await applied(t.id)).toEqual(CLAUDE);
    return { t, s };
  }

  it('reassigned to a worker bound as codex: the read shows that session\'s family, model and effort', async () => {
    const { t } = await startedByKit();
    await bindAs(sam, CODEX);
    await reassign(t.id, { worker: sam.id });
    expect((await row(t.id)).status).toBe('started');
    expect(await applied(t.id)).toEqual(CODEX);
  });

  it('reassigned to a worker with no open session: nothing is shown, and nothing of the starter is kept', async () => {
    const { t } = await startedByKit();
    await reassign(t.id, { worker: sam.id });
    expect(await stored(t.id)).toEqual(NONE);
    expect(await applied(t.id)).toBeNull();
  });

  it('reassigned to a person: nothing is shown', async () => {
    const { t } = await startedByKit();
    await reassign(t.id, { user: bo.id });
    expect(await stored(t.id)).toEqual(NONE);
    expect(await applied(t.id)).toBeNull();
  });

  it('the unbound new assignee then binds as codex: the bind fills the empty stamp', async () => {
    const { t } = await startedByKit();
    await reassign(t.id, { worker: sam.id });
    await bindAs(sam, CODEX);
    expect(await applied(t.id)).toEqual(CODEX);
  });

  it('a bind never overwrites a stamp: the assignee ends its session and binds again as another model', async () => {
    const { t, s } = await startedByKit();
    await M.endSession({}, { id: s.id }, ctx(bo.id));
    await bindAs(kit, CODEX);
    expect((await row(t.id)).status).toBe('started');
    expect(await applied(t.id)).toEqual(CLAUDE);
  });

  // #4309 (1): the fill reads the three applied values as ONE set, so a stamp holding any one of them is not empty.
  it.each([
    ['family', { appliedFamily: 'claude' }, { family: 'claude', model: null, effort: null }],
    ['model', { appliedModel: 'claude-sonnet-5-5' }, { family: null, model: 'claude-sonnet-5-5', effort: null }],
    ['effort', { appliedEffort: 'LOW' }, { family: null, model: null, effort: 'LOW' }],
    ['family and effort', { appliedFamily: 'claude', appliedEffort: 'LOW' }, { family: 'claude', model: null, effort: 'LOW' }],
    ['family and model', { appliedFamily: 'claude', appliedModel: 'claude-sonnet-5-5' }, { family: 'claude', model: 'claude-sonnet-5-5', effort: null }],
    ['model and effort', { appliedModel: 'claude-sonnet-5-5', appliedEffort: 'LOW' }, { family: null, model: 'claude-sonnet-5-5', effort: 'LOW' }],
  ])('a partial stamp (%s set) is kept as it was by a later bind of the assignee', async (_name, partial, expected) => {
    const { t, s } = await startedByKit();
    await db.agentTask.update({ where: { id: t.id }, data: { appliedFamily: null, appliedModel: null, appliedEffort: null, ...partial } as never });
    expect(await stored(t.id)).toEqual(expected);
    await M.endSession({}, { id: s.id }, ctx(bo.id));
    await bindAs(kit, CODEX);
    expect((await row(t.id)).status).toBe('started');
    expect(await stored(t.id)).toEqual(expected);
  });

  // #4309 (2): both take the destination worker's per-worker lock first. A gate transaction holds that lock while the
  // first operation starts and is seen waiting on it, then the second starts and is seen waiting too, then the gate
  // releases: contention is real every round and the lock queue fixes the order, so each order runs three times.
  /** Waiters on exactly this worker's lock key, the two-integer form (objsubid 2); the worker id is fresh per test in a private clone database, so only the gate and the two racers can queue on it (workerLock.ts: classid hashtext('agent-task-matcher:worker'), objid hashtext(id)). */
  const waitingOnWorkerLock = async (w: { id: string }) =>
    Number((await db.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM pg_locks
      WHERE locktype = 'advisory' AND objsubid = 2 AND NOT granted
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND classid::bigint = (hashtext('agent-task-matcher:worker')::bigint & 4294967295)
        AND objid::bigint = (hashtext(${w.id})::bigint & 4294967295)`)[0]!.n);
  const waitUntilWaiting = async (w: { id: string }, n: number) => {
    for (let k = 0; k < 400 && (await waitingOnWorkerLock(w)) < n; k++) await new Promise((r) => setTimeout(r, 25));
    expect(await waitingOnWorkerLock(w)).toBe(n);
  };
  async function raceBehindWorkerLock(w: { id: string }, first: () => Promise<unknown>, second: () => Promise<unknown>) {
    let release!: () => void;
    let held!: () => void;
    let heldFailed!: (e: unknown) => void;
    const heldP = new Promise<void>((res, rej) => { held = res; heldFailed = rej; });
    const gate = db.$transaction(async (tx) => {
      await lockWorkersForAssignment(tx as never, [w.id]);
      held();
      await new Promise<void>((r) => { release = r; });
    }, { timeout: 30_000, maxWait: 30_000 });
    gate.catch((e) => heldFailed(e)); // a gate that fails before holding the lock reaches the readiness wait
    const started: Array<Promise<unknown>> = [gate];
    // Each racer's rejection is observed at once, so none is left unhandled while the polling runs.
    const run = (f: () => Promise<unknown>) => { const pr = f(); pr.catch(() => undefined); started.push(pr); };
    let failure: unknown;
    let failed = false;
    try {
      await heldP;
      run(first);
      await waitUntilWaiting(w, 1);
      run(second);
      await waitUntilWaiting(w, 2);
    } catch (e) {
      failure = e;
      failed = true;
    } finally {
      release?.(); // always let the gate go, then drain everything that started
      const settled = await Promise.allSettled(started);
      if (!failed) for (const r of settled) if (r.status === 'rejected') { failure = r.reason; failed = true; break; }
    }
    if (failed) throw failure;
  }

  it.each([['bind', 'reassignment'], ['reassignment', 'bind']])(
    'a concurrent %s then %s on one destination worker, queued on its lock: no deadlock, the task ends stamped with the destination session\'s settings',
    async (firstOp) => {
      const s = await bindAs(kit, CLAUDE);
      for (let i = 0; i < 3; i++) {
        const t = await assignTo(kit);
        await runAsActor({ workerId: kit.id, agentId: longAgent }, () => M.startAgentTask({}, { taskRef: t.id }, { ...ctx(bo.id), sessionId: s.id } as Context));
        expect((await row(t.id)).status).toBe('started');
        const open = await db.session.findMany({ where: { workerId: sam.id, endedAt: null } });
        for (const o of open) await M.endSession({}, { id: o.id }, ctx(bo.id));
        const doBind = () => bindAs(sam, CODEX);
        const doReassign = () => reassign(t.id, { worker: sam.id });
        await (firstOp === 'bind' ? raceBehindWorkerLock(sam, doBind, doReassign) : raceBehindWorkerLock(sam, doReassign, doBind));
        expect(await assigneeOf(t.id)).toBe(sam.id);
        expect(await applied(t.id)).toEqual(CODEX);
      }
    }, 60_000);

  it('a bind fills only its own worker\'s STARTED tasks: not a pending one, another assignee\'s, or an ended one', async () => {
    const { t } = await startedByKit();
    await reassign(t.id, { worker: sam.id }); // Sam's, started, empty stamp
    const pending = await assignTo(sam);
    const other = await assignTo(kit);
    const ended = await assignTo(sam);
    await db.agentTask.update({ where: { id: other.id }, data: { status: 'started', startedAt: new Date() } }); // Kit's, started, empty
    await db.agentTask.update({ where: { id: ended.id }, data: { status: 'cancelled', startedAt: new Date(), cancelledAt: new Date() } });
    await bindAs(sam, CODEX);
    expect(await stored(t.id)).toEqual(CODEX);
    expect(await stored(pending.id)).toEqual(NONE);
    expect(await stored(other.id)).toEqual(NONE);
    expect(await stored(ended.id)).toEqual(NONE);
  });

  it('a reassignment of a PENDING task stamps nothing (green on main: guards the status check)', async () => {
    await bindAs(sam, CODEX);
    const t = await assignTo(kit);
    await reassign(t.id, { worker: sam.id });
    expect((await row(t.id)).status).toBe('pending');
    expect(await stored(t.id)).toEqual(NONE);
  });
});
