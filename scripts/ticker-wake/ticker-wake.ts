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
 * Per-reason contract:
 *  - TICK, or TICK+MENTION: nudge once, then ack the wake.
 *  - any wake carrying another reason (TASK, unknown): left alone, neither
 *    nudged nor acked; an opaque proof cannot discard unseen components
 *    (#2069 owns the joining policy).
 *  - MENTION-only: ignored, unless --ack-mentions (OFF by default, Holger's
 *    ruling pending) and the worker is a ticker subscriber on the roster; then
 *    it is acked WITHOUT a nudge.
 *
 * Safety:
 *  - a nudge is typed only after the terminal proves idle AND a final read of
 *    the composer shows it empty with no Orca draft, even when tui-idle holds;
 *    unknown/menu/input state holds. Nothing is cleared or interrupted.
 *  - a confirmed send is recorded in a durable receipt BEFORE the ack, so a
 *    lost ack is retried as ack-only and never re-typed; an ambiguous send is
 *    never retyped nor acked.
 *  - one instance per state dir (lock file).
 *
 * usage: tsx ticker-wake.ts once [--dry] [--ack-mentions]
 *        tsx ticker-wake.ts loop [--interval <seconds>=120] [--ack-mentions]
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadConfig, DEFAULT_CONFIG, runCommand, listTerminals, resolveTerminal, provesIdle, sendNudge,
  readScreen, promptIsEmptyFromTerm, screenAgentFamily,
  type Config, type Runner,
} from '../orca-attention-router/router.js';

const QUERY = `query($a:String!,$p:String){dueWakes(appRef:$a,first:100,after:$p){wakes{worker{id name} reasons{kind ticker{name}} proof} pageInfo{hasNextPage endCursor}}}`;
const SUBS = `query($a:String!){tickers(appRef:$a){subscribers(first:200){items{worker{id}} hasNextPage}}}`;
const ACK = `mutation($p:[String!]!){acknowledgeWakes(proofs:$p){acknowledged unchanged}}`;
const MAX_PAGES = 10;
const RECEIPT_TTL_MS = 24 * 3600_000;

type Log = (line: string) => void;
export interface Opts { dry?: boolean; ackMentions?: boolean; now?: () => number }
interface Receipt { state: 'sent' | 'ambiguous'; at: number }

/** Stable delivery identity of a wake: worker + the ticks it carries (decoded from the proof; falls back to the proof itself). */
export function wakeIdentity(workerId: string, proof: string): string {
  try {
    const body = JSON.parse(Buffer.from(proof.split('.')[0], 'base64url').toString('utf8'));
    const ticks = (body.ticks ?? []).map((t: any) => `${t.tickerId}:${t.k}`).sort();
    if (ticks.length) return `${workerId}|${ticks.join(',')}`;
  } catch { /* fall through */ }
  return `${workerId}|proof:${proof}`;
}

function receiptsPath(dir: string): string { return join(dir, 'receipts.json'); }
function loadReceipts(dir: string, now: number): Record<string, Receipt> {
  try {
    const raw = JSON.parse(readFileSync(receiptsPath(dir), 'utf8')) as Record<string, Receipt>;
    return Object.fromEntries(Object.entries(raw).filter(([, r]) => now - r.at < RECEIPT_TTL_MS));
  } catch { return {}; }
}
function saveReceipts(dir: string, r: Record<string, Receipt>): void {
  const tmp = `${receiptsPath(dir)}.tmp`;
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

/** Ack one proof; true only on a real acknowledgement result. */
function ack(cfg: Config, run: Runner, proof: string): { ok: boolean; text: string } {
  try {
    const d = gql(run, [cfg.hadronCli, 'api', ACK, '-F', `p=${JSON.stringify([proof])}`]);
    const r = d?.acknowledgeWakes;
    if (!r || typeof r.acknowledged !== 'number') return { ok: false, text: 'no acknowledgement result' };
    return { ok: true, text: JSON.stringify(r) };
  } catch (e) { return { ok: false, text: (e as Error).message }; }
}

export function pass(cfg: Config, run: Runner, opts: Opts = {}, log: Log = console.log, stateDir = join(cfg.stateDir, 'ticker-wake')): void {
  const dry = Boolean(opts.dry);
  const now = (opts.now ?? Date.now)();
  const ts = new Date(now).toISOString();
  if (!dry) mkdirSync(stateDir, { recursive: true });

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
  const rosterOf = (w: any) => cfg.roster.find((e) => e.worker === w.worker.id);

  // --ack-mentions (OFF): clear an invisible MENTION-only reservation of a roster worker that subscribes a ticker.
  if (opts.ackMentions) {
    let subIds: Set<string> | null = null;
    try {
      const t = gql(run, [cfg.hadronCli, 'api', SUBS, '-F', `a=${cfg.app}`]).tickers ?? [];
      subIds = t.some((x: any) => x.subscribers.hasNextPage) ? null : new Set(t.flatMap((x: any) => x.subscribers.items.map((i: any) => i.worker.id)));
      if (!subIds) log(`${ts} subscriber list truncated; --ack-mentions skipped`);
    } catch (e) { log(`${ts} subscriber lookup failed: ${(e as Error).message}; --ack-mentions skipped`); }
    for (const w of subIds ? wakes : []) {
      const k = kinds(w);
      if (k.size !== 1 || !k.has('MENTION') || !subIds!.has(w.worker.id) || !rosterOf(w)) continue;
      if (dry) { log(`${ts} ${w.worker.name}: WOULD ack mention-only reservation`); continue; }
      const a = ack(cfg, run, w.proof);
      log(`${ts} ${w.worker.name}: ${a.ok ? 'acked' : 'ack FAILED for'} mention-only reservation ${a.text}`);
    }
  }

  const due = wakes.filter((w) => kinds(w).has('TICK'));
  const terminals = due.length ? listTerminals(cfg, run) : [];
  const receipts = dry ? {} : loadReceipts(stateDir, now);
  for (const w of due) {
    const name = w.worker.name;
    const k = kinds(w);
    if ([...k].some((x) => x !== 'TICK' && x !== 'MENTION')) { log(`${ts} ${name}: left alone (carries ${[...k].filter((x) => x !== 'TICK' && x !== 'MENTION').join(',')}; nothing is discarded unseen)`); continue; }
    const entry = rosterOf(w);
    if (!entry) { log(`${ts} ${name}: not on roster`); continue; }
    const id = wakeIdentity(w.worker.id, w.proof);
    const prior = receipts[id];
    if (prior?.state === 'ambiguous') { log(`${ts} ${name}: an earlier send was ambiguous; not retyped, not acked`); continue; }
    if (prior?.state === 'sent') {
      const a = ack(cfg, run, w.proof);
      log(`${ts} ${name}: ack-only recovery ${a.ok ? 'acked' : 'FAILED'} ${a.text}`);
      if (a.ok) { delete receipts[id]; saveReceipts(stateDir, receipts); }
      continue;
    }
    const [handle, detail] = resolveTerminal(entry, terminals, cfg, run);
    if (!handle) { log(`${ts} ${name}: held (${detail})`); continue; }
    const [idle, why] = provesIdle(cfg, handle, detail, undefined, cfg.busyWaitMs, run);
    if (!idle) { log(`${ts} ${name}: held (${why})`); continue; }
    // Final composer check, even when tui-idle held: the idle helper does not read the draft.
    const term = readScreen(cfg, handle, run);
    const agent = detail === 'claude' || detail === 'codex' ? detail : (screenAgentFamily(term) ?? '');
    const [empty, emptyWhy] = promptIsEmptyFromTerm(term, agent);
    if (!empty) { log(`${ts} ${name}: held (composer not provably empty: ${emptyWhy})`); continue; }
    const tickers = [...new Set(w.reasons.filter((r: any) => r.kind === 'TICK').map((r: any) => r.ticker?.name))].join(', ');
    const text = `Hadron ticker wake (${tickers}): run your standing routine for this tick, then end your turn. Read only your own mentions; no unfiltered chat catch-up.`;
    if (dry) { log(`${ts} ${name}: WOULD nudge ${handle}`); continue; }
    const [ok, detailSend] = sendNudge(cfg, handle, text, run);
    if (!ok) {
      if (/unparsable/.test(detailSend)) { receipts[id] = { state: 'ambiguous', at: now }; saveReceipts(stateDir, receipts); }
      log(`${ts} ${name}: send not confirmed (${detailSend})`);
      continue;
    }
    receipts[id] = { state: 'sent', at: now };
    saveReceipts(stateDir, receipts);
    const a = ack(cfg, run, w.proof);
    log(`${ts} ${name}: nudged ${handle}; ${a.ok ? 'acked' : 'ack FAILED (retried ack-only next pass)'} ${a.text}`);
    if (a.ok) { delete receipts[id]; saveReceipts(stateDir, receipts); }
  }
  if (!due.length) log(`${ts} no ticker wakes due (${wakes.length} other wakes ignored)`);
}

/** One instance per state dir: refuse when a live ticker-wake holds the lock. */
export function acquireLock(dir: string, pid = process.pid): () => void {
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, 'lock');
  if (existsSync(lock)) {
    const held = Number(readFileSync(lock, 'utf8').trim());
    let alive = false;
    try { alive = held > 0 && readFileSync(`/proc/${held}/cmdline`, 'utf8').includes('ticker-wake'); } catch { /* gone */ }
    if (alive && held !== pid) throw new Error(`another ticker-wake (pid ${held}) holds ${lock}`);
  }
  writeFileSync(lock, String(pid));
  return () => { try { if (readFileSync(lock, 'utf8').trim() === String(pid)) unlinkSync(lock); } catch { /* already gone */ } };
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
  const usage = (m: string): number => { log(`ticker-wake: ${m}\nusage: once [--dry] [--ack-mentions] | loop [--interval <seconds>] [--ack-mentions]`); return 2; };
  if (mode !== 'once' && mode !== 'loop') return usage(`unknown mode ${JSON.stringify(mode)}`);
  const allowed = mode === 'once' ? ['--dry', '--ack-mentions'] : ['--interval', '--ack-mentions'];
  let seconds = 120;
  let dry = false;
  let ackMentions = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!allowed.includes(a)) return usage(`${a} is not valid for ${mode}`);
    if (a === '--dry') dry = true;
    else if (a === '--ack-mentions') ackMentions = true;
    else {
      const v = rest[++i];
      seconds = v !== undefined && /^\d+(\.\d+)?$/.test(v) ? Number(v) : NaN;
      if (!Number.isFinite(seconds) || seconds < 10) return usage('--interval needs a number of seconds, at least 10');
    }
  }
  const cfg = (deps.load ?? (() => loadConfig(DEFAULT_CONFIG)))();
  const run = deps.run ?? runCommand;
  const opts: Opts = { dry, ackMentions, now: deps.now };
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
