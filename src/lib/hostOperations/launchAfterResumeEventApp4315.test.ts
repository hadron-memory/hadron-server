/**
 * #4315 item 3 (follow-up to #4202 / #4212) — `launchAfterTeamResume` takes a task's family from the task's LATEST assignment event,
 * and that event must be an event of the TASK's App.
 *
 * `agent_team_events.task_id` has no foreign key, so a legacy or hand-made row can name a task of another App. No write path makes
 * one; the read must still count it for nothing. Here a hand-assigned task (which names no family, so the lift starts Kit as the host
 * launches it) gets a LATER `assignment.matched` row of ANOTHER App naming it with a family: before the App match, that row became
 * "the latest assignment" and the lift took its family.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { resolvers } from '../../api/graphql/schema/resolvers.js';
import type { Context } from '../../api/graphql/schema/resolvers.helpers.js';
import { setUpResetFixture, type ResetFixture } from '../../test/contextResetFixture.js';
import { generateId } from '../id.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const M = resolvers.Mutation as any;
const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] }) as Context;

let f: ResetFixture;
const starts = () => db.hostOperation.findMany({ where: { type: 'worker.start' } });

/** The host launches Kit only as codex, with a worktree. */
const registerCodexOnly = () =>
  M.registerHost({}, {
    input: {
      appRef: f.app.id, label: 'Orca', pollIntervalSeconds: 600, capabilities: ['worker.reset-context'],
      workers: [{ worker: f.kit.id, family: 'codex', worktrees: ['hadron-server/kit'] }],
    },
  }, f.keyCtx());

/** A task handed to Kit by hand while the team is paused (its own assignment event is a `task.assigned`: no family). */
async function handAssignedDuringPause(): Promise<string> {
  await M.setTeamPause({}, { appRef: f.app.id, paused: true }, ctx(f.manager.id));
  const t = await db.agentTask.create({ data: { appId: f.app.id, title: 'Do it', ownerUserId: f.manager.id, closeSessionWhenDone: false }, select: { id: true } });
  await M.assignAgentTask({}, { taskId: t.id, assignee: { worker: f.kit.id } }, ctx(f.manager.id));
  return t.id;
}

async function otherApp(): Promise<string> {
  const suffix = generateId().slice(-8);
  const org = await db.organization.create({ data: { id: generateId(), name: `other-${suffix}`, urn: `other-${suffix}.test` } });
  return (await db.app.create({ data: { id: generateId(), organizationId: org.id, name: `Other ${suffix}`, urn: `${org.urn}:app` } })).id;
}

const plantMatched = (appId: string, taskId: string, family: string) =>
  db.agentTeamEvent.create({ data: { id: generateId(), appId, type: 'assignment.matched', taskId, createdAt: new Date(Date.now() + 60_000), payload: { family } as never } });

beforeEach(async () => {
  f = await setUpResetFixture();
  await db.session.update({ where: { id: f.session.id }, data: { endedAt: new Date() } });
  await db.worker.update({ where: { id: f.ada.id }, data: { retiredAt: new Date() } });
});

describe('#4315 item 3: launchAfterTeamResume reads the latest assignment event of the task\'s own App only', () => {
  it('a LATER assignment.matched row of another App naming the task does not set its family: the lift starts Kit as the host launches it (codex)', async () => {
    const taskId = await handAssignedDuringPause();
    await plantMatched(await otherApp(), taskId, 'claude');
    await registerCodexOnly();
    await M.setTeamPause({}, { appRef: f.app.id, paused: false }, ctx(f.manager.id));
    // On main the foreign row is the latest "assignment", so the family is claude, which the codex-only host cannot start: no start.
    expect((await starts()).map((o) => o.args)).toEqual([{ workerId: f.kit.id, worktree: 'hadron-server/kit', family: 'codex', taskId }]);
  });

  it('control: the SAME row in the task\'s own App is the latest assignment, so its family is taken (claude: a codex-only host starts nothing)', async () => {
    const taskId = await handAssignedDuringPause();
    await plantMatched(f.app.id, taskId, 'claude');
    await registerCodexOnly();
    await M.setTeamPause({}, { appRef: f.app.id, paused: false }, ctx(f.manager.id));
    expect(await starts()).toEqual([]);
  });
});
