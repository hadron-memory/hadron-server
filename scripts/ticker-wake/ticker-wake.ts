/**
 * Ticker-only wake delivery for an Orca host (Hugo, 2026-10-18; corrected after
 * the #2070 gate, 2026-10-19).
 *
 * Delivers ONLY wakes that carry a TICK, from hadron dueWakes to the worker's
 * terminal, then acks the wake by proof. Mentions are not relayed: chat posts
 * reach terminals through hadron-chat-send. Interim until hadron-cli#907 (C1);
 * shares no token, ledger or lock with the attention router.
 *
 * Per-reason contract (TICK-only; #2070 gate, Vera's receipt; updated for #2102):
 *  - a wake whose reasons are TICK, or TICK joined with MENTION: nudge once, then
 *    ack it. Since #2069 (landed in #2102) a MENTION-only reservation absorbs a
 *    later tick, so a worker holding an outstanding mention is offered a
 *    TICK+MENTION wake; skipping it would starve that worker of ticks. Since R53
 *    (#2072, cor:agt:080:04/:16) acknowledging a wake moves NO message mark: it
 *    records the tick and spends the reservation, and the mention stays unread
 *    and due (it is delivered by an S1 batch / hadron-chat-send, never by this
 *    script). The nudge tells the worker to run its standing routine and read only its own
 *    mentions; it forbids an unfiltered chat catch-up.
 *  - any wake carrying another reason (TASK, unknown): left alone, neither
 *    nudged nor acked. A proof naming task events records them delivered
 *    unseen (T5 receipts), and this script does not deliver tasks.
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
 *  - one instance per state dir (atomic lock file).
 *
 * usage: tsx ticker-wake.ts once [--dry]
 *        tsx ticker-wake.ts loop [--interval <seconds>=120]
 */
import { linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadConfig, DEFAULT_CONFIG, runCommand, listTerminals, resolveTerminal,
  readScreen, promptIsEmptyFromTerm, screenAgentFamily, isIdle, idleProofAbovePrompt,
  type Config, type Runner,
} from '../orca-attention-router/router.js';

export const QUERY = `query($a:String!,$p:String){dueWakes(appRef:$a,first:100,after:$p){wakes{worker{id name} reasons{kind ticker{id name}} proof anchorAt deliverAfter busyDeadline} pageInfo{hasNextPage endCursor}}}`;
export const ACK = `mutation($p:[String!]!){acknowledgeWakes(proofs:$p){acknowledged unchanged}}`;
const MAX_PAGES = 10;

type Log = (line: string) => void;
export interface Opts { dry?: boolean; now?: () => number }

/** What a confirmed send covered, and who received it. */
interface Delivered { state: 'sent'; coverage: string[]; receiver: string; at: number }
/** An accepted-but-unconfirmed or failed-after-possible-submission send, kept until reconciled. */
interface Ambiguous { state: 'ambiguous'; coverage: string[]; receiver: string; at: number; detail: string; text: string; handle: string; requestId?: string }
type Receipt = Delivered | Ambiguous;
type Receipts = Record<string, Receipt>; // by worker id

/** The ticks a proof carries ("tickerId:k"), decoded from its payload; null when it cannot be established. */
export function proofTicks(proof: string): string[] | null {
  try {
    const body = JSON.parse(Buffer.from(proof.split('.')[0], 'base64url').toString('utf8'));
    const ticks = (body.ticks ?? []).map((t: any) => `${t.tickerId}:${t.k}`);
    return ticks.length && ticks.every((t: string) => !t.includes('undefined')) ? ticks.sort() : null;
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
const SAFE_CODE = /^[A-Za-z][A-Za-z0-9_.-]{1,63}$/;
function safeCode(v: unknown): string | undefined { return typeof v === 'string' && SAFE_CODE.test(v) ? v : undefined; }
const errno = (e: unknown): string => safeCode((e as NodeJS.ErrnoException)?.code) ?? 'error';

/** An error THIS script raised, with a message it controls (class, code, pid, path): safe to log as written. */
export class SafeError extends Error {}

/**
 * The only way an exception becomes log text. This script's own SafeErrors keep their message; anything else (a router
 * helper's RouterError, a runner or filesystem exception, a bug) is reduced to a class plus an allowlisted code, because its
 * message can carry Orca or hadron output, a typed nudge, a draft or a proof (#2070 LOCAL P2-2, outer catch).
 */
export function describeError(e: unknown): string {
  if (e instanceof SafeError) return scrub(e.message);
  const name = safeCode((e as Error)?.name) ?? 'Error';
  const code = safeCode((e as NodeJS.ErrnoException)?.code)
    ?? String((e as Error)?.message ?? '').match(/"code"\s*:\s*"([A-Za-z][A-Za-z0-9_.-]{1,63})"/)?.[1];
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
const CODE_SHAPE = '[A-Za-z][A-Za-z0-9_.-]{1,63}';
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
export function submit(cfg: Config, run: Runner, handle: string, text: string, retryRequestId?: string): Submission {
  const argv = [cfg.orcaCli, 'terminal', 'send', '--terminal', handle, '--text', text, '--enter', '--wait-submit', String(cfg.submitWaitS), '--json'];
  if (retryRequestId) argv.push('--retry-request', retryRequestId);
  const first = classify(run(argv).stdout);
  // An ambiguous transport failure that names its request is reissued ONCE with that same request identity.
  if (!retryRequestId && first.kind === 'uncertain' && first.requestId && !first.stages.length) {
    const again = classify(run([...argv, '--retry-request', first.requestId]).stdout);
    const requestId = again.requestId ?? first.requestId;
    // Once a request may have been submitted, only a confirmation resolves it. A failed same-id retry (even a structured
    // refusal that carries no id) does not prove the original never submitted: it stays uncertain.
    if (again.kind === 'confirmed') return { ...again, requestId };
    return { kind: 'uncertain', requestId, stages: again.stages, detail: `${first.detail}; same-id retry: ${again.detail}` };
  }
  return first;
}

export function pass(cfg: Config, run: Runner, opts: Opts = {}, log: Log = console.log, stateDir = join(cfg.stateDir, 'ticker-wake')): void {
  const rawLog = log;
  log = (m: string): void => rawLog(scrub(m));
  const dry = Boolean(opts.dry);
  const now = (opts.now ?? Date.now)();
  const ts = new Date(now).toISOString();
  if (!dry) mkdirSync(stateDir, { recursive: true });
  const receipts = loadReceipts(stateDir); // throws on unreadable/malformed state

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
  if (more) log(`${ts} dueWakes has more than ${MAX_PAGES} pages; the rest wait for a later pass`);

  const kinds = (w: any): Set<string> => new Set(w.reasons.map((r: any) => r.kind));
  const due = wakes.filter((w) => kinds(w).has('TICK'));
  const terminals = due.length ? listTerminals(cfg, run) : [];
  for (const w of due) {
    const name = w.worker.name;
    const id: string = w.worker.id;
    const other = [...kinds(w)].filter((x) => x !== 'TICK' && x !== 'MENTION');
    if (other.length) { log(`${ts} ${name}: left alone (also carries ${other.join(',')}; the proof would record them delivered unseen)`); continue; }
    const entry = cfg.roster.find((e) => e.worker === id);
    if (!entry) { log(`${ts} ${name}: not on roster`); continue; }
    const ticks = proofTicks(w.proof);
    if (!ticks) { log(`${ts} ${name}: held (the proof's tick coverage cannot be established)`); continue; }
    let prior = receipts[id];

    // The server owns the timing (R63): anchor, floor and busy deadline come with the wake and are never recomputed or
    // remembered here, so a re-offer, a join or a restart cannot restart them. Missing/unparsable timing holds.
    const at = (v: unknown): number => (typeof v === 'string' ? Date.parse(v) : NaN);
    const deliverAfter = at(w.deliverAfter);
    const busyDeadline = at(w.busyDeadline);
    if (!Number.isFinite(deliverAfter) || !Number.isFinite(busyDeadline) || !Number.isFinite(at(w.anchorAt))) { log(`${ts} ${name}: held (the wake carries no server timing)`); continue; }

    const [handle, detail] = resolveTerminal(entry, terminals, cfg, run);
    if (!handle) { log(`${ts} ${name}: held (${detail})`); continue; }
    const term0 = terminals.find((t) => t.handle === handle) as any;
    const receiver = `${handle}#${term0?.incarnationId ?? ''}`;

    /**
     * The R63 delivery gate for anything that can type into this terminal. The composer rules are unconditional: a
     * draft, a question/menu, unknown input or identity, or a foreign composer always holds. Before the server's
     * deliverAfter nothing is typed; "busy" alone vetoes only until the server's busyDeadline, then stops vetoing.
     */
    const safeToType = (): string | null => {
      if (now < deliverAfter) return `before deliverAfter ${new Date(deliverAfter).toISOString()}`;
      const idleNow = isIdle(cfg, handle, cfg.busyWaitMs, run);
      const term = readScreen(cfg, handle, run);
      const agent = detail === 'claude' || detail === 'codex' ? detail : (screenAgentFamily(term) ?? '');
      const [empty, emptyWhy] = promptIsEmptyFromTerm(term, agent);
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
      if (!prior.requestId || dry) { log(`${ts} ${name}: an earlier send is unreconciled (${safeDetail(prior.detail)}); not retyped, not acked`); continue; }
      if (prior.receiver !== receiver) { log(`${ts} ${name}: an earlier send is unreconciled for another receiver (${prior.receiver}); held for a human`); continue; }
      const unsafe = safeToType();
      if (unsafe) { log(`${ts} ${name}: unreconciled request not reissued (held: ${unsafe})`); continue; }
      const r = submit(cfg, run, prior.handle, prior.text, prior.requestId);
      if (r.kind !== 'confirmed') { log(`${ts} ${name}: earlier request still unreconciled (${safeDetail(r.detail)}); not retyped, not acked`); continue; }
      prior = receipts[id] = { state: 'sent', coverage: prior.coverage, receiver: prior.receiver, at: now };
      saveReceipts(stateDir, receipts);
      log(`${ts} ${name}: earlier request reconciled as delivered`);
    }

    const covered = prior?.state === 'sent' && prior.receiver === receiver ? prior.coverage : [];
    const newTicks = ticks.filter((t) => !covered.includes(t));
    // Everything in this proof was already delivered to this receiver: only the ack is missing.
    if (!newTicks.length) {
      if (dry) { log(`${ts} ${name}: WOULD ack-only (covered by a confirmed receipt)`); continue; }
      const a = ack(cfg, run, w.proof);
      log(`${ts} ${name}: ack-only recovery ${a.ok ? 'acked' : 'FAILED'} ${a.text}`);
      if (a.ok) { delete receipts[id]; saveReceipts(stateDir, receipts); }
      continue;
    }

    // Otherwise a fresh nudge for ONLY the uncovered tick work; if it cannot be identified, hold rather than repeat covered work.
    const nameOf = new Map<string, string>();
    for (const r of w.reasons) if (r.kind === 'TICK' && r.ticker?.id) nameOf.set(r.ticker.id, r.ticker.name);
    const newTickers = new Set<string>();
    for (const t of newTicks) {
      const tickerName = nameOf.get(t.slice(0, t.lastIndexOf(':')));
      if (!tickerName) { newTickers.clear(); break; }
      newTickers.add(tickerName);
    }
    if (!newTickers.size) { log(`${ts} ${name}: held (the uncovered tick work cannot be identified; reconcile rather than repeat covered work)`); continue; }

    const unsafe = safeToType();
    if (unsafe) { log(`${ts} ${name}: held (${unsafe})`); continue; }
    const text = `Hadron ticker wake (${[...newTickers].join(', ')}): run your standing routine for this tick, then end your turn. Read only your own mentions; no unfiltered chat catch-up.`;
    if (dry) { log(`${ts} ${name}: WOULD nudge ${handle}`); continue; }
    const coverage = [...new Set([...covered, ...ticks])].sort();

    // Persist the UNRESOLVED INTENT before anything can be submitted (#2070 LOCAL P2-1). If the process dies, or any later
    // receipt write fails, after Orca took the input, this entry is what stops the next pass from typing the same wake again:
    // it is an ambiguous record without a request identity, which is held for a human and never retyped or acked. If the
    // intent itself cannot be written, nothing is sent.
    const before = receipts[id];
    const restore = (): void => { if (before) receipts[id] = before; else delete receipts[id]; };
    receipts[id] = { state: 'ambiguous', coverage, receiver, at: now, detail: 'send intent recorded before submission; outcome unknown', text, handle };
    try { saveReceipts(stateDir, receipts); } catch (e) {
      restore();
      log(`${ts} ${name}: held (the send intent could not be recorded: ${errno(e)}); nothing sent`);
      continue;
    }
    const r = submit(cfg, run, handle, text);
    if (r.kind === 'refused') {
      // Orca says nothing was typed: the intent is withdrawn so the next pass retries. If that write fails, the intent stays
      // on disk and the wake is held for a human (fail closed).
      restore();
      try { saveReceipts(stateDir, receipts); } catch (e) { log(`${ts} ${name}: could not withdraw the send intent (${errno(e)}); held for a human`); }
      log(`${ts} ${name}: ${safeDetail(r.detail)}; will retry`);
      continue;
    }
    if (r.kind === 'uncertain') {
      // Never an ack, never a fresh type: recorded with its request identity so it can be reconciled.
      receipts[id] = { state: 'ambiguous', coverage, receiver, at: now, detail: r.detail, text, handle, ...(r.requestId ? { requestId: r.requestId } : {}) };
      try { saveReceipts(stateDir, receipts); } catch (e) { log(`${ts} ${name}: could not update the send record (${errno(e)}); the earlier intent stays and holds the wake`); }
      log(`${ts} ${name}: send not confirmed (${safeDetail(r.detail)}); left for reconciliation`);
      continue;
    }
    receipts[id] = { state: 'sent', coverage, receiver, at: now };
    try { saveReceipts(stateDir, receipts); } catch (e) {
      // Orca confirmed the turn started but the receipt could not be written: the intent on disk still marks the wake as
      // unreconciled, so it is never retyped; it is not acked either, and waits for a human.
      log(`${ts} ${name}: nudged ${handle} but the receipt could not be written (${errno(e)}); intent retained, not acked`);
      continue;
    }
    const a = ack(cfg, run, w.proof);
    log(`${ts} ${name}: nudged ${handle}; ${a.ok ? 'acked' : 'ack FAILED (retried ack-only next pass)'} ${a.text}`);
    if (a.ok) { delete receipts[id]; saveReceipts(stateDir, receipts); }
  }
  if (!due.length) log(`${ts} no ticker wakes due (${wakes.length} other wakes ignored)`);
}

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
  /** loop only: stop after this many passes (tests). */
  maxPasses?: number;
  now?: () => number;
}

/** CLI entry. Returns the exit code; 2 for a usage error. */
export async function main(argv: string[], deps: MainDeps = {}): Promise<number> {
  const log = deps.log ?? console.log;
  const [mode, ...rest] = argv;
  const usage = (m: string): number => { log(`ticker-wake: ${m}\nusage: once [--dry] | loop [--interval <seconds>]`); return 2; };
  if (mode !== 'once' && mode !== 'loop') return usage(`unknown mode ${JSON.stringify(mode)}`);
  const allowed = mode === 'once' ? ['--dry'] : ['--interval'];
  let seconds = 120;
  let dry = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!allowed.includes(a)) return usage(`${a} is not valid for ${mode}`);
    if (a === '--dry') dry = true;
    else {
      const v = rest[++i];
      seconds = v !== undefined && /^\d+(\.\d+)?$/.test(v) ? Number(v) : NaN;
      if (!Number.isFinite(seconds) || seconds < 10) return usage('--interval needs a number of seconds, at least 10');
    }
  }
  const cfg = (deps.load ?? (() => loadConfig(DEFAULT_CONFIG)))();
  const run = deps.run ?? runCommand;
  const opts: Opts = { dry, now: deps.now };
  const stateDir = join(cfg.stateDir, 'ticker-wake');
  if (dry) { pass(cfg, run, opts, log, stateDir); return 0; }
  let release: () => void;
  try { release = acquireLock(stateDir); } catch (e) { log(`ticker-wake: ${describeError(e)}`); return 1; }
  try {
    for (let n = 0; ; n++) {
      try { pass(cfg, run, opts, log, stateDir); } catch (e) { log(`${new Date().toISOString()} pass failed: ${describeError(e)}`); }
      if (mode === 'once' || (deps.maxPasses !== undefined && n + 1 >= deps.maxPasses)) return 0;
      await (deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(seconds * 1000);
    }
  } finally { release(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
