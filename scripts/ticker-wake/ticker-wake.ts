/**
 * Ticker-only wake delivery for an Orca host (Hugo, 2026-10-18; corrected after
 * the #2070 gate, 2026-10-19).
 *
 * Delivers ONLY wakes whose reasons are TICK (optionally with MENTION) from
 * hadron dueWakes to the worker's terminal, then acks the wake by proof.
 * Mentions are not relayed: chat posts reach terminals through
 * hadron-chat-send. Interim until hadron-cli#907 (C1); shares no token, ledger
 * or lock with the attention router.
 *
 * Per-reason contract (TICK-only; #2070 gate, Vera's receipt):
 *  - a wake whose reasons are exactly TICK: nudge once, then ack it.
 *  - any wake carrying another reason (MENTION, TASK, unknown): left alone,
 *    neither nudged nor acked. The opaque proof would also acknowledge the
 *    undelivered components, possibly marking mentions read (#2069 owns the
 *    joining policy). There is no mention-ack path in this script.
 *
 * Safety:
 *  - a nudge is typed only after the terminal proves idle AND a final read of
 *    the composer shows it empty with no Orca draft, even when tui-idle holds;
 *    unknown/menu/input state holds. Nothing is cleared or interrupted.
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
  loadConfig, DEFAULT_CONFIG, runCommand, listTerminals, resolveTerminal, provesIdle,
  readScreen, promptIsEmptyFromTerm, screenAgentFamily,
  type Config, type Runner,
} from '../orca-attention-router/router.js';

const QUERY = `query($a:String!,$p:String){dueWakes(appRef:$a,first:100,after:$p){wakes{worker{id name} reasons{kind ticker{id name}} proof} pageInfo{hasNextPage endCursor}}}`;
const ACK = `mutation($p:[String!]!){acknowledgeWakes(proofs:$p){acknowledged unchanged}}`;
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
    throw new Error(`receipts unreadable (${(e as Error).message}); stopping rather than risk a retype`);
  }
  const bad = (): never => { throw new Error('receipts malformed; stopping rather than risk a retype'); };
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

/** Parse a hadron api reply; throws a readable error on GraphQL/transport failure. */
function gql(run: Runner, argv: string[]): any {
  const res = run(argv);
  let data: any;
  try { data = JSON.parse(res.stdout); } catch { throw new Error(`unparsable reply (${res.stderr.trim().slice(0, 160)})`); }
  if (data.errors?.length || data.error) throw new Error(String(data.errors?.[0]?.message ?? data.error?.message ?? 'graphql error').slice(0, 200));
  return data.data;
}

/** Ack one proof; ok only on a real acknowledgement result. */
function ack(cfg: Config, run: Runner, proof: string): { ok: boolean; text: string } {
  try {
    const d = gql(run, [cfg.hadronCli, 'api', ACK, '-F', `p=${JSON.stringify([proof])}`]);
    const r = d?.acknowledgeWakes;
    if (!r || typeof r.acknowledged !== 'number') return { ok: false, text: 'no acknowledgement result' };
    return { ok: true, text: JSON.stringify(r) };
  } catch (e) { return { ok: false, text: (e as Error).message }; }
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
    const stages: string[] = Array.isArray(data.result.send.prompt?.stages) ? data.result.send.prompt.stages : [];
    return stages.includes('turn_started')
      ? { kind: 'confirmed', requestId, stages, detail: stages.join(',') }
      : { kind: 'uncertain', requestId, stages, detail: `accepted, turn start not confirmed (${stages.join(',') || 'no stages'})` };
  }
  if (requestId) return { kind: 'uncertain', requestId, stages: [], detail: `failed with a request identity (${JSON.stringify(data?.error ?? null).slice(0, 120)})` };
  if (data && typeof data === 'object' && data.ok === false && data.error) return { kind: 'refused', stages: [], detail: `send refused: ${JSON.stringify(data.error).slice(0, 160)}` };
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
    if (!d) throw new Error('dueWakes returned no result');
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
    const other = [...kinds(w)].filter((x) => x !== 'TICK');
    if (other.length) { log(`${ts} ${name}: left alone (also carries ${other.join(',')}; the proof would acknowledge them unseen)`); continue; }
    const entry = cfg.roster.find((e) => e.worker === id);
    if (!entry) { log(`${ts} ${name}: not on roster`); continue; }
    const ticks = proofTicks(w.proof);
    if (!ticks) { log(`${ts} ${name}: held (the proof's tick coverage cannot be established)`); continue; }
    let prior = receipts[id];

    const [handle, detail] = resolveTerminal(entry, terminals, cfg, run);
    if (!handle) { log(`${ts} ${name}: held (${detail})`); continue; }
    const term0 = terminals.find((t) => t.handle === handle) as any;
    const receiver = `${handle}#${term0?.incarnationId ?? ''}`;

    /** The idle proof plus the final empty-composer/no-draft read: required before ANYTHING that can type into this terminal. */
    const safeToType = (): string | null => {
      const [idle, why] = provesIdle(cfg, handle, detail, undefined, cfg.busyWaitMs, run);
      if (!idle) return why;
      const term = readScreen(cfg, handle, run);
      const agent = detail === 'claude' || detail === 'codex' ? detail : (screenAgentFamily(term) ?? '');
      const [empty, emptyWhy] = promptIsEmptyFromTerm(term, agent);
      return empty ? null : `composer not provably empty: ${emptyWhy}`;
    };

    // An unreconciled earlier request is reconciled with ITS OWN identity. Reissuing it can still perform input, so it
    // needs the same receiver and the same composer safety as a fresh send; without a request id it stays held for a human.
    if (prior?.state === 'ambiguous') {
      if (!prior.requestId || dry) { log(`${ts} ${name}: an earlier send is unreconciled (${prior.detail}); not retyped, not acked`); continue; }
      if (prior.receiver !== receiver) { log(`${ts} ${name}: an earlier send is unreconciled for another receiver (${prior.receiver}); held for a human`); continue; }
      const unsafe = safeToType();
      if (unsafe) { log(`${ts} ${name}: unreconciled request not reissued (held: ${unsafe})`); continue; }
      const r = submit(cfg, run, prior.handle, prior.text, prior.requestId);
      if (r.kind !== 'confirmed') { log(`${ts} ${name}: earlier request still unreconciled (${r.detail}); not retyped, not acked`); continue; }
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
    const r = submit(cfg, run, handle, text);
    if (r.kind === 'refused') { log(`${ts} ${name}: ${r.detail}; will retry`); continue; }
    if (r.kind === 'uncertain') {
      // Never an ack, never a fresh type: recorded with its request identity so it can be reconciled.
      receipts[id] = { state: 'ambiguous', coverage, receiver, at: now, detail: r.detail, text, handle, ...(r.requestId ? { requestId: r.requestId } : {}) };
      saveReceipts(stateDir, receipts);
      log(`${ts} ${name}: send not confirmed (${r.detail}); left for reconciliation`);
      continue;
    }
    receipts[id] = { state: 'sent', coverage, receiver, at: now };
    saveReceipts(stateDir, receipts);
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
    if (held !== null && held !== pid && pidAlive(held)) throw new Error(`another ticker-wake (pid ${held}) holds ${lock}`);
    hooks.afterJudgedStale?.();
    // Take the takeover right. A takeover file that already exists is never cleaned up here, live owner or not: removing
    // it would repeat the check/unlink race one level down. A dead owner's file needs explicit operator cleanup.
    if (!linked(tmp, takeover)) {
      const t = ownerOf(takeover);
      throw new Error(t !== null && t !== pid && pidAlive(t)
        ? `another starter is taking over ${lock}`
        : `${takeover} was left behind (owner ${t ?? 'unknown'}); an operator must remove it after checking that no ticker-wake is starting`);
    }
    try {
      hooks.beforeUnlink?.();
      const now = ownerOf(lock);
      if (now !== null && now !== pid && pidAlive(now)) throw new Error(`another ticker-wake (pid ${now}) holds ${lock}`);
      if (now !== null) { try { unlinkSync(lock); } catch { /* gone */ } }
      if (!linked(tmp, lock)) throw new Error(`could not take ${lock}: it was taken meanwhile`);
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
  try { release = acquireLock(stateDir); } catch (e) { log(`ticker-wake: ${(e as Error).message}`); return 1; }
  try {
    for (let n = 0; ; n++) {
      try { pass(cfg, run, opts, log, stateDir); } catch (e) { log(`${new Date().toISOString()} pass failed: ${(e as Error).message}`); }
      if (mode === 'once' || (deps.maxPasses !== undefined && n + 1 >= deps.maxPasses)) return 0;
      await (deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(seconds * 1000);
    }
  } finally { release(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
