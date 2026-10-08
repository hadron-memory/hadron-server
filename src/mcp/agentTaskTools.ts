/**
 * #1705 — agent tasks on the MCP surface (cor:agt:050): create, assign,
 * reassign, start, record progress, finish and cancel a task, read one or a
 * list, and read the App's team event stream.
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
import { z } from 'zod';
import { GraphQLError } from 'graphql';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { agentTaskFieldResolvers } from '../api/graphql/schema/resolvers.agentTask.js';
import { type AuthContext, validateSessionBinding } from '../middleware/auth.js';
import { runAsActor } from '../lib/requestActor.js';
import { UrnNotQualifiedError } from '../lib/urn.js';
import type { PrismaClient } from '../generated/prisma/index.js';

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
const T = agentTaskFieldResolvers.AgentTask;
const E = agentTaskFieldResolvers.AgentTeamEvent;

/** The write tools, for the caller-session gate's bookkeeping and tests. */
export const AGENT_TASK_WRITE_TOOLS = [
  'hadron_task_create', 'hadron_task_assign', 'hadron_task_reassign', 'hadron_task_start',
  'hadron_task_progress', 'hadron_task_finish', 'hadron_task_cancel',
] as const;
/** The read tools: actor-neutral, so they are listed in ACTOR_NEUTRAL_TOOLS. */
export const AGENT_TASK_READ_TOOLS = ['hadron_task_get', 'hadron_task_list', 'hadron_team_events'] as const;

function textResult(text: string, isError = false) {
  return { ...(isError ? { isError: true as const } : {}), content: [{ type: 'text' as const, text }] };
}

/** A resolver refusal as `[<code>] <message>` plus its extensions; anything else is a server fault. */
function refusal(e: unknown) {
  if (e instanceof GraphQLError) {
    const { code, ...rest } = e.extensions ?? {};
    const extras = Object.entries(rest).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
    return textResult([`[${String(code ?? 'ERROR').toLowerCase()}] ${e.message}`, ...extras].join('\n'), true);
  }
  if (e instanceof UrnNotQualifiedError) return textResult(`[bad_user_input] ${e.message}`, true);
  throw e;
}

function partyLabel(p: Party): string {
  if (!p) return 'nobody';
  return p.kind === 'WORKER' ? `worker ${p.name ?? p.id}${p.urn ? ` (${p.urn})` : ''}` : `user @${p.name ?? p.id}`;
}

/** One task as text, every derived field through the GraphQL field resolvers. */
export async function renderTask(t: TaskRow, ctx: Context): Promise<string> {
  const [owner, assignee, waiting] = await Promise.all([
    T.owner(t as never, {}, ctx) as Promise<Party>,
    T.assignee(t as never, {}, ctx) as Promise<Party>,
    T.waitingOnChildren(t as never, {}, ctx),
  ]);
  const flags = [T.queued(t as never) ? 'queued' : null, waiting ? 'waiting on child tasks' : null].filter(Boolean);
  const lines = [
    `- ${t.title} (id: ${t.id})`,
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
  if (t.status === 'finished') {
    lines.push(`  result: ${t.resultOutcome}${t.resultEvidence ? ` · evidence ${t.resultEvidence}` : ''}`);
    if (t.resultSummary) lines.push(...String(t.resultSummary).split('\n').map((l) => `    ${l}`));
  }
  if (t.description) lines.push('  description:', ...String(t.description).split('\n').map((l) => `    ${l}`));
  return lines.join('\n');
}

async function renderEvent(e: EventRow, ctx: Context): Promise<string> {
  const actor = (await E.actor(e as never, {}, ctx)) as Party;
  const subject = (await E.subjectWorker(e as never, {}, ctx)) as Party;
  const payload = e.payload && Object.keys(e.payload).length ? ` ${JSON.stringify(e.payload)}` : '';
  return `- ${e.createdAt.toISOString()} ${e.type}${e.severity ? ' [ALARM]' : ''} (id: ${e.id})` +
    `${e.taskId ? ` task ${e.taskId}` : ''} by ${partyLabel(actor)}` +
    `${subject ? ` → ${partyLabel(subject)}` : ''}${payload}`;
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
const taskId = z.string().describe('The task id.');

/**
 * Register the agent-task tools on one MCP server instance. `auth` is the
 * connection's principal; each call builds the GraphQL Context from it.
 */
export function registerAgentTaskTools(server: McpServer, deps: { db: PrismaClient; auth: AuthContext }): void {
  const { db, auth } = deps;
  const ctxOf = (): Context => ({
    db,
    transport: 'mcp',
    clientId: auth.clientId ?? undefined,
    userId: auth.userId ?? undefined,
    appId: auth.appId ?? undefined,
    sessionId: auth.sessionId ?? undefined,
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
      return textResult(`${verb}.\n\n${await renderTask(t, ctx)}`);
    } catch (e) {
      return refusal(e);
    }
  }

  /** Run a READ, as the named session's worker when one is given. */
  async function read(session: string | undefined, fn: (ctx: Context) => Promise<ReturnType<typeof textResult>>) {
    const ctx = ctxOf();
    try {
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
    'Create an agent task in a team App (cor:agt:050). A ROOT task names appRef; any App participant may create one, ' +
      'and owns it unless an App manager names another owner. A CHILD task names parentTaskId; only the parent\'s ' +
      'assignee may create one, and owns it. Omit assignee to leave it queued.',
    {
      appRef: z.string().optional().describe('The team App (id or URN). Required for a root task.'),
      parentTaskId: z.string().optional().describe('The parent task, for a child task.'),
      title: z.string().describe('What is asked, in the team\'s own words.'),
      description: z.string().optional(),
      source: z.string().optional().describe('Where the work came from: an issue URL, a node URN.'),
      owner: party.optional().describe('Defaults to you. Only an App manager may name someone else, and never for a child task.'),
      assignee: party.optional(),
      requirements: z.object({
        role: z.string().optional(),
        familyIn: z.array(z.string()).optional(),
        familyNotIn: z.array(z.string()).optional(),
        excludeWorkers: z.array(z.string()).optional(),
      }).optional().describe('For the platform\'s matcher.'),
      startBy: z.string().optional().describe('ISO date-time by which it should have started.'),
      tags: z.array(z.string()).optional(),
      closeSessionWhenDone: z.boolean().optional().describe('Default true (cor:agt:050:10).'),
      session: SESSION_WRITE,
    },
    async ({ session, ...input }) =>
      write('hadron_task_create', session, 'Created', (ctx) => M.createAgentTask({}, { input }, ctx)),
  );

  server.tool(
    'hadron_task_assign',
    'Assign a queued task (pending, no assignee): the task\'s owner, or whoever manages the App (cor:agt:050:09). A task that already has an assignee is moved with hadron_task_reassign.',
    { taskId, assignee: party, closeSessionWhenDone: z.boolean().optional(), session: SESSION_WRITE },
    async ({ session, ...args }) =>
      write('hadron_task_assign', session, 'Assigned', (ctx) => M.assignAgentTask({}, args, ctx)),
  );

  server.tool(
    'hadron_task_reassign',
    'Move a task to another assignee: the task\'s owner, or whoever manages the App (cor:agt:050:09). A started task stays started; the former assignee can no longer move it.',
    { taskId, assignee: party, closeSessionWhenDone: z.boolean().optional(), session: SESSION_WRITE },
    async ({ session, ...args }) =>
      write('hadron_task_reassign', session, 'Reassigned', (ctx) => M.reassignAgentTask({}, args, ctx)),
  );

  server.tool(
    'hadron_task_start',
    'Start a pending task: its assignee only (cor:agt:050:08).',
    { taskId, session: SESSION_WRITE },
    async ({ session, taskId: id }) =>
      write('hadron_task_start', session, 'Started', (ctx) => M.startAgentTask({}, { taskId: id }, ctx)),
  );

  server.tool(
    'hadron_task_progress',
    'Record progress on a started task: its assignee only (cor:agt:050:08). Carries no text.',
    { taskId, session: SESSION_WRITE },
    async ({ session, taskId: id }) =>
      write('hadron_task_progress', session, 'Progress recorded', (ctx) => M.recordAgentTaskProgress({}, { taskId: id }, ctx)),
  );

  server.tool(
    'hadron_task_finish',
    'Finish a started task with its result: its assignee only (cor:agt:050:08). outcome is one word: succeeded, failed, or a word your team uses.',
    {
      taskId,
      outcome: z.string().describe('One word, e.g. succeeded or failed.'),
      summary: z.string().optional(),
      evidence: z.string().optional().describe('A URL or a node URN.'),
      session: SESSION_WRITE,
    },
    async ({ session, taskId: id, outcome, summary, evidence }) =>
      write('hadron_task_finish', session, 'Finished', (ctx) =>
        M.finishAgentTask({}, { taskId: id, result: { outcome, summary, evidence } }, ctx)),
  );

  server.tool(
    'hadron_task_cancel',
    'Cancel a pending or started task: its owner, or whoever manages the App (cor:agt:050:09).',
    { taskId, session: SESSION_WRITE },
    async ({ session, taskId: id }) =>
      write('hadron_task_cancel', session, 'Cancelled', (ctx) => M.cancelAgentTask({}, { taskId: id }, ctx)),
  );

  server.tool(
    'hadron_task_get',
    'Read one agent task, or with tree: true the task and every task below it. Readers: the App\'s participants (cor:agt:050:21). A task you cannot read reads as not found.',
    { taskId, tree: z.boolean().optional(), session: SESSION_READ },
    async ({ taskId: id, tree, session }) =>
      read(session, async (ctx) => {
        if (tree) {
          const rows = await Q.agentTaskTree({}, { root: id }, ctx);
          if (!rows) return textResult(`[task_not_found] Task not found.\ntaskId: ${id}`, true);
          return textResult((await Promise.all(rows.map((t) => renderTask(t, ctx)))).join('\n'));
        }
        const t = await Q.agentTask({}, { id }, ctx);
        if (!t) return textResult(`[task_not_found] Task not found.\ntaskId: ${id}`, true);
        return textResult(await renderTask(t, ctx));
      }),
  );

  server.tool(
    'hadron_task_list',
    'List a team App\'s agent tasks, newest first. Filters combine with AND. Readers: the App\'s participants (cor:agt:050:21).',
    {
      appRef: z.string().describe('The team App (id or URN).'),
      status: z.array(z.enum(['PENDING', 'STARTED', 'FINISHED', 'CANCELLED'])).optional(),
      owner: party.optional(),
      assignee: party.optional(),
      tag: z.string().optional(),
      parentTaskId: z.string().optional(),
      rootsOnly: z.boolean().optional(),
      queued: z.boolean().optional().describe('Only pending tasks with no assignee.'),
      limit: z.number().int().nonnegative().optional().describe('Default 50, cap 200.'),
      offset: z.number().int().nonnegative().optional(),
      session: SESSION_READ,
    },
    async ({ session, ...args }) =>
      read(session, async (ctx) => {
        const rows = await Q.agentTasks({}, args, ctx);
        if (!rows.length) return textResult('No tasks match.');
        return textResult((await Promise.all(rows.map((t) => renderTask(t, ctx)))).join('\n'));
      }),
  );

  server.tool(
    'hadron_team_events',
    'Read a team App\'s event stream (cor:agt:050:11), oldest first. To read the next page, pass after: the id of the last event you read (events sharing a timestamp are never skipped). Events carry ids, counts and outcome words, never message text.',
    {
      appRef: z.string().describe('The team App (id or URN).'),
      since: z.string().optional().describe('ISO date-time; only events after it. A coarse filter, not a continuation: use after to page.'),
      after: z.string().optional().describe('The id of the last event you read; the page continues strictly after it.'),
      types: z.array(z.string()).optional().describe('e.g. task.assigned, task.finished.'),
      alarmsOnly: z.boolean().optional(),
      taskId: z.string().optional(),
      limit: z.number().int().nonnegative().optional().describe('Default 50, cap 200.'),
      session: SESSION_READ,
    },
    async ({ session, ...args }) =>
      read(session, async (ctx) => {
        const rows = await Q.agentTeamEvents({}, args, ctx);
        if (!rows.length) return textResult('No events match.');
        const lines = await Promise.all(rows.map((e) => renderEvent(e, ctx)));
        const pageSize = args.limit ?? 50;
        if (rows.length >= pageSize) lines.push(`\nMore may follow: pass after: "${rows[rows.length - 1].id}".`);
        return textResult(lines.join('\n'));
      }),
  );
}
