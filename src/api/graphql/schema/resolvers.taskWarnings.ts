/**
 * #2198 (action register S1) — typed WARNINGS on task create / assign / reassign / finish.
 *
 * A warning is advice at the point of action: the call still succeeds (R125), and the response says what the team
 * has learned is usually wrong, with a stable `code`, a fixed `text`, and — for a caller that has an Agent — where
 * the App's register maps that code to a role task. The codes are a closed list per release; clients tolerate
 * unknown ones. EXPERIMENT (R130): no spec citation until it has run.
 *
 * Carrier. A field resolver cannot set response extensions, so a mutation records its warnings on the per-request
 * `Context` (`ctx.taskWarnings`, keyed by the mutation's response key, so aliases and several mutations in one
 * request stay apart) and `taskWarningsPlugin` copies them into `extensions.warnings` as the response is sent. The
 * MCP tools read the same list off the `ctx` they handed the resolver. A resolver records only AFTER its write
 * committed, so a failed operation can never carry a warning.
 *
 * Privacy. A warning is a code and a FIXED sentence: no worker name, reason or `until`. The three that describe
 * another worker's state (unavailable, busy, paused) are emitted only to a caller who passes the roster's own read
 * gate for that fact (`maySeeWorkerInternals`, the gate `Worker.checkStatus` masks on); to anyone else they are
 * simply absent.
 *
 * Register. The code→role-task mapping lives in the App's Team Agent's system memory as `register:<code>` nodes
 * (`data.registerEntry = { code, taskLoc }`, R137). The effective Team Agent is found the way team roles find it
 * (`locateTeamAgent`); `register:<code>` resolves through ITS chain; the entry's `taskLoc` then resolves through the
 * CALLER's own Agent chain (nearest wins). A caller with no Agent (a person, an ambiguous or refused session) gets no
 * `register` field. The lookup runs after commit under a hard budget and never fails the call.
 */
import type { GraphQLResolveInfo } from 'graphql';
import type { Prisma } from '../../../generated/prisma/index.js';
import type { Context } from './resolvers.helpers.js';
import { currentActor } from '../../../lib/requestActor.js';
import { findEffectiveNodeIdByLoc } from '../../../lib/effectiveSystemMemory.js';
import { loadAvailabilityByFamily } from '../../../lib/agentTasks/availability.js';
import { loadAppWorkerCheckStatuses, locateTeamAgent, maySeeWorkerInternals } from './resolvers.worker.js';

export const TASK_WARNING_CODES = [
  'task.create.no-source',
  'task.assign.assignee-unavailable',
  'task.assign.assignee-busy',
  'task.assign.assignee-paused',
  'task.finish.open-children',
] as const;
export type TaskWarningCode = (typeof TASK_WARNING_CODES)[number];

/** Fixed text per code: never interpolated with a name, id or reason. */
export const TASK_WARNING_TEXT: Record<TaskWarningCode, string> = {
  'task.create.no-source': 'This task has no source: say where the work came from (an issue URL or a node URN).',
  'task.assign.assignee-unavailable': 'The assignee is marked unavailable for work, so the task may wait.',
  'task.assign.assignee-busy': 'The assignee already has an open task.',
  'task.assign.assignee-paused': 'The assignee has paused itself, so the task may wait.',
  'task.finish.open-children': 'This task still has open child tasks.',
};

export type TaskWarningRegister =
  | { state: 'mapped'; taskLoc: string; taskUrn: string }
  | { state: 'unmapped' }
  | { state: 'unresolved' };

export type TaskWarning = { code: TaskWarningCode; text: string; register?: TaskWarningRegister };

/** At most this many warnings per operation and per response (deterministic: operation order, then code order). */
export const MAX_WARNINGS_PER_OPERATION = 5;
export const MAX_WARNINGS_PER_RESPONSE = 20;
/** One statement is cancelled by Postgres after this long; the whole register step after the total. */
export const REGISTER_STATEMENT_TIMEOUT_MS = 300;
export const REGISTER_TOTAL_BUDGET_MS = 1000;

const ASSIGNEE_FACT_CODES: readonly TaskWarningCode[] = [
  'task.assign.assignee-unavailable', 'task.assign.assignee-busy', 'task.assign.assignee-paused',
];

/** The key a mutation's warnings are filed under: its response key (alias or name); MCP calls have no `info`. */
export function warningPath(info?: Pick<GraphQLResolveInfo, 'path'> | null): string {
  const key = info?.path?.key;
  return typeof key === 'string' ? key : 'mcp';
}

/** Order by the fixed code order and cap; drops duplicates. */
function normalise(codes: readonly TaskWarningCode[]): TaskWarningCode[] {
  return TASK_WARNING_CODES.filter((c) => codes.includes(c)).slice(0, MAX_WARNINGS_PER_OPERATION);
}

/**
 * What the write transaction saw about a worker assignee. Plain reads, no locks: a concurrent change is a benign
 * race for advice, and the facts are read in the same transaction as the assignment decision.
 */
export async function readAssigneeFacts(
  tx: Prisma.TransactionClient,
  args: { appId: string; workerId: string; excludeTaskId: string | null; now: Date },
): Promise<{ unavailable: boolean; busy: boolean }> {
  const [view, open] = await Promise.all([
    loadAvailabilityByFamily(tx, [{ id: args.workerId, appId: args.appId, families: [] }], args.now),
    tx.agentTask.count({
      where: {
        assigneeWorkerId: args.workerId, status: { in: ['pending', 'started'] },
        ...(args.excludeTaskId ? { id: { not: args.excludeTaskId } } : {}),
      },
    }),
  ]);
  return { unavailable: view.get(args.workerId)?.ownInEffect === true, busy: open > 0 };
}

export type PendingWarnings = {
  /** Codes decided inside the write transaction. */
  codes: TaskWarningCode[];
  /** When the assignee is a worker other than the caller: who to check for `paused` (and gate the facts on). */
  assigneeWorkerId?: string | null;
};

/**
 * After the write committed: gate, order, cap, resolve the register, and file the warnings on the request. Never
 * throws and never delays the call beyond {@link REGISTER_TOTAL_BUDGET_MS}.
 */
export async function emitTaskWarnings(
  ctx: Context,
  info: Pick<GraphQLResolveInfo, 'path'> | undefined | null,
  appId: string,
  pending: PendingWarnings,
): Promise<void> {
  try {
    let codes = [...pending.codes];
    const facts = codes.some((c) => ASSIGNEE_FACT_CODES.includes(c)) || pending.assigneeWorkerId;
    if (facts) {
      // The facts describe another worker's state: only a caller the roster would show them to learns them.
      const mayKnow = await maySeeWorkerInternals(ctx, appId);
      codes = codes.filter((c) => !ASSIGNEE_FACT_CODES.includes(c) || mayKnow);
      if (mayKnow && pending.assigneeWorkerId) {
        const statuses = await loadAppWorkerCheckStatuses(ctx, appId);
        if (statuses.get(pending.assigneeWorkerId)?.pendingReason === 'PAUSED') codes.push('task.assign.assignee-paused');
      }
    }
    const ordered = normalise(codes);
    if (ordered.length === 0) return;
    const registers = await resolveRegisters(ctx, appId, ordered);
    const warnings: TaskWarning[] = ordered.map((code) => ({
      code, text: TASK_WARNING_TEXT[code], ...(registers.has(code) ? { register: registers.get(code) } : {}),
    }));
    const path = warningPath(info);
    (ctx.taskWarnings ??= []).push(...warnings.map((warning) => ({ path, warning })));
  } catch {
    // Advice must never fail a committed action.
  }
}

type RegisterOutcome = Map<TaskWarningCode, TaskWarningRegister>;

/**
 * Resolve each code through the register, in ONE read transaction. `SET LOCAL statement_timeout` makes Postgres
 * cancel a slow statement itself (nothing keeps running after we stop waiting), the transaction `timeout` bounds the
 * whole step, and a deadline is checked between codes so the AGGREGATE is bounded: past it, the remaining codes carry
 * no `register` field. Any error ⇒ no register info at all (code + text only).
 */
export async function resolveRegisters(ctx: Context, appId: string, codes: readonly TaskWarningCode[]): Promise<RegisterOutcome> {
  const out: RegisterOutcome = new Map();
  const agentId = currentActor().agentId;
  // No Agent (a person, ambiguous or refused binding): code + text only (R129). Never a borrowed Agent.
  if (!agentId || codes.length === 0) return out;
  const deadline = Date.now() + REGISTER_TOTAL_BUDGET_MS;
  try {
    await ctx.db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${REGISTER_STATEMENT_TIMEOUT_MS}`);
      const txCtx = { ...ctx, db: tx } as unknown as Context;
      const caller = await tx.agent.findUnique({ where: { id: agentId }, select: { systemMemoryId: true, deletedAt: true } });
      let team: Awaited<ReturnType<typeof locateTeamAgent>> | null = null;
      try {
        team = await locateTeamAgent(txCtx, appId, undefined);
      } catch {
        team = null; // zero or several Team Agents: nothing to map through, never a guess
      }
      for (const code of codes) {
        if (Date.now() >= deadline) return; // aggregate bound: the rest stay code + text only
        if (!team?.systemMemoryId) { out.set(code, { state: 'unmapped' }); continue; }
        const entry = await findEffectiveNodeIdByLoc(tx, team.systemMemoryId, `register:${code}`);
        const node = entry ? await tx.node.findUnique({ where: { id: entry.id }, select: { data: true, deletedAt: true } }) : null;
        const taskLoc = registerTaskLoc(node?.deletedAt ? null : node?.data, code);
        if (!taskLoc) { out.set(code, { state: 'unmapped' }); continue; }
        if (!caller || caller.deletedAt || !caller.systemMemoryId) { out.set(code, { state: 'unresolved' }); continue; }
        const hit = await findEffectiveNodeIdByLoc(tx, caller.systemMemoryId, taskLoc);
        const task = hit
          ? await tx.node.findUnique({
              where: { id: hit.id },
              select: { loc: true, isRunnable: true, deletedAt: true, memory: { select: { urn: true, deletedAt: true } } },
            })
          : null;
        if (!task || task.deletedAt || task.memory.deletedAt || !task.isRunnable) { out.set(code, { state: 'unresolved' }); continue; }
        out.set(code, { state: 'mapped', taskLoc: task.loc, taskUrn: `hrn:node:${task.memory.urn}:${task.loc}` });
      }
    }, { timeout: REGISTER_TOTAL_BUDGET_MS + 500, maxWait: 500 });
  } catch {
    out.clear();
  }
  return out;
}

/** The `taskLoc` of a well-formed register entry for `code`, else null (a malformed entry reads as unmapped). */
export function registerTaskLoc(data: unknown, code: string): string | null {
  const entry = (data as { registerEntry?: { code?: unknown; taskLoc?: unknown } } | null | undefined)?.registerEntry;
  if (!entry || entry.code !== code) return null;
  const loc = entry.taskLoc;
  return typeof loc === 'string' && loc.trim() !== '' && loc.length <= 512 ? loc : null;
}

/**
 * The response copy: per path at most {@link MAX_WARNINGS_PER_OPERATION}, whole response at most
 * {@link MAX_WARNINGS_PER_RESPONSE}, in the order they were recorded; a path whose field errored carries none.
 */
export function shapeResponseWarnings(
  collected: readonly { path: string; warning: TaskWarning }[],
  erroredPaths: ReadonlySet<string>,
): { path: string; code: TaskWarningCode; text: string; register?: TaskWarningRegister }[] {
  const perPath = new Map<string, number>();
  const out: { path: string; code: TaskWarningCode; text: string; register?: TaskWarningRegister }[] = [];
  for (const { path, warning } of collected) {
    if (erroredPaths.has(path)) continue;
    const n = perPath.get(path) ?? 0;
    if (n >= MAX_WARNINGS_PER_OPERATION || out.length >= MAX_WARNINGS_PER_RESPONSE) continue;
    perPath.set(path, n + 1);
    out.push({ path, code: warning.code, text: warning.text, ...(warning.register ? { register: warning.register } : {}) });
  }
  return out;
}

/** The MCP rendering: extra lines after the task text, same list and order. */
export function renderTaskWarnings(collected: readonly { warning: TaskWarning }[] | undefined): string {
  const lines = (collected ?? []).slice(0, MAX_WARNINGS_PER_OPERATION).map(({ warning: w }) => {
    const where = w.register?.state === 'mapped' ? ` → ${w.register.taskUrn}` : w.register?.state === 'unmapped' ? ' (no task mapped)' : '';
    return `Warning [${w.code}]: ${w.text}${where}`;
  });
  return lines.length ? `\n\n${lines.join('\n')}` : '';
}
