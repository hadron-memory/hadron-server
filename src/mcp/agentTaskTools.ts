import { taskListDateTime } from '../lib/agentTasks/listDateTime.js';
import { mcpRequestSessionContext } from './requestSession.js';
/**
 * #1705 — agent tasks on the MCP surface (cor:agt:050): create, assign,
 * reassign, start, record progress, finish and cancel a task, read one or a
 * list, and read the App's team event stream. #1706 adds acknowledging an
 * alarm and availability for work (cor:agt:050:20, cor:agt:060). #1707 adds
 * the team roster (plan design:agent-tasks §7.4).
 *
 * Every tool is a thin call into the SAME resolvers GraphQL serves
 * (`resolvers.agentTask.ts`): the actor, the participation gate, the
 * owner / assignee / App-manager rules, the refusal codes and the event writes
 * are computed once, so the two surfaces cannot drift.
 *
 * WHO ACTS. Every WRITE tool requires `session` and refuses without it, never
 * inferring one (the #1697 / #1701 lessons; plan design:agent-tasks §7.2): a
 * worker passes its worker session and acts as the worker; a person passes a
 * plain session (one bound to no worker) and acts as themselves. The
 * caller-session gate in createMcpServerInstance validates the argument and
 * publishes its actor for this call only; a session it could not validate is
 * refused here. Reads take an optional `session` for the same purpose: a
 * worker on an App key reads as itself through it.
 */
import { renderCheckStatusShort } from '../lib/workerCheckStatus.js';
import { z } from 'zod';
import { GraphQLError } from 'graphql';
import { publicErrorExtensions } from '../lib/errorDiagnostics.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { agentTaskFieldResolvers, taskError } from '../api/graphql/schema/resolvers.agentTask.js';
import { flushTaskWarningHistory, renderTaskWarnings } from '../api/graphql/schema/resolvers.taskWarnings.js';
import { agentTaskAlarmFieldResolvers } from '../api/graphql/schema/resolvers.agentTaskAlarms.js';
import { type AuthContext, validateSessionBinding } from '../middleware/auth.js';
import { runAsActor } from '../lib/requestActor.js';
import { UrnNotQualifiedError } from '../lib/urn.js';
import type { PrismaClient } from '../generated/prisma/index.js';
import { isTrustedRefusal } from '../api/graphql/formatError.js';

type TaskRow = Record<string, any> & { id: string; status: string };
type EventRow = Record<string, any> & { id: string; type: string; createdAt: Date };
type Party = { kind: 'WORKER' | 'USER'; id: string; name: string | null; urn: string | null } | null;

type Resolver<A, R> = (parent: unknown, args: A, ctx: Context) => Promise<R>;
const Q = resolvers.Query as unknown as {
  agentTask: Resolver<{ id: string }, TaskRow | null>;
  agentTasks: Resolver<Record<string, unknown>, TaskRow[]>;
  agentTaskTree: Resolver<{ root: string }, TaskRow[] | null>;
  agentTeamEvents: Resolver<Record<string, unknown>, EventRow[]>;
};
const M = resolvers.Mutation as unknown as Record<string, Resolver<Record<string, unknown>, TaskRow>>;
const MA = resolvers.Mutation as unknown as {
  acknowledgeAlarm: Resolver<{ eventId: string }, EventRow>;
  setWorkerAvailability: Resolver<{ input: Record<string, unknown> }, AvailabilityRow>;
  setModelFamilyAvailability: Resolver<{ input: Record<string, unknown> }, AvailabilityRow>;
  setAgentTaskStallSchedule: Resolver<{ appRef: string; input: Record<string, unknown> }, StallScheduleView>;
};
const QA = resolvers.Query as unknown as {
  teamAvailability: Resolver<{ appRef: string }, { workers: AvailabilityRow[]; families: AvailabilityRow[] }>;
  teamRoster: Resolver<{ appRef: string }, { appId: string; asOf: Date; workers: RosterRow[] }>;
  agentTaskStallSchedule: Resolver<{ appRef: string }, StallScheduleView>;
};
type StallScheduleView = Record<StallScheduleKey, number> & { updatedAt: Date | null };
type RosterRow = Omit<import('../lib/agentTasks/roster.js').RosterEntry, 'teamPlacement'> & {
  teamPlacement: import('../lib/agentTasks/roster.js').RosterEntry['teamPlacement'] | null;
  appUrn: string;
  currentTask?: import('../lib/agentTasks/rosterSummary.js').RosterTaskSummary | null;
  pausedUntil?: Date | null;
  heldBy?: { id: string; handle: string | null; name: string | null } | null;
  checkStatus?: import('../lib/workerCheckStatus.js').WorkerCheckStatus | null;
};
/** The seven values of an App's stall schedule (cor:agt:050:14–:17, :10, 070:01, :02), in the order the tools render them. */
const STALL_SCHEDULE_KEYS = [
  'notStartedMinutes', 'noProgressMinutes', 'ownerReactionMinutes', 'assignmentMinutes',
  'hostLapseCheckIns', 'sessionEndGraceMinutes', 'hostReportTimeoutMinutes',
] as const;
type StallScheduleKey = (typeof STALL_SCHEDULE_KEYS)[number];
const T = agentTaskFieldResolvers.AgentTask;
const E = agentTaskFieldResolvers.AgentTeamEvent;
const WA = agentTaskAlarmFieldResolvers.WorkerAvailability;
const FA = agentTaskAlarmFieldResolvers.ModelFamilyAvailability;
type AvailabilityRow = Record<string, any>;

/** The write tools, for the caller-session gate's bookkeeping and tests. */
export const AGENT_TASK_WRITE_TOOLS = [
  'hadron_task_create', 'hadron_task_assign', 'hadron_task_reassign', 'hadron_task_start',
  'hadron_task_progress', 'hadron_task_finish', 'hadron_task_cancel',
  'hadron_task_blocker_add', 'hadron_task_blocker_remove', 'hadron_task_priority_set',
  // #1754 — the backlog moves (cor:agt:050:02)
  'hadron_task_park', 'hadron_task_make_ready',
  // #1706
  'hadron_alarm_ack', 'hadron_worker_availability_set', 'hadron_model_family_availability_set',
  // #1926
  'hadron_stall_schedule_set',
] as const;
/** The read tools: actor-neutral, so they are listed in ACTOR_NEUTRAL_TOOLS. */
export const AGENT_TASK_READ_TOOLS = [
  'hadron_task_get', 'hadron_task_list', 'hadron_team_events', 'hadron_team_availability',
  // #1707
  'hadron_team_roster',
  // #1926
  'hadron_stall_schedule_get',
] as const;

function textResult(text: string, isError = false) {
  return { ...(isError ? { isError: true as const } : {}), content: [{ type: 'text' as const, text }] };
}

/** A resolver refusal as `[<code>] <message>` plus its extensions; anything else is a server fault. */
function refusal(e: unknown) {
  if (e instanceof GraphQLError && isTrustedRefusal(e)) {
    const { code, ...rest } = publicErrorExtensions(e.extensions ?? {});
    const extras = Object.entries(rest).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
    return textResult([`[${String(code ?? 'ERROR').toLowerCase()}] ${e.message}`, ...extras].join('\n'), true);
  }
  if (e instanceof UrnNotQualifiedError) return textResult(`[bad_user_input] ${e.message}`, true);
  throw e;
}

/** One roster line at the server's read instant, including stored pause history with explicit tense. */
export function renderRosterEntry(r: RosterRow, asOf: Date): string {
  const facts = [
    r.role ? `role ${r.role}` : null,
    r.bound
      ? `bound${r.family ? ` as ${r.family}` : ', no model family reported'}${r.liveSession ? '' : ' (session quiet)'}`
      : 'unbound',
    r.launchableFamilies.length ? `launchable as ${r.launchableFamilies.join('/')}` : null,
    r.free ? `free for work as ${r.freeFamilies.join('/')}` : null,
    r.unavailable ? `unavailable: ${r.unavailable.reason ?? 'unknown'}${r.unavailable.until ? ` until ${r.unavailable.until.toISOString()}` : ''}` : null,
    r.unavailableFamilies.length ? `family unavailable: ${r.unavailableFamilies.join('/')}` : null,
    r.startedTaskIds.length ? `started ${r.startedTaskIds.join(', ')}` : null,
    r.pendingTaskIds.length ? `pending ${r.pendingTaskIds.join(', ')}` : null,
    r.currentTask ? `top assignment ${r.currentTask.id} (${r.currentTask.status}): ${JSON.stringify(r.currentTask.title)}` : null,
    r.pausedUntil ? `own pause ${r.pausedUntil > asOf ? 'until' : 'ended'} ${r.pausedUntil.toISOString()}` : null,
    r.waitingOnTaskIds.length ? `waiting on ${r.waitingOnTaskIds.join(', ')} since ${r.waitingSince?.toISOString()}` : null,
    r.alarmEventIds.length ? `woken on alarm ${r.alarmEventIds.join(', ')}` : null,
    r.unreactedChildTaskId ? `child ${r.unreactedChildTaskId} ended (finished or cancelled)` : null,
    r.lastAssignedAt ? `last assigned ${r.lastAssignedAt.toISOString()}` : 'never assigned',
    // #1726: beside last activity, so a stale claim is easy to spot.
    r.teamPlacement != null ? `team placement ${r.teamPlacement}` : null,
    r.reportsTo ? `reports to ${r.reportsTo.name}${r.reportsTo.retired ? ' (retired)' : ''}` : null,
    r.lastActiveAt ? `last active ${r.lastActiveAt.toISOString()}` : null,
    // #2138 §3.4
    r.checkStatus ? renderCheckStatusShort(r.checkStatus) : null,
    // #2223: already behind the working-state and name gates by the time it reaches a row.
    r.heldBy ? `held by ${r.heldBy.handle ? `@${r.heldBy.handle} (hrn:user:${r.heldBy.handle})` : `user ${r.heldBy.id}`}${r.heldBy.name ? ` ${r.heldBy.name}` : ''}` : null,
  ].filter(Boolean);
  return `${r.name} — ${r.state}: ${facts.join('; ')}`;
}

function partyLabel(p: Party): string {
  if (!p) return 'nobody';
  return p.kind === 'WORKER' ? `worker ${p.name ?? p.id}${p.urn ? ` (${p.urn})` : ''}` : `user @${p.name ?? p.id}`;
}

/** One task as text, every derived field through the GraphQL field resolvers. */
export async function renderTask(t: TaskRow, ctx: Context, dependencies: { limit?: number; offset?: number } = {}): Promise<string> {
  const [owner, assignee, waiting] = await Promise.all([
    T.owner(t as never, {}, ctx) as Promise<Party>,
    T.assignee(t as never, {}, ctx) as Promise<Party>,
    T.waitingOnChildren(t as never, {}, ctx),
  ]);
  const [blockedBy, blocks] = await Promise.all([T.blockedBy(t as never, dependencies, ctx), T.blocks(t as never, dependencies, ctx)]);
  const flags = [T.queued(t as never) ? 'queued' : null, waiting ? 'waiting on child tasks' : null].filter(Boolean);
  const lines = [
    // #2553: the handle first, then the id it is an alias for.
    `- ${t.handle} ${t.title} (id: ${t.id})`,
    `  priority: ${t.priority ?? 1}`,
    `  blocked: ${t.blocked ?? false}`,
    `  blocked by (${blockedBy.total} total${blockedBy.hasMore ? ', more pages' : ''}): ${blockedBy.items.map((b) => b.id).join(', ') || 'none on this page'}`,
    `  blocks (${blocks.total} total${blocks.hasMore ? ', more pages' : ''}): ${blocks.items.map((b) => b.id).join(', ') || 'none on this page'}`,
    `  status: ${t.status}${flags.length ? ` (${flags.join(', ')})` : ''}`,
    `  owner: ${partyLabel(owner)} · assignee: ${partyLabel(assignee)}`,
  ];
  if (t.parentTaskId) lines.push(`  parent: ${t.parentTaskId}`);
  if (t.source) lines.push(`  source: ${t.source}`);
  if (t.tags?.length) lines.push(`  tags: ${t.tags.join(', ')}`);
  if (t.requirements) lines.push(`  requirements: ${JSON.stringify(t.requirements)}`);
  const times = [
    t.startBy ? `start by ${t.startBy.toISOString()}` : null,
    t.assignedAt ? `assigned ${t.assignedAt.toISOString()}` : null,
    t.startedAt ? `started ${t.startedAt.toISOString()}` : null,
    t.finishedAt ? `finished ${t.finishedAt.toISOString()}` : null,
    t.cancelledAt ? `cancelled ${t.cancelledAt.toISOString()}` : null,
  ].filter(Boolean);
  lines.push(`  created ${t.createdAt.toISOString()}${times.length ? ` · ${times.join(' · ')}` : ''}`);
  lines.push(`  closeSessionWhenDone: ${t.closeSessionWhenDone ? 'yes' : 'no'}`);
  // #1709 (cor:agt:050:10): the ask, in the words the asked worker acts on.
  const end = (await T.sessionEndRequest(t as never, {}, ctx)) as { sessionId: string; dueAt: Date; resolution: string | null } | null;
  if (end) {
    lines.push(end.resolution
      ? `  session end: ${end.resolution.toLowerCase().replace(/_/g, '-')} (session ${end.sessionId})`
      : `  session end requested: end session ${end.sessionId} with your handoff (hadron_end_session) before ${end.dueAt.toISOString()}; ` +
        'if it is still open then, the platform ends it through its host.');
  }
  if (t.status === 'finished') {
    lines.push(`  result: ${t.resultOutcome}${t.resultEvidence ? ` · evidence ${t.resultEvidence}` : ''}`);
    if (t.resultSummary) lines.push(...String(t.resultSummary).split('\n').map((l) => `    ${l}`));
  }
  if (t.description) lines.push('  description:', ...String(t.description).split('\n').map((l) => `    ${l}`));
  return lines.join('\n');
}

export async function renderEvent(e: EventRow, ctx: Context): Promise<string> {
  const actor = (await E.actor(e as never, {}, ctx)) as Party;
  const subject = (await E.subjectWorker(e as never, {}, ctx)) as Party;
  // #2553: the handle first, then the id (one read: the event row carries only the id).
  const handle = e.taskId ? (await ctx.db.agentTask.findUnique({ where: { id: e.taskId }, select: { handle: true } }))?.handle ?? null : null;
  const shown = (await E.payload(e as never, {}, ctx)) as Record<string, unknown> | null; // #2755: evidence only for a reader of the worker's internals
  const payload = shown && Object.keys(shown).length ? ` ${JSON.stringify(shown)}` : '';
  const line = `- ${e.createdAt.toISOString()} ${e.type}${e.severity ? ' [ALARM]' : ''} (id: ${e.id})` +
    `${e.taskId ? ` task ${handle ? `${handle} ` : ''}${e.taskId}` : ''}${e.severity ? '' : ` by ${partyLabel(actor)}`}` +
    `${subject ? ` → ${partyLabel(subject)}` : ''}${payload}`;
  if (!e.severity) return line;
  // #1706 — an alarm: its episode, who it has woken, and its acknowledgement.
  const wakes = (await agentTaskAlarmFieldResolvers.AgentTeamEvent.wakes(e as never, {}, ctx)) ?? [];
  const chain = await Promise.all(wakes.map(async (w) => {
    const owner = (await agentTaskAlarmFieldResolvers.AgentTeamAlarmSchedule.owner(w as never, {}, ctx)) as Party;
    return `${partyLabel(owner)} (${w.wokenAt ? `woken ${w.wokenAt.toISOString()}` : `due ${w.dueAt.toISOString()}`})`;
  }));
  const ack = e.acknowledgedAt
    ? `acknowledged ${e.acknowledgedAt.toISOString()} by ${partyLabel((await E.acknowledgedBy(e as never, {}, ctx)) as Party)}`
    : 'not acknowledged';
  return [
    line,
    `  episode since ${e.episodeStart ? e.episodeStart.toISOString() : '?'} · ${ack}`,
    `  chain: ${chain.join(' → ') || 'nobody'}`,
  ].join('\n');
}

async function renderAvailability(r: AvailabilityRow, kind: 'worker' | 'family', ctx: Context): Promise<string> {
  const F = (kind === 'worker' ? WA : FA) as Record<string, (r: never, a: unknown, c: Context) => unknown>;
  const who = kind === 'worker'
    ? partyLabel((await F.worker(r as never, {}, ctx)) as Party)
    : `family ${r.family}`;
  const setBy = kind === 'worker'
    ? `${String(F.setBy(r as never, {}, ctx)).toLowerCase()}${r.setByWorkerId || r.setByUserId ? ` (${partyLabel((await F.setByParty(r as never, {}, ctx)) as Party)})` : ''}`
    : partyLabel((await F.setBy(r as never, {}, ctx)) as Party);
  const inEffect = await F.inEffect(r as never, {}, ctx);
  return `- ${who}: ${r.state}${r.reason ? ` (${r.reason})` : ''}${r.until ? ` until ${r.until.toISOString()}` : ''}` +
    ` · ${inEffect ? 'in effect' : 'not in effect'} · set ${r.setAt.toISOString()} by ${setBy}`;
}

/** An App's stall schedule as text: the seven effective values, then when a manager last set any of them. */
function renderStallSchedule(r: StallScheduleView): string {
  return [
    ...STALL_SCHEDULE_KEYS.map((k) => `${k}: ${r[k]}`),
    `updatedAt: ${r.updatedAt ? r.updatedAt.toISOString() : 'never'}`,
  ].join('\n');
}

const SESSION_WRITE = z.string().optional().describe(
  'REQUIRED. Your session id: a worker passes its worker session (from hadron_start_session / hadron_whoami) and ' +
    'acts as the worker; a person passes a plain session (one bound to no worker) and acts as themselves. A write ' +
    'without it is refused, never inferred (#1697/#1701).',
);
const SESSION_READ = z.string().optional().describe(
  'Optional session id: read as that session\'s worker. An App key cannot act as a worker (until cor:agt:050:21 is ruled).',
);
const party = z.object({
  worker: z.string().optional().describe('A worker of the App: its id, URN or name.'),
  user: z.string().optional().describe('A person who participates in the App: user id or handle.'),
}).describe('Exactly one of worker or user.');
const taskId = z.string().describe(
  'The task id, or its handle: AT3.405 (a project, then the number within each parent; AT0.<n> is a task with no project). ' +
    'A person who belongs to several Apps qualifies it: hrn:agenttask:<app-urn>:AT3.405. The handle is not a GitHub issue number.',
);

/**
 * Register the agent-task tools on one MCP server instance. `auth` is the
 * connection's principal; each call builds the GraphQL Context from it.
 */
export function registerAgentTaskTools(server: McpServer, deps: { db: PrismaClient; auth: AuthContext }): void {
  const { db, auth } = deps;
  const keyCaller = Boolean(auth.appKeyId && !auth.userId);
  const ctxOf = (): Context => ({
    db,
    transport: 'mcp',
    clientId: auth.clientId ?? undefined,
    userId: auth.userId ?? undefined,
    // #1868: the presented hdr_user_ key, so the shared authorized transaction
    // re-checks it is still unrevoked at the write (as #1864's signing tools do).
    apiKeyId: auth.apiKeyId ?? undefined, signInId: auth.signInId,
    appId: auth.appId ?? undefined,
    appKeyId: auth.appKeyId ?? undefined,
    ...mcpRequestSessionContext(auth),
    roles: auth.roles as Context['roles'],
    organizationId: auth.organizationId ?? undefined,
    impersonation: auth.impersonation,
  });

  /**
   * Run a WRITE: refuse a missing session, refuse one that does not validate
   * (the caller-session gate already published its actor when it did), then
   * call the resolver and render the task.
   */
  async function write(tool: string, session: string | undefined, verb: string, call: (ctx: Context) => Promise<TaskRow>) {
    if (!session) {
      return textResult(
        `[session_required] ${tool}: pass session. A worker passes its worker session; a person passes a plain ` +
          'session (hadron_start_session with no worker) to act as themselves. Nothing was written.',
        true,
      );
    }
    if (!(await validateSessionBinding(db, auth, session))) {
      return textResult(
        `[session_not_bound] ${tool}: session "${session}" is not one of your open sessions (it may have ended, gone ` +
          'dormant, or belong to someone else). Nothing was written. hadron_whoami lists yours.',
        true,
      );
    }
    const ctx = ctxOf();
    try {
      const t = await call(ctx);
      const result = textResult(`${verb}.\n\n${await renderTask(t, ctx)}${renderTaskWarnings(ctx.taskWarnings)}`);
      await flushTaskWarningHistory(ctx);
      return result;
    } catch (e) {
      return refusal(e);
    }
  }

  /** Run a non-task WRITE (#1706): the same session rules as `write`, rendering its own result. */
  async function writeOther(tool: string, session: string | undefined, call: (ctx: Context) => Promise<string>) {
    if (!session) {
      return textResult(
        `[session_required] ${tool}: pass session. A worker passes its worker session; a person passes a plain ` +
          'session (hadron_start_session with no worker) to act as themselves. Nothing was written.',
        true,
      );
    }
    if (!(await validateSessionBinding(db, auth, session))) {
      return textResult(
        `[session_not_bound] ${tool}: session "${session}" is not one of your open sessions (it may have ended, gone ` +
          'dormant, or belong to someone else). Nothing was written. hadron_whoami lists yours.',
        true,
      );
    }
    const ctx = ctxOf();
    try {
      // #2607: a write that files task warnings (hadron_alarm_ack) renders them where the task tools do.
      const result = textResult(`${await call(ctx)}${renderTaskWarnings(ctx.taskWarnings)}`);
      await flushTaskWarningHistory(ctx);
      return result;
    } catch (e) {
      return refusal(e);
    }
  }

  /** Run a READ, as the named session's worker when one is given. */
  async function read(session: string | undefined, fn: (ctx: Context) => Promise<ReturnType<typeof textResult>>) {
    const ctx = ctxOf();
    try {
      // An App key reads without a session: whatever it names (plain, worker or invalid) is refused here, never
      // dropped, so the read cannot be served as if the key were unbound (#1785 cycle 1).
      if (keyCaller && session) {
        throw taskError('APP_KEY_SESSION_BOUND', 'An App key does not act through a session. Send no session.');
      }
      if (!session) return await fn(ctx);
      const valid = await validateSessionBinding(db, auth, session);
      if (!valid) return textResult(`[session_not_bound] session "${session}" is not one of your open sessions.`, true);
      return await runAsActor(valid.actor, () => fn(ctx));
    } catch (e) {
      return refusal(e);
    }
  }

  server.tool(
    'hadron_task_create',
    'Create an agent task in a team App (cor:agt:050). A ROOT task names appRef; any App participant may create one. ' +
      'It owns it unless it names another owner, which any participating worker or person may be (#1757, cor:agt:050:01). ' +
      'A CHILD task names parentTaskId; only the parent\'s assignee may create one, and owns it. Omit assignee to leave ' +
      'it queued; pass status BACKLOG to park it instead.',
    SHAPE_HADRON_TASK_CREATE,
    async ({ session, ...input }) =>
      write('hadron_task_create', session, 'Created', (ctx) => M.createAgentTask({}, { input }, ctx)),
  );

  server.tool('hadron_task_blocker_add',
    'Add a same-App blocker to a pending/backlog task. Assigner authority; cycles refuse (cor:agt:050:01).',
    SHAPE_HADRON_TASK_BLOCKER,
    async ({ session, ...args }) => write('hadron_task_blocker_add', session, 'Blocker added', (ctx) => M.addAgentTaskBlocker({}, args, ctx)));
  server.tool('hadron_task_blocker_remove',
    'Remove a blocker from a pending/backlog task. Last-blocker release restarts stall clocks; assigner authority (cor:agt:050:02).',
    SHAPE_HADRON_TASK_BLOCKER,
    async ({ session, ...args }) => write('hadron_task_blocker_remove', session, 'Blocker removed', (ctx) => M.removeAgentTaskBlocker({}, args, ctx)));
  server.tool('hadron_task_priority_set',
    'Set task priority1..5 (1 highest). Assigner authority; priority never grants authority (cor:agt:050:01).',
    SHAPE_HADRON_TASK_PRIORITY,
    async ({ session, ...args }) => write('hadron_task_priority_set', session, 'Priority set', (ctx) => M.setAgentTaskPriority({}, args, ctx)));

  server.tool(
    'hadron_task_assign',
    'Assign a task with no assignee — a queued task (pending) or a BACKLOG task: the task\'s owner, a worker the owner ' +
      'reports to, or whoever manages the App (cor:agt:050:09). Assigning a BACKLOG task moves it to pending. A task that ' +
      'already has an assignee is moved with hadron_task_reassign.',
    SHAPE_HADRON_TASK_ASSIGN,
    async ({ session, ...args }) =>
      write('hadron_task_assign', session, 'Assigned', (ctx) => M.assignAgentTask({}, args, ctx)),
  );

  server.tool(
    'hadron_task_reassign',
    'Move a task to another assignee: the task\'s owner, or whoever manages the App (cor:agt:050:09). A started task stays started; the former assignee can no longer move it.',
    SHAPE_HADRON_TASK_REASSIGN,
    async ({ session, ...args }) =>
      write('hadron_task_reassign', session, 'Reassigned', (ctx) => M.reassignAgentTask({}, args, ctx)),
  );

  server.tool(
    'hadron_task_start',
    'Start a pending task: its assignee only (cor:agt:050:08).',
    SHAPE_HADRON_TASK_START,
    async ({ session, taskId: id }) =>
      write('hadron_task_start', session, 'Started', (ctx) => M.startAgentTask({}, { taskId: id }, ctx)),
  );

  server.tool(
    'hadron_task_progress',
    'Record progress on a started task: its assignee only (cor:agt:050:08). Carries no text.',
    SHAPE_HADRON_TASK_PROGRESS,
    async ({ session, taskId: id }) =>
      write('hadron_task_progress', session, 'Progress recorded', (ctx) => M.recordAgentTaskProgress({}, { taskId: id }, ctx)),
  );

  server.tool(
    'hadron_task_finish',
    'Finish a started task with its result: its assignee only (cor:agt:050:08). outcome is one word: succeeded, failed, or a word your team uses.',
    SHAPE_HADRON_TASK_FINISH,
    async ({ session, taskId: id, outcome, summary, evidence }) =>
      write('hadron_task_finish', session, 'Finished', (ctx) =>
        M.finishAgentTask({}, { taskId: id, result: { outcome, summary, evidence } }, ctx)),
  );

  server.tool(
    'hadron_task_cancel',
    'Cancel a pending, started or backlog task: its owner, a worker the owner reports to, or whoever manages the App (cor:agt:050:09).',
    SHAPE_HADRON_TASK_CANCEL,
    async ({ session, taskId: id }) =>
      write('hadron_task_cancel', session, 'Cancelled', (ctx) => M.cancelAgentTask({}, { taskId: id }, ctx)),
  );

  // ── #1754: the backlog moves (cor:agt:050:02) ─────────────────────────

  server.tool(
    'hadron_task_park',
    'Park a queued task (pending, no assignee) in the backlog (cor:agt:050:02): unassigned, never matched, never waited on, ' +
      'no alarms. Whoever may assign a task may park it: its owner, a worker the owner reports to, or whoever manages the App (cor:agt:050:09).',
    SHAPE_HADRON_TASK_PARK,
    async ({ session, taskId: id }) =>
      write('hadron_task_park', session, 'Parked', (ctx) => M.parkAgentTask({}, { taskId: id }, ctx)),
  );

  server.tool(
    'hadron_task_make_ready',
    'Make a backlog task ready to be worked (cor:agt:050:02): it becomes pending and enters the queue. Whoever may assign ' +
      'a task may make it ready: its owner, a worker the owner reports to, or whoever manages the App (cor:agt:050:09).',
    SHAPE_HADRON_TASK_MAKE_READY,
    async ({ session, taskId: id }) =>
      write('hadron_task_make_ready', session, 'Ready', (ctx) => M.makeAgentTaskReady({}, { taskId: id }, ctx)),
  );

  server.tool(
    'hadron_task_get',
    'Read one agent task, or with tree: true the task and every task below it. Readers: the App\'s participants (cor:agt:050:21). A task you cannot read reads as not found.',
    SHAPE_HADRON_TASK_GET,
    async ({ taskId: id, tree, session, dependencyLimit, dependencyOffset }) =>
      read(session, async (ctx) => {
        if (tree) {
          const rows = await Q.agentTaskTree({}, { root: id }, ctx);
          if (!rows) return textResult(`[task_not_found] Task not found.\ntaskId: ${id}`, true);
          return textResult((await Promise.all(rows.map((t) => renderTask(t, ctx, { limit: dependencyLimit, offset: dependencyOffset })))).join('\n'));
        }
        const t = await Q.agentTask({}, { id }, ctx);
        if (!t) return textResult(`[task_not_found] Task not found.\ntaskId: ${id}`, true);
        return textResult(await renderTask(t, ctx, { limit: dependencyLimit, offset: dependencyOffset }));
      }),
  );

  server.tool(
    'hadron_task_list',
    'List a team App\'s agent tasks, newest first. Filters combine with AND. Readers: the App\'s participants (cor:agt:050:21).',
    SHAPE_HADRON_TASK_LIST,
    async ({ session, ...args }) =>
      read(session, async (ctx) => {
        const rows = await Q.agentTasks({}, args, ctx);
        if (!rows.length) return textResult('No tasks match.');
        return textResult((await Promise.all(rows.map((t) => renderTask(t, ctx)))).join('\n'));
      }),
  );

  server.tool(
    'hadron_team_events',
    'Read a team App\'s event stream (cor:agt:050:11), oldest first. To read the next page, pass after: the id of the last event you read (events sharing a timestamp are never skipped). Events carry ids, counts and outcome words, never message text. task.warning is passive history (never wakes, suppresses a wake or counts as activity), payload {code} only.',
    SHAPE_HADRON_TEAM_EVENTS,
    async ({ session, ...args }) =>
      read(session, async (ctx) => {
        const rows = await Q.agentTeamEvents({}, args, ctx);
        if (!rows.length) return textResult('No events match.');
        const lines = await Promise.all(rows.map((e) => renderEvent(e, ctx)));
        const pageSize = args.limit ?? 20;
        if (rows.length >= pageSize) lines.push(`\nMore may follow: pass after: "${rows[rows.length - 1].id}".`);
        return textResult(lines.join('\n'));
      }),
  );

  // ── #1706: alarms and availability ────────────────────────────────────

  server.tool(
    'hadron_alarm_ack',
    'Acknowledge a stall alarm (cor:agt:050:20): it stops waking owners further up the chain. It does not resolve the ' +
      'stall: the task moves only when it is reassigned, cancelled, or its assignee acts. Any owner in the alarm\'s ' +
      'chain, or whoever manages the App (cor:agt:050:24), may acknowledge it, and nobody else; a second ' +
      'acknowledgement is refused. Find alarms with ' +
      'hadron_team_events (alarmsOnly: true).',
    SHAPE_HADRON_ALARM_ACK,
    async ({ session, eventId }) =>
      writeOther('hadron_alarm_ack', session, async (ctx) =>
        `Acknowledged.\n\n${await renderEvent(await MA.acknowledgeAlarm({}, { eventId }, ctx), ctx)}`),
  );

  server.tool(
    'hadron_worker_availability_set',
    'Set a worker\'s availability for work (cor:agt:060:08). A worker, through its own session, may mark ITSELF ' +
      'unavailable (never available); the person holding the worker\'s name, or whoever manages the App, may set ' +
      'either. The worker it reports to directly may set it AVAILABLE, only to clear a mark the stall rule set ' +
      '(cor:agt:060:11). A worker is never chosen for new work while unavailable.',
    SHAPE_HADRON_WORKER_AVAILABILITY_SET,
    async ({ session, ...input }) =>
      writeOther('hadron_worker_availability_set', session, async (ctx) =>
        `Set.\n\n${await renderAvailability(await MA.setWorkerAvailability({}, { input }, ctx), 'worker', ctx)}`),
  );

  server.tool(
    'hadron_model_family_availability_set',
    'Set a model family\'s availability for work in a team App (cor:agt:060:09), e.g. pause every claude worker: ' +
      'whoever manages the App only.',
    SHAPE_HADRON_MODEL_FAMILY_AVAILABILITY_SET,
    async ({ session, ...input }) =>
      writeOther('hadron_model_family_availability_set', session, async (ctx) =>
        `Set.\n\n${await renderAvailability(await MA.setModelFamilyAvailability({}, { input }, ctx), 'family', ctx)}`),
  );

  server.tool(
    'hadron_team_availability',
    'Read a team App\'s availability records (cor:agt:060:02 / :03): each worker or model family marked, and whether ' +
      'the mark is in effect now. A worker or family with no record is available. Readers: the App\'s participants and the App\'s own key.',
    SHAPE_HADRON_TEAM_AVAILABILITY,
    async ({ session, appRef }) =>
      read(session, async (ctx) => {
        const { workers, families } = await QA.teamAvailability({}, { appRef }, ctx);
        if (!workers.length && !families.length) return textResult('No availability records: every worker and model family is available.');
        const lines = [
          ...(await Promise.all(workers.map((r) => renderAvailability(r, 'worker', ctx)))),
          ...(await Promise.all(families.map((r) => renderAvailability(r, 'family', ctx)))),
        ];
        return textResult(lines.join('\n'));
      }),
  );

  // ── #1926: the App's stall schedule ───────────────────────────────────

  server.tool(
    'hadron_stall_schedule_get',
    'Read a team App\'s stall schedule: the effective value of each of its seven settings (cor:agt:050:14–:17 the four ' +
      'stall windows in minutes, 070:01 the host-lapse count in check-ins, 050:10 the session-end grace in minutes, 070:02 ' +
      'the host report timeout in minutes), with the default shown for a setting nobody has changed, and when it was last ' +
      'set. Readers: the App\'s participants (cor:agt:050:21).',
    SHAPE_HADRON_STALL_SCHEDULE_GET,
    async ({ session, appRef }) =>
      read(session, async (ctx) => textResult(renderStallSchedule(await QA.agentTaskStallSchedule({}, { appRef }, ctx)))),
  );

  server.tool(
    'hadron_stall_schedule_set',
    'Set a team App\'s stall schedule: whoever manages the App only (a bound worker never does, even through a person who ' +
      'does). Pass only the settings to change: an omitted setting keeps its value; null returns that setting to the ' +
      'platform default. Bounds are the server\'s and a value outside them is refused. Returns the effective values as ' +
      'stored; a change applies to the platform\'s next evaluation, and nothing here restarts a host.',
    SHAPE_HADRON_STALL_SCHEDULE_SET,
    async ({ session, appRef, ...values }) => {
      // Forward only what the caller sent: `key in input` is the resolver's keep-vs-reset test.
      const input: Record<string, number | null> = {};
      for (const k of STALL_SCHEDULE_KEYS) if (values[k] !== undefined) input[k] = values[k] as number | null;
      return writeOther('hadron_stall_schedule_set', session, async (ctx) =>
        `Set.\n\n${renderStallSchedule(await MA.setAgentTaskStallSchedule({}, { appRef, input }, ctx))}`);
    },
  );

  server.tool(
    'hadron_team_roster',
    'Read a team App\'s roster (plan design:agent-tasks §7.4): each worker that is not retired, with one derived state ' +
      '(YOUR_MOVE, UNAVAILABLE, WAITING, WORKING, ASSIGNED_NOT_STARTED, AVAILABLE, NO_FAMILY, NOT_LAUNCHABLE) and the ' +
      'facts behind it: model family, free for work, availability, its tasks and alarms. Plan-derived, not a spec. ' +
      'Readers: the App\'s participants.',
    SHAPE_HADRON_TEAM_ROSTER,
    async ({ session, appRef }) =>
      read(session, async (ctx) => {
        const { workers, asOf } = await QA.teamRoster({}, { appRef }, ctx);
        if (!workers.length) return textResult('This App has no workers that are not retired.');
        return textResult([`Roster as of ${asOf.toISOString()}:`, ...workers.map((r) => renderRosterEntry(r, asOf))].join('\n'));
      }),
  );
}

// ── #2260: parameter shapes, built ONCE per process ──────────────────────────
// A shape is pure data (no session state: moved here only because nothing in it resolves to a
// function- or block-scoped binding, so `tsc` rejects one that captures `auth` or any other
// per-session value). Every MCP session registers these same objects instead of rebuilding ~15 MB.

const availabilityFields = {
  state: z.enum(['AVAILABLE', 'UNAVAILABLE']),
  reason: z.enum(['STALLED', 'OUT_OF_TOKENS', 'HOST_DOWN', 'OTHER']).optional()
    .describe('Required when UNAVAILABLE; refused when AVAILABLE.'),
  until: z.string().optional().describe('ISO date-time when an UNAVAILABLE record lapses; in the future.'),
};

const SHAPE_HADRON_TASK_CREATE = {
  priority: z.number().int().optional().describe('Priority1..5 (1 highest), default1; assigner authority required when named.'),
  blockedBy: z.array(z.string()).optional().describe('Same-App task refs that must end before start/matching; assigner authority required.'),
  appRef: z.string().optional().describe('The team App (id or URN). Required for a root task.'),
  parentTaskId: z.string().optional().describe('The parent task, for a child task.'),
  project: z.boolean().optional().describe('Make a top-level PROJECT (AT1, AT2, ...) instead of a task under the reserved project AT0. Not with parentTaskId.'),
  title: z.string().describe('What is asked, in the team\'s own words.'),
  description: z.string().optional(),
  source: z.string().optional().describe('Where the work came from: an issue URL, a node URN.'),
  owner: party.optional().describe('Defaults to you. For a root task, any participating worker or person; a ref outside the App\'s participants is refused. Never for a child task.'),
  assignee: party.optional(),
  requirements: z.object({
    role: z.string().optional(),
    familyIn: z.array(z.string()).optional(),
    familyNotIn: z.array(z.string()).optional(),
    excludeWorkers: z.array(z.string()).optional(),
  }).optional().describe('For the platform\'s matcher.'),
  startBy: z.string().optional().describe('ISO date-time by which it should have started.'),
  tags: z.array(z.string()).optional(),
  closeSessionWhenDone: z.boolean().optional().describe('Default false: the assignee\'s session ends only when you ask (cor:agt:050:10).'),
  status: z.enum(['PENDING', 'BACKLOG']).optional().describe(
    '#1754 (cor:agt:050:02): PENDING (default) or BACKLOG — parked, unassigned, never queued. A BACKLOG task takes no assignee.',
  ),
  session: SESSION_WRITE,
};

const SHAPE_HADRON_TASK_BLOCKER = { taskRef: taskId, blockerTaskRef: z.string(), session: SESSION_WRITE };
const SHAPE_HADRON_TASK_PRIORITY = { taskRef: taskId, priority: z.number().int(), session: SESSION_WRITE };

const SHAPE_HADRON_TASK_ASSIGN = { taskId, assignee: party, closeSessionWhenDone: z.boolean().optional().describe('Omitted keeps the task\'s stored value (cor:agt:050:10).'), session: SESSION_WRITE };

const SHAPE_HADRON_TASK_REASSIGN = { taskId, assignee: party, closeSessionWhenDone: z.boolean().optional().describe('Omitted keeps the task\'s stored value (cor:agt:050:10).'), session: SESSION_WRITE };

const SHAPE_HADRON_TASK_START = { taskId, session: SESSION_WRITE };

const SHAPE_HADRON_TASK_PROGRESS = { taskId, session: SESSION_WRITE };

const SHAPE_HADRON_TASK_FINISH = {
  taskId,
  outcome: z.string().describe('One word, e.g. succeeded or failed.'),
  summary: z.string().optional(),
  evidence: z.string().optional().describe('A URL or a node URN.'),
  session: SESSION_WRITE,
};

const SHAPE_HADRON_TASK_CANCEL = { taskId, session: SESSION_WRITE };

const SHAPE_HADRON_TASK_PARK = { taskId, session: SESSION_WRITE };

const SHAPE_HADRON_TASK_MAKE_READY = { taskId, session: SESSION_WRITE };

const SHAPE_HADRON_TASK_GET = { taskId, tree: z.boolean().optional(), dependencyLimit: z.number().int().optional().describe('Dependency page size, default20 cap200.'), dependencyOffset: z.number().int().optional().describe('Dependency offset, default0; applies to both blocks and blockedBy.'), session: SESSION_READ };

const SHAPE_HADRON_TASK_LIST = {
  appRef: z.string().describe('The team App (id or URN).'),
  status: z.array(z.enum(['BACKLOG', 'PENDING', 'STARTED', 'FINISHED', 'CANCELLED'])).optional(),
  owner: party.optional(),
  assignee: party.optional(),
  creator: party.optional().describe('Who created the task: a worker, or a person for a task they created themselves (not one their worker created).'),
  tag: z.string().optional(),
  tagsAny: z.array(z.string()).optional().describe('Match at least one tag; empty does not narrow.'),
  tagsAll: z.array(z.string()).optional().describe('Match every tag; empty does not narrow.'),
  source: z.string().optional().describe('Exact opaque source, not a prefix.'),
  text: z.string().optional().describe('Case-insensitive substring of the title or description, 1 to 200 characters after trimming. ANDed with the other filters.'),
  overdue: z.boolean().optional().describe('True: start-by passed on the database clock, not started, not ended, not backlog. False: all other tasks; not an alarm.'),
  createdAfter: taskListDateTime.optional().describe('Inclusive creation-time lower bound (ISO date-time).'),
  createdBefore: taskListDateTime.optional().describe('Inclusive creation-time upper bound (ISO date-time).'),
  startedAfter: taskListDateTime.optional().describe('Inclusive start-time lower bound; null dates excluded.'),
  startedBefore: taskListDateTime.optional().describe('Inclusive start-time upper bound; null dates excluded.'),
  finishedAfter: taskListDateTime.optional().describe('Inclusive finish-time lower bound; null dates excluded.'),
  finishedBefore: taskListDateTime.optional().describe('Inclusive finish-time upper bound; null dates excluded.'),
  parentTaskId: z.string().optional(),
  rootsOnly: z.boolean().optional(),
  queued: z.boolean().optional().describe('Only pending tasks with no assignee.'),
  limit: z.number().int().nonnegative().optional().describe('Default 20, cap 200.'),
  offset: z.number().int().nonnegative().optional(),
  session: SESSION_READ,
};

const SHAPE_HADRON_TEAM_EVENTS = {
  appRef: z.string().describe('The team App (id or URN).'),
  since: z.string().optional().describe('ISO date-time; only events after it. A coarse filter, not a continuation: use after to page.'),
  after: z.string().optional().describe('The id of the last event you read; the page continues strictly after it.'),
  types: z.array(z.string()).optional().describe('e.g. task.assigned, task.finished.'),
  alarmsOnly: z.boolean().optional(),
  taskId: z.string().optional(),
  limit: z.number().int().nonnegative().optional().describe('Default 20, cap 200.'),
  session: SESSION_READ,
};

const SHAPE_HADRON_ALARM_ACK = { eventId: z.string().describe('The alarm event id.'), session: SESSION_WRITE };

const SHAPE_HADRON_TEAM_AVAILABILITY = { appRef: z.string().describe('The team App (id or URN).'), session: SESSION_READ };

const stallValue = (what: string) => z.number().nullable().optional().describe(`${what}. Omit to keep; null for the platform default.`);

const SHAPE_HADRON_STALL_SCHEDULE_GET = { appRef: z.string().describe('The team App (id or URN).'), session: SESSION_READ };

const SHAPE_HADRON_STALL_SCHEDULE_SET = {
  appRef: z.string().describe('The team App (id or URN).'),
  notStartedMinutes: stallValue('Minutes an assigned task may sit unstarted before it alarms (1 to 10080)'),
  noProgressMinutes: stallValue('Minutes a started task may go without progress before it alarms (1 to 10080)'),
  ownerReactionMinutes: stallValue('Minutes an owner has to react to an ended child task before it alarms (1 to 10080)'),
  assignmentMinutes: stallValue('Minutes a queued task may go unassigned before it alarms (1 to 10080)'),
  hostLapseCheckIns: stallValue('Missed check-ins before a host\'s registration lapses (2 to 10)'),
  sessionEndGraceMinutes: stallValue('Grace before the platform ends a finished task\'s session (1 to 1440)'),
  hostReportTimeoutMinutes: stallValue('Minutes a host has to report an operation it collected'),
  session: SESSION_WRITE,
};

const SHAPE_HADRON_TEAM_ROSTER = { appRef: z.string().describe('The team App (id or URN).'), session: SESSION_READ };

const SHAPE_HADRON_WORKER_AVAILABILITY_SET = {
  worker: z.string().describe('The worker: id or URN, or its name with appRef.'),
  appRef: z.string().optional().describe('The team App (id or URN); needed when worker is a name.'),
  ...availabilityFields,
  session: SESSION_WRITE,
};

const SHAPE_HADRON_MODEL_FAMILY_AVAILABILITY_SET = {
  appRef: z.string().describe('The team App (id or URN).'),
  family: z.string().describe('The model family, a lowercase token, e.g. claude or codex.'),
  ...availabilityFields,
  session: SESSION_WRITE,
};
