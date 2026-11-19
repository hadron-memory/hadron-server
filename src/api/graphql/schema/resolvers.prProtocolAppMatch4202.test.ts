/**
 * #4202 (§10 P2 on hadron-server#4212, Rook; folded in by Peter's ruling, team chat #111177) — the PR-protocol reads
 * count an event for a task only when the task is in the EVENT's App (hrn:node:hadronmemory.com:specs:cor:agt:050:01,
 * :21, :28). `agent_team_events.task_id` has no foreign key, so a legacy or hand-made row of another App can name this
 * App's build or seat task. No write path makes one; the reads must count it for nothing: it freezes no head, sets no
 * schedule, blocks no seat, and links no defect.
 *
 * Every pin plants such a row by raw insert (App B's event, App A's task). The same-App behaviour is pinned by
 * resolvers.prProtocol3448.test.ts and resolvers.defectLink4280.test.ts; one control per read is repeated here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn() }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const M = resolvers.Mutation as Record<string, (...args: any[]) => Promise<any>>;
const Q = resolvers.Query as Record<string, (...args: any[]) => Promise<any>>;
const H = 'a'.repeat(40);
const DEFECT = 'https://github.com/example/project/issues/4202';
let owner: any, author: any, reviewer: any, other: any, manager: any, app: any, foreign: any, build: any;
const ctx = (userId: string) => ({ db, userId, roles: ['READER' as const] });
const error = (code: string) => ({ extensions: { code } });
const command = (name: string, args: Record<string, unknown>, who: string) => M[name]!({}, args, ctx(who));
const readiness = (head = H) => Q.pullRequestReadiness!({}, { taskRef: build.id, head }, ctx(owner.id));
const schedule = (slots = ['local', 'blind']) => command('setReviewSchedule', { taskRef: build.id, slots }, owner.id);
const freeze = (head = H) => command('freezePullRequestHead', { taskRef: build.id, head }, author.id);
async function seat(slot: string, head = H) {
  const t = await M.createAgentTask!({}, { input: { parentTaskId: build.id, title: slot, assignee: { user: reviewer.id }, source: 'synthetic' } }, ctx(author.id));
  await command('assignReviewSeat', { taskRef: t.id, slot, head }, author.id);
  return t;
}
const verdict = (t: any, value: string, who = reviewer.id) =>
  command('recordReviewVerdict', { taskRef: t.id, head: H, verdict: value, node: 'hrn:node:example.test:reviews:one', receipt: 'https://example.test/receipt' }, who);
const link = (introducedAtHead?: string) => command('linkDefectToPullRequest', { defectRef: DEFECT, prTaskRef: build.id, ...(introducedAtHead ? { introducedAtHead } : {}) }, manager.id);
/** A raw event row: `appId` is whichever App the pin says, whatever App the task is in. */
const plant = (appId: string, taskId: string, type: string, payload: Record<string, unknown>, actorUserId: string | null = null) =>
  db.agentTeamEvent.create({ data: { id: generateId(), appId, taskId, type, payload: payload as never, actorUserId } });
const eventsOf = (taskId: string, type: string) => db.agentTeamEvent.findMany({ where: { taskId, type }, select: { appId: true } });

beforeEach(async () => {
  await cleanDb(db);
  [owner, author, reviewer, other, manager] = await Promise.all(['owner', 'author', 'reviewer', 'other', 'manager'].map((handle) => db.user.create({ data: { handle } })));
  const org = await db.organization.create({ data: { name: 'Protocol', urn: `protocol-4202-${generateId()}.test` } });
  app = await db.app.create({ data: { organizationId: org.id, name: 'Protocol', urn: `${org.urn}:app` } });
  foreign = await db.app.create({ data: { organizationId: org.id, name: 'Foreign', urn: `${org.urn}:foreign` } });
  for (const u of [owner, author, reviewer, other]) await db.appMember.create({ data: { appId: app.id, userId: u.id, role: 'member' } });
  await db.appMember.create({ data: { appId: app.id, userId: manager.id, role: 'owner' } });
  build = await M.createAgentTask!({}, { input: { appRef: app.id, title: 'Build', source: 'synthetic', assignee: { user: author.id }, references: [{ kind: 'PULL_REQUEST', target: 'https://github.com/example/project/pull/1' }] } }, ctx(owner.id));
});

describe('#4202 the protocol facts of a task (taskEvents): frozen head, schedule, seat', () => {
  it('a pr.frozen event of another App naming the build task freezes no head: readiness still refuses', async () => {
    await schedule();
    await plant(foreign.id, build.id, 'pr.frozen', { head: H });
    await expect(readiness()).rejects.toMatchObject(error('PR_HEAD_NOT_FROZEN'));
  });

  it('control: the same event in the build task\'s own App is its frozen head', async () => {
    await schedule();
    await plant(app.id, build.id, 'pr.frozen', { head: H }, author.id);
    expect((await readiness()).head).toBe(H);
  });

  it('a review.scheduled event of another App naming the build task sets no schedule', async () => {
    await freeze();
    await plant(foreign.id, build.id, 'review.scheduled', { slots: ['local'] });
    await expect(readiness()).rejects.toMatchObject(error('REVIEW_SCHEDULE_MISSING'));
  });

  it('a pr.frozen event of another App does not let a seat be assigned at a head that was never frozen', async () => {
    await schedule();
    await plant(foreign.id, build.id, 'pr.frozen', { head: H });
    const t = await M.createAgentTask!({}, { input: { parentTaskId: build.id, title: 'local', assignee: { user: reviewer.id }, source: 'synthetic' } }, ctx(author.id));
    await expect(command('assignReviewSeat', { taskRef: t.id, slot: 'local', head: H }, author.id)).rejects.toMatchObject(error('REVIEW_HEAD_MISMATCH'));
    expect(await eventsOf(t.id, 'review.seat.assigned')).toEqual([]);
  });

  it('a review.seat.assigned event of another App naming a plain child task gives it no seat: no verdict is recorded on it', async () => {
    await schedule(); await freeze();
    const t = await M.createAgentTask!({}, { input: { parentTaskId: build.id, title: 'not a seat', assignee: { user: reviewer.id }, source: 'synthetic' } }, ctx(author.id));
    await plant(foreign.id, t.id, 'review.seat.assigned', { slot: 'local', head: H, supersedes: null });
    await M.startAgentTask!({}, { taskId: t.id }, ctx(reviewer.id));
    await expect(verdict(t, 'APPROVE')).rejects.toMatchObject(error('REVIEW_SEAT_UNASSIGNED'));
    expect(await eventsOf(t.id, 'review.verdict')).toEqual([]);
  });
});

describe('#4202 the negative-verdict reads', () => {
  it('a negative review.verdict of another App naming a seat does not stop the schedule dropping that seat\'s slot (negativeAtHead)', async () => {
    await schedule(); await freeze();
    const t = await seat('local');
    await plant(foreign.id, t.id, 'review.verdict', { slot: 'local', head: H, verdict: 'CHANGES_REQUESTED' });
    await schedule(['blind']);
    expect((await readiness()).slots.map((s: any) => s.slot)).toEqual(['blind']);
  });

  it('control: the same verdict in the seat\'s own App does stop it', async () => {
    await schedule(); await freeze();
    const t = await seat('local');
    await plant(app.id, t.id, 'review.verdict', { slot: 'local', head: H, verdict: 'CHANGES_REQUESTED' }, other.id);
    await expect(schedule(['blind'])).rejects.toMatchObject(error('REVIEW_SEAT_NOT_SUPERSEDABLE'));
  });

  it('a negative review.verdict of another App by another actor does not stop the seat\'s holder recording its verdict (the prior-verdict read)', async () => {
    await schedule(); await freeze();
    const t = await seat('local');
    await M.startAgentTask!({}, { taskId: t.id }, ctx(reviewer.id));
    await plant(foreign.id, t.id, 'review.verdict', { slot: 'local', head: H, verdict: 'FAIL' }, other.id);
    await verdict(t, 'APPROVE');
    expect(await eventsOf(t.id, 'review.verdict')).toEqual(expect.arrayContaining([{ appId: app.id }]));
  });

  it('control: the same prior verdict in the seat\'s own App does stop another actor', async () => {
    await schedule(); await freeze();
    const t = await seat('local');
    await M.startAgentTask!({}, { taskId: t.id }, ctx(reviewer.id));
    await plant(app.id, t.id, 'review.verdict', { slot: 'local', head: H, verdict: 'FAIL' }, other.id);
    await expect(verdict(t, 'APPROVE')).rejects.toMatchObject(error('REVIEW_SEAT_NOT_SUPERSEDABLE'));
  });
});

describe('#4202 the defect link', () => {
  it('a pr.frozen event of another App does not make a head one that was frozen on this pull request', async () => {
    await plant(foreign.id, build.id, 'pr.frozen', { head: H });
    await expect(link(H)).rejects.toMatchObject(error('DEFECT_HEAD_NOT_FROZEN'));
    expect(await eventsOf(build.id, 'review.defect-linked')).toEqual([]);
  });

  it('control: a head frozen in the task\'s own App is accepted', async () => {
    await freeze();
    expect((await link(H)).created).toBe(true);
  });

  it('a review.defect-linked event of another App is not this task\'s link: the link is still created, in the task\'s App', async () => {
    await plant(foreign.id, build.id, 'review.defect-linked', { defect: DEFECT, introducedAtHead: null });
    expect((await link()).created).toBe(true);
    expect(await eventsOf(build.id, 'review.defect-linked')).toEqual(expect.arrayContaining([{ appId: app.id }]));
    // And a second call returns the App's own link, not the foreign row.
    expect((await link()).created).toBe(false);
  });
});
