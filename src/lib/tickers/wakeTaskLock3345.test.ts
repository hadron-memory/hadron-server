/** #3345: real due-wake audit vs real worker task create, with two transaction connections and explicit barriers. */
import { beforeEach, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
import { runAsActor } from '../requestActor.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import type { Prisma } from '../../generated/prisma/index.js';

vi.mock('../bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn() }));
vi.mock('../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn() }));

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
const latch = () => {
  let release!: () => void;
  return { promise: new Promise<void>(r => { release = r; }), release: () => release() };
};
const context = (extra: Partial<Context>): Context => ({ db, roles: [], ...extra }) as Context;
let appId: string, orgId: string, userId: string, agentId: string, keyId: string;
let workers: string[];

beforeEach(async () => {
  await cleanDb(db);
  const suffix = generateId();
  const org = await db.organization.create({ data: { name: 'lock3345', urn: `lock-${suffix}.example` } });
  orgId = org.id;
  const user = await db.user.create({ data: { githubId: 3345001, githubUsername: `lock-${suffix}`, roles: ['READER'] } });
  userId = user.id;
  await db.orgMember.create({ data: { organizationId: orgId, userId, role: 'ADMIN' } });
  const agent = await db.agent.create({ data: { organizationId: orgId, name: 'Role', urn: `${org.urn}:role`, visibility: 'ORGANIZATION' } });
  agentId = agent.id;
  const app = await db.app.create({ data: { organizationId: orgId, name: 'Team', urn: `${org.urn}:team` } });
  appId = app.id;
  await db.appAgent.create({ data: { appId, agentId } });
  await db.appMember.create({ data: { appId, userId, role: 'member' } });
  workers = [];
  for (const name of ['Low', 'Middle', 'High']) {
    const w = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId, agentId, name, slug: name.toLowerCase(), heldByUserId: userId } });
    workers.push(w.id);
  }
  workers.sort();
  const key = await db.appKey.create({ data: { appId, label: 'wake reader', keyHash: suffix, keyPreview: suffix.slice(-4) } });
  keyId = key.id;
  await db.appKeyScope.create({ data: { id: generateId(), appKeyId: keyId, scope: 'attention:deliver', grantedByUserId: userId } });
  // Keep AT0 creation out of the race; the competing INSERT below is the actual requested task.
  await M.createAgentTask({}, { input: { appRef: appId, title: 'seed', status: 'backlog' } }, context({ userId }));
});

it.each(['owner', 'assignee', 'distinct-match'] as const)('wake audit and create with an earlier %s worker both commit', async party => {
  const caller = workers[2];
  if (party === 'distinct-match') {
    for (const id of workers) {
      const role = id === workers[0] ? 'target' : 'other';
      await db.worker.update({ where: { id }, data: { role } });
      await db.session.create({ data: { id: generateId(), appId, workerId: id, agentId, role, family: 'claude',
        llmModel: 'claude-sonnet-5-5', startedAt: new Date(), updatedAt: new Date() } });
    }
  }
  const held = latch(), resume = latch();
  let createPid = 0;
  // Only observe/pause AFTER the real create's caller-worker SHARE has executed.
  const traced = new Proxy(db, {
    get(target, prop) {
      if (prop !== '$transaction') {
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (fn: (tx: Prisma.TransactionClient) => Promise<unknown>, options: unknown) => target.$transaction(async tx => {
        return fn(new Proxy(tx, {
          get(t, p) {
            if (p === '$queryRaw') return async (...args: any[]) => {
              const out = await (t.$queryRaw as any)(...args);
              const sql = Array.isArray(args[0]) ? args[0].join('?') : '';
              if (sql.includes('SELECT 1 FROM workers WHERE id =') && sql.includes('FOR SHARE')) {
                createPid = (await t.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0].pid;
                held.release();
                await resume.promise;
              }
              return out;
            };
            const value = Reflect.get(t, p);
            return typeof value === 'function' ? value.bind(t) : value;
          },
        }));
      }, options as any);
    },
  });
  const input = { appRef: appId, title: `competing-${party}`, [party]: { worker: workers[0] } };
  // Attach rejection handlers immediately: a regression must fail an assertion, never leak an unhandled rejection.
  const creating = runAsActor({ workerId: caller, agentId }, () => party === 'distinct-match'
    ? M.createAgentTasks({}, { appRef: appId, distinctAssignees: true,
      tasks: [{ task: { title: input.title, match: true, requirements: { role: 'target' } } }] }, context({ userId, db: traced }))
    : M.createAgentTask({}, { input }, context({ userId, db: traced })))
    .then((value: any) => ({ value, error: null }), (error: unknown) => ({ value: null, error }));
  let reading: Promise<{ value: any; error: unknown }> | undefined;
  let barrierTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      held.promise,
      creating.then(() => { throw new Error('create finished before its caller-worker barrier'); }),
      new Promise<never>((_, reject) => {
        barrierTimer = setTimeout(() => reject(new Error('create did not reach its caller-worker barrier')), 5_000);
      }),
    ]);
    clearTimeout(barrierTimer);
    reading = Q.dueWakes({}, { appRef: appId }, context({ appId, appKeyId: keyId, organizationId: orgId }))
      .then((value: any) => ({ value, error: null }), (error: unknown) => ({ value: null, error }));
    // Observer connection is not a participant: prove the real wake transaction
    // waits on this create (worker row, or the distinct batch's graph fence).
    let blocked = false;
    for (let n = 0; n < 200; n++) {
      const [row] = await db.$queryRaw<{ blocked: boolean }[]>`
        SELECT EXISTS(SELECT 1 FROM pg_stat_activity a
          WHERE ${createPid} = ANY(pg_blocking_pids(a.pid))
            AND (a.query LIKE '%FROM workers%FOR%UPDATE%'
              OR (${party === 'distinct-match'} AND a.query LIKE '%pg_advisory_xact_lock_shared%'))) AS blocked`;
      if (row.blocked) { blocked = true; break; }
      await new Promise(r => setTimeout(r, 10));
    }
    expect(blocked, 'wake must wait on the create caller or its batch graph fence').toBe(true);
  } finally {
    clearTimeout(barrierTimer);
    resume.release();
    const [created, read] = await Promise.all([creating, reading]);
    expect(created.error, 'task create must commit without a deadlock retry').toBeNull();
    expect(read?.error, 'wake answer must commit without a deadlock retry').toBeNull();
    const made = party === 'distinct-match' ? created.value?.[0] : created.value;
    expect(made).toMatchObject({ ownerWorkerId: party === 'owner' ? workers[0] : caller, assigneeWorkerId: party === 'owner' ? null : workers[0] });
    expect(read?.value.wakes).toEqual([]);
    expect(await db.appKeyWakeRead.count({ where: { appKeyId: keyId } })).toBe(1);
    expect(await db.appKeyWakeRead.findFirst({ where: { appKeyId: keyId } })).toMatchObject({ workerCount: 0 });
  }
}, 20_000);
