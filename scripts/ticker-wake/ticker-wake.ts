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
 *  - a CONFIRMED send (Orca reports the turn started) is recorded in a durable
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
  loadConfig, DEFAULT_CONFIG, runCommand, listTerminals, resolveTerminal, provesIdle, sendNudge,
  readScreen, promptIsEmptyFromTerm, screenAgentFamily,
  type Config, type Runner,
} from '../orca-attention-router/router.js';

const QUERY = `query($a:String!,$p:String){dueWakes(appRef:$a,first:100,after:$p){wakes{worker{id name} reasons{kind ticker{name}} proof} pageInfo{hasNextPage endCursor}}}`;
const ACK = `mutation($p:[String!]!){acknowledgeWakes(proofs:$p){acknowledged unchanged}}`;
const MAX_PAGES = 10;

type Log = (line: string) => void;
export interface Opts { dry?: boolean; now?: () => number }

/** What a confirmed send covered, and who received it. */
interface Delivered { state: 'sent'; coverage: string[]; receiver: string; at: number }
/** An accepted-but-unconfirmed or unparsable send: kept until a human reconciles it. */
interface Ambiguous { state: 'ambiguous'; coverage: string[]; receiver: string; at: number; detail: string }
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
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch { throw new Error('receipts malformed; stopping rather than risk a retype'); }
  for (const r of Object.values(parsed ?? {}) as any[]) {
    if (!r || (r.state !== 'sent' && r.state !== 'ambiguous') || !Array.isArray(r.coverage) || typeof r.receiver !== 'string') throw new Error('receipts malformed; stopping rather than risk a retype');
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

/** Orca reports the submitted prompt started a turn: the only result that counts as a confirmed submission. */
const CONFIRMED = /turn_started|submitted/;

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
    const prior = receipts[id];
    if (prior?.state === 'ambiguous') { log(`${ts} ${name}: an earlier send is unreconciled (${prior.detail}); not retyped, not acked`); continue; }

    const [handle, detail] = resolveTerminal(entry, terminals, cfg, run);
    if (!handle) { log(`${ts} ${name}: held (${detail})`); continue; }
    const term0 = terminals.find((t) => t.handle === handle) as any;
    const receiver = `${handle}#${term0?.incarnationId ?? ''}`;

    // A receipt for the SAME receiver that fully covers this proof: the nudge was already typed; only the ack is missing.
    if (prior?.state === 'sent' && prior.receiver === receiver && ticks.every((t) => prior.coverage.includes(t))) {
      if (dry) { log(`${ts} ${name}: WOULD ack-only (covered by a confirmed receipt)`); continue; }
      const a = ack(cfg, run, w.proof);
      log(`${ts} ${name}: ack-only recovery ${a.ok ? 'acked' : 'FAILED'} ${a.text}`);
      if (a.ok) { delete receipts[id]; saveReceipts(stateDir, receipts); }
      continue;
    }
    // Otherwise (no receipt, a replacement receiver, or new ticks): a fresh nudge for the uncovered ticks.
    const [idle, why] = provesIdle(cfg, handle, detail, undefined, cfg.busyWaitMs, run);
    if (!idle) { log(`${ts} ${name}: held (${why})`); continue; }
    // Final composer check, even when tui-idle held: the idle helper does not read the draft.
    const term = readScreen(cfg, handle, run);
    const agent = detail === 'claude' || detail === 'codex' ? detail : (screenAgentFamily(term) ?? '');
    const [empty, emptyWhy] = promptIsEmptyFromTerm(term, agent);
    if (!empty) { log(`${ts} ${name}: held (composer not provably empty: ${emptyWhy})`); continue; }
    const tickers = [...new Set(w.reasons.map((r: any) => r.ticker?.name))].join(', ');
    const text = `Hadron ticker wake (${tickers}): run your standing routine for this tick, then end your turn. Read only your own mentions; no unfiltered chat catch-up.`;
    if (dry) { log(`${ts} ${name}: WOULD nudge ${handle}`); continue; }
    const covered = prior?.state === 'sent' && prior.receiver === receiver ? prior.coverage : [];
    const coverage = [...new Set([...covered, ...ticks])].sort();
    const [ok, sendDetail] = sendNudge(cfg, handle, text, run);
    if (!ok && !/unparsable/.test(sendDetail)) { log(`${ts} ${name}: send refused (${sendDetail}); will retry`); continue; }
    if (!ok || !CONFIRMED.test(sendDetail)) {
      // Accepted without a confirmed submission, or an unparsable receipt: uncertainty, never an ack, never a retype.
      receipts[id] = { state: 'ambiguous', coverage, receiver, at: now, detail: ok ? `accepted, not confirmed (${sendDetail})` : sendDetail };
      saveReceipts(stateDir, receipts);
      log(`${ts} ${name}: send not confirmed (${receipts[id] && (receipts[id] as Ambiguous).detail}); left for reconciliation`);
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

/**
 * One instance per state dir. Acquisition is atomic: the owner's pid goes into
 * a private temp file that is hard-linked to `lock` (link fails if it exists),
 * so two simultaneous starters cannot both win. A lock whose owner is gone is
 * removed once and the link retried; the loser of any race is refused.
 */
export function acquireLock(dir: string, pid = process.pid): () => void {
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, 'lock');
  const tmp = join(dir, `lock.${pid}.${Math.random().toString(36).slice(2)}`);
  writeFileSync(tmp, String(pid));
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { linkSync(tmp, lock); return () => { try { if (readFileSync(lock, 'utf8').trim() === String(pid)) unlinkSync(lock); } catch { /* gone */ } }; } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
      let held = 0;
      try { held = Number(readFileSync(lock, 'utf8').trim()); } catch { continue; } // vanished: retry the link
      if (held !== pid && pidAlive(held)) throw new Error(`another ticker-wake (pid ${held}) holds ${lock}`);
      try { if (Number(readFileSync(lock, 'utf8').trim()) === held) unlinkSync(lock); } catch { /* someone else removed it */ }
    }
    throw new Error(`could not take ${lock}: another starter won the race`);
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
