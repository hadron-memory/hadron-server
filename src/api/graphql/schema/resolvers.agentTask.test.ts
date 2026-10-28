import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
/**
 * #1705 — agent tasks (Task Management T1): authorization matrix, lifecycle,
 * events and the read gate.
 *
 * One case per PRINCIPAL SHAPE for each act, plus every Scenario of the specs
 * #1705 implements (cor:agt:050:02, :05–:09, :21). A worker acts through its
 * session: the request's validated binding publishes the Worker as the #1610
 * actor (auth middleware `bindSession` / the MCP `session` argument), which
 * these tests reproduce with `runAsActor` — the same holder the middleware
 * fills.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { resolvers, type Context } from './resolvers.js';
import { isAppParticipant } from './resolvers.helpers.js';
import { mergeUsers } from '../../../test/mergeConsent.js';
import { lockAuthorityAnchors } from '../../../lib/auth/authorityAnchors.js';
import { ownerChain } from '../../../lib/agentTasks/stall.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
const F = resolvers as any;

function ctx(userId?: string, extra: Partial<Context> = {}): Context {
  return { db, userId, roles: ['READER'], ...extra };
}

async function expectCode(p: Promise<unknown>, code: string) {
  try {
    await p;
    expect.fail(`expected rejection with extensions.code=${code}`);
  } catch (e) {
    expect(e).toBeInstanceOf(GraphQLError);
    expect((e as GraphQLError).extensions?.code).toBe(code);
  }
}

let org: { id: string; urn: string };
let admin: { id: string };
let contrib: { id: string };
let member: { id: string; handle: string };
let reader: { id: string };
let appOwnerMember: { id: string };
let outsider: { id: string };
let teamAgent: { id: string };
let app: { id: string; urn: string };
let otherApp: { id: string; urn: string };
let anne: { id: string };
let liam: { id: string };
let rook: { id: string };
let zed: { id: string };
let retired: { id: string };

/** Run `fn` as `worker` acting through its session (the #1610 binding), with `userId` as the credential. */
const asWorker = (worker: { id: string }, fn: () => Promise<any>): Promise<any> =>
  runAsActor({ workerId: worker.id, agentId: teamAgent.id }, fn);

const create = (c: Context, input: Record<string, unknown>) =>
  M.createAgentTask({}, { input: { appRef: app.id, title: 'Fix the widget', ...input } }, c);

async function user(suffix: string, n: number, handle?: string) {
  return db.user.create({
    data: {
      id: generateId(), githubId: 97_000 + n, githubUsername: `at-${n}-${suffix}`, roles: ['READER'],
      ...(handle ? { handle } : {}),
    },
    select: { id: true, handle: true },
  });
}

async function worker(appId: string, name: string, extra: Record<string, unknown> = {}) {
  return db.worker.create({
    data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId, agentId: teamAgent.id, name, slug: name.toLowerCase(), ...extra },
    select: { id: true },
  });
}

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({ data: { id: generateId(), name: 'at-org', urn: `at-org-${suffix}.com` } });
  admin = await user(suffix, 1);
  contrib = await user(suffix, 2);
  member = await user(suffix, 3, `mia-${suffix.replace(/[^a-z0-9-]/gi, '')}`);
  reader = await user(suffix, 4);
  appOwnerMember = await user(suffix, 5);
  outsider = await user(suffix, 6);
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: contrib.id, role: 'CONTRIBUTOR' } });

  const created = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(admin.id));
  teamAgent = { id: created.id };
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  otherApp = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Other', urn: `${org.urn}:other` } });
  await db.appMember.create({ data: { appId: app.id, userId: member.id, role: 'member' } });
  await db.appMember.create({ data: { appId: app.id, userId: reader.id, role: 'reader' } });
  await db.appMember.create({ data: { appId: app.id, userId: appOwnerMember.id, role: 'owner' } });

  anne = await worker(app.id, 'Anne');
  liam = await worker(app.id, 'Liam');
  rook = await worker(app.id, 'Rook');
  zed = await worker(otherApp.id, 'Zed');
  retired = await worker(app.id, 'Old', { retiredAt: new Date() });
});

/** A task owned by `member`, assigned to worker Anne, optionally started. */
async function anneTask(opts: { start?: boolean; owner?: Context } = {}) {
  const t = await create(opts.owner ?? ctx(member.id), { assignee: { worker: anne.id } });
  if (opts.start) await asWorker(anne, () => M.startAgentTask({}, { taskId: t.id }, ctx(member.id)));
  return t;
}

const events = (taskId: string) =>
  db.agentTeamEvent.findMany({ where: { taskId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });

// ── Create a root task (cor:agt:050:06) ─────────────────────────────────────

describe('createAgentTask — root tasks: any App participant (cor:agt:050:06)', () => {
  it('S1: an AppMember creates a root task; it owns it, and task.created is written', async () => {
    const t = await create(ctx(member.id), {});
    expect(t.ownerUserId).toBe(member.id);
    expect(t.ownerWorkerId).toBeNull();
    expect(t.status).toBe('pending');
    expect(t.closeSessionWhenDone).toBe(false); // #2249 / R182: the session ends only when the assigner asks
    const ev = await events(t.id);
    // #1707: a task created with no assignee enters the queue.
    expect(ev.map((e) => e.type)).toEqual(['task.created', 'assignment.queued']);
    expect(ev[0].actorUserId).toBe(member.id);
  });

  it("a 'reader' AppMember participates too, and creates one", async () => {
    const t = await create(ctx(reader.id), {});
    expect(t.ownerUserId).toBe(reader.id);
  });

  it('an org CONTRIBUTOR with no AppMember row participates, and creates one', async () => {
    const t = await create(ctx(contrib.id), {});
    expect(t.ownerUserId).toBe(contrib.id);
  });

  it('S2: a person who is not a participant is refused, and nothing is created', async () => {
    // Concealed exactly like an absent App (#1713 review, Rook P3-1).
    await expectCode(create(ctx(outsider.id), {}), 'APP_NOT_FOUND');
    await expectCode(create(ctx(outsider.id), { appRef: generateId() }), 'APP_NOT_FOUND');
    expect(await db.agentTask.count()).toBe(0);
  });

  it('a pure App key is refused (cor:agt:050:21 open; #1705 interim)', async () => {
    await expectCode(create(ctx(undefined, { appId: app.id }), {}), 'APP_NOT_FOUND');
  });

  it('a worker acting through its session creates one and owns it (workers are participants, #7489)', async () => {
    const t = await asWorker(anne, () => create(ctx(member.id), {}));
    expect(t.ownerWorkerId).toBe(anne.id);
    expect(t.ownerUserId).toBeNull();
    expect(t.createdByWorkerId).toBe(anne.id);
    expect(t.createdBy).toBe(member.id);
  });

  it('INTERIM (050:21 unruled, Rook P2-1): an App key cannot act as a worker, even through a session of its App', async () => {
    await expectCode(asWorker(anne, () => create(ctx(undefined, { appId: app.id }), {})), 'APP_NOT_FOUND');
    const t = await create(ctx(member.id), {});
    expect(await asWorker(anne, () => Q.agentTask({}, { id: t.id }, ctx(undefined, { appId: app.id })))).toBeNull();
    expect(await db.agentTask.count({ where: { handle: { not: 'AT0' } } })).toBe(1);
  });

  it("a worker of another App is refused — even when its driver participates here", async () => {
    await expectCode(asWorker(zed, () => create(ctx(admin.id), {})), 'APP_NOT_FOUND');
  });

  it('a retired worker is refused', async () => {
    await expectCode(asWorker(retired, () => create(ctx(member.id), {})), 'APP_NOT_FOUND');
  });

  it('a request naming a session that did not validate is refused, not run as its driver', async () => {
    await expectCode(create(ctx(member.id, { sessionBindingRefused: true }), {}), 'SESSION_NOT_BOUND');
    expect(await db.agentTask.count()).toBe(0);
  });

  it('an uninstalled App refuses writes', async () => {
    await db.app.update({ where: { id: app.id }, data: { uninstalledAt: new Date() } });
    await expectCode(create(ctx(member.id), {}), 'APP_UNINSTALLED');
  });

  it('naming yourself as owner is always fine', async () => {
    const t = await create(ctx(member.id), { owner: { user: member.handle } });
    expect(t.ownerUserId).toBe(member.id);
  });

  it('#1757 (cor:agt:050:01, ruling #8183): a plain participant names another participating owner at create', async () => {
    const byMember = await create(ctx(member.id), { owner: { worker: 'Liam' } });
    expect(byMember.ownerWorkerId).toBe(liam.id);
    expect(byMember.ownerUserId).toBeNull();
    const byContrib = await create(ctx(contrib.id), { owner: { user: reader.id } });
    expect(byContrib.ownerUserId).toBe(reader.id);
  });

  it('#1757: a worker creating a root task names its owner too (workers participate via their session)', async () => {
    const t = await asWorker(anne, () => create(ctx(member.id), { owner: { worker: 'Liam' } }));
    expect(t.ownerWorkerId).toBe(liam.id);
    expect(t.createdByWorkerId).toBe(anne.id);
  });

  it('#1757∘#1764 compose: a user-owned App\'s member — a participant since #1786 — names and is named as owner', async () => {
    const uoOwner = await user(`uo-${Date.now()}`, 70);
    const uoMember = await user(`um-${Date.now()}`, 71);
    const uoApp = await db.app.create({
      data: { id: generateId(), ownerUserId: uoOwner.id, name: 'UO', urn: `uo${generateId().toLowerCase()}:app` },
    });
    await db.appMember.create({ data: { appId: uoApp.id, userId: uoMember.id, role: 'member' } });
    const mk = (c: Context, input: Record<string, unknown>) =>
      M.createAgentTask({}, { input: { appRef: uoApp.id, title: 't', ...input } }, c);
    expect((await mk(ctx(uoMember.id), { owner: { user: uoOwner.id } })).ownerUserId).toBe(uoOwner.id);
    expect((await mk(ctx(uoOwner.id), { owner: { user: uoMember.id } })).ownerUserId).toBe(uoMember.id);
  });

  it('#1757: the named owner appears in the task.created event and the alarm chain (B4)', async () => {
    const t = await create(ctx(member.id), { owner: { worker: 'Liam' } });
    const ev = await events(t.id);
    expect(ev[0].type).toBe('task.created');
    const payload = ev[0].payload as { owner: { workerId: string }; hasAssignee: boolean };
    expect(payload.owner).toEqual({ workerId: liam.id });
    expect(payload.hasAssignee).toBe(false);
    // The owner first; the App's managers follow (cor:agt:050:25, #1761).
    expect((await ownerChain(db, t.id))[0]).toEqual({ workerId: liam.id });
  });

  it("naming a non-participant, another App's worker, a retired worker or nobody at all answers TASK_OWNER_INVALID — the same refusal", async () => {
    await expectCode(create(ctx(member.id), { owner: { worker: zed.id } }), 'TASK_OWNER_INVALID');
    await expectCode(create(ctx(member.id), { owner: { user: outsider.id } }), 'TASK_OWNER_INVALID');
    await expectCode(create(ctx(member.id), { owner: { worker: retired.id } }), 'TASK_OWNER_INVALID');
    await expectCode(create(ctx(member.id), { owner: { worker: generateId() } }), 'TASK_OWNER_INVALID');
  });

  it('participant shapes that also manage the App name owners like any other participant', async () => {
    const byAdmin = await create(ctx(admin.id), { owner: { worker: 'Liam' } });
    expect(byAdmin.ownerWorkerId).toBe(liam.id);
    const byOwnerRole = await create(ctx(appOwnerMember.id), { owner: { user: member.id } });
    expect(byOwnerRole.ownerUserId).toBe(member.id);
    // The transaction re-reads platform roles from the user row, so the grant must be real.
    const platformAdmin = await user(`pa2-${Date.now()}`, 51);
    await db.user.update({ where: { id: platformAdmin.id }, data: { roles: ['ADMIN'] } });
    const byPlatform = await create(ctx(platformAdmin.id, { roles: ['ADMIN'] }), { owner: { user: member.id } });
    expect(byPlatform.ownerUserId).toBe(member.id);
  });

  it('#1731: a platform role the user row no longer carries does not make a non-participant one (a stale token)', async () => {
    const formerAdmin = await user(`pa3-${Date.now()}`, 52);
    await expectCode(create(ctx(formerAdmin.id, { roles: ['ADMIN'] }), {}), 'APP_NOT_FOUND');
    await expectCode(create(ctx(formerAdmin.id, { roles: ['ADMIN'] }), { owner: { user: member.id } }), 'APP_NOT_FOUND');
    expect(await db.agentTask.count()).toBe(0);
  });

  it('#1714/#1731: a self-joined plain member is a participant and names an owner; the row is not the owner role', async () => {
    await db.agent.update({ where: { id: teamAgent.id }, data: { installationPolicy: { maxMembers: 'unlimited', memberRoles: ['owner', 'member'], selfJoinRole: 'member' } as never } });
    await db.appAgent.create({ data: { appId: app.id, agentId: teamAgent.id } });
    await M.joinApp({}, { appId: app.id }, ctx(outsider.id));
    expect((await db.appMember.findUniqueOrThrow({ where: { appId_userId: { appId: app.id, userId: outsider.id } } })).role).toBe('member');
    const t = await create(ctx(outsider.id), { owner: { user: member.id } });
    expect(t.ownerUserId).toBe(member.id);
  });

  it('creating with an assignee writes task.created then task.assigned, and stamps the assignment', async () => {
    const t = await create(ctx(member.id), { assignee: { worker: 'liam' }, closeSessionWhenDone: false });
    expect(t.assigneeWorkerId).toBe(liam.id);
    expect(t.assignedAt).toBeInstanceOf(Date);
    expect(t.assignedBy).toBe(member.id);
    expect(t.closeSessionWhenDone).toBe(false);
    const ev = await events(t.id);
    expect(ev.map((e) => e.type)).toEqual(['task.created', 'task.assigned']);
    expect(ev[1].subjectWorkerId).toBe(liam.id);
  });

  it('an assignee outside the App is refused TASK_ASSIGNEE_INVALID (other App worker, retired worker, non-participant)', async () => {
    await expectCode(create(ctx(member.id), { assignee: { worker: zed.id } }), 'TASK_ASSIGNEE_INVALID');
    await expectCode(create(ctx(member.id), { assignee: { worker: retired.id } }), 'TASK_ASSIGNEE_INVALID');
    await expectCode(create(ctx(member.id), { assignee: { user: outsider.id } }), 'TASK_ASSIGNEE_INVALID');
    await expectCode(create(ctx(member.id), { assignee: { worker: 'Nobody' } }), 'TASK_ASSIGNEE_INVALID');
    expect(await db.agentTask.count()).toBe(0);
  });

  it('validates the shape: title, one party kind, requirements', async () => {
    await expectCode(create(ctx(member.id), { title: '   ' }), 'BAD_USER_INPUT');
    await expectCode(create(ctx(member.id), { assignee: { worker: 'Liam', user: member.id } }), 'BAD_USER_INPUT');
    await expectCode(
      create(ctx(member.id), { requirements: { familyIn: ['claude'], familyNotIn: ['glm'] } }),
      'BAD_USER_INPUT',
    );
    const t = await create(ctx(member.id), {
      requirements: { role: 'reviewer', familyNotIn: ['claude'], excludeWorkers: ['Rook'] },
      tags: ['epic-1704', 'epic-1704', ' t1 '],
    });
    expect(t.requirements).toEqual({ role: 'reviewer', familyNotIn: ['claude'], excludeWorkerIds: [rook.id] });
    expect(t.tags).toEqual(['epic-1704', 't1']);
  });
});

// ── Child tasks (cor:agt:050:07) ───────────────────────────────────────────

describe('createAgentTask — child tasks: the parent\'s assignee, who owns them (cor:agt:050:07)', () => {
  it('S1: the assignee creates a review child task and owns it', async () => {
    const parent = await anneTask({ start: true });
    const child = await asWorker(anne, () =>
      M.createAgentTask({}, { input: { parentTaskId: parent.id, title: 'Review', assignee: { worker: 'Rook' } } }, ctx(member.id)));
    expect(child.parentTaskId).toBe(parent.id);
    expect(child.appId).toBe(app.id);
    expect(child.ownerWorkerId).toBe(anne.id);
    expect(child.assigneeWorkerId).toBe(rook.id);
  });

  it('S2: someone who is not the assignee is refused — the owner included', async () => {
    const parent = await anneTask({ start: true });
    await expectCode(
      asWorker(rook, () => M.createAgentTask({}, { input: { parentTaskId: parent.id, title: 'x' } }, ctx(member.id))),
      'TASK_NOT_ASSIGNEE',
    );
    await expectCode(
      M.createAgentTask({}, { input: { parentTaskId: parent.id, title: 'x' } }, ctx(member.id)),
      'TASK_NOT_ASSIGNEE',
    );
  });

  it('S3: the creator naming another owner is refused TASK_CHILD_OWNER_MISMATCH', async () => {
    const parent = await anneTask({ start: true });
    await expectCode(
      asWorker(anne, () => M.createAgentTask(
        {}, { input: { parentTaskId: parent.id, title: 'x', owner: { worker: 'Rook' } } }, ctx(member.id))),
      'TASK_CHILD_OWNER_MISMATCH',
    );
    // #1757: the refusal is the same for an invalid ref — no oracle over which
    // parties exist, and naming yourself stays fine (you are the owner).
    await expectCode(
      asWorker(anne, () => M.createAgentTask(
        {}, { input: { parentTaskId: parent.id, title: 'x', owner: { user: outsider.id } } }, ctx(member.id))),
      'TASK_CHILD_OWNER_MISMATCH',
    );
    const self = await asWorker(anne, () =>
      M.createAgentTask({}, { input: { parentTaskId: parent.id, title: 'x', owner: { worker: anne.id } } }, ctx(member.id)));
    expect(self.ownerWorkerId).toBe(anne.id);
  });

  it('no child under an ended parent (TASK_ENDED, #1705 interim)', async () => {
    const parent = await anneTask({ start: true });
    await asWorker(anne, () => M.finishAgentTask({}, { taskId: parent.id, result: { outcome: 'succeeded' } }, ctx(member.id)));
    await expectCode(
      asWorker(anne, () => M.createAgentTask({}, { input: { parentTaskId: parent.id, title: 'x' } }, ctx(member.id))),
      'TASK_ENDED',
    );
  });

  it('a parent named across Apps, or unreadable, reads as TASK_NOT_FOUND (no existence oracle)', async () => {
    const parent = await anneTask({ start: true });
    await expectCode(
      asWorker(anne, () => M.createAgentTask(
        {}, { input: { appRef: otherApp.id, parentTaskId: parent.id, title: 'x' } }, ctx(member.id))),
      'TASK_NOT_FOUND',
    );
    await expectCode(
      M.createAgentTask({}, { input: { parentTaskId: parent.id, title: 'x' } }, ctx(outsider.id)),
      'TASK_NOT_FOUND',
    );
    await expectCode(
      M.createAgentTask({}, { input: { parentTaskId: generateId(), title: 'x' } }, ctx(member.id)),
      'TASK_NOT_FOUND',
    );
  });
});

// ── Assign, reassign, cancel (cor:agt:050:09) ──────────────────────────────

describe('assign / reassign / cancel — the owner, or whoever manages the App (cor:agt:050:09)', () => {
  it('S1: the owner assigns a queued task', async () => {
    const t = await create(ctx(member.id), {});
    const out = await M.assignAgentTask({}, { taskId: t.id, assignee: { worker: 'Liam' } }, ctx(member.id));
    expect(out.assigneeWorkerId).toBe(liam.id);
    expect(out.status).toBe('pending');
    expect((await events(t.id)).map((e) => e.type)).toEqual(['task.created', 'assignment.queued', 'task.assigned']);
  });

  it('a participant who is not the owner may not assign; an App manager may', async () => {
    const t = await create(ctx(member.id), {});
    await expectCode(M.assignAgentTask({}, { taskId: t.id, assignee: { worker: 'Liam' } }, ctx(reader.id)), 'TASK_NOT_OWNER');
    await expectCode(
      asWorker(rook, () => M.assignAgentTask({}, { taskId: t.id, assignee: { worker: 'Liam' } }, ctx(admin.id))),
      'TASK_NOT_OWNER',
    );
    const out = await M.assignAgentTask({}, { taskId: t.id, assignee: { worker: 'Liam' } }, ctx(admin.id));
    expect(out.assigneeWorkerId).toBe(liam.id);
    expect(out.assignedBy).toBe(admin.id);
  });

  it('assigning an already-assigned task is TASK_INVALID_TRANSITION (reassign instead)', async () => {
    const t = await anneTask();
    await expectCode(M.assignAgentTask({}, { taskId: t.id, assignee: { worker: 'Liam' } }, ctx(member.id)), 'TASK_INVALID_TRANSITION');
  });

  it('a non-owner learns nothing about the assignee ref: refused before it is validated', async () => {
    const t = await create(ctx(member.id), {});
    await expectCode(M.assignAgentTask({}, { taskId: t.id, assignee: { user: outsider.id } }, ctx(reader.id)), 'TASK_NOT_OWNER');
  });

  it('S2: the owner reassigns a stalled started task; it stays started, and the former assignee is locked out', async () => {
    const t = await anneTask({ start: true });
    const out = await M.reassignAgentTask({}, { taskId: t.id, assignee: { worker: 'Liam' }, closeSessionWhenDone: false }, ctx(member.id));
    expect(out.status).toBe('started');
    expect(out.assigneeWorkerId).toBe(liam.id);
    expect(out.closeSessionWhenDone).toBe(false);
    const ev = await events(t.id);
    const re = ev.find((e) => e.type === 'task.reassigned')!;
    expect(re.payload).toEqual({ from: { workerId: anne.id }, to: { workerId: liam.id }, closeSessionWhenDone: false });
    expect(re.subjectWorkerId).toBe(liam.id);
    await expectCode(asWorker(anne, () => M.recordAgentTaskProgress({}, { taskId: t.id }, ctx(member.id))), 'TASK_NOT_ASSIGNEE');
    await expectCode(
      asWorker(anne, () => M.finishAgentTask({}, { taskId: t.id, result: { outcome: 'succeeded' } }, ctx(member.id))),
      'TASK_NOT_ASSIGNEE',
    );
    const done = await asWorker(liam, () => M.finishAgentTask({}, { taskId: t.id, result: { outcome: 'succeeded' } }, ctx(member.id)));
    expect(done.status).toBe('finished');
  });

  it('S3: the assignee who is not the owner may not reassign', async () => {
    const t = await anneTask({ start: true });
    await expectCode(
      asWorker(anne, () => M.reassignAgentTask({}, { taskId: t.id, assignee: { worker: 'Rook' } }, ctx(member.id))),
      'TASK_NOT_OWNER',
    );
  });

  it('reassigning a queued task, or to the same assignee, is TASK_INVALID_TRANSITION', async () => {
    const q = await create(ctx(member.id), {});
    await expectCode(M.reassignAgentTask({}, { taskId: q.id, assignee: { worker: 'Liam' } }, ctx(member.id)), 'TASK_INVALID_TRANSITION');
    const t = await anneTask();
    await expectCode(M.reassignAgentTask({}, { taskId: t.id, assignee: { worker: 'Anne' } }, ctx(member.id)), 'TASK_INVALID_TRANSITION');
  });

  it('lifecycle S4: the owner cancels a pending task; a non-owner may not', async () => {
    const t = await anneTask();
    await expectCode(asWorker(anne, () => M.cancelAgentTask({}, { taskId: t.id }, ctx(member.id))), 'TASK_NOT_OWNER');
    const out = await M.cancelAgentTask({}, { taskId: t.id }, ctx(member.id));
    expect(out.status).toBe('cancelled');
    expect(out.cancelledAt).toBeInstanceOf(Date);
    const ev = (await events(t.id)).at(-1)!;
    expect(ev.type).toBe('task.cancelled');
    expect(ev.payload).toEqual({ fromStatus: 'pending', openChildCount: 0 });
  });

  it('lifecycle S6: cancelling a finished task is refused and it stays finished', async () => {
    const t = await anneTask({ start: true });
    await asWorker(anne, () => M.finishAgentTask({}, { taskId: t.id, result: { outcome: 'succeeded' } }, ctx(member.id)));
    await expectCode(M.cancelAgentTask({}, { taskId: t.id }, ctx(member.id)), 'TASK_ENDED');
    expect((await db.agentTask.findUniqueOrThrow({ where: { id: t.id } })).status).toBe('finished');
    await expectCode(M.reassignAgentTask({}, { taskId: t.id, assignee: { worker: 'Liam' } }, ctx(member.id)), 'TASK_ENDED');
  });

  it('a worker owner acts on its own tasks through its session', async () => {
    const t = await asWorker(anne, () => create(ctx(member.id), {}));
    await expectCode(M.assignAgentTask({}, { taskId: t.id, assignee: { worker: 'Liam' } }, ctx(member.id)), 'TASK_NOT_OWNER');
    const out = await asWorker(anne, () => M.assignAgentTask({}, { taskId: t.id, assignee: { worker: 'Liam' } }, ctx(member.id)));
    expect(out.assignedByWorkerId).toBe(anne.id);
  });

  it('a task id the caller cannot read is TASK_NOT_FOUND for every mutation', async () => {
    const t = await anneTask();
    for (const call of [
      () => M.assignAgentTask({}, { taskId: t.id, assignee: { worker: 'Liam' } }, ctx(outsider.id)),
      () => M.cancelAgentTask({}, { taskId: t.id }, ctx(outsider.id)),
      () => asWorker(zed, () => M.startAgentTask({}, { taskId: t.id }, ctx(member.id))),
    ]) await expectCode(call(), 'TASK_NOT_FOUND');
  });
});

// ── Backlog status (#1754, cor:agt:050:02) ─────────────────────────────────

describe('backlog — parked, unassigned (#1754, cor:agt:050:02)', () => {
  it('a task may be created in backlog: no assignee, never queued, never matched', async () => {
    const t = await create(ctx(member.id), { status: 'BACKLOG' });
    expect(t.status).toBe('backlog');
    expect(t.assigneeWorkerId).toBeNull();
    expect(t.assigneeUserId).toBeNull();
    expect(F.AgentTask.queued(t)).toBe(false);
    // #1707: only a queued task enters the queue — a backlog task never does.
    expect((await events(t.id)).map((e) => e.type)).toEqual(['task.created']);
  });

  it('backlog + assignee is refused, and so is creating in any other status', async () => {
    await expectCode(create(ctx(member.id), { status: 'BACKLOG', assignee: { worker: 'Liam' } }), 'BAD_USER_INPUT');
    for (const status of ['STARTED', 'FINISHED', 'CANCELLED']) {
      await expectCode(create(ctx(member.id), { status }), 'BAD_USER_INPUT');
    }
    expect(await db.agentTask.count()).toBe(0);
  });

  it('the owner parks a queued task; a reader may not; an App manager may', async () => {
    const t = await create(ctx(member.id), {});
    await expectCode(M.parkAgentTask({}, { taskId: t.id }, ctx(reader.id)), 'TASK_NOT_OWNER');
    const parked = await M.parkAgentTask({}, { taskId: t.id }, ctx(member.id));
    expect(parked.status).toBe('backlog');
    expect((await events(t.id)).map((e) => e.type)).toEqual(['task.created', 'assignment.queued', 'task.parked']);
    const t2 = await create(ctx(member.id), {});
    expect((await M.parkAgentTask({}, { taskId: t2.id }, ctx(admin.id))).status).toBe('backlog');
  });

  it('parking refuses an assigned, started, already-backlog or ended task', async () => {
    await expectCode(M.parkAgentTask({}, { taskId: (await anneTask()).id }, ctx(member.id)), 'TASK_INVALID_TRANSITION');
    await expectCode(M.parkAgentTask({}, { taskId: (await anneTask({ start: true })).id }, ctx(member.id)), 'TASK_INVALID_TRANSITION');
    const bl = await create(ctx(member.id), { status: 'BACKLOG' });
    await expectCode(M.parkAgentTask({}, { taskId: bl.id }, ctx(member.id)), 'TASK_INVALID_TRANSITION');
    const done = await anneTask({ start: true });
    await asWorker(anne, () => M.finishAgentTask({}, { taskId: done.id, result: { outcome: 'succeeded' } }, ctx(member.id)));
    await expectCode(M.parkAgentTask({}, { taskId: done.id }, ctx(member.id)), 'TASK_ENDED');
  });

  it('whoever may assign makes a backlog task ready: it becomes pending and enters the queue', async () => {
    const t = await create(ctx(member.id), { status: 'BACKLOG' });
    await expectCode(M.makeAgentTaskReady({}, { taskId: t.id }, ctx(reader.id)), 'TASK_NOT_OWNER');
    const ready = await M.makeAgentTaskReady({}, { taskId: t.id }, ctx(member.id));
    expect(ready.status).toBe('pending');
    expect(F.AgentTask.queued(ready)).toBe(true);
    expect((await events(t.id)).map((e) => e.type)).toEqual(['task.created', 'task.ready', 'assignment.queued']);
  });

  it('making ready refuses a pending or ended task', async () => {
    await expectCode(M.makeAgentTaskReady({}, { taskId: (await create(ctx(member.id), {})).id }, ctx(member.id)), 'TASK_INVALID_TRANSITION');
    const done = await anneTask({ start: true });
    await asWorker(anne, () => M.finishAgentTask({}, { taskId: done.id, result: { outcome: 'succeeded' } }, ctx(member.id)));
    await expectCode(M.makeAgentTaskReady({}, { taskId: done.id }, ctx(member.id)), 'TASK_ENDED');
  });

  it('assigning a backlog task moves it to pending (cor:agt:050:02)', async () => {
    const t = await create(ctx(member.id), { status: 'BACKLOG' });
    const out = await M.assignAgentTask({}, { taskId: t.id, assignee: { worker: 'Liam' } }, ctx(member.id));
    expect(out.status).toBe('pending');
    expect(out.assigneeWorkerId).toBe(liam.id);
  });

  it('cancelling from backlog: the owner and the reports-to chain, not an unrelated worker', async () => {
    const mine = await create(ctx(member.id), { status: 'BACKLOG' });
    const out = await M.cancelAgentTask({}, { taskId: mine.id }, ctx(member.id));
    expect(out.status).toBe('cancelled');
    expect((await events(mine.id)).at(-1)!.payload).toEqual({ fromStatus: 'backlog', openChildCount: 0 });
    await db.worker.update({ where: { id: anne.id }, data: { reportsToWorkerId: rook.id } });
    const hers = await asWorker(anne, () => create(ctx(member.id), { status: 'BACKLOG' }));
    await expectCode(asWorker(liam, () => M.cancelAgentTask({}, { taskId: hers.id }, ctx(member.id))), 'TASK_NOT_OWNER');
    const viaChain = await asWorker(rook, () => M.cancelAgentTask({}, { taskId: hers.id }, ctx(member.id)));
    expect(viaChain.status).toBe('cancelled');
  });

  it('a backlog child never makes its started parent wait; a ready one does', async () => {
    const parent = await anneTask({ start: true });
    const child = await asWorker(anne, () =>
      M.createAgentTask({}, { input: { parentTaskId: parent.id, title: 'later', status: 'BACKLOG' } }, ctx(member.id)));
    expect(child.status).toBe('backlog');
    const fresh = () => db.agentTask.findUniqueOrThrow({ where: { id: parent.id } });
    expect(await F.AgentTask.waitingOnChildren(await fresh(), {}, ctx(member.id))).toBe(false);
    await asWorker(anne, () => M.makeAgentTaskReady({}, { taskId: child.id }, ctx(member.id)));
    expect(await F.AgentTask.waitingOnChildren(await fresh(), {}, ctx(member.id))).toBe(true);
  });

  it('the status filter finds backlog tasks', async () => {
    const bl = await create(ctx(member.id), { status: 'BACKLOG' });
    await create(ctx(member.id), {});
    const seen = await Q.agentTasks({}, { appRef: app.id, status: ['BACKLOG'] }, ctx(member.id));
    expect(seen.map((t: any) => t.id)).toEqual([bl.id]);
  });

  it('assigning a backlog task writes task.ready beside task.assigned (the uniform left-backlog signal)', async () => {
    const t = await create(ctx(member.id), { status: 'BACKLOG' });
    await M.assignAgentTask({}, { taskId: t.id, assignee: { worker: 'Liam' } }, ctx(member.id));
    expect((await events(t.id)).map((e) => e.type)).toEqual(['task.created', 'task.ready', 'task.assigned']);
  });

  it('two concurrent make-ready calls: one typed refusal, never a duplicate event pair', async () => {
    const t = await create(ctx(member.id), { status: 'BACKLOG' });
    const codes = await Promise.all([ctx(member.id), ctx(admin.id)].map((c) =>
      M.makeAgentTaskReady({}, { taskId: t.id }, c).then(() => 'NO_ERROR', (e: GraphQLError) => String(e.extensions?.code))));
    expect(codes.sort()).toEqual(['NO_ERROR', 'TASK_INVALID_TRANSITION']);
    const ev = (await events(t.id)).map((e) => e.type);
    expect(ev.filter((t2) => t2 === 'task.ready')).toHaveLength(1);
    expect(ev.filter((t2) => t2 === 'assignment.queued')).toHaveLength(1);
    expect((await db.agentTask.findUniqueOrThrow({ where: { id: t.id } })).status).toBe('pending');
  });

  it('a backlog child counts as not open in a parent cancel (openChildCount)', async () => {
    const parent = await anneTask();
    await asWorker(anne, () =>
      M.createAgentTask({}, { input: { parentTaskId: parent.id, title: 'later', status: 'BACKLOG' } }, ctx(member.id)));
    const out = await M.cancelAgentTask({}, { taskId: parent.id }, ctx(member.id));
    expect(out.status).toBe('cancelled');
    expect((await events(parent.id)).at(-1)!.payload).toEqual({ fromStatus: 'pending', openChildCount: 0 });
  });

  it('a backlog task may carry a startBy already past (no alarm while parked)', async () => {
    const t = await create(ctx(member.id), { status: 'BACKLOG', startBy: new Date(Date.now() - 86_400_000).toISOString() });
    expect(t.status).toBe('backlog');
    expect(t.startBy).toBeInstanceOf(Date);
  });

  it('#1757∘#1754 (the reconciliation head): naming an owner and parking at creation compose', async () => {
    const t = await create(ctx(member.id), { status: 'BACKLOG', owner: { worker: 'Liam' } });
    expect(t.ownerWorkerId).toBe(liam.id);
    expect(t.status).toBe('backlog');
    expect((await events(t.id)).map((e) => e.type)).toEqual(['task.created']);
  });

  it('#1757 pin (Rook P3-2, deferred to this head per #9016): a worker creator naming a person owner rides the alarm chain cross-kind', async () => {
    const t = await asWorker(anne, () => create(ctx(member.id), { owner: { user: member.handle } }));
    expect(t.ownerUserId).toBe(member.id);
    expect(t.createdByWorkerId).toBe(anne.id);
    expect((await ownerChain(db, t.id))[0]).toEqual({ userId: member.id }); // then the App's managers, one entry each (#1761)
  });
});

// ── Start, progress, finish (cor:agt:050:08, :05, :02) ────────────────────

describe('start / progress / finish — the assignee only (cor:agt:050:08)', () => {
  it('lifecycle S1 + S2: the assignee starts, records progress and finishes with its result', async () => {
    const t = await anneTask();
    const started = await asWorker(anne, () => M.startAgentTask({}, { taskId: t.id }, ctx(member.id)));
    expect(started.status).toBe('started');
    expect(started.startedAt).toBeInstanceOf(Date);
    await asWorker(anne, () => M.recordAgentTaskProgress({}, { taskId: t.id }, ctx(member.id)));
    const done = await asWorker(anne, () => M.finishAgentTask(
      {}, { taskId: t.id, result: { outcome: 'succeeded', summary: 'Merged as abc123 after review.', evidence: 'https://github.com/o/r/pull/1' } },
      ctx(member.id)));
    expect(done.status).toBe('finished');
    expect(done.resultOutcome).toBe('succeeded');
    expect(done.resultSummary).toBe('Merged as abc123 after review.');
    const ev = await events(t.id);
    expect(ev.map((e) => e.type)).toEqual(['task.created', 'task.assigned', 'task.started', 'task.progress', 'task.finished']);
    expect(ev.at(-1)!.payload).toEqual({ outcome: 'succeeded' });
    expect(ev.every((e) => e.actorWorkerId === anne.id || e.actorUserId === member.id)).toBe(true);
  });

  it('S2 (050:08): someone else finishing the task or setting its result is refused, and the task is unchanged', async () => {
    const t = await anneTask({ start: true });
    const before = await db.agentTask.findUniqueOrThrow({ where: { id: t.id } });
    await expectCode(
      asWorker(rook, () => M.finishAgentTask({}, { taskId: t.id, result: { outcome: 'failed' } }, ctx(member.id))),
      'TASK_NOT_ASSIGNEE',
    );
    // 050:05 S3: the owner (a coordinator, say) cannot finish it for the assignee either.
    await expectCode(M.finishAgentTask({}, { taskId: t.id, result: { outcome: 'succeeded' } }, ctx(member.id)), 'TASK_NOT_ASSIGNEE');
    await expectCode(M.finishAgentTask({}, { taskId: t.id, result: { outcome: 'succeeded' } }, ctx(admin.id)), 'TASK_NOT_ASSIGNEE');
    const after = await db.agentTask.findUniqueOrThrow({ where: { id: t.id } });
    expect(after).toEqual(before);
  });

  it('only the assignee starts or records progress', async () => {
    const t = await anneTask();
    await expectCode(asWorker(rook, () => M.startAgentTask({}, { taskId: t.id }, ctx(member.id))), 'TASK_NOT_ASSIGNEE');
    await expectCode(M.startAgentTask({}, { taskId: t.id }, ctx(member.id)), 'TASK_NOT_ASSIGNEE');
    await asWorker(anne, () => M.startAgentTask({}, { taskId: t.id }, ctx(member.id)));
    await expectCode(asWorker(rook, () => M.recordAgentTaskProgress({}, { taskId: t.id }, ctx(member.id))), 'TASK_NOT_ASSIGNEE');
  });

  it('a queued task can be started by nobody (050:08 edge case)', async () => {
    const t = await create(ctx(member.id), {});
    await expectCode(M.startAgentTask({}, { taskId: t.id }, ctx(member.id)), 'TASK_NOT_ASSIGNEE');
  });

  it('a person assignee and the worker that person drives are different parties', async () => {
    const t = await create(ctx(member.id), { assignee: { user: member.id } });
    await expectCode(asWorker(anne, () => M.startAgentTask({}, { taskId: t.id }, ctx(member.id))), 'TASK_NOT_ASSIGNEE');
    const started = await M.startAgentTask({}, { taskId: t.id }, ctx(member.id));
    expect(started.status).toBe('started');
  });

  it('finishing a pending task is refused (start it first; #1705 interim)', async () => {
    const t = await anneTask();
    await expectCode(
      asWorker(anne, () => M.finishAgentTask({}, { taskId: t.id, result: { outcome: 'succeeded' } }, ctx(member.id))),
      'TASK_INVALID_TRANSITION',
    );
    await expectCode(asWorker(anne, () => M.recordAgentTaskProgress({}, { taskId: t.id }, ctx(member.id))), 'TASK_INVALID_TRANSITION');
  });

  it('starting twice is TASK_INVALID_TRANSITION; lifecycle S7: a finished task never starts again', async () => {
    const t = await anneTask({ start: true });
    await expectCode(asWorker(anne, () => M.startAgentTask({}, { taskId: t.id }, ctx(member.id))), 'TASK_INVALID_TRANSITION');
    await asWorker(anne, () => M.finishAgentTask({}, { taskId: t.id, result: { outcome: 'succeeded' } }, ctx(member.id)));
    await expectCode(asWorker(anne, () => M.startAgentTask({}, { taskId: t.id }, ctx(member.id))), 'TASK_ENDED');
    // A result cannot be changed after finishing (050:01 open question; #1705 interim).
    await expectCode(
      asWorker(anne, () => M.finishAgentTask({}, { taskId: t.id, result: { outcome: 'failed' } }, ctx(member.id))),
      'TASK_ENDED',
    );
  });

  it('an outcome is one word — free text never reaches the event stream', async () => {
    const t = await anneTask({ start: true });
    await expectCode(
      asWorker(anne, () => M.finishAgentTask({}, { taskId: t.id, result: { outcome: 'it went fine I think' } }, ctx(member.id))),
      'BAD_USER_INPUT',
    );
  });

  it('no title, description, source or summary text appears in any event payload', async () => {
    const t = await create(ctx(member.id), {
      title: 'SECRET-TITLE', description: 'SECRET-DESC', source: 'SECRET-SOURCE', assignee: { worker: anne.id },
    });
    await asWorker(anne, () => M.startAgentTask({}, { taskId: t.id }, ctx(member.id)));
    await asWorker(anne, () => M.finishAgentTask(
      {}, { taskId: t.id, result: { outcome: 'succeeded', summary: 'SECRET-SUMMARY', evidence: 'SECRET-EVIDENCE' } }, ctx(member.id)));
    const blob = JSON.stringify(await events(t.id));
    expect(blob).not.toMatch(/SECRET-/);
  });
});

// ── Reads (cor:agt:050:21) and derived fields ─────────────────────────────

describe('reads — the App\'s participants, workers included (cor:agt:050:21)', () => {
  it('S1: a participant lists every task, including ones they neither own nor hold', async () => {
    await create(ctx(member.id), {});
    await create(ctx(contrib.id), { assignee: { worker: 'Anne' } });
    const seen = await Q.agentTasks({}, { appRef: app.id }, ctx(reader.id));
    expect(seen).toHaveLength(2);
    const asLiam = await asWorker(liam, () => Q.agentTasks({}, { appRef: app.id }, ctx(member.id)));
    expect(asLiam).toHaveLength(2);
  });

  it('S2: a non-participant does not get the task; a pure App key and another App\'s worker neither', async () => {
    const t = await create(ctx(member.id), {});
    expect(await Q.agentTask({}, { id: t.id }, ctx(outsider.id))).toBeNull();
    expect(await Q.agentTask({}, { id: t.id }, ctx(undefined, { appId: app.id }))).toBeNull();
    expect(await asWorker(zed, () => Q.agentTask({}, { id: t.id }, ctx(member.id)))).toBeNull();
    expect(await Q.agentTaskTree({}, { root: t.id }, ctx(outsider.id))).toBeNull();
    await expectCode(Q.agentTasks({}, { appRef: app.id }, ctx(outsider.id)), 'APP_NOT_FOUND');
    await expectCode(Q.agentTeamEvents({}, { appRef: app.id }, ctx(outsider.id)), 'APP_NOT_FOUND');
  });

  it('a soft-deleted App\'s tasks read as missing', async () => {
    const t = await create(ctx(member.id), {});
    await db.app.update({ where: { id: app.id }, data: { deletedAt: new Date() } });
    expect(await Q.agentTask({}, { id: t.id }, ctx(member.id))).toBeNull();
  });

  it('differential: agentTask is readable exactly for the App-participant audience (isAppParticipant)', async () => {
    const t = await create(ctx(member.id), {});
    const platformAdmin = await user(`pa-${Date.now()}`, 50);
    const principals: Context[] = [
      ctx(admin.id), ctx(contrib.id), ctx(member.id), ctx(reader.id), ctx(appOwnerMember.id), ctx(outsider.id),
      ctx(platformAdmin.id, { roles: ['ADMIN'] }),
    ];
    for (const c of principals) {
      const readable = (await Q.agentTask({}, { id: t.id }, c)) !== null;
      const participates = await isAppParticipant(c, { id: app.id, organizationId: org.id, ownerUserId: null });
      expect({ user: c.userId, readable }).toEqual({ user: c.userId, readable: participates });
    }
    // The worker arm: this App's live, unretired workers, driven by a credential
    // that may STILL drive them (Rook P1-2) — and nobody else's.
    expect(await asWorker(anne, () => Q.agentTask({}, { id: t.id }, ctx(member.id)))).not.toBeNull();
    expect(await asWorker(anne, () => Q.agentTask({}, { id: t.id }, ctx(outsider.id)))).toBeNull();
    expect(await asWorker(retired, () => Q.agentTask({}, { id: t.id }, ctx(member.id)))).toBeNull();
    expect(await asWorker(zed, () => Q.agentTask({}, { id: t.id }, ctx(member.id)))).toBeNull();
  });

  it('filters: status, owner, assignee, tag, roots, queued', async () => {
    const a = await create(ctx(member.id), { tags: ['x'] });
    const b = await anneTask({ start: true });
    const child = await asWorker(anne, () =>
      M.createAgentTask({}, { input: { parentTaskId: b.id, title: 'child' } }, ctx(member.id)));
    const ids = async (args: Record<string, unknown>) =>
      (await Q.agentTasks({}, { appRef: app.id, ...args }, ctx(member.id))).map((t: any) => t.id).sort();
    expect(await ids({ status: ['STARTED'] })).toEqual([b.id]);
    expect(await ids({ owner: { worker: 'Anne' } })).toEqual([child.id]);
    expect(await ids({ assignee: { worker: anne.id } })).toEqual([b.id]);
    expect(await ids({ assignee: { worker: zed.id } })).toEqual([]);
    expect(await ids({ tag: 'x' })).toEqual([a.id]);
    expect(await ids({ rootsOnly: true })).toEqual([a.id, b.id].sort());
    expect(await ids({ queued: true })).toEqual([a.id, child.id].sort());
    expect(await ids({ parentTaskId: b.id })).toEqual([child.id]);
  });

  describe('creator filter (#2370): matches what `createdBy` projects', () => {
    const ids = async (args: Record<string, unknown>, c: Context = ctx(member.id)) =>
      (await Q.agentTasks({}, { appRef: app.id, ...args }, c)).map((t: any) => t.id).sort();
    /** `inPerson` is created by `member` directly; `byAnne` by Anne's session (stamps BOTH createdBy = holder and createdByWorkerId). */
    async function twoCreators() {
      const inPerson = await create(ctx(member.id), { title: 'in person' });
      const byAnne = await asWorker(anne, () => create(ctx(member.id), { title: 'by anne' }));
      return { inPerson, byAnne };
    }

    it('P1: a worker creator returns what that worker created, not what its holder created in person', async () => {
      const { byAnne } = await twoCreators();
      expect(await ids({ creator: { worker: anne.id } })).toEqual([byAnne.id]);
      expect(await ids({ creator: { worker: 'Anne' } })).toEqual([byAnne.id]);
    });

    it('P2: a person creator returns their in-person tasks and excludes their workers\' tasks', async () => {
      const { inPerson } = await twoCreators();
      expect(await ids({ creator: { user: member.id } })).toEqual([inPerson.id]);
      expect(await ids({ creator: { user: `@${member.handle}` } })).toEqual([inPerson.id]);
    });

    it('P3: combines with the other filters by AND', async () => {
      await twoCreators();
      const byAnne = await asWorker(anne, () => create(ctx(member.id), { title: 'for liam', assignee: { worker: 'Liam' } }));
      expect(await ids({ creator: { worker: anne.id }, assignee: { worker: liam.id }, status: ['PENDING'] })).toEqual([byAnne.id]);
      expect(await ids({ creator: { worker: anne.id }, assignee: { worker: rook.id } })).toEqual([]);
      expect(await ids({ creator: { worker: anne.id }, status: ['STARTED'] })).toEqual([]);
    });

    it('P4: a ref naming nobody in this App matches nothing, with no error', async () => {
      await twoCreators();
      expect(await ids({ creator: { worker: zed.id } })).toEqual([]);
      expect(await ids({ creator: { worker: 'Nobody' } })).toEqual([]);
      expect(await ids({ creator: { user: outsider.id } })).toEqual([]);
      // Parity with owner/assignee: a retired worker is not a party to resolve.
      expect(await ids({ creator: { worker: retired.id } })).toEqual([]);
      await expectCode(Q.agentTasks({}, { appRef: app.id, creator: { worker: 'Anne', user: member.id } }, ctx(member.id)), 'BAD_USER_INPUT');
    });

    it('P5: a non-participant gets APP_NOT_FOUND, exactly as without the filter (R202, no oracle)', async () => {
      await twoCreators();
      await expectCode(Q.agentTasks({}, { appRef: app.id, creator: { worker: anne.id } }, ctx(outsider.id)), 'APP_NOT_FOUND');
      await expectCode(Q.agentTasks({}, { appRef: app.id, creator: { user: member.id } }, ctx(outsider.id)), 'APP_NOT_FOUND');
      await expectCode(Q.agentTasks({}, { appRef: app.id, creator: { worker: 'Nobody' } }, ctx(outsider.id)), 'APP_NOT_FOUND');
    });
  });

  it('derived: queued (050:03) and waitingOnChildren (050:04), never stored', async () => {
    const T = F.AgentTask;
    const parent = await anneTask({ start: true });
    const queued = await create(ctx(member.id), {});
    expect(T.queued(queued)).toBe(true);
    expect(T.queued(parent)).toBe(false);
    const fresh = () => db.agentTask.findUniqueOrThrow({ where: { id: parent.id } });
    expect(await T.waitingOnChildren(await fresh(), {}, ctx(member.id))).toBe(false);
    const child = await asWorker(anne, () =>
      M.createAgentTask({}, { input: { parentTaskId: parent.id, title: 'review', assignee: { worker: 'Rook' } } }, ctx(member.id)));
    expect(await T.waitingOnChildren(await fresh(), {}, ctx(member.id))).toBe(true);
    await asWorker(anne, () => M.cancelAgentTask({}, { taskId: child.id }, ctx(member.id)));
    expect(await T.waitingOnChildren(await fresh(), {}, ctx(member.id))).toBe(false);
  });

  it('agentTaskTree returns the root and every descendant, root first', async () => {
    const root = await anneTask({ start: true });
    const c1 = await asWorker(anne, () =>
      M.createAgentTask({}, { input: { parentTaskId: root.id, title: 'c1', assignee: { worker: 'Rook' } } }, ctx(member.id)));
    await asWorker(rook, () => M.startAgentTask({}, { taskId: c1.id }, ctx(member.id)));
    const g1 = await asWorker(rook, () =>
      M.createAgentTask({}, { input: { parentTaskId: c1.id, title: 'g1' } }, ctx(member.id)));
    await create(ctx(member.id), { title: 'unrelated' });
    const tree = await Q.agentTaskTree({}, { root: root.id }, ctx(reader.id));
    expect(tree.map((t: any) => t.id)).toEqual([root.id, c1.id, g1.id]);
  });

  it('agentTeamEvents: oldest first, filtered by type and task', async () => {
    const t = await anneTask({ start: true });
    const all = await Q.agentTeamEvents({}, { appRef: app.id }, ctx(reader.id));
    expect(all.map((e: any) => e.type)).toEqual(['task.created', 'task.assigned', 'task.started']);
    const started = await Q.agentTeamEvents({}, { appRef: app.id, types: ['task.started'], taskId: t.id }, ctx(reader.id));
    expect(started).toHaveLength(1);
    expect(await Q.agentTeamEvents({}, { appRef: app.id, alarmsOnly: true }, ctx(reader.id))).toEqual([]);
  });

  it('parties render as a sanitized projection, never the User object', async () => {
    const t = await create(ctx(member.id), { assignee: { worker: 'Anne' } });
    const owner = await F.AgentTask.owner(t, {}, ctx(reader.id));
    expect(owner).toEqual({ kind: 'USER', id: member.id, name: member.handle, urn: null });
    const assignee = await F.AgentTask.assignee(t, {}, ctx(reader.id));
    expect(assignee).toMatchObject({ kind: 'WORKER', id: anne.id, name: 'Anne' });
    expect(assignee.urn).toMatch(/^hrn:worker:/);
  });
});

// ── Cross-cutting: deleteWorker, user merge ───────────────────────────────

describe('integrity', () => {
  it('deleteWorker refuses a worker that owns or holds a task (WORKER_IN_USE)', async () => {
    await create(ctx(member.id), { assignee: { worker: 'Liam' } });
    await expectCode(M.deleteWorker({}, { workerRef: liam.id, confirmNoExternalAttribution: true }, ctx(admin.id)), 'WORKER_IN_USE');
  });

  it("a user merge carries task ownership and assignment to the surviving account, and leaves the event stream sealed", async () => {
    const survivor = await user(`sv-${Date.now()}`, 60);
    await db.appMember.create({ data: { appId: app.id, userId: survivor.id, role: 'member' } });
    const t = await create(ctx(member.id), { assignee: { user: member.id } });
    const platform = await user(`pl-${Date.now()}`, 61);
    await db.user.update({ where: { id: platform.id }, data: { roles: ['ADMIN'] } });
    await mergeUsers(db as any, { sourceUserId: member.id, targetUserId: survivor.id, actorUserId: platform.id } as any);
    const after = await db.agentTask.findUniqueOrThrow({ where: { id: t.id } });
    expect(after.ownerUserId).toBe(survivor.id);
    expect(after.assigneeUserId).toBe(survivor.id);
    expect(after.createdBy).toBe(survivor.id);
    expect(after.assignedBy).toBe(survivor.id);
    const ev = await events(t.id);
    expect(ev.every((e) => e.actorUserId === member.id)).toBe(true);
  });
});

// ── #1713 review round (Rook §10, Diego cross-provider) ───────────────────

describe('#1731: the strict App manager of #1713 (Rook P1-1) is replaced by #7790', () => {
  it('an owner-role AppMember outside the org manages the App: reassigns, cancels, assigns and names owners', async () => {
    // #1714 closed self-join, so the row stands for one a manager granted.
    await db.appAgent.create({ data: { appId: app.id, agentId: teamAgent.id } });
    await db.appMember.create({ data: { appId: app.id, userId: outsider.id, role: 'owner' } });
    const theirs = await anneTask({ start: true });
    await M.reassignAgentTask({}, { taskId: theirs.id, assignee: { worker: 'Liam' } }, ctx(outsider.id));
    expect((await db.agentTask.findUniqueOrThrow({ where: { id: theirs.id } })).assigneeWorkerId).toBe(liam.id);
    await M.cancelAgentTask({}, { taskId: theirs.id }, ctx(outsider.id));
    const queued = await create(ctx(member.id), {});
    await M.assignAgentTask({}, { taskId: queued.id, assignee: { worker: 'Liam' } }, ctx(outsider.id));
    expect((await create(ctx(outsider.id), { owner: { user: member.id } })).ownerUserId).toBe(member.id);
  });

  it('demoted from owner, the same member manages nothing again', async () => {
    await db.appMember.create({ data: { appId: app.id, userId: outsider.id, role: 'owner' } });
    await db.appMember.update({ where: { appId_userId: { appId: app.id, userId: outsider.id } }, data: { role: 'member' } });
    const theirs = await anneTask();
    await expectCode(M.cancelAgentTask({}, { taskId: theirs.id }, ctx(outsider.id)), 'TASK_NOT_OWNER');
  });
});

describe('#1713 review: a worker session stops authorizing when its driver stops participating (Rook P1-2)', () => {
  it('bind, remove the AppMember: the worker reads null and its writes are TASK_NOT_FOUND', async () => {
    const t = await anneTask();
    expect(await asWorker(anne, () => Q.agentTask({}, { id: t.id }, ctx(member.id)))).not.toBeNull();
    await db.appMember.delete({ where: { appId_userId: { appId: app.id, userId: member.id } } });
    expect(await asWorker(anne, () => Q.agentTask({}, { id: t.id }, ctx(member.id)))).toBeNull();
    await expectCode(asWorker(anne, () => M.startAgentTask({}, { taskId: t.id }, ctx(member.id))), 'TASK_NOT_FOUND');
    await expectCode(asWorker(anne, () => Q.agentTasks({}, { appRef: app.id }, ctx(member.id))), 'APP_NOT_FOUND');
    expect((await db.agentTask.findUniqueOrThrow({ where: { id: t.id } })).status).toBe('pending');
  });

  it('a revoked org membership stops it too', async () => {
    const t = await anneTask();
    await db.orgMember.updateMany({ where: { organizationId: org.id, userId: contrib.id }, data: { deletedAt: new Date() } });
    expect(await asWorker(anne, () => Q.agentTask({}, { id: t.id }, ctx(contrib.id)))).toBeNull();
  });
});

/** Resolve once another backend of THIS database is waiting on a lock — the request reached its wait. */
async function untilSomeoneWaits(): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const [{ n }] = await db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`;
    if (n > 0) return;
    if (Date.now() > deadline) throw new Error('no backend ever waited on a lock');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/**
 * A revoker that has DONE its write (locks held, uncommitted) and commits only
 * when `release` is called — so a request can be parked at its wait first.
 */
function revoker(work: (tx: any) => Promise<void>) {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let ready!: () => void;
  const holding = new Promise<void>((r) => { ready = r; });
  const done = db.$transaction(async (tx) => {
    await work(tx);
    ready();
    await gate;
  }, { timeout: 30_000 });
  return { holding, release, done };
}

describe('#1713 review: writes re-gate inside their transaction (Diego P2-A)', () => {
  it('a membership revocation that commits while the write waits: no task change, no event', async () => {
    const t = await create(ctx(reader.id), {});
    const eventsBefore = await db.agentTeamEvent.count();
    // removeAppMember's protocol: the App + removed-user anchors EXCLUSIVELY, then the delete.
    const r = revoker(async (tx) => {
      await lockAuthorityAnchors(tx, [{ kind: 'app', id: app.id }, { kind: 'user', id: reader.id }, { kind: 'org', id: org.id }], 'exclusive');
      await tx.appMember.delete({ where: { appId_userId: { appId: app.id, userId: reader.id } } });
    });
    await r.holding;
    const write = M.cancelAgentTask({}, { taskId: t.id }, ctx(reader.id)).then(
      () => 'NO_ERROR', (e: GraphQLError) => String(e.extensions?.code));
    await untilSomeoneWaits();
    r.release();
    await r.done;
    expect(await write).toBe('TASK_NOT_FOUND');
    expect((await db.agentTask.findUniqueOrThrow({ where: { id: t.id } })).status).toBe('pending');
    expect(await db.agentTeamEvent.count()).toBe(eventsBefore);
  });

  it('an uninstall that commits while the write waits: APP_UNINSTALLED, no task change, no event', async () => {
    const t = await anneTask();
    const eventsBefore = await db.agentTeamEvent.count();
    const r = revoker(async (tx) => {
      await tx.$executeRaw`UPDATE apps SET uninstalled_at = now() WHERE id = ${app.id}`;
    });
    await r.holding;
    const write = asWorker(anne, () => M.startAgentTask({}, { taskId: t.id }, ctx(member.id))).then(
      () => 'NO_ERROR', (e: GraphQLError) => String(e.extensions?.code));
    await untilSomeoneWaits();
    r.release();
    await r.done;
    expect(await write).toBe('APP_UNINSTALLED');
    expect((await db.agentTask.findUniqueOrThrow({ where: { id: t.id } })).status).toBe('pending');
    expect(await db.agentTeamEvent.count()).toBe(eventsBefore);
  });

  it('a worker retired while its write waits: refused, no task change, no event', async () => {
    const t = await anneTask({ start: true });
    const eventsBefore = await db.agentTeamEvent.count();
    const r = revoker(async (tx) => {
      await tx.$executeRaw`UPDATE workers SET retired_at = now() WHERE id = ${anne.id}`;
    });
    await r.holding;
    const write = asWorker(anne, () =>
      M.finishAgentTask({}, { taskId: t.id, result: { outcome: 'succeeded' } }, ctx(member.id))).then(
      () => 'NO_ERROR', (e: GraphQLError) => String(e.extensions?.code));
    await untilSomeoneWaits();
    r.release();
    await r.done;
    expect(await write).toBe('TASK_NOT_FOUND');
    expect((await db.agentTask.findUniqueOrThrow({ where: { id: t.id } })).status).toBe('started');
    expect(await db.agentTeamEvent.count()).toBe(eventsBefore);
  });

  it('a self-service leaveApp (no anchor) that commits while the write waits: refused, no event', async () => {
    const t = await create(ctx(reader.id), {});
    const eventsBefore = await db.agentTeamEvent.count();
    // controller/operations/leaveApp.ts: a bare deleteMany, no authority anchor.
    const r = revoker(async (tx) => {
      await tx.appMember.deleteMany({ where: { appId: app.id, userId: reader.id } });
    });
    await r.holding;
    const write = M.cancelAgentTask({}, { taskId: t.id }, ctx(reader.id)).then(
      () => 'NO_ERROR', (e: GraphQLError) => String(e.extensions?.code));
    await untilSomeoneWaits();
    r.release();
    await r.done;
    expect(await write).toBe('TASK_NOT_FOUND');
    expect((await db.agentTask.findUniqueOrThrow({ where: { id: t.id } })).status).toBe('pending');
    expect(await db.agentTeamEvent.count()).toBe(eventsBefore);
  });

  it('a root create racing a revocation commits nothing either', async () => {
    const r = revoker(async (tx) => {
      await lockAuthorityAnchors(tx, [{ kind: 'app', id: app.id }, { kind: 'user', id: reader.id }, { kind: 'org', id: org.id }], 'exclusive');
      await tx.appMember.delete({ where: { appId_userId: { appId: app.id, userId: reader.id } } });
    });
    await r.holding;
    const write = create(ctx(reader.id), {}).then(() => 'NO_ERROR', (e: GraphQLError) => String(e.extensions?.code));
    await untilSomeoneWaits();
    r.release();
    await r.done;
    expect(await write).toBe('APP_NOT_FOUND');
    expect(await db.agentTask.count()).toBe(0);
    expect(await db.agentTeamEvent.count()).toBe(0);
  });
});

describe('#1713 review: event continuation keeps ties (Diego P2-B)', () => {
  it('pages one event at a time through a group sharing one timestamp, skipping and repeating nothing', async () => {
    const t = await create(ctx(member.id), { assignee: { worker: 'Anne' } }); // created + assigned
    // 1. The page boundary inside the same-transaction created + assigned pair,
    //    tested BEFORE anything else is in the stream. No assumption about which
    //    of the two sorts first: an equal createdAt falls back to id order.
    const first = await Q.agentTeamEvents({}, { appRef: app.id, limit: 1 }, ctx(member.id));
    const next = await Q.agentTeamEvents({}, { appRef: app.id, limit: 1, after: first[0].id }, ctx(member.id));
    expect(next).toHaveLength(1);
    expect([first[0].type, next[0].type].sort()).toEqual(['task.assigned', 'task.created']);
    expect(await Q.agentTeamEvents({}, { appRef: app.id, limit: 1, after: next[0].id }, ctx(member.id))).toEqual([]);
    // 2. Three more rows at ONE instant, derived from the pair (strictly later),
    //    so the order holds on any date the suite runs.
    const pair = await db.agentTeamEvent.findMany({ where: { taskId: t.id }, select: { createdAt: true } });
    const at = new Date(Math.max(...pair.map((e) => e.createdAt.getTime())) + 1_000);
    for (const type of ['task.started', 'task.progress', 'task.progress']) {
      await db.agentTeamEvent.create({ data: { appId: app.id, taskId: t.id, type, createdAt: at } });
    }
    const all = await Q.agentTeamEvents({}, { appRef: app.id, limit: 200 }, ctx(member.id));
    expect(all).toHaveLength(5);
    expect(all.slice(2).every((e: any) => e.createdAt.getTime() === at.getTime())).toBe(true);
    const seen: string[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await Q.agentTeamEvents({}, { appRef: app.id, limit: 1, ...(after ? { after } : {}) }, ctx(member.id));
      if (!page.length) break;
      seen.push(page[0].id);
      after = page[0].id;
    }
    expect(seen).toEqual(all.map((e: any) => e.id));
  });

  it('a cursor that is not an event of this App is refused', async () => {
    await expectCode(Q.agentTeamEvents({}, { appRef: app.id, after: generateId() }, ctx(member.id)), 'BAD_USER_INPUT');
  });
});
