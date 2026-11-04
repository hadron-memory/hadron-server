/** #3448: PR protocol facts are typed events, never opaque properties (cor:agt:050:28). */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn() }));

const M = resolvers.Mutation as Record<string, (...args: any[]) => Promise<any>>;
const Q = resolvers.Query as Record<string, (...args: any[]) => Promise<any>>;
const H = 'a'.repeat(40), H2 = 'b'.repeat(40);
let owner: any, author: any, reviewer: any, other: any, outsider: any, app: any, build: any;
const ctx = (userId = owner.id) => ({ db, userId, roles: ['READER'] });
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
  return M.finishAgentTask!({}, { taskId: t.id, outcome: 'approved' }, ctx(who));
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
    const api = new ApolloServer({ typeDefs, resolvers });
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
  it.each([[], ['local', 'local'], ['a b'], ['x'.repeat(65)]])('refuses invalid slots %j atomically', async (...slots) => {
    await expect(schedule(slots as string[])).rejects.toMatchObject(error('BAD_USER_INPUT'));
    expect(await events()).toHaveLength(0);
  });
  it('freeze writes the head, PR reference, actor, mirror and an unmapped action', async () => {
    const r = await freeze();
    expect(r.action).toEqual({ code: 'pr.frozen', state: 'UNMAPPED' });
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
    await expect(seat('local', H, reviewer.id, build.id)).rejects.toMatchObject(error('REVIEW_SEAT_SUPERSEDE_INVALID'));
  });
  it('a no-verdict seat can be superseded at the same head', async () => {
    await schedule(['local']); await freeze(); const old = await seat('local');
    const now = await seat('local', H, reviewer.id, old.id);
    expect((await readiness()).slots[0].currentTaskId).toBe(now.id);
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
});
