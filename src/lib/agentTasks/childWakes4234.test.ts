/**
 * #4234 (G7 of the Team on Orca epic, #4229) — the PARENT's assignee is woken when one of its child tasks finishes or
 * is cancelled, so an implementer waiting on its review, QA and merge tasks catches each verdict without polling
 * (Holger's G7 ruling, hrn:node:hadronmemory.com:hadron-dev-team-shared:coordination:team-on-orca-decisions, log row
 * 2026-11-15 15:10). The child's owner keeps its own wake (cor:agt:050:16 r2); a cancelled child now wakes both too,
 * as it already starts the owner-didn't-react window (#1830).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
import { type Context } from '../../api/graphql/schema/resolvers.js';
import { computeDueWakes } from '../tickers/dueWakes.js';
import { pendingTaskWakes, recordUndeliverableTaskWakes } from './taskWakes.js';

vi.mock('../bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const MIN = 60_000;
const DAY = 86_400_000;

let org: { id: string; urn: string };
let manager: { id: string };
let holder: { id: string };
let app: { id: string; organizationId: string | null; ownerUserId: string | null };
let agent: { id: string };
let liam: { id: string };
let anne: { id: string };
let rook: { id: string };

const ctx = (userId: string): Context => ({ db, userId, roles: ['READER'] }) as Context;

async function mkUser(n: number) {
  return db.user.create({
    data: { id: generateId(), githubId: 4_234_000 + n * 1000 + Math.floor(Math.random() * 1000), githubUsername: `cw-${n}-${generateId().slice(-8)}`, roles: ['READER'] },
    select: { id: true },
  });
}
const mkWorker = (name: string) =>
  db.worker.create({
    data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name, slug: name.toLowerCase(), heldByUserId: holder.id, heldAt: new Date() },
    select: { id: true },
  });

beforeEach(async () => {
  await cleanDb(db);
  const suffix = generateId().slice(-10).toLowerCase();
  org = await db.organization.create({ data: { id: generateId(), name: 'cw-org', urn: `cw-org-${suffix}.com` } });
  [manager, holder] = [await mkUser(1), await mkUser(2)];
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: manager.id, role: 'ADMIN' } });
  agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team`, visibility: 'ORGANIZATION' } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` }, select: { id: true, organizationId: true, ownerUserId: true } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  await db.appMember.create({ data: { appId: app.id, userId: holder.id, role: 'member' } });
  liam = await mkWorker('Liam');
  anne = await mkWorker('Anne');
  rook = await mkWorker('Rook');
});

const task = (data: Record<string, unknown>) =>
  db.agentTask.create({ data: { appId: app.id, title: 'Review #42', ...data }, select: { id: true } });
const event = (data: Record<string, unknown> & { type: string }) =>
  db.agentTeamEvent.create({ data: { appId: app.id, ...data }, select: { id: true } });
const FINISHED = () => ({ status: 'finished', startedAt: new Date(Date.now() - 10 * MIN), finishedAt: new Date(), resultOutcome: 'done' });
const CANCELLED = () => ({ status: 'cancelled', cancelledAt: new Date() });
/** A started parent Rook owns, assigned to `assignee`, and a child of it that `childOwner` owns and Rook is assigned. */
async function family(assignee: { id: string }, childOwner: { id: string }, childEnd: Record<string, unknown>) {
  const parent = await task({ ownerWorkerId: rook.id, assigneeWorkerId: assignee.id, status: 'started', startedAt: new Date(Date.now() - 60 * MIN), assignedAt: new Date(Date.now() - 60 * MIN) });
  const child = await task({ parentTaskId: parent.id, ownerWorkerId: childOwner.id, assigneeWorkerId: rook.id, assignedAt: new Date(Date.now() - 20 * MIN), title: 'Child', ...childEnd });
  return { parent, child };
}
const dueFor = (now = new Date()) =>
  computeDueWakes({ ctx: ctx(manager.id), app, reader: { manager: true, userId: manager.id }, requester: { userId: manager.id }, now });
const taskEvents = async (workerId: string, now = new Date()) =>
  ((await dueFor(now)).wakes.find((x) => x.workerId === workerId)?.wake.reasons ?? [])
    .filter((r) => r.kind === 'TASK')
    .map((r) => ({ taskId: (r as any).taskId, event: (r as any).event }));

describe("#4234 G7: a child's finish wakes the parent's assignee", () => {
  it('the parent was reassigned after the child was made: its new assignee AND the child\'s owner are both due', async () => {
    const { child } = await family(anne, liam, FINISHED());
    await event({ taskId: child.id, type: 'task.finished', actorWorkerId: rook.id, actorUserId: holder.id, payload: { outcome: 'done' } });
    expect(await taskEvents(anne.id)).toEqual([{ taskId: child.id, event: 'CHILD_FINISHED' }]);
    expect(await taskEvents(liam.id)).toEqual([{ taskId: child.id, event: 'CHILD_FINISHED' }]);
  });

  it('the parent\'s assignee who is also the child\'s owner gets the event once, not twice', async () => {
    const { child } = await family(liam, liam, FINISHED());
    const e = await event({ taskId: child.id, type: 'task.finished', actorWorkerId: rook.id, actorUserId: holder.id });
    const pending = (await pendingTaskWakes(db, [liam.id], new Date())).get(liam.id) ?? [];
    expect(pending.map((p) => p.eventId)).toEqual([e.id]);
  });

  it('a parent assignee who finished the child itself is not woken for it (the owner still is)', async () => {
    const { child } = await family(anne, liam, FINISHED());
    await event({ taskId: child.id, type: 'task.finished', actorWorkerId: anne.id, actorUserId: holder.id });
    expect(await taskEvents(anne.id)).toEqual([]);
    expect(await taskEvents(liam.id)).toEqual([{ taskId: child.id, event: 'CHILD_FINISHED' }]);
  });

  it('the parent\'s assignee acting on the parent after the finish ends its wake', async () => {
    const { parent, child } = await family(anne, liam, FINISHED());
    await event({ taskId: child.id, type: 'task.finished', actorWorkerId: rook.id, actorUserId: holder.id });
    await event({ taskId: parent.id, type: 'task.progress', actorWorkerId: anne.id, actorUserId: holder.id, createdAt: new Date(Date.now() + 1000) });
    expect(await taskEvents(anne.id, new Date(Date.now() + 2000))).toEqual([]);
  });

  it('a child ending under an ended parent wakes nobody', async () => {
    const parent = await task({ ownerWorkerId: rook.id, assigneeWorkerId: anne.id, assignedAt: new Date(Date.now() - 60 * MIN), ...FINISHED() });
    const child = await task({ parentTaskId: parent.id, ownerWorkerId: liam.id, assigneeWorkerId: rook.id, assignedAt: new Date(Date.now() - 20 * MIN), ...FINISHED() });
    await event({ taskId: child.id, type: 'task.finished', actorWorkerId: rook.id, actorUserId: holder.id });
    expect((await dueFor()).wakes).toEqual([]);
  });
});

describe("#4234 G7: a child's cancellation wakes the same two as its finish", () => {
  it('the parent\'s assignee and the child\'s owner are due with CHILD_CANCELLED', async () => {
    const { child } = await family(anne, liam, CANCELLED());
    await event({ taskId: child.id, type: 'task.cancelled', actorUserId: manager.id, payload: { fromStatus: 'pending', openChildCount: 0 } });
    expect(await taskEvents(anne.id)).toEqual([{ taskId: child.id, event: 'CHILD_CANCELLED' }]);
    expect(await taskEvents(liam.id)).toEqual([{ taskId: child.id, event: 'CHILD_CANCELLED' }]);
  });

  it('a dormant owner of a cancelled child is recorded undeliverable, like one of a finished child', async () => {
    const { child } = await family(anne, liam, CANCELLED());
    await db.session.create({ data: { id: generateId(), appId: app.id, userId: holder.id, workerId: liam.id, agentId: agent.id, type: 'DEVELOPER', startedAt: new Date(Date.now() - 100 * DAY), updatedAt: new Date(Date.now() - 100 * DAY), endedAt: new Date(Date.now() - 100 * DAY) } });
    const e = await event({ taskId: child.id, type: 'task.cancelled', actorUserId: manager.id, payload: { fromStatus: 'pending', openChildCount: 0 } });
    await recordUndeliverableTaskWakes(db, new Date());
    const row = await db.workerDeliveryTaskEvent.findUnique({ where: { workerId_eventId_chainIndex: { workerId: liam.id, eventId: e.id, chainIndex: 0 } } });
    expect(row).toMatchObject({ deliveredAt: null, undeliverableReason: 'dormant' });
  });
});
