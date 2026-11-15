import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
/**
 * #4230 (S1b of #4229) — a typed launcher profile on the host assignment (decision G1; cor:agt:070:01 and :03, the change
 * drafted as Proposed in #4226): family, model, effort and accountProfile, each a token, never a command, a path or a
 * credential. Under the App's `server` source a start carries them; the host builds the command from fixed templates
 * (hadron-cli C3). Fixtures as in resolvers.hostAssignment4222.test.ts.
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

const KIT = { hostId: 'orca1', worker: 'Kit', workdir: 'hadron-server/kit', family: 'claude', model: 'claude-opus-5-5', accountProfile: 'worker' };
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

const PROFILE = (a: any) => ({ family: a.family, model: a.model, effort: a.effort, accountProfile: a.accountProfile });

describe('acceptance 1: a manager sets the profile; the host reads exactly those fields', () => {
  it("family claude, model claude-opus-5-5, account profile worker on Kit's assignment, read by orca1's key", async () => {
    const a = await assign();
    expect(PROFILE(a)).toEqual({ family: 'claude', model: 'claude-opus-5-5', effort: null, accountProfile: 'worker' });
    const seen = await setup(keyCtx(orca1));
    expect(seen.assignments.map(PROFILE)).toEqual([{ family: 'claude', model: 'claude-opus-5-5', effort: null, accountProfile: 'worker' }]);
    const row = await db.hostWorkerAssignment.findFirstOrThrow({ where: { appId: app.id } });
    expect(PROFILE(row)).toEqual({ family: 'claude', model: 'claude-opus-5-5', effort: null, accountProfile: 'worker' });
  });

  it('an effort is stored and read; replace changes the profile in place; every profile field but family is optional', async () => {
    await assign({ family: 'codex', model: 'gpt-6.1-sol', effort: 'high', accountProfile: 'codex-main' });
    expect((await setup(keyCtx(orca1))).assignments.map(PROFILE)).toEqual([{ family: 'codex', model: 'gpt-6.1-sol', effort: 'high', accountProfile: 'codex-main' }]);
    await assign({ family: 'glm', model: null, effort: null, accountProfile: null, replace: true });
    expect((await setup(ctx(manager.id))).assignments.map(PROFILE)).toEqual([{ family: 'glm', model: null, effort: null, accountProfile: null }]);
  });
});

describe('acceptance 2: a value that is not a token, or an unknown family, is BAD_LAUNCHER_PROFILE and nothing is stored', () => {
  const BAD = ['a b', 'a/b', '../x', '$(id)', '`id`', 'a;b', 'a|b', 'a&b', "a'b", 'a"b', '-rf', '--dangerously', 'a>b', '', 'x'.repeat(129)];
  it('model, effort or accountProfile with a space, slash or shell character', async () => {
    for (const field of ['model', 'effort', 'accountProfile']) {
      for (const v of BAD) {
        expect(await code(assign({ [field]: v })), `${field}=${JSON.stringify(v)}`).toBe('BAD_LAUNCHER_PROFILE');
      }
    }
    expect(await db.hostWorkerAssignment.count()).toBe(0);
  });

  it('a family the host has no launcher template for', async () => {
    for (const family of ['gemini', 'bash', 'claude code', 'Claude/Code', '']) {
      expect(await code(assign({ family })), family).toBe('BAD_LAUNCHER_PROFILE');
    }
    for (const family of ['claude', 'Claude', 'anthropic', 'codex', 'openai', 'glm', 'kimi']) {
      await assign({ family, replace: true });
    }
    expect(await db.hostWorkerAssignment.count()).toBe(1);
  });

  it('a refused replace leaves the stored profile as it was', async () => {
    await assign();
    expect(await code(assign({ accountProfile: 'a b', replace: true }))).toBe('BAD_LAUNCHER_PROFILE');
    expect(PROFILE(await db.hostWorkerAssignment.findFirstOrThrow({ where: { appId: app.id } }))).toEqual(
      { family: 'claude', model: 'claude-opus-5-5', effort: null, accountProfile: 'worker' });
  });

  it('the workdir and host id keep their own code', async () => {
    expect(await code(assign({ workdir: '../x' }))).toBe('BAD_HOST_ASSIGNMENT_ARGS');
    expect(await code(assign({ hostId: '-x' }))).toBe('BAD_HOST_ASSIGNMENT_ARGS');
  });

  it('the database refuses a profile value that is not a token', async () => {
    const base = { id: generateId(), appId: app.id, hostId: 'orca1', workerId: kit.id, workdir: 'hadron-server/kit', family: 'claude', createdByUserId: manager.id };
    await expect(db.hostWorkerAssignment.create({ data: { ...base, effort: 'a b' } })).rejects.toThrow();
    await expect(db.hostWorkerAssignment.create({ data: { ...base, accountProfile: 'a/b' } })).rejects.toThrow();
    await expect(db.hostWorkerAssignment.create({ data: { ...base, accountProfile: '-x' } })).rejects.toThrow();
    expect(await db.hostWorkerAssignment.count()).toBe(0);
  });
});

describe('acceptance 3: worker.start carries the profile tokens and no command', () => {
  const task = async () => {
    await M.createAgentTask({}, { input: { appRef: app.id, title: 'Work', assignee: { worker: kit.id }, closeSessionWhenDone: false } }, ctx(manager.id));
    return db.hostOperation.findFirst({ where: { workerId: kit.id, type: 'worker.start' } });
  };
  const hostLists = () => register(orca1, [{ worker: 'Kit', family: 'claude', worktrees: ['hadron-server/kit'] }]);

  it("SERVER: the platform's start carries exactly the assignment's profile, and the database accepts it", async () => {
    await assign({ effort: 'high' });
    await setSource('SERVER');
    await hostLists();
    const op = await task();
    expect(op!.args).toEqual({ workerId: kit.id, worktree: 'hadron-server/kit', family: 'claude', model: 'claude-opus-5-5', effort: 'high', accountProfile: 'worker', taskId: expect.any(String) });
  });

  it('SERVER: a field the assignment leaves unset is not in the start', async () => {
    await assign({ model: null, accountProfile: null });
    await setSource('SERVER');
    await hostLists();
    const op = await task();
    expect(Object.keys(op!.args as object).sort()).toEqual(['family', 'taskId', 'workerId', 'worktree']);
  });

  it("SERVER: a manager's own start carries the assignment's profile; a caller never passes one", async () => {
    await assign({ effort: 'low' });
    await setSource('SERVER');
    await hostLists();
    const start = (args: Record<string, unknown>) =>
      M.issueHostOperation({}, { input: { appRef: app.id, hostId: 'orca1', worker: kit.id, type: 'worker.start', args } }, ctx(manager.id));
    for (const extra of [{ model: 'claude-opus-5-5' }, { accountProfile: 'worker' }, { effort: 'low' }, { command: 'claude' }]) {
      expect(await code(start({ worktree: 'hadron-server/kit', family: 'claude', ...extra })), JSON.stringify(extra)).toBe('BAD_HOST_OPERATION_ARGS');
    }
    const op = await start({ worktree: 'hadron-server/kit', family: 'claude' });
    expect(op.args).toEqual({ workerId: kit.id, worktree: 'hadron-server/kit', family: 'claude', model: 'claude-opus-5-5', effort: 'low', accountProfile: 'worker' });
  });

  it('HOST (the default): a start carries no profile, whatever the assignment says', async () => {
    await assign({ effort: 'high' });
    await hostLists();
    const op = await task();
    expect(Object.keys(op!.args as object).sort()).toEqual(['family', 'taskId', 'workerId', 'worktree']);
  });

  it("the database's check on host-operation args admits the profile tokens and nothing else", async () => {
    const base = { id: generateId(), appId: app.id, hostId: 'orca1', type: 'worker.start', workerId: kit.id, issuedBy: 'platform' };
    const args = { workerId: kit.id, worktree: 'hadron-server/kit', family: 'claude' };
    await expect(db.hostOperation.create({ data: { ...base, args: { ...args, model: 'claude-opus-5-5', effort: 'high', accountProfile: 'worker' } } })).resolves.toBeTruthy();
    for (const bad of [{ accountProfile: 'a b' }, { model: 'a/b' }, { effort: '$(id)' }, { command: 'claude' }, { accountProfile: 1 }]) {
      await expect(db.hostOperation.create({ data: { ...base, id: generateId(), args: { ...args, ...bad } } }), JSON.stringify(bad)).rejects.toThrow();
    }
  });
});

describe("acceptance 4: a host key reads its own host's profiles only", () => {
  it("orca2's key reads none of orca1's profiles, asked or not; orca1's reads its own", async () => {
    await assign();
    await assign({ hostId: 'orca2', workdir: 'kit-two', accountProfile: 'other' });
    expect((await setup(keyCtx(orca1))).assignments.map((a: any) => [a.hostId, a.accountProfile])).toEqual([['orca1', 'worker']]);
    expect((await setup(keyCtx(orca2))).assignments.map((a: any) => [a.hostId, a.accountProfile])).toEqual([['orca2', 'other']]);
    expect((await setup(keyCtx(orca2), 'orca1')).assignments).toEqual([]);
  });
});
