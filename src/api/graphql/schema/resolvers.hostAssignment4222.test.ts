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
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { APP_KEY_PREFIX, hashAppKey } from '../../../middleware/auth.js';
import { loadLaunchableFamilies } from '../../../lib/agentTasks/hosts.js';
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
    const migration = readFileSync(new URL('../../../../prisma/migrations/20261115120000_host_worker_assignments/migration.sql', import.meta.url), 'utf8');
    expect(migration.endsWith(`\n${source}`)).toBe(true);
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
});

describe('assignHostWorker: whoever manages the App states what a host runs', () => {
  it('a manager assigns Kit to orca1 with its workdir, family and model', async () => {
    const a = await assign();
    expect(a).toMatchObject({ hostId: 'orca1', workerId: kit.id, workdir: 'hadron-server/kit', family: 'claude', model: 'fable-5.2' });
    expect(rows(await setup(ctx(manager.id)))).toEqual([['orca1', kit.id, 'hadron-server/kit', 'claude', 'fable-5.2']]);
    const row = await db.hostWorkerAssignment.findFirstOrThrow({ where: { appId: app.id } });
    expect(row.createdByUserId).toBe(manager.id);
    expect(row.launcherProfile).toBeNull();
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

  it('an existing assignment is refused HOST_ASSIGNMENT_EXISTS unless replace is set; replace updates it in place', async () => {
    const first = await assign();
    expect(await code(assign({ workdir: 'elsewhere' }))).toBe('HOST_ASSIGNMENT_EXISTS');
    expect(rows(await setup(ctx(manager.id)))[0]![2]).toBe('hadron-server/kit');
    const again = await assign({ workdir: 'hadron-cli/kit', family: 'codex', model: 'gpt-x', replace: true });
    expect(again).toMatchObject({ id: first.id, workdir: 'hadron-cli/kit', family: 'codex', model: 'gpt-x' });
    expect(await db.hostWorkerAssignment.count()).toBe(1);
  });

  it('refuses a path, an option, a bad family, model or host id as BAD_HOST_ASSIGNMENT_ARGS', async () => {
    for (const bad of [
      { workdir: '/home/orca/x' }, { workdir: '../x' }, { workdir: '-rf' }, { workdir: 'a//b' }, { workdir: 'a/' }, { workdir: '' },
      { workdir: 'bash -c x' }, { family: 'claude code' }, { family: '' }, { model: 'a b' }, { model: '--dangerously' }, { hostId: '-x' }, { hostId: '' },
    ]) {
      expect(await code(assign(bad)), JSON.stringify(bad)).toBe('BAD_HOST_ASSIGNMENT_ARGS');
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
    expect((await setSource('SERVER')).source).toBe('SERVER');
    expect((await setup(keyCtx(orca1))).source).toBe('SERVER');
    expect((await setSource('HOST')).source).toBe('HOST');
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
    const t = await M.createAgentTask({}, { input: { appRef: app.id, title: 'Work', closeSessionWhenDone: false } }, ctx(manager.id));
    await M.assignAgentTask({}, { taskId: t.id, assignee: { worker: kit.id } }, ctx(manager.id));
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
