/**
 * #3448 (cor:agt:050:28, cor:agt:110:01/:03): validated PR protocol facts.
 * Commands append typed events and mirror properties atomically; readiness NEVER reads a property.
 * All writes use the ordinary task authority transaction, with the App task graph exclusive BEFORE
 * any task row. This serializes protocol changes with one another and with existing task lifecycle
 * writes. Reads hold the graph shared and the contributing task rows shared for one coherent answer.
 */
import { Prisma } from '../../../generated/prisma/index.js';
import type { Context } from './resolvers.helpers.js';
import { withoutRequestCaches } from './resolvers.helpers.js';
import { mutateTask, mayDirectTask, isAssignee, withReadableTask, resolveTaskRef, taskError, type TaskRow, type TaskActor, type TaskApp } from './resolvers.agentTask.js';
import { appendTaskEvent, eventActor } from '../../../lib/agentTasks/events.js';
import { PR_EVENT_TYPES, REVIEW_VERDICTS, type ReviewVerdict, type PrProtocolEvent } from '../../../lib/agentTasks/prProtocol.js';
import { storedTaskReferences } from '../../../lib/agentTasks/references.js';
import { checkAgainstTeamSchema, normalizeTaskProperties } from '../../../lib/agentTasks/properties.js';
import { lockTaskGraph } from '../../../lib/agentTasks/blockers.js';
import { RegisterLookup } from '../../../lib/actionRegister/lookup.js';
import { boundedRead } from './resolvers.taskWarnings.js';
import { currentActor } from '../../../lib/requestActor.js';
import type { PublicTickAction } from '../../../lib/tickers/tickActions.js';

const badInput = (text: string) => taskError('BAD_USER_INPUT', text);
const ATOM = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?$/;
const validSlot = (value: unknown): value is string => typeof value === 'string' && value.length <= 64 && value.split(':').every(atom => ATOM.test(atom));
const SHA = /^[0-9a-fA-F]{40}$/;
type Event = Pick<Prisma.AgentTeamEventGetPayload<Record<string, never>>, 'id' | 'taskId' | 'type' | 'payload' | 'actorWorkerId' | 'actorUserId' | 'createdAt'>;
const data = (event: Event | undefined): Record<string, unknown> =>
  event?.payload && typeof event.payload === 'object' && !Array.isArray(event.payload) ? event.payload as Record<string, unknown> : {};
const latest = (events: Event[], type: string, id: string) => events.find(e => e.taskId === id && e.type === type);
const newest = [{ createdAt: 'desc' }, { id: 'desc' }] as const;

function headValue(head: unknown): string {
  if (typeof head !== 'string' || !SHA.test(head)) throw badInput('head must be a full 40-hex SHA.');
  return head.toLowerCase();
}
function slotValue(slot: unknown): string {
  if (!validSlot(slot)) throw badInput('A slot is colon-separated atoms, at most 64 characters total.');
  return slot;
}
function scheduleValue(slots: unknown): string[] {
  if (!Array.isArray(slots) || !slots.length) throw badInput('slots must be a non-empty list.');
  const result = slots.map(slotValue);
  if (new Set(result).size !== result.length) throw badInput('slots must be unique.');
  return result;
}
function optionalMetadata(value: unknown, field: string): string | null {
  if (value == null) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > 2048 || /[\u0000-\u001f\u007f]/.test(value)) throw badInput(`${field} must be non-empty text of at most 2048 characters, without controls.`);
  return value;
}
async function taskEvents(tx: Prisma.TransactionClient, ids: string[]): Promise<Event[]> {
  if (!ids.length) return [];
  // Collapse history in PostgreSQL, not Prisma's client-side distinct: repeated verdicts/freezes must
  // not hydrate the complete append-only stream. At most one row per task and protocol type escapes.
  const rows = await tx.$queryRaw<Event[]>`SELECT DISTINCT ON (task_id, type)
    id, task_id AS "taskId", type, payload, actor_worker_id AS "actorWorkerId", actor_user_id AS "actorUserId", created_at AS "createdAt"
    FROM agent_team_events WHERE task_id IN (${Prisma.join(ids)}) AND type IN (${Prisma.join([...PR_EVENT_TYPES])})
    ORDER BY task_id, type, created_at DESC, id DESC`;
  return rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id));
}
function frozen(events: Event[], taskId: string, head: string, code = 'PR_HEAD_NOT_FROZEN'): string {
  const value = data(latest(events, 'pr.frozen', taskId)).head;
  if (value !== head) throw taskError(code, 'This is not the build task\'s frozen head.');
  return value as string;
}
function scheduled(events: Event[], taskId: string): string[] {
  const slots = data(latest(events, 'review.scheduled', taskId)).slots;
  if (!Array.isArray(slots) || !slots.length || !slots.every(validSlot)) throw taskError('REVIEW_SCHEDULE_MISSING', 'The build task has no review schedule.');
  return slots as string[];
}
async function negativeAtHead(tx: Prisma.TransactionClient, taskId: string, head: string): Promise<boolean> {
  const prior = await tx.agentTeamEvent.findFirst({ where: { taskId, type: 'review.verdict', payload: { path: ['head'], equals: head } }, orderBy: [...newest] });
  return ['CHANGES_REQUESTED', 'FAIL', 'REFUSED'].includes(String(data(prior ?? undefined).verdict));
}
function assignments(events: Event[]): Event[] {
  return events.filter(e => e.type === 'review.seat.assigned')
    .filter((e, i, all) => all.findIndex(other => other.taskId === e.taskId) === i);
}
function currentAssignment(events: Event[], slot: string): Event | undefined {
  const assigned = assignments(events);
  const superseded = new Set(assigned.map(e => data(e).supersedes).filter((id): id is string => typeof id === 'string'));
  return assigned.find(e => data(e).slot === slot && !superseded.has(e.taskId!));
}
async function ownerChain(tx: Prisma.TransactionClient, c: Context, app: TaskApp, actor: TaskActor, task: TaskRow, excludeAssignee = false) {
  if ((excludeAssignee && isAssignee(actor, task)) || !await mayDirectTask(tx, c, app, actor, task)) {
    throw taskError('TASK_NOT_OWNER', 'Only the task\'s owner chain performs this command; the assignee alone has no standing.');
  }
}
function assignee(actor: TaskActor, task: TaskRow) {
  if (!isAssignee(actor, task)) throw taskError('TASK_NOT_ASSIGNEE', 'Only the task\'s assignee performs this command.');
}

/** Mirrors obey the ordinary size/schema constraints, but are never consulted as protocol facts. */
async function record(tx: Prisma.TransactionClient, c: Context, task: TaskRow, event: PrProtocolEvent, mirror: Record<string, Prisma.InputJsonValue | null>) {
  const properties = normalizeTaskProperties({ ...(task.properties as Record<string, unknown> | null ?? {}), ...mirror });
  await checkAgainstTeamSchema(tx, c, task.appId, properties);
  const actor = currentActor();
  await tx.agentTask.update({ where: { id: task.id }, data: {
    properties, updatedBy: c.userId ?? null, updatedByWorkerId: actor.workerId, updatedByAgentId: actor.agentId,
  } });
  await appendTaskEvent(tx, { appId: task.appId, taskId: task.id, actor: eventActor(c.userId), event });
}

/** Optional guidance is resolved after commit. Failure never turns an accepted command into a refusal. */
async function action(ctx: Context, appId: string, code: string): Promise<PublicTickAction> {
  try {
    return await boundedRead(ctx, async (tx, deadline) => {
      const c = withoutRequestCaches(ctx, tx);
      const lookup = new RegisterLookup(tx, c, appId, deadline);
      const team = await lookup.teamMemory();
      if (!team) return { code, state: 'UNMAPPED' };
      for (const id of await lookup.chain(team)) if (!await lookup.readable(c, id, 'reader')) return { code, state: 'WITHHELD' };
      const entry = await lookup.entry(code);
      if (entry.state !== 'FOUND') return { code, state: entry.state };
      const workerId = currentActor().workerId;
      const worker = workerId ? await tx.worker.findFirst({ where: { id: workerId, appId }, select: { agent: { select: { systemMemoryId: true, deletedAt: true } } } }) : null;
      const memoryId = workerId ? (worker?.agent.deletedAt ? null : worker?.agent.systemMemoryId) : team;
      if (memoryId) {
        for (const id of await lookup.chain(memoryId)) if (!await lookup.readable(c, id, 'reader')) return { code, state: 'WITHHELD' };
        const task = await lookup.task(memoryId, entry.taskLoc);
        if (task?.task) return { code, state: 'MAPPED', taskLoc: task.task.loc, taskUrn: task.task.urn };
      }
      return { code, state: 'UNRESOLVED', taskLoc: entry.taskLoc };
    });
  } catch { return { code, state: 'WITHHELD' }; }
}

type SlotAnswer = { slot: string; currentTaskId: string | null; state: string; verdict: string | null; head: string | null; counts: boolean };
type Readiness = { ready: boolean; head: string; slots: SlotAnswer[] };

/** Caller holds the App graph (shared for a read, exclusive for a ready call), before these rows. */
async function readinessInTx(tx: Prisma.TransactionClient, buildId: string, appId: string, head: string): Promise<Readiness> {
  await tx.$queryRaw`SELECT id FROM agent_tasks WHERE app_id = ${appId} AND (id = ${buildId} OR parent_task_id = ${buildId}) ORDER BY id FOR SHARE`;
  const tasks = await tx.agentTask.findMany({ where: { appId, OR: [{ id: buildId }, { parentTaskId: buildId }] } });
  const build = tasks.find(t => t.id === buildId);
  if (!build) throw taskError('TASK_NOT_FOUND', 'Task not found.');
  const events = await taskEvents(tx, tasks.map(t => t.id));
  frozen(events, buildId, head);
  const slots = scheduled(events, buildId);
  const childEvents = events.filter(e => e.taskId !== buildId);
  const answers = slots.map((slot): SlotAnswer => {
    const assignment = currentAssignment(childEvents, slot);
    const task = assignment ? tasks.find(t => t.id === assignment.taskId) : null;
    const verdict = task ? latest(events, 'review.verdict', task.id) : undefined;
    const payload = data(verdict);
    // Actor identity is the same worker/person distinction as the task writer gate, not the holder's credential.
    const ownVerdict = !!verdict && (build.assigneeWorkerId
      ? verdict.actorWorkerId === build.assigneeWorkerId
      : !verdict.actorWorkerId && !!build.assigneeUserId && verdict.actorUserId === build.assigneeUserId);
    const counts = !!task && task.status === 'finished' && data(assignment).head === head && payload.head === head
      && payload.slot === slot && ['APPROVE', 'PASS', 'CARRY'].includes(String(payload.verdict)) && !ownVerdict;
    return { slot, currentTaskId: task?.id ?? null, state: task?.status.toUpperCase() ?? 'MISSING',
      verdict: typeof payload.verdict === 'string' ? payload.verdict : null,
      head: typeof payload.head === 'string' ? payload.head : typeof data(assignment).head === 'string' ? data(assignment).head as string : null, counts };
  });
  return { ready: answers.every(s => s.counts), head, slots: answers };
}

export const prProtocolQueries = {
  pullRequestReadiness: async (_: unknown, { taskRef, head: raw }: { taskRef: string; head: string }, ctx: Context) => {
    // The same task read gate, including the App's live key; conceal an unreadable task as null.
    return withReadableTask(ctx, taskRef, async (c, { task }) => {
      const head = headValue(raw);
      const read = async (tx: Prisma.TransactionClient) => {
        await lockTaskGraph(tx, task.appId, 'shared');
        return readinessInTx(tx, task.id, task.appId, head);
      };
      // Key reads already run inside their anchored transaction. Participant reads open their own snapshot.
      if (!('$transaction' in c.db)) return read(c.db as unknown as Prisma.TransactionClient);
      return c.db.$transaction(read, { timeout: 10_000 });
    });
  },
};

export const prProtocolMutations = {
  setReviewSchedule: async (_: unknown, { taskRef, slots }: { taskRef: string; slots: string[] }, ctx: Context) => {
    const task = await mutateTask(ctx, taskRef, async (tx, row, actor, app, c) => {
      await ownerChain(tx, c, app, actor, row, true);
      const values = scheduleValue(slots);
      await record(tx, c, row, { type: 'review.scheduled', slots: values }, { 'review.schedule': values });
    }, { taskGraph: 'exclusive' });
    return { task, action: await action(ctx, task.appId, 'review.scheduled') };
  },
  freezePullRequestHead: async (_: unknown, { taskRef, head: raw }: { taskRef: string; head: string }, ctx: Context) => {
    const task = await mutateTask(ctx, taskRef, async (tx, row, actor, _app, c) => {
      assignee(actor, row); const head = headValue(raw);
      const pr = storedTaskReferences(row.references).find(r => r.kind === 'pull_request');
      if (!pr) throw taskError('PR_REFERENCE_MISSING', 'The build task needs a pull_request reference.');
      await record(tx, c, row, { type: 'pr.frozen', head, pullRequest: pr.target }, { 'pr.head': head });
    }, { taskGraph: 'exclusive' });
    return { task, action: await action(ctx, task.appId, 'pr.frozen') };
  },
  assignReviewSeat: async (_: unknown, args: { taskRef: string; slot: string; head: string; supersedes?: string | null }, ctx: Context) => {
    const task = await mutateTask(ctx, args.taskRef, async (tx, row, actor, app, c) => {
      await ownerChain(tx, c, app, actor, row);
      if (!row.parentTaskId) throw taskError('REVIEW_SEAT_UNASSIGNED', 'A seat must be a child of the build task.');
      await tx.$queryRaw`SELECT id FROM agent_tasks WHERE id = ${row.parentTaskId} AND app_id = ${app.id} FOR UPDATE`;
      if (!await tx.agentTask.count({ where: { id: row.parentTaskId, appId: app.id } })) throw taskError('TASK_NOT_FOUND', 'Build task not found.');
      const head = headValue(args.head), slot = slotValue(args.slot);
      const buildEvents = await taskEvents(tx, [row.parentTaskId]);
      frozen(buildEvents, row.parentTaskId, head, 'REVIEW_HEAD_MISMATCH');
      if (!scheduled(buildEvents, row.parentTaskId).includes(slot)) throw taskError('REVIEW_SLOT_UNKNOWN', 'The slot is not scheduled.');
      const siblings = await tx.agentTask.findMany({ where: { appId: app.id, parentTaskId: row.parentTaskId }, select: { id: true } });
      const history = await taskEvents(tx, siblings.map(s => s.id));
      const previous = data(latest(history, 'review.seat.assigned', row.id));
      // Xanthos #75789: moving the negative seat is the same replacement, not a way around it.
      if (previous.head === head && previous.slot !== slot && await negativeAtHead(tx, row.id, head)) {
        throw taskError('REVIEW_SEAT_NOT_SUPERSEDABLE', 'A negative seat cannot move slots at the same frozen head.');
      }
      const current = currentAssignment(history, slot);
      // An implicit replacement (no supersedes pointer) must obey the identical negative-seat gate.
      if (current?.taskId && current.taskId !== row.id && data(current).head === head && await negativeAtHead(tx, current.taskId, head)) {
        throw taskError('REVIEW_SEAT_NOT_SUPERSEDABLE', 'A negative current seat cannot be replaced at the same frozen head.');
      }
      if (typeof previous.slot === 'string') throw taskError('REVIEW_SEAT_ALREADY_ASSIGNED', 'Each seat task is assigned once; use a new seat task.');
      if (current && args.supersedes !== current.taskId) {
        // Resolve handle spellings below too, without letting an omitted pointer replace a current seat.
        const id = args.supersedes == null ? null : await resolveTaskRef(c, args.supersedes, app.id);
        if (id !== current.taskId) throw taskError('REVIEW_SEAT_SUPERSEDES_REQUIRED', 'Name the current seat in supersedes.');
      }
      let supersedes: string | null = null;
      if (args.supersedes != null) {
        supersedes = await resolveTaskRef(c, args.supersedes, app.id);
        const sibling = supersedes ? await tx.agentTask.findFirst({ where: { id: supersedes, appId: app.id, parentTaskId: row.parentTaskId } }) : null;
        if (!sibling || sibling.id === row.id || data(latest(history, 'review.seat.assigned', sibling.id)).slot !== slot || current?.taskId !== sibling.id) throw taskError('REVIEW_SEAT_SUPERSEDE_INVALID', 'supersedes must name the current sibling seat for this slot.');
        if (await negativeAtHead(tx, sibling.id, head)) throw taskError('REVIEW_SEAT_NOT_SUPERSEDABLE', 'A negative verdict cannot be superseded at the same frozen head.');
      }
      await record(tx, c, row, { type: 'review.seat.assigned', slot, head, supersedes }, { 'review.slot': slot, 'review.head': head, 'review.supersedes': supersedes });
    }, { taskGraph: 'exclusive' });
    return { task, action: await action(ctx, task.appId, 'review.seat.assigned') };
  },
  recordReviewVerdict: async (_: unknown, args: { taskRef: string; head: string; verdict: ReviewVerdict; node?: string | null; receipt?: string | null }, ctx: Context) => {
    const task = await mutateTask(ctx, args.taskRef, async (tx, row, actor, _app, c) => {
      assignee(actor, row);
      if (row.status !== 'started') throw taskError('TASK_INVALID_TRANSITION', 'A verdict is recorded only on a STARTED seat.');
      const assigned = data(latest(await taskEvents(tx, [row.id]), 'review.seat.assigned', row.id));
      if (typeof assigned.slot !== 'string') throw taskError('REVIEW_SEAT_UNASSIGNED', 'The task has no assigned review seat.');
      const head = headValue(args.head);
      if (head !== assigned.head) throw taskError('REVIEW_HEAD_MISMATCH', 'The verdict head differs from the assigned head.');
      if (!(REVIEW_VERDICTS as readonly string[]).includes(args.verdict)) throw badInput('Unknown review verdict.');
      const node = optionalMetadata(args.node, 'node'), receipt = optionalMetadata(args.receipt, 'receipt');
      await record(tx, c, row, { type: 'review.verdict', slot: assigned.slot, head, verdict: args.verdict, node, receipt }, { 'review.verdict': args.verdict, 'review.node': node, 'review.receipt': receipt });
    }, { taskGraph: 'exclusive' });
    return { task, action: await action(ctx, task.appId, 'review.verdict') };
  },
  recordReadyCall: async (_: unknown, { taskRef, head: raw }: { taskRef: string; head: string }, ctx: Context) => {
    const task = await mutateTask(ctx, taskRef, async (tx, row, actor, _app, c) => {
      assignee(actor, row); const head = headValue(raw);
      const readiness = await readinessInTx(tx, row.id, row.appId, head);
      if (!readiness.ready) throw taskError('PR_NOT_READY', 'The current seats do not serve this frozen head.', { slots: readiness.slots.filter(s => !s.counts) });
      await record(tx, c, row, { type: 'pr.ready', head }, { 'pr.ready': true });
    }, { taskGraph: 'exclusive' });
    return { task, action: await action(ctx, task.appId, 'pr.ready') };
  },
};
