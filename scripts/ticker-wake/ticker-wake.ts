/**
 * Ticker-only wake delivery for an Orca host (Hugo, 2026-10-18; corrected after
 * the #2070 gate, 2026-10-19).
 *
 * Delivers wakes that carry a TICK or a task event (an assignment, a stall alarm, a finished child), from hadron dueWakes
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
 *  - a TASK reason for a stall ALARM or a CHILD_FINISHED (#1704), alone or
 *    joined as above: nudged once, then acked, recorded in the receipt like an
 *    assignment. An alarm names its task, its stall rule (read from the alarm,
 *    which must still be unacknowledged) and the `hadron team alarm ack <id>`
 *    to run after acting, because delivery is never an acknowledgement
 *    (cor:agt:050:20); a finished child names the child task.
 *  - any wake carrying another reason (END_SESSION, which needs the host
 *    poller, a TASK reason without its task, or an unknown kind): left alone,
 *    neither nudged nor acked, because its proof would record those events
 *    delivered unseen.
 *  - a MENTION-only wake is ignored and never acked: there is no mention-ack
 *    path in this script.
 *
 * Receivers (#2138, Hugo #26221): the ticker's live subscribers and every due worker, joined to this host's terminals by
 * the CLI binding in their worktree, while it names their current open session (`hostRoster`, George's #2161 P2); a
 * router-config roster row overrides it. Every one with no receiver
 * here is logged once per pass, `no binding` or `no terminal`. Never a hand-kept list alone.
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
 *    channel after the send: a later lastCheckedAt than the one read just before the send, both on the server's clock
 *    (Ada #26165; any covered task must also be STARTED by it). A timeout alone never resolves it: after 2
 *    cadences without evidence, a strictly newer tick may get ONE fresh request under the same guards; the old entry
 *    is retained in needs-person.json, never certified by elapsed time, retyped as a fresh request or acked by itself.
 *  - a STRANDED DRAFT (#2138, Ada #26150) is DETECTED, never submitted: Orca accepted our text but the Enter never
 *    submitted it, so the composer holds exactly that text and neither the reissue (an idempotent replay of the stored
 *    receipt, Hugo #26146) nor the evidence path can run. When the draft equals the recorded text, the rest of the
 *    composer is empty, the terminal is idle and 60 s have passed since the send, `strandedAt` is recorded once and the
 *    entry is listed for a person. No keystroke: Orca's raw Enter is bound to neither the terminal incarnation nor the
 *    expected draft, so it could submit someone else's input (George's #2157 P2). The entry stays ambiguous and still
 *    resolves on evidence as above, e.g. once the draft submits on its own.
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
import { linkSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadConfig, DEFAULT_CONFIG, runCommand, listTerminals, resolveTerminal, teamBinding,
  readScreen, promptIsEmptyFromTerm, screenAgentFamily, isIdle, idleProofAbovePrompt,
  CALL_TIMEOUT_MS, type Config, type RosterEntry, type Runner, type RunResult,
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
/** #2138 (Hugo #26221): every live ticker of the App and its live subscribers, the first page of each. */
export const SUBSCRIBERS = `query($a:String!){tickers(appRef:$a){id subscribers(first:200){items{worker{id name}} hasNextPage endCursor}}}`;
/** The next page of one ticker's subscribers. */
export const SUBSCRIBERS_PAGE = `query($t:String!,$p:String){ticker(ref:$t){subscribers(first:200,after:$p){items{worker{id name}} hasNextPage endCursor}}}`;
/**
 * A worker's newest session visible to this host's credential (newest first by startedAt; George's #2161 P2). A worker
 * holds at most one open session, so an open newest session is its current one.
 */
export const CURRENT_SESSION = `query($w:String){sessions(workerRef:$w,limit:1){id workerId appId endedAt}}`;
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
/**
 * How long a send observes the accepted prompt for a turn start (`--wait-submit`). Orca only observes for this long;
 * a timeout returns the input-accepted receipt and never resends. It almost never confirms in time (#26099: two 15 s
 * observations were ~30 s of every resolve+send), and since #2154 an accepted send is resolved on evidence later, so a
 * short look is enough. Its own constant: `submitWaitS` belongs to the shared router config.
 */
export const SUBMIT_PROBE_S = 2;
/** Sends in flight at once. Each lane is one terminal; the reads around a send stay serial. */
export const DELIVERY_POOL = 8;
/** Two cadences of the 600 s team-tick: list the old request for a person and allow strictly newer ticks. */
export const NEEDS_PERSON_AFTER_MS = 20 * 60 * 1000;
/** A draft still in the composer this long after its send counts as stranded, not as a slow submit still in progress. */
export const STRANDED_AFTER_MS = 60_000;
/** The task states that prove the assignee saw its assignment. */
const TASK_SEEN: ReadonlySet<string> = new Set(['STARTED', 'FINISHED']);
/** Orca took the input (send.accepted) but no turn start was seen: the only ambiguity evidence may resolve. */
const ACCEPTED_DETAIL = 'accepted, turn start not confirmed';
const wasAccepted = (detail: string): boolean => detail.split('; same-id retry: ').some((p) => p.startsWith(ACCEPTED_DETAIL));
/** The task events that mean "a task was assigned to you" (#2138 §5.2). */
export const ASSIGNMENT_EVENTS: ReadonlySet<string> = new Set(['ASSIGNED', 'REASSIGNED', 'MATCHED']);
/**
 * Every task event this script delivers (#1704): the assignments, a stall ALARM and a CHILD_FINISHED. END_SESSION is
 * left alone: it needs the host poller, which is not running.
 */
export const DELIVERED_EVENTS: ReadonlySet<string> = new Set([...ASSIGNMENT_EVENTS, 'ALARM', 'CHILD_FINISHED']);
/** An alarm's own record: its rule (the event type) and whether someone already acknowledged it (#1704). */
export const ALARM_EVENT = `query($a:ID!,$t:ID!,$p:ID){agentTeamEvents(appRef:$a,taskId:$t,alarmsOnly:true,after:$p,limit:200){id type acknowledgedAt}}`;
/** The alarm read's page size (the server's cap), and how many pages it walks before holding (George's #2160 P2). */
const ALARM_PAGE = 200;
const ALARM_MAX_PAGES = 50;
/** A stall rule is typed into a terminal, so only the platform's plain rule shape is accepted (e.g. stall.not-started). */
const STALL_RULE = /^[a-z][a-z0-9.-]{0,63}$/;
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
 * `strandedAt` is when the send was first seen stranded in the composer, recorded once and never rewritten.
 * `checkedBefore` is the worker's `lastCheckedAt` as the SERVER reported it just before the send (null: never checked),
 * so delivery evidence compares two server times (#2138, Ada #26165); absent on an older receipt, which then holds.
 */
interface Ambiguous { state: 'ambiguous'; coverage: string[]; receiver: string; at: number; detail: string; text: string; handle: string; requestId?: string; tasks?: Record<string, string>; strandedAt?: number; checkedBefore?: string | null }
type Receipt = Delivered | Ambiguous;
type Receipts = Record<string, Receipt>; // by worker id
/** Old requests displaced by NEW tick work, retained for a person; never treated as delivered evidence. */
type NeedsPerson = Record<string, Ambiguous & { workerId: string }>;
const NEEDS_PERSON_FILE = 'needs-person.json';

/** A strictly newer tick is new work; an old tick or task in an unresolved request is never named again. */
function tickParts(key: string): { ticker: string; k: number } | null {
  if (key.startsWith('task:')) return null;
  const i = key.lastIndexOf(':');
  const raw = key.slice(i + 1);
  const k = Number(raw);
  return i > 0 && /^\d+$/.test(raw) && Number.isSafeInteger(k) && k > 0 ? { ticker: key.slice(0, i), k } : null;
}
function unresolvedCovers(key: string, unresolved: string[]): boolean {
  if (unresolved.includes(key)) return true;
  const t = tickParts(key);
  return !!t && unresolved.some((c) => { const old = tickParts(c); return old?.ticker === t.ticker && old.k >= t.k; });
}

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

/** Missing file is empty state; anything unreadable or malformed THROWS (fail closed: no send, no ack). */
function loadReceipts(dir: string, file = 'receipts.json'): Receipts {
  let raw: string;
  try { raw = readFileSync(join(dir, file), 'utf8'); } catch (e) {
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
      || (r.requestId !== undefined && typeof r.requestId !== 'string')
      || (r.strandedAt !== undefined && !(typeof r.strandedAt === 'number' && Number.isFinite(r.strandedAt)))
      || (r.checkedBefore !== undefined && r.checkedBefore !== null && !(typeof r.checkedBefore === 'string' && Number.isFinite(Date.parse(r.checkedBefore))))) return bad();
    if (r.tasks !== undefined && (r.tasks === null || typeof r.tasks !== 'object' || Array.isArray(r.tasks)
      || !Object.entries(r.tasks).every(([k, v]) => k.startsWith('task:') && r.coverage.includes(k) && typeof v === 'string' && TASK_ID.test(v)))) return bad();
  }
  return parsed as Receipts;
}
function saveReceipts(dir: string, r: Receipts, file = 'receipts.json'): void {
  const path = join(dir, file);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(r));
  renameSync(tmp, path);
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
  const initial = proofCoverage(proof);
  if (!initial || !initial.every((t) => covered.includes(t))) return { ok: false, text: 'the proof includes unresolved work; not acked' };
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
 * The worker's own last team-channel check, as the server stamped it (its database clock): an ISO time, or null when it
 * has never checked. Throws a SafeError when the read fails or the value is not a time.
 */
function lastChecked(cfg: Config, run: Runner, workerId: string): string | null {
  const v = gql(run, [cfg.hadronCli, 'api', WORKER_CHECK, '-F', `w=${workerId}`, '-F', `a=${cfg.app}`])?.worker?.checkStatus?.lastCheckedAt;
  if (v === null) return null;
  if (typeof v !== 'string' || !Number.isFinite(Date.parse(v))) throw new SafeError('check status carries no time');
  return v;
}

/**
 * Server evidence that an accepted nudge was delivered: a channel check by the worker's own session LATER than the one
 * recorded just before the send, and every covered task STARTED (or finished) by this worker. Both check times are the
 * server's, so host/server clock skew cannot move the comparison either way (Liam #26163: alpha's DB ran ~19 s behind
 * the host). Null when the evidence holds, else why it does not; a failed read is "no evidence", never an error.
 */
function deliveryEvidence(cfg: Config, run: Runner, workerId: string, prior: Ambiguous): string | null {
  if (prior.checkedBefore === undefined) return 'the pre-send check was not recorded with the send';
  let checked: string | null;
  try { checked = lastChecked(cfg, run, workerId); } catch (e) { return `the worker's check status is unreadable (${describeError(e)})`; }
  const before = prior.checkedBefore === null ? -Infinity : Date.parse(prior.checkedBefore);
  if (checked === null || !(Date.parse(checked) > before)) return 'no channel check since the send';
  // Only the tasks this send newly named need proof; a covered task with no recorded identity (a legacy receipt) holds.
  if (!prior.tasks && prior.coverage.some((c) => c.startsWith('task:'))) return 'a covered task was not recorded with the send';
  for (const taskId of Object.values(prior.tasks ?? {})) {
    let t: any;
    try { t = gql(run, [cfg.hadronCli, 'api', TASK_STATE, '-F', `t=${taskId}`])?.agentTask; } catch (e) { return `a covered task is unreadable (${describeError(e)})`; }
    if (!t || !TASK_SEEN.has(t.status) || t.assignee?.kind !== 'WORKER' || t.assignee?.id !== workerId) return 'a covered task is not started by this worker';
  }
  return null;
}

/**
 * The alarm `eventId` on task `taskId`, or undefined when the task's alarm history runs out without it. The history is
 * oldest first and keeps acknowledged alarms, so it is paged by the last event read until the exact id turns up
 * (George's #2160 P2: a task can hold more than one page of earlier episodes). Throws a SafeError when a page fails, the
 * cursor does not advance, or ALARM_MAX_PAGES pages pass without an end: never "absent" on a partial read.
 */
function findAlarm(cfg: Config, run: Runner, taskId: string, eventId: string): any {
  let after: string | undefined;
  for (let n = 0; n < ALARM_MAX_PAGES; n++) {
    const argv = [cfg.hadronCli, 'api', ALARM_EVENT, '-F', `a=${cfg.app}`, '-F', `t=${taskId}`];
    if (after) argv.push('-F', `p=${after}`);
    const list = gql(run, argv)?.agentTeamEvents;
    if (!Array.isArray(list)) throw new SafeError('alarm history returned no result');
    const found = list.find((e: any) => e?.id === eventId);
    if (found) return found;
    if (list.length < ALARM_PAGE) return undefined;
    const last = list[list.length - 1]?.id;
    if (typeof last !== 'string' || last === after) throw new SafeError('alarm history cursor did not advance');
    after = last;
  }
  throw new SafeError(`alarm history longer than ${ALARM_MAX_PAGES} pages`);
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

/**
 * Every live subscriber of the App's tickers, by worker id (#2138, Hugo #26221). Throws a SafeError when a read fails or a
 * ticker has more than MAX_PAGES pages: a pass that cannot say who should be reachable stops, like a failed dueWakes read.
 */
function fetchSubscribers(cfg: Config, run: Runner): Map<string, string> {
  const out = new Map<string, string>();
  const take = (page: any): void => {
    if (!page || !Array.isArray(page.items)) throw new SafeError('subscribers returned no result');
    for (const s of page.items) if (typeof s?.worker?.id === 'string') out.set(s.worker.id, String(s.worker.name ?? s.worker.id));
  };
  const tickers = gql(run, [cfg.hadronCli, 'api', SUBSCRIBERS, '-F', `a=${cfg.app}`])?.tickers;
  if (!Array.isArray(tickers)) throw new SafeError('tickers returned no result');
  for (const t of tickers) {
    let page = t?.subscribers;
    take(page);
    for (let n = 1; page.hasNextPage; n++) {
      if (n >= MAX_PAGES) throw new SafeError(`a ticker has more than ${MAX_PAGES} pages of subscribers`);
      page = gql(run, [cfg.hadronCli, 'api', SUBSCRIBERS_PAGE, '-F', `t=${t.id}`, '-F', `p=${page.endCursor}`])?.ticker?.subscribers;
      take(page);
    }
  }
  return out;
}

const realPath = (p: string): string => { try { return realpathSync(p); } catch { return resolve(p); } };

/**
 * The receivers on this host (#2138, Hugo #26221: a hand-kept roster missed 17 subscribed workers). A worker is reachable
 * here through a worktree among Orca's terminals whose CLI binding (`hadron team session start`) names it AND names its
 * CURRENT session (George's #2161 P2, Ada #26314): the worker's newest session, read from the server, must be open, be
 * that worker's, and be the binding's session in the binding's App. A binding left behind after the worker ended or was
 * rebound elsewhere is stale, so a terminal later reused in that worktree is never taken for the worker. Among several
 * bindings for one worker only the current one counts; two current ones hold. The router config's roster row for a
 * worker, when there is one, overrides all of this (its worktree and terminal pin, as the operator states them). Which
 * terminal in the worktree gets the nudge is still `resolveTerminal`'s, at delivery. `why` says, for a worker with no
 * receiver: `no binding` (none on this host, or two current ones), `stale binding (...)` (ended, replaced, mismatched,
 * or the session read failed), or `no terminal` (no connected, writable terminal in its worktree). The session read is
 * made once per worker per pass, and only for a worker asked about.
 */
export function hostRoster(cfg: Config, terminals: Array<{ worktreePath?: string; connected?: boolean; writable?: boolean }>, run: Runner): {
  entry: (workerId: string, name: string) => RosterEntry | null; why: (workerId: string) => string;
} {
  const live = new Set<string>();
  const byWorker = new Map<string, Array<{ wt: string; sessionId?: string; appId?: string }>>();
  for (const wt of new Set(terminals.map((t) => t.worktreePath).filter((p): p is string => typeof p === 'string' && p !== '').map(realPath))) {
    const b = teamBinding(wt);
    if (b) byWorker.set(b.workerId, [...(byWorker.get(b.workerId) ?? []), { wt, sessionId: b.sessionId, appId: b.appId }]);
  }
  for (const t of terminals) if (t.worktreePath && t.connected !== false && t.writable !== false) live.add(realPath(t.worktreePath));
  const memo = new Map<string, { wt?: string; why: string }>();
  const resolveWorker = (workerId: string): { wt?: string; why: string } => {
    const file = cfg.roster.find((e) => e.worker === workerId);
    if (file) return { wt: realPath(file.worktree), why: live.has(realPath(file.worktree)) ? '' : 'no terminal' };
    const bound = byWorker.get(workerId) ?? [];
    if (bound.length === 0) return { why: 'no binding' };
    let s: any;
    try {
      const list = gql(run, [cfg.hadronCli, 'api', CURRENT_SESSION, '-F', `w=${workerId}`])?.sessions;
      if (!Array.isArray(list)) throw new SafeError('sessions returned no result');
      s = list[0];
    } catch (e) { return { why: `stale binding (session unreadable: ${describeError(e)})` }; }
    if (!s || typeof s.id !== 'string') return { why: 'stale binding (no session)' };
    if (s.endedAt !== null) return { why: 'stale binding (session ended)' };
    if (s.workerId !== workerId) return { why: 'stale binding (session mismatched)' };
    const current = bound.filter((b) => b.sessionId === s.id);
    if (current.length === 0) return { why: 'stale binding (session replaced)' };
    if (current.some((b) => b.appId !== s.appId)) return { why: 'stale binding (app mismatched)' };
    if (current.length > 1) return { why: `no binding (bound in ${current.length} worktrees)` };
    return { wt: current[0].wt, why: live.has(current[0].wt) ? '' : 'no terminal' };
  };
  const resolved = (workerId: string): { wt?: string; why: string } => {
    let r = memo.get(workerId);
    if (!r) { r = resolveWorker(workerId); memo.set(workerId, r); }
    return r;
  };
  const why = (workerId: string): string => resolved(workerId).why;
  const entry = (workerId: string, name: string): RosterEntry | null => {
    const r = resolved(workerId);
    if (r.why !== '' || !r.wt) return null;
    return cfg.roster.find((e) => e.worker === workerId) ?? { worker: workerId, name, worktree: r.wt };
  };
  return { entry, why };
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
  const needsPerson = loadReceipts(stateDir, NEEDS_PERSON_FILE) as NeedsPerson;
  for (const p of Object.values(needsPerson)) {
    if (p.state !== 'ambiguous' || typeof p.workerId !== 'string' || !p.workerId) throw new SafeError('needs-person receipts malformed; stopping rather than risk a retype');
    log(`${ts} ${p.workerId}: earlier request needs a person (${Math.max(0, Math.floor((now - p.at) / 1000))}s old); not retyped, not acked`);
  }

  const { wakes, more } = fetchDue(cfg, run);
  if (more) log(`${ts} dueWakes has more than ${MAX_PAGES} pages; the rest wait for a later pass`);

  const kinds = (w: any): Set<string> => new Set(w.reasons.map((r: any) => r.kind));
  // Oldest anchor first, so a spent budget never starves the same workers; a wake without timing sorts last (it is held).
  const anchor = (w: any): number => { const t = typeof w.anchorAt === 'string' ? Date.parse(w.anchorAt) : NaN; return Number.isFinite(t) ? t : Infinity; };
  const due = wakes.filter((w) => kinds(w).has('TICK') || kinds(w).has('TASK')).sort((a, b) => anchor(a) - anchor(b));
  // The receivers come from the server's subscribers and this host's bound terminals, never from a hand-kept list alone
  // (#2138). Every subscriber or due worker with no receiver here is logged once per pass, with why.
  const subscribers = fetchSubscribers(cfg, run);
  const terminals = listTerminals(cfg, run);
  const receivers = hostRoster(cfg, terminals, run);
  const wanted = new Map(subscribers);
  for (const w of due) if (typeof w.worker?.id === 'string' && !wanted.has(w.worker.id)) wanted.set(w.worker.id, String(w.worker.name));
  const unreachable = [...wanted].map(([id, n]) => [n, receivers.why(id)] as const).filter(([, r]) => r !== '')
    .sort(([a], [b]) => a.localeCompare(b));
  if (unreachable.length) log(`${ts} unreachable on this host (${unreachable.length}): ${unreachable.map(([n, r]) => `${n} (${r})`).join(', ')}`);
  const inFlight = new Set<string>(); // terminal handles with a send in flight
  /** Deliver one due wake. Only a submit awaits; everything else is synchronous, so a receipt update never interleaves. */
  const deliver = async (w: any): Promise<void> => {
      const name = w.worker.name;
      const id: string = w.worker.id;
      const other = [...kinds(w)].filter((x) => x !== 'TICK' && x !== 'MENTION' && x !== 'TASK');
      // A task reason is delivered only for an event this script names (DELIVERED_EVENTS) and the caller can see; its id
      // is typed, and so is an alarm's event id (the ack command), so both must be plain ids.
      const undeliverable = w.reasons.filter((r: any) => r.kind === 'TASK'
        && !(r.task && DELIVERED_EVENTS.has(r.task.event) && typeof r.task.id === 'string' && TASK_ID.test(r.task.id)
          && (r.task.event !== 'ALARM' || (typeof r.task.eventId === 'string' && TASK_ID.test(r.task.eventId)))));
      if (undeliverable.length) other.push(...new Set(undeliverable.map((r: any) => (DELIVERED_EVENTS.has(r.task?.event) ? 'TASK' : `TASK ${safeEvent(r.task?.event)}`))));
      if (other.length) { log(`${ts} ${name}: left alone (also carries ${other.join(',')}; the proof would record them delivered unseen)`); return; }
      const entry = receivers.entry(id, name);
      if (!entry) { log(`${ts} ${name}: held (${receivers.why(id)} on this host)`); return; }
      const work = proofCoverage(w.proof);
      if (!work) { log(`${ts} ${name}: held (the proof's tick coverage cannot be established)`); return; }
      let prior: Receipt | undefined = receipts[id];
      let displaced: Ambiguous | undefined;

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
      const unresolved = Object.values(needsPerson).filter((p) => p.workerId === id && p.receiver === receiver).flatMap((p) => p.coverage);
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

        /**
         * A stranded draft (#2138, Ada #26150): the composer holds exactly the text this accepted send typed, because its
         * Enter never submitted it. DETECTION ONLY, never a keystroke (George's #2157 P2: a raw Enter is bound to neither the
         * incarnation nor the draft, so a terminal replaced after this read would get it). It counts only when nothing
         * else is on the composer, the terminal is idle and STRANDED_AFTER_MS has passed since the send; `strandedAt` is
         * then recorded once and the entry is listed for a person. Null when the composer does not hold our exact text.
         */
        const strandedDraft = (p: Ambiguous): string | null => {
          const term = readScreen(cfg, handle, run);
          const agent = detail === 'claude' || detail === 'codex' ? detail : (screenAgentFamily(term) ?? '');
          if (typeof term?.draft !== 'string' || term.draft.trimEnd() !== p.text.trimEnd()) return null;
          if (!promptIsEmptyFromTerm({ ...term, draft: undefined }, agent)[0]) return null;
          const secs = Math.floor((now - p.at) / 1000);
          if (now - p.at < STRANDED_AFTER_MS) return `our nudge is in the composer, ${secs}s since the send; not retyped, not acked`;
          if (!isIdle(cfg, handle, IDLE_PROBE_MS, run) && idleProofAbovePrompt((term.tail ?? []) as string[], agent)[0] !== 'idle') {
            return `our nudge is in the composer, ${secs}s since the send, but the terminal is not idle; not retyped, not acked`;
          }
          const tail = 'nothing submitted, not retyped, not acked; needs a person';
          if (p.strandedAt !== undefined) return `stranded draft, ${secs}s (first seen ${new Date(p.strandedAt).toISOString()}); ${tail}`;
          receipts[id] = { ...p, strandedAt: now };
          try { saveReceipts(stateDir, receipts); } catch (e) {
            receipts[id] = p;
            return `stranded draft, ${secs}s (not recorded: ${errno(e)}); ${tail}`;
          }
          return `stranded draft, ${secs}s; ${tail}`;
        };

        // An unreconciled earlier request is reconciled with ITS OWN identity. Reissuing it can still perform input, so it
        // needs the same receiver and composer safety. An id-less accepted request may only be displaced by NEW ticks
        // after two cadences; the old request is never replayed without its id.
        const allowFreshTick = (p: Ambiguous): boolean => {
          if (dry || now - p.at < NEEDS_PERSON_AFTER_MS || !wasAccepted(p.detail)
            || p.receiver !== receiver || typeof term0?.incarnationId !== 'string' || !term0.incarnationId) return false;
          const old = [...unresolved, ...p.coverage];
          if (!work.some((t) => tickParts(t) && !unresolvedCovers(t, old))) return false;
          if (safeToType()) return false;
          displaced = p;
          unresolved.push(...p.coverage);
          log(`${ts} ${name}: earlier request needs a person (${Math.floor((now - p.at) / 1000)}s old); newer ticks are a fresh request, not a retype`);
          return true;
        };
        if (prior?.state === 'ambiguous') {
          if (dry) { log(`${ts} ${name}: an earlier send is unreconciled (${safeDetail(prior.detail)}); not retyped, not acked`); return; }
          if (prior.receiver !== receiver) { log(`${ts} ${name}: an earlier send is unreconciled for another receiver (${prior.receiver}); held for a human`); return; }
          // Reissue by its own id first: a confirmation from Orca settles it.
          const unsafe = prior.requestId ? safeToType() : null;
          const r = unsafe || !prior.requestId ? null : await submit(cfg, runAsync, prior.handle, prior.text, prior.requestId);
          let resolved = r?.kind === 'confirmed' ? 'reconciled as delivered' : '';
          if (!resolved) {
            // Otherwise only evidence resolves it (#26055): accepted, same receiver (checked above), composer provably empty,
            // and the worker's own session checked the channel after the send. It types nothing, so busy does not veto it.
            const why = !(wasAccepted(prior.detail) || (r !== null && wasAccepted(r.detail))) ? 'Orca never reported the input accepted'
              : !readComposer().empty ? 'composer not provably empty'
                : deliveryEvidence(cfg, run, id, prior);
            if (why === null) resolved = 'resolved as delivered on evidence (accepted, composer empty, channel checked after the send)';
            else {
              const s = why === 'composer not provably empty' ? strandedDraft(prior) : null;
              if (s) { log(`${ts} ${name}: ${s}`); return; }
              const held = unsafe ? `unreconciled request not reissued (held: ${unsafe})` : `earlier request still unreconciled (${safeDetail(r?.detail ?? prior.detail)})`;
              const person = now - prior.at >= NEEDS_PERSON_AFTER_MS ? 'needs a person' : 'not retyped, not acked';
              log(`${ts} ${name}: ${held}; no delivery evidence yet (${why}); ${person}`);
              if (!allowFreshTick(prior)) return;
            }
          }
          if (displaced) prior = undefined;
          else {
            prior = receipts[id] = { state: 'sent', coverage: prior.coverage, receiver: prior.receiver, at: now };
            saveReceipts(stateDir, receipts);
            log(`${ts} ${name}: earlier request ${resolved}`);
          }
        }

        const covered = prior?.state === 'sent' && prior.receiver === receiver ? prior.coverage : [];
        const newWork = work.filter((t) => !covered.includes(t) && !unresolvedCovers(t, unresolved) && (!displaced || tickParts(t) !== null));
        // No new work to name: only confirmed coverage can be acked. Archived ambiguity never supplies coverage.
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
        const taskOf = new Map<string, { id: string; event: string; eventId: string }>();
        for (const r of w.reasons) if (r.kind === 'TASK') taskOf.set(taskKey(r.task.eventId, r.task.chainIndex), r.task);
        const newTickers = new Set<string>();
        const newTasks: NudgeTask[] = [];
        let unknown = false;
        for (const t of newWork) {
          if (t.startsWith('task:')) {
            const r = taskOf.get(t);
            if (!r) { unknown = true; break; }
            newTasks.push({ id: r.id, event: ASSIGNMENT_EVENTS.has(r.event) ? 'ASSIGNED' : r.event as NudgeTask['event'], eventId: r.eventId });
          } else {
            const found = nameOf.get(t.slice(0, t.lastIndexOf(':')));
            if (!found) { unknown = true; break; }
            newTickers.add(found);
          }
        }
        if (unknown) { log(`${ts} ${name}: held (the uncovered tick work cannot be identified; reconcile rather than repeat covered work)`); return; }
        // An alarm is named with its rule, read from the alarm itself (the wake does not carry it). Unreadable, unknown,
        // not a plain rule, or already acknowledged: held, and the next pass's wake decides again.
        for (const t of newTasks) {
          if (t.event !== 'ALARM') continue;
          let alarm: any;
          try { alarm = findAlarm(cfg, run, t.id, t.eventId as string); } catch (e) { log(`${ts} ${name}: held (the alarm cannot be read: ${describeError(e)})`); return; }
          if (!alarm || typeof alarm.type !== 'string' || !STALL_RULE.test(alarm.type)) { log(`${ts} ${name}: held (the alarm's rule cannot be established)`); return; }
          if (alarm.acknowledgedAt) { log(`${ts} ${name}: held (the alarm was acknowledged meanwhile; left for the next pass)`); return; }
          t.rule = alarm.type;
        }

        const unsafe = safeToType();
        if (unsafe) { log(`${ts} ${name}: held (${unsafe})`); return; }
        const text = (displaced ? `Fresh tick request at ${ts}: ` : '') + nudgeText([...newTickers], newTasks);
        if (dry) { log(`${ts} ${name}: WOULD nudge ${handle}`); return; }
        const coverage = [...new Set([...covered, ...newWork])].sort();
        // The ASSIGNED task identities this send names, kept on the receipt: the assignment wake is gone once the task
        // starts, and a started task is their delivery evidence. An alarm or a finished child has no such proof (its
        // receiver need not be the assignee), so its evidence is the channel check alone, as for a tick.
        const tasks: Record<string, string> = {};
        for (const t of newWork) {
          const r = t.startsWith('task:') ? taskOf.get(t) : undefined;
          if (r && ASSIGNMENT_EVENTS.has(r.event)) tasks[t] = r.id;
        }

        // Persist the UNRESOLVED INTENT before anything can be submitted (#2070 LOCAL P2-1). If the process dies, or any later
        // receipt write fails, after Orca took the input, this entry is what stops the next pass from typing the same wake again:
        // it is an ambiguous record without a request identity, which is held for a human and never retyped or acked. If the
        // intent itself cannot be written, nothing is sent.
        // The worker's last check on the SERVER clock, so a later pass can tell a check after this send from the one before.
        let checkedBefore: string | null;
        try { checkedBefore = lastChecked(cfg, run, id); } catch (e) {
          log(`${ts} ${name}: held (the worker's check status is unreadable before the send: ${describeError(e)}); nothing sent`);
          return;
        }
        // Write the old request BEFORE the replacement intent. A crash between writes still leaves the old receipt
        // holding; no archive write failure can lead to typing. Its original timestamp and evidence stay unchanged.
        if (displaced) {
          // Re-check after the same-id replay and evidence reads: a replacement request is not bound to the old id.
          const latest = listTerminals(cfg, run);
          const [currentHandle] = resolveTerminal(entry, latest, cfg, run);
          const incarnation = (latest.find((t) => t.handle === currentHandle) as any)?.incarnationId;
          if (currentHandle !== handle || !incarnation || `${currentHandle}#${incarnation}` !== displaced.receiver) {
            log(`${ts} ${name}: held (the terminal incarnation changed before the fresh request); nothing sent`);
            return;
          }
          const key = JSON.stringify([id, displaced.receiver, displaced.at, displaced.requestId ?? null]);
          needsPerson[key] = { ...displaced, workerId: id };
          try { saveReceipts(stateDir, needsPerson, NEEDS_PERSON_FILE); } catch (e) {
            log(`${ts} ${name}: held (the old request could not be retained: ${errno(e)}); nothing sent`);
            return;
          }
        }
        const before = receipts[id];
        const restore = (): void => { if (before) receipts[id] = before; else delete receipts[id]; };
        receipts[id] = { state: 'ambiguous', coverage, receiver, at: now, detail: 'send intent recorded before submission; outcome unknown', text, handle, tasks, checkedBefore };
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
          // Never an ack or replay of this work as new: retain its identity for reconciliation. Only later ticks
          // after another two cadences may displace it, with this record retained for a person.
          receipts[id] = { state: 'ambiguous', coverage, receiver, at: now, detail: r.detail, text, handle, tasks, checkedBefore, ...(r.requestId ? { requestId: r.requestId } : {}) };
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
 * posted after it, and still stamps the check on an empty read. On a failed read nothing is marked, and a read whose
 * output the worker's tool truncated or saved counts only once the worker has read the rest (George's #2156 residual).
 */
export function nudgeText(tickers: string[], tasks: Array<string | NudgeTask>): string {
  const tagged = 'run `hadron team chat read --mentions-me --limit 1` (it prints `cursor #C; channel head #H`), '
    + 'then `hadron team chat read --mentions-me --since C --all` and act on the tagged messages it returns; '
    + 'only if that read succeeded and you saw all of its output (if your tool truncated or saved it, read the rest first; '
    + 'if you can\'t, don\'t mark), run `hadron team chat mark-read --through H` with the H that read printed';
  // #2138 (Marco #26709): a coordinator's ticker asks for its base tick, the tagged check FIRST and then the sweep, so
  // the nudge never tells a coordinator to skip the sweep. A wake that carries both tickers is the coordinator's.
  const check = tickers.some((t) => BASE_TICK_TICKERS.has(t))
    ? `run your base tick (${BASE_TICK_TASK}): first the tagged check: ${tagged}; then the sweep of your owned tasks, alarms and ready heads`
    : tagged;
  const rule = 'No unfiltered chat catch-up.';
  // #2138 (Diego #28498): a tick lands mid-build too, so it never tells the worker to stop; it resumes what was running.
  if (!tasks.length) return `Hadron ticker wake (${tickers.join(', ')}): ${check}; then continue your in-progress work; end your turn only if you have none. ${rule}`;
  const all = tasks.map((t): NudgeTask => (typeof t === 'string' ? { id: t, event: 'ASSIGNED' } : t));
  const assigned = [...new Set(all.filter((t) => t.event === 'ASSIGNED').map((t) => t.id))];
  const alarms = all.filter((t) => t.event === 'ALARM');
  const children = all.filter((t) => t.event === 'CHILD_FINISHED');
  const ticker = tickers.length ? `; ticker ${tickers.join(', ')}` : '';
  const which = assigned.length === 1 ? `hadron team task get ${assigned[0]}` : 'hadron team task list';
  if (!alarms.length && !children.length) return `Hadron task assigned (${assigned.join(', ')}${ticker}): ${check}; then start the task (\`${which}\`). ${rule}`;
  // #1704: an alarm names its task and rule and how to acknowledge it, since delivery is never an acknowledgement
  // (cor:agt:050:20); a finished child names the child.
  const items = [
    ...(assigned.length ? [`assigned ${assigned.join(', ')}`] : []),
    ...alarms.map((a) => `stall alarm ${a.rule} on task ${a.id}`),
    ...children.map((c) => `child task ${c.id} finished`),
  ];
  const actions = [
    ...(assigned.length ? [`start the assigned task (\`${which}\`)`] : []),
    ...alarms.map((a) => `act on task ${a.id} (\`hadron team task get ${a.id}\`), then acknowledge its alarm with \`hadron team alarm ack ${a.eventId}\` (this message is not an acknowledgement)`),
    ...children.map((c) => `review the finished child task (\`hadron team task get ${c.id}\`)`),
  ];
  return `Hadron task wake (${items.join('; ')}${ticker}): ${check}; then ${actions.join('; ')}. ${rule}`;
}

/**
 * #2138 (Marco #26709): the tickers whose nudge asks for the coordinator's base tick rather than the bare tagged check,
 * and the task that tick is. Named by ticker name, the way the wake reports it.
 */
export const BASE_TICK_TICKERS: ReadonlySet<string> = new Set(['coordinator-tick']);
const BASE_TICK_TASK = 'coordinator-system:tasks:on-base-tick';

/** A task event a nudge names (#1704). An alarm carries its event id (what `team alarm ack` takes) and its stall rule. */
export interface NudgeTask { id: string; event: 'ASSIGNED' | 'ALARM' | 'CHILD_FINISHED'; eventId?: string; rule?: string }

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
