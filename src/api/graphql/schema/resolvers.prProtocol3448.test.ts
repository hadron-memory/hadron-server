import { settledTeamEventQueries } from '../../../test/teamEventHorizon.js';
import { canReadMemory } from '../../../mcp/access-control.js';
/** #3448: PR protocol facts are typed events, never opaque properties (cor:agt:050:28). */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
import * as taskProperties from '../../../lib/agentTasks/properties.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import * as taskGraphLocks from '../../../lib/agentTasks/blockers.js';
import { RegisterLookup } from '../../../lib/actionRegister/lookup.js';
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn() }));

const M = resolvers.Mutation as Record<string, (...args: any[]) => Promise<any>>;
const Q = settledTeamEventQueries(resolvers.Query, db) as Record<string, (...args: any[]) => Promise<any>>;
const H = 'a'.repeat(40), H2 = 'b'.repeat(40);
let owner: any, author: any, reviewer: any, other: any, outsider: any, app: any, build: any;
const ctx = (userId = owner.id) => ({ db, userId, roles: ['READER' as const] });
const error = (code: string) => ({ extensions: { code } });
async function command(name: string, args: Record<string, unknown>, who = owner.id) {
  expect(M[name], `${name} must exist`).toBeTypeOf('function');
  return M[name]!({}, args, ctx(who));
}
async function readiness(head = H, who = owner.id) {
  expect(Q.pullRequestReadiness, 'pullRequestReadiness must exist').toBeTypeOf('function');
  return Q.pullRequestReadiness!({}, { taskRef: build.id, head }, ctx(who));
}
const schedule = (slots = ['local', 'blind', 'security'], who = owner.id) => command('setReviewSchedule', { taskRef: build.id, slots }, who);
const freeze = (head = H, who = author.id) => command('freezePullRequestHead', { taskRef: build.id, head }, who);
const events = (id = build.id) => db.agentTeamEvent.findMany({ where: { taskId: id, type: { in: ['review.scheduled', 'pr.frozen', 'review.seat.assigned', 'review.verdict', 'pr.ready'] } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
const stored = (id = build.id) => db.agentTask.findUniqueOrThrow({ where: { id } });
async function seat(slot: string, head = H, who = reviewer.id, supersedes?: string) {
  const t = await M.createAgentTask!({}, { input: { parentTaskId: build.id, title: slot, assignee: { user: who }, source: 'synthetic' } }, ctx(author.id));
  await command('assignReviewSeat', { taskRef: t.id, slot, head, supersedes }, author.id);
  return t;
}
async function verdict(t: any, value = 'APPROVE', head = H, who = reviewer.id) {
  await M.startAgentTask!({}, { taskId: t.id }, ctx(who));
  return command('recordReviewVerdict', { taskRef: t.id, head, verdict: value, node: 'hrn:node:example.test:reviews:one', receipt: 'https://example.test/receipt' }, who);
}
async function finish(t: any, who = reviewer.id) {
  return M.finishAgentTask!({}, { taskId: t.id, result: { outcome: 'approved' } }, ctx(who));
}
async function readySeats() {
  await schedule(); await freeze();
  const seats = [];
  for (const [slot, v] of [['local', 'APPROVE'], ['blind', 'CARRY'], ['security', 'PASS']]) {
    const t = await seat(slot!); await verdict(t, v); await finish(t); seats.push(t);
  }
  return seats;
}

beforeEach(async () => {
  await cleanDb(db);
  [owner, author, reviewer, other, outsider] = await Promise.all(['owner', 'author', 'reviewer', 'other', 'outsider'].map(handle => db.user.create({ data: { handle } })));
  const org = await db.organization.create({ data: { name: 'Protocol', urn: `protocol-${generateId()}.test` } });
  app = await db.app.create({ data: { organizationId: org.id, name: 'Protocol', urn: `${org.urn}:app` } });
  for (const u of [owner, author, reviewer, other]) await db.appMember.create({ data: { appId: app.id, userId: u.id, role: 'member' } });
  build = await M.createAgentTask!({}, { input: { appRef: app.id, title: 'Build', source: 'synthetic', assignee: { user: author.id }, references: [{ kind: 'PULL_REQUEST', target: 'https://github.com/example/project/pull/1' }] } }, ctx());
});

describe('typed PR schedule and freeze', () => {
  it('adds the GraphQL commands and closed verdict enum', async () => {
    const api = new ApolloServer({ typeDefs, resolvers: { ...resolvers, Query: settledTeamEventQueries(resolvers.Query, db) } });
    const r = await api.executeOperation({ query: '{__type(name:"ReviewVerdict"){enumValues{name}}}' });
    expect((r.body as any).singleResult.data.__type.enumValues.map((v: any) => v.name)).toEqual(['APPROVE', 'CHANGES_REQUESTED', 'PASS', 'FAIL', 'CARRY', 'REFUSED']);
    await api.stop();
  });
  it('owner writes a schedule event/mirror; a later schedule replaces it', async () => {
    await schedule(); await schedule(['local']); await freeze();
    expect((await events()).filter(e => e.type === 'review.scheduled').map(e => e.payload)).toEqual([{ slots: ['local', 'blind', 'security'] }, { slots: ['local'] }]);
    expect((await stored()).properties).toMatchObject({ 'review.schedule': ['local'] });
    expect((await readiness()).slots.map((s: any) => s.slot)).toEqual(['local']);
  });
  it('the assignee is not a schedule writer, with nothing written', async () => {
    await expect(schedule(['local'], author.id)).rejects.toMatchObject(error('TASK_NOT_OWNER'));
    expect(await events()).toHaveLength(0); expect((await stored()).properties).toBeNull();
  });
  it('a schedule writer who is also the assignee is still refused', async () => {
    const t = await M.createAgentTask!({}, { input: { appRef: app.id, title: 'Own build', source: 's', assignee: { user: author.id } } }, ctx(author.id));
    await expect(command('setReviewSchedule', { taskRef: t.id, slots: ['local'] }, author.id)).rejects.toMatchObject(error('TASK_NOT_OWNER'));
    expect(await events(t.id)).toHaveLength(0);
  });
  it.each([[], ['local', 'local'], ['a b'], ['x'.repeat(65)], ['local.'], ['qa::portal'], ['qa:']])('refuses invalid slots %j atomically', async (...slots) => {
    await expect(schedule(slots as string[])).rejects.toMatchObject(error('BAD_USER_INPUT'));
    expect(await events()).toHaveLength(0);
  });
  it('accepts the namespaced slot qa:portal', async () => {
    await schedule(['qa:portal']); await freeze();
    expect((await readiness()).slots[0].slot).toBe('qa:portal');
  });
  it('freeze writes the head, PR reference, actor, mirror and a code-only person action', async () => {
    const r = await freeze();
    expect(r.action).toEqual({ code: 'pr.frozen', state: 'WITHHELD' });
    expect((await events())[0]).toMatchObject({ type: 'pr.frozen', actorUserId: author.id, payload: { head: H, pullRequest: 'https://github.com/example/project/pull/1' } });

      expect((await stored()).properties).toMatchObject({ 'pr.head': H });
  });
  it.each(['abc', 'z'.repeat(40)])('refuses invalid SHA %s without writes', async head => {
    await expect(freeze(head)).rejects.toMatchObject(error('BAD_USER_INPUT')); expect(await events()).toHaveLength(0);
  });
  it('only the assignee freezes', async () => {
    await expect(freeze(H, owner.id)).rejects.toMatchObject(error('TASK_NOT_ASSIGNEE')); expect(await events()).toHaveLength(0);
  });
  it('requires a pull_request reference', async () => {
    await M.updateAgentTask!({}, { taskId: build.id, input: { references: [] } }, ctx());
    await expect(freeze()).rejects.toMatchObject(error('PR_REFERENCE_MISSING')); expect(await events()).toHaveLength(0);
  });
});

describe('seat binding and verdicts', () => {
  it('rejects an unscheduled slot and wrong frozen head', async () => {
    await schedule(['local']); await freeze();
    await expect(seat('blind')).rejects.toMatchObject(error('REVIEW_SLOT_UNKNOWN'));
    await expect(seat('local', H2)).rejects.toMatchObject(error('REVIEW_HEAD_MISMATCH'));
  });
  it('only the seat owner-chain assigns it', async () => {
    await schedule(); await freeze(); const t = await seat('local'); const before = await events(t.id);
    await expect(command('assignReviewSeat', { taskRef: t.id, slot: 'local', head: H }, reviewer.id)).rejects.toMatchObject(error('TASK_NOT_OWNER'));
    expect(await events(t.id)).toEqual(before);
  });
  it('supersedes must be a sibling assigned to the same slot', async () => {
    await schedule(); await freeze(); const t = await seat('local');
    await expect(seat('blind', H, reviewer.id, t.id)).rejects.toMatchObject(error('REVIEW_SEAT_SUPERSEDE_INVALID'));
    await expect(seat('local', H, reviewer.id, build.id)).rejects.toMatchObject(error('REVIEW_SEAT_SUPERSEDES_REQUIRED'));
  });
  it('a no-verdict seat can be superseded at the same head', async () => {
    await schedule(['local']); await freeze(); const old = await seat('local');
    const now = await seat('local', H, reviewer.id, old.id);
    expect((await readiness()).slots[0].currentTaskId).toBe(now.id);
  });
  it.each(['CHANGES_REQUESTED', 'FAIL', 'REFUSED'])('cannot shop away %s at the same head, but a new head permits replacement', async value => {
    await schedule(['local']); await freeze(); const old = await seat('local'); await verdict(old, value); await finish(old);
    const replacement = await M.createAgentTask!({}, { input: { parentTaskId: build.id, title: 'Replacement', assignee: { user: other.id }, source: 'synthetic' } }, ctx(author.id));
    const args = { taskRef: replacement.id, slot: 'local', head: H, supersedes: old.id };
    await expect(command('assignReviewSeat', args, author.id)).rejects.toMatchObject(error('REVIEW_SEAT_NOT_SUPERSEDABLE'));
    expect(await events(replacement.id)).toHaveLength(0); expect((await stored(replacement.id)).properties).toBeNull();
    await freeze(H2); await command('assignReviewSeat', { ...args, head: H2 }, author.id);
    await verdict(replacement, 'APPROVE', H2, other.id); await finish(replacement, other.id);
    expect((await readiness(H2)).ready).toBe(true);
  });
  it('cannot implicitly replace a negative current seat by omitting supersedes', async () => {
    await schedule(['local']); await freeze(); const old = await seat('local'); await verdict(old, 'CHANGES_REQUESTED');
    await expect(seat('local', H, other.id)).rejects.toMatchObject(error('REVIEW_SEAT_NOT_SUPERSEDABLE'));
    expect((await readiness()).slots[0].currentTaskId).toBe(old.id);
  });
  it('cannot move a negative seat to another slot at the same head', async () => {
    await schedule(); await freeze(); const old = await seat('local'); await verdict(old, 'FAIL');
    await expect(command('assignReviewSeat', { taskRef: old.id, slot: 'blind', head: H }, author.id)).rejects.toMatchObject(error('REVIEW_SEAT_NOT_SUPERSEDABLE'));
    expect((await readiness()).slots[0].currentTaskId).toBe(old.id);
  });
  it('a non-negative current seat still requires an explicit current-seat supersedes pointer', async () => {
    await schedule(['local']); await freeze(); const old = await seat('local');
    await expect(seat('local')).rejects.toMatchObject(error('REVIEW_SEAT_SUPERSEDES_REQUIRED'));
    const now = await seat('local', H, reviewer.id, old.id);
    await expect(seat('local', H, reviewer.id, old.id)).rejects.toMatchObject(error('REVIEW_SEAT_SUPERSEDES_REQUIRED'));
    expect((await readiness()).slots[0].currentTaskId).toBe(now.id);
  });
  it('a seat task is assigned only once, even without a verdict or a slot change', async () => {
    await schedule(); await freeze(); const t = await seat('local');
    await expect(command('assignReviewSeat', { taskRef: t.id, slot: 'local', head: H }, author.id)).rejects.toMatchObject(error('REVIEW_SEAT_ALREADY_ASSIGNED'));
    await expect(command('assignReviewSeat', { taskRef: t.id, slot: 'blind', head: H }, author.id)).rejects.toMatchObject(error('REVIEW_SEAT_ALREADY_ASSIGNED'));
    expect((await events(t.id)).filter(e => e.type === 'review.seat.assigned')).toHaveLength(1);
  });
  it('two concurrent first assignments cannot both become current for a slot', async () => {
    await schedule(['local']); await freeze();
    const tasks = await Promise.all(['one', 'two'].map(title => M.createAgentTask!({}, { input: { parentTaskId: build.id, title, source: 's', assignee: { user: reviewer.id } } }, ctx(author.id))));
    const results = await Promise.allSettled(tasks.map(t => command('assignReviewSeat', { taskRef: t.id, slot: 'local', head: H }, author.id)));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject(error('REVIEW_SEAT_SUPERSEDES_REQUIRED'));
    expect(await db.agentTeamEvent.count({ where: { appId: app.id, type: 'review.seat.assigned' } })).toBe(1);
  });
  it('holds the build row FOR UPDATE through the mirror check/write', async () => {
    await schedule(['local']); await freeze();
    const original = taskProperties.checkAgainstTeamSchema;
    let probed = false;
    const spy = vi.spyOn(taskProperties, 'checkAgainstTeamSchema').mockImplementation(async (...args) => {
      await original(...args);
      probed = true;
      await expect(db.$transaction(tx => tx.$queryRaw`SELECT id FROM agent_tasks WHERE id = ${build.id} FOR SHARE NOWAIT`)).rejects.toMatchObject({ code: 'P2010', meta: { code: '55P03' } });
    });
    try { await seat('local'); expect(probed).toBe(true); } finally { spy.mockRestore(); }
  });
  it.each(['APPROVE', 'CHANGES_REQUESTED', 'PASS', 'FAIL', 'CARRY', 'REFUSED'])('records %s once, mirrors it and leaves the seat STARTED', async value => {
    await schedule(); await freeze(); const t = await seat('local'); await verdict(t, value);
    expect((await stored(t.id)).status).toBe('started');
    expect((await stored(t.id)).properties).toMatchObject({ 'review.slot': 'local', 'review.head': H, 'review.verdict': value });
    expect((await events(t.id)).filter(e => e.type === 'review.verdict')).toHaveLength(1);
  });
  it('verdict requires assignment, matching head, STARTED and the assignee', async () => {
    await schedule(); await freeze(); const t = await seat('local');
    await expect(command('recordReviewVerdict', { taskRef: t.id, head: H, verdict: 'APPROVE' }, reviewer.id)).rejects.toMatchObject(error('TASK_INVALID_TRANSITION'));
    await M.startAgentTask!({}, { taskId: t.id }, ctx(reviewer.id));
    await expect(command('recordReviewVerdict', { taskRef: t.id, head: H2, verdict: 'APPROVE' }, reviewer.id)).rejects.toMatchObject(error('REVIEW_HEAD_MISMATCH'));
    await expect(command('recordReviewVerdict', { taskRef: t.id, head: H, verdict: 'APPROVE' }, other.id)).rejects.toMatchObject(error('TASK_NOT_ASSIGNEE'));
    await expect(command('recordReviewVerdict', { taskRef: build.id, head: H, verdict: 'APPROVE' }, author.id)).rejects.toMatchObject(error('TASK_INVALID_TRANSITION'));
    expect((await events(t.id)).filter(e => e.type === 'review.verdict')).toHaveLength(0);
  });
  it('a started task without an assignment cannot record a verdict', async () => {
    await M.startAgentTask!({}, { taskId: build.id }, ctx(author.id));
    await expect(command('recordReviewVerdict', { taskRef: build.id, head: H, verdict: 'APPROVE' }, author.id)).rejects.toMatchObject(error('REVIEW_SEAT_UNASSIGNED'));
  });
  it('untyped resolver callers cannot invent a verdict enum value', async () => {
    await schedule(); await freeze(); const t = await seat('local'); await M.startAgentTask!({}, { taskId: t.id }, ctx(reviewer.id));
    await expect(command('recordReviewVerdict', { taskRef: t.id, head: H, verdict: 'APPROVED' }, reviewer.id)).rejects.toMatchObject(error('BAD_USER_INPUT'));
    expect((await events(t.id)).filter(e => e.type === 'review.verdict')).toHaveLength(0);
  });
});

describe('readiness uses only event facts', () => {
  it('counts current finished APPROVE/PASS/CARRY seats and records readiness', async () => {
    await readySeats(); expect((await readiness()).ready).toBe(true);
    const r = await command('recordReadyCall', { taskRef: build.id, head: H }, author.id);
    expect(r.action.code).toBe('pr.ready'); expect((await stored()).properties).toMatchObject({ 'pr.ready': true });
    expect((await events()).filter(e => e.type === 'pr.ready')).toHaveLength(1);
  });
  it('does not count PENDING, CANCELLED or unfinished verdict seats', async () => {
    await schedule(['local']); await freeze(); const t = await seat('local');
    expect((await readiness()).ready).toBe(false);
    await verdict(t); expect((await readiness()).ready).toBe(false);
    await M.cancelAgentTask!({}, { taskId: t.id }, ctx(author.id)); expect((await readiness()).ready).toBe(false);
    const before = await events(); const props = (await stored()).properties;
    await expect(command('recordReadyCall', { taskRef: build.id, head: H }, author.id)).rejects.toMatchObject(error('PR_NOT_READY'));
    expect(await events()).toEqual(before); expect((await stored()).properties).toEqual(props);
  });
  it('a new freeze invalidates old verdicts and names their old heads', async () => {
    await readySeats(); await freeze(H2); const r = await readiness(H2);
    expect(r.ready).toBe(false); expect(r.slots.every((s: any) => s.head === H && !s.counts)).toBe(true);
    await expect(readiness(H)).rejects.toMatchObject(error('PR_HEAD_NOT_FROZEN'));
  });
  it('does not count a stored stale-head verdict even with a current-head assignment', async () => {
    await schedule(['local']); await freeze(); const t = await seat('local'); await verdict(t); await finish(t);
    // Synthetic stored history isolates the READ-side head check; the typed writer refuses this event.
    await db.agentTeamEvent.create({ data: { appId: app.id, taskId: t.id, type: 'review.verdict', actorUserId: reviewer.id, payload: { slot: 'local', head: H2, verdict: 'APPROVE' } } });
    expect((await readiness()).slots[0]).toMatchObject({ head: H2, counts: false });
  });
  it('a superseded seat never wins even with synthetic later assignment history', async () => {
    await schedule(['local']); await freeze(); const old = await seat('local');
    const now = await seat('local', H, reviewer.id, old.id); await verdict(now); await finish(now);
    // Legacy/invalid fixture, not a typed command: once-assigned prevents this through the API.
    await db.agentTeamEvent.create({ data: { appId: app.id, taskId: old.id, type: 'review.seat.assigned', actorUserId: author.id, payload: { slot: 'local', head: H, supersedes: null } } });
    expect((await readiness()).slots[0]).toMatchObject({ currentTaskId: now.id, counts: true });
  });
  it('the implementer cannot count as their own reviewer', async () => {
    await schedule(['local']); await freeze(); const t = await seat('local', H, author.id); await verdict(t, 'APPROVE', H, author.id); await finish(t, author.id);
    expect((await readiness()).slots[0].counts).toBe(false);
  });
  it('opaque property edits still succeed but cannot forge a schedule or freeze', async () => {
    await M.updateAgentTask!({}, { taskId: build.id, input: { properties: { 'review.schedule': ['local'], 'pr.head': H, 'pr.ready': true } } }, ctx(author.id));
    await expect(readiness()).rejects.toMatchObject(error('PR_HEAD_NOT_FROZEN'));
    await freeze(); await expect(readiness()).rejects.toMatchObject(error('REVIEW_SCHEDULE_MISSING'));
  });
  it('opaque edits cannot forge a verdict, assigned slot or head, or lower the schedule', async () => {
    await schedule(); await freeze(); const t = await seat('local');
    await M.updateAgentTask!({}, { taskId: t.id, input: { properties: { 'review.slot': 'security', 'review.head': H, 'review.verdict': 'APPROVE' } } }, ctx(reviewer.id));
    await M.updateAgentTask!({}, { taskId: build.id, input: { properties: { 'review.schedule': [] } } }, ctx(author.id));
    const r = await readiness(); expect(r.ready).toBe(false); expect(r.slots).toHaveLength(3);
    expect(r.slots[0]).toMatchObject({ slot: 'local', currentTaskId: t.id, verdict: null, counts: false });
  });
  it('readiness has the existing participant/key gate and conceals outsiders', async () => {
    await readySeats(); expect(await readiness(H, other.id)).toMatchObject({ ready: true });
    expect(await readiness(H, outsider.id)).toBeNull();
    const key = await db.appKey.create({ data: { appId: app.id, keyHash: generateId(), keyPreview: 'test' } });
    expect(await Q.pullRequestReadiness!({}, { taskRef: build.id, head: H }, { db, appId: app.id, appKeyId: key.id, roles: [] })).toMatchObject({ ready: true });
  });
  it('only the build assignee records a ready call', async () => {
    await readySeats();
    await expect(command('recordReadyCall', { taskRef: build.id, head: H }, owner.id)).rejects.toMatchObject(error('TASK_NOT_ASSIGNEE'));
    expect((await events()).filter(e => e.type === 'pr.ready')).toHaveLength(0);
  });
  it('the newest verdict wins while the seat stays started', async () => {
    await schedule(['local']); await freeze(); const t = await seat('local'); await verdict(t, 'FAIL');
    await command('recordReviewVerdict', { taskRef: t.id, head: H, verdict: 'APPROVE' }, reviewer.id);
    expect((await stored(t.id)).status).toBe('started'); await finish(t);
    expect((await readiness()).ready).toBe(true);
  });
  it('typed writes re-gate on the transaction client and roll back after uncommitted participation removal', async () => {
    const raced = new Proxy(db, { get(target, key) {
      if (key !== '$transaction') return Reflect.get(target, key);
      return (fn: (tx: any) => Promise<unknown>, options: any) => db.$transaction(async tx => {
        await tx.appMember.delete({ where: { appId_userId: { appId: app.id, userId: owner.id } } });
        expect(await tx.appMember.count({ where: { appId: app.id, userId: owner.id } })).toBe(0);
        expect(await db.appMember.count({ where: { appId: app.id, userId: owner.id } })).toBe(1);
        return fn(tx);
      }, options);
    } });
    await expect(M.setReviewSchedule!({}, { taskRef: build.id, slots: ['local'] }, { ...ctx(), db: raced })).rejects.toMatchObject(error('TASK_NOT_FOUND'));
    expect(await events()).toHaveLength(0); expect((await stored()).properties).toBeNull();
    expect(await db.appMember.count({ where: { appId: app.id, userId: owner.id } })).toBe(1);
  });
  it('an App key never writes protocol facts', async () => {
    const key = await db.appKey.create({ data: { appId: app.id, keyHash: generateId(), keyPreview: 'test' } });
    const c = { db, appId: app.id, appKeyId: key.id, roles: [] };
    for (const name of ['setReviewSchedule', 'freezePullRequestHead', 'assignReviewSeat', 'recordReviewVerdict', 'recordReadyCall']) {
      await expect(M[name]!({}, { taskRef: build.id, slots: ['local'], slot: 'local', verdict: 'PASS', head: H }, c)).rejects.toMatchObject(error('TASK_NOT_FOUND'));
    }
    expect(await events()).toHaveLength(0);
  });
  it('the GraphQL commands expose task + register action and the event-only readiness answer', async () => {
    const api = new ApolloServer({ typeDefs, resolvers: { ...resolvers, Query: settledTeamEventQueries(resolvers.Query, db) } });
    try {
      const call = async (query: string, userId: string) => {
        const r = await api.executeOperation({ query, variables: { id: build.id } }, { contextValue: ctx(userId) });
        expect(r.body.kind).toBe('single'); return (r.body as any).singleResult;
      };
      const a = await call('mutation($id:ID!){setReviewSchedule(taskRef:$id,slots:["local"]){task{id} action{code state}}}', owner.id);
      expect(a.errors).toBeUndefined(); expect(a.data.setReviewSchedule.action.code).toBe('review.scheduled');
      const b = await call(`mutation($id:ID!){freezePullRequestHead(taskRef:$id,head:"${H}"){task{id} action{code state}}}`, author.id);
      expect(b.errors).toBeUndefined(); expect(b.data.freezePullRequestHead.action.state).toBe('WITHHELD');
      const r = await call(`query($id:ID!){pullRequestReadiness(taskRef:$id,head:"${H}"){ready slots{slot currentTaskId state verdict head counts}}}`, other.id);
      expect(r.errors).toBeUndefined(); expect(r.data.pullRequestReadiness).toMatchObject({ ready: false, slots: [{ slot: 'local', state: 'MISSING', counts: false }] });
    } finally { await api.stop(); }
  });
  it('a person gets code-only WITHHELD without any register lookup even when Team has an entry', async () => {
    const memory = await db.memory.create({ data: { name: 'Team system', urn: `${app.urn}:system`, class: 'system', ownerUserId: author.id } });
    const agent = await db.agent.create({ data: { name: 'Team', urn: `${app.urn}:agent`, systemMemoryId: memory.id, ownerUserId: author.id } });
    await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
    for (const loc of ['roles:author', 'tasks:review']) await db.node.create({ data: { id: generateId(), memoryId: memory.id, loc, name: loc, isRunnable: loc.startsWith('tasks:') } });
    await db.node.create({ data: { id: generateId(), memoryId: memory.id, loc: 'register:pr.frozen', name: 'Freeze', data: { registerEntry: { code: 'pr.frozen', taskLoc: 'tasks:review' } } } });
    const spy = vi.spyOn(RegisterLookup.prototype, 'teamMemory');
    try {
      const result = await freeze();
      expect(result.action).toEqual({ code: 'pr.frozen', state: 'WITHHELD' });
      expect(spy).not.toHaveBeenCalled();
      expect((await events())[0].type).toBe('pr.frozen');
    } finally { spy.mockRestore(); }
  });
  it('maps an Agent caller through its own chain, never the Team task at the same loc', async () => {
    const memory = await db.memory.create({ data: { name: 'Team system', urn: `${app.urn}:team-system`, class: 'system', ownerUserId: author.id } });
    const team = await db.agent.create({ data: { name: 'Team', urn: `${app.urn}:team-agent`, systemMemoryId: memory.id, ownerUserId: author.id } });
    await db.appAgent.create({ data: { appId: app.id, agentId: team.id } });
    for (const loc of ['roles:author', 'tasks:review']) await db.node.create({ data: { id: generateId(), memoryId: memory.id, loc, name: loc, isRunnable: loc.startsWith('tasks:') } });
    await db.node.create({ data: { id: generateId(), memoryId: memory.id, loc: 'register:pr.frozen', name: 'Freeze', data: { registerEntry: { code: 'pr.frozen', taskLoc: 'tasks:review' } } } });
    const roleMemory = await db.memory.create({ data: { name: 'Caller system', urn: `${app.urn}:caller-system`, class: 'system', ownerUserId: author.id } });
    const role = await db.agent.create({ data: { name: 'Caller', urn: `${app.urn}:caller-agent`, systemMemoryId: roleMemory.id, ownerUserId: author.id } });
    await db.node.create({ data: { id: generateId(), memoryId: roleMemory.id, loc: 'tasks:review', name: 'Caller task', isRunnable: true } });
    const worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: role.id, name: 'Author', slug: 'author', heldByUserId: author.id } });
    await db.agentTask.update({ where: { id: build.id }, data: { assigneeUserId: null, assigneeWorkerId: worker.id } });
    const result = await runAsActor({ workerId: worker.id, agentId: role.id }, () => freeze());
    expect(result.action).toEqual({ code: 'pr.frozen', state: 'MAPPED', taskLoc: 'tasks:review', taskUrn: `hrn:node:${roleMemory.urn}:tasks:review` });
    await db.node.deleteMany({ where: { memoryId: memory.id, loc: 'register:pr.frozen' } });
    expect((await runAsActor({ workerId: worker.id, agentId: role.id }, () => freeze())).action).toEqual({ code: 'pr.frozen', state: 'UNMAPPED' });
  });
  it('a failed register lookup never undoes or refuses a committed command', async () => {
    const memory = await db.memory.create({ data: { name: 'Caller', urn: `${app.urn}:caller`, class: 'system', ownerUserId: author.id } });
    const agent = await db.agent.create({ data: { name: 'Caller', urn: `${app.urn}:caller-agent`, systemMemoryId: memory.id, ownerUserId: author.id } });
    const spy = vi.spyOn(RegisterLookup.prototype, 'teamMemory').mockRejectedValue(new Error('synthetic lookup failure'));
    try {
      expect((await runAsActor({ workerId: null, agentId: agent.id }, () => freeze())).action).toEqual({ code: 'pr.frozen', state: 'WITHHELD' }); // #3470, ruling 0164: a fault is code-only WITHHELD
      expect(spy).toHaveBeenCalled();
      expect((await events())[0].type).toBe('pr.frozen');
      expect((await stored()).properties).toMatchObject({ 'pr.head': H });
    } finally { spy.mockRestore(); }
  });
});


describe('protocol admission order under a delayed transaction', () => {
  it('the freeze that obtains the graph last is newest even if its transaction started first', async () => {
    await schedule(['local']);
    let entered!: () => void, release!: () => void;
    const paused = new Promise<void>(r => { entered = r; });
    const resume = new Promise<void>(r => { release = r; });
    const original = taskGraphLocks.lockTaskGraph;
    const spy = vi.spyOn(taskGraphLocks, 'lockTaskGraph').mockImplementationOnce(async (...args) => {
      // The real transaction has begun and taken shared authority anchors. Hold it BEFORE
      // the graph lock, so a later-starting command can acquire the graph and commit first.
      entered(); await resume; return original(...args);
    });
    const laterCommit = freeze(H);
    try {
      await paused;
      await freeze(H2);
      release(); await laterCommit;
      expect(spy).toHaveBeenCalledTimes(2);
      expect((await stored()).properties).toMatchObject({ 'pr.head': H });
      // This is the event-fed answer, not the correct but non-authoritative mirror above.
      expect((await readiness(H)).head).toBe(H);
    } finally { release(); await laterCommit.catch(() => undefined); spy.mockRestore(); }
  });
});


describe('protocol event feed compatibility', () => {
  it('round-trips protocol event types and payloads through the public GraphQL history query', async () => {
    const seats=await readySeats();
    await command('recordReadyCall', { taskRef: build.id, head: H }, author.id);
    const api = new ApolloServer({ typeDefs, resolvers: { ...resolvers, Query: settledTeamEventQueries(resolvers.Query, db) } });
    try {
      const r = await api.executeOperation({
        query: 'query($app: ID!, $task: ID!) { agentTeamEvents(appRef:$app,taskId:$task) { type payload } }',
        variables: { app: app.id, task: build.id },
      }, { contextValue: ctx() });
      const body = (r.body as any).singleResult;
      expect(body.errors).toBeUndefined();
      expect(body.data.agentTeamEvents).toEqual(expect.arrayContaining([
        { type: 'review.scheduled', payload: { slots: ['local', 'blind', 'security'] } },
        { type: 'pr.frozen', payload: { head: H, pullRequest: 'https://github.com/example/project/pull/1' } },
        { type: 'pr.ready', payload: { head: H } },
      ]));
      const child=await api.executeOperation({query:'query($app: ID!, $task: ID!) { agentTeamEvents(appRef:$app,taskId:$task) { type payload } }',variables:{app:app.id,task:seats[0]!.id}}, {contextValue:ctx()});
      const answer=(child.body as any).singleResult;expect(answer.errors).toBeUndefined();
      expect(answer.data.agentTeamEvents).toEqual(expect.arrayContaining([
        {type:'review.seat.assigned',payload:{slot:'local',head:H,supersedes:null}},
        {type:'review.verdict',payload:{slot:'local',head:H,verdict:'APPROVE',node:'hrn:node:example.test:reviews:one',receipt:'https://example.test/receipt'}},
      ]));
    } finally { await api.stop(); }
  });
});


describe('gate amendment: frozen actor and negative schedule', () => {
  it('the newest frozen actor cannot launder a self verdict by reassigning the build', async () => {
    await schedule(['local']); await freeze();
    const t = await seat('local', H, author.id);
    await verdict(t, 'APPROVE', H, author.id); await finish(t, author.id);
    expect((await readiness()).ready).toBe(false);
    await M.reassignAgentTask!({}, { taskId: build.id, assignee: { user: other.id } }, ctx());
    expect((await readiness()).slots[0].counts).toBe(false);
    expect((await readiness()).ready).toBe(false);
  });
  it.each(['CHANGES_REQUESTED', 'FAIL', 'REFUSED'])('schedule cannot drop a slot holding %s at the frozen head', async v => {
    await schedule(['local', 'security']); await freeze();
    const t = await seat('security'); await verdict(t, v);
    const before = await events(); const properties = (await stored()).properties;
    await expect(schedule(['local'])).rejects.toMatchObject(error('REVIEW_SEAT_NOT_SUPERSEDABLE'));
    expect(await events()).toEqual(before); expect((await stored()).properties).toEqual(properties);
    // Adding a slot, or dropping the clean slot, does not erase the negative one.
    await schedule(['local', 'security', 'qa']);
    await schedule(['security', 'qa']);
    expect((await readiness()).slots.map((x: any) => x.slot)).toEqual(['security', 'qa']);
  });
  it('schedule may drop a slot whose negative verdict belongs to an older frozen head', async () => {
    await schedule(['local', 'security']); await freeze();
    const t = await seat('security'); await verdict(t, 'FAIL');
    await freeze(H2); await schedule(['local']);
    expect((await readiness(H2)).slots.map((x: any) => x.slot)).toEqual(['local']);
  });
});


describe('LOCAL delta: finished negative verdicts and seat provenance', () => {
  it.each(['CHANGES_REQUESTED', 'FAIL', 'REFUSED'])('a FINISHED %s seat never counts and cannot record ready', async v => {
    await schedule(['local']); await freeze();
    const t = await seat('local'); await verdict(t, v); await finish(t);
    expect((await readiness()).slots[0]).toMatchObject({ state: 'FINISHED', verdict: v, counts: false });
    expect((await readiness()).ready).toBe(false);
    await expect(command('recordReadyCall', { taskRef: build.id, head: H }, author.id)).rejects.toMatchObject(error('PR_NOT_READY'));
    expect((await events()).filter(e => e.type === 'pr.ready')).toHaveLength(0);
  });
  it('only the build assignee can create its seat and cannot give it another owner', async () => {
    const input = { parentTaskId: build.id, title: 'Seat', source: 'synthetic', assignee: { user: reviewer.id } };
    await expect(M.createAgentTask!({}, { input }, ctx(other.id))).rejects.toMatchObject(error('TASK_NOT_ASSIGNEE'));
    await expect(M.createAgentTask!({}, { input: { ...input, owner: { user: other.id } } }, ctx(author.id)))
      .rejects.toMatchObject(error('TASK_CHILD_OWNER_MISMATCH'));
    const t = await M.createAgentTask!({}, { input }, ctx(author.id));
    expect((await stored(t.id)).ownerUserId).toBe(author.id);
    const api = new ApolloServer({ typeDefs, resolvers: { ...resolvers, Query: settledTeamEventQueries(resolvers.Query, db) } });
    try {
      const r = await api.executeOperation({ query: '{ __type(name:"UpdateAgentTaskInput") { inputFields { name } } }' });
      expect((r.body as any).singleResult.data.__type.inputFields.map((f:any) => f.name)).not.toContain('owner');
    } finally { await api.stop(); }
  });
});


describe('SECURITY delta: negative history survives bounce and reassignment', () => {
  it.each(['CHANGES_REQUESTED', 'FAIL', 'REFUSED'])('a head bounce cannot erase an older %s seat even after replacement and reschedule', async v => {
    await schedule(['local', 'security']); await freeze();
    const old = await seat('security'); await verdict(old, v);
    await freeze(H2); await seat('security', H2, other.id, old.id);
    await schedule(['local']);
    const before = await events(); const properties = (await stored()).properties;
    await expect(freeze(H)).rejects.toMatchObject(error('REVIEW_SEAT_NOT_SUPERSEDABLE'));
    expect(await events()).toEqual(before); expect((await stored()).properties).toEqual(properties);
    expect((await readiness(H2)).head).toBe(H2);
  });
  it.each(['CHANGES_REQUESTED', 'FAIL', 'REFUSED'])('another reviewer cannot replace %s on the same seat and head, but its author may re-rate', async v => {
    await schedule(['local']); await freeze(); const t = await seat('local'); await verdict(t, v);
    await M.reassignAgentTask!({}, { taskId: t.id, assignee: { user: other.id } }, ctx(author.id));
    const before = await events(t.id); const properties = (await stored(t.id)).properties;
    await expect(command('recordReviewVerdict', { taskRef:t.id, head:H, verdict:'APPROVE' }, other.id))
      .rejects.toMatchObject(error('REVIEW_SEAT_NOT_SUPERSEDABLE'));
    expect(await events(t.id)).toEqual(before); expect((await stored(t.id)).properties).toEqual(properties);
    await M.reassignAgentTask!({}, { taskId: t.id, assignee: { user: reviewer.id } }, ctx(author.id));
    await command('recordReviewVerdict', { taskRef:t.id, head:H, verdict:'APPROVE' }, reviewer.id);
    await finish(t); expect((await readiness()).ready).toBe(true);
    await freeze(); // newest verdict per child wins, not any historical negative
    expect((await readiness()).ready).toBe(true);
  });
});

describe('SECURITY delta: ended rows and mirrored property history', () => {
  async function end(id:string, who:string, ownerId:string, status:string) {
    if (status === 'cancelled') await M.cancelAgentTask!({}, { taskId:id }, ctx(ownerId));
    else { await M.startAgentTask!({}, { taskId:id }, ctx(who)); await M.finishAgentTask!({}, { taskId:id, result:{outcome:'done'} }, ctx(who)); }
  }
  it.each(['cancelled','finished'])('schedule and freeze refuse a %s build without an event or property change', async status => {
    await end(build.id, author.id, owner.id, status);
    const before=await events(), properties=(await stored()).properties;
    await expect(schedule()).rejects.toMatchObject(error('TASK_ENDED'));
    await expect(freeze()).rejects.toMatchObject(error('TASK_ENDED'));
    expect(await events()).toEqual(before); expect((await stored()).properties).toEqual(properties);
  });
  it.each(['cancelled','finished'])('ready call refuses a %s build even when every seat counts', async status => {
    await readySeats(); await end(build.id, author.id, owner.id, status);
    const before=await events(), properties=(await stored()).properties;
    await expect(command('recordReadyCall', {taskRef:build.id,head:H}, author.id)).rejects.toMatchObject(error('TASK_ENDED'));
    expect(await events()).toEqual(before); expect((await stored()).properties).toEqual(properties);
  });
  it.each(['cancelled','finished'])('assignment refuses a %s seat', async status => {
    await schedule(['local']); await freeze();
    const t=await M.createAgentTask!({}, {input:{parentTaskId:build.id,title:'Seat',source:'synthetic',assignee:{user:reviewer.id}}},ctx(author.id));
    await end(t.id,reviewer.id,author.id,status);
    const before=await events(t.id),properties=(await stored(t.id)).properties;
    await expect(command('assignReviewSeat',{taskRef:t.id,slot:'local',head:H},author.id)).rejects.toMatchObject(error('TASK_ENDED'));
    expect(await events(t.id)).toEqual(before);expect((await stored(t.id)).properties).toEqual(properties);
  });
  it.each(['cancelled','finished'])('verdict uses the ended-task refusal on a %s seat', async status => {
    await schedule(['local']);await freeze();const t=await seat('local');await end(t.id,reviewer.id,author.id,status);
    const before=await events(t.id),properties=(await stored(t.id)).properties;
    await expect(command('recordReviewVerdict',{taskRef:t.id,head:H,verdict:'APPROVE'},reviewer.id)).rejects.toMatchObject(error('TASK_ENDED'));
    expect(await events(t.id)).toEqual(before);expect((await stored(t.id)).properties).toEqual(properties);
  });
  it('a real mirror change has its ordinary content-free fingerprint event; identical mirrors do not add one', async () => {
    await freeze();
    const history=await db.agentTeamEvent.findMany({where:{taskId:build.id,type:'task.properties-changed'}});
    expect(history).toHaveLength(1);
    expect(history[0].payload).toEqual({from:null,to:taskProperties.propertiesFingerprint((await stored()).properties)});
    await freeze();
    expect(await db.agentTeamEvent.count({where:{taskId:build.id,type:'task.properties-changed'}})).toBe(1);
  });
  it('a root task cannot be a review seat',async()=>{
    const root = await M.createAgentTask!({}, { input:{ appRef:app.id, title:'Root project', project:true, source:'synthetic', assignee:{user:author.id} } }, ctx());
    expect((await stored(root.id)).parentTaskId).toBeNull();
    await expect(command('assignReviewSeat',{taskRef:root.id,slot:'local',head:H},owner.id)).rejects.toMatchObject(error('REVIEW_SEAT_UNASSIGNED'));
  });
});


describe('Worker actor floor and register disclosure', () => {
  let teamAgent:any, roleAgent:any, roleMemory:any, worker:any;
  const bound = <T>(fn:()=>Promise<T>) => runAsActor({workerId:worker.id,agentId:roleAgent.id},fn);
  beforeEach(async()=>{
    const teamMemory=await db.memory.create({data:{name:'Team system',urn:`${app.urn}:team-system`,class:'system',ownerUserId:author.id}});
    teamAgent=await db.agent.create({data:{name:'Team',urn:`${app.urn}:team-agent`,systemMemoryId:teamMemory.id,ownerUserId:author.id}});
    await db.appAgent.create({data:{appId:app.id,agentId:teamAgent.id}});
    for(const loc of ['roles:author','tasks:review']) await db.node.create({data:{id:generateId(),memoryId:teamMemory.id,loc,name:loc,isRunnable:loc.startsWith('tasks:')}});
    await db.node.create({data:{id:generateId(),memoryId:teamMemory.id,loc:'register:pr.frozen',name:'Freeze',data:{registerEntry:{code:'pr.frozen',taskLoc:'tasks:review'}}}});
    roleMemory=await db.memory.create({data:{name:'Caller system',urn:`${app.urn}:caller-system`,class:'system',ownerUserId:author.id}});
    roleAgent=await db.agent.create({data:{name:'Caller',urn:`${app.urn}:caller-agent`,systemMemoryId:roleMemory.id,ownerUserId:author.id}});
    await db.node.create({data:{id:generateId(),memoryId:roleMemory.id,loc:'tasks:review',name:'Caller task',isRunnable:true}});
    worker=await db.worker.create({data:{...WORKER_SIGNATURE_DEFAULTS,appId:app.id,agentId:roleAgent.id,name:'Author',slug:'author',heldByUserId:author.id}});
  });
  async function workerSeat() {
    const t=await M.createAgentTask!({}, {input:{parentTaskId:build.id,title:'Worker seat',source:'synthetic',assignee:{worker:worker.id}}},ctx(author.id));
    await command('assignReviewSeat',{taskRef:t.id,slot:'local',head:H},author.id);
    return t;
  }
  async function workerVerdict(t:any) {
    await bound(async()=>{
      await M.startAgentTask!({}, {taskId:t.id},ctx(author.id));
      await command('recordReviewVerdict',{taskRef:t.id,head:H,verdict:'APPROVE'},author.id);
      await M.finishAgentTask!({}, {taskId:t.id,result:{outcome:'approved'}},ctx(author.id));
    });
    const event=await db.agentTeamEvent.findFirstOrThrow({where:{taskId:t.id,type:'review.verdict'}});
    expect(event.actorWorkerId).toBe(worker.id);
  }
  it('excludes the current Worker assignee when a different person froze the head',async()=>{
    await schedule(['local']);await freeze();const t=await workerSeat();await workerVerdict(t);
    await M.reassignAgentTask!({}, {taskId:build.id,assignee:{worker:worker.id}},ctx());
    expect((await readiness()).slots[0].counts).toBe(false);
  });
  it('excludes the frozen Worker actor after the build is reassigned to a different person',async()=>{
    await schedule(['local']);
    await M.reassignAgentTask!({}, {taskId:build.id,assignee:{worker:worker.id}},ctx());
    let t:any;
    await bound(async()=>{await freeze();t=await workerSeat();});
    await workerVerdict(t);
    await M.reassignAgentTask!({}, {taskId:build.id,assignee:{user:other.id}},ctx());
    expect((await readiness()).slots[0].counts).toBe(false);
    await freeze(H,other.id);
    expect((await readiness()).slots[0].counts).toBe(false);
  });
  it('SECURITY final pins: an Agent caller without a single Team Agent is UNMAPPED',async()=>{
    await M.reassignAgentTask!({}, {taskId:build.id,assignee:{worker:worker.id}},ctx());
    expect((await bound(()=>freeze())).action.state).toBe('MAPPED');
    await db.appAgent.delete({where:{appId_agentId:{appId:app.id,agentId:teamAgent.id}}});
    expect((await bound(()=>freeze())).action).toEqual({code:'pr.frozen',state:'UNMAPPED'});
    await db.appAgent.create({data:{appId:app.id,agentId:teamAgent.id}});
    expect((await bound(()=>freeze())).action.state).toBe('MAPPED');
  });
  it.each(['team','agent'])('an inherited unreadable %s chain memory withholds even a nearer readable mapping (#3470, ruling 0163)',async side=>{
    await M.reassignAgentTask!({}, {taskId:build.id,assignee:{worker:worker.id}},ctx());
    expect((await bound(()=>freeze())).action.state).toBe('MAPPED');
    const baseMemory=await db.memory.create({data:{name:'Unreadable base',urn:`${app.urn}:hidden-base`,class:'system',ownerUserId:other.id}});
    const baseAgent=await db.agent.create({data:{name:'Hidden base',urn:`${app.urn}:hidden-agent`,systemMemoryId:baseMemory.id,ownerUserId:other.id}});
    await db.agent.update({where:{id:side==='team'?teamAgent.id:roleAgent.id},data:{extendsAgentId:baseAgent.id}});
    const r=await bound(()=>freeze());
    expect(r.action).toEqual({code:'pr.frozen',state:'WITHHELD'});
    expect((await events()).filter(e=>e.type==='pr.frozen')).toHaveLength(2);
  });
  it('an unreadable chain memory withholds the answer, with or without a readable nearer entry (#3470, ruling 0163)',async()=>{
    await M.reassignAgentTask!({}, {taskId:build.id,assignee:{worker:worker.id}},ctx());
    await db.node.deleteMany({where:{memoryId:teamAgent.systemMemoryId,loc:'register:pr.frozen'}});
    const farMemory=await db.memory.create({data:{name:'Readable far entry',urn:`${app.urn}:far-entry`,class:'system',ownerUserId:author.id}});
    const far=await db.agent.create({data:{name:'Far entry',urn:`${app.urn}:far-entry-agent`,systemMemoryId:farMemory.id,ownerUserId:author.id}});
    const hiddenMemory=await db.memory.create({data:{name:'Hidden entry',urn:`${app.urn}:hidden-entry`,class:'system',ownerUserId:other.id}});
    const hidden=await db.agent.create({data:{name:'Hidden entry',urn:`${app.urn}:hidden-entry-agent`,systemMemoryId:hiddenMemory.id,ownerUserId:other.id,extendsAgentId:far.id}});
    await db.agent.update({where:{id:teamAgent.id},data:{extendsAgentId:hidden.id}});
    for(const memoryId of [hiddenMemory.id,farMemory.id]) await db.node.create({data:{id:generateId(),memoryId,loc:'register:pr.frozen',name:'Entry',data:{registerEntry:{code:'pr.frozen',taskLoc:'tasks:review'}}}});
    expect((await bound(()=>freeze())).action).toEqual({code:'pr.frozen',state:'WITHHELD'});
    // A readable nearer entry does not help: the caller must read every system memory on the chain.
    await db.node.create({data:{id:generateId(),memoryId:teamAgent.systemMemoryId,loc:'register:pr.frozen',name:'Own entry',data:{registerEntry:{code:'pr.frozen',taskLoc:'tasks:review'}}}});
    expect((await bound(()=>freeze())).action).toEqual({code:'pr.frozen',state:'WITHHELD'});
  });
  it.each(['unreadable','missing'])('a readable entry with a %s nearest task: unreadable chain is WITHHELD, missing task is UNRESOLVED without a task URN (#3470)',async mode=>{
    await M.reassignAgentTask!({}, {taskId:build.id,assignee:{worker:worker.id}},ctx());
    await db.node.deleteMany({where:{memoryId:roleMemory.id,loc:'tasks:review'}});
    if(mode==='unreadable'){
      const farMemory=await db.memory.create({data:{name:'Readable far task',urn:`${app.urn}:far-task`,class:'system',ownerUserId:author.id}});
      const far=await db.agent.create({data:{name:'Far task',urn:`${app.urn}:far-task-agent`,systemMemoryId:farMemory.id,ownerUserId:author.id}});
      const hiddenMemory=await db.memory.create({data:{name:'Hidden task',urn:`${app.urn}:hidden-task`,class:'system',ownerUserId:other.id}});
      const hidden=await db.agent.create({data:{name:'Hidden task',urn:`${app.urn}:hidden-task-agent`,systemMemoryId:hiddenMemory.id,ownerUserId:other.id,extendsAgentId:far.id}});
      await db.agent.update({where:{id:roleAgent.id},data:{extendsAgentId:hidden.id}});
      for(const memoryId of [hiddenMemory.id,farMemory.id]) await db.node.create({data:{id:generateId(),memoryId,loc:'tasks:review',name:'Task',isRunnable:true}});
    }
    const result=(await bound(()=>freeze())).action;
    expect(result.state).toBe(mode==='unreadable'?'WITHHELD':'UNRESOLVED');expect(result.code).toBe('pr.frozen');expect(result.taskUrn).toBeUndefined();
    expect(result.taskLoc).toBe(mode==='unreadable'?undefined:'tasks:review');
    await db.node.create({data:{id:generateId(),memoryId:roleMemory.id,loc:'tasks:review',name:'Own task',isRunnable:true}});
    expect((await bound(()=>freeze())).action).toEqual(mode==='unreadable'?{code:'pr.frozen',state:'WITHHELD'}:{code:'pr.frozen',state:'MAPPED',taskLoc:'tasks:review',taskUrn:`hrn:node:${roleMemory.urn}:tasks:review`});
  });
  it.each(['team','agent'])('root-memory readability probe: unreadable %s root does not disclose a task URN',async kind=>{
    await M.reassignAgentTask!({}, {taskId:build.id,assignee:{worker:worker.id}},ctx());
    const rootAgent=kind==='team'?teamAgent:roleAgent;
    const rootId=kind==='team'?teamAgent.systemMemoryId:roleMemory.id;
    await db.agent.update({where:{id:rootAgent.id},data:{ownerUserId:outsider.id}});
    await db.memory.update({where:{id:rootId},data:{ownerUserId:outsider.id}});
    await bound(async()=>{
      expect(await canReadMemory(db,ctx(author.id),rootId)).toBe(false);
      const result=await freeze();
      expect(result.action).toEqual({code:'pr.frozen',state:'WITHHELD'});
      expect(result.action.taskUrn).toBeUndefined();
    });
    await db.agent.update({where:{id:rootAgent.id},data:{ownerUserId:author.id}});
    await db.memory.update({where:{id:rootId},data:{ownerUserId:author.id}});
    expect((await bound(()=>freeze())).action).toEqual({code:'pr.frozen',state:'MAPPED',taskLoc:'tasks:review',taskUrn:`hrn:node:${roleMemory.urn}:tasks:review`});
  });
  it('does not resolve the task of an Agent retired after the command committed',async()=>{
    await M.reassignAgentTask!({}, {taskId:build.id,assignee:{worker:worker.id}},ctx());
    const original=RegisterLookup.prototype.entry;
    let retired=false;
    const spy=vi.spyOn(RegisterLookup.prototype,'entry').mockImplementation(async function(this:RegisterLookup,code){
      const entry=await original.call(this,code);
      // This is a second DB connection, after protocol commit; the bounded reader's next
      // statement must observe retirement rather than disclose the old role task URN.
      await db.agent.update({where:{id:roleAgent.id},data:{deletedAt:new Date()}});retired=true;
      return entry;
    });
    try {
      const r=await bound(()=>freeze());expect(retired).toBe(true);
      expect(r.action).toEqual({code:'pr.frozen',state:'UNRESOLVED',taskLoc:'tasks:review'});
      expect((await events()).filter(e=>e.type==='pr.frozen')).toHaveLength(1);
    } finally {spy.mockRestore();}
  });
});


describe('normalization and first-schedule controls', () => {
  it('the first schedule may be written after a head is frozen',async()=>{
    await freeze();await schedule(['local']);expect((await readiness()).slots.map((x:any)=>x.slot)).toEqual(['local']);
  });
  it('uppercase SHA input is normalized to the same frozen head',async()=>{
    await schedule(['local']);await freeze('A'.repeat(40));expect((await stored()).properties).toMatchObject({'pr.head':H});
    expect((await readiness(H)).head).toBe(H);
  });
  it.each(['node','receipt'])('a control character in %s is refused before an event or mirror change',async field=>{
    await schedule(['local']);await freeze();const t=await seat('local');await M.startAgentTask!({}, {taskId:t.id},ctx(reviewer.id));
    const before=await events(t.id), properties=(await stored(t.id)).properties;
    await expect(command('recordReviewVerdict',{taskRef:t.id,head:H,verdict:'APPROVE',[field]:'one'+String.fromCharCode(10)+'two'},reviewer.id))
      .rejects.toMatchObject(error('BAD_USER_INPUT'));
    expect(await events(t.id)).toEqual(before);expect((await stored(t.id)).properties).toEqual(properties);
  });
});


describe('controlled same-ms writer clock evidence (harness only)', () => {
  it('documents refusal of the later accepted head under a harness-forced clock tie and descending UUIDv7 suffixes', async () => {
    await schedule(['local']);
    const at = new Date();
    const prefix = at.getTime().toString(16).padStart(12,'0');
    const ids = [prefix+'7fff'+'b'+'f'.repeat(15), prefix+'7000'+'8'+'0'.repeat(15)];
    let creates = 0;
    // Only clock/id providers are controlled. Real command authority, graph/row locks,
    // event serialization, append-only table and readiness query are untouched.
    const clockDb = db.$extends({query:{agentTeamEvent:{create({args,query}) {
      if (args.data.type === 'pr.frozen') { args.data.createdAt = at; args.data.id = ids[creates++]; }
      return query(args);
    }}}});
    for (const head of [H,H2]) await M.freezePullRequestHead!({}, {taskRef:build.id,head}, {...ctx(author.id),db:clockDb});
    expect(creates).toBe(2);
    expect((await stored()).properties).toMatchObject({'pr.head':H2});
    const written = await db.agentTeamEvent.findMany({where:{taskId:build.id,type:'pr.frozen'}});
    expect(written).toHaveLength(2);
    expect(written.every(e=>e.createdAt.getTime()===at.getTime())).toBe(true);
    expect(written.map(e=>e.id).sort()).toEqual([...ids].reverse());
    // Documented limit (Xanthos #76647): these are harness-controlled writer metadata,
    // not a naturally observed interleave. The mirror holds H2 but the stable event sort
    // selects H, so H2 refuses. No claim about other tied verdict sequences follows.
    await expect(readiness(H2)).rejects.toMatchObject(error('PR_HEAD_NOT_FROZEN'));
    expect((await readiness(H)).head).toBe(H);
  });
});

describe('BLIND delta new refreeze floor probe',()=>{
 it('a second freezer cannot release an earlier freezer self verdict at the same head',async()=>{
  await schedule(['local']);await freeze();const t=await seat('local',H,author.id);
  await verdict(t,'APPROVE',H,author.id);await finish(t,author.id);
  expect((await readiness()).slots[0].counts).toBe(false);
  await M.reassignAgentTask!({}, {taskId:build.id,assignee:{user:other.id}},ctx());
  expect((await readiness()).slots[0].counts).toBe(false);
  await freeze(H,other.id);
  const answer=await readiness();
  expect(answer.slots[0].counts).toBe(false);
  expect(answer.ready).toBe(false);
 });
});


describe('late verdicts on superseded seats',()=>{
  it.each(['CHANGES_REQUESTED','FAIL','REFUSED'])('a late %s at H blocks the slot until a new head',async value=>{
    await schedule(['local']);await freeze();
    const old=await seat('local');await M.startAgentTask!({}, {taskId:old.id},ctx(reviewer.id));
    const now=await seat('local',H,other.id,old.id);await verdict(now,'APPROVE',H,other.id);await finish(now,other.id);
    expect((await readiness()).ready).toBe(true);
    await command('recordReviewVerdict',{taskRef:old.id,head:H,verdict:value},reviewer.id);
    const answer=await readiness();expect(answer.slots[0].currentTaskId).toBe(now.id);expect(answer.slots[0].counts).toBe(false);expect(answer.ready).toBe(false);
    await expect(command('recordReadyCall',{taskRef:build.id,head:H},author.id)).rejects.toMatchObject(error('PR_NOT_READY'));
    await freeze(H2);const next=await seat('local',H2,other.id,now.id);await verdict(next,'APPROVE',H2,other.id);await finish(next,other.id);
    expect((await readiness(H2)).ready).toBe(true);
  });
});


describe('same-head floor scope controls',()=>{
  it('the original superseded reviewer may re-rate its own negative without leaving an older negative effective',async()=>{
    await schedule(['local']);await freeze();const old=await seat('local');
    await M.startAgentTask!({}, {taskId:old.id},ctx(reviewer.id));
    const now=await seat('local',H,other.id,old.id);await verdict(now,'APPROVE',H,other.id);await finish(now,other.id);
    await command('recordReviewVerdict',{taskRef:old.id,head:H,verdict:'FAIL'},reviewer.id);
    expect((await readiness()).ready).toBe(false);
    await command('recordReviewVerdict',{taskRef:old.id,head:H,verdict:'APPROVE'},reviewer.id);
    expect((await readiness()).ready).toBe(true);
  });
  it('a freezer at an earlier head may review a new head frozen by a different implementer',async()=>{
    await schedule(['local']);await freeze();
    const review=await seat('local',H,author.id);
    await M.reassignAgentTask!({}, {taskId:build.id,assignee:{user:other.id}},ctx());
    await freeze(H2,other.id);
    const next=await M.createAgentTask!({}, {input:{parentTaskId:build.id,title:'New head',source:'synthetic',assignee:{user:author.id}}},ctx(other.id));
    await command('assignReviewSeat',{taskRef:next.id,slot:'local',head:H2,supersedes:review.id},other.id);
    await verdict(next,'APPROVE',H2,author.id);await finish(next,author.id);
    expect((await readiness(H2)).ready).toBe(true);
  });
});


describe('late verdicts after a clean slot is dropped',()=>{
  it.each(['CHANGES_REQUESTED','FAIL','REFUSED'])('a late %s from an unscheduled child blocks the head',async value=>{
    await schedule(['local','blind']);await freeze();const old=await seat('local');
    await M.startAgentTask!({}, {taskId:old.id},ctx(reviewer.id));
    const kept=await seat('blind',H,other.id);await verdict(kept,'APPROVE',H,other.id);await finish(kept,other.id);
    await schedule(['blind']);expect((await readiness()).ready).toBe(true);
    await command('recordReviewVerdict',{taskRef:old.id,head:H,verdict:value},reviewer.id);
    expect((await readiness()).ready).toBe(false);
    await expect(command('recordReadyCall',{taskRef:build.id,head:H},author.id)).rejects.toMatchObject(error('PR_NOT_READY'));
    await freeze(H2);const next=await seat('blind',H2,other.id,kept.id);await verdict(next,'APPROVE',H2,other.id);await finish(next,other.id);
    expect((await readiness(H2)).ready).toBe(true);
  });
});


describe('SECURITY final pins: freezer actor scope',()=>{
  it('a same-head freezer on another build is excluded from this build too',async()=>{
    const sibling=await M.createAgentTask!({}, {input:{appRef:app.id,title:'Other build',source:'synthetic',assignee:{user:reviewer.id},references:[{kind:'PULL_REQUEST',target:'https://github.com/example/project/pull/2'}]}},ctx());
    await command('freezePullRequestHead',{taskRef:sibling.id,head:H},reviewer.id);
    await schedule(['local']);await freeze();const t=await seat('local');await verdict(t);await finish(t);
    const answer=await readiness();expect(answer.slots[0].counts).toBe(false);expect(answer.ready).toBe(false);
    await expect(command('recordReadyCall',{taskRef:build.id,head:H},author.id)).rejects.toMatchObject(error('PR_NOT_READY'));
  });
  it('a freezer on another build at an earlier head can review this head',async()=>{
    const sibling=await M.createAgentTask!({}, {input:{appRef:app.id,title:'Other build',source:'synthetic',assignee:{user:reviewer.id},references:[{kind:'PULL_REQUEST',target:'https://github.com/example/project/pull/2'}]}},ctx());
    await command('freezePullRequestHead',{taskRef:sibling.id,head:H2},reviewer.id);
    await schedule(['local']);await freeze();const t=await seat('local');await verdict(t);await finish(t);
    expect((await readiness()).ready).toBe(true);
  });
  it('a freezer of the same head in another App does not affect this App',async()=>{
    const foreign=await db.app.create({data:{organizationId:app.organizationId,name:'Foreign',urn:app.urn+':foreign'}});
    await db.appMember.create({data:{appId:foreign.id,userId:reviewer.id,role:'member'}});
    const sibling=await M.createAgentTask!({}, {input:{appRef:foreign.id,title:'Foreign build',source:'synthetic',assignee:{user:reviewer.id},references:[{kind:'PULL_REQUEST',target:'https://github.com/example/project/pull/3'}]}},ctx(reviewer.id));
    await command('freezePullRequestHead',{taskRef:sibling.id,head:H},reviewer.id);
    await schedule(['local']);await freeze();const t=await seat('local');await verdict(t);await finish(t);
    expect((await readiness()).ready).toBe(true);
  });
  it('both same-head freezers remain excluded together after reassignment to a third actor',async()=>{
    await schedule(['local','blind']);await freeze();
    const a=await seat('local',H,author.id),b=await seat('blind',H,other.id);
    await verdict(a,'APPROVE',H,author.id);await finish(a,author.id);
    await verdict(b,'APPROVE',H,other.id);await finish(b,other.id);
    await M.reassignAgentTask!({}, {taskId:build.id,assignee:{user:other.id}},ctx());await freeze(H,other.id);
    await M.reassignAgentTask!({}, {taskId:build.id,assignee:{user:reviewer.id}},ctx());
    const answer=await readiness();expect(answer.slots).toHaveLength(2);
    expect(answer.slots.map((slot:any)=>slot.counts)).toEqual([false,false]);expect(answer.ready).toBe(false);
  });
});
