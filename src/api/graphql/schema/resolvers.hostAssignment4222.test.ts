import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
/**
 * #4222 (S1a of #4229) — the platform holds which workers each host runs (hrn:node:hadronmemory.com:specs:cor:agt:070:01,
 * its change drafted as Proposed in #4226): the assignment record, who sets and reads it, the App's
 * `hostSetupSource` switch (HOST by default, so nothing changes until cutover), a registration checked against
 * the assignments once the App opts in, and a start that uses the assignment's workdir and family.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { APP_KEY_PREFIX, hashAppKey } from '../../../middleware/auth.js';
import { loadLaunchableFamilies } from '../../../lib/agentTasks/hosts.js';
import { fenceHostDecision } from '../../../lib/hostOperations/launch.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;

const ctx = (userId?: string, extra: Partial<Context> = {}): Context => ({ db, userId, roles: ['READER'], ...extra }) as Context;
async function refusal(p: Promise<unknown>): Promise<{ code?: string; message?: string; extensions?: unknown }> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(GraphQLError);
    const g = e as GraphQLError;
    return { code: g.extensions?.code as string, message: g.message, extensions: g.extensions };
  }
  return {};
}
const code = async (p: Promise<unknown>) => (await refusal(p)).code;

let org: { id: string; urn: string };
let app: { id: string; urn: string };
let otherApp: { id: string };
let agentId: string;
let manager: { id: string };
let holder: { id: string };
let member: { id: string };
let outsider: { id: string };
let kit: { id: string };
let ada: { id: string };
let zed: { id: string };
let orca1: { id: string };
let orca2: { id: string };
let plainKey: { id: string };

async function mkKey(appId: string, label: string) {
  const raw = `${APP_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
  return db.appKey.create({ data: { id: generateId(), appId, keyHash: hashAppKey(raw), keyPreview: raw.slice(-4), label }, select: { id: true } });
}
const keyCtx = (k: { id: string }, appId = app.id): Context => ({ db, appId, appKeyId: k.id, organizationId: org.id, roles: [] }) as Context;
const asWorker = <T>(w: { id: string }, fn: () => Promise<T>): Promise<T> => runAsActor({ workerId: w.id, agentId }, fn);

const KIT = { hostId: 'orca1', worker: 'Kit', workdir: 'hadron-server/kit', family: 'claude', model: 'fable-5.2' };
const assign = (input: Record<string, unknown> = {}, c: Context = ctx(manager.id)) =>
  M.assignHostWorker({}, { input: { appRef: app.id, ...KIT, ...input } }, c);
const unassign = (input: Record<string, unknown> = {}, c: Context = ctx(manager.id)) =>
  M.unassignHostWorker({}, { input: { appRef: app.id, hostId: 'orca1', worker: 'Kit', ...input } }, c);
const setSource = (source: string, c: Context = ctx(manager.id)) => M.setHostSetupSource({}, { appRef: app.id, source }, c);
const setup = (c: Context, hostId?: string) => Q.hostSetup({}, { appRef: app.id, hostId }, c);
const register = (k: { id: string }, workers: unknown[] = []) =>
  M.registerHost({}, { input: { appRef: app.id, label: 'Orca', pollIntervalSeconds: 600, workers } }, keyCtx(k));
const rows = (s: { assignments: any[] }) => s.assignments.map((a) => [a.hostId, a.workerId, a.workdir, a.family, a.model]);

/** A raw connection on this run's database (the per-worker URL), for interleavings Prisma cannot hold open. */
async function pgClient(): Promise<Client> {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  return c;
}
/** Resolves once PostgreSQL reports a backend waiting for a lock: `pid` given, that backend; else any backend waiting
 * for the App's host-setup advisory lock. Polls pg_locks, never a sleep; fails after 10 s (#4241, Diego P3). */
async function untilWaiting(probe: Client, a: { pid?: number; setupOf?: string }): Promise<void> {
  for (let i = 0; i < 400; i++) {
    const { rowCount } = a.pid !== undefined
      ? await probe.query('SELECT 1 FROM pg_locks WHERE pid = $1 AND NOT granted', [a.pid])
      : await probe.query(
        `SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted
           AND objid::bigint = (hashtext($1)::bigint & 4294967295)`, [`host-setup:${a.setupOf}`]);
    if (rowCount) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('no backend ever waited for the lock');
}
const insertAssignmentSql = `INSERT INTO host_worker_assignments (id, app_id, host_id, worker_id, workdir, family, created_by_user_id)
  VALUES ($1, $2, 'orca1', $3, 'hadron-server/kit', 'claude', $4)`;

beforeEach(async () => {
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1_000_000);
  org = await db.organization.create({ data: { name: 'Hosts', urn: `hostsetup-${n}.example` }, select: { id: true, urn: true } });
  const u = (k: number, name: string) =>
    db.user.create({ data: { githubId: k * 1_000_000 + n, githubUsername: `hs-${name}-${n}`, roles: ['READER'] }, select: { id: true } });
  manager = await u(81, 'manager');
  holder = await u(82, 'holder');
  member = await u(83, 'member');
  outsider = await u(84, 'outsider');
  await db.orgMember.create({ data: { organizationId: org.id, userId: manager.id, role: 'ADMIN' } });
  const agent = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(manager.id));
  agentId = agent.id;
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `${org.urn}:team` }, select: { id: true, urn: true } });
  otherApp = await db.app.create({ data: { organizationId: org.id, name: 'Other', urn: `${org.urn}:other` }, select: { id: true } });
  for (const id of [holder.id, member.id]) await db.appMember.create({ data: { appId: app.id, userId: id, role: 'member' } });
  ada = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId, name: 'Ada', slug: 'ada', heldByUserId: holder.id, heldAt: new Date() }, select: { id: true } });
  kit = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId, name: 'Kit', slug: 'kit', heldByUserId: holder.id, heldAt: new Date() }, select: { id: true } });
  zed = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: otherApp.id, agentId, name: 'Zed', slug: 'zed' }, select: { id: true } });
  orca1 = await mkKey(app.id, 'orca1');
  orca2 = await mkKey(app.id, 'orca2');
  plainKey = await mkKey(app.id, 'plain');
  await M.grantAppKeyScope({}, { id: orca1.id, scope: 'host:operate', hostId: 'orca1' }, ctx(manager.id));
  await M.grantAppKeyScope({}, { id: orca2.id, scope: 'host:operate', hostId: 'orca2' }, ctx(manager.id));
});

describe('the invariants file', () => {
  it('the migration carries a byte-identical copy and post-push includes it', () => {
    const source = readFileSync(new URL('../../../../prisma/host-assignment-invariants.sql', import.meta.url), 'utf8');
    const migration = readFileSync(new URL('../../../../prisma/migrations/20261115140000_host_worker_assignments/migration.sql', import.meta.url), 'utf8');
    // #4230 (S1b) changed only the shape CHECK's last clauses (launcher_profile gave way to effort and account_profile),
    // and its migration carries the file as it is now; this one carries it as it was, with those clauses.
    const profile = source.slice(source.indexOf('  -- #4230 (S1b, decision G1)'), source.indexOf('\n);', source.indexOf('  -- #4230 (S1b, decision G1)')));
    expect(profile.length).toBeGreaterThan(0);
    const s1a = source.replace(profile, '  (launcher_profile IS NULL OR (host_operation_token_ok(launcher_profile) AND length(launcher_profile) <= 128))')
      // #4251: the model clause now calls the one launcher-model grammar; S1a's copy has it inline.
      .replace('  -- The one launcher-model grammar, shared with worker.start\'s argument check (prisma/host-operation-invariants.sql).\n  (model IS NULL OR host_launcher_model_ok(model)) AND\n',
        '  (model IS NULL OR (host_operation_token_ok(model) AND length(model) <= 128)) AND\n');
    expect(migration.endsWith(`\n${s1a}`)).toBe(true);
    const s1b = readFileSync(new URL('../../../../prisma/migrations/20261115180000_host_launcher_profiles/migration.sql', import.meta.url), 'utf8');
    expect(s1b.endsWith(`\n${source}`)).toBe(true);
    expect(readFileSync(new URL('../../../../prisma/post-push.sql', import.meta.url), 'utf8')).toContain('\\ir host-assignment-invariants.sql');
  });

  it('the database refuses a workdir or family that is not a token, and an unknown setup source', async () => {
    const base = { id: generateId(), appId: app.id, hostId: 'orca1', workerId: kit.id, workdir: 'hadron-server/kit', family: 'claude', createdByUserId: manager.id };
    await expect(db.hostWorkerAssignment.create({ data: { ...base, workdir: '../etc' } })).rejects.toThrow();
    await expect(db.hostWorkerAssignment.create({ data: { ...base, workdir: '-rf' } })).rejects.toThrow();
    await expect(db.hostWorkerAssignment.create({ data: { ...base, family: 'Claude Code' } })).rejects.toThrow();
    await expect(db.hostWorkerAssignment.create({ data: { ...base, model: 'a b' } })).rejects.toThrow();
    await expect(db.hostWorkerAssignment.create({ data: { ...base, hostId: '-x' } })).rejects.toThrow();
    await expect(db.$executeRaw`UPDATE apps SET host_setup_source = 'file' WHERE id = ${app.id}`).rejects.toThrow();
    // A worker of another App is refused by the database too.
    await expect(db.hostWorkerAssignment.create({ data: { ...base, workerId: zed.id } })).rejects.toThrow();
  });

  it("the database keeps an assigned worker in its App: moving it is refused until its assignments are removed (#4241 P2-2)", async () => {
    await db.hostWorkerAssignment.create({ data: { id: generateId(), appId: app.id, hostId: 'orca1', workerId: kit.id, workdir: 'hadron-server/kit', family: 'claude', createdByUserId: manager.id } });
    await expect(db.$executeRaw`UPDATE workers SET app_id = ${otherApp.id} WHERE id = ${kit.id}`).rejects.toThrow(/host_worker_assignments_worker_app_fkey/);
    expect((await db.worker.findUniqueOrThrow({ where: { id: kit.id } })).appId).toBe(app.id);
    // A worker with no assignment moves as before.
    expect(await db.$executeRaw`UPDATE workers SET app_id = ${otherApp.id} WHERE id = ${ada.id}`).toBe(1);
    await db.hostWorkerAssignment.deleteMany({ where: { workerId: kit.id } });
    expect(await db.$executeRaw`UPDATE workers SET app_id = ${otherApp.id} WHERE id = ${kit.id}`).toBe(1);
  });
});

describe('assignHostWorker: whoever manages the App states what a host runs', () => {
  it('a manager assigns Kit to orca1 with its workdir, family and model', async () => {
    const a = await assign();
    expect(a).toMatchObject({ hostId: 'orca1', workerId: kit.id, workdir: 'hadron-server/kit', family: 'claude', model: 'fable-5.2' });
    expect(rows(await setup(ctx(manager.id)))).toEqual([['orca1', kit.id, 'hadron-server/kit', 'claude', 'fable-5.2']]);
    const row = await db.hostWorkerAssignment.findFirstOrThrow({ where: { appId: app.id } });
    expect(row.createdByUserId).toBe(manager.id);
    expect([row.effort, row.accountProfile]).toEqual([null, null]); // #4230's profile fields, unset here
  });

  it('the family is normalized, the model is optional, and a worker may be assigned to two hosts', async () => {
    expect(await assign({ family: 'Claude', model: null })).toMatchObject({ family: 'claude', model: null });
    await assign({ hostId: 'orca2', workdir: 'kit-home' });
    expect(rows(await setup(ctx(manager.id))).map((r) => r[0])).toEqual(['orca1', 'orca2']);
  });

  it('a participant who does not manage the App, a worker session, and every App key are refused, writing nothing', async () => {
    expect(await code(assign({}, ctx(member.id)))).toBe('HOST_ASSIGNMENT_NOT_PERMITTED');
    expect(await code(asWorker(ada, () => assign({}, ctx(holder.id))))).toBe('HOST_ASSIGNMENT_NOT_PERMITTED');
    expect(await code(assign({}, keyCtx(orca1)))).toBe('HOST_ASSIGNMENT_NOT_PERMITTED');
    expect(await code(assign({}, keyCtx(plainKey)))).toBe('HOST_ASSIGNMENT_NOT_PERMITTED');
    expect(await code(assign({}, ctx(outsider.id)))).toBe('APP_NOT_FOUND');
    expect(await code(assign({}, ctx(manager.id, { impersonation: { adminId: 'x' } } as any)))).toBeDefined();
    expect(await db.hostWorkerAssignment.count()).toBe(0);
  });

  it('an App key is refused before its arguments are read: a malformed request answers the same as a good one', async () => {
    for (const k of [orca1, plainKey]) {
      expect(await code(assign({ workdir: '../x' }, keyCtx(k)))).toBe('HOST_ASSIGNMENT_NOT_PERMITTED');
      expect(await code(unassign({ hostId: '-x' }, keyCtx(k)))).toBe('HOST_ASSIGNMENT_NOT_PERMITTED');
    }
  });

  it('an existing assignment is refused HOST_ASSIGNMENT_EXISTS unless replace is set; replace updates it in place', async () => {
    const first = await assign();
    expect(await code(assign({ workdir: 'elsewhere' }))).toBe('HOST_ASSIGNMENT_EXISTS');
    expect(rows(await setup(ctx(manager.id)))[0]![2]).toBe('hadron-server/kit');
    const again = await assign({ workdir: 'hadron-cli/kit', family: 'codex', model: 'gpt-x', replace: true });
    expect(again).toMatchObject({ id: first.id, workdir: 'hadron-cli/kit', family: 'codex', model: 'gpt-x' });
    expect(await db.hostWorkerAssignment.count()).toBe(1);
  });

  it('refuses a path, an option or a bad host id as BAD_HOST_ASSIGNMENT_ARGS, and a bad family or model as BAD_LAUNCHER_PROFILE', async () => {
    for (const bad of [
      { workdir: '/home/orca/x' }, { workdir: '../x' }, { workdir: '-rf' }, { workdir: 'a//b' }, { workdir: 'a/' }, { workdir: '' },
      { workdir: 'bash -c x' }, { hostId: '-x' }, { hostId: '' },
    ]) {
      expect(await code(assign(bad)), JSON.stringify(bad)).toBe('BAD_HOST_ASSIGNMENT_ARGS');
    }
    // #4230: the family and model are the launcher profile's, and refuse with its code.
    for (const bad of [{ family: 'claude code' }, { family: '' }, { model: 'a b' }, { model: '--dangerously' }]) {
      expect(await code(assign(bad)), JSON.stringify(bad)).toBe('BAD_LAUNCHER_PROFILE');
    }
    expect(await db.hostWorkerAssignment.count()).toBe(0);
  });

  it('a retired worker is refused WORKER_RETIRED; a worker of another App or none reads WORKER_NOT_FOUND', async () => {
    await db.worker.update({ where: { id: kit.id }, data: { retiredAt: new Date() } });
    expect(await code(assign())).toBe('WORKER_RETIRED');
    expect(await code(assign({ worker: zed.id }))).toBe('WORKER_NOT_FOUND');
    expect(await code(assign({ worker: 'Nobody' }))).toBe('WORKER_NOT_FOUND');
    expect(await db.hostWorkerAssignment.count()).toBe(0);
  });

  it('unassign removes it: a manager only; a second removal answers false', async () => {
    await assign();
    expect(await code(unassign({}, ctx(member.id)))).toBe('HOST_ASSIGNMENT_NOT_PERMITTED');
    expect(await code(unassign({}, keyCtx(orca1)))).toBe('HOST_ASSIGNMENT_NOT_PERMITTED');
    expect(await db.hostWorkerAssignment.count()).toBe(1);
    expect(await unassign()).toBe(true);
    expect(await unassign()).toBe(false);
    expect(await db.hostWorkerAssignment.count()).toBe(0);
  });
});

describe('hostSetup: who reads what a host runs', () => {
  beforeEach(async () => {
    await assign();
    await assign({ hostId: 'orca2', worker: 'Ada', workdir: 'hadron-server/ada', family: 'codex', model: null });
  });

  it('a participant and a non-host App key read every host; hostId narrows it', async () => {
    for (const c of [ctx(member.id), keyCtx(plainKey)]) {
      const s = await setup(c);
      expect(s.source).toBe('HOST');
      expect(rows(s).map((r) => [r[0], r[1]])).toEqual([['orca1', kit.id], ['orca2', ada.id]]);
      expect(rows(await setup(c, 'orca2')).map((r) => r[1])).toEqual([ada.id]);
    }
    expect(await code(setup(ctx(outsider.id)))).toBe('APP_NOT_FOUND');
  });

  it("a host key reads its own host's rows, and another host's like a host that has none", async () => {
    expect(rows(await setup(keyCtx(orca1))).map((r) => [r[0], r[1]])).toEqual([['orca1', kit.id]]);
    expect(rows(await setup(keyCtx(orca1), 'orca1')).map((r) => [r[0], r[1]])).toEqual([['orca1', kit.id]]);
    const other = await setup(keyCtx(orca1), 'orca2');
    const missing = await setup(keyCtx(orca1), 'no-such-host');
    expect(other).toEqual(missing);
    expect(other.assignments).toEqual([]);
    // Each host-key read is a recorded use (cor:agt:070:07).
    expect(await db.hostKeyUse.count({ where: { appKeyId: orca1.id, action: 'read' } })).toBe(4);
  });

  it('a key whose host scope was revoked reads nothing (revoking never opens the App-wide read)', async () => {
    await M.revokeAppKeyScope({}, { id: orca1.id, scope: 'host:operate' }, ctx(manager.id));
    expect(await code(setup(keyCtx(orca1)))).toBe('FORBIDDEN');
    expect(await code(setup(keyCtx(orca1), 'orca2'))).toBe('FORBIDDEN');
  });

  it('retiring an assigned worker removes it from the next read', async () => {
    await db.worker.update({ where: { id: kit.id }, data: { retiredAt: new Date() } });
    expect(rows(await setup(keyCtx(orca1)))).toEqual([]);
    expect(rows(await setup(ctx(manager.id))).map((r) => r[1])).toEqual([ada.id]);
  });
});

describe('setHostSetupSource: the App opts in', () => {
  it('defaults to HOST; only whoever manages the App changes it', async () => {
    expect((await setup(ctx(manager.id))).source).toBe('HOST');
    expect(await code(setSource('SERVER', ctx(member.id)))).toBe('HOST_ASSIGNMENT_NOT_PERMITTED');
    expect(await code(setSource('SERVER', keyCtx(orca1)))).toBe('HOST_ASSIGNMENT_NOT_PERMITTED');
    expect((await setup(ctx(manager.id))).source).toBe('HOST');
    expect(await setSource('SERVER')).toBe('SERVER');
    expect((await setup(keyCtx(orca1))).source).toBe('SERVER');
    expect(await setSource('HOST')).toBe('HOST');
    expect(await code(setSource('FILE'))).toBe('BAD_USER_INPUT');
  });
});

describe('registerHost is checked against the assignments once the App opts in', () => {
  const both = () => [
    { worker: 'Kit', family: 'claude', worktrees: ['hadron-server/kit'] },
    { worker: 'Ada', family: 'claude', worktrees: ['hadron-server/ada'] },
  ];

  it('HOST (the default): the host states what it runs, exactly as before', async () => {
    await assign();
    const r = await register(orca1, both());
    expect(r.workers.map((w: any) => w.workerId).sort()).toEqual([ada.id, kit.id].sort());
    expect(r.refusedWorkers).toEqual([]);
  });

  it('SERVER: an unassigned worker is refused per row; the assigned workers still register', async () => {
    await assign();
    await setSource('SERVER');
    const r = await register(orca1, both());
    expect(r.workers.map((w: any) => w.workerId)).toEqual([kit.id]);
    expect(r.refusedWorkers).toEqual([{ worker: 'Ada', code: 'HOST_WORKER_NOT_ASSIGNED' }]);
    expect(r.live).toBe(true);
    expect(await db.hostRegistrationWorker.count()).toBe(1);
    // The use record counts what was registered.
    expect((await db.hostKeyUse.findFirstOrThrow({ where: { appKeyId: orca1.id, action: 'register' } })).count).toBe(1);
  });

  it('SERVER: an assignment to another host, a retired worker, a foreign worker and an unknown ref all read not assigned', async () => {
    await assign({ hostId: 'orca2' });
    await assign({ worker: 'Ada', workdir: 'hadron-server/ada' });
    await db.worker.update({ where: { id: ada.id }, data: { retiredAt: new Date() } });
    await setSource('SERVER');
    const r = await register(orca1, [...both(), { worker: zed.id, family: 'claude' }, { worker: 'Nobody', family: 'claude' }]);
    expect(r.workers).toEqual([]);
    expect(r.refusedWorkers.map((x: any) => [x.worker, x.code])).toEqual([
      ['Kit', 'HOST_WORKER_NOT_ASSIGNED'], ['Ada', 'HOST_WORKER_NOT_ASSIGNED'], [zed.id, 'HOST_WORKER_NOT_ASSIGNED'], ['Nobody', 'HOST_WORKER_NOT_ASSIGNED'],
    ]);
  });

  it('SERVER: a malformed registration is still refused whole', async () => {
    await assign();
    await setSource('SERVER');
    expect(await code(register(orca1, [{ worker: 'Kit', family: 'claude', worktrees: ['../x'] }]))).toBe('BAD_HOST_REGISTRATION');
  });

  it('SERVER: unassigning a registered worker makes it unlaunchable before the next registration', async () => {
    await assign();
    await setSource('SERVER');
    await register(orca1, both());
    expect((await loadLaunchableFamilies(db, { appId: app.id }, new Date())).get(kit.id)).toEqual(['claude']);
    await unassign();
    expect((await loadLaunchableFamilies(db, { appId: app.id }, new Date())).size).toBe(0);
  });
});

describe('a start uses the assignment (cor:agt:070:08 unchanged: with none, nothing is issued)', () => {
  const task = async () => {
    // Assigned at creation: a task created with no assignee is matched at once, Kit being launchable.
    await M.createAgentTask({}, { input: { appRef: app.id, title: 'Work', assignee: { worker: kit.id }, closeSessionWhenDone: false } }, ctx(manager.id));
    return db.hostOperation.findFirst({ where: { workerId: kit.id, type: 'worker.start' } });
  };
  const hostLists = (worktrees: string[]) => register(orca1, [{ worker: 'Kit', family: 'claude', worktrees }]);

  it('HOST (the default): the first worktree and the family the host registered', async () => {
    await assign({ workdir: 'hadron-cli/kit', family: 'codex' });
    await hostLists(['hadron-server/kit', 'hadron-cli/kit']);
    expect((await task())!.args).toMatchObject({ worktree: 'hadron-server/kit', family: 'claude' });
  });

  it('SERVER: the assigned workdir and family, whatever order or family the host stated', async () => {
    await assign({ workdir: 'hadron-cli/kit', family: 'codex' });
    await setSource('SERVER');
    await hostLists(['hadron-server/kit', 'hadron-cli/kit']);
    const op = await task();
    expect(op).toMatchObject({ hostId: 'orca1', issuedBy: 'platform' });
    expect(op!.args).toMatchObject({ worktree: 'hadron-cli/kit', family: 'codex' });
    // #4230 (S1b): a start now carries the assignment's model too (S1a's "a record only" ended there).
    expect(op!.args).toMatchObject({ model: 'fable-5.2' });
    expect((await loadLaunchableFamilies(db, { appId: app.id }, new Date())).get(kit.id)).toEqual(['codex']);
  });

  it('SERVER: no assignment issues nothing and the task waits', async () => {
    await hostLists(['hadron-server/kit']); // registered while the App was still HOST
    await setSource('SERVER');
    expect(await task()).toBeNull();
    expect((await loadLaunchableFamilies(db, { appId: app.id }, new Date())).size).toBe(0);
  });

  it('SERVER: a workdir the host did not confirm issues nothing', async () => {
    await assign({ workdir: 'hadron-cli/kit' });
    await setSource('SERVER');
    await hostLists(['hadron-server/kit']);
    expect(await task()).toBeNull();
  });

  it("SERVER: a manager's own start is held to the assigned workdir and family", async () => {
    await assign({ workdir: 'hadron-cli/kit', family: 'codex' });
    await setSource('SERVER');
    await hostLists(['hadron-server/kit', 'hadron-cli/kit']);
    const start = (args: Record<string, unknown>) =>
      M.issueHostOperation({}, { input: { appRef: app.id, hostId: 'orca1', worker: kit.id, type: 'worker.start', args } }, ctx(manager.id));
    expect(await code(start({ worktree: 'hadron-server/kit', family: 'codex' }))).toBe('BAD_HOST_OPERATION_ARGS');
    expect(await code(start({ worktree: 'hadron-cli/kit', family: 'claude' }))).toBe('BAD_HOST_OPERATION_ARGS');
    expect((await start({ worktree: 'hadron-cli/kit', family: 'codex' })).args).toMatchObject({ worktree: 'hadron-cli/kit', family: 'codex' });
  });
});

describe('lock order: a start takes the host-setup lock before the registration rows, as registerHost does', () => {
  it('a start queued behind a setup writer holds no registration row (#4241 blind review, Diego P2-1)', async () => {
    await register(orca1, [{ worker: 'Kit', family: 'claude', worktrees: ['hadron-server/kit'] }]);
    const writer = await pgClient();
    const registration = await pgClient();
    try {
      // A setup writer (an unassign, a switch change) holds the lock exclusive.
      await writer.query('BEGIN');
      await writer.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`host-setup:${app.id}`]);
      // A start's host decision queues behind it: PostgreSQL reports it waiting for that lock.
      let fenced = false;
      const start = db.$transaction(async (tx) => {
        await fenceHostDecision(tx, app.id);
        fenced = true;
      }, { timeout: 20_000 });
      await untilWaiting(registration, { setupOf: app.id });
      expect(fenced).toBe(false);
      // While it waits it holds no registration row, so a registration (which holds the lock shared and then
      // writes its row) is never blocked by it: no cycle through the writer's queue.
      await registration.query('BEGIN');
      const locked = await registration.query('SELECT id FROM host_registrations WHERE app_id = $1 FOR UPDATE NOWAIT', [app.id]);
      expect(locked.rowCount).toBe(1);
      await registration.query('ROLLBACK');
      await writer.query('COMMIT');
      await start;
      expect(fenced).toBe(true);
    } finally {
      await registration.query('ROLLBACK').catch(() => undefined);
      await writer.query('ROLLBACK').catch(() => undefined);
      await registration.end();
      await writer.end();
    }
  });

  it('registerHost holds the host-setup lock shared: it waits for a setup writer (#4241 §10, Rook F1)', async () => {
    const writer = await pgClient();
    try {
      await writer.query('BEGIN');
      await writer.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`host-setup:${app.id}`]);
      let registered = false;
      const reg = register(orca1, [{ worker: 'Kit', family: 'claude', worktrees: ['hadron-server/kit'] }]).then((r: unknown) => {
        registered = true;
        return r;
      });
      await untilWaiting(writer, { setupOf: app.id });
      expect(registered).toBe(false);
      await writer.query('COMMIT');
      await reg;
      expect(registered).toBe(true);
    } finally {
      await writer.query('ROLLBACK').catch(() => undefined);
      await writer.end();
    }
  });
});

describe('the same-App fact holds under concurrency (#4241 blind delta, Diego P2)', () => {
  it('a worker moved to another App while an assignment is inserted: the insert waits, then is refused', async () => {
    const mover = await pgClient();
    const inserter = await pgClient();
    try {
      await mover.query('BEGIN');
      await mover.query('UPDATE workers SET app_id = $1 WHERE id = $2', [otherApp.id, kit.id]); // no assignment yet
      const { rows: [{ pid }] } = await inserter.query('SELECT pg_backend_pid() AS pid');
      const insert = inserter.query(insertAssignmentSql, [generateId(), app.id, kit.id, manager.id]).then(() => 'inserted', (e: Error) => e.message);
      await untilWaiting(mover, { pid });
      await mover.query('COMMIT');
      expect(await insert).toMatch(/host_worker_assignments_worker_app_fkey/);
      expect(await db.hostWorkerAssignment.count()).toBe(0);
    } finally {
      await mover.query('ROLLBACK').catch(() => undefined);
      await mover.end();
      await inserter.end();
    }
  });

  it('an assignment inserted while the worker is moved: the move waits, then is refused', async () => {
    const mover = await pgClient();
    const inserter = await pgClient();
    try {
      await inserter.query('BEGIN');
      await inserter.query(insertAssignmentSql, [generateId(), app.id, kit.id, manager.id]);
      const { rows: [{ pid }] } = await mover.query('SELECT pg_backend_pid() AS pid');
      const move = mover.query('UPDATE workers SET app_id = $1 WHERE id = $2', [otherApp.id, kit.id]).then(() => 'moved', (e: Error) => e.message);
      await untilWaiting(inserter, { pid });
      await inserter.query('COMMIT');
      expect(await move).toMatch(/host_worker_assignments_worker_app_fkey/);
      expect((await db.worker.findUniqueOrThrow({ where: { id: kit.id } })).appId).toBe(app.id);
    } finally {
      await inserter.query('ROLLBACK').catch(() => undefined);
      await inserter.end();
      await mover.end();
    }
  });
  // REPEATABLE READ: the waiting side's snapshot predates the other side's commit, so a check by plain query would
  // read the old state and pass. The foreign key's own check still refuses it (#4241 blind delta at 2ce78a82, Diego P2).
  it('REPEATABLE READ: a mover whose snapshot predates the assignment cannot move the assigned worker', async () => {
    const mover = await pgClient();
    const inserter = await pgClient();
    try {
      await mover.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await mover.query('SELECT count(*) FROM host_worker_assignments'); // the snapshot is taken here, before the insert
      await inserter.query('BEGIN');
      await inserter.query(insertAssignmentSql, [generateId(), app.id, kit.id, manager.id]);
      const { rows: [{ pid }] } = await mover.query('SELECT pg_backend_pid() AS pid');
      const move = mover.query('UPDATE workers SET app_id = $1 WHERE id = $2', [otherApp.id, kit.id]).then(() => 'moved', (e: Error) => e.message);
      await untilWaiting(inserter, { pid });
      await inserter.query('COMMIT');
      expect(await move).toMatch(/host_worker_assignments_worker_app_fkey|could not serialize/);
      await mover.query('ROLLBACK');
      expect((await db.worker.findUniqueOrThrow({ where: { id: kit.id } })).appId).toBe(app.id);
      expect(await db.hostWorkerAssignment.count()).toBe(1);
    } finally {
      await inserter.query('ROLLBACK').catch(() => undefined);
      await mover.query('ROLLBACK').catch(() => undefined);
      await inserter.end();
      await mover.end();
    }
  });

  it('REPEATABLE READ: an inserter whose snapshot predates the move cannot assign the moved worker', async () => {
    const mover = await pgClient();
    const inserter = await pgClient();
    try {
      await inserter.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await inserter.query('SELECT count(*) FROM workers'); // the snapshot is taken here, before the move
      await mover.query('BEGIN');
      await mover.query('UPDATE workers SET app_id = $1 WHERE id = $2', [otherApp.id, kit.id]);
      const { rows: [{ pid }] } = await inserter.query('SELECT pg_backend_pid() AS pid');
      const insert = inserter.query(insertAssignmentSql, [generateId(), app.id, kit.id, manager.id]).then(() => 'inserted', (e: Error) => e.message);
      await untilWaiting(mover, { pid });
      await mover.query('COMMIT');
      expect(await insert).toMatch(/host_worker_assignments_worker_app_fkey|could not serialize/);
      await inserter.query('ROLLBACK');
      expect(await db.hostWorkerAssignment.count()).toBe(0);
    } finally {
      await mover.query('ROLLBACK').catch(() => undefined);
      await inserter.query('ROLLBACK').catch(() => undefined);
      await mover.end();
      await inserter.end();
    }
  });
});

describe("the instructed arm: a held worker on its holder's instruction (#3321; #4241 §10, Rook F2)", () => {
  const live = { kind: 'LIVE_CHAT', ref: 'client-chat:turn-4241' };
  const managerActs = () => db.agentTeamEvent.findMany({ where: { type: 'app.manager-act' }, orderBy: { id: 'asc' } });
  let boss: { id: string };
  let bossSession: { id: string };
  let adaSession: { id: string };
  beforeEach(async () => {
    boss = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId, name: 'Boss', slug: 'boss', heldByUserId: manager.id, heldAt: new Date() }, select: { id: true } });
    bossSession = await db.session.create({ data: { id: generateId(), appId: app.id, agentId, workerId: boss.id, userId: manager.id, tool: 'vitest' }, select: { id: true } });
    adaSession = await db.session.create({ data: { id: generateId(), appId: app.id, agentId, workerId: ada.id, userId: holder.id, tool: 'vitest' }, select: { id: true } });
  });
  const asBoss = <T>(fn: (c: Context) => Promise<T>) => asWorker(boss, () => fn(ctx(manager.id, { sessionId: bossSession.id })));
  const asAda = <T>(fn: (c: Context) => Promise<T>) => asWorker(ada, () => fn(ctx(holder.id, { sessionId: adaSession.id })));
  const doors: Record<string, { act: string; call: (c: Context) => Promise<unknown>; took: () => Promise<boolean> }> = {
    assignHostWorker: {
      act: 'host-setup.assign',
      call: (c) => M.assignHostWorker({}, { input: { appRef: app.id, ...KIT }, instruction: live }, c),
      took: async () => (await db.hostWorkerAssignment.count()) === 1,
    },
    unassignHostWorker: {
      act: 'host-setup.unassign',
      call: (c) => M.unassignHostWorker({}, { input: { appRef: app.id, hostId: 'orca1', worker: 'Kit' }, instruction: live }, c),
      took: async () => (await db.hostWorkerAssignment.count()) === 0,
    },
    setHostSetupSource: {
      act: 'host-setup.source',
      call: (c) => M.setHostSetupSource({}, { appRef: app.id, source: 'SERVER', instruction: live }, c),
      took: async () => (await db.app.findUniqueOrThrow({ where: { id: app.id } })).hostSetupSource === 'server',
    },
  };
  for (const [name, door] of Object.entries(doors)) {
    it(`${name}: a worker held by a manager, on an instruction, is admitted with exactly one record`, async () => {
      if (name === 'unassignHostWorker') await assign();
      const before = (await managerActs()).length;
      await asBoss(door.call);
      expect(await door.took()).toBe(true);
      const acts = (await managerActs()).slice(before);
      expect(acts).toHaveLength(1);
      expect(acts[0]).toMatchObject({ appId: app.id, actorUserId: manager.id, actorWorkerId: boss.id });
      expect(acts[0]!.payload).toMatchObject({ act: door.act, instruction: live });
    });

    it(`${name}: a worker whose holder does not manage the App is refused, nothing written`, async () => {
      if (name === 'unassignHostWorker') await assign();
      const before = { acts: (await managerActs()).length, rows: await db.hostWorkerAssignment.findMany(), app: await db.app.findUniqueOrThrow({ where: { id: app.id } }) };
      expect(await code(asAda(door.call))).toBe('HOST_ASSIGNMENT_NOT_PERMITTED');
      expect((await managerActs()).length).toBe(before.acts);
      expect(await db.hostWorkerAssignment.findMany()).toEqual(before.rows);
      expect((await db.app.findUniqueOrThrow({ where: { id: app.id } })).hostSetupSource).toBe(before.app.hostSetupSource);
    });
  }
});
