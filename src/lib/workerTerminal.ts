/**
 * #2771 (Worker.terminal; proposed cor:agt:070:09, cor:dmo:050:11 Working-state row) — the one module that owns the
 * shape of a worker's stored terminal report.
 *
 * A host's on-host sweep classifies each registered worker's terminal and reports it. The server BUILDS the stored
 * object from the validated fields; nothing is stored as received, and no screen text of any kind is accepted or
 * stored (cor:agt:050:11; D-2026-10-16-005 amended, Holger R65). `reason` is therefore a closed code, never a line.
 *
 * The field decides nothing: it feeds no `checkStatus` (cor:agt:100:03 stays derived), no availability
 * (cor:agt:060:08), no matcher, no stall rule and no server alarm.
 */

/** The terminal states a host reports. */
export const TERMINAL_STATUSES = ['busy', 'idle', 'locked', 'dark'] as const;
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

/** What the input prompt looked like. */
export const TERMINAL_PROMPTS = ['empty', 'not_empty', 'menu', 'unknown'] as const;
export type TerminalPrompt = (typeof TERMINAL_PROMPTS)[number];

/** The closed reason codes (hadron-cli#1187). Required for `locked`/`dark`, null otherwise. */
export const TERMINAL_REASONS = [
  'model_at_capacity',
  'token_budget_exhausted',
  'rate_limited',
  'guardrail_triggered',
  'menu_or_question',
  'shed_staged_not_relaunched',
  'unrecognized',
  'no_turn_for_due_ticker',
  'no_terminal',
  'bare_shell',
  'no_agent',
] as const;
export type TerminalReason = (typeof TERMINAL_REASONS)[number];

/** The keys of the stored object, exactly. The DB CHECK on `workers.terminal` lists the same keys. */
export const TERMINAL_KEYS = ['host', 'status', 'prompt', 'reason', 'lastTurnAt', 'checkedAt', 'reportedAt'] as const;

/** The most reports one call carries. */
export const TERMINAL_REPORT_MAX = 200;

/** How far ahead of the server's clock a host's `checkedAt` may be, in ms. */
export const TERMINAL_CHECKED_AT_SKEW_MS = 2 * 60 * 1000;

/** The stored object. */
export type WorkerTerminal = {
  host: { id: string; label: string };
  status: TerminalStatus;
  prompt: TerminalPrompt;
  reason: TerminalReason | null;
  lastTurnAt: string | null;
  checkedAt: string;
  reportedAt: string;
};

/** One report as a host sends it. */
export type TerminalReportInput = {
  worker: string;
  status: string;
  prompt: string;
  reason?: string | null;
  lastTurnAt?: Date | string | null;
  checkedAt: Date | string;
};

/** A report that passed whole-batch validation. */
export type ValidTerminalReport = {
  worker: string;
  status: TerminalStatus;
  prompt: TerminalPrompt;
  reason: TerminalReason | null;
  lastTurnAt: Date | null;
  checkedAt: Date;
};

const KEY_SET = new Set<string>(['worker', 'status', 'prompt', 'reason', 'lastTurnAt', 'checkedAt']);

/**
 * Validate a whole batch (cor:agt:070:09): the sender's bugs refuse the batch and nothing is stored. Returns the first
 * problem as a message, or the validated reports. Pure: the caller owns the clock.
 */
export function validateTerminalBatch(
  reports: readonly TerminalReportInput[] | null | undefined,
  now: Date,
): { ok: true; reports: ValidTerminalReport[] } | { ok: false; message: string } {
  if (!Array.isArray(reports) || reports.length === 0) return { ok: false, message: 'reports must name at least one worker.' };
  if (reports.length > TERMINAL_REPORT_MAX) return { ok: false, message: `reports carries at most ${TERMINAL_REPORT_MAX} entries.` };
  const seen = new Set<string>();
  const out: ValidTerminalReport[] = [];
  for (const r of reports) {
    if (!r || typeof r !== 'object') return { ok: false, message: 'Each report must be an object.' };
    for (const k of Object.keys(r)) if (!KEY_SET.has(k)) return { ok: false, message: `A report has no field "${k}".` };
    if (typeof r.worker !== 'string' || r.worker.length === 0) return { ok: false, message: 'Each report names a worker.' };
    if (seen.has(r.worker)) return { ok: false, message: 'A worker is reported at most once per call.' };
    seen.add(r.worker);
    if (!(TERMINAL_STATUSES as readonly string[]).includes(r.status)) return { ok: false, message: 'status is not a known terminal state.' };
    if (!(TERMINAL_PROMPTS as readonly string[]).includes(r.prompt)) return { ok: false, message: 'prompt is not a known prompt state.' };
    const needsReason = r.status === 'locked' || r.status === 'dark';
    const reason = r.reason ?? null;
    if (needsReason && reason === null) return { ok: false, message: 'A locked or dark report carries a reason code.' };
    if (!needsReason && reason !== null) return { ok: false, message: 'A busy or idle report carries no reason.' };
    if (reason !== null && !(TERMINAL_REASONS as readonly string[]).includes(reason)) {
      return { ok: false, message: 'reason is not one of the closed codes.' };
    }
    const checkedAt = r.checkedAt instanceof Date ? r.checkedAt : new Date(r.checkedAt);
    if (Number.isNaN(checkedAt.getTime())) return { ok: false, message: 'checkedAt is not a time.' };
    if (checkedAt.getTime() > now.getTime() + TERMINAL_CHECKED_AT_SKEW_MS) return { ok: false, message: 'checkedAt is in the future.' };
    let lastTurnAt: Date | null = null;
    if (r.lastTurnAt !== null && r.lastTurnAt !== undefined) {
      const turn = r.lastTurnAt instanceof Date ? r.lastTurnAt : new Date(r.lastTurnAt);
      if (Number.isNaN(turn.getTime())) return { ok: false, message: 'lastTurnAt is not a time.' };
      if (turn.getTime() > checkedAt.getTime()) return { ok: false, message: 'lastTurnAt is after checkedAt.' };
      lastTurnAt = turn;
    }
    out.push({ worker: r.worker, status: r.status as TerminalStatus, prompt: r.prompt as TerminalPrompt, reason: reason as TerminalReason | null, lastTurnAt, checkedAt });
  }
  return { ok: true, reports: out };
}

/** Build the stored object. `host` is the key's host and its registration's label, never the request's. */
export function buildWorkerTerminal(r: ValidTerminalReport, host: { id: string; label: string }, reportedAt: Date): WorkerTerminal {
  return {
    host: { id: host.id, label: host.label },
    status: r.status,
    prompt: r.prompt,
    reason: r.reason,
    lastTurnAt: r.lastTurnAt ? r.lastTurnAt.toISOString() : null,
    checkedAt: r.checkedAt.toISOString(),
    reportedAt: reportedAt.toISOString(),
  };
}

/** The stored object as read back: the ISO strings the server wrote. */
export type StoredWorkerTerminal = WorkerTerminal;

/** The GraphQL view of a stored report: the same object with its instants as Dates, or null. */
export function workerTerminalView(t: StoredWorkerTerminal | null | undefined) {
  if (!t) return null;
  return {
    host: t.host,
    status: t.status,
    prompt: t.prompt,
    reason: t.reason,
    lastTurnAt: t.lastTurnAt ? new Date(t.lastTurnAt) : null,
    checkedAt: new Date(t.checkedAt),
    reportedAt: new Date(t.reportedAt),
  };
}
