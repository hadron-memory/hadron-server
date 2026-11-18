import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { observeTransactionBackend, waitForAdvisoryWaiter } from '../../../test/advisoryWaiter.js';
/**
 * #1726 — a Worker records who it reports to (Task Management, #1704).
 *
 * The field's shape (same App, not itself, not retired, no cycle), who may
 * change it, its history as team events, retirement, the reads and the
 * roster. A worker acts through its session: `runAsActor` reproduces the
 * binding the auth middleware publishes (#1610), as in the task tests.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { serveEveryAgent } from '../../../test/servedBootPrompt.js';
import { generateId } from '../../../lib/id.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { reportsToChain, writeReportsTo } from '../../../lib/workerReportsTo.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
const F = resolvers as any;

const ctx = (userId?: string, extra: Partial<Context> = {}): Context => ({ db, userId, roles: ['READER'], ...extra });

async function codeOf(p: Promise<unknown>): Promise<string> {
  try { await p; return 'NO_ERROR'; } catch (e) {
    return e instanceof GraphQLError ? String(e.extensions?.code) : (e as Error).message;
  }
}

let org: { id: string; urn: string };
let admin: { id: string };
let member: { id: string };
let appOwnerMember: { id: string };
let teamAgent: { id: string };
let app: { id: string; urn: string };
let otherApp: { id: string; urn: string };
let ada: { id: string };
let marco: { id: string };
let dan: { id: string };
let liam: { id: string };
let zed: { id: string };
let old: { id: string };

/** Run `fn` as `worker` acting through its session, with `member` (a person) behind the request. */
const asWorker = (worker: { id: string }, fn: () => Promise<any>): Promise<any> =>
  runAsActor({ workerId: worker.id, agentId: teamAgent.id }, fn);
const set = (c: Context, workerRef: string, reportsTo: string | null) => M.setWorkerReportsTo({}, { workerRef, reportsTo }, c);
const reportsToOf = async (w: { id: string }) =>
  (await db.worker.findUniqueOrThrow({ where: { id: w.id }, select: { reportsToWorkerId: true } })).reportsToWorkerId;
const events = (w: { id: string }) =>
  db.agentTeamEvent.findMany({ where: { type: 'worker.reports-to', subjectWorkerId: w.id }, orderBy: { createdAt: 'asc' } });

async function user(n: number) {
  return db.user.create({ data: { id: generateId(), githubId: 98_000 + n, githubUsername: `rt-${n}`, roles: ['READER'] }, select: { id: true } });
}
async function worker(appId: string, name: string, extra: Record<string, unknown> = {}) {
  return db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId, agentId: teamAgent.id, name, slug: name.toLowerCase(), ...extra }, select: { id: true } });
}

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'rt-org', urn: 'rt-org.com' } });
  admin = await user(1);
  member = await user(2);
  appOwnerMember = await user(3);
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  teamAgent = { id: (await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(admin.id))).id };
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  otherApp = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Other', urn: `${org.urn}:other` } });
  await db.appMember.create({ data: { appId: app.id, userId: member.id, role: 'member' } });
  await db.appMember.create({ data: { appId: app.id, userId: appOwnerMember.id, role: 'owner' } });
  ada = await worker(app.id, 'Ada');
  marco = await worker(app.id, 'Marco');
  dan = await worker(app.id, 'Dan');
  liam = await worker(app.id, 'Liam');
  zed = await worker(otherApp.id, 'Zed');
  old = await worker(app.id, 'Old', { retiredAt: new Date() });
  await serveEveryAgent(db); // #2712: binds need a served prompt
});

describe('the value: same App, not itself, not retired, no cycle', () => {
  it('whoever manages the App sets it, and each change is one team event with ids and a setter word', async () => {
    await set(ctx(admin.id), dan.id, ada.id);
    expect(await reportsToOf(dan)).toBe(ada.id);
    // Setting the current value changes nothing and records nothing.
    await set(ctx(admin.id), dan.id, ada.id);
    await set(ctx(appOwnerMember.id), dan.id, null);
    expect(await reportsToOf(dan)).toBeNull();
    expect((await events(dan)).map((e) => e.payload)).toEqual([
      { from: null, to: ada.id, setBy: 'app-manager' },
      { from: ada.id, to: null, setBy: 'app-manager', oldExplicitNoTeam: false, newExplicitNoTeam: true },
    ]);
  });

  it('refuses itself, another App, a retired worker and a cycle, and writes nothing', async () => {
    expect(await codeOf(set(ctx(admin.id), dan.id, dan.id))).toBe('WORKER_REPORTS_TO_SELF');
    // Another App's worker is resolved only within this App, so it reads as missing (Chip's P2 on #1737).
    expect(await codeOf(set(ctx(admin.id), dan.id, zed.id))).toBe('WORKER_NOT_FOUND');
    expect(await codeOf(set(ctx(admin.id), dan.id, old.id))).toBe('WORKER_REPORTS_TO_RETIRED');
    await set(ctx(admin.id), liam.id, dan.id);
    await set(ctx(admin.id), dan.id, ada.id);
    // Ada → Liam → Dan → Ada would loop.
    expect(await codeOf(set(ctx(admin.id), ada.id, liam.id))).toBe('WORKER_REPORTS_TO_CYCLE');
    expect(await reportsToOf(ada)).toBeNull();
    expect(await reportsToChain(db, liam.id)).toEqual([dan.id, ada.id]);
    expect(await codeOf(set(ctx(admin.id), old.id, ada.id))).toBe('WORKER_RETIRED');
  });

  it('two concurrent changes on disjoint workers cannot close a loop between them', async () => {
    // Ada → Marco and Dan → Liam exist. Marco → Dan and Liam → Ada lock disjoint
    // rows ({Marco, Dan} and {Liam, Ada}), so only the per-App lock stops each
    // passing its cycle check against the other's uncommitted half of the loop.
    await set(ctx(admin.id), ada.id, marco.id);
    await set(ctx(admin.id), dan.id, liam.id);
    const by = { userId: admin.id, workerId: null, agentId: null };
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let wrote!: () => void;
    const firstWrote = new Promise<void>((r) => { wrote = r; });
    const first = db.$transaction(async (tx) => {
      await writeReportsTo(tx, { workerId: marco.id, to: dan.id, actor: by, setBy: 'app-manager' });
      wrote();
      await held;
    }, { timeout: 20_000 });
    await firstWrote;
    const second = db.$transaction((tx) => writeReportsTo(tx, { workerId: liam.id, to: ada.id, actor: by, setBy: 'app-manager' }));
    await new Promise((r) => setTimeout(r, 200));
    release();
    await first;
    expect(await codeOf(second)).toBe('WORKER_REPORTS_TO_CYCLE');
    expect(await reportsToOf(liam)).toBeNull();
  });
});

describe('who may change it (#1726; Dan #7909, as recommended; claims narrowed by Ada #7981)', () => {
  const hold = (by: { id: string }, ...ws: Array<{ id: string }>) =>
    db.worker.updateMany({ where: { id: { in: ws.map((w) => w.id) } }, data: { heldByUserId: by.id, heldAt: new Date() } });

  it('the worker it reports to hands it over or clears it; a worker claims an unclaimed one for itself', async () => {
    // One person (member) holds Ada, Marco and Dan, so Ada may claim Dan.
    await hold(member, ada, marco, dan);
    // Ada claims Dan, who reports to nobody.
    await asWorker(ada, () => set(ctx(member.id), dan.id, ada.id));
    // Marco can't take Dan from Ada.
    expect(await codeOf(asWorker(marco, () => set(ctx(member.id), dan.id, marco.id)))).toBe('WORKER_REPORTS_TO_FORBIDDEN');
    // Ada hands Dan over to Marco: her act is her agreement.
    await asWorker(ada, () => set(ctx(member.id), dan.id, marco.id));
    expect(await reportsToOf(dan)).toBe(marco.id);
    // Marco clears it.
    await asWorker(marco, () => set(ctx(member.id), dan.id, null));
    expect((await events(dan)).map((e) => (e.payload as { setBy: string }).setBy)).toEqual(['claimant', 'current', 'current']);
  });

  it('a worker may not claim an unclaimed worker for someone else, nor set its own, and a person alone may not', async () => {
    expect(await codeOf(asWorker(ada, () => set(ctx(member.id), dan.id, marco.id)))).toBe('WORKER_REPORTS_TO_FORBIDDEN');
    expect(await codeOf(asWorker(dan, () => set(ctx(member.id), dan.id, ada.id)))).toBe('WORKER_REPORTS_TO_FORBIDDEN');
    expect(await codeOf(set(ctx(member.id), dan.id, ada.id))).toBe('WORKER_REPORTS_TO_FORBIDDEN');
    expect(await reportsToOf(dan)).toBeNull();
  });

  it('INTERIM (Ada #7981): a worker claims only a worker the same person holds; otherwise the target\'s holder places it', async () => {
    const other = await user(12);
    await db.appMember.create({ data: { appId: app.id, userId: other.id, role: 'member' } });
    // Both unheld (a worker whose name was released keeps its live session): "nobody holds
    // both" is not "one person holds both".
    expect(await codeOf(asWorker(ada, () => set(ctx(member.id), dan.id, ada.id)))).toBe('WORKER_REPORTS_TO_FORBIDDEN');
    await hold(member, ada);
    // Dan is unheld: Ada can't claim him.
    expect(await codeOf(asWorker(ada, () => set(ctx(member.id), dan.id, ada.id)))).toBe('WORKER_REPORTS_TO_FORBIDDEN');
    // Dan held by someone else: still not Ada's to claim.
    await hold(other, dan);
    expect(await codeOf(asWorker(ada, () => set(ctx(member.id), dan.id, ada.id)))).toBe('WORKER_REPORTS_TO_FORBIDDEN');
    expect(await reportsToOf(dan)).toBeNull();
    // Dan's holder places him under Ada, as a person or through any session.
    await set(ctx(other.id), dan.id, ada.id);
    expect(await reportsToOf(dan)).toBe(ada.id);
    expect((await events(dan)).at(-1)?.payload).toEqual({ from: null, to: ada.id, setBy: 'holder' });
    // The holder can't then move him: an existing claim is the current worker's, or a manager's.
    expect(await codeOf(set(ctx(other.id), dan.id, marco.id))).toBe('WORKER_REPORTS_TO_FORBIDDEN');
  });

  it('a worker id with no person behind it proves nothing: a bare App key is refused', async () => {
    const appKey: Context = { db, roles: [], appId: app.id };
    expect(await codeOf(asWorker(ada, () => set(appKey, dan.id, ada.id)))).not.toBe('NO_ERROR');
    expect(await reportsToOf(dan)).toBeNull();
  });
});

describe('retirement, reads and the roster', () => {
  it("retiring clears the worker's own value; workers reporting to it keep theirs and read reportsToRetired", async () => {
    await set(ctx(admin.id), dan.id, ada.id);
    await set(ctx(admin.id), ada.id, marco.id);
    await M.retireWorker({}, { workerRef: ada.id }, ctx(admin.id));
    expect(await reportsToOf(ada)).toBeNull();
    expect((await events(ada)).at(-1)?.payload).toEqual({ from: marco.id, to: null, setBy: 'retirement' });
    expect(await reportsToOf(dan)).toBe(ada.id);
    const row = await db.worker.findUniqueOrThrow({ where: { id: dan.id } });
    expect(await F.Worker.reportsToRetired(row, {}, ctx(member.id))).toBe(true);
    const roster = await Q.teamRoster({}, { appRef: app.id }, ctx(member.id));
    const entry = roster.workers.find((w: { workerId: string }) => w.workerId === dan.id);
    expect(F.TeamRosterEntry.reportsTo(entry)).toMatchObject({ kind: 'WORKER', id: ada.id, name: 'Ada' });
    expect(F.TeamRosterEntry.reportsToRetired(entry)).toBe(true);
  });

  it('worker reads show it to the App audience and mask it for anyone else', async () => {
    await set(ctx(admin.id), dan.id, ada.id);
    const row = await db.worker.findUniqueOrThrow({ where: { id: dan.id } });
    expect(await F.Worker.reportsToWorkerId(row, {}, ctx(member.id))).toBe(ada.id);
    expect(await F.Worker.reportsTo(row, {}, ctx(member.id))).toMatchObject({ id: ada.id });
    const stranger = await user(9);
    expect(await F.Worker.reportsToWorkerId(row, {}, ctx(stranger.id))).toBeNull();
    expect(await F.Worker.reportsTo(row, {}, ctx(stranger.id))).toBeNull();
  });
});

describe('cor:agt:050:09 — a worker directs the tasks of the workers that report to it (Holger, #7804)', () => {
  /** A root task owned by worker Dan, assigned to Liam. */
  const dansTask = () => asWorker(dan, () => M.createAgentTask({}, { input: { appRef: app.id, title: 'Fix it', assignee: { worker: liam.id } } }, ctx(member.id)));
  const reassign = (by: { id: string }, taskId: string, to: { id: string }) =>
    asWorker(by, () => M.reassignAgentTask({}, { taskId, assignee: { worker: to.id } }, ctx(member.id)));
  const cancel = (by: { id: string }, taskId: string) => asWorker(by, () => M.cancelAgentTask({}, { taskId }, ctx(member.id)));

  it('the worker the owner reports to reassigns and cancels; any other worker is refused', async () => {
    await set(ctx(admin.id), dan.id, ada.id);
    const t = await dansTask();
    expect(await codeOf(reassign(marco, t.id, marco))).toBe('TASK_NOT_OWNER');
    await reassign(ada, t.id, marco);
    expect(await codeOf(cancel(marco, t.id))).toBe('TASK_NOT_OWNER');
    await cancel(ada, t.id);
    expect((await db.agentTask.findUniqueOrThrow({ where: { id: t.id } })).status).toBe('cancelled');
  });

  it('up the chain: Dan → Ada → Marco, so Marco directs it too; once the chain is cleared nobody above does', async () => {
    await set(ctx(admin.id), dan.id, ada.id);
    await set(ctx(admin.id), ada.id, marco.id);
    const t = await dansTask();
    await reassign(marco, t.id, ada);
    await set(ctx(admin.id), ada.id, null);
    expect(await codeOf(reassign(marco, t.id, liam))).toBe('TASK_NOT_OWNER');
    expect(await codeOf(reassign(ada, t.id, liam))).toBe('NO_ERROR');
  });

  it('the reverse direction grants nothing: a worker does not direct the tasks of the worker it reports to', async () => {
    await set(ctx(admin.id), ada.id, dan.id);
    const t = await dansTask();
    expect(await codeOf(reassign(ada, t.id, marco))).toBe('TASK_NOT_OWNER');
  });
});

describe('reportsTo at startSession (a spawn brief in one step)', () => {
  const bind = (c: Context, worker: { id: string }, reportsTo?: string) =>
    // force: a rebind of one's own live worker is an informed takeover (#940), beside the point here.
    M.startSession({}, { input: { id: generateId(), workerRef: worker.id, force: true, ...(reportsTo ? { reportsTo } : {}) } }, c);

  it('sets an unset value by name, as a bind event; a bind without it changes nothing', async () => {
    await bind(ctx(member.id), dan, 'Ada');
    expect(await reportsToOf(dan)).toBe(ada.id);
    expect((await events(dan)).map((e) => (e.payload as { setBy: string }).setBy)).toEqual(['bind']);
    await bind(ctx(member.id), dan);
    expect(await reportsToOf(dan)).toBe(ada.id);
  });

  it('naming a different worker refuses the bind, unless the caller manages the App', async () => {
    await set(ctx(admin.id), dan.id, ada.id);
    const before = await db.session.count({ where: { workerId: dan.id } });
    expect(await codeOf(bind(ctx(member.id), dan, marco.id))).toBe('WORKER_REPORTS_TO_HELD');
    expect(await db.session.count({ where: { workerId: dan.id } })).toBe(before);
    expect(await reportsToOf(dan)).toBe(ada.id);
    // Naming the current one is fine; an App manager may move it.
    await bind(ctx(member.id), dan, ada.id);
    await bind(ctx(appOwnerMember.id), liam, ada.id);
    await set(ctx(admin.id), liam.id, marco.id);
    await bind(ctx(appOwnerMember.id), liam, ada.id);
    expect(await reportsToOf(liam)).toBe(ada.id);
  });
});

describe('#1737 review — anchored authority and one lock protocol (Rook P2-1, Diego P2-1..P2-3)', () => {
  /** Is this worker's row free to lock right now (no other transaction holds it)? */
  const rowFree = (id: string) => db.$transaction(async (t) => {
    await t.$queryRaw`SELECT id FROM workers WHERE id = ${id} FOR UPDATE NOWAIT`;
  }).then(() => true, () => false);
  /** Hold `appId`'s graph lock in a transaction until `release()`; `during` runs inside it first. */
  function holdGraph(appId: string, during: (tx: any) => Promise<void> = async () => {}) {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let ready!: () => void;
    const isReady = new Promise<void>((r) => { ready = r; });
    const done = db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'worker-reports-to:' + appId}))`;
      await during(tx);
      ready();
      await held;
    }, { timeout: 30_000 });
    return { isReady, release: () => { release(); return done; } };
  }

  it('a support session (impersonation) is refused, and nothing is written', async () => {
    const support = ctx(admin.id, { impersonation: { orgId: org.id } as Context['impersonation'] });
    expect(await codeOf(set(support, dan.id, ada.id))).toBe('FORBIDDEN');
    expect(await reportsToOf(dan)).toBeNull();
    expect(await events(dan)).toHaveLength(0);
  });

  it('a platform role only the token still carries grants nothing (roles are re-read in the transaction)', async () => {
    const former = await user(10);
    await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: former.id, role: 'CONTRIBUTOR' } });
    expect(await codeOf(set(ctx(former.id, { roles: ['ADMIN'] }), dan.id, ada.id))).toBe('WORKER_REPORTS_TO_FORBIDDEN');
    // The same role on the user row does manage.
    await db.user.update({ where: { id: former.id }, data: { roles: ['ADMIN'] } });
    await set(ctx(former.id, { roles: ['ADMIN'] }), dan.id, ada.id);
    expect(await reportsToOf(dan)).toBe(ada.id);
  });

  it('at bind too, a platform role only the token carries cannot move a claimed worker', async () => {
    await set(ctx(admin.id), dan.id, ada.id);
    const former = await user(11);
    await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: former.id, role: 'CONTRIBUTOR' } });
    const bind = (c: Context) => M.startSession({}, { input: { id: generateId(), workerRef: dan.id, force: true, reportsTo: marco.id } }, c);
    expect(await codeOf(bind(ctx(former.id, { roles: ['ADMIN'] })))).toBe('WORKER_REPORTS_TO_HELD');
    expect(await reportsToOf(dan)).toBe(ada.id);
  });

  it("an owner-role manager's membership is held through the write: a demotion waits for it", async () => {
    // Pause the setter after its authority holds: a barrier holds Dan's row.
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => { locked = r; });
    const barrier = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM workers WHERE id = ${dan.id} FOR UPDATE`;
      locked();
      await held;
    }, { timeout: 30_000 });
    await isLocked;
    const setting = set(ctx(appOwnerMember.id), dan.id, ada.id);
    let demoted = false;
    let demotion: Promise<void> = Promise.resolve();
    let demotedWhileWriting = true;
    try {
      // The setter now holds the graph lock and the owner's app_members row, and
      // its writer waits on Dan's row. Wait for THAT statement specifically: an
      // unrelated waiter (the event-driven matcher, say) must not release us early.
      for (let i = 0; ; i++) {
        const [{ n }] = await db.$queryRaw<Array<{ n: bigint }>>`
          SELECT count(*) AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND query LIKE '%reports_to_worker_id FROM workers%FOR UPDATE%'`;
        if (n > 0n) break;
        if (i > 400) throw new Error("the setter's writer never waited on Dan's row");
        await new Promise((r) => setTimeout(r, 25));
      }
      demotion = db.appMember.update({
        where: { appId_userId: { appId: app.id, userId: appOwnerMember.id } }, data: { role: 'member' },
      }).then(() => { demoted = true; });
      await new Promise((r) => setTimeout(r, 400));
      demotedWhileWriting = demoted;
    } finally {
      release();
      await barrier;
    }
    expect(demotedWhileWriting).toBe(false);
    await setting;
    await demotion;
    // The write was authorized by the role it held throughout; the demotion is ordered after it.
    expect(await reportsToOf(dan)).toBe(ada.id);
    expect(await codeOf(set(ctx(appOwnerMember.id), dan.id, null))).toBe('WORKER_REPORTS_TO_FORBIDDEN');
  });

  it('retirement takes the graph lock before the worker row (no setter/retire deadlock)', async () => {
    const graph = holdGraph(app.id);
    await graph.isReady;
    const observed = observeTransactionBackend(db);
    const retiring = M.retireWorker({}, { workerRef: ada.id }, ctx(admin.id, { db: observed.db }));
    void retiring.catch(() => {});
    let freeWhileWaiting = false;
    try {
      const pid = await observed.backendFor(retiring);
      await waitForAdvisoryWaiter(db, { pid, key: { form: 'hashed-bigint', value: 'worker-reports-to:' + app.id } }, 10_000);
      freeWhileWaiting = await rowFree(ada.id);
    } finally {
      await graph.release();
      await Promise.allSettled([retiring]);
    }
    expect(freeWhileWaiting).toBe(true);
    await retiring;
  });

  it('a bind that sets reportsTo takes the graph lock before the worker row (no setter/bind deadlock)', async () => {
    const graph = holdGraph(app.id);
    await graph.isReady;
    const observed = observeTransactionBackend(db);
    const binding = M.startSession({}, { input: { id: generateId(), workerRef: dan.id, reportsTo: ada.id } }, ctx(member.id, { db: observed.db }));
    void binding.catch(() => {});
    let freeWhileWaiting = false;
    try {
      const pid = await observed.backendFor(binding);
      await waitForAdvisoryWaiter(db, { pid, key: { form: 'hashed-bigint', value: 'worker-reports-to:' + app.id } }, 10_000);
      freeWhileWaiting = await rowFree(dan.id);
    } finally {
      await graph.release();
      await Promise.allSettled([binding]);
    }
    expect(freeWhileWaiting).toBe(true);
    await binding;
    expect(await reportsToOf(dan)).toBe(ada.id);
  });

  it("a coordinating task write waits on the graph before any worker row, and sees a chain cleared meanwhile", async () => {
    await set(ctx(admin.id), dan.id, ada.id);
    const t = await asWorker(dan, () => M.createAgentTask({}, { input: { appRef: app.id, title: 'Fix it', assignee: { worker: liam.id } } }, ctx(member.id)));
    // A writer clears Dan → Ada, uncommitted, while Ada's reassign is in flight.
    const graph = holdGraph(app.id, (tx) => writeReportsTo(tx, {
      workerId: dan.id, to: null, actor: { userId: admin.id, workerId: null, agentId: null }, setBy: 'app-manager',
    }).then(() => undefined));
    await graph.isReady;
    const observed = observeTransactionBackend(db);
    const reassigning = codeOf(asWorker(ada, () => M.reassignAgentTask({}, { taskId: t.id, assignee: { worker: marco.id } }, ctx(member.id, { db: observed.db }))));
    let adaFree = false;
    try {
      const pid = await observed.backendFor(reassigning);
      await waitForAdvisoryWaiter(db, { pid, key: { form: 'hashed-bigint', value: 'worker-reports-to:' + app.id } }, 10_000);
      adaFree = await rowFree(ada.id);
    } finally {
      await graph.release();
      await Promise.allSettled([reassigning]);
    }
    expect(adaFree).toBe(true);
    expect(await reassigning).toBe('TASK_NOT_OWNER');
    expect((await db.agentTask.findUniqueOrThrow({ where: { id: t.id } })).assigneeWorkerId).toBe(liam.id);
  });
});

describe("#1737 QA (Chip's P2) — no cross-tenant existence oracle", () => {
  const extensionsOf = async (p: Promise<unknown>) => {
    try { await p; return null; } catch (e) { return (e as GraphQLError).extensions; }
  };

  it("another App's worker and a missing one answer alike, with no id, on set and at bind", async () => {
    const zedUrn = `hrn:worker:${org.urn}:other:zed`;
    const missingUrn = `hrn:worker:${org.urn}:team:nobody`;
    for (const ref of [zed.id, zedUrn, generateId(), missingUrn]) {
      const ext = await extensionsOf(set(ctx(member.id), dan.id, ref));
      expect(ext).toEqual({ code: 'WORKER_NOT_FOUND' });
      const atBind = await extensionsOf(M.startSession({}, { input: { id: generateId(), workerRef: dan.id, force: true, reportsTo: ref } }, ctx(member.id)));
      expect(atBind).toEqual({ code: 'WORKER_NOT_FOUND' });
    }
    expect(await reportsToOf(dan)).toBeNull();
  });

  it("a caller without authority is refused before any target check: a retired or looping target says nothing", async () => {
    await set(ctx(admin.id), ada.id, dan.id);
    // member drives no worker and manages nothing: refused, whatever the target.
    expect(await codeOf(set(ctx(member.id), dan.id, old.id))).toBe('WORKER_REPORTS_TO_FORBIDDEN');
    expect(await codeOf(set(ctx(member.id), dan.id, ada.id))).toBe('WORKER_REPORTS_TO_FORBIDDEN');
    // The same targets refuse on their merits for a manager.
    expect(await codeOf(set(ctx(admin.id), dan.id, old.id))).toBe('WORKER_REPORTS_TO_RETIRED');
    expect(await codeOf(set(ctx(admin.id), dan.id, ada.id))).toBe('WORKER_REPORTS_TO_CYCLE');
  });
});
