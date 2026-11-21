/** #4494: the seat and verdict refusals name the remedy. Codes and outcomes are unchanged; only the message text moves. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers } from './resolvers.js';
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn() }));

const M = resolvers.Mutation as Record<string, (...args: any[]) => Promise<any>>;
const H = 'a'.repeat(40), H2 = 'b'.repeat(40);
const REMEDY = 'Post the verdict as a signed PR receipt at the exact head, which is the record when a seat cannot bind.';
let owner: any, author: any, reviewer: any, app: any, build: any;
const ctx = (userId: string) => ({ db, userId, roles: ['READER' as const] });
const refused = (code: string, message: string) => ({ extensions: { code }, message });
const PR = [{ kind: 'PULL_REQUEST', target: 'https://github.com/example/project/pull/1' }];
const child = (parent: string, who = author.id) => M.createAgentTask!({}, { input: { parentTaskId: parent, title: 'Seat', source: 'synthetic', assignee: { user: reviewer.id } } }, ctx(who));
const seatCmd = (taskRef: string, head = H, who = author.id) => M.assignReviewSeat!({}, { taskRef, slot: 'local', head }, ctx(who));
const verdictCmd = (taskRef: string, head = H, who = reviewer.id) => M.recordReviewVerdict!({}, { taskRef, head, verdict: 'APPROVE' }, ctx(who));
const finishTask = async (id: string, who: string) => {
  await M.startAgentTask!({}, { taskId: id }, ctx(who));
  await M.finishAgentTask!({}, { taskId: id, result: { outcome: 'done' } }, ctx(who));
};
async function readyBuild() {
  await M.setReviewSchedule!({}, { taskRef: build.id, slots: ['local'] }, ctx(owner.id));
  await M.freezePullRequestHead!({}, { taskRef: build.id, head: H }, ctx(author.id));
}

beforeEach(async () => {
  await cleanDb(db);
  [owner, author, reviewer] = await Promise.all(['owner', 'author', 'reviewer'].map(handle => db.user.create({ data: { handle } })));
  const org = await db.organization.create({ data: { name: 'Remedy', urn: `remedy-${generateId()}.test` } });
  app = await db.app.create({ data: { organizationId: org.id, name: 'Remedy', urn: `${org.urn}:app` } });
  for (const u of [owner, author, reviewer]) await db.appMember.create({ data: { appId: app.id, userId: u.id, role: 'member' } });
  build = await M.createAgentTask!({}, { input: { appRef: app.id, title: 'Build', source: 'synthetic', assignee: { user: author.id }, references: PR } }, ctx(owner.id));
});

describe('#4494 refusal texts name the remedy (rows 1-7)', () => {
  it('row 1: a new seat under an ended build task', async () => {
    await readyBuild(); await finishTask(build.id, author.id);
    await expect(child(build.id)).rejects.toMatchObject(refused('TASK_ENDED',
      `This task is finished; an ended task never moves again. A child task such as a review seat cannot be created under an ended build task. ${REMEDY}`));
  });
  it('row 2: pr seat on a seat that has itself ended', async () => {
    await readyBuild(); const t = await child(build.id); await finishTask(t.id, reviewer.id);
    await expect(seatCmd(t.id)).rejects.toMatchObject(refused('TASK_ENDED',
      `This task is finished; an ended task never moves again. A seat binds only while its task is live. ${REMEDY}`));
  });
  it('row 3: pr verdict on a seat that has itself ended', async () => {
    await readyBuild(); const t = await child(build.id); await seatCmd(t.id); await finishTask(t.id, reviewer.id);
    await expect(verdictCmd(t.id)).rejects.toMatchObject(refused('TASK_ENDED',
      `This task is finished; an ended task never moves again. A verdict is recorded only on a live seat. ${REMEDY}`));
  });
  it('row 4: pr verdict on a live seat that was never bound', async () => {
    await readyBuild(); const t = await child(build.id); await M.startAgentTask!({}, { taskId: t.id }, ctx(reviewer.id));
    await expect(verdictCmd(t.id)).rejects.toMatchObject(refused('REVIEW_SEAT_UNASSIGNED',
      `The task has no assigned review seat: it was never bound with pr seat. ${REMEDY}`));
  });
  it('row 5: pr seat on a parentless task', async () => {
    const root = await M.createAgentTask!({}, { input: { appRef: app.id, title: 'Root', project: true, source: 'synthetic', assignee: { user: author.id } } }, ctx(owner.id));
    await expect(seatCmd(root.id, H, owner.id)).rejects.toMatchObject(refused('REVIEW_SEAT_UNASSIGNED',
      `A seat must be a child of the build task. ${REMEDY}`));
  });
  it('row 6: pr seat on a child of a task with no frozen head', async () => {
    const other = await M.createAgentTask!({}, { input: { appRef: app.id, title: 'Not frozen', source: 'synthetic', assignee: { user: author.id } } }, ctx(owner.id));
    const t = await child(other.id);
    await expect(seatCmd(t.id)).rejects.toMatchObject(refused('REVIEW_HEAD_MISMATCH',
      `This is not the build task's frozen head. ${REMEDY}`));
  });
  it('row 7: pr verdict at a head other than the assigned one', async () => {
    await readyBuild(); const t = await child(build.id); await seatCmd(t.id); await M.startAgentTask!({}, { taskId: t.id }, ctx(reviewer.id));
    await expect(verdictCmd(t.id, H2)).rejects.toMatchObject(refused('REVIEW_HEAD_MISMATCH',
      `The verdict head differs from the assigned head. ${REMEDY}`));
  });
  it('the unchanged outcomes: a live seat at the frozen head still binds and records', async () => {
    await readyBuild(); const t = await child(build.id); await seatCmd(t.id); await M.startAgentTask!({}, { taskId: t.id }, ctx(reviewer.id));
    await expect(verdictCmd(t.id)).resolves.toBeTruthy();
  });
});
