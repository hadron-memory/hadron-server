import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
/**
 * #2198 — typed WARNINGS on task create / assign / reassign / finish, resolved through the App's register.
 *
 * Every shipped code is pinned both ways (fires / does not), the call still succeeds, the register resolves through
 * the right chains, and the carrier keeps aliases apart, caps deterministically and never decorates a failure.
 */
import { ApolloServer } from '@apollo/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
import { taskWarningsPlugin } from '../taskWarningsPlugin.js';
import {
  boundedRead, emitTaskWarnings, renderTaskWarnings, resolveRegisters, shapeResponseWarnings,
  MAX_WARNINGS_PER_OPERATION, MAX_WARNINGS_PER_RESPONSE, type TaskWarning, type TaskWarningCode,
} from './resolvers.taskWarnings.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const hooks: { afterCommit: (() => Promise<void>) | null } = { afterCommit: null };
vi.mock('../../../lib/hostOperations/launch.js', async (orig) => ({
  ...(await orig<typeof import('../../../lib/hostOperations/launch.js')>()),
  launchForAssignment: async (...a: unknown[]) => {
    await hooks.afterCommit?.();
    return (await orig<typeof import('../../../lib/hostOperations/launch.js')>()).launchForAssignment(...(a as [never, never]));
  },
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const M = resolvers.Mutation as any;

let org: { id: string; urn: string };
let admin: { id: string };
let member: { id: string };
let outsider: { id: string };
let app: { id: string };
let teamAgentId: string;
let teamMemoryId: string;
let teamMemoryUrn: string;
let anne: { id: string };
let liam: { id: string };
let rook: { id: string };

const ctx = (userId: string): Context => ({ db, userId, roles: ['READER'] });
const asWorker = (w: { id: string }, agentId: string | null, fn: () => Promise<any>) => runAsActor({ workerId: w.id, agentId }, fn);
const create = (c: Context, input: Record<string, unknown>) =>
  M.createAgentTask({}, { input: { appRef: app.id, title: 'Fix the widget', source: 'https://example.test/1', ...input } }, c);
const codes = (c: Context) => (c.taskWarnings ?? []).map((w) => w.warning.code);
const worker = (name: string, agentId = teamAgentId) =>
  db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId, name, slug: name.toLowerCase() }, select: { id: true } });

async function node(memoryId: string, loc: string, extra: Record<string, unknown> = {}) {
  return db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, content: '# x', ...extra } });
}
const registerEntry = (memoryId: string, code: string, taskLoc: unknown, entryCode: string = code) =>
  node(memoryId, `register:${code}`, { data: { registerEntry: { code: entryCode, taskLoc } } });

beforeEach(async () => {
  await cleanDb(db);
  const suffix = generateId().toLowerCase();
  org = await db.organization.create({ data: { id: generateId(), name: 'tw-org', urn: `tw-${suffix}.example` } });
  admin = await db.user.create({ data: { githubId: 218001, githubUsername: 'tw-admin', handle: 'tw-admin', roles: ['READER'] } });
  member = await db.user.create({ data: { githubId: 218002, githubUsername: 'tw-member', handle: 'tw-member', roles: ['READER'] } });
  outsider = await db.user.create({ data: { githubId: 218003, githubUsername: 'tw-out', handle: 'tw-out', roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  const agent = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(admin.id));
  teamAgentId = agent.id;
  const row = await db.agent.findUniqueOrThrow({ where: { id: teamAgentId } });
  teamMemoryId = row.systemMemoryId as string;
  teamMemoryUrn = (await db.memory.findUniqueOrThrow({ where: { id: teamMemoryId } })).urn;
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  await db.appMember.create({ data: { appId: app.id, userId: member.id, role: 'member' } });
  await db.appAgent.create({ data: { appId: app.id, agentId: teamAgentId } });
  await node(teamMemoryId, 'roles'); // the Team Agent marker (locateTeamAgent)
  anne = await worker('Anne');
  liam = await worker('Liam');
  rook = await worker('Rook');
});

describe('task.create.no-source', () => {
  it('fires on a create with no source (blank counts), still creates, and not when a source is given', async () => {
    for (const source of [undefined, '', '   ']) {
      const c = ctx(member.id);
      const t = await create(c, { source });
      expect(t.id).toBeTruthy();
      expect(codes(c)).toEqual(['task.create.no-source']);
    }
    const c = ctx(member.id);
    await create(c, { source: 'https://example.test/x' });
    expect(codes(c)).toEqual([]);
  });
});

describe('assignee warnings (create-with-assignee, assign, reassign)', () => {
  it('busy: another open task for the assignee; none for a free worker; the task itself is excluded on reassign', async () => {
    await create(ctx(member.id), { assignee: { worker: anne.id } });
    const busy = ctx(member.id);
    await create(busy, { assignee: { worker: anne.id } });
    expect(codes(busy)).toEqual(['task.assign.assignee-busy']);
    const free = ctx(member.id);
    await create(free, { assignee: { worker: liam.id } });
    expect(codes(free)).toEqual([]);
    // reassign Anne's task to Liam (who now has one): busy for Liam because of the OTHER task, not this one
    const t = await create(ctx(member.id), { assignee: { worker: rook.id } });
    const r = ctx(member.id);
    await M.reassignAgentTask({}, { taskId: t.id, assignee: { worker: liam.id } }, r);
    expect(codes(r)).toEqual(['task.assign.assignee-busy']);
  });

  it('unavailable: the assignee\'s own record in effect (and not once its until has passed)', async () => {
    await db.workerAvailability.create({ data: { workerId: anne.id, state: 'unavailable', reason: 'other', setAt: new Date(), setBy: 'app-manager', setByUserId: admin.id } });
    const c = ctx(member.id);
    const t = await create(c, { assignee: { worker: anne.id } });
    expect(t.assigneeWorkerId).toBe(anne.id);
    expect(codes(c)).toEqual(['task.assign.assignee-unavailable']);
    await db.workerAvailability.update({ where: { workerId: anne.id }, data: { until: new Date(Date.now() - 1000) } });
    const c2 = ctx(member.id);
    await create(c2, { assignee: { worker: anne.id } });
    expect(codes(c2)).toEqual(['task.assign.assignee-busy']); // lapsed record ⇒ not unavailable; Anne has an open task now
  });

  it('paused: the assignee\'s own pause (the roster fact), via assign of a queued task', async () => {
    await db.workerWakeSettings.create({ data: { workerId: liam.id, pausedUntil: new Date(Date.now() + 3_600_000) } });
    const queued = await create(ctx(member.id), {});
    // No live session ⇒ the roster shows NO_SESSION, not PAUSED ⇒ no warning (the pause stays private).
    const quiet = ctx(member.id);
    await M.assignAgentTask({}, { taskId: queued.id, assignee: { worker: liam.id } }, quiet);
    expect(codes(quiet)).toEqual([]);
    // With a live session the roster shows PAUSED to a participant ⇒ the warning.
    await db.session.create({ data: { id: generateId(), userId: member.id, appId: app.id, workerId: rook.id, agentId: teamAgentId } });
    await db.session.create({ data: { id: generateId(), userId: member.id, appId: app.id, workerId: liam.id, agentId: teamAgentId } });
    const queued2 = await create(ctx(member.id), {});
    const c = ctx(member.id);
    const t = await M.assignAgentTask({}, { taskId: queued2.id, assignee: { worker: liam.id } }, c);
    expect(t.assigneeWorkerId).toBe(liam.id);
    expect(codes(c)).toContain('task.assign.assignee-paused');
  });

  it('several fire together in the fixed order (unavailable, busy)', async () => {
    await db.workerAvailability.create({ data: { workerId: anne.id, state: 'unavailable', reason: 'other', setAt: new Date(), setBy: 'app-manager', setByUserId: admin.id } });
    await create(ctx(member.id), { assignee: { worker: anne.id } });
    const c = ctx(member.id);
    await create(c, { source: undefined, assignee: { worker: anne.id } });
    expect(codes(c)).toEqual(['task.create.no-source', 'task.assign.assignee-unavailable', 'task.assign.assignee-busy']);
  });

  it('a worker taking work for itself, and a user assignee, are not advised', async () => {
    await create(ctx(member.id), { assignee: { worker: anne.id } });
    const self = ctx(member.id);
    await asWorker(anne, teamAgentId, () => create(self, { assignee: { worker: anne.id } }));
    expect(codes(self)).toEqual([]);
    const user = ctx(member.id);
    await create(user, { assignee: { user: member.id } });
    expect(codes(user)).toEqual([]);
  });

  it('a caller the roster would not show the facts to gets none of the three (the others stay)', async () => {
    const c = ctx(outsider.id);
    await emitTaskWarnings(c, undefined, app.id, {
      codes: ['task.create.no-source', 'task.assign.assignee-busy', 'task.assign.assignee-unavailable', 'task.assign.assignee-paused'],
    });
    expect(codes(c)).toEqual(['task.create.no-source']);
    // a participant passes the same gate and gets all four, in the fixed order
    const ok = ctx(member.id);
    await emitTaskWarnings(ok, undefined, app.id, {
      codes: ['task.assign.assignee-paused', 'task.assign.assignee-busy', 'task.create.no-source', 'task.assign.assignee-unavailable'],
    });
    expect(codes(ok)).toEqual(['task.create.no-source', 'task.assign.assignee-unavailable', 'task.assign.assignee-busy', 'task.assign.assignee-paused']);
  });
});

describe('task.finish.open-children', () => {
  it('fires on finish with an open child, the finish still succeeds; none once the child is done', async () => {
    const parent = await create(ctx(member.id), { assignee: { worker: anne.id } });
    await asWorker(anne, teamAgentId, () => M.startAgentTask({}, { taskId: parent.id }, ctx(member.id)));
    const child = await asWorker(anne, teamAgentId, () => M.createAgentTask({}, { input: { parentTaskId: parent.id, title: 'child', source: 's' } }, ctx(member.id)));
    const c = ctx(member.id);
    const done = await asWorker(anne, teamAgentId, () => M.finishAgentTask({}, { taskId: parent.id, result: { outcome: 'succeeded' } }, c));
    expect(done.status).toBe('finished');
    expect(codes(c)).toEqual(['task.finish.open-children']);
    // control: a childless task finishes quietly
    const solo = await create(ctx(member.id), { assignee: { worker: liam.id } });
    await asWorker(liam, teamAgentId, () => M.startAgentTask({}, { taskId: solo.id }, ctx(member.id)));
    const c2 = ctx(member.id);
    await asWorker(liam, teamAgentId, () => M.finishAgentTask({}, { taskId: solo.id, result: { outcome: 'succeeded' } }, c2));
    expect(codes(c2)).toEqual([]);
    expect(child.id).toBeTruthy();
  });

  it('a refused finish carries no warning', async () => {
    const t = await create(ctx(member.id), { assignee: { worker: anne.id } }); // not started
    const c = ctx(member.id);
    await expect(asWorker(anne, teamAgentId, () => M.finishAgentTask({}, { taskId: t.id, result: { outcome: 'succeeded' } }, c))).rejects.toThrow();
    expect(codes(c)).toEqual([]);
  });
});

describe('the register: code → role task, through the right chains', () => {
  const finishWarning = (): TaskWarningCode[] => ['task.finish.open-children'];

  it('mapped: the Team Agent\'s entry, the task found through the CALLER Agent\'s chain, a runnable live node', async () => {
    await registerEntry(teamMemoryId, 'task.finish.open-children', 'tasks:finish');
    await node(teamMemoryId, 'tasks:finish', { isRunnable: true });
    const out = await asWorker(anne, teamAgentId, () => resolveRegisters(ctx(member.id), app.id, finishWarning()));
    expect(out.get('task.finish.open-children')).toEqual({
      state: 'mapped', taskLoc: 'tasks:finish', taskUrn: `hrn:node:${teamMemoryUrn}:tasks:finish`,
    });
  });

  it('an extended Agent\'s own task wins by depth; the register itself still comes from the Team Agent', async () => {
    await registerEntry(teamMemoryId, 'task.finish.open-children', 'tasks:finish');
    await node(teamMemoryId, 'tasks:finish', { isRunnable: true });
    const child = await M.createAgent({}, { orgId: org.id, name: 'Child Role' }, ctx(admin.id));
    const childRow = await db.agent.findUniqueOrThrow({ where: { id: child.id } });
    const childMemUrn = (await db.memory.findUniqueOrThrow({ where: { id: childRow.systemMemoryId as string } })).urn;
    await db.agent.update({ where: { id: child.id }, data: { extendsAgentId: teamAgentId } });
    await db.appAgent.create({ data: { appId: app.id, agentId: child.id } }); // a cast worker's Agent is installed in its App
    await node(childRow.systemMemoryId as string, 'tasks:finish', { isRunnable: true });
    // The caller must be able to read the child's definition under the canonical gate: an org admin can, and so can
    // an App member, because the child is installed and licensed in this App (#2206 case 3, cor:acl:010:01).
    const out = await asWorker(anne, child.id, () => resolveRegisters(ctx(admin.id), app.id, finishWarning()));
    const member_ = await asWorker(anne, child.id, () => resolveRegisters(ctx(member.id), app.id, finishWarning()));
    for (const r of [out, member_]) {
      expect(r.get('task.finish.open-children')).toMatchObject({ state: 'mapped', taskUrn: `hrn:node:${childMemUrn}:tasks:finish` });
    }
  });

  /** #2206 case 3: a second installed Agent extending the Team Agent, with its own runnable role task. */
  async function nonPrimaryChild(opts: { orgId?: string; install?: boolean; name?: string } = {}) {
    if (!(await db.node.count({ where: { memoryId: teamMemoryId, loc: 'tasks:finish' } }))) {
      await registerEntry(teamMemoryId, 'task.finish.open-children', 'tasks:finish');
      await node(teamMemoryId, 'tasks:finish', { isRunnable: true });
    }
    const childOrg = opts.orgId ?? org.id;
    let creator = admin.id;
    if (childOrg !== org.id) {
      const foreignAdmin = await db.user.create({ data: { githubId: 218099, githubUsername: 'tw-foreign', handle: 'tw-foreign', roles: ['READER'] } });
      await db.orgMember.create({ data: { organizationId: childOrg, userId: foreignAdmin.id, role: 'ADMIN' } });
      creator = foreignAdmin.id;
    }
    const child = await M.createAgent({}, { orgId: childOrg, name: opts.name ?? 'Child Role' }, ctx(creator));
    const childRow = await db.agent.findUniqueOrThrow({ where: { id: child.id } });
    await db.agent.update({ where: { id: child.id }, data: { extendsAgentId: teamAgentId } });
    if (opts.install ?? true) await db.appAgent.create({ data: { appId: app.id, agentId: child.id } });
    await node(childRow.systemMemoryId as string, 'tasks:finish', { isRunnable: true });
    return { id: child.id, memoryId: childRow.systemMemoryId as string };
  }

  it('#2206 case 3: an org CONTRIBUTOR who is not an App member maps through the App, for the primary and a second Agent', async () => {
    const contributor = await db.user.create({ data: { githubId: 218004, githubUsername: 'tw-contrib', handle: 'tw-contrib', roles: ['READER'] } });
    await db.orgMember.create({ data: { organizationId: org.id, userId: contributor.id, role: 'CONTRIBUTOR' } });
    const child = await nonPrimaryChild();
    const primary = await asWorker(anne, teamAgentId, () => resolveRegisters(ctx(contributor.id), app.id, finishWarning()));
    const second = await asWorker(anne, child.id, () => resolveRegisters(ctx(contributor.id), app.id, finishWarning()));
    expect(primary.get('task.finish.open-children')?.state).toBe('mapped');
    expect(second.get('task.finish.open-children')?.state).toBe('mapped');
    // An org READER who is not an App member does not participate: the Team Agent's entry is not readable.
    const reader = await db.user.create({ data: { githubId: 218005, githubUsername: 'tw-reader', handle: 'tw-reader', roles: ['READER'] } });
    await db.orgMember.create({ data: { organizationId: org.id, userId: reader.id, role: 'READER' } });
    expect((await asWorker(anne, child.id, () => resolveRegisters(ctx(reader.id), app.id, finishWarning()))).get('task.finish.open-children')).toEqual({ state: 'unmapped' });
  });

  it('#2206 case 3: no license, no install, or an uninstalled App: the second Agent stays unresolved (fixed text, no loc)', async () => {
    const other = await db.organization.create({ data: { id: generateId(), name: 'tw-other', urn: `two-${generateId().toLowerCase()}.example` } });
    const foreign = await nonPrimaryChild({ orgId: other.id }); // installed, but a foreign Agent with no org grant: unlicensed
    expect((await asWorker(anne, foreign.id, () => resolveRegisters(ctx(member.id), app.id, finishWarning()))).get('task.finish.open-children')).toEqual({ state: 'unresolved' });
    await db.appAgent.deleteMany({ where: { agentId: foreign.id } });
    const notInstalled = await nonPrimaryChild({ install: false, name: 'Loose Role' });
    expect((await asWorker(anne, notInstalled.id, () => resolveRegisters(ctx(member.id), app.id, finishWarning()))).get('task.finish.open-children')).toEqual({ state: 'unresolved' });
  });

  it('unmapped: no entry, a malformed entry, or an entry for another code', async () => {
    const run = () => asWorker(anne, teamAgentId, () => resolveRegisters(ctx(member.id), app.id, finishWarning()));
    expect((await run()).get('task.finish.open-children')).toEqual({ state: 'unmapped' });
    await registerEntry(teamMemoryId, 'task.finish.open-children', 'tasks:finish', 'task.create.no-source');
    expect((await run()).get('task.finish.open-children')).toEqual({ state: 'unmapped' });
    await db.node.deleteMany({ where: { memoryId: teamMemoryId, loc: 'register:task.finish.open-children' } });
    await registerEntry(teamMemoryId, 'task.finish.open-children', '   ');
    expect((await run()).get('task.finish.open-children')).toEqual({ state: 'unmapped' });
  });

  it('unresolved: an entry whose task is absent, not runnable, or deleted (no loc is revealed)', async () => {
    await registerEntry(teamMemoryId, 'task.finish.open-children', 'tasks:finish');
    const run = () => asWorker(anne, teamAgentId, () => resolveRegisters(ctx(member.id), app.id, finishWarning()));
    expect((await run()).get('task.finish.open-children')).toEqual({ state: 'unresolved' });
    const n = await node(teamMemoryId, 'tasks:finish', { isRunnable: false });
    expect((await run()).get('task.finish.open-children')).toEqual({ state: 'unresolved' });
    await db.node.update({ where: { id: n.id }, data: { isRunnable: true, deletedAt: new Date() } });
    expect((await run()).get('task.finish.open-children')).toEqual({ state: 'unresolved' });
  });

  it('the caller must be able to READ both the register entry and the role task: an unreadable one is withheld', async () => {
    await registerEntry(teamMemoryId, 'task.finish.open-children', 'tasks:finish');
    await node(teamMemoryId, 'tasks:finish', { isRunnable: true });
    // outsider has no standing in the org or App: neither node is readable by them
    const out = await asWorker(anne, teamAgentId, () => resolveRegisters(ctx(outsider.id), app.id, finishWarning()));
    expect(out.get('task.finish.open-children')).toEqual({ state: 'unmapped' });
    // positive control: an App participant reads the same
    const ok = await asWorker(anne, teamAgentId, () => resolveRegisters(ctx(member.id), app.id, finishWarning()));
    expect(ok.get('task.finish.open-children')?.state).toBe('mapped');
  });

  it('no Agent ⇒ no register field: a person, an ambiguous binding (worker without agent)', async () => {
    await registerEntry(teamMemoryId, 'task.finish.open-children', 'tasks:finish');
    await node(teamMemoryId, 'tasks:finish', { isRunnable: true });
    const spy = vi.spyOn(db, '$transaction');
    expect((await resolveRegisters(ctx(member.id), app.id, finishWarning())).size).toBe(0);
    expect((await asWorker(anne, null, () => resolveRegisters(ctx(member.id), app.id, finishWarning()))).size).toBe(0);
    // Not even a lookup is attempted without an Agent: nothing is read on a borrowed identity.
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('no Team Agent, or two, ⇒ unmapped (never a guess, never a failure)', async () => {
    const other = await M.createAgent({}, { orgId: org.id, name: 'Other Team' }, ctx(admin.id));
    const otherRow = await db.agent.findUniqueOrThrow({ where: { id: other.id } });
    await db.appAgent.create({ data: { appId: app.id, agentId: other.id } });
    await node(otherRow.systemMemoryId as string, 'roles');
    const out = await asWorker(anne, teamAgentId, () => resolveRegisters(ctx(member.id), app.id, finishWarning()));
    expect(out.get('task.finish.open-children')).toEqual({ state: 'unmapped' });
  });

  it('an install of a DIFFERENT App\'s Team Agent is never read: the register is the App\'s own', async () => {
    const foreignApp = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'F', urn: `${org.urn}:f` } });
    const out = await asWorker(anne, teamAgentId, () => resolveRegisters(ctx(member.id), foreignApp.id, finishWarning()));
    expect(out.get('task.finish.open-children')).toEqual({ state: 'unmapped' });
  });

  it('a lookup failure degrades to code + text: the warning is still filed, with no register', async () => {
    const spy = vi.spyOn(db, '$transaction').mockRejectedValueOnce(new Error('boom'));
    const c = ctx(member.id);
    await asWorker(anne, teamAgentId, () => emitTaskWarnings(c, undefined, app.id, { codes: ['task.create.no-source'] }));
    spy.mockRestore();
    expect(c.taskWarnings).toHaveLength(1);
    expect(c.taskWarnings![0].warning.register).toBeUndefined();
  });

  it('the lookup runs under a statement timeout (Postgres cancels it, nothing dangles)', async () => {
    await registerEntry(teamMemoryId, 'task.finish.open-children', 'tasks:finish');
    const seen: string[] = [];
    const orig = db.$transaction.bind(db) as any;
    const spy = vi.spyOn(db, '$transaction').mockImplementation(((fn: any, opts: any) =>
      orig(async (tx: any) => fn(new Proxy(tx, {
        get(target, key) {
          if (key === '$executeRawUnsafe') return (q: string, ...a: unknown[]) => { seen.push(q); return target.$executeRawUnsafe(q, ...a); };
          const v = target[key];
          return typeof v === 'function' ? v.bind(target) : v;
        },
      })), opts)) as any);
    await asWorker(anne, teamAgentId, () => resolveRegisters(ctx(member.id), app.id, finishWarning()));
    spy.mockRestore();
    expect(seen.join(' ')).toMatch(/SET LOCAL statement_timeout = 300/);
  });
});

describe('decided in the write transaction, bounded after it', () => {
  it('paused is the deciding snapshot: a pause lifted between the commit and the response still warns', async () => {
    await db.workerWakeSettings.create({ data: { workerId: liam.id, pausedUntil: new Date(Date.now() + 3_600_000) } });
    await db.session.create({ data: { id: generateId(), userId: member.id, appId: app.id, workerId: liam.id, agentId: teamAgentId } });
    hooks.afterCommit = async () => { await db.workerWakeSettings.update({ where: { workerId: liam.id }, data: { pausedUntil: null } }); };
    try {
      const c = ctx(member.id);
      await create(c, { assignee: { worker: liam.id } });
      expect(codes(c)).toContain('task.assign.assignee-paused');
    } finally { hooks.afterCommit = null; }
    // control: not paused at the decision ⇒ no warning even if a pause appears after it
    const c2 = ctx(member.id);
    hooks.afterCommit = async () => { await db.workerWakeSettings.update({ where: { workerId: liam.id }, data: { pausedUntil: new Date(Date.now() + 3_600_000) } }); };
    try {
      await create(c2, { assignee: { worker: liam.id } });
      expect(codes(c2)).not.toContain('task.assign.assignee-paused');
    } finally { hooks.afterCommit = null; }
  });

  it('a failing enrichment keeps the fixed-text codes and drops the privacy-gated facts (fail closed)', async () => {
    const spy = vi.spyOn(db, '$transaction').mockRejectedValue(new Error('boom'));
    const c = ctx(member.id);
    try {
      await emitTaskWarnings(c, undefined, app.id, { codes: ['task.create.no-source', 'task.assign.assignee-busy', 'task.finish.open-children'] });
    } finally { spy.mockRestore(); }
    expect(codes(c)).toEqual(['task.create.no-source', 'task.finish.open-children']);
    expect(c.taskWarnings!.every((w) => w.warning.register === undefined)).toBe(true);
  });

  it('a request that spent its read budget files only fixed text, with no further read', async () => {
    const c = ctx(member.id);
    c.taskWarningState = { spentMs: 10_000, gate: new Map(), registers: new Map(), team: new Map() };
    const spy = vi.spyOn(db, '$transaction');
    await emitTaskWarnings(c, undefined, app.id, { codes: ['task.create.no-source', 'task.assign.assignee-busy'] });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    expect(codes(c)).toEqual(['task.create.no-source']);
  });

  it('a full response does no more work: nothing is read for a warning that cannot be sent', async () => {
    const c = ctx(member.id);
    c.taskWarnings = Array.from({ length: MAX_WARNINGS_PER_RESPONSE }, () => ({ path: 'p', warning: { code: 'task.create.no-source' as const, text: 't' } }));
    const spy = vi.spyOn(db, '$transaction');
    await asWorker(anne, teamAgentId, () => emitTaskWarnings(c, undefined, app.id, { codes: ['task.assign.assignee-busy', 'task.finish.open-children'] }));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    expect(c.taskWarnings).toHaveLength(MAX_WARNINGS_PER_RESPONSE);
  });

  it('Postgres really cancels a slow statement, and the connection is reusable', async () => {
    const t0 = Date.now();
    await expect(boundedRead(ctx(member.id), (tx) => tx.$queryRaw`SELECT pg_sleep(2)`)).rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(await db.$queryRaw`SELECT 1 AS one`).toEqual([{ one: 1 }]);
  });

  it('21 aliased creates in one worker request: all succeed, 20 warnings, one enrichment read plus one history write (no per-alias work)', async () => {
    await registerEntry(teamMemoryId, 'task.create.no-source', 'tasks:a');
    await node(teamMemoryId, 'tasks:a', { isRunnable: true });
    const server = new ApolloServer<Context>({ typeDefs, resolvers, plugins: [taskWarningsPlugin] });
    const body = Array.from({ length: 21 }, (_, i) => `a${i}: createAgentTask(input: { appRef: "${app.id}", title: "t${i}" }) { id }`).join(' ');
    const spy = vi.spyOn(db, '$transaction');
    const before = spy.mock.calls.length;
    const res = await asWorker(anne, teamAgentId, () => server.executeOperation({ query: `mutation { ${body} }` }, { contextValue: ctx(member.id) }));
    const bounded = spy.mock.calls.slice(before).filter((c) => (c[1] as { timeout?: number } | undefined)?.timeout === 1500);
    spy.mockRestore();
    if (res.body.kind !== 'single') throw new Error('single expected');
    expect(res.body.singleResult.errors).toBeUndefined();
    expect(Object.keys(res.body.singleResult.data as object)).toHaveLength(21);
    const warnings = res.body.singleResult.extensions?.warnings as { path: string; register?: { state: string } }[];
    expect(warnings).toHaveLength(MAX_WARNINGS_PER_RESPONSE);
    expect(warnings[0].register?.state).toBe('mapped');
    expect(bounded).toHaveLength(2); // one shared enrichment transaction plus one bounded history transaction
  });
});

describe('order and the aggregate lookup bound', () => {
  it('emission puts codes in the fixed order whatever order they were decided in', async () => {
    const c = ctx(member.id);
    await emitTaskWarnings(c, undefined, app.id, { codes: ['task.finish.open-children', 'task.create.no-source'] });
    expect(codes(c)).toEqual(['task.create.no-source', 'task.finish.open-children']);
  });

  it('past the total budget the remaining codes carry no register (the aggregate is bounded)', async () => {
    await registerEntry(teamMemoryId, 'task.create.no-source', 'tasks:a');
    await node(teamMemoryId, 'tasks:a', { isRunnable: true });
    await registerEntry(teamMemoryId, 'task.finish.open-children', 'tasks:b');
    await node(teamMemoryId, 'tasks:b', { isRunnable: true });
    const real = Date.now.bind(Date);
    let calls = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => (++calls <= 2 ? real() : real() + 60_000));
    const out = await asWorker(anne, teamAgentId, () =>
      resolveRegisters(ctx(member.id), app.id, ['task.create.no-source', 'task.finish.open-children']));
    clock.mockRestore();
    expect(out.get('task.create.no-source')?.state).toBe('mapped');
    expect(out.has('task.finish.open-children')).toBe(false);
  });
});

describe('the carrier: extensions.warnings on a real GraphQL response', () => {
  const server = new ApolloServer<Context>({ typeDefs, resolvers, plugins: [taskWarningsPlugin] });
  const run = async (query: string, contextValue: Context) => {
    const res = await server.executeOperation({ query }, { contextValue });
    if (res.body.kind !== 'single') throw new Error('single expected');
    return res.body.singleResult;
  };
  const m = (alias: string, title: string, source = '') =>
    `${alias}: createAgentTask(input: { appRef: "${app.id}", title: "${title}"${source ? `, source: "${source}"` : ''} }) { id }`;

  it('two aliased mutations keep their warnings apart; a clean one carries none; data is unchanged', async () => {
    const r = await run(`mutation { a1: ${m('a1', 'one').split(': ').slice(1).join(': ')} a2: ${m('a2', 'two', 'src').split(': ').slice(1).join(': ')} }`, ctx(member.id));
    expect(r.errors).toBeUndefined();
    expect((r.data as any).a1.id).toBeTruthy();
    expect(r.extensions?.warnings).toEqual([
      { path: 'a1', code: 'task.create.no-source', text: expect.any(String) },
    ]);
  });

  it('a failed mutation in the same request carries no warning while another keeps hers', async () => {
    const bad = `bad: createAgentTask(input: { appRef: "${generateId()}", title: "x" }) { id }`;
    const good = m('good', 'g').split(': ').slice(1).join(': ');
    const r = await run(`mutation { good: ${good} ${bad} }`, ctx(member.id));
    expect(r.errors?.length).toBe(1);
    expect((r.extensions?.warnings as any[]).map((w) => w.path)).toEqual(['good']);
  });

  it('two concurrent requests never share a collector', async () => {
    const [x, y] = await Promise.all([
      run(`mutation { x: ${m('x', 'x').split(': ').slice(1).join(': ')} }`, ctx(member.id)),
      run(`mutation { y: ${m('y', 'y', 's').split(': ').slice(1).join(': ')} }`, ctx(member.id)),
    ]);
    expect((x.extensions?.warnings as any[]).map((w) => w.path)).toEqual(['x']);
    expect(y.extensions?.warnings).toBeUndefined();
  });

  it('an ordinary request with no warning has no extensions.warnings (ordinary-client regression)', async () => {
    const r = await run(`mutation { ${m('ok', 'ok', 's').split(': ').slice(1).join(': ')} }`, ctx(member.id));
    expect(r.errors).toBeUndefined();
    expect(r.extensions?.warnings).toBeUndefined();
  });
});

describe('shaping and rendering', () => {
  const w = (code: TaskWarningCode): TaskWarning => ({ code, text: code });
  it('caps per operation and per response deterministically, in recorded order; an errored path carries none', () => {
    const one = Array.from({ length: 8 }, () => ({ path: 'a', warning: w('task.create.no-source') }));
    expect(shapeResponseWarnings(one, new Set())).toHaveLength(MAX_WARNINGS_PER_OPERATION);
    const many = Array.from({ length: 6 }, (_, i) => Array.from({ length: 5 }, () => ({ path: `p${i}`, warning: w('task.create.no-source') }))).flat();
    expect(shapeResponseWarnings(many, new Set())).toHaveLength(MAX_WARNINGS_PER_RESPONSE);
    expect(shapeResponseWarnings(many, new Set(['p0', 'p1'])).every((x) => x.path !== 'p0' && x.path !== 'p1')).toBe(true);
  });

  it('MCP rendering lists the same warnings in the same order, with the mapped task when there is one', () => {
    const text = renderTaskWarnings([
      { warning: { code: 'task.create.no-source', text: 'T1' } },
      { warning: { code: 'task.finish.open-children', text: 'T2', register: { state: 'mapped', taskLoc: 'l', taskUrn: 'hrn:node:x:l' } } },
    ]);
    expect(text).toBe('\n\nWarning [task.create.no-source]: T1\nWarning [task.finish.open-children]: T2 → hrn:node:x:l');
    expect(renderTaskWarnings(undefined)).toBe('');
  });
});
