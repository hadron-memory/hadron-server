/**
 * Ticker-only wake delivery for an Orca host (Hugo, 2026-10-18; corrected after
 * the #2070 gate, 2026-10-19).
 *
 * Delivers wakes that carry a TICK or a task ASSIGNMENT, from hadron dueWakes
 * to the worker's terminal, then acks the wake by proof. Mentions are not
 * relayed: chat posts reach terminals through hadron-chat-send. Interim until
 * hadron-cli#907 (C1); shares no token, ledger or lock with the attention router.
 *
 * #2138 §5.2: the nudge names the commands: learn its read mark C from one
 * `team chat read --mentions-me --limit 1`, read everything tagged from C with
 * `--since C --all`, act, then, only if that read succeeded, `team chat
 * mark-read` through the head it printed (never an unfiltered catch-up). A
 * `live-check` ticker fires an ordinary TICK reason, so it is delivered exactly
 * like any other tick: the wake names the ticker, not why it fired.
 *
 * Per-reason contract (#2070 gate, Vera's receipt; updated for #2102 and #2138):
 *  - a wake whose reasons are TICK, or TICK joined with MENTION: nudge once, then
 *    ack it. Since #2069 (landed in #2102) a MENTION-only reservation absorbs a
 *    later tick, so a worker holding an outstanding mention is offered a
 *    TICK+MENTION wake; skipping it would starve that worker of ticks. Since R53
 *    (#2072, cor:agt:080:04/:16) acknowledging a wake moves NO message mark: it
 *    records the tick and spends the reservation, and the mention stays unread
 *    and due (it is delivered by an S1 batch / hadron-chat-send, never by this
 *    script). The nudge tells the worker to run its standing routine and read only its own
 *    mentions; it forbids an unfiltered chat catch-up.
 *  - a TASK reason for an assignment (ASSIGNED, REASSIGNED, MATCHED; #2138
 *    §5.2), alone or joined with ticks or a mention: nudged once, naming the
 *    task, then acked. The ack records the task event delivered (T5 receipts),
 *    which is now true: the nudge named it. Task events are covered by the
 *    receipt like ticks, so one is never named twice to the same receiver.
 *  - any wake carrying another reason (another task event such as ALARM,
 *    CHILD_FINISHED or END_SESSION, a TASK reason without its task, or an
 *    unknown kind): left alone, neither nudged nor acked, because its proof
 *    would record those events delivered unseen.
 *  - a MENTION-only wake is ignored and never acked: there is no mention-ack
 *    path in this script.
 *
 * Safety:
 *  - timing is the server's (R63): nothing is typed before the wake's
 *    deliverAfter; a busy terminal is held until its busyDeadline, after which
 *    busy alone stops vetoing. Anchors/floors are never recomputed or remembered
 *    here, so a re-offer, join or restart cannot restart them.
 *  - the composer rules are unconditional, deadline or not: a nudge is typed
 *    only when a read shows the composer empty with no Orca draft, even when
 *    tui-idle holds; a draft, question/menu, unknown input or identity holds.
 *    Nothing is cleared or interrupted.
 *  - a CONFIRMED send (Orca's stages include `turn_started`) is recorded in a durable
 *    receipt, with the tick coverage and the receiving terminal, BEFORE the
 *    ack. A lost ack is retried ack-only, only for a proof fully covered by a
 *    receipt for the same receiver. An accepted-but-unconfirmed or unparsable
 *    send is AMBIGUOUS: never retyped, never acked, kept until a human
 *    reconciles it (delete its entry in receipts.json). Unreadable or
 *    malformed receipt state stops the pass: fail closed.
 *  - an ambiguous send is resolved WITHOUT a person only on evidence (#2138, proposal #26055, approved #26060): after
 *    its request is reissued by id and still not confirmed, it becomes a delivered receipt only when Orca accepted the
 *    input, the receiver is the same, the composer reads provably empty, and the worker's own session checked the team
 *    channel after the send (any covered task must also be STARTED by it). A timeout alone never resolves it: after 2
 *    cadences without evidence it stays held and is logged as needing a person.
 *  - one instance per state dir (atomic lock file).
 *
 * A pass fits inside one cadence (#2138 experiment, Hugo's tick 1, #26038): a busy terminal is PROBED, never waited
 * on, so it is held to a later pass instead of costing a busy-wait; the oldest wakes go first, and once the pass
 * budget is spent the rest wait for the next pass; a proof near the end of its 15-minute life, or one the server calls
 * stale, is re-fetched before the ack; the loop runs on fixed slots and skips (and logs) a slot a pass overran.
 *
 * usage: tsx ticker-wake.ts once [--dry] [--budget <seconds>=300]
 *        tsx ticker-wake.ts loop [--interval <seconds>=120] [--budget <seconds>=interval]
 */
import { spawn } from 'node:child_process';
import { linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadConfig, DEFAULT_CONFIG, runCommand, listTerminals, resolveTerminal,
  readScreen, promptIsEmptyFromTerm, screenAgentFamily, isIdle, idleProofAbovePrompt,
  CALL_TIMEOUT_MS, type Config, type Runner, type RunResult,
} from '../orca-attention-router/router.js';

/** A runner that does not block: the sends of different workers overlap. */
export type AsyncRunner = (argv: string[]) => Promise<RunResult>;

/**
 * The asynchronous twin of the router's `runCommand`, with the same fail-closed contract: a spawn error or a call past
 * the hard timeout (SIGKILL) is code 1 with EMPTY stdout, so a result the failure invalidated never reaches a caller.
 */
export const runCommandAsync: AsyncRunner = (argv) => new Promise((resolveRun) => {
  let stdout = '';
  let stderr = '';
  let done = false;
  const finish = (r: RunResult): void => { if (!done) { done = true; clearTimeout(timer); resolveRun(r); } };
  const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
  const timer = setTimeout(() => { child.kill('SIGKILL'); finish({ code: 1, stdout: '', stderr: `call exceeded ${CALL_TIMEOUT_MS}ms and was killed` }); }, CALL_TIMEOUT_MS);
  child.stdout.setEncoding('utf8').on('data', (d: string) => { stdout += d; });
  child.stderr.setEncoding('utf8').on('data', (d: string) => { stderr += d; });
  child.on('error', (e: NodeJS.ErrnoException) => finish({ code: 1, stdout: '', stderr: `call failed: ${e.code ?? 'error'}` }));
  child.on('close', (code, signal) => finish(code === null
    ? { code: 1, stdout: '', stderr: `call ended by ${signal ?? 'a signal'}` }
    : { code, stdout, stderr }));
});

export const QUERY = `query($a:String!,$p:String){dueWakes(appRef:$a,first:100,after:$p){wakes{worker{id name} reasons{kind ticker{id name} task{id eventId chainIndex event}} proof anchorAt deliverAfter busyDeadline} pageInfo{hasNextPage endCursor}}}`;
export const ACK = `mutation($p:[String!]!){acknowledgeWakes(proofs:$p){acknowledged unchanged}}`;
/** The worker's own last team-channel check (#2138 §3.4; stamped only through its own session). */
export const WORKER_CHECK = `query($w:ID!,$a:ID){worker(ref:$w,appRef:$a){id checkStatus{lastCheckedAt}}}`;
/** A covered task's state and assignee. */
export const TASK_STATE = `query($t:ID!){agentTask(id:$t){id status assignee{kind id}}}`;
const MAX_PAGES = 10;
/**
 * The tui-idle probe. It proves idle without waiting for business to clear (the router's RECHECK_IDLE_TIMEOUT_MS
 * rule); a busy terminal falls through to the screen read and the server's busyDeadline, and is otherwise held to a
 * later pass. Waiting `busyWaitMs` per busy worker is what made tick 1's serial pass run ~30 min.
 */
export const IDLE_PROBE_MS = 500;
/** A `once` pass's default budget: half the 600 s team-tick cadence, so a pass ends well inside one cadence. */
export const DEFAULT_ONCE_BUDGET_S = 300;
/** A proof older than this is re-fetched before its ack: the server refuses one past 15 minutes (WAKE_PROOF_MAX_AGE_MS). */
export const PROOF_REFRESH_AFTER_MS = 10 * 60 * 1000;
/** An ambiguous send with no delivery evidence after this long (2 cadences of the 600 s team-tick) is listed for a person. */
/**
 * How long a send observes the accepted prompt for a turn start (`--wait-submit`). Orca only observes for this long;
 * a timeout returns the input-accepted receipt and never resends. It almost never confirms in time (#26099: two 15 s
 * observations were ~30 s of every resolve+send), and since #2154 an accepted send is resolved on evidence later, so a
 * short look is enough. Its own constant: `submitWaitS` belongs to the shared router config.
 */
export const SUBMIT_PROBE_S = 2;
/** Sends in flight at once. Each lane is one terminal; the reads around a send stay serial. */
export const DELIVERY_POOL = 8;
export const NEEDS_PERSON_AFTER_MS = 20 * 60 * 1000;
/** A channel check counts as after the send only past this margin, so host/server clock skew cannot pass an earlier one. */
export const CHECK_CLOCK_MARGIN_MS = 5_000;
/** The task states that prove the assignee saw its assignment. */
const TASK_SEEN: ReadonlySet<string> = new Set(['STARTED', 'FINISHED']);
/** Orca took the input (send.accepted) but no turn start was seen: the only ambiguity evidence may resolve. */
const ACCEPTED_DETAIL = 'accepted, turn start not confirmed';
const wasAccepted = (detail: string): boolean => detail.split('; same-id retry: ').some((p) => p.startsWith(ACCEPTED_DETAIL));
/** The task events that mean "a task was assigned to you" (#2138 §5.2); every other task event is left alone. */
export const ASSIGNMENT_EVENTS: ReadonlySet<string> = new Set(['ASSIGNED', 'REASSIGNED', 'MATCHED']);
/** A task id is typed into a terminal, so only a plain id shape is accepted; anything else holds the wake. */
const TASK_ID = /^[A-Za-z0-9_-]{1,64}$/;

type Log = (line: string) => void;
/**
 * `budgetMs`: no new delivery starts once this long has passed since the pass began (default DEFAULT_ONCE_BUDGET_S).
 * `runAsync`: runs the sends, so they can overlap; without it the synchronous runner is wrapped (tests).
 */
export interface Opts { dry?: boolean; now?: () => number; budgetMs?: number; runAsync?: AsyncRunner }

/** What a confirmed send covered, and who received it. */
interface Delivered { state: 'sent'; coverage: string[]; receiver: string; at: number }
/**
 * An accepted-but-unconfirmed or failed-after-possible-submission send, kept until reconciled. `tasks` maps each task
 * coverage key THIS send newly named to its task id, recorded at send time because starting the task removes its wake
 * (#2154 P2); absent on a receipt written before it existed, which then cannot be resolved on task evidence.
 */
interface Ambiguous { state: 'ambiguous'; coverage: string[]; receiver: string; at: number; detail: string; text: string; handle: string; requestId?: string; tasks?: Record<string, string> }
type Receipt = Delivered | Ambiguous;
type Receipts = Record<string, Receipt>; // by worker id

/** A task event's coverage key ("task:<eventId>#<chainIndex>"), shared by the proof and the wake's reasons. */
const taskKey = (eventId: unknown, chainIndex: unknown): string => `task:${eventId}#${chainIndex}`;

/**
 * Everything a proof carries that a nudge must name: its ticks ("tickerId:k") and its task events (`taskKey`), sorted.
 * Null when the payload cannot be decoded, names nothing, or carries an entry with a missing part.
 */
export function proofCoverage(proof: string): string[] | null {
  try {
    const body = JSON.parse(Buffer.from(proof.split('.')[0], 'base64url').toString('utf8'));
    const ticks = (body.ticks ?? []).map((t: any) => `${t.tickerId}:${t.k}`);
    const tasks = (body.tasks ?? []).map((t: any) => taskKey(t.eventId, t.chainIndex));
    const all = [...ticks, ...tasks];
    return all.length && all.every((t: string) => !t.includes('undefined')) ? all.sort() : null;
  } catch { return null; }
}

function receiptsPath(dir: string): string { return join(dir, 'receipts.json'); }
/** Missing file is empty state; anything unreadable or malformed THROWS (fail closed: no send, no ack). */
function loadReceipts(dir: string): Receipts {
  let raw: string;
  try { raw = readFileSync(receiptsPath(dir), 'utf8'); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new SafeError(`receipts unreadable (${errno(e)}); stopping rather than risk a retype`);
  }
  const bad = (): never => { throw new SafeError('receipts malformed; stopping rather than risk a retype'); };
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch { return bad(); }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return bad(); // [] would be silently rewritten as []
  for (const [id, r] of Object.entries(parsed) as [string, any][]) {
    const common = id !== '' && r && typeof r === 'object' && !Array.isArray(r)
      && Array.isArray(r.coverage) && r.coverage.length > 0 && r.coverage.every((c: unknown) => typeof c === 'string' && c !== '')
      && typeof r.receiver === 'string' && r.receiver !== '' && typeof r.at === 'number' && Number.isFinite(r.at);
    if (!common) return bad();
    if (r.state === 'sent') continue;
    if (r.state !== 'ambiguous' || typeof r.detail !== 'string' || typeof r.text !== 'string' || typeof r.handle !== 'string'
      || (r.requestId !== undefined && typeof r.requestId !== 'string')) return bad();
    if (r.tasks !== undefined && (r.tasks === null || typeof r.tasks !== 'object' || Array.isArray(r.tasks)
      || !Object.entries(r.tasks).every(([k, v]) => k.startsWith('task:') && r.coverage.includes(k) && typeof v === 'string' && TASK_ID.test(v)))) return bad();
  }
  return parsed as Receipts;
}
function saveReceipts(dir: string, r: Receipts): void {
  const tmp = `${receiptsPath(dir)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(r));
  renameSync(tmp, receiptsPath(dir));
}

/**
 * Diagnostics are logged and stored as a FIXED CLASS plus, when the server or Orca named one, an error CODE. Never the raw
 * message, stderr or error object: those can echo an opaque wake proof, a typed nudge, a composer draft or a credential
 * (#2070 LOCAL P2-2). A code is kept only if it looks like one.
 */
const PUBLIC_CODES: ReadonlySet<string> = new Set([
  // hadron server (GraphQL extensions.code): Apollo built-ins and the wake refusals this loop can meet
  'BAD_USER_INPUT', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'APP_NOT_FOUND', 'APP_UNINSTALLED', 'GRAPHQL_VALIDATION_FAILED',
  'GRAPHQL_PARSE_FAILED', 'INTERNAL_SERVER_ERROR', 'PERSISTED_QUERY_NOT_FOUND', 'WAKE_PROOF_INVALID',
  'WAKE_PROOF_REQUESTER_MISMATCH', 'WAKE_PROOF_STALE',
  // Orca (terminal list / send errors)
  'backend_failure', 'composer_not_empty', 'invalid_argument', 'not_accepted', 'terminal_handle_stale', 'terminal_list_failed',
  'timeout', 'transport',
  // POSIX errno from this process's own filesystem and spawn calls
  'ENOENT', 'EACCES', 'EPERM', 'EEXIST', 'EISDIR', 'ENOTDIR', 'ENOTEMPTY', 'ENOSPC', 'EROFS', 'EIO', 'EMFILE', 'ENFILE', 'EBUSY',
  'EAGAIN', 'EINVAL', 'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE',
]);
/**
 * A code is VALIDATED AGAINST THAT FIXED VOCABULARY, never by its character shape: arbitrary private text can look exactly
 * like a code (#2070 §10 delta). A known code is kept; any other string that was present collapses to the class `other`;
 * a missing code stays absent.
 */
function safeCode(v: unknown): string | undefined {
  if (typeof v !== 'string' || v === '') return undefined;
  return PUBLIC_CODES.has(v) ? v : 'other';
}
const errno = (e: unknown): string => safeCode((e as NodeJS.ErrnoException)?.code) ?? 'error';
/** Standard error classes only: a dynamic or custom name is untrusted text and collapses to `other`. */
const KNOWN_NAMES: ReadonlySet<string> = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'RouterError']);
const safeName = (n: unknown): string => (typeof n === 'string' && KNOWN_NAMES.has(n) ? n : 'other');

/** An error THIS script raised, with a message it controls (class, code, pid, path): safe to log as written. */
export class SafeError extends Error {}

/**
 * The only way an exception becomes log text. This script's own SafeErrors keep their message; anything else (a router
 * helper's RouterError, a runner or filesystem exception, a bug) is reduced to a class plus an allowlisted code, because its
 * message can carry Orca or hadron output, a typed nudge, a draft or a proof (#2070 LOCAL P2-2, outer catch).
 */
export function describeError(e: unknown): string {
  if (e instanceof SafeError) return scrub(e.message);
  const name = safeName((e as Error)?.name);
  const code = safeCode((e as NodeJS.ErrnoException)?.code)
    ?? safeCode(String((e as Error)?.message ?? '').match(/"code"\s*:\s*"([^"]{1,64})"/)?.[1]);
  return `${name === 'RouterError' ? 'helper failed' : `unexpected ${name}`}${code ? ` (${code})` : ''}`;
}

/**
 * Orca's send stages come from its reply, so an unexpected string must not become text: the known stage names pass, anything
 * else is the class `other` (the length is kept, so the confirmed/uncertain logic is unchanged).
 */
const STAGES = new Set(['input_accepted', 'turn_started', 'no_turn_started_yet', 'not_accepted']);
const stageClass = (s: unknown): string => (typeof s === 'string' && STAGES.has(s) ? s : 'other');

/**
 * A stored `detail` (it outlives this process, and an older version wrote raw text) is logged only if it is exactly one of the
 * shapes THIS version writes; anything else is withheld. A same-id retry joins two such shapes.
 */
const CODE_SHAPE = `(?:other|${[...PUBLIC_CODES].join('|')})`;
const STAGE_SHAPE = '(?:input_accepted|turn_started|no_turn_started_yet|not_accepted|other)';
const DETAIL_SHAPES: RegExp[] = [
  /^send intent recorded before submission; outcome unknown$/,
  /^unparsable send receipt$/,
  /^unrecognized send receipt$/,
  new RegExp(`^accepted, turn start not confirmed \\((?:no stages|${STAGE_SHAPE}(?:,${STAGE_SHAPE})*)\\)$`),
  new RegExp(`^failed with a request identity(?: \\(${CODE_SHAPE}\\))?$`),
  new RegExp(`^send refused(?:: ${CODE_SHAPE})?$`),
];
export function safeDetail(d: unknown): string {
  const s = typeof d === 'string' ? d : '';
  const parts = s.split('; same-id retry: ');
  return parts.length <= 2 && parts.every((p) => DETAIL_SHAPES.some((re) => re.test(p))) ? s : 'recorded detail withheld';
}

/**
 * Last line of defence at the log sink: anything token-shaped that still reaches a log line (a `body.signature` proof, a
 * long opaque run, a bearer or key prefix) is replaced. The classes above are what keep text and messages out; this
 * catches an accident. Terminal handles (`term_<uuid>`) are left readable.
 */
export function scrub(s: string): string {
  return s
    .replace(/\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g, '[redacted]')
    .replace(/\b(?!term_)[A-Za-z0-9_-]{48,}\b/g, '[redacted]')
    .replace(/\b(?:Bearer\s+|hdr_[a-z]+_)[A-Za-z0-9._-]+/gi, '[redacted]')
    .slice(0, 600);
}

/** Parse a hadron api reply; throws a class-only error on GraphQL/transport failure (never the server's message). */
function gql(run: Runner, argv: string[]): any {
  const res = run(argv);
  let data: any;
  try { data = JSON.parse(res.stdout); } catch { throw new SafeError('unparsable reply'); }
  if (data.errors?.length || data.error) {
    const code = safeCode(data.errors?.[0]?.extensions?.code) ?? safeCode(data.error?.code);
    throw new SafeError(code ? `graphql error ${code}` : 'graphql error');
  }
  return data.data;
}

/** When the proof was issued (ms), from its payload; null when it does not say. */
export function proofIssuedAt(proof: string): number | null {
  try {
    const v = JSON.parse(Buffer.from(proof.split('.')[0], 'base64url').toString('utf8')).issuedAt;
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  } catch { return null; }
}

/** Read every page of dueWakes (at most MAX_PAGES); `more` says pages were left unread. */
function fetchDue(cfg: Config, run: Runner): { wakes: any[]; more: boolean } {
  const wakes: any[] = [];
  let page: string | null = null;
  let more = false;
  for (let n = 0; n < MAX_PAGES; n++) {
    const argv = [cfg.hadronCli, 'api', QUERY, '-F', `a=${cfg.app}`];
    if (page) argv.push('-F', `p=${page}`);
    const d = gql(run, argv).dueWakes;
    if (!d) throw new SafeError('dueWakes returned no result');
    wakes.push(...d.wakes);
    more = Boolean(d.pageInfo?.hasNextPage);
    if (!more) break;
    page = d.pageInfo.endCursor;
  }
  return { wakes, more };
}

/**
 * Ack a worker's wake whose work is all in `covered` (a confirmed receipt for the same receiver). A proof near the end
 * of its life is re-fetched first, and a proof the server calls stale is re-fetched once and retried: the fresh proof
 * is acked only when the receipt still covers ALL of it. A fresh proof with new work is left for the next pass, which
 * names only that work; nothing is ever typed here.
 */
function ackCovered(cfg: Config, run: Runner, workerId: string, proof: string, covered: string[], clock: () => number): { ok: boolean; text: string } {
  const refetch = (): { proof?: string; text: string } => {
    let fresh: any;
    try { fresh = fetchDue(cfg, run).wakes.find((w) => w.worker?.id === workerId); } catch (e) { return { text: `proof refresh failed (${describeError(e)})` }; }
    if (!fresh) return { text: 'no wake is due any more after a proof refresh' };
    const work = proofCoverage(fresh.proof);
    if (!work) return { text: 'the fresh proof\'s coverage cannot be established' };
    if (!work.every((t) => covered.includes(t))) return { text: 'the fresh proof carries new work; left for the next pass' };
    return { proof: fresh.proof, text: 'proof refreshed' };
  };
  const issued = proofIssuedAt(proof);
  let current = proof;
  if (issued !== null && clock() - issued > PROOF_REFRESH_AFTER_MS) {
    const r = refetch();
    if (!r.proof) return { ok: false, text: r.text };
    current = r.proof;
  }
  const a = ack(cfg, run, current);
  if (a.ok || a.text !== 'graphql error WAKE_PROOF_STALE') return a;
  const r = refetch();
  if (!r.proof) return { ok: false, text: `${a.text}; ${r.text}` };
  return ack(cfg, run, r.proof);
}

/**
 * Server evidence that an accepted nudge was delivered: the worker's own channel check after the send, and every
 * covered task STARTED (or finished) by this worker. Null when the evidence holds, else why it does not; a failed read
 * is "no evidence", never an error.
 */
function deliveryEvidence(cfg: Config, run: Runner, workerId: string, prior: Ambiguous): string | null {
  let checked: number;
  try {
    const v = gql(run, [cfg.hadronCli, 'api', WORKER_CHECK, '-F', `w=${workerId}`, '-F', `a=${cfg.app}`])?.worker?.checkStatus?.lastCheckedAt;
    checked = typeof v === 'string' ? Date.parse(v) : NaN;
  } catch (e) { return `the worker's check status is unreadable (${describeError(e)})`; }
  if (!Number.isFinite(checked) || checked <= prior.at + CHECK_CLOCK_MARGIN_MS) return 'no channel check since the send';
  // Only the tasks this send newly named need proof; a covered task with no recorded identity (a legacy receipt) holds.
  if (!prior.tasks && prior.coverage.some((c) => c.startsWith('task:'))) return 'a covered task was not recorded with the send';
  for (const taskId of Object.values(prior.tasks ?? {})) {
    let t: any;
    try { t = gql(run, [cfg.hadronCli, 'api', TASK_STATE, '-F', `t=${taskId}`])?.agentTask; } catch (e) { return `a covered task is unreadable (${describeError(e)})`; }
    if (!t || !TASK_SEEN.has(t.status) || t.assignee?.kind !== 'WORKER' || t.assignee?.id !== workerId) return 'a covered task is not started by this worker';
  }
  return null;
}

/** Ack one proof; ok only on a real acknowledgement result. */
function ack(cfg: Config, run: Runner, proof: string): { ok: boolean; text: string } {
  try {
    const d = gql(run, [cfg.hadronCli, 'api', ACK, '-F', `p=${JSON.stringify([proof])}`]);
    const r = d?.acknowledgeWakes;
    if (!r || typeof r.acknowledged !== 'number') return { ok: false, text: 'no acknowledgement result' };
    return { ok: true, text: JSON.stringify(r) };
  } catch (e) {
    const m = (e as Error).message;
    return { ok: false, text: /^(graphql error|unparsable reply)/.test(m) ? m : 'ack failed' };
  }
}

/**
 * The structured outcome of typing a nudge:
 *  - confirmed: Orca accepted the input AND reports the turn started (exact stage `turn_started`).
 *  - refused: the reply parsed and says the input was not accepted, with no request identity: nothing was typed.
 *  - uncertain: accepted without a confirmed turn start, an unparsable reply, or a failure that names a request
 *    identity (the input may have been submitted). Carries the durable requestId when Orca gave one.
 */
export interface Submission { kind: 'confirmed' | 'refused' | 'uncertain'; requestId?: string; stages: string[]; detail: string }

function findRequestId(o: unknown): string | undefined {
  if (Array.isArray(o)) { for (const v of o) { const r = findRequestId(v); if (r) return r; } return undefined; }
  if (o && typeof o === 'object') {
    for (const [k, v] of Object.entries(o)) {
      if ((k === 'requestId' || k === 'request_id' || k === 'retryRequestId') && typeof v === 'string' && v) return v;
      const r = findRequestId(v);
      if (r) return r;
    }
  }
  return undefined;
}

function classify(stdout: string): Submission {
  let data: any;
  try { data = JSON.parse(stdout); } catch { return { kind: 'uncertain', stages: [], detail: 'unparsable send receipt' }; }
  const requestId = findRequestId(data);
  if (data?.ok && data.result?.send?.accepted) {
    const stages: string[] = (Array.isArray(data.result.send.prompt?.stages) ? data.result.send.prompt.stages : []).map(stageClass);
    return stages.includes('turn_started')
      ? { kind: 'confirmed', requestId, stages, detail: stages.join(',') }
      : { kind: 'uncertain', requestId, stages, detail: `accepted, turn start not confirmed (${stages.join(',') || 'no stages'})` };
  }
  const code = safeCode(data?.error?.code);
  if (requestId) return { kind: 'uncertain', requestId, stages: [], detail: `failed with a request identity${code ? ` (${code})` : ''}` };
  if (data && typeof data === 'object' && data.ok === false && data.error) return { kind: 'refused', stages: [], detail: `send refused${code ? `: ${code}` : ''}` };
  return { kind: 'uncertain', stages: [], detail: 'unrecognized send receipt' };
}

/**
 * Type the nudge and submit it (one attempt). With `retryRequestId` the exact
 * prior request is reissued, which Orca binds to the same prompt payload and
 * terminal incarnation: it reports that request's state and never types twice.
 */
export async function submit(cfg: Config, run: AsyncRunner, handle: string, text: string, retryRequestId?: string): Promise<Submission> {
  const argv = [cfg.orcaCli, 'terminal', 'send', '--terminal', handle, '--text', text, '--enter', '--wait-submit', String(SUBMIT_PROBE_S), '--json'];
  if (retryRequestId) argv.push('--retry-request', retryRequestId);
  const first = classify((await run(argv)).stdout);
  // An ambiguous transport failure that names its request is reissued ONCE with that same request identity.
  if (!retryRequestId && first.kind === 'uncertain' && first.requestId && !first.stages.length) {
    const again = classify((await run([...argv, '--retry-request', first.requestId])).stdout);
    const requestId = again.requestId ?? first.requestId;
    // Once a request may have been submitted, only a confirmation resolves it. A failed same-id retry (even a structured
    // refusal that carries no id) does not prove the original never submitted: it stays uncertain.
    if (again.kind === 'confirmed') return { ...again, requestId };
    return { kind: 'uncertain', requestId, stages: again.stages, detail: `${first.detail}; same-id retry: ${again.detail}` };
  }
  return first;
}

export async function pass(cfg: Config, run: Runner, opts: Opts = {}, log: Log = console.log, stateDir = join(cfg.stateDir, 'ticker-wake')): Promise<void> {
  const rawLog = log;
  log = (m: string): void => rawLog(scrub(m));
  const dry = Boolean(opts.dry);
  const runAsync: AsyncRunner = opts.runAsync ?? ((argv) => Promise.resolve(run(argv)));
  const clock = opts.now ?? Date.now;
  const now = clock();
  const deadline = now + (opts.budgetMs ?? DEFAULT_ONCE_BUDGET_S * 1000);
  const ts = new Date(now).toISOString();
  if (!dry) mkdirSync(stateDir, { recursive: true });
  const receipts = loadReceipts(stateDir); // throws on unreadable/malformed state

  const { wakes, more } = fetchDue(cfg, run);
  if (more) log(`${ts} dueWakes has more than ${MAX_PAGES} pages; the rest wait for a later pass`);

  const kinds = (w: any): Set<string> => new Set(w.reasons.map((r: any) => r.kind));
  // Oldest anchor first, so a spent budget never starves the same workers; a wake without timing sorts last (it is held).
  const anchor = (w: any): number => { const t = typeof w.anchorAt === 'string' ? Date.parse(w.anchorAt) : NaN; return Number.isFinite(t) ? t : Infinity; };
  const due = wakes.filter((w) => kinds(w).has('TICK') || kinds(w).has('TASK')).sort((a, b) => anchor(a) - anchor(b));
  const terminals = due.length ? listTerminals(cfg, run) : [];
  const inFlight = new Set<string>(); // terminal handles with a send in flight
  /** Deliver one due wake. Only a submit awaits; everything else is synchronous, so a receipt update never interleaves. */
  const deliver = async (w: any): Promise<void> => {
      const name = w.worker.name;
      const id: string = w.worker.id;
      const other = [...kinds(w)].filter((x) => x !== 'TICK' && x !== 'MENTION' && x !== 'TASK');
      // A task reason is delivered only for an assignment the caller can see; its id is typed, so it must be a plain id.
      const unassignable = w.reasons.filter((r: any) => r.kind === 'TASK'
        && !(r.task && ASSIGNMENT_EVENTS.has(r.task.event) && typeof r.task.id === 'string' && TASK_ID.test(r.task.id)));
      if (unassignable.length) other.push(...new Set(unassignable.map((r: any) => (ASSIGNMENT_EVENTS.has(r.task?.event) ? 'TASK' : `TASK ${safeEvent(r.task?.event)}`))));
      if (other.length) { log(`${ts} ${name}: left alone (also carries ${other.join(',')}; the proof would record them delivered unseen)`); return; }
      const entry = cfg.roster.find((e) => e.worker === id);
      if (!entry) { log(`${ts} ${name}: not on roster`); return; }
      const work = proofCoverage(w.proof);
      if (!work) { log(`${ts} ${name}: held (the proof's tick coverage cannot be established)`); return; }
      let prior = receipts[id];

      // The server owns the timing (R63): anchor, floor and busy deadline come with the wake and are never recomputed or
      // remembered here, so a re-offer, a join or a restart cannot restart them. Missing/unparsable timing holds.
      const at = (v: unknown): number => (typeof v === 'string' ? Date.parse(v) : NaN);
      const deliverAfter = at(w.deliverAfter);
      const busyDeadline = at(w.busyDeadline);
      if (!Number.isFinite(deliverAfter) || !Number.isFinite(busyDeadline) || !Number.isFinite(at(w.anchorAt))) { log(`${ts} ${name}: held (the wake carries no server timing)`); return; }

      const [handle, detail] = resolveTerminal(entry, terminals, cfg, run);
      if (!handle) { log(`${ts} ${name}: held (${detail})`); return; }
      const term0 = terminals.find((t) => t.handle === handle) as any;
      const receiver = `${handle}#${term0?.incarnationId ?? ''}`;
      // Never two sends in flight to one terminal: a second worker resolving to it is held to a later pass.
      if (inFlight.has(handle)) { log(`${ts} ${name}: held (another send to this terminal is in flight)`); return; }
      inFlight.add(handle);
      try {

        /**
         * The R63 delivery gate for anything that can type into this terminal. The composer rules are unconditional: a
         * draft, a question/menu, unknown input or identity, or a foreign composer always holds. Before the server's
         * deliverAfter nothing is typed; "busy" alone vetoes only until the server's busyDeadline, then stops vetoing.
         */
        /** One screen read: whether the composer is provably empty (no draft, question/menu or unknown input). */
        const readComposer = (): { term: Record<string, any> | undefined; agent: string; empty: boolean } => {
          const term = readScreen(cfg, handle, run);
          const agent = detail === 'claude' || detail === 'codex' ? detail : (screenAgentFamily(term) ?? '');
          return { term, agent, empty: promptIsEmptyFromTerm(term, agent)[0] };
        };
        const safeToType = (): string | null => {
          if (now < deliverAfter) return `before deliverAfter ${new Date(deliverAfter).toISOString()}`;
          const idleNow = isIdle(cfg, handle, IDLE_PROBE_MS, run);
          const { term, agent, empty } = readComposer();
          if (!empty) return 'composer not provably empty';
          if (idleNow) return null;
          const [proof, why] = idleProofAbovePrompt((term?.tail ?? []) as string[], agent);
          if (proof === 'idle') return null;
          if (proof === 'busy') return now >= busyDeadline ? null : `busy until the server's busyDeadline ${new Date(busyDeadline).toISOString()}`;
          return 'unknown input state';
        };

        // An unreconciled earlier request is reconciled with ITS OWN identity. Reissuing it can still perform input, so it
        // needs the same receiver and the same composer safety as a fresh send; without a request id it stays held for a human.
        if (prior?.state === 'ambiguous') {
          if (!prior.requestId || dry) { log(`${ts} ${name}: an earlier send is unreconciled (${safeDetail(prior.detail)}); not retyped, not acked`); return; }
          if (prior.receiver !== receiver) { log(`${ts} ${name}: an earlier send is unreconciled for another receiver (${prior.receiver}); held for a human`); return; }
          // Reissue by its own id first: a confirmation from Orca settles it.
          const unsafe = safeToType();
          const r = unsafe ? null : await submit(cfg, runAsync, prior.handle, prior.text, prior.requestId);
          let resolved = r?.kind === 'confirmed' ? 'reconciled as delivered' : '';
          if (!resolved) {
            // Otherwise only evidence resolves it (#26055): accepted, same receiver (checked above), composer provably empty,
            // and the worker's own session checked the channel after the send. It types nothing, so busy does not veto it.
            const why = !(wasAccepted(prior.detail) || (r !== null && wasAccepted(r.detail))) ? 'Orca never reported the input accepted'
              : !readComposer().empty ? 'composer not provably empty'
                : deliveryEvidence(cfg, run, id, prior);
            if (why === null) resolved = 'resolved as delivered on evidence (accepted, composer empty, channel checked after the send)';
            else {
              const held = unsafe ? `unreconciled request not reissued (held: ${unsafe})` : `earlier request still unreconciled (${safeDetail(r!.detail)})`;
              const person = now - prior.at >= NEEDS_PERSON_AFTER_MS ? 'needs a person' : 'not retyped, not acked';
              log(`${ts} ${name}: ${held}; no delivery evidence yet (${why}); ${person}`);
              return;
            }
          }
          prior = receipts[id] = { state: 'sent', coverage: prior.coverage, receiver: prior.receiver, at: now };
          saveReceipts(stateDir, receipts);
          log(`${ts} ${name}: earlier request ${resolved}`);
        }

        const covered = prior?.state === 'sent' && prior.receiver === receiver ? prior.coverage : [];
        const newWork = work.filter((t) => !covered.includes(t));
        // Everything in this proof was already delivered to this receiver: only the ack is missing.
        if (!newWork.length) {
          if (dry) { log(`${ts} ${name}: WOULD ack-only (covered by a confirmed receipt)`); return; }
          const a = ackCovered(cfg, run, id, w.proof, covered, clock);
          log(`${ts} ${name}: ack-only recovery ${a.ok ? 'acked' : 'FAILED'} ${a.text}`);
          if (a.ok) { delete receipts[id]; saveReceipts(stateDir, receipts); }
          return;
        }

        // Otherwise a fresh nudge for ONLY the uncovered work; if any of it cannot be identified, hold rather than repeat covered work.
        const nameOf = new Map<string, string>();
        for (const r of w.reasons) if (r.kind === 'TICK' && r.ticker?.id) nameOf.set(r.ticker.id, r.ticker.name);
        const taskOf = new Map<string, string>();
        for (const r of w.reasons) if (r.kind === 'TASK') taskOf.set(taskKey(r.task.eventId, r.task.chainIndex), r.task.id);
        const newTickers = new Set<string>();
        const newTasks = new Set<string>();
        let unknown = false;
        for (const t of newWork) {
          const found = t.startsWith('task:') ? taskOf.get(t) : nameOf.get(t.slice(0, t.lastIndexOf(':')));
          if (!found) { unknown = true; break; }
          (t.startsWith('task:') ? newTasks : newTickers).add(found);
        }
        if (unknown) { log(`${ts} ${name}: held (the uncovered tick work cannot be identified; reconcile rather than repeat covered work)`); return; }

        const unsafe = safeToType();
        if (unsafe) { log(`${ts} ${name}: held (${unsafe})`); return; }
        const text = nudgeText([...newTickers], [...newTasks]);
        if (dry) { log(`${ts} ${name}: WOULD nudge ${handle}`); return; }
        const coverage = [...new Set([...covered, ...work])].sort();
        // The task identities this send names, kept on the receipt: the assignment wake is gone once the task starts.
        const tasks: Record<string, string> = {};
        for (const t of newWork) if (t.startsWith('task:')) tasks[t] = taskOf.get(t) as string;

        // Persist the UNRESOLVED INTENT before anything can be submitted (#2070 LOCAL P2-1). If the process dies, or any later
        // receipt write fails, after Orca took the input, this entry is what stops the next pass from typing the same wake again:
        // it is an ambiguous record without a request identity, which is held for a human and never retyped or acked. If the
        // intent itself cannot be written, nothing is sent.
        const before = receipts[id];
        const restore = (): void => { if (before) receipts[id] = before; else delete receipts[id]; };
        receipts[id] = { state: 'ambiguous', coverage, receiver, at: now, detail: 'send intent recorded before submission; outcome unknown', text, handle, tasks };
        try { saveReceipts(stateDir, receipts); } catch (e) {
          restore();
          log(`${ts} ${name}: held (the send intent could not be recorded: ${errno(e)}); nothing sent`);
          return;
        }
        const r = await submit(cfg, runAsync, handle, text);
        if (r.kind === 'refused') {
          // Orca says nothing was typed: the intent is withdrawn so the next pass retries. If that write fails, the intent stays
          // on disk and the wake is held for a human (fail closed).
          restore();
          try { saveReceipts(stateDir, receipts); } catch (e) { log(`${ts} ${name}: could not withdraw the send intent (${errno(e)}); held for a human`); }
          log(`${ts} ${name}: ${safeDetail(r.detail)}; will retry`);
          return;
        }
        if (r.kind === 'uncertain') {
          // Never an ack, never a fresh type: recorded with its request identity so it can be reconciled.
          receipts[id] = { state: 'ambiguous', coverage, receiver, at: now, detail: r.detail, text, handle, tasks, ...(r.requestId ? { requestId: r.requestId } : {}) };
          try { saveReceipts(stateDir, receipts); } catch (e) { log(`${ts} ${name}: could not update the send record (${errno(e)}); the earlier intent stays and holds the wake`); }
          log(`${ts} ${name}: send not confirmed (${safeDetail(r.detail)}); left for reconciliation`);
          return;
        }
        receipts[id] = { state: 'sent', coverage, receiver, at: now };
        try { saveReceipts(stateDir, receipts); } catch (e) {
          // Orca confirmed the turn started but the receipt could not be written: the intent on disk still marks the wake as
          // unreconciled, so it is never retyped; it is not acked either, and waits for a human.
          log(`${ts} ${name}: nudged ${handle} but the receipt could not be written (${errno(e)}); intent retained, not acked`);
          return;
        }
        const a = ackCovered(cfg, run, id, w.proof, coverage, clock);
        log(`${ts} ${name}: nudged ${handle}; ${a.ok ? 'acked' : 'ack FAILED (retried ack-only next pass)'} ${a.text}`);
        if (a.ok) { delete receipts[id]; saveReceipts(stateDir, receipts); }
      } finally { inFlight.delete(handle); }
  };

  // A bounded pool of lanes (#2138): the sends overlap, so a pass costs about the slowest lane, not the sum of the
  // turn-start observations. No new delivery starts once the budget is spent or a delivery failed; a failure is
  // rethrown only after every send in flight has finished and written its receipt (fail closed, never mid-send).
  let next = 0;
  let left = 0;
  let failed: { e: unknown } | null = null;
  const lane = async (): Promise<void> => {
    while (next < due.length && !failed) {
      const w = due[next++];
      if (clock() >= deadline) { left++; continue; }
      try { await deliver(w); } catch (e) { failed ??= { e }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(DELIVERY_POOL, due.length) }, lane));
  if (failed) throw (failed as { e: unknown }).e;
  if (left) log(`${ts} pass budget spent; ${left} due wake(s) left for the next pass`);
  if (!due.length) log(`${ts} no ticker wakes due (${wakes.length} other wakes ignored)`);
}

/**
 * The one line typed into the terminal (#2138 §5.2, mark-read follow-up). It names the exact commands, because a worker's
 * compiled prompt may not carry the messaging rules and the nudge is all it has (Yuri #26114: Codex turns obeyed the
 * old text but read with their own --since and never marked read). Verified against the released CLI v0.26.0
 * (8c428a7, internal/cmd/team/chat.go): a read with no --since is a TAIL read of the newest page only (George #2156
 * P2), so the first read only learns the cursor C; `--since C --all` then walks every page forward from C until a
 * short page, and fails as a whole, before any output, if a page fails. Each read samples the head it prints BEFORE
 * fetching, so marking through the H the complete read printed never buries an unseen tagged message, never skips one
 * posted after it, and still stamps the check on an empty read. On a failed read nothing is marked.
 */
export function nudgeText(tickers: string[], tasks: string[]): string {
  const check = 'run `hadron team chat read --mentions-me --limit 1` (it prints `cursor #C; channel head #H`), '
    + 'then `hadron team chat read --mentions-me --since C --all` and act on the tagged messages it returns; '
    + 'only if that read succeeded, run `hadron team chat mark-read --through H` with the H that read printed';
  const rule = 'No unfiltered chat catch-up.';
  if (!tasks.length) return `Hadron ticker wake (${tickers.join(', ')}): ${check}; then end your turn. ${rule}`;
  const which = tasks.length === 1 ? `hadron team task get ${tasks[0]}` : 'hadron team task list';
  return `Hadron task assigned (${tasks.join(', ')}${tickers.length ? `; ticker ${tickers.join(', ')}` : ''}): ${check}; then start the task (\`${which}\`). ${rule}`;
}

/** A task event name from the server, logged only when it is a known shape. */
const safeEvent = (e: unknown): string => (typeof e === 'string' && /^[A-Z_]{1,32}$/.test(e) ? e : 'other');

function pidAlive(pid: number): boolean {
  try { return pid > 0 && readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('ticker-wake'); } catch { return false; }
}

/** Test seams for the stale-takeover race. */
export interface LockHooks { afterJudgedStale?: () => void; beforeUnlink?: () => void }

/**
 * One instance per state dir.
 *  - Fresh acquisition is atomic: the owner's pid goes into a private temp file hard-linked to `lock` (fails if it exists).
 *  - A stale lock (dead owner) is only ever removed by a contender holding the exclusive `lock.takeover` file, and only
 *    after re-reading `lock` under it: a replacement owner that arrived meanwhile is never unlinked. A contender that
 *    cannot take `lock.takeover` is refused, and a takeover file left behind by a dead process fails closed for
 *    operator cleanup (no recursive stale recovery).
 */
export function acquireLock(dir: string, pid = process.pid, hooks: LockHooks = {}): () => void {
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, 'lock');
  const takeover = join(dir, 'lock.takeover');
  const mk = (): string => { const t = join(dir, `lock.${pid}.${Math.random().toString(36).slice(2)}`); writeFileSync(t, String(pid)); return t; };
  const linked = (t: string, to: string): boolean => {
    try { linkSync(t, to); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false; throw e; }
  };
  const ownerOf = (p: string): number | null => { try { return Number(readFileSync(p, 'utf8').trim()); } catch { return null; } };
  const releaseFn = (): void => { try { if (ownerOf(lock) === pid) unlinkSync(lock); } catch { /* gone */ } };
  const tmp = mk();
  try {
    if (linked(tmp, lock)) return releaseFn;
    const held = ownerOf(lock);
    if (held !== null && held !== pid && pidAlive(held)) throw new SafeError(`another ticker-wake (pid ${held}) holds ${lock}`);
    hooks.afterJudgedStale?.();
    // Take the takeover right. A takeover file that already exists is never cleaned up here, live owner or not: removing
    // it would repeat the check/unlink race one level down. A dead owner's file needs explicit operator cleanup.
    if (!linked(tmp, takeover)) {
      const t = ownerOf(takeover);
      throw new SafeError(t !== null && t !== pid && pidAlive(t)
        ? `another starter is taking over ${lock}`
        : `${takeover} was left behind (owner ${t ?? 'unknown'}); an operator must remove it after checking that no ticker-wake is starting`);
    }
    try {
      hooks.beforeUnlink?.();
      const now = ownerOf(lock);
      if (now !== null && now !== pid && pidAlive(now)) throw new SafeError(`another ticker-wake (pid ${now}) holds ${lock}`);
      if (now !== null) { try { unlinkSync(lock); } catch { /* gone */ } }
      if (!linked(tmp, lock)) throw new SafeError(`could not take ${lock}: it was taken meanwhile`);
      return releaseFn;
    } finally { try { if (ownerOf(takeover) === pid) unlinkSync(takeover); } catch { /* gone */ } }
  } finally { try { unlinkSync(tmp); } catch { /* already gone */ } }
}

export interface MainDeps {
  load?: () => Config;
  run?: Runner;
  log?: Log;
  sleep?: (ms: number) => Promise<void>;
  /** Runs the sends; defaults to runCommandAsync, or to a wrapped `run` when one is given (tests). */
  runAsync?: AsyncRunner;
  /** loop only: stop after this many passes (tests). */
  maxPasses?: number;
  now?: () => number;
}

/** CLI entry. Returns the exit code; 2 for a usage error. */
export async function main(argv: string[], deps: MainDeps = {}): Promise<number> {
  const log = deps.log ?? console.log;
  const [mode, ...rest] = argv;
  const usage = (m: string): number => { log(`ticker-wake: ${m}\nusage: once [--dry] [--budget <seconds>] | loop [--interval <seconds>] [--budget <seconds>]`); return 2; };
  if (mode !== 'once' && mode !== 'loop') return usage(`unknown mode ${JSON.stringify(mode)}`);
  const allowed = mode === 'once' ? ['--dry', '--budget'] : ['--interval', '--budget'];
  let seconds = 120;
  let budget: number | undefined;
  let dry = false;
  const secondsArg = (v: string | undefined): number => (v !== undefined && /^\d+(\.\d+)?$/.test(v) ? Number(v) : NaN);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!allowed.includes(a)) return usage(`${a} is not valid for ${mode}`);
    if (a === '--dry') dry = true;
    else if (a === '--budget') {
      budget = secondsArg(rest[++i]);
      if (!Number.isFinite(budget) || budget < 10) return usage('--budget needs a number of seconds, at least 10');
    } else {
      seconds = secondsArg(rest[++i]);
      if (!Number.isFinite(seconds) || seconds < 10) return usage('--interval needs a number of seconds, at least 10');
    }
  }
  // A loop pass must end inside its own slot, so its budget defaults to, and may not exceed, the interval.
  if (mode === 'loop' && budget !== undefined && budget > seconds) return usage('--budget may not exceed --interval');
  const cfg = (deps.load ?? (() => loadConfig(DEFAULT_CONFIG)))();
  const run = deps.run ?? runCommand;
  const clock = deps.now ?? Date.now;
  const runAsync = deps.runAsync ?? (deps.run ? undefined : runCommandAsync);
  const opts: Opts = { dry, now: deps.now, runAsync, budgetMs: (budget ?? (mode === 'loop' ? seconds : DEFAULT_ONCE_BUDGET_S)) * 1000 };
  const stateDir = join(cfg.stateDir, 'ticker-wake');
  if (dry) { await pass(cfg, run, opts, log, stateDir); return 0; }
  let release: () => void;
  try { release = acquireLock(stateDir); } catch (e) { log(`ticker-wake: ${describeError(e)}`); return 1; }
  try {
    // Fixed slots: a pass starts on a slot boundary. One that overran its slot skips the slots it covered (logged) and
    // the next pass starts on the following boundary, so passes never run back to back or pile up behind a slow one.
    const slotMs = seconds * 1000;
    let next = clock();
    for (let n = 0; ; n++) {
      const started = clock();
      try { await pass(cfg, run, opts, log, stateDir); } catch (e) { log(`${new Date(clock()).toISOString()} pass failed: ${describeError(e)}`); }
      if (mode === 'once' || (deps.maxPasses !== undefined && n + 1 >= deps.maxPasses)) return 0;
      next = Math.max(next, started) + slotMs;
      const ended = clock();
      if (ended > next) {
        const skipped = Math.ceil((ended - next) / slotMs);
        next += skipped * slotMs;
        log(`${new Date(ended).toISOString()} pass overran its slot; skipped ${skipped} slot(s)`);
      }
      await (deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(next - ended);
    }
  } finally { release(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
