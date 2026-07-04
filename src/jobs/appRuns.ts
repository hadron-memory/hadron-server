/**
 * Headless agent runs — mint, execute, listen, sweep (spec 040, plan §4–§6).
 *
 * The AppRun row is simultaneously the audit record, the ACTIVATION
 * (cor:agt:010:02 / D-2026-07-04-D: policy snapshot + live budgets + status,
 * re-checked on every action — zeroing a budget or CANCELLING halts the run),
 * and the outbox row for run.requested.v1 (publishedAt NULL ⇒ sweep
 * republishes).
 *
 * v1 kernel (D-2026-07-04-F): single-entry-node runs — instruction assembly
 * delegates to the runTask resolver (placeholder substitution + dependency
 * inlining + usage event), one LLM completion via src/lib/llm, output written
 * through the node-write core under the run's principal. Edge-walking, spawn,
 * schema envelopes: follow-on plan.
 *
 * Principal (cor:agt:010:01 / D-2026-07-04-C): Context{appId, userId?} —
 * the memory class gates apply unchanged, so a run without an on-behalf-of
 * user cannot touch personal/private memories, by construction.
 */

import type { PrismaClient, AppRun } from '../generated/prisma/index.js';
import { generateId } from '../lib/id.js';
import { getBusClient } from '../lib/bus/index.js';
import { evaluatePolicyChain, parsePolicyLink, type PolicyAction } from '../lib/policy/index.js';
import { resolveAiConfigWithFallback, NoAiConfigAvailableError } from '../lib/aiConfig.js';
import { generateText, LlmInvocationError, type LlmResult } from '../lib/llm/index.js';
import type { ResolvedAiConfig } from '../lib/aiConfig.js';

export const RUN_REQUESTED_SUBJECT = 'run.requested.v1';
export const RUN_QUEUE_GROUP = 'run-worker';

// Tunables (env-overridable where operations will want dials).
const DEFAULT_RUN_TOKEN_BUDGET = intEnv('RUN_DEFAULT_TOKEN_BUDGET', 100_000);
const DEFAULT_RUN_ACTION_BUDGET = intEnv('RUN_DEFAULT_ACTION_BUDGET', 50);
const DEFAULT_RUN_TIMEOUT_MS = intEnv('RUN_DEFAULT_TIMEOUT_MS', 120_000);
const QUOTA_RUNS_PER_DAY_APP = intEnv('QUOTA_RUNS_PER_DAY_APP', 200);
const QUOTA_RUNS_PER_DAY_ORG = intEnv('QUOTA_RUNS_PER_DAY_ORG', 1_000);
const QUOTA_TOKENS_PER_DAY_APP = intEnv('QUOTA_TOKENS_PER_DAY_APP', 2_000_000);
const QUOTA_TOKENS_PER_DAY_ORG = intEnv('QUOTA_TOKENS_PER_DAY_ORG', 10_000_000);

/** Parse a positive-integer env var, falling back when unset/invalid. */
function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw == null ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export class RunLaunchDeniedError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'QUOTA_EXCEEDED'
      | 'TRIGGER_DISABLED'
      | 'RELATIONSHIP_MISSING'
      | 'POLICY_DENIED'
      | 'APP_NOT_FOUND'
      | 'AGENT_NOT_INSTALLED',
  ) {
    super(message);
    this.name = 'RunLaunchDeniedError';
  }
}

// ── Quota counters (cor:acl:050:01/:04 tier 1) ──────────────────────────────

/** Start of the next UTC day — the daily quota window boundary. */
function nextUtcMidnight(): Date {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0);
  return d;
}

const QUOTA_WINDOW = 'day';

/**
 * Ensure the counter row exists (seeded with the platform-default limit) and
 * roll an expired window. The stored `limit` column is the enforced value
 * from then on — operators can raise/lower it per row and the default is
 * only the seed (PR-493 review, Gemini).
 */
async function ensureQuotaRow(
  db: PrismaClient,
  scopeKind: 'app' | 'org',
  scopeId: string,
  action: 'run.execute' | 'llm.tokens',
  defaultLimit: number,
): Promise<void> {
  try {
    await db.quotaCounter.create({
      data: {
        id: generateId(), scopeKind, scopeId, action,
        window: QUOTA_WINDOW, used: 0, limit: defaultLimit, resetAt: nextUtcMidnight(),
      },
    });
  } catch (err) {
    // Only the unique-constraint race is success (prisma-upsert-not-race-safe);
    // anything else — connectivity, permissions — must surface (PR-493 review).
    if ((err as { code?: string }).code !== 'P2002') throw err;
  }
  await db.quotaCounter.updateMany({
    where: { scopeKind, scopeId, action, window: QUOTA_WINDOW, resetAt: { lte: new Date() } },
    data: { used: 0, resetAt: nextUtcMidnight() },
  });
}

/**
 * Atomically consume `amount` iff the STORED limit has headroom. Raw SQL
 * because the check is column-vs-column (used + amount <= limit), which
 * Prisma's where cannot express.
 */
export async function consumeQuota(
  db: PrismaClient,
  scopeKind: 'app' | 'org',
  scopeId: string,
  action: 'run.execute' | 'llm.tokens',
  defaultLimit: number,
  amount = 1,
): Promise<boolean> {
  await ensureQuotaRow(db, scopeKind, scopeId, action, defaultLimit);
  const res = await db.$executeRaw`
    UPDATE quota_counters SET used = used + ${amount}
    WHERE scope_kind = ${scopeKind} AND scope_id = ${scopeId}
      AND action = ${action} AND "window" = ${QUOTA_WINDOW}
      AND used + ${amount} <= "limit"`;
  return res === 1;
}

/** Stored-limit headroom check WITHOUT consuming (the launch gate's token look-ahead). */
export async function hasQuotaHeadroom(
  db: PrismaClient,
  scopeKind: 'app' | 'org',
  scopeId: string,
  action: 'run.execute' | 'llm.tokens',
  defaultLimit: number,
): Promise<boolean> {
  await ensureQuotaRow(db, scopeKind, scopeId, action, defaultLimit);
  const row = await db.quotaCounter.findUnique({
    where: { scopeKind_scopeId_action_window: { scopeKind, scopeId, action, window: QUOTA_WINDOW } },
    select: { used: true, limit: true },
  });
  return row != null && row.used < row.limit;
}

/**
 * Record spend UNCONDITIONALLY (may exceed the limit — the honest ledger).
 * Used for post-hoc costs (LLM tokens are already spent at the provider when
 * usage is known); enforcement happens at the NEXT launch gate, which denies
 * while used >= limit (PR-493 review, Codex P2 — enforcement point chosen so
 * a completed run's paid-for output is never discarded).
 */
export async function recordQuotaUsage(
  db: PrismaClient,
  scopeKind: 'app' | 'org',
  scopeId: string,
  action: 'run.execute' | 'llm.tokens',
  defaultLimit: number,
  amount: number,
): Promise<void> {
  if (amount <= 0) return;
  await ensureQuotaRow(db, scopeKind, scopeId, action, defaultLimit);
  await db.quotaCounter.updateMany({
    where: { scopeKind, scopeId, action, window: QUOTA_WINDOW },
    data: { used: { increment: amount } },
  });
}

// ── Action tickets (cor:acl:050:01/:04 tier 2) ──────────────────────────────

/**
 * Atomically consume one unconsumed, unexpired ticket for the action —
 * app-scoped tickets are preferred over org-wide ones. Returns false when
 * the ledger has none (the caller SKIPS the outbound action and records
 * why — outbound communication never happens off-ledger).
 */
export async function consumeActionTicket(
  db: PrismaClient,
  organizationId: string,
  appId: string | null,
  action: string,
  runId: string,
): Promise<boolean> {
  const now = new Date();
  const candidates = await db.actionTicket.findMany({
    where: {
      organizationId,
      action,
      consumedAt: null,
      OR: [{ appId: null }, ...(appId ? [{ appId }] : [])],
      AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }],
    },
    orderBy: [{ appId: { sort: 'desc', nulls: 'last' } }, { createdAt: 'asc' }],
    take: 5,
    select: { id: true },
  });
  for (const t of candidates) {
    // Claim atomically — a raced ticket just moves to the next candidate.
    const res = await db.actionTicket.updateMany({
      // Re-check expiry at claim time: a ticket can lapse between the read
      // and the claim (PR-494 review).
      where: {
        id: t.id,
        consumedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      data: { consumedAt: now, consumedByRunId: runId },
    });
    if (res.count === 1) return true;
  }
  return false;
}

// ── Mint (plan §4 steps 1–2: launch gate + activation) ──────────────────────

export interface MintAppRunArgs {
  organizationId: string;
  appId: string;
  agentId?: string | null;
  userId?: string | null;
  triggerKind: 'SCHEDULE' | 'WEBHOOK' | 'MANUAL' | 'INTEGRATION';
  triggerId?: string | null;
  entryNodeUrn: string;
  eventData?: Record<string, unknown> | null;
  policy?: unknown;
  timeoutMs?: number | null;
  createdBy?: string | null;
}

export async function mintAppRun(db: PrismaClient, args: MintAppRunArgs): Promise<AppRun> {
  // 1. LAUNCH GATE (cor:acl:050:01). App live?
  const app = await db.app.findFirst({
    where: { id: args.appId, deletedAt: null },
    select: { id: true, organizationId: true },
  });
  if (!app || app.organizationId !== args.organizationId) {
    throw new RunLaunchDeniedError('App not found or not in this organization.', 'APP_NOT_FOUND');
  }
  // agentId must be an Agent actually installed in this App — otherwise the
  // AI-config walk would consult a FOREIGN agent's credentials (PR-493
  // review, Codex P1). Checked here (defense in depth) and at trigger
  // creation.
  if (args.agentId) {
    const installed = await db.appAgent.findFirst({
      where: { appId: args.appId, agentId: args.agentId },
      select: { agentId: true },
    });
    if (!installed) {
      throw new RunLaunchDeniedError(
        'agentId is not installed in this App.',
        'AGENT_NOT_INSTALLED',
      );
    }
  }
  // On-behalf-of relationship re-verified at launch, not only at trigger
  // creation (cor:agt:010:01): AppMember OR an active AgentSubscription to
  // any of the App's agents.
  if (args.userId) {
    const member = await db.appMember.findFirst({
      where: { appId: args.appId, userId: args.userId },
      select: { userId: true },
    });
    if (!member) {
      const sub = await db.agentSubscription.findFirst({
        where: {
          userId: args.userId,
          revokedAt: null,
          agent: { appAgents: { some: { appId: args.appId } } },
        },
        select: { userId: true },
      });
      if (!sub) {
        throw new RunLaunchDeniedError(
          'The on-behalf-of user has no live relationship with this App.',
          'RELATIONSHIP_MISSING',
        );
      }
    }
  }
  // Trigger-layer policy must allow run.execute at all (conjunction floor).
  const triggerLink = parsePolicyLink(args.policy);
  if (!evaluatePolicyChain('run.execute', [triggerLink])) {
    throw new RunLaunchDeniedError('Trigger policy does not allow run.execute.', 'POLICY_DENIED');
  }
  // Quota tier 1: runs/day per App AND per org (both must pass — consume
  // app first, refund on org denial to keep the counters truthful).
  if (!(await consumeQuota(db, 'app', args.appId, 'run.execute', QUOTA_RUNS_PER_DAY_APP))) {
    throw new RunLaunchDeniedError('App run quota exhausted for today.', 'QUOTA_EXCEEDED');
  }
  if (!(await consumeQuota(db, 'org', args.organizationId, 'run.execute', QUOTA_RUNS_PER_DAY_ORG))) {
    await db.quotaCounter.updateMany({
      where: { scopeKind: 'app', scopeId: args.appId, action: 'run.execute', window: 'day', used: { gt: 0 } },
      data: { used: { decrement: 1 } },
    });
    throw new RunLaunchDeniedError('Organization run quota exhausted for today.', 'QUOTA_EXCEEDED');
  }
  // Token look-ahead: deny NEW launches while the daily token ledger is at
  // or over its stored limit (the enforcement point for post-hoc token
  // spend — see recordQuotaUsage).
  if (!(await hasQuotaHeadroom(db, 'app', args.appId, 'llm.tokens', QUOTA_TOKENS_PER_DAY_APP))) {
    throw new RunLaunchDeniedError('App token quota exhausted for today.', 'QUOTA_EXCEEDED');
  }
  if (!(await hasQuotaHeadroom(db, 'org', args.organizationId, 'llm.tokens', QUOTA_TOKENS_PER_DAY_ORG))) {
    throw new RunLaunchDeniedError('Organization token quota exhausted for today.', 'QUOTA_EXCEEDED');
  }

  // 2. MINT the activation (AppRun row) + publish the wake-up.
  const run = await db.appRun.create({
    data: {
      id: generateId(),
      organizationId: args.organizationId,
      appId: args.appId,
      agentId: args.agentId ?? null,
      userId: args.userId ?? null,
      triggerKind: args.triggerKind,
      triggerId: args.triggerId ?? null,
      entryNodeUrn: args.entryNodeUrn,
      eventData: (args.eventData ?? undefined) as never,
      policy: (triggerLink ?? undefined) as never,
      budgetTokens: DEFAULT_RUN_TOKEN_BUDGET,
      budgetActions: DEFAULT_RUN_ACTION_BUDGET,
      timeoutMs: args.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
      createdBy: args.createdBy ?? null,
    },
  });
  await publishRunRequested(db, run.id);
  return run;
}

/** Publish + stamp publishedAt on success; NULL keeps the sweep republishing. */
async function publishRunRequested(db: PrismaClient, runId: string): Promise<void> {
  try {
    const bus = await getBusClient();
    if (!bus) return; // sweep-only mode (D-2026-06-17-004)
    await bus.publish(RUN_REQUESTED_SUBJECT, { runId }, { idempotencyKey: runId });
    await db.appRun.updateMany({ where: { id: runId, publishedAt: null }, data: { publishedAt: new Date() } });
  } catch (err) {
    console.error('[run-worker] publish failed (sweep will recover):', err);
  }
}

// ── Execute (plan §4 steps 3–5 + §6 kernel) ─────────────────────────────────

/** Injected in tests; production uses the real resolvers + LLM. */
export interface RunExecutionDeps {
  assemble: (run: AppRun) => Promise<string>;
  llm: (resolved: ResolvedAiConfig, req: { system?: string; prompt: string; maxTokens?: number }) => Promise<LlmResult>;
  writeOutput: (run: AppRun, text: string) => Promise<string | null>; // returns written node id/urn
  resolveConfig: (run: AppRun) => Promise<ResolvedAiConfig>;
  /** Fired once after a run reaches a terminal state (callback dispatch etc.). Best-effort. */
  onTerminal?: (run: AppRun) => Promise<void>;
}

export type RunOutcome = 'completed' | 'failed' | 'skipped' | 'transient';

/**
 * Claim + execute one run. Returns 'transient' ONLY for infra failures worth
 * a bus redelivery; run-level failures are recorded on the row (a failed run
 * is a result, not a retry — cor:agt:010:02).
 */
/**
 * Claim + execute one run, then fire the terminal hook (callback dispatch).
 * Returns 'transient' ONLY for infra failures worth a bus redelivery;
 * run-level failures are recorded on the row (a failed run is a result,
 * not a retry — cor:agt:010:02).
 */
export async function executeAppRun(
  db: PrismaClient,
  runId: string,
  deps: RunExecutionDeps,
): Promise<RunOutcome> {
  const outcome = await executeAppRunInner(db, runId, deps);
  if (outcome === 'completed' || outcome === 'failed') {
    // Terminal → fire the after-hook (webhook callbacks etc.). Best-effort:
    // a hook failure must never resurrect or re-fail the run.
    try {
      const fresh = await db.appRun.findUnique({ where: { id: runId } });
      if (fresh && deps.onTerminal) await deps.onTerminal(fresh);
    } catch (err) {
      console.error(`[run-worker] onTerminal hook failed for ${runId}:`, err);
    }
  }
  return outcome;
}

/** The §4 steps 3–5 sequence: atomic claim → per-action activation checks → LLM → output → finish. */
async function executeAppRunInner(
  db: PrismaClient,
  runId: string,
  deps: RunExecutionDeps,
): Promise<RunOutcome> {
  // 3. CLAIM — atomic PENDING→RUNNING (the #489 idiom; duplicate deliveries drop).
  const claimed = await db.appRun.updateMany({
    where: { id: runId, status: 'PENDING' },
    data: { status: 'RUNNING', startedAt: new Date(), attempts: { increment: 1 } },
  });
  if (claimed.count === 0) return 'skipped';
  const run = await db.appRun.findUniqueOrThrow({ where: { id: runId } });

  const fail = async (code: string, message: string): Promise<RunOutcome> => {
    // Guarded transition: a concurrent cancelAppRun must not be overwritten
    // to FAILED — the audit log keeps CANCELLED (PR-493 review, Gemini).
    const res = await db.appRun.updateMany({
      where: { id: runId, status: 'RUNNING' },
      data: { status: 'FAILED', failure: { code, message }, finishedAt: new Date() },
    });
    return res.count === 1 ? 'failed' : 'skipped';
  };

  try {
    const deadline = Date.now() + (run.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS);

    // 4. EXECUTE — every action re-checks the activation row + policy +
    // budget (the kill-switch contract).
    if (!(await checkActivation(db, runId, 'llm.invoke'))) {
      return fail('ACTIVATION_DENIED', 'Run cancelled, expired, or llm.invoke denied by policy.');
    }

    let instructions: string;
    try {
      instructions = await deps.assemble(run);
    } catch (err) {
      // Entry lookup/assembly failures are OBSERVABLE failed runs (D20/D15).
      return fail('ASSEMBLY_FAILED', String((err as Error)?.message ?? err));
    }

    let resolved: ResolvedAiConfig;
    try {
      resolved = await deps.resolveConfig(run);
    } catch (err) {
      if (err instanceof NoAiConfigAvailableError) {
        return fail('NO_AI_CONFIG', err.message);
      }
      throw err;
    }

    const budget = (await db.appRun.findUniqueOrThrow({ where: { id: runId }, select: { budgetTokens: true } }))
      .budgetTokens;
    let result: LlmResult;
    try {
      result = await deps.llm(resolved, {
        system:
          'You are executing a scheduled Hadron task. Follow the task instructions below. ' +
          'Produce ONLY the requested output document — no preamble, no meta-commentary.',
        prompt: instructions,
        ...(budget != null ? { maxTokens: Math.max(1, Math.min(budget, 32_000)) } : {}),
      });
    } catch (err) {
      if (err instanceof LlmInvocationError && err.transient && Date.now() < deadline) {
        // Bus redelivery is the retry path — reset the claim so the next
        // delivery can take it (bounded by max_deliver + the timeout reaper).
        await db.appRun.updateMany({
          where: { id: runId, status: 'RUNNING' },
          data: { status: 'PENDING' },
        });
        return 'transient';
      }
      return fail('LLM_FAILED', String((err as Error)?.message ?? err));
    }

    // Live decrement: run budget + daily token counters (kill switch stays
    // truthful even though this v1 kernel makes a single call).
    const spent = result.tokensIn + result.tokensOut;
    await db.appRun.updateMany({
      where: { id: runId },
      data: { budgetTokens: { decrement: Math.min(spent, budget ?? spent) } },
    });
    // Recorded even into overage — tokens are already spent at the provider;
    // the NEXT launch gate is the enforcement point (PR-493 Codex P2).
    await recordQuotaUsage(db, 'app', run.appId, 'llm.tokens', QUOTA_TOKENS_PER_DAY_APP, spent);
    await recordQuotaUsage(db, 'org', run.organizationId, 'llm.tokens', QUOTA_TOKENS_PER_DAY_ORG, spent);

    if (Date.now() >= deadline) {
      await db.appRun.updateMany({
        where: { id: runId, status: 'RUNNING' },
        data: { status: 'TIMED_OUT', finishedAt: new Date(), failure: { code: 'TIMEOUT' } },
      });
      return 'failed';
    }

    // Output write — its own activation re-check (memory.write) + action budget.
    if (!(await checkActivation(db, runId, 'memory.write', { actionCost: 1 }))) {
      return fail('ACTIVATION_DENIED', 'memory.write denied (policy, cancellation, or action budget).');
    }
    let writtenRef: string | null = null;
    try {
      writtenRef = await deps.writeOutput(run, result.text);
    } catch (err) {
      return fail('OUTPUT_WRITE_FAILED', String((err as Error)?.message ?? err));
    }

    // 5. FINISH — guarded for the same concurrent-cancel reason as fail().
    const finished = await db.appRun.updateMany({
      where: { id: runId, status: 'RUNNING' },
      data: {
        status: 'COMPLETED',
        finishedAt: new Date(),
        curNodeUrn: writtenRef ?? run.entryNodeUrn,
      },
    });
    if (finished.count === 0) return 'skipped'; // cancelled at the wire
    await db.usageEvent
      .create({
        data: {
          id: generateId(),
          type: 'app-run',
          nodeLoc: run.entryNodeUrn,
          appId: run.appId,
          createdBy: run.userId ?? null,
          model: result.model,
          tokensIn: result.tokensIn,
          tokensOut: result.tokensOut,
        },
      })
      .catch(() => {});
    return 'completed';
  } catch (err) {
    // Unexpected infra error: record, don't crash the listener.
    return fail('INTERNAL', String((err as Error)?.message ?? err));
  }
}

/**
 * The activation re-check (cor:agt:010:02): status live + policy allows +
 * (optionally) action budget headroom, decremented atomically on the same
 * statement so cancellation/zeroing halts the run at its next action.
 */
async function checkActivation(
  db: PrismaClient,
  runId: string,
  action: PolicyAction,
  opts: { actionCost?: number } = {},
): Promise<boolean> {
  const run = await db.appRun.findUnique({
    where: { id: runId },
    select: { status: true, policy: true, budgetActions: true, budgetTokens: true },
  });
  if (!run || run.status !== 'RUNNING') return false;
  if (!evaluatePolicyChain(action, [parsePolicyLink(run.policy)])) return false;
  if (run.budgetTokens != null && run.budgetTokens <= 0) return false; // zeroed = kill switch
  const cost = opts.actionCost ?? 0;
  if (cost > 0) {
    const res = await db.appRun.updateMany({
      where: { id: runId, status: 'RUNNING', budgetActions: { gte: cost } },
      data: { budgetActions: { decrement: cost } },
    });
    return res.count === 1;
  }
  return true;
}

// ── Listener + sweep (plan §5) ──────────────────────────────────────────────

export async function startAppRunBusListener(
  db: PrismaClient,
  deps: RunExecutionDeps,
): Promise<(() => Promise<void>) | null> {
  const bus = await getBusClient();
  if (!bus) return null;
  const unsubscribe = await bus.subscribeQueue(RUN_REQUESTED_SUBJECT, RUN_QUEUE_GROUP, async (msg) => {
    const payload = msg.payload as { runId?: unknown } | null;
    const runId = payload && typeof payload === 'object' ? payload.runId : undefined;
    if (typeof runId !== 'string' || runId === '') {
      console.warn('[run-worker] ignoring malformed run.requested payload');
      return;
    }
    const outcome = await executeAppRun(db, runId, deps);
    if (outcome === 'transient') {
      throw new Error(`transient failure for run ${runId} — nak for redelivery`);
    }
  });
  console.log(`[run-worker] bus listener active on ${RUN_REQUESTED_SUBJECT}`);
  return unsubscribe;
}

/**
 * Sweep (60s): republish unpublished PENDING runs (or execute them directly
 * in no-bus mode), and reap RUNNING runs past their timeout → TIMED_OUT.
 */
export function startAppRunSweepLoop(
  db: PrismaClient,
  deps: RunExecutionDeps,
  opts: { intervalMs?: number } = {},
): NodeJS.Timeout {
  const intervalMs = opts.intervalMs ?? 60_000;
  const tick = async () => {
    try {
      const bus = await getBusClient();
      const stale = await db.appRun.findMany({
        where: { status: 'PENDING' },
        orderBy: { createdAt: 'asc' },
        take: 25,
        select: { id: true, publishedAt: true },
      });
      for (const r of stale) {
        if (bus) {
          if (!r.publishedAt) await publishRunRequested(db, r.id);
        } else {
          await executeAppRun(db, r.id, deps); // standalone mode drains directly
        }
      }
      // Timeout reaper (D24): RUNNING past its deadline → TIMED_OUT. Uses
      // startedAt + timeoutMs; rows with no timeout use the platform default.
      const running = await db.appRun.findMany({
        where: { status: 'RUNNING' },
        select: { id: true, startedAt: true, timeoutMs: true },
      });
      const now = Date.now();
      for (const r of running) {
        const limit = (r.startedAt?.getTime() ?? now) + (r.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS);
        if (now > limit + 5_000) {
          await db.appRun.updateMany({
            where: { id: r.id, status: 'RUNNING' },
            data: { status: 'TIMED_OUT', finishedAt: new Date(), failure: { code: 'TIMEOUT' } },
          });
        }
      }
    } catch (err) {
      console.error('[run-worker] sweep error:', err);
    }
  };
  return setInterval(() => void tick(), intervalMs);
}
