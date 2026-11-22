/**
 * #3448 (cor:agt:050:28, cor:agt:110:01/:03): validated PR protocol facts.
 * Commands append typed events and mirror properties atomically; readiness NEVER reads a property.
 * All writes use the ordinary task authority transaction, with the App task graph exclusive BEFORE
 * any task row. This serializes protocol changes with one another and with existing task lifecycle
 * writes. Reads hold the graph shared and the contributing task rows shared for one coherent answer.
 */
import { Prisma } from '../../../generated/prisma/index.js';
import type { Context } from './resolvers.helpers.js';
import { mutateTask, mayDirectTask, isAssignee, notAssignee, refuseEnded, SEAT_RECEIPT_REMEDY, withReadableTask, resolveTaskRef, taskError, taskNotFound, actorManagesApp, recordInstructedManagerAct, type TaskRow, type TaskActor, type TaskApp } from './resolvers.agentTask.js';
import type { ActInstruction } from '../../../lib/auth/instructedAct.js';
import { appKeyCaller } from '../../../lib/appKeyScopes/scopes.js';
import { isRunPrincipal } from '../../../lib/auth/runPrincipal.js';
import { workerHasRole } from '../../../lib/agentTasks/workerRole.js';
import { appendTaskEvent, eventActor } from '../../../lib/agentTasks/events.js';
import { PR_EVENT_TYPES, REVIEW_VERDICTS, type ReviewVerdict, type PrProtocolEvent } from '../../../lib/agentTasks/prProtocol.js';
import { normalizeTaskReferences, storedTaskReferences, TaskReferenceError } from '../../../lib/agentTasks/references.js';
import { checkAgainstTeamSchema, normalizeTaskProperties, propertiesFingerprint } from '../../../lib/agentTasks/properties.js';
import { lockTaskGraph } from '../../../lib/agentTasks/blockers.js';
import { currentActor } from '../../../lib/requestActor.js';
import { resolveActionAnswer } from '../../../lib/actionRegister/answer.js';
import type { PublicTickAction } from '../../../lib/tickers/tickActions.js';

const RECEIPT_IF_UNBINDABLE = 'post the verdict as a signed PR receipt at the exact head, which is then the record.';
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
  // #4202 (cor:agt:050:01, :21): `agent_team_events.task_id` has no foreign key, so an event of another App can name
  // one of these tasks. Only an event of the task's OWN App is one of its protocol facts (the join).
  const rows = await tx.$queryRaw<Event[]>`SELECT DISTINCT ON (e.task_id, e.type)
    e.id, e.task_id AS "taskId", e.type, e.payload, e.actor_worker_id AS "actorWorkerId", e.actor_user_id AS "actorUserId", e.created_at AS "createdAt"
    FROM agent_team_events e
    JOIN agent_tasks t ON t.id = e.task_id AND t.app_id = e.app_id
    WHERE e.task_id IN (${Prisma.join(ids)}) AND e.type IN (${Prisma.join([...PR_EVENT_TYPES])})
    ORDER BY e.task_id, e.type, e.created_at DESC, e.id DESC`;
  return rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id));
}
function frozen(events: Event[], taskId: string, head: string, code = 'PR_HEAD_NOT_FROZEN', remedy = ''): string {
  const value = data(latest(events, 'pr.frozen', taskId)).head;
  if (value !== head) throw taskError(code, `This is not the build task's frozen head.${remedy ? ` ${remedy}` : ''}`);
  return value as string;
}
function scheduled(events: Event[], taskId: string): string[] {
  const slots = data(latest(events, 'review.scheduled', taskId)).slots;
  if (!Array.isArray(slots) || !slots.length || !slots.every(validSlot)) throw taskError('REVIEW_SCHEDULE_MISSING', 'The build task has no review schedule.');
  return slots as string[];
}
/** #4202: the task's latest verdict at `head`, among the events of the task's OWN App (`appId`); another App's row naming the task is not its verdict. */
const verdictAtHead = (tx: Prisma.TransactionClient, appId: string, taskId: string, head: string) =>
  tx.agentTeamEvent.findFirst({ where: { appId, taskId, type: 'review.verdict', payload: { path: ['head'], equals: head } }, orderBy: [...newest] });
const NEGATIVE_VERDICTS = ['CHANGES_REQUESTED', 'FAIL', 'REFUSED'] as const;
const isNegative = (verdict: unknown) => (NEGATIVE_VERDICTS as readonly string[]).includes(String(verdict));
/** #4441: whether this verdict event was withdrawn (review.verdict.withdrawn naming it, in the task's own App). */
const withdrawalOf = (tx: Prisma.TransactionClient, appId: string, taskId: string, verdictEventId: string) =>
  tx.agentTeamEvent.findFirst({ where: { appId, taskId, type: 'review.verdict.withdrawn', payload: { path: ['verdictEventId'], equals: verdictEventId } }, orderBy: [...newest], select: { id: true } });
/** The task's latest verdict at `head` is negative and was not withdrawn (#4441): the one predicate every negative-seat guard reads. */
async function negativeAtHead(tx: Prisma.TransactionClient, appId: string, taskId: string, head: string): Promise<boolean> {
  const prior = await verdictAtHead(tx, appId, taskId, head);
  return !!prior && isNegative(data(prior).verdict) && !await withdrawalOf(tx, appId, taskId, prior.id);
}
function sameEventActor(event: Pick<Event, 'actorWorkerId' | 'actorUserId'>, actor: { workerId: string | null; userId: string | null }): boolean {
  return event.actorWorkerId ? event.actorWorkerId === actor.workerId
    : !actor.workerId && !!event.actorUserId && event.actorUserId === actor.userId;
}

/** Who froze this exact head anywhere in the App. A named function so a test can EXPLAIN the very statement the gate runs (#3473). */
export function freezersAtHeadSql(appId: string, head: string): Prisma.Sql {
  return Prisma.sql`SELECT DISTINCT
    actor_worker_id AS "workerId", CASE WHEN actor_worker_id IS NULL THEN actor_user_id ELSE NULL END AS "userId"
    FROM agent_team_events WHERE app_id = ${appId}
      AND type = 'pr.frozen' AND payload->>'head' = ${head}`;
}

/** Caller holds the App graph lock: include superseded seats and dropped slots, not just the current schedule. */
async function negativeHead(tx: Prisma.TransactionClient, build: Pick<TaskRow, 'id' | 'appId'>, head: string): Promise<boolean> {
  const [answer] = await tx.$queryRaw<{ blocked: boolean }[]>`SELECT EXISTS (
    SELECT 1 FROM (
      SELECT DISTINCT ON (e.task_id) e.id, e.task_id, e.payload FROM agent_team_events e
      JOIN agent_tasks t ON t.id = e.task_id AND t.app_id = ${build.appId} AND t.parent_task_id = ${build.id}
      WHERE e.app_id = ${build.appId} AND e.type = 'review.verdict' AND e.payload->>'head' = ${head}
      ORDER BY e.task_id, e.created_at DESC, e.id DESC
    ) latest WHERE latest.payload->>'verdict' IN (${Prisma.join([...NEGATIVE_VERDICTS])})
      -- #4441: a negative withdrawn by its holder or the coordinator no longer blocks the head.
      AND NOT EXISTS (SELECT 1 FROM agent_team_events w
        WHERE w.app_id = ${build.appId} AND w.task_id = latest.task_id AND w.type = 'review.verdict.withdrawn'
          AND w.payload->>'verdictEventId' = latest.id)
  ) AS blocked`;
  return answer.blocked;
}
async function refuseNegativeHead(tx: Prisma.TransactionClient, build: TaskRow, head: string): Promise<void> {
  if (await negativeHead(tx, build, head)) throw taskError('REVIEW_SEAT_NOT_SUPERSEDABLE', 'A head with a negative seat verdict cannot be frozen again; answer the finding with a new head.');
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
  if (!isAssignee(actor, task)) throw notAssignee(actor, 'Only the task\'s assignee performs this command.');
}

/**
 * #4235 S12a (cor:agt:130:02): which model reviewed, copied from the session the reviewing WORKER records through. The
 * request's own bound session when it is an open session of that worker, else the worker's binding (its newest open
 * session, the matcher's ordering). The values are the session's self-report (`family`, `llmModel`,
 * `modelReportedAt`), never an argument of the verdict call, and null wherever nothing is recorded: a person (no
 * worker session), no open session, or a null column. Never derived, never 'unknown'. Readiness does not read them.
 */
async function reviewerModelSnapshot(tx: Prisma.TransactionClient, actor: TaskActor, sessionId: string | undefined) {
  const none = { reviewerFamily: null, reviewerModel: null, modelReportedAt: null };
  if (actor.kind !== 'worker') return none;
  const where = { workerId: actor.workerId, endedAt: null, deletedAt: null };
  const select = { family: true, llmModel: true, modelReportedAt: true } as const;
  const session = (sessionId ? await tx.session.findFirst({ where: { ...where, id: sessionId }, select }) : null)
    ?? await tx.session.findFirst({ where, orderBy: [{ startedAt: 'desc' }, { id: 'desc' }], select });
  if (!session) return none;
  return { reviewerFamily: session.family || null, reviewerModel: session.llmModel || null, modelReportedAt: session.modelReportedAt?.toISOString() ?? null };
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
  const from = task.properties === null ? null : propertiesFingerprint(task.properties);
  const to = propertiesFingerprint(properties);
  if (from === null || from.sha256 !== to.sha256 || from.bytes !== to.bytes) {
    await appendTaskEvent(tx, { appId: task.appId, taskId: task.id, actor: eventActor(c.userId),
      event: { type: 'task.properties-changed', from, to } });
  }
}

/**
 * Optional guidance is resolved after commit. Failure never turns an accepted command into a refusal.
 * #3470 (rulings 0163, 0164; cor:agt:110:03): the same whole-chain gate and fault state as every other
 * action answer, so this delegates to the shared producer instead of keeping a node-by-node reading.
 * No Agent means no register answer (never the Team Agent for a person; #3448 gate clarification 76106).
 */
async function action(ctx: Context, appId: string, code: string): Promise<PublicTickAction> {
  const answer = await resolveActionAnswer(ctx, appId, code, currentActor().agentId);
  return { code: answer.code, state: answer.state, ...(answer.taskLoc ? { taskLoc: answer.taskLoc } : {}), ...(answer.taskUrn ? { taskUrn: answer.taskUrn } : {}) };
}

type SlotAnswer = { slot: string; currentTaskId: string | null; state: string; verdict: string | null; head: string | null; counts: boolean };
type Readiness = { ready: boolean; head: string; slots: SlotAnswer[] };

/** Caller holds the App graph (shared for a read, exclusive for a ready call), before these rows. */
async function readinessInTx(tx: Prisma.TransactionClient, buildId: string, appId: string, head: string): Promise<Readiness> {
  await tx.$queryRaw`SELECT id FROM agent_tasks WHERE app_id = ${appId} AND (id = ${buildId} OR parent_task_id = ${buildId}) ORDER BY id FOR SHARE`;
  const tasks = await tx.agentTask.findMany({ where: { appId, OR: [{ id: buildId }, { parentTaskId: buildId }] },
    select: { id: true, status: true, assigneeWorkerId: true, assigneeUserId: true } });
  const build = tasks.find(t => t.id === buildId);
  if (!build) throw taskError('TASK_NOT_FOUND', 'Task not found.');
  const events = await taskEvents(tx, tasks.map(t => t.id));
  frozen(events, buildId, head);
  // Every actor who froze this exact head anywhere in this App is excluded,
  // even on a sibling build or after another actor re-freezes it.
  const freezers = await tx.$queryRaw<{ workerId: string | null; userId: string | null }[]>(freezersAtHeadSql(appId, head));
  // The same predicate as freeze: even an unscheduled/superseded child's newest
  // negative at H blocks this head. Positive counting still uses the scheduled slots.
  const blockedHead = await negativeHead(tx, { id: buildId, appId }, head);
  const slots = scheduled(events, buildId);
  const childEvents = events.filter(e => e.taskId !== buildId);
  const answers = slots.map((slot): SlotAnswer => {
    const assignment = currentAssignment(childEvents, slot);
    const task = assignment ? tasks.find(t => t.id === assignment.taskId) : null;
    const verdict = task ? latest(events, 'review.verdict', task.id) : undefined;
    const payload = data(verdict);
    // Actor identity is the same worker/person distinction as the task writer gate, not the holder's credential.
    const ownVerdict = !!verdict && (sameEventActor(verdict, { workerId: build.assigneeWorkerId, userId: build.assigneeUserId })
      || freezers.some(actor => sameEventActor(verdict, actor)));
    const counts = !!task && task.status === 'finished' && data(assignment).head === head && payload.head === head
      && payload.slot === slot && ['APPROVE', 'PASS', 'CARRY'].includes(String(payload.verdict)) && !ownVerdict && !blockedHead;
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

/** #4280 (Proposed, Peter's ruling on the issue): the worker roles that may link a defect, by the CURRENT Worker.role. */
export const DEFECT_LINK_ROLES = ['qa-engineer', 'coordinator'] as const;
const defectLinkForbidden = () => taskError('DEFECT_LINK_FORBIDDEN',
  'Only a QA engineer or coordinator worker, or whoever manages the App, may link a defect to a pull request. Nothing was written.');

type DefectLinkEvent = Pick<Event, 'id' | 'taskId' | 'payload' | 'createdAt'>;
const defectLink = (e: DefectLinkEvent, created: boolean) => {
  const p = data(e as Event);
  return { taskId: e.taskId, defect: p.defect, introducedAtHead: p.introducedAtHead ?? null, eventId: e.id, linkedAt: e.createdAt, created };
};

/** #4280: the issue URL, with exactly the rules a task reference of kind `issue` passes; stored as given. */
function defectValue(raw: unknown): string {
  try {
    return normalizeTaskReferences([{ kind: 'issue', target: raw }])[0]!.target;
  } catch (e) {
    if (e instanceof TaskReferenceError) throw badInput(e.message.replace(/^Reference 1/, 'defectRef'));
    throw e;
  }
}

export const prProtocolMutations = {
  setReviewSchedule: async (_: unknown, { taskRef, slots }: { taskRef: string; slots: string[] }, ctx: Context) => {
    const task = await mutateTask(ctx, taskRef, async (tx, row, actor, app, c) => {
      await ownerChain(tx, c, app, actor, row, true);
      refuseEnded(row);
      const values = scheduleValue(slots);
      const prior = await taskEvents(tx, [row.id]);
      const head = data(latest(prior, 'pr.frozen', row.id)).head;
      if (typeof head === 'string') {
        const children = await tx.agentTask.findMany({ where: { appId: row.appId, parentTaskId: row.id }, select: { id: true } });
        const history = await taskEvents(tx, children.map(t => t.id));
        const oldSlots = latest(prior, 'review.scheduled', row.id) ? scheduled(prior, row.id) : [];
        for (const slot of oldSlots.filter(slot => !values.includes(slot))) {
          const current = currentAssignment(history, slot);
          if (current?.taskId && await negativeAtHead(tx, row.appId, current.taskId, head)) {
            throw taskError('REVIEW_SEAT_NOT_SUPERSEDABLE', 'A schedule cannot drop a slot with a negative verdict at the frozen head.');
          }
        }
      }
      await record(tx, c, row, { type: 'review.scheduled', slots: values }, { 'review.schedule': values });
    }, { taskGraph: 'exclusive' });
    return { task, action: await action(ctx, task.appId, 'review.scheduled') };
  },
  /**
   * #4280 (S12b of #4229): record that a defect found after the PR merged traces back to it.
   * One `review.defect-linked` event on the PR's build task, and nothing else: no property, verdict, seat, readiness or
   * row field changes. One link per (defect, task): a second call returns the first link (`created: false`).
   */
  linkDefectToPullRequest: async (_: unknown, args: { defectRef: string; prTaskRef: string; introducedAtHead?: string | null; instruction?: ActInstruction | null }, ctx: Context) => {
    const defect = defectValue(args.defectRef);
    const head = args.introducedAtHead == null ? null : headValue(args.introducedAtHead);
    // The App's key and a run never link (rule 1), even a run a manager started: one that may read the task is refused
    // DEFECT_LINK_FORBIDDEN, one that may not is answered as for a task that does not exist (cor:agt:050:21).
    if (isRunPrincipal(ctx) || appKeyCaller(ctx)) {
      const readable = await withReadableTask(ctx, args.prTaskRef, async () => true, true);
      throw readable ? defectLinkForbidden() : taskNotFound(args.prTaskRef);
    }
    let out: ReturnType<typeof defectLink> | undefined;
    // mutateTask answers a caller who may not read the App's tasks as for a task that does not exist.
    await mutateTask(ctx, args.prTaskRef, async (tx, row, actor, app, c) => {
      const allowed = (actor.kind === 'worker' && await workerHasRole(tx, actor.workerId, app.id, DEFECT_LINK_ROLES))
        || await actorManagesApp(c, app, actor, actor.instructed);
      if (!allowed) throw defectLinkForbidden();
      if (!storedTaskReferences(row.references).some((r) => r.kind === 'pull_request')) {
        throw taskError('PR_REFERENCE_MISSING', 'A defect links to a build task with a pull_request reference.');
      }
      if (head !== null && !await tx.agentTeamEvent.count({ where: { appId: app.id, taskId: row.id, type: 'pr.frozen', payload: { path: ['head'], equals: head } } })) {
        throw taskError('DEFECT_HEAD_NOT_FROZEN', 'introducedAtHead must be a head frozen on this pull request. Nothing was written.');
      }
      // Under the task's row lock (mutateTask), so two links of one pair cannot both write.
      const linked = (where: Prisma.AgentTeamEventWhereInput) => tx.agentTeamEvent.findFirst({
        where: { appId: app.id, taskId: row.id, type: 'review.defect-linked', payload: { path: ['defect'], equals: defect }, ...where },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true, taskId: true, payload: true, createdAt: true },
      });
      const existing = await linked({});
      if (existing) { out = defectLink(existing, false); return; }
      await appendTaskEvent(tx, { appId: app.id, taskId: row.id, actor: eventActor(c.userId), event: { type: 'review.defect-linked', defect, introducedAtHead: head } });
      out = defectLink((await linked({}))!, true);
      await recordInstructedManagerAct(tx, app.id, actor, 'review.defect-link', { taskId: row.id });
    }, {}, args.instruction ?? null);
    return out!;
  },
  freezePullRequestHead: async (_: unknown, { taskRef, head: raw }: { taskRef: string; head: string }, ctx: Context) => {
    const task = await mutateTask(ctx, taskRef, async (tx, row, actor, _app, c) => {
      assignee(actor, row); refuseEnded(row); const head = headValue(raw);
      await refuseNegativeHead(tx, row, head);
      const pr = storedTaskReferences(row.references).find(r => r.kind === 'pull_request');
      if (!pr) throw taskError('PR_REFERENCE_MISSING', 'The build task needs a pull_request reference.');
      await record(tx, c, row, { type: 'pr.frozen', head, pullRequest: pr.target }, { 'pr.head': head });
    }, { taskGraph: 'exclusive' });
    return { task, action: await action(ctx, task.appId, 'pr.frozen') };
  },
  assignReviewSeat: async (_: unknown, args: { taskRef: string; slot: string; head: string; supersedes?: string | null }, ctx: Context) => {
    const task = await mutateTask(ctx, args.taskRef, async (tx, row, actor, app, c) => {
      await ownerChain(tx, c, app, actor, row);
      refuseEnded(row, `A seat binds only while its task is live. ${SEAT_RECEIPT_REMEDY}`);
      if (!row.parentTaskId) throw taskError('REVIEW_SEAT_UNASSIGNED', `A seat must be a child of the build task. ${SEAT_RECEIPT_REMEDY}`);
      await tx.$queryRaw`SELECT id FROM agent_tasks WHERE id = ${row.parentTaskId} AND app_id = ${app.id} FOR UPDATE`;
      if (!await tx.agentTask.count({ where: { id: row.parentTaskId, appId: app.id } })) throw taskError('TASK_NOT_FOUND', 'Build task not found.');
      const head = headValue(args.head), slot = slotValue(args.slot);
      const buildEvents = await taskEvents(tx, [row.parentTaskId]);
      frozen(buildEvents, row.parentTaskId, head, 'REVIEW_HEAD_MISMATCH', `Bind at the build task's frozen head (pr freeze records it). If the seat truly cannot bind, ${RECEIPT_IF_UNBINDABLE}`);
      if (!scheduled(buildEvents, row.parentTaskId).includes(slot)) throw taskError('REVIEW_SLOT_UNKNOWN', 'The slot is not scheduled.');
      const siblings = await tx.agentTask.findMany({ where: { appId: app.id, parentTaskId: row.parentTaskId }, select: { id: true } });
      const history = await taskEvents(tx, siblings.map(s => s.id));
      const previous = data(latest(history, 'review.seat.assigned', row.id));
      // Xanthos #75789: moving the negative seat is the same replacement, not a way around it.
      if (previous.head === head && previous.slot !== slot && await negativeAtHead(tx, app.id, row.id, head)) {
        throw taskError('REVIEW_SEAT_NOT_SUPERSEDABLE', 'A negative seat cannot move slots at the same frozen head.');
      }
      const current = currentAssignment(history, slot);
      // An implicit replacement (no supersedes pointer) must obey the identical negative-seat gate.
      if (current?.taskId && current.taskId !== row.id && data(current).head === head && await negativeAtHead(tx, app.id, current.taskId, head)) {
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
        if (await negativeAtHead(tx, app.id, sibling.id, head)) throw taskError('REVIEW_SEAT_NOT_SUPERSEDABLE', 'A negative verdict cannot be superseded at the same frozen head.');
      }
      await record(tx, c, row, { type: 'review.seat.assigned', slot, head, supersedes }, { 'review.slot': slot, 'review.head': head, 'review.supersedes': supersedes });
    }, { taskGraph: 'exclusive' });
    return { task, action: await action(ctx, task.appId, 'review.seat.assigned') };
  },
  recordReviewVerdict: async (_: unknown, args: { taskRef: string; head: string; verdict: ReviewVerdict; node?: string | null; receipt?: string | null }, ctx: Context) => {
    const task = await mutateTask(ctx, args.taskRef, async (tx, row, actor, _app, c) => {
      assignee(actor, row);
      refuseEnded(row, `A verdict is recorded only on a live seat. ${SEAT_RECEIPT_REMEDY}`);
      if (row.status !== 'started') throw taskError('TASK_INVALID_TRANSITION', 'A verdict is recorded only on a STARTED seat.');
      const assigned = data(latest(await taskEvents(tx, [row.id]), 'review.seat.assigned', row.id));
      if (typeof assigned.slot !== 'string') throw taskError('REVIEW_SEAT_UNASSIGNED', `The task has no assigned review seat: it was never bound with pr seat. ${SEAT_RECEIPT_REMEDY}`);
      const head = headValue(args.head);
      if (head !== assigned.head) throw taskError('REVIEW_HEAD_MISMATCH', `The verdict head differs from the assigned head. Record at the head the seat was bound to. If the seat truly cannot record, ${RECEIPT_IF_UNBINDABLE}`);
      const prior = await verdictAtHead(tx, row.appId, row.id, head);
      // #4441: no withdrawal check here, on purpose: a withdrawal needs a FINISHED seat and a verdict needs a live one,
      // so a seat that can take a verdict can never hold a withdrawn negative. A path that reopens a seat must revisit this.
      if (prior && isNegative(data(prior).verdict)
        && !sameEventActor(prior, { workerId: currentActor().workerId, userId: c.userId ?? null })) {
        throw taskError('REVIEW_SEAT_NOT_SUPERSEDABLE', 'Only the actor who recorded a negative verdict may re-rate it at the same head.');
      }
      if (!(REVIEW_VERDICTS as readonly string[]).includes(args.verdict)) throw badInput('Unknown review verdict.');
      const node = optionalMetadata(args.node, 'node'), receipt = optionalMetadata(args.receipt, 'receipt');
      const reviewer = await reviewerModelSnapshot(tx, actor, c.sessionId);
      await record(tx, c, row, { type: 'review.verdict', slot: assigned.slot, head, verdict: args.verdict, node, receipt, ...reviewer }, { 'review.verdict': args.verdict, 'review.node': node, 'review.receipt': receipt });
    }, { taskGraph: 'exclusive' });
    return { task, action: await action(ctx, task.appId, 'review.verdict') };
  },
  /**
   * #4441 (Holger's ruling, team chat #138478, "WITHDRAW VERB"): withdraw a FINISHED seat's negative verdict at the head
   * it was recorded at. Who: the actor who recorded that verdict (the seat holder), or the coordinator: a worker whose
   * current role is coordinator in the App, or whoever manages the App (with an instruction for a worker whose holder
   * does). A caller who may not read the App's tasks is answered as for a task that does not exist. One
   * review.verdict.withdrawn event on the seat task, naming the verdict event; the verdict event and the finished task row
   * are not changed. Afterwards every negative-seat guard reads the verdict as not negative, so the slot can be
   * superseded at the same head, but it counts only through a positive verdict. TASK_ENDED still forbids re-recording on
   * the finished seat.
   */
  withdrawReviewVerdict: async (_: unknown, args: { taskRef: string; head: string; receipt?: string | null; instruction?: ActInstruction | null }, ctx: Context) => {
    const task = await mutateTask(ctx, args.taskRef, async (tx, row, actor, app, c) => {
      const head = headValue(args.head);
      const receipt = optionalMetadata(args.receipt, 'receipt');
      const assigned = data(latest(await taskEvents(tx, [row.id]), 'review.seat.assigned', row.id));
      if (typeof assigned.slot !== 'string') throw taskError('REVIEW_SEAT_UNASSIGNED', 'The task has no assigned review seat; only a bound seat\'s verdict can be withdrawn.');
      if (row.status !== 'finished') throw taskError('TASK_INVALID_TRANSITION', 'A verdict is withdrawn only on a FINISHED seat; while the seat is STARTED its holder re-rates it.');
      if (head !== assigned.head) throw taskError('REVIEW_HEAD_MISMATCH', 'Withdraw at the head the seat was bound to.');
      const prior = await verdictAtHead(tx, app.id, row.id, head);
      if (!prior || !isNegative(data(prior).verdict)) throw taskError('REVIEW_VERDICT_NOT_NEGATIVE', 'Only a CHANGES_REQUESTED, FAIL or REFUSED verdict can be withdrawn.');
      if (await withdrawalOf(tx, app.id, row.id, prior.id)) throw taskError('REVIEW_VERDICT_ALREADY_WITHDRAWN', 'This verdict is already withdrawn.');
      const holder = sameEventActor(prior, { workerId: currentActor().workerId, userId: c.userId ?? null });
      const coordinator = !holder && actor.kind === 'worker' && await workerHasRole(tx, actor.workerId, app.id, ['coordinator']);
      const manager = !holder && !coordinator && await actorManagesApp(c, app, actor, actor.instructed);
      if (!holder && !coordinator && !manager) {
        throw taskError('REVIEW_WITHDRAW_FORBIDDEN', 'Only the reviewer who recorded the negative verdict, a coordinator worker, or whoever manages the App (a worker whose holder does, with an instruction) withdraws it. Nothing was written.');
      }
      await appendTaskEvent(tx, { appId: app.id, taskId: row.id, actor: eventActor(c.userId), event: {
        type: 'review.verdict.withdrawn', slot: assigned.slot, head, verdictEventId: prior.id, verdict: data(prior).verdict as ReviewVerdict, receipt,
      } });
      if (manager) await recordInstructedManagerAct(tx, app.id, actor, 'review.verdict-withdraw', { taskId: row.id });
    }, { taskGraph: 'exclusive' }, args.instruction ?? null);
    return { task, action: await action(ctx, task.appId, 'review.verdict.withdrawn') };
  },
  recordReadyCall: async (_: unknown, { taskRef, head: raw }: { taskRef: string; head: string }, ctx: Context) => {
    const task = await mutateTask(ctx, taskRef, async (tx, row, actor, _app, c) => {
      assignee(actor, row); refuseEnded(row); const head = headValue(raw);
      const readiness = await readinessInTx(tx, row.id, row.appId, head);
      if (!readiness.ready) throw taskError('PR_NOT_READY', 'The current seats do not serve this frozen head.', { slots: readiness.slots.filter(s => !s.counts) });
      await record(tx, c, row, { type: 'pr.ready', head }, { 'pr.ready': true });
    }, { taskGraph: 'exclusive' });
    return { task, action: await action(ctx, task.appId, 'pr.ready') };
  },
};
