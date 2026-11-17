import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
/**
 * #3297 — the children-ended warning's read is one aggregate, and its safety rests on the parent row lock.
 *
 * `recordAgentTaskProgress` locks the task row FOR UPDATE (`lockTask`); a child INSERT needs FOR KEY SHARE on that row
 * through agent_tasks_parent_task_id_fkey, which conflicts, so a child create cannot land between the decision's reads.
 * Pinned: the decision (positive controls) and that an interleaved child insert waits for the progress transaction.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { resolvers, type Context } from './resolvers.js';
import { type TaskWarningCode } from './resolvers.taskWarnings.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const M = resolvers.Mutation as any;

let org: { id: string; urn: string };
let admin: { id: string };
let member: { id: string };
let outsider: { id: string };
let app: { id: string };
let otherApp: { id: string };
let teamAgentId: string;
let teamMemoryId: string;
let anne: { id: string };
let liam: { id: string };

const CHILDREN_ENDED = 'task.progress.children-ended' as TaskWarningCode;

const ctx = (userId: string): Context => ({ db, userId, roles: ['READER'] });
const asWorker = (w: { id: string }, fn: () => Promise<any>) => runAsActor({ workerId: w.id, agentId: teamAgentId }, fn);
const codes = (c: Context) => (c.taskWarnings ?? []).map((w) => w.warning.code as string);
const worker = (name: string, appId = app.id) =>
  db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId, agentId: teamAgentId, name, slug: name.toLowerCase() }, select: { id: true } });

/** A task row in `status`, with the columns the shape constraint (chk_agent_tasks_shape) requires. */
function task(status: string, data: Record<string, unknown> = {}, appId = app.id) {
  const now = new Date();
  const worked = status === 'started' || status === 'finished';
  // A started or finished row must be assigned: default it to Liam.
  const assignee = worked && !data.assigneeWorkerId && !data.assigneeUserId ? { assigneeWorkerId: liam.id } : {};
  const assigned = data.assigneeWorkerId || data.assigneeUserId || assignee.assigneeWorkerId ? { assignedAt: now } : {};
  const started = worked ? { startedAt: now } : {};
  return db.agentTask.create({
    data: {
      id: generateId(), appId, title: 'T', ownerUserId: member.id, status, ...assignee, ...assigned, ...started,
      ...(status === 'finished' ? { finishedAt: now, resultOutcome: 'succeeded' } : {}),
      ...(status === 'cancelled' ? { cancelledAt: now } : {}),
      ...data,
    } as any,
    select: { id: true },
  });
}
const progress = (c: Context, w: { id: string }, id: string) => asWorker(w, () => M.recordAgentTaskProgress({}, { taskId: id }, c));

beforeEach(async () => {
  await cleanDb(db);
  const suffix = generateId().toLowerCase();
  org = await db.organization.create({ data: { id: generateId(), name: 'tw3267-org', urn: `tw3267-${suffix}.example` } });
  admin = await db.user.create({ data: { githubId: 326701, githubUsername: 'tw3267-admin', handle: 'tw3267-admin', roles: ['READER'] } });
  member = await db.user.create({ data: { githubId: 326702, githubUsername: 'tw3267-member', handle: 'tw3267-member', roles: ['READER'] } });
  outsider = await db.user.create({ data: { githubId: 326703, githubUsername: 'tw3267-out', handle: 'tw3267-out', roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  const agent = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(admin.id));
  teamAgentId = agent.id;
  teamMemoryId = (await db.agent.findUniqueOrThrow({ where: { id: teamAgentId } })).systemMemoryId as string;
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  otherApp = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Other', urn: `${org.urn}:other` } });
  await db.appMember.create({ data: { appId: app.id, userId: member.id, role: 'member' } });
  await db.appAgent.create({ data: { appId: app.id, agentId: teamAgentId } });
  await db.node.create({ data: { id: generateId(), memoryId: teamMemoryId, loc: 'roles', name: 'roles', content: 'x' } });
  anne = await worker('Anne');
  liam = await worker('Liam');
});


const CHILD_STATUSES = ['backlog', 'pending', 'started'] as const;
const childOf = (parentId: string, status: string) =>
  task(status, status === 'backlog' ? { parentTaskId: parentId } : { assigneeWorkerId: liam.id, parentTaskId: parentId });

describe('task.progress.children-ended decision (#3297)', () => {
  it('a parent whose children have all ended warns', async () => {
    const parent = await task('started', { assigneeWorkerId: anne.id });
    await task('finished', { assigneeWorkerId: liam.id, parentTaskId: parent.id });
    await task('cancelled', { parentTaskId: parent.id });
    const c = ctx(member.id);
    await progress(c, anne, parent.id);
    expect(codes(c)).toEqual([CHILDREN_ENDED]);
  });

  it('a childless parent does not warn', async () => {
    const parent = await task('started', { assigneeWorkerId: anne.id });
    const c = ctx(member.id);
    await progress(c, anne, parent.id);
    expect(codes(c)).toEqual([]);
  });

  it.each(CHILD_STATUSES)('a parent with an ended child and a %s child does not warn', async (status) => {
    const parent = await task('started', { assigneeWorkerId: anne.id });
    await task('finished', { assigneeWorkerId: liam.id, parentTaskId: parent.id });
    await childOf(parent.id, status);
    const c = ctx(member.id);
    await progress(c, anne, parent.id);
    expect(codes(c)).toEqual([]);
  });
});

describe('the parent row lock serializes a child create behind progress (#3297)', () => {
  it('a child insert started after the first children read waits for the transaction; no warning is filed', async () => {
    const parent = await task('started', { assigneeWorkerId: anne.id });
    const seen = { fired: 0, doneInTx: false, lockWaiters: 0 };
    let insert: Promise<unknown> = Promise.resolve();
    // After the transaction's FIRST read of this task's children, start a PENDING child insert on the real db.
    const hook = async () => {
      if (seen.fired) return; // only the transaction's FIRST children read interleaves
      seen.fired = 1;
      let done = false;
      insert = db.agentTask.create({ data: { id: generateId(), appId: app.id, title: 'late', ownerUserId: member.id, status: 'pending', parentTaskId: parent.id } as any })
        .then(() => { done = true; });
      await new Promise((r) => setTimeout(r, 1500));
      seen.doneInTx = done;
      const w = await db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      seen.lockWaiters = Number(w[0]!.n);
    };
    const wrapTx = (tx: any) => new Proxy(tx, {
      get(t, k) {
        if (k === '$queryRaw') {
          return async (strings: any, ...vals: unknown[]) => {
            const r = await t.$queryRaw(strings, ...vals);
            if (Array.isArray(strings) && strings.join('?').includes('parent_task_id =') && vals.includes(parent.id)) await hook();
            return r;
          };
        }
        if (k === 'agentTask') {
          return new Proxy(t.agentTask, {
            get(m, f) {
              if (f !== 'count') return typeof m[f] === 'function' ? m[f].bind(m) : m[f];
              return async (a: any) => { const r = await m.count(a); if (a?.where?.parentTaskId === parent.id) await hook(); return r; };
            },
          });
        }
        const v = t[k];
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
    const hookedDb = new Proxy(db, {
      get(t, k) {
        if (k === '$transaction') return (fn: any, o: any) => (t as any).$transaction((tx: any) => fn(wrapTx(tx)), o);
        const v = (t as any)[k];
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
    const c = { ...ctx(member.id), db: hookedDb } as Context;
    await progress(c, anne, parent.id);
    await insert;
    expect(seen.fired).toBe(1); // the interleave happened, so the outcome below is not vacuous
    expect(seen.doneInTx).toBe(false); // the insert had not completed while the progress transaction was open
    expect(seen.lockWaiters).toBeGreaterThan(0); // and it was a lock waiter
    expect(await db.agentTask.count({ where: { parentTaskId: parent.id } })).toBe(1); // it completed after commit
    expect(codes(c)).toEqual([]);
  });
});
