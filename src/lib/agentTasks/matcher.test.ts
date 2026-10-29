import { anchorNow } from '../stopSignals/state.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
/**
 * #1707 (Task Management T3) — the matcher (cor:agt:060:05, :06): who is free
 * for work, who a queued task goes to, when matching runs, and that
 * overlapping runs never give a task two assignees or a worker two tasks.
 *
 * Against a CONTROLLABLE clock where the matcher is driven directly
 * (`taskMatcherTick(db, at)`), with real session rows for bindings and real
 * assignment events for "assigned least recently". The event-driven runs use
 * the wall clock, so those scenarios bind sessions at the real now.
 *
 * Cast (060:06's own): Baloo (codex), Liam (glm) and Rook (claude) are
 * reviewers; Anne (codex) is an engineer. Mia is an App member who owns the
 * tasks.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '../../generated/prisma/index.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { runAsActor } from '../requestActor.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { taskMatcherTick } from '../../jobs/taskMatcher.js';
import { __matcherTesting, compareRank, eligibleFamily, loadWorkerWorkStates, matchable, matchQueuedTasks, parseRequirements } from './matcher.js';
import { registerHost } from './hosts.js';
import { typeDefs } from '../../api/graphql/schema/typeDefs.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const M = resolvers.Mutation as any;

const DAY = '2026-10-09';
const at = (hhmm: string): Date => new Date(`${DAY}T${hhmm.length === 5 ? `${hhmm}:00` : hhmm}Z`);

function ctx(userId?: string): Context {
  return { db, userId, roles: ['READER'] };
}

let app: { id: string };
let agentId: string;
let admin: { id: string };
let mia: { id: string };
let baloo: { id: string };
let liam: { id: string };
let rook: { id: string };
let anne: { id: string };

beforeEach(async () => {
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1_000_000);
  const org = await db.organization.create({ data: { name: 'Match', urn: `match-${n}.example` } });
  admin = await db.user.create({ data: { githubId: 600_000 + n, githubUsername: `mt-admin-${n}`, roles: ['READER'] } });
  mia = await db.user.create({ data: { githubId: 700_000 + n, githubUsername: `mt-mia-${n}`, roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  const agent = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(admin.id));
  agentId = agent.id;
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `match-${n}.example:team` }, select: { id: true } });
  await db.appMember.create({ data: { appId: app.id, userId: mia.id, role: 'member' } });
  const worker = (name: string, role: string) =>
    db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId, name, slug: name.toLowerCase(), role, heldByUserId: mia.id }, select: { id: true } });
  baloo = await worker('Baloo', 'reviewer');
  liam = await worker('Liam', 'reviewer');
  rook = await worker('Rook', 'reviewer');
  anne = await worker('Anne', 'engineer');
});

afterEach(() => {
  delete process.env.DISABLE_TASK_MATCHER;
});

// ── Fixtures ──────────────────────────────────────────────────────────────

/** Bind `w` in a session of `family` (null: none reported), driven at `t` (default: the real now). */
async function bind(w: { id: string }, family: string | null, t?: Date) {
  const when = t ?? new Date();
  return db.session.create({
    data: { id: generateId(), appId: app.id, workerId: w.id, agentId, family, startedAt: when, updatedAt: when },
    select: { id: true },
  });
}

/** A queued task, created at `t`, owned by Mia. */
function queued(t: string, requirements: Prisma.InputJsonObject | null = null, extra: Record<string, unknown> = {}) {
  return db.agentTask.create({
    data: { appId: app.id, title: 'Review', ownerUserId: mia.id, createdAt: at(t), ...(requirements ? { requirements } : {}), ...extra },
    select: { id: true },
  });
}

/** `w` was last assigned a task at `t` (a task.assigned event naming it). */
async function lastAssigned(w: { id: string }, t: string) {
  await db.agentTeamEvent.create({
    data: { appId: app.id, type: 'task.assigned', subjectWorkerId: w.id, createdAt: at(t), payload: { assignee: { workerId: w.id } } },
  });
}

const assigneeOf = async (taskId: string) =>
  (await db.agentTask.findUniqueOrThrow({ where: { id: taskId }, select: { assigneeWorkerId: true } })).assigneeWorkerId;
const NOT_CLAUDE_REVIEWER = { role: 'reviewer', familyNotIn: ['claude'] };

describe('#2191 matching constraints', () => {
  it('treats legacy JSON null requirements as unconstrained, like SQL null', async () => {
    await bind(baloo, 'codex', at('11:00'));
    const task = await queued('11:00');
    await db.$executeRaw`UPDATE agent_tasks SET requirements = 'null'::jsonb WHERE id = ${task.id}`;
    expect(await matchQueuedTasks(db, at('11:01'), { appId: app.id })).toEqual([{ taskId: task.id, workerId: baloo.id, family: 'codex' }]);
  });

  it('uses the post-wait clock for session expiry instead of the pass timestamp', async () => {
    const session = await bind(baloo, 'codex', at('11:00'));
    await db.session.update({ where: { id: session.id }, data: { expiresAt: at('11:01') } });
    const task = await queued('11:00');
    expect(await __matcherTesting.tryAssign(db, { ...task, appId: app.id, requirements: null, closeSessionWhenDone: false }, baloo.id, 'codex', at('11:00'), {}, anchorNow() - 120000)).toBe('worker-not-free');
    expect(await assigneeOf(task.id)).toBeNull();
  });

  it('an unbound assignment launches only through a host offering the selected allowed family', async () => {
    for (const [hostId, family] of [['aaa', 'claude'], ['zzz', 'codex']]) {
      await registerHost(db, { appId: app.id, hostId, label: hostId, pollIntervalSeconds: 60, workers: [{ workerId: baloo.id, family, worktrees: ['repo/worker'] }] }, at('11:00'));
    }
    const task = await queued('11:00', { familyNotIn: ['anthropic'] });
    expect(await matchQueuedTasks(db, at('11:01'), { appId: app.id })).toEqual([{ taskId: task.id, workerId: baloo.id, family: 'codex' }]);
    const op = await db.hostOperation.findFirstOrThrow({ where: { workerId: baloo.id, type: 'worker.start' } });
    expect(op.args).toMatchObject({ family: 'codex' });
    expect(op.hostId).toBe('zzz');
  });

  it('compares both aliases, custom identities and exclusions without guessing a missing role', () => {
    const w = { id: 'worker', role: 'engineer', freeFamilies: ['claude'] };
    for (const family of ['claude', 'anthropic', ' AnTHropic ']) {
      expect(eligibleFamily(parseRequirements({ familyIn: [family] }), w)).toBe('claude');
      expect(eligibleFamily(parseRequirements({ familyNotIn: [family] }), w)).toBeNull();
    }
    const custom = { ...w, freeFamilies: [' Private-7 '] };
    expect(eligibleFamily(parseRequirements({ familyIn: ['PRIVATE-7'] }), custom)).toBe('private-7');
    expect(eligibleFamily(parseRequirements({ familyIn: ['private-8'] }), custom)).toBeNull();
    expect(eligibleFamily(parseRequirements({ familyNotIn: ['private-8'] }), custom)).toBe('private-7');
    expect(eligibleFamily(parseRequirements({ excludeWorkerIds: ['worker'] }), custom)).toBeNull();
    expect(eligibleFamily(parseRequirements({ role: 'reviewer' }), custom)).toBeNull();
    for (const raw of [null, {}, { role: null, familyIn: null }, { familyNotIn: [] }]) {
      expect(eligibleFamily(parseRequirements(raw), w)).toBe('claude');
    }
    expect(eligibleFamily(parseRequirements({ familyIn: [] }), w)).toBeNull();
    for (const raw of [{ familyIn: 'codex' }, { role: 1 }, { familyNotIn: [''] }, { familyNotIn: ['not valid'] }, { excludeWorkerIds: 'worker' }]) {
      expect(eligibleFamily(parseRequirements(raw), w)).toBeNull();
    }
  });

  for (const family of ['Anthropic', 'OpenAI']) {
    it(`unbound host ${family} follows alias inclusion and exclusion without a real launch`, async () => {
      await registerHost(db, { appId: app.id, hostId: 'synthetic', label: 'synthetic', pollIntervalSeconds: 60, workers: [{ workerId: baloo.id, family, worktrees: ['repo/worker'] }] }, at('11:00'));
      const canonical = family === 'Anthropic' ? 'claude' : 'codex';
      // Force the existing-row spelling; new registrations are already canonical.
      await db.hostRegistrationWorker.updateMany({ data: { family: family.toLowerCase() } });
      const blocked = await queued('11:00', { familyNotIn: [canonical] });
      const allowed = await queued('11:01', { familyIn: [family] });
      expect(await matchQueuedTasks(db, at('11:02'), { appId: app.id })).toEqual([{ taskId: allowed.id, workerId: baloo.id, family: canonical }]);
      expect(await assigneeOf(blocked.id)).toBeNull();
      const op = await db.hostOperation.findFirstOrThrow({ where: { workerId: baloo.id, type: 'worker.start' } });
      expect(op.args).toMatchObject({ family: canonical });
      expect(op.status).toBe('issued'); // synthetic DB row only; no host consumes it.
    });
  }

  it('excludes legacy Claude bindings by the anthropic alias', async () => {
    await bind(rook, 'claude', at('11:00'));
    const t = await queued('11:00', { familyNotIn: [' AnthropIC '] });
    expect(await matchQueuedTasks(db, at('11:01'), { appId: app.id })).toEqual([]);
    expect(await assigneeOf(t.id)).toBeNull();
  });

  it('includes legacy provider bindings by their canonical family', async () => {
    await bind(baloo, 'openai', at('11:00'));
    const t = await queued('11:00', { familyIn: ['codex'] });
    expect(await matchQueuedTasks(db, at('11:01'), { appId: app.id })).toEqual([
      { taskId: t.id, workerId: baloo.id, family: 'codex' },
    ]);
  });

  it('never automatically assigns to an Agent with usesTasks false', async () => {
    await bind(baloo, 'codex', at('11:00'));
    await db.agent.update({ where: { id: agentId }, data: { usesTasks: false } });
    const t = await queued('11:00');
    expect(await matchQueuedTasks(db, at('11:01'), { appId: app.id })).toEqual([]);
    expect(await assigneeOf(t.id)).toBeNull();
  });

  it('keeps explicit named assignment to usesTasks:false working', async () => {
    process.env.DISABLE_TASK_MATCHER = 'true';
    await db.agent.update({ where: { id: agentId }, data: { usesTasks: false } });
    const t = await M.createAgentTask({}, { input: { appRef: app.id, title: 'Explicit', assignee: { worker: baloo.id } } }, ctx(mia.id));
    expect(t.assigneeWorkerId).toBe(baloo.id);
  });

  it('normalizes task requirement storage and retains custom tokens', async () => {
    process.env.DISABLE_TASK_MATCHER = 'true';
    const t = await M.createAgentTask({}, { input: { appRef: app.id, title: 'Aliases', requirements: { familyNotIn: [' Anthropic ', 'claude', ' OPENAI ', 'Custom-7'] } } }, ctx(mia.id));
    expect(t.requirements).toEqual({ familyNotIn: ['claude', 'codex', 'custom-7'] });
    await expect(M.createAgentTask({}, { input: { appRef: app.id, title: 'Bad', requirements: { familyIn: ['not a token'] } } }, ctx(mia.id)))
      .rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  });

  it('honors legacy alias availability and can deliberately clear it through the canonical key', async () => {
    process.env.DISABLE_TASK_MATCHER = 'true';
    await bind(baloo, 'codex', at('11:00'));
    await db.modelFamilyAvailability.create({ data: { appId: app.id, family: 'openai', state: 'unavailable', reason: 'other', setAt: at('10:00'), setByUserId: admin.id } });
    const t = await queued('11:00');
    expect(await matchQueuedTasks(db, at('11:01'), { appId: app.id })).toEqual([]);
    await M.setModelFamilyAvailability({}, { input: { appRef: app.id, family: 'OpenAI', state: 'AVAILABLE' } }, ctx(admin.id));
    expect(await matchQueuedTasks(db, at('11:01'), { appId: app.id })).toEqual([{ taskId: t.id, workerId: baloo.id, family: 'codex' }]);
  });

  it('does not weaken malformed legacy exclusions or conflicting family lists', () => {
    const w = { id: 'w', role: 'reviewer', freeFamilies: ['codex'] };
    for (const raw of [{ familyNotIn: [1] }, { familyIn: ['codex'], familyNotIn: ['codex'] }, { excludeWorkerIds: [false] }]) {
      expect(eligibleFamily(parseRequirements(raw), w)).toBeNull();
    }
  });
});

// ── cor:agt:060:06 — the rule's scenarios ─────────────────────────────────

describe('cor:agt:060:06 — a queued task goes to the matching worker free for work assigned least recently', () => {
  it('S1: reviewer, not claude; Baloo (codex, 09:00) and Liam (glm, 10:00) free → Baloo', async () => {
    await bind(baloo, 'codex', at('11:00'));
    await bind(liam, 'glm', at('11:00'));
    await lastAssigned(baloo, '09:00');
    await lastAssigned(liam, '10:00');
    const t = await queued('11:00', NOT_CLAUDE_REVIEWER);
    expect(await taskMatcherTick(db, at('11:01'))).toEqual({ lost: 0, lapsed: 0, expired: 0, matched: 1 });
    expect(await assigneeOf(t.id)).toBe(baloo.id);
    const task = await db.agentTask.findUniqueOrThrow({ where: { id: t.id } });
    expect(task).toMatchObject({ status: 'pending', assignedAt: at('11:01'), assignedBy: null, assignedByWorkerId: null });
    const [ev] = await db.agentTeamEvent.findMany({ where: { taskId: t.id } });
    expect(ev).toMatchObject({
      type: 'assignment.matched', subjectWorkerId: baloo.id, actorUserId: null, actorWorkerId: null,
      payload: { assignee: { workerId: baloo.id }, family: 'codex', closeSessionWhenDone: false }, // the stored value, the default since #2249
      createdAt: at('11:01'),
    });
  });

  it('S2: no eligible worker is free → the task stays queued', async () => {
    const t = await queued('11:00', NOT_CLAUDE_REVIEWER);
    expect((await taskMatcherTick(db, at('11:01'))).matched).toBe(0);
    expect(await assigneeOf(t.id)).toBeNull();
  });

  it('S3: Rook (claude) is the only free reviewer and the task requires not claude → not assigned', async () => {
    await bind(rook, 'claude', at('11:00'));
    await bind(anne, 'codex', at('11:00')); // free and codex, but not a reviewer
    const t = await queued('11:00', NOT_CLAUDE_REVIEWER);
    expect((await taskMatcherTick(db, at('11:01'))).matched).toBe(0);
    expect(await assigneeOf(t.id)).toBeNull();
  });

  it('familyIn admits only the named families; excludeWorkerIds leaves a worker out by name', async () => {
    await bind(baloo, 'codex', at('11:00'));
    await bind(liam, 'glm', at('11:00'));
    const onlyGlm = await queued('11:00', { familyIn: ['glm'] });
    const notBaloo = await queued('11:01', { excludeWorkerIds: [baloo.id, liam.id] });
    await taskMatcherTick(db, at('11:02'));
    expect(await assigneeOf(onlyGlm.id)).toBe(liam.id);
    expect(await assigneeOf(notBaloo.id)).toBeNull();
  });

  it('roles compare case-insensitively; a task with no requirements takes anyone free', async () => {
    await bind(anne, 'codex', at('11:00'));
    const t = await queued('11:00', { role: 'Engineer' });
    await taskMatcherTick(db, at('11:01'));
    expect(await assigneeOf(t.id)).toBe(anne.id);
    const anyone = await queued('11:02');
    await bind(rook, 'claude', at('11:00'));
    await taskMatcherTick(db, at('11:03'));
    expect(await assigneeOf(anyone.id)).toBe(rook.id);
  });

  it('the oldest queued task is served first (Proposed)', async () => {
    await bind(baloo, 'codex', at('11:00'));
    const newer = await queued('11:05');
    const older = await queued('11:00');
    await taskMatcherTick(db, at('11:06'));
    expect(await assigneeOf(older.id)).toBe(baloo.id);
    expect(await assigneeOf(newer.id)).toBeNull();
  });

  it('a never-assigned worker ranks least recent; ties break by name, then id (#1707 interim)', async () => {
    await bind(baloo, 'codex', at('11:00'));
    await bind(liam, 'codex', at('11:00'));
    await bind(rook, 'codex', at('11:00'));
    await lastAssigned(baloo, '09:00');
    // Liam and Rook were never assigned: Liam wins on name.
    const t1 = await queued('11:00', { role: 'reviewer' });
    await taskMatcherTick(db, at('11:01'));
    expect(await assigneeOf(t1.id)).toBe(liam.id);
    // Rook (never) ranks before Baloo (09:00).
    const t2 = await queued('11:02', { role: 'reviewer' });
    await taskMatcherTick(db, at('11:03'));
    expect(await assigneeOf(t2.id)).toBe(rook.id);

    const w = (id: string, name: string, last: string | null) => ({ id, name, lastAssignedAt: last ? at(last) : null });
    expect([w('b', 'Bob', '09:00'), w('a', 'amy', null), w('c', 'Amy', null), w('d', 'cal', '08:00')].sort(compareRank).map((x) => x.id))
      .toEqual(['c', 'a', 'd', 'b']);
  });

  it('reassigning to a worker counts as assigning it, for "least recently"', async () => {
    await bind(baloo, 'codex', at('11:00'));
    await bind(liam, 'codex', at('11:00'));
    await lastAssigned(baloo, '09:00');
    await db.agentTeamEvent.create({
      data: { appId: app.id, type: 'task.reassigned', subjectWorkerId: baloo.id, createdAt: at('10:30'), payload: {} },
    });
    await lastAssigned(liam, '10:00');
    const t = await queued('11:00', { role: 'reviewer' });
    await taskMatcherTick(db, at('11:01'));
    expect(await assigneeOf(t.id)).toBe(liam.id);
  });

  it('the matcher\'s own assignments count toward "least recently" (assignment.matched)', async () => {
    await bind(baloo, 'codex', at('11:00'));
    await bind(liam, 'codex', at('11:00'));
    await lastAssigned(liam, '10:00');
    const first = await queued('11:00', { role: 'reviewer' });
    await taskMatcherTick(db, at('11:01'));
    expect(await assigneeOf(first.id)).toBe(baloo.id); // never assigned before
    // Baloo finishes, and both are free again: Baloo was assigned at 11:01, Liam at 10:00.
    await db.agentTask.update({
      where: { id: first.id },
      data: { status: 'finished', startedAt: at('11:02'), finishedAt: at('11:03'), resultOutcome: 'succeeded' },
    });
    const second = await queued('11:04', { role: 'reviewer' });
    await taskMatcherTick(db, at('11:05'));
    expect(await assigneeOf(second.id)).toBe(liam.id);
  });

  it('the WHOLE queue is matched: 500 older tasks nobody can take do not starve a later one (#1723 review, Diego P2-1)', async () => {
    await bind(baloo, 'codex', at('11:00'));
    await db.agentTask.createMany({
      data: Array.from({ length: 500 }, (_, i) => ({
        appId: app.id, title: `Unmatchable ${i}`, ownerUserId: mia.id,
        createdAt: new Date(at('09:00').getTime() + i), requirements: { role: 'nobody' },
      })),
    });
    const last = await queued('10:00', { role: 'reviewer' });
    expect(await taskMatcherTick(db, at('11:01'))).toEqual({ lost: 0, lapsed: 0, expired: 0, matched: 1 });
    expect(await assigneeOf(last.id)).toBe(baloo.id);
  });
});

describe('the family follows the BINDING, not activity (#1723 review, Diego P2-2; cor:agt:060:04)', () => {
  const WorkerField = (resolvers as any).Worker;
  const familyOf = (w: { id: string }): Promise<string | null> =>
    WorkerField.family({ id: w.id, appId: app.id }, {}, ctx(mia.id), { operation: { operation: 'mutation' } });

  it('a quiet, still-open binding keeps its family — and a live host family does not replace it', async () => {
    // Bound as codex at 10:00, quiet ever since; a host can launch Baloo as glm.
    await bind(baloo, 'codex', new Date(Date.now() - 25 * 3_600_000));
    await registerHost(db, { appId: app.id, hostId: 'orca1', label: 'orca1', pollIntervalSeconds: 60, workers: [{ workerId: baloo.id, family: 'glm', worktrees: ['repo/baloo'] }] });
    expect(await familyOf(baloo)).toBe('codex');
    const [state] = (await loadWorkerWorkStates(db, app.id, new Date())).filter((w) => w.id === baloo.id);
    expect(state).toMatchObject({ bound: true, live: false, bindingFamily: 'codex', launchableFamilies: ['glm'], families: ['codex'], freeFamilies: ['codex'] });
    // A quiet BOUND worker is not matchable, whatever a host could launch it as: a glm-only task stays queued, and so does a codex one.
    const glmOnly = await queued('09:00', { familyIn: ['glm'] });
    const codexOk = await queued('09:01', { familyIn: ['codex'] });
    await matchQueuedTasks(db, new Date(), { appId: app.id });
    expect(await assigneeOf(glmOnly.id)).toBeNull();
    expect(await assigneeOf(codexOk.id)).toBeNull();
  });

  it('an actual end clears it; only then does a host family apply', async () => {
    const s = await bind(baloo, 'codex', new Date(Date.now() - 25 * 3_600_000));
    await registerHost(db, { appId: app.id, hostId: 'orca1', label: 'orca1', pollIntervalSeconds: 60, workers: [{ workerId: baloo.id, family: 'glm', worktrees: ['repo/baloo'] }] });
    await db.session.update({ where: { id: s.id }, data: { endedAt: new Date() } });
    expect(await familyOf(baloo)).toBeNull();
    const [state] = (await loadWorkerWorkStates(db, app.id, new Date())).filter((w) => w.id === baloo.id);
    expect(state).toMatchObject({ bound: false, bindingFamily: null, families: ['glm'] });
  });

  it('a newer bind replaces it, live or not', async () => {
    await bind(baloo, 'codex', new Date(Date.now() - 26 * 3_600_000));
    await bind(baloo, 'glm', new Date(Date.now() - 25 * 3_600_000));
    expect(await familyOf(baloo)).toBe('glm');
  });

  it('a quiet binding that is driven again is matched as its family', async () => {
    const s = await bind(baloo, 'codex', new Date(Date.now() - 25 * 3_600_000));
    const t = await queued('09:00', { role: 'reviewer' });
    await matchQueuedTasks(db, new Date(), { appId: app.id });
    expect(await assigneeOf(t.id)).toBeNull();
    await db.session.update({ where: { id: s.id }, data: { updatedAt: new Date() } });
    await matchQueuedTasks(db, new Date(), { appId: app.id });
    expect(await assigneeOf(t.id)).toBe(baloo.id);
  });
});

// ── cor:agt:060:05 — free for work, one disqualifier at a time ────────────

describe('cor:agt:060:05 — free for work: each disqualifier on its own', () => {
  /** Baloo is the only candidate; `setup` disqualifies him or not. */
  async function matchesBaloo(setup: () => Promise<void>, now = at('11:01')): Promise<boolean> {
    await setup();
    const t = await queued('11:00', { role: 'reviewer' });
    await matchQueuedTasks(db, now, { appId: app.id });
    return (await assigneeOf(t.id)) === baloo.id;
  }

  it('control: bound with a family, no task, available → matched', async () => {
    expect(await matchesBaloo(() => bind(baloo, 'codex', at('11:00')).then(() => undefined))).toBe(true);
  });

  it('retired → not matched', async () => {
    expect(await matchesBaloo(async () => {
      await bind(baloo, 'codex', at('11:00'));
      await db.worker.update({ where: { id: baloo.id }, data: { retiredAt: at('10:00') } });
    })).toBe(false);
  });

  it('the assignee of a pending task → not matched', async () => {
    expect(await matchesBaloo(async () => {
      await bind(baloo, 'codex', at('11:00'));
      await db.agentTask.create({ data: { appId: app.id, title: 'Busy', ownerUserId: mia.id, assigneeWorkerId: baloo.id, assignedAt: at('10:00') } });
    })).toBe(false);
  });

  it('the assignee of a started task → not matched', async () => {
    expect(await matchesBaloo(async () => {
      await bind(baloo, 'codex', at('11:00'));
      await db.agentTask.create({
        data: { appId: app.id, title: 'Busy', ownerUserId: mia.id, assigneeWorkerId: baloo.id, assignedAt: at('10:00'), status: 'started', startedAt: at('10:05') },
      });
    })).toBe(false);
  });

  it('kept bound after a FINISHED task (closeSessionWhenDone: false) → free, and keeps its family', async () => {
    expect(await matchesBaloo(async () => {
      await bind(baloo, 'codex', at('11:00'));
      await db.agentTask.create({
        data: {
          appId: app.id, title: 'Done', ownerUserId: mia.id, assigneeWorkerId: baloo.id, assignedAt: at('09:00'),
          status: 'finished', startedAt: at('09:05'), finishedAt: at('10:00'), resultOutcome: 'succeeded', closeSessionWhenDone: false,
        },
      });
    })).toBe(true);
  });

  it('unavailable by its own record (out of tokens until 18:00) → not matched; after 18:00 → matched', async () => {
    const mark = async () => {
      await bind(baloo, 'codex', at('11:00'));
      await db.workerAvailability.create({
        data: { workerId: baloo.id, state: 'unavailable', reason: 'out-of-tokens', until: at('18:00'), setAt: at('10:00'), setBy: 'holder', setByUserId: mia.id },
      });
    };
    expect(await matchesBaloo(mark)).toBe(false);
    await bind(baloo, 'codex', at('18:00'));
    await matchQueuedTasks(db, at('18:01'), { appId: app.id });
    expect(await db.agentTask.count({ where: { assigneeWorkerId: baloo.id } })).toBe(1);
  });

  it('stalled (cor:agt:060:07) → not matched', async () => {
    expect(await matchesBaloo(async () => {
      await bind(baloo, 'codex', at('10:00'));
      await db.workerAvailability.create({
        data: { workerId: baloo.id, state: 'unavailable', reason: 'stalled', setAt: at('10:30'), setBy: 'stall-rule' },
      });
    })).toBe(false);
  });

  it('its model family is unavailable in the App (cor:agt:060:03) → not matched', async () => {
    expect(await matchesBaloo(async () => {
      await bind(baloo, 'codex', at('11:00'));
      await db.modelFamilyAvailability.create({
        data: { appId: app.id, family: 'codex', state: 'unavailable', reason: 'other', setAt: at('10:00'), setByUserId: admin.id },
      });
    })).toBe(false);
  });

  it('bound, but its session reported no model family → not matched', async () => {
    expect(await matchesBaloo(() => bind(baloo, null, at('11:00')).then(() => undefined))).toBe(false);
  });

  it('family follows the binding: an ENDED session gives none, so not matched', async () => {
    expect(await matchesBaloo(async () => {
      const s = await bind(baloo, 'codex', at('10:00'));
      await db.session.update({ where: { id: s.id }, data: { endedAt: at('10:30') } });
    })).toBe(false);
  });

  it('a lapsed session (idle past its window) is not live, so not matched', async () => {
    expect(await matchesBaloo(() => bind(baloo, 'codex', at('10:00')).then(() => undefined), new Date(at('10:00').getTime() + 25 * 3_600_000)))
      .toBe(false);
  });

  it('the newest open session is the binding: its family wins, even when it reported none', async () => {
    expect(await matchesBaloo(async () => {
      await bind(baloo, 'codex', at('10:00'));
      await bind(baloo, null, at('10:30'));
    })).toBe(false);
  });

  it('#1709 (T6): unbound but launchable by a live host → matched, and its host is asked to start it in its worktree', async () => {
    await registerHost(db, { appId: app.id, hostId: 'orca1', label: 'orca1', pollIntervalSeconds: 60, workers: [{ workerId: baloo.id, family: 'codex', worktrees: ['repo/baloo'] }] }, at('11:00'));
    const t = await queued('11:00', { role: 'reviewer' });
    await matchQueuedTasks(db, at('11:01'), { appId: app.id });
    expect(await assigneeOf(t.id)).toBe(baloo.id);
    const ops = await db.hostOperation.findMany();
    expect(ops.map((o) => [o.type, o.hostId, o.issuedBy, o.args])).toEqual([
      ['worker.start', 'orca1', 'platform', { workerId: baloo.id, worktree: 'repo/baloo', family: 'codex', taskId: t.id }],
    ]);
  });

  it('#1709: a registered worker with no worktree on the host is not launchable, so not matched; the task waits', async () => {
    await registerHost(db, { appId: app.id, hostId: 'orca1', label: 'orca1', pollIntervalSeconds: 60, workers: [{ workerId: baloo.id, family: 'codex' }] }, at('11:00'));
    const t = await queued('11:00', { role: 'reviewer' });
    await matchQueuedTasks(db, at('11:01'), { appId: app.id });
    expect(await assigneeOf(t.id)).toBeNull();
    expect(await db.hostOperation.count()).toBe(0);
  });
});

describe('requirements and eligibility (pure)', () => {
  it('parseRequirements reads T1\'s stored shape and lowercases families', () => {
    expect(parseRequirements({ role: 'reviewer', familyNotIn: ['Claude'], excludeWorkerIds: ['w1'] }))
      .toEqual({ role: 'reviewer', familyIn: undefined, familyNotIn: ['claude'], excludeWorkerIds: ['w1'] });
    expect(parseRequirements(null)).toEqual({});
  });

  it('eligibleFamily picks the first free family the task allows', () => {
    const w = { id: 'w', role: 'reviewer', freeFamilies: ['claude', 'codex'] };
    expect(eligibleFamily({ familyNotIn: ['claude'] }, w)).toBe('codex');
    expect(eligibleFamily({ familyIn: ['glm'] }, w)).toBeNull();
    expect(eligibleFamily({ role: 'engineer' }, w)).toBeNull();
    expect(eligibleFamily({ excludeWorkerIds: ['w'] }, w)).toBeNull();
    expect(eligibleFamily({}, { ...w, freeFamilies: [] })).toBeNull();
  });
});

// ── When matching runs ────────────────────────────────────────────────────

describe('matching triggers (060:06 interim): create, finish, cancel, availability; a sweep', () => {
  it('a task created with no assignee is matched at once; the returned task shows the assignee', async () => {
    await bind(baloo, 'codex');
    const t = await M.createAgentTask({}, { input: { appRef: app.id, title: 'Review', requirements: { role: 'reviewer' } } }, ctx(mia.id));
    expect(t.assigneeWorkerId).toBe(baloo.id);
    const types = (await db.agentTeamEvent.findMany({ where: { taskId: t.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })).map((e) => e.type);
    expect(types).toEqual(['task.created', 'assignment.queued', 'assignment.matched']);
  });

  it('a task created WITH an assignee does not run the matcher for itself', async () => {
    await bind(baloo, 'codex');
    const t = await M.createAgentTask({}, { input: { appRef: app.id, title: 'Mine', assignee: { worker: 'Liam' } } }, ctx(mia.id));
    expect(t.assigneeWorkerId).toBe(liam.id);
    expect(await db.agentTeamEvent.count({ where: { type: { in: ['assignment.queued', 'assignment.matched'] } } })).toBe(0);
  });

  it('finishing a task frees its worker, and the next queued task goes to it', async () => {
    const s = await bind(baloo, 'codex');
    const busy = await db.agentTask.create({
      data: { appId: app.id, title: 'Busy', ownerUserId: mia.id, assigneeWorkerId: baloo.id, assignedAt: new Date(), status: 'started', startedAt: new Date(), closeSessionWhenDone: false },
    });
    const waiting = await queued('09:00', { role: 'reviewer' });
    expect(await assigneeOf(waiting.id)).toBeNull();
    expect(s.id).toBeTruthy();
    await runAsActor({ workerId: baloo.id, agentId }, () =>
      M.finishAgentTask({}, { taskId: busy.id, result: { outcome: 'succeeded' } }, ctx(mia.id)));
    expect(await assigneeOf(waiting.id)).toBe(baloo.id);
  });

  it('cancelling a task frees its worker', async () => {
    await bind(baloo, 'codex');
    const busy = await db.agentTask.create({
      data: { appId: app.id, title: 'Busy', ownerUserId: mia.id, assigneeWorkerId: baloo.id, assignedAt: new Date(), closeSessionWhenDone: false },
    });
    const waiting = await queued('09:00', { role: 'reviewer' });
    await M.cancelAgentTask({}, { taskId: busy.id }, ctx(mia.id));
    expect(await assigneeOf(waiting.id)).toBe(baloo.id);
  });

  it('#1709: a worker asked to end its session gets no new work until that session ends (Proposed)', async () => {
    const s = await bind(baloo, 'codex');
    const busy = await db.agentTask.create({
      data: { appId: app.id, title: 'Busy', ownerUserId: mia.id, assigneeWorkerId: baloo.id, assignedAt: new Date(), closeSessionWhenDone: true },
    });
    const waiting = await queued('09:00', { role: 'reviewer' });
    await M.cancelAgentTask({}, { taskId: busy.id }, ctx(mia.id));
    expect(await db.taskSessionEndRequest.count({ where: { workerId: baloo.id, sessionId: s.id } })).toBe(1);
    expect(await assigneeOf(waiting.id)).toBeNull();
    // The session ends: the worker is matched again, on its next session.
    await db.session.update({ where: { id: s.id }, data: { endedAt: new Date() } });
    await bind(baloo, 'codex');
    await matchQueuedTasks(db, new Date(), { appId: app.id });
    expect(await assigneeOf(waiting.id)).toBe(baloo.id);
  });

  it('an availability change (the holder marks the worker available again) matches at once', async () => {
    await bind(baloo, 'codex');
    await db.workerAvailability.create({
      data: { workerId: baloo.id, state: 'unavailable', reason: 'other', setAt: new Date(), setBy: 'holder', setByUserId: mia.id },
    });
    const waiting = await queued('09:00', { role: 'reviewer' });
    await matchQueuedTasks(db, new Date(), { appId: app.id });
    expect(await assigneeOf(waiting.id)).toBeNull();
    await M.setWorkerAvailability({}, { input: { worker: baloo.id, state: 'AVAILABLE' } }, ctx(mia.id));
    expect(await assigneeOf(waiting.id)).toBe(baloo.id);
  });

  it('a model family made available again matches at once', async () => {
    await bind(baloo, 'codex');
    await db.modelFamilyAvailability.create({
      data: { appId: app.id, family: 'codex', state: 'unavailable', reason: 'other', setAt: new Date(), setByUserId: admin.id },
    });
    const waiting = await queued('09:00', { role: 'reviewer' });
    await M.setModelFamilyAvailability({}, { input: { appRef: app.id, family: 'codex', state: 'AVAILABLE' } }, ctx(admin.id));
    expect(await assigneeOf(waiting.id)).toBe(baloo.id);
  });

  it('DISABLE_TASK_MATCHER=true turns the event-driven run off', async () => {
    process.env.DISABLE_TASK_MATCHER = 'true';
    await bind(baloo, 'codex');
    const t = await M.createAgentTask({}, { input: { appRef: app.id, title: 'Review' } }, ctx(mia.id));
    expect(t.assigneeWorkerId).toBeNull();
  });

  it('the sweep matches every App with a queued task, and leaves an uninstalled App\'s alone', async () => {
    await bind(baloo, 'codex', at('11:00'));
    const t = await queued('11:00', { role: 'reviewer' });
    await db.app.update({ where: { id: app.id }, data: { uninstalledAt: at('10:00') } });
    expect((await taskMatcherTick(db, at('11:01'))).matched).toBe(0);
    await db.app.update({ where: { id: app.id }, data: { uninstalledAt: null } });
    expect((await taskMatcherTick(db, at('11:02'))).matched).toBe(1);
    expect(await assigneeOf(t.id)).toBe(baloo.id);
  });
});

// ── Concurrency ───────────────────────────────────────────────────────────

describe('concurrent runs never double-assign a task or a worker', () => {
  it('N parallel runs over M queued tasks: every task at most one assignee, every worker at most one task', async () => {
    const workers = [baloo, liam, rook, anne];
    for (const w of workers) await bind(w, 'codex', at('11:00'));
    const tasks = [];
    for (let i = 0; i < 7; i++) tasks.push(await queued(`10:0${i}`));
    const runs = await Promise.all(Array.from({ length: 8 }, () => matchQueuedTasks(db, at('11:01'), { appId: app.id })));
    const reported = runs.flat();
    // Each assignment was reported by exactly one run.
    expect(reported).toHaveLength(workers.length);
    expect(new Set(reported.map((r) => r.taskId)).size).toBe(workers.length);
    expect(new Set(reported.map((r) => r.workerId)).size).toBe(workers.length);
    // The database agrees: four assigned tasks, one per worker, one matched event each.
    const assigned = await db.agentTask.findMany({ where: { appId: app.id, assigneeWorkerId: { not: null } } });
    expect(assigned).toHaveLength(workers.length);
    expect(new Set(assigned.map((t) => t.assigneeWorkerId)).size).toBe(workers.length);
    expect(await db.agentTeamEvent.count({ where: { type: 'assignment.matched' } })).toBe(workers.length);
    // The oldest four were served.
    expect(assigned.map((t) => t.id).sort()).toEqual(tasks.slice(0, 4).map((t) => t.id).sort());
  });

  /** A gate a hook waits on, released by the test. */
  function gate() {
    let open!: () => void;
    let reached!: () => void;
    const opened = new Promise<void>((r) => { open = r; });
    const arrived = new Promise<void>((r) => { reached = r; });
    return { open, arrived, hook: async () => { reached(); await opened; } };
  }

  const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const row = (id: string) => db.agentTask.findUniqueOrThrow({ where: { id }, select: { id: true, appId: true, requirements: true, closeSessionWhenDone: true } });

  it('the per-worker lock: a second attempt on the SAME worker waits, re-checks, and finds it no longer free', async () => {
    await bind(baloo, 'codex', at('11:00'));
    const t1 = await queued('10:00');
    const t2 = await queued('10:01');
    const g = gate();
    const first = __matcherTesting.tryAssign(db, await row(t1.id), baloo.id, 'codex', at('11:01'), { afterWorkerCheck: g.hook });
    await g.arrived; // the first holds Baloo's lock, checked free, not yet assigned
    let secondDone = false;
    const second = __matcherTesting.tryAssign(db, await row(t2.id), baloo.id, 'codex', at('11:01'), {}).then((o) => { secondDone = true; return o; });
    await tick(300);
    expect(secondDone).toBe(false); // waiting on the lock
    g.open();
    expect(await first).toBe('assigned');
    expect(await second).toBe('worker-not-free');
    expect(await db.agentTask.count({ where: { assigneeWorkerId: baloo.id } })).toBe(1);
  });

  it('the App graph decision: two workers racing for one task serialize and the loser changes nothing', async () => {
    await bind(baloo, 'codex', at('11:00'));
    await bind(liam, 'glm', at('11:00'));
    const t = await queued('10:00');
    const g = gate();
    const first = __matcherTesting.tryAssign(db, await row(t.id), baloo.id, 'codex', at('11:01'), { afterWorkerCheck: g.hook });
    await g.arrived;
    const second = __matcherTesting.tryAssign(db, await row(t.id), liam.id, 'glm', at('11:01'), {});
    g.open();
    expect(await first).toBe('assigned');
    expect(await second).toBe('task-gone');
    expect(await assigneeOf(t.id)).toBe(baloo.id);
    expect(await db.agentTeamEvent.count({ where: { type: 'assignment.matched' } })).toBe(1);
  });
});

// ── #1754 — a backlog task is never matched (cor:agt:050:02) ──────────────

describe('#1754 — a backlog task is never matched (cor:agt:050:02)', () => {
  /** A REAL queued stint, as create leaves it: the row and its queue-entry event, both at `t`. */
  async function queuedAt(t: string, extra: Record<string, unknown> = {}) {
    const row = await db.agentTask.create({
      data: { appId: app.id, title: 'Review', ownerUserId: mia.id, createdAt: at(t), ...extra },
      select: { id: true },
    });
    await db.agentTeamEvent.create({
      data: { appId: app.id, taskId: row.id, type: 'assignment.queued', createdAt: at(t) },
    });
    return row;
  }

  it('a free, matching worker and a born-backlog task: the tick assigns nothing and writes no event', async () => {
    await bind(baloo, 'codex', at('11:00'));
    const t = await db.agentTask.create({
      data: { appId: app.id, title: 'Parked', ownerUserId: mia.id, status: 'backlog', createdAt: at('11:00') },
      select: { id: true },
    });
    expect(await taskMatcherTick(db, at('11:01'))).toEqual({ lost: 0, lapsed: 0, expired: 0, matched: 0 });
    expect(await db.agentTask.findUniqueOrThrow({ where: { id: t.id } }))
      .toMatchObject({ status: 'backlog', assigneeWorkerId: null, assigneeUserId: null });
    expect(await db.agentTeamEvent.findMany({ where: { taskId: t.id } })).toEqual([]);
  });

  it('a task parked FROM THE QUEUE (a real queue stint behind it) is not matched (#1790 Xylon P2-2)', async () => {
    await bind(baloo, 'codex', at('11:00'));
    const t = await queuedAt('10:00', { status: 'backlog' }); // queued at 10:00, parked since
    expect(await taskMatcherTick(db, at('11:01'))).toEqual({ lost: 0, lapsed: 0, expired: 0, matched: 0 });
    expect(await db.agentTask.findUniqueOrThrow({ where: { id: t.id } }))
      .toMatchObject({ status: 'backlog', assigneeWorkerId: null, assigneeUserId: null });
  });

  it('a task made ready again re-enters the queue and KEEPS ITS CREATION RANK (createdAt order, by design)', async () => {
    await bind(baloo, 'codex', at('11:00'));
    const older = await queuedAt('10:00'); // queued, parked, made ready again before the tick
    await db.agentTask.update({ where: { id: older.id }, data: { status: 'backlog' } });
    await db.agentTeamEvent.create({
      data: { appId: app.id, taskId: older.id, type: 'assignment.queued', createdAt: at('11:30') },
    });
    await db.agentTask.update({ where: { id: older.id }, data: { status: 'pending' } });
    const younger = await queuedAt('11:00'); // queued continuously
    expect(await taskMatcherTick(db, at('11:31'))).toEqual({ lost: 0, lapsed: 0, expired: 0, matched: 1 });
    expect(await assigneeOf(older.id)).toBe(baloo.id);
    expect(await assigneeOf(younger.id)).toBeNull();
  });
});

describe('#1961 the roster SDL states the shipped matching rule', () => {
  const field = (name: string) => new RegExp(`"([^"]*)"\\n\\s*${name}: `).exec(/type TeamRosterEntry \{[^}]*\}/.exec(typeDefs)![0])?.[1] ?? '';
  const state = (name: string) => new RegExp(`"([^"]*)"\\n\\s*${name}\\n`).exec(/enum TeamRosterState \{[^}]*\}/.exec(typeDefs)![0])?.[1] ?? '';

  it('matchable: a bound worker only while live, an unbound one always (free for work then needs a launchable family)', () => {
    expect(matchable({ bound: true, live: true })).toBe(true);
    expect(matchable({ bound: true, live: false })).toBe(false);
    expect(matchable({ bound: false, live: false })).toBe(true);
    expect(matchable({ bound: false, live: false, endingSession: true })).toBe(false);
  });

  it('liveSession and AVAILABLE describe that rule, with no pre-T6 restriction left', () => {
    expect(field('liveSession')).toContain('The matcher assigns to a BOUND worker only while it has one');
    expect(field('liveSession')).toContain('an unbound worker is matched when a live host can launch it');
    expect(state('AVAILABLE')).toContain('an unbound worker a live host can launch, which the matcher assigns to');
    expect(state('AVAILABLE')).toContain('which the matcher leaves alone until its session is live again');
    for (const text of [field('liveSession'), state('AVAILABLE')]) expect(text).not.toMatch(/host-operations slice|until T6/);
  });
});

// Private per-worker DB only. A blocker-specific barrier proves the intended
// transaction is waiting; unrelated waiters cannot satisfy this schedule.
async function blockedBy(pid: number) {
  const deadline = Date.now() + 3000;
  for (;;) {
    const [{ n }] = await db.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND ${pid} = ANY(pg_blocking_pids(pid))`;
    if (n > 0) return;
    if (Date.now() > deadline) throw new Error('intended blocker has no waiter');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function hold(work: (tx: Prisma.TransactionClient) => Promise<void>) {
  let ready!: (pid: number) => void;
  const held = new Promise<number>((resolve) => { ready = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const done = db.$transaction(async (tx) => {
    const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
    await work(tx);
    ready(pid);
    await gate;
  }, { timeout: 10000 });
  return { held, release, done };
}

describe('#2191 deciding checks after real lock waits', () => {
  for (const change of ['usesTasks', 'role', 'family'] as const) {
    it(`an already-deciding assignment fences a later ${change} change without an upgrade cycle`, async () => {
      const session = await bind(baloo, 'codex', at('11:00'));
      const requirements = { role: 'reviewer', familyIn: ['codex'] };
      const task = await queued('11:00', requirements);
      let ready!: (pid: number) => void;
      const held = new Promise<number>((resolve) => { ready = resolve; });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const pending = __matcherTesting.tryAssign(db, { ...task, appId: app.id, requirements, closeSessionWhenDone: false }, baloo.id, 'codex', at('11:01'), {
        afterWorkerCheck: async () => {
          const [row] = await db.$queryRaw<Array<{ pid: number }>>`
            SELECT l.pid FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
            WHERE a.datname = current_database() AND l.locktype = 'advisory' AND l.granted
              AND l.classid::bigint = (hashtext('agent-task-matcher:worker')::bigint & 4294967295)
              AND l.objid::bigint = (hashtext(${baloo.id})::bigint & 4294967295) AND l.objsubid = 2`;
          ready(row.pid);
          await gate;
        },
      });
      const pid = await held;
      const changed = (change === 'usesTasks'
        ? db.agent.update({ where: { id: agentId }, data: { usesTasks: false } })
        : change === 'role'
          ? db.worker.update({ where: { id: baloo.id }, data: { role: 'engineer' } })
          : db.session.update({ where: { id: session.id }, data: { family: 'claude' } })).then((row) => row);
      try { await blockedBy(pid); } finally { release(); }
      expect(await pending).toBe('assigned');
      await changed;
      expect(await assigneeOf(task.id)).toBe(baloo.id);
    });
  }

  it('an Agent flag change that wins the row lock is honored', async () => {
    await bind(baloo, 'codex', at('11:00'));
    const task = await queued('11:00');
    const h = hold(async (tx) => { await tx.agent.update({ where: { id: agentId }, data: { usesTasks: false } }); });
    const pid = await h.held;
    const pending = __matcherTesting.tryAssign(db, { ...task, appId: app.id, requirements: null, closeSessionWhenDone: false }, baloo.id, 'codex', at('11:01'), {});
    try { await blockedBy(pid); } finally { h.release(); }
    await h.done;
    expect(await pending).toBe('worker-not-free');
    expect(await assigneeOf(task.id)).toBeNull();
  });

  for (const change of ['role', 'family'] as const) {
    it(`rechecks ${change} changed while waiting for the worker advisory lock`, async () => {
      const session = await bind(baloo, 'codex', at('11:00'));
      const requirements = { role: 'reviewer', familyIn: ['codex'] };
      const task = await queued('11:00', requirements);
      const h = hold(async (tx) => { await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('agent-task-matcher:worker'), hashtext(${baloo.id}))`; });
      const pid = await h.held;
      const pending = __matcherTesting.tryAssign(db, { ...task, appId: app.id, requirements, closeSessionWhenDone: false }, baloo.id, 'codex', at('11:01'), {});
      try {
        await blockedBy(pid);
        if (change === 'role') await db.worker.update({ where: { id: baloo.id }, data: { role: 'engineer' } });
        else await db.session.update({ where: { id: session.id }, data: { family: 'claude' } });
      } finally { h.release(); }
      await h.done;
      expect(await pending).toBe('worker-not-free');
      expect(await assigneeOf(task.id)).toBeNull();
    });
  }
});

// #2644: priority is a queue ordering input, never matching eligibility.
describe('#2644 blocker and priority queue', () => {
  it('skips an open blocker, chooses lowest priority then FIFO, and retains later pages', async () => {
    await bind(baloo, 'codex', at('11:00'));
    const blocker = await queued('09:00', null, { status: 'backlog' });
    const blocked = await queued('09:01', null, { priority: 1 });
    await db.agentTaskBlocker.create({ data: { taskId: blocked.id, blockerTaskId: blocker.id } });
    const low = await queued('09:02', null, { priority: 5 });
    const high = await queued('09:03', null, { priority: 2 });
    const tie = await queued('09:04', null, { priority: 2 });
    expect(await matchQueuedTasks(db, at('11:01'), { appId: app.id })).toMatchObject([{ taskId: high.id }]);
    expect(await assigneeOf(blocked.id)).toBeNull();
    expect(await assigneeOf(low.id)).toBeNull();
    expect(await assigneeOf(tie.id)).toBeNull();
  });
  it('passes more than one page of mixed priorities and ties that nobody can take', async () => {
    await bind(baloo, 'codex', at('11:00'));
    await db.agentTask.createMany({ data: Array.from({ length: 501 }, (_, i) => ({
      id: generateId(), appId: app.id, title: 'Synthetic ineligible', ownerUserId: mia.id,
      priority: i < 250 ? 1 : 2, createdAt: at('10:00'), requirements: { role: 'unmatched-role' },
    })) });
    const target = await queued('09:00', { role: 'reviewer' }, { priority: 3 });
    expect(await matchQueuedTasks(db, at('11:01'), { appId: app.id })).toMatchObject([{ taskId: target.id, workerId: baloo.id }]);
  });
});
