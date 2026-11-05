/**
 * #2198 (action register S1) — typed WARNINGS on task create / assign / reassign / finish; #2607 adds task cancel
 * and alarm acknowledgement.
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
 * Register. Shared lookup primitives live in lib/actionRegister/lookup.ts, also used by tick wakes (#2733).
 * The ticker.code.unmapped warning uses this same carrier and never records a task event.
 * The code→role-task mapping lives in the App's Team Agent's system memory as `register:<code>` nodes
 * (`data.registerEntry = { code, taskLoc }`, R137). The effective Team Agent is found the way team roles find it
 * (`locateTeamAgent`); `register:<code>` resolves through ITS chain; the entry's `taskLoc` then resolves through the
 * CALLER's own Agent chain (nearest wins). A caller with no Agent (a person, an ambiguous or refused session) gets no
 * `register` field. The lookup runs after commit under a hard budget and never fails the call.
 */
import type { GraphQLResolveInfo } from 'graphql';
import type { Prisma } from '../../../generated/prisma/index.js';
import { withoutRequestCaches, type Context } from './resolvers.helpers.js';
import { appendTaskEvent, eventActor, RECORDED_TASK_WARNING_CODES, type EventActor, type RecordedTaskWarningCode } from '../../../lib/agentTasks/events.js';
import { currentActor } from '../../../lib/requestActor.js';
import { loadAvailabilityByFamily } from '../../../lib/agentTasks/availability.js';
import { loadWorkerCheckStatuses } from '../../../lib/workerCheckStatus.js';
import { maySeeWorkerInternals } from './resolvers.worker.js';
import { RegisterLookup } from '../../../lib/actionRegister/lookup.js';
import { answerWithLookup } from '../../../lib/actionRegister/answerCore.js';
export { registerTaskLoc } from '../../../lib/actionRegister/lookup.js';

export const TASK_WARNING_CODES = [
  'task.create.no-source',
  'task.assign.assignee-unavailable',
  'task.assign.assignee-busy',
  'task.assign.assignee-paused',
  // #3267 (action register phase 3, S1): advice on start and progress. The first and last describe worker or
  // other-task state, so they sit behind the roster gate (GATED_CODES); parent-ended is about the task's own parent.
  'task.start.other-started',
  'task.start.parent-ended',
  'task.progress.children-ended',
  'task.finish.open-children',
  // #2607 (action register phase 3): ungated, fixed text, about the caller's own act.
  'task.cancel.open-children',
  'alarm.ack.outside-chain',
  'ticker.code.unmapped',
] as const;
export type TaskWarningCode = (typeof TASK_WARNING_CODES)[number];

/** Fixed text per code: never interpolated with a name, id or reason. */
export const TASK_WARNING_TEXT: Record<TaskWarningCode, string> = {
  'task.create.no-source': 'This task has no source: say where the work came from (an issue URL or a node URN).',
  'task.assign.assignee-unavailable': 'The assignee is marked unavailable for work, so the task may wait.',
  'task.assign.assignee-busy': 'The assignee already has an open task.',
  'task.assign.assignee-paused': 'The assignee has paused itself, so the task may wait.',
  'task.start.other-started': 'You already have another task started; starting this one does not end it.',
  'task.start.parent-ended': "This task's parent has already ended.",
  'task.progress.children-ended': 'Every child of this task has ended, so it may be ready to finish.',
  'task.finish.open-children': 'This task still has open child tasks.',
  'task.cancel.open-children': 'This task still has open child tasks; cancelling it does not end them.',
  'alarm.ack.outside-chain': 'You acknowledged an alarm outside its chain, as a manager of the App.',
  'ticker.code.unmapped': "No register entry you can read maps this ticker's code to a task, so its wakes will say no task is mapped.",
};

export type TaskWarningRegister =
  | { state: 'mapped'; taskLoc: string; taskUrn: string }
  | { state: 'unmapped' }
  | { state: 'unresolved' }
  /** #3491, ruling 0176: an unreadable system memory on a chain, or a failed lookup. Says nothing about what the chain holds. */
  | { state: 'withheld' };

const WITHHELD_REGISTER: TaskWarningRegister = Object.freeze({ state: 'withheld' as const });

export type TaskWarning = { code: TaskWarningCode; text: string; register?: TaskWarningRegister };

/** At most this many warnings per operation and per response (deterministic: operation order, then code order). */
export const MAX_WARNINGS_PER_OPERATION = 5;
export const MAX_WARNINGS_PER_RESPONSE = 20;
/**
 * The enforced bounds, all on the post-commit reads (the privacy gate and the register alike, one transaction per
 * response-filing call): Postgres cancels any STATEMENT after the statement timeout; the transaction is cut after
 * total + 500 ms (hard); between steps a cooperative deadline of `total` stops further codes; and a request as a whole
 * spends at most {@link REQUEST_READ_BUDGET_MS} (plus its last transaction) before it files fixed text only. Answers
 * are shared request-wide, so N aliases cost one lookup per distinct (App, Agent, code), and a full response costs none.
 */
export const REGISTER_STATEMENT_TIMEOUT_MS = 300;
export const REGISTER_TOTAL_BUDGET_MS = 1000;

/**
 * The codes that describe a worker's or another task's state: filed only to a caller who passes the roster's own read
 * gate (`maySeeWorkerInternals`), and dropped, never degraded, for anyone else. #3267 adds the start/progress pair.
 */
const GATED_CODES: readonly TaskWarningCode[] = [
  'task.assign.assignee-unavailable', 'task.assign.assignee-busy', 'task.assign.assignee-paused',
  'task.start.other-started', 'task.progress.children-ended',
];

/** The key a mutation's warnings are filed under: its response key (alias or name); MCP calls have no `info`. */
export function warningPath(info?: Pick<GraphQLResolveInfo, 'path'> | null): string {
  const key = info?.path?.key;
  return typeof key === 'string' ? key : 'mcp';
}

/**
 * Whether a warning's path belongs to a mutation that errored. #2653: a createAgentTasks call files each task's
 * warnings under `<response key>.<position>`, and an error names the response key alone, so the key before the first
 * dot decides (a GraphQL response key never contains one).
 */
function erroredPath(path: string, erroredPaths: ReadonlySet<string>): boolean {
  return erroredPaths.has(path) || erroredPaths.has(path.split('.')[0]!);
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
): Promise<{ unavailable: boolean; busy: boolean; paused: boolean }> {
  const [view, open, checks] = await Promise.all([
    loadAvailabilityByFamily(tx, [{ id: args.workerId, appId: args.appId, families: [] }], args.now),
    tx.agentTask.count({
      where: {
        assigneeWorkerId: args.workerId, status: { in: ['pending', 'started'] },
        ...(args.excludeTaskId ? { id: { not: args.excludeTaskId } } : {}),
      },
    }),
    // The roster's own derivation (PAUSED only for a worker with a live session), for this one worker, in this tx.
    loadWorkerCheckStatuses(tx, { appId: args.appId, teamChannelId: null, workerIds: [args.workerId], now: args.now }),
  ]);
  return {
    unavailable: view.get(args.workerId)?.ownInEffect === true,
    busy: open > 0,
    paused: checks.get(args.workerId)?.pendingReason === 'PAUSED',
  };
}

export type PendingWarnings = {
  /** Codes decided inside the write transaction (the assignee facts included: unavailable, busy, paused). */
  codes: TaskWarningCode[];
  /** Internal association from the committed row, never an input field. */
  taskId?: string;
};

/**
 * Request-local state shared by every warning a request files: what the gate and the register answered already (so
 * N aliased mutations do not repeat the lookup N times) and how much bounded-read time the request has spent.
 */
export type TaskWarningState = {
  spentMs: number;
  gate: Map<string, boolean>;
  registers: Map<string, TaskWarningRegister>;
  team: Map<string, string | null>;
};

/** All the enrichment a request may spend, summed over its operations; past it, only fixed code + text is filed. */
export const REQUEST_READ_BUDGET_MS = 2000;

const isFactCode = (c: TaskWarningCode): boolean => GATED_CODES.includes(c);

/**
 * Run `fn` in ONE short transaction: Postgres cancels any statement after {@link REGISTER_STATEMENT_TIMEOUT_MS}
 * (`SET LOCAL`, so nothing runs on after we stop waiting and the connection returns to the pool), the transaction
 * itself is cut after `timeout`, and `deadline` (a wall-clock ms) lets `fn` stop between steps. All bounded database work
 * the warnings add after a commit goes through here: the privacy gate and the register alike.
 */
export async function boundedRead<T>(
  ctx: Context,
  fn: (tx: Prisma.TransactionClient, deadline: number) => Promise<T>,
): Promise<T> {
  return ctx.db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${REGISTER_STATEMENT_TIMEOUT_MS}`);
    return fn(tx, Date.now() + REGISTER_TOTAL_BUDGET_MS);
  }, { timeout: REGISTER_TOTAL_BUDGET_MS + 500, maxWait: 500 });
}

/**
 * After the write committed: file the warnings the transaction decided. The fixed-text codes (no-source,
 * open-children) are filed whatever happens to the optional enrichment; the three assignee facts also need the
 * roster's privacy gate and fail CLOSED (dropped) if it cannot be answered; the register is optional guidance whose
 * lookup failing or timing out is `withheld` (#3491, ruling 0176). Never throws, and does no work once the response is full or the request has spent its
 * read budget.
 */
export async function emitTaskWarnings(
  ctx: Context,
  info: Pick<GraphQLResolveInfo, 'path'> | undefined | null,
  appId: string,
  pending: PendingWarnings,
): Promise<void> {
  try {
    // History is the fired population, BEFORE response caps and optional register/gate enrichment.
    if (pending.taskId) {
      const history = (ctx.taskWarningHistory ??= []);
      const path = warningPath(info);
      const actor = { ...eventActor(ctx.userId) };
      for (const code of RECORDED_TASK_WARNING_CODES) {
        if (pending.codes.includes(code) && !history.some(h => h.path === path && h.code === code)) {
          history.push({ appId, taskId: pending.taskId, path, code, actor });
        }
      }
    }
    const filed = (ctx.taskWarnings ??= []);
    // Cap BEFORE work: a warning that cannot be sent costs nothing.
    if (filed.length >= MAX_WARNINGS_PER_RESPONSE) return;
    const decided = normalise(pending.codes);
    if (decided.length === 0) return;
    const state = (ctx.taskWarningState ??= { spentMs: 0, gate: new Map(), registers: new Map(), team: new Map() });
    const agentId = currentActor().agentId;
    const needsGate = decided.some(isFactCode) && !state.gate.has(appId);
    const keyOf = (code: TaskWarningCode) => `${appId}\u0000${agentId}\u0000${code}`;
    const needsRegister = agentId !== null && decided.some((c) => !state.registers.has(keyOf(c)));
    if ((needsGate || needsRegister) && state.spentMs < REQUEST_READ_BUDGET_MS) {
      const started = Date.now();
      try {
        await boundedRead(ctx, async (tx, deadline) => {
          const txCtx = { ...ctx, db: tx, workerInternalsCache: new Map() } as unknown as Context;
          if (needsGate) state.gate.set(appId, await maySeeWorkerInternals(txCtx, appId));
          if (agentId) {
            // A deadline already spent by the gate read withholds the codes (resolveRegistersIn breaks before any read).
            const wanted = decided.filter((c) => (!isFactCode(c) || state.gate.get(appId) === true) && !state.registers.has(keyOf(c)));
            await resolveRegistersIn(tx, txCtx, state, appId, agentId, wanted, deadline);
          }
        });
      } catch {
        // The gate stays unanswered ⇒ the three facts are dropped below. A register that was to be read is withheld (#3491).
        if (agentId) for (const c of decided) if (!state.registers.has(keyOf(c)) && (!isFactCode(c) || state.gate.get(appId) === true)) state.registers.set(keyOf(c), WITHHELD_REGISTER);
      } finally {
        state.spentMs += Date.now() - started;
      }
    }
    const mayKnow = state.gate.get(appId) === true;
    const out = decided.filter((c) => !isFactCode(c) || mayKnow);
    const path = warningPath(info);
    for (const code of out) {
      const register = agentId ? state.registers.get(keyOf(code)) : undefined;
      filed.push({ path, warning: { code, text: TASK_WARNING_TEXT[code], ...(register ? { register } : {}) } });
    }
  } catch {
    // Advice must never fail a committed action.
  }
}

/** Unenriched, closed history record, captured before a response cap or actor-scope exit. */
export type TaskWarningHistory = { appId: string; taskId: string; path: string; code: RecordedTaskWarningCode; actor: EventActor };

/**
 * Consume once after field errors are known (GraphQL), or after the MCP result has been built. One bounded
 * post-commit transaction. No retries, no detached write, and no response mutation. Partial history is allowed; a
 * missing event is never proof that no warning fired. This independent write budget cannot truncate the fired
 * population merely because optional response enrichment or its size cap was exhausted.
 *
 * Where each limit is enforced: all of them come from {@link boundedRead}, the one helper the privacy gate and the
 * register use too, so history adds no tunable option of its own.
 * - 300 ms statement timeout: {@link REGISTER_STATEMENT_TIMEOUT_MS}, applied as `SET LOCAL statement_timeout`
 *   inside the transaction, per statement.
 * - 1000 ms cooperative deadline: {@link REGISTER_TOTAL_BUDGET_MS}; `boundedRead` hands `Date.now() + total` to its
 *   callback, and the loop below checks it between events (it cannot interrupt a statement already running).
 * - 1500 ms transaction timeout: `REGISTER_TOTAL_BUDGET_MS + 500`, the literal `timeout` option of the
 *   `$transaction` call in `boundedRead` (no named constant).
 * - 500 ms pool wait: the literal `maxWait` option of that same call, the time allowed to get a connection before
 *   the transaction starts.
 * These are per-limit bounds, not a wall-clock service SLA, and their sum is not a promised total.
 *
 * Its read budget is not shared with optional enrichment: `TaskWarningState.spentMs` and
 * {@link REQUEST_READ_BUDGET_MS} meter the gate and register reads, whereas this flush neither reads nor charges
 * them: it runs its own `boundedRead` invocation whatever those have spent.
 */
export async function flushTaskWarningHistory(ctx: Context, erroredPaths: ReadonlySet<string> = new Set()): Promise<void> {
  const pending = ctx.taskWarningHistory?.splice(0) ?? [];
  const successful = pending.filter(h => !erroredPath(h.path, erroredPaths));
  if (successful.length === 0) return;
  try {
    // Budgets (statement, deadline, transaction, pool wait) all come from boundedRead; see the JSDoc above.
    await boundedRead(ctx, async (tx, deadline) => {
      for (const h of successful) {
        if (Date.now() >= deadline) break;
        await appendTaskEvent(tx, { appId: h.appId, taskId: h.taskId, actor: h.actor, event: { type: 'task.warning', code: h.code } });
      }
    });
  } catch {
    // The operation committed already. Neither recording failure nor timeout changes its result; never retry.
  }
}

/**
 * Resolve each code through the register inside an open bounded read, storing the outcomes in the request state. The
 * deadline is checked between codes (the aggregate bound); a code not reached, or any failure, is `withheld`.
 * #3491 (ruling 0176): every system memory on the chains looked up (the Team Agent's and the caller Agent's) must be
 * readable by the CALLER under the canonical memory read gate, else `withheld`; the shared {@link answerWithLookup}
 * is the one gate, the same as for every action answer.
 */
async function resolveRegistersIn(
  tx: Prisma.TransactionClient,
  txCtx: Context,
  state: TaskWarningState,
  appId: string,
  agentId: string,
  codes: readonly TaskWarningCode[],
  deadline: number,
): Promise<void> {
  if (codes.length === 0) return;
  const keyOf = (code: TaskWarningCode) => `${appId}\u0000${agentId}\u0000${code}`;
  const c = withoutRequestCaches(txCtx, tx);
  // The ONE gate (#3491, ruling 0176): the shared lookup, whole chains, the same answer as every action answer.
  const lookup = new RegisterLookup(tx, c, appId, deadline, false, state.team.has(appId) ? state.team.get(appId) : undefined);
  let reached = 0;
  try {
    for (const code of codes) {
      if (Date.now() >= deadline) break; // aggregate bound: the rest are withheld below
      const answer = await answerWithLookup(lookup, c, code, agentId);
      state.registers.set(keyOf(code), answer.state === 'MAPPED' ? { state: 'mapped', taskLoc: answer.taskLoc!, taskUrn: answer.taskUrn! }
        : answer.state === 'UNMAPPED' ? { state: 'unmapped' } : answer.state === 'UNRESOLVED' ? { state: 'unresolved' } : WITHHELD_REGISTER);
      reached += 1;
    }
    // Only while budget remains: a spent deadline is routine (the codes are withheld below), not a failed lookup, and does no further read.
    if (!state.team.has(appId) && Date.now() < deadline) state.team.set(appId, await lookup.teamMemory());
  } catch {
    // Fixed category only: never log the caller, the code or the failure.
    // A throw once the budget is spent is routine exhaustion (the codes not reached are withheld below), not a failed lookup.
    if (Date.now() < deadline) console.warn('task_warning.register_failed');
  }
  // A failed or timed-out lookup is withheld, never a guess and never an error to the call.
  for (const code of codes.slice(reached)) state.registers.set(keyOf(code), WITHHELD_REGISTER);
}

type RegisterOutcome = Map<TaskWarningCode, TaskWarningRegister>;

/**
 * Resolve the register for `codes` for the current actor's Agent, standalone (its own request state): the map holds
 * an outcome per code. No Agent ⇒ empty and no lookup; a failed read ⇒ `withheld` for every code.
 */
export async function resolveRegisters(ctx: Context, appId: string, codes: readonly TaskWarningCode[]): Promise<RegisterOutcome> {
  const out: RegisterOutcome = new Map();
  const agentId = currentActor().agentId;
  if (!agentId || codes.length === 0) return out;
  const state: TaskWarningState = { spentMs: 0, gate: new Map(), registers: new Map(), team: new Map() };
  try {
    await boundedRead(ctx, async (tx, deadline) => {
      const txCtx = { ...ctx, db: tx, workerInternalsCache: new Map() } as unknown as Context;
      await resolveRegistersIn(tx, txCtx, state, appId, agentId, codes, deadline);
    });
  } catch {
    // The read transaction itself failed: nothing was answered, so every code is withheld.
    for (const code of codes) state.registers.set(`${appId}\u0000${agentId}\u0000${code}`, WITHHELD_REGISTER);
  }
  for (const code of codes) {
    const r = state.registers.get(`${appId}\u0000${agentId}\u0000${code}`);
    if (r) out.set(code, r);
  }
  return out;
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
    if (erroredPath(path, erroredPaths)) continue;
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
