/** #2674: descriptive edits must not reopen the not-started episode. Production unchanged. */
import { beforeEach, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { resolvers } from '../../api/graphql/schema/resolvers.js';
import { effectiveWindows, loadStallInputs, stallCandidates } from './stall.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const M = resolvers.Mutation as any;
beforeEach(async () => { await cleanDb(db); });

it('#2674 title and tags edits preserve the pending assignment episode and deadline', async () => {
  const org = await db.organization.create({ data: { name: 'Episode', urn: `episode-${generateId()}.test` } });
  const owner = await db.user.create({ data: { handle: `owner-${generateId()}` } });
  const assignee = await db.user.create({ data: { handle: `assignee-${generateId()}` } });
  const app = await db.app.create({ data: { organizationId: org.id, name: 'Episode', urn: `${org.urn}:app` } });
  for (const user of [owner, assignee]) {
    await db.appMember.create({ data: { appId: app.id, userId: user.id, role: 'member' } });
  }
  const ctx = { db, userId: owner.id, roles: ['READER'] };
  const task = await M.createAgentTask({}, { input: {
    appRef: app.id, title: 'Original', tags: ['old'], assignee: { user: assignee.id },
  } }, ctx);
  const now = new Date();
  const assignedAt = new Date(now.getTime() - 3_600_000);
  await db.agentTask.update({ where: { id: task.id }, data: { assignedAt } });
  const candidate = async () => {
    const inputs = await loadStallInputs(db, { id: task.id }, now);
    expect(inputs).toHaveLength(1);
    const result = stallCandidates(inputs[0], effectiveWindows(null), now).find(c => c.rule === 'not-started');
    expect(result).toBeDefined();
    return result!;
  };
  const before = await candidate();
  expect(before.episodeStart).toEqual(assignedAt);
  expect(before.dueAt).toEqual(new Date(assignedAt.getTime() + effectiveWindows(null).notStartedMinutes * 60_000));

  await M.updateAgentTask({}, { taskId: task.id, input: { title: 'Edited', tags: ['new'] } }, ctx);
  expect(await db.agentTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({
    status: 'pending', title: 'Edited', tags: ['new'], assignedAt, startBy: null,
  });
  const events = await db.agentTeamEvent.findMany({ where: { taskId: task.id, type: 'task.edited' } });
  expect(events).toHaveLength(1);
  expect(events[0].payload).toEqual({ fields: ['title', 'tags'] });
  expect(events[0].createdAt.getTime()).toBeGreaterThan(assignedAt.getTime());
  const after = await candidate();
  expect(after.episodeStart).toEqual(before.episodeStart);
  expect(after.dueAt).toEqual(before.dueAt);
});
