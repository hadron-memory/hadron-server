/**
 * Orca attention router: nudge Orca-hosted team workers when they are mentioned.
 *
 * One polling router per host app (Holger, 2026-09-25). This is Orca's. It
 * reads the count-only Hadron team attention API with its OWN token, and
 * nudges the Orca-hosted workers on its explicit roster by typing one short
 * line into that worker's Orca terminal. It never reads, relays or posts a
 * chat message, never marks anything read, and never changes server state.
 * The Codex Desktop router is separate; the two share no token and no roster.
 *
 * Why the rules below exist (measured 2026-09-30, finding
 * hrn:node:hadronmemory.com:hadron-server:findings:orca-terminal-send-busy-agent-claude-queues-codex-steers):
 *
 *  - A prompt typed into a BUSY Codex agent steers its turn, and it silently
 *    drops the rest of its task. So a nudge is sent only after
 *    `orca terminal wait --for tui-idle` proves the terminal idle.
 *  - Tab titles are not identity (agents retitle their own tabs), and a
 *    worktree's name does not prove which worker drives it. So each roster
 *    entry names its worktree; the terminal is the ONE agent terminal there,
 *    and a CLI worker binding in that worktree must agree.
 *  - The token is adopted only when every roster worker with new attention
 *    was nudged. A busy or unreachable worker HOLDS it, and a ledger keyed on
 *    the adopted token keeps the retry from re-nudging the others.
 *
 * Usage (see README.md):
 *   pnpm tsx scripts/orca-attention-router/router.ts poll   [--config PATH]
 *   pnpm tsx scripts/orca-attention-router/router.ts loop   [--config PATH] [--interval S]
 *   pnpm tsx scripts/orca-attention-router/router.ts status [--config PATH]
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DEFAULT_CONFIG = join(homedir(), '.config', 'hadron-orca-attention-router', 'config.json');

/** The one line a worker receives: counts only, never a message body, sequence or token. */
export function nudgeText(unread: number, mentions: number): string {
  return (
    `Hadron team attention: team has ${unread} relevant unread (${mentions} mentions) for you. ` +
    'Read team chat unfiltered with your own live Hadron session. If nothing needs your action, ' +
    'acknowledge your own read cursor and finish silently: do not post a team-chat reply or a ' +
    "user-facing 'read/no action' comment. Report only an actionable result or blocker. " +
    '(Nudged by the Orca attention router.)'
  );
}

const AGENT_IDENTITIES = new Set(['claude', 'codex']);

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type Runner = (argv: string[]) => RunResult;

/** Run a CLI and capture its output; never throws on a non-zero exit. */
export const runCommand: Runner = (argv) => {
  const proc = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 300_000 });
  return { code: proc.status ?? 1, stdout: proc.stdout ?? '', stderr: proc.stderr ?? String(proc.error ?? '') };
};

/** A failure that must leave the adopted token untouched. */
export class RouterError extends Error {}

export interface RosterEntry {
  /** The Worker's permanent id. */
  worker: string;
  name: string;
  /** The Orca worktree this worker is driven in. */
  worktree: string;
}

export interface Config {
  app: string;
  /** The team Channel's id: attention counts and the register check are scoped to it. */
  channel: string;
  hadronCli: string;
  orcaCli: string;
  stateDir: string;
  roster: RosterEntry[];
  busyWaitMs: number;
  submitWaitS: number;
}

const expandHome = (p: string) => (p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p);

/** Read and validate the router config; a roster entry needs worker, name and worktree, once each. */
export function loadConfig(path: string): Config {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const roster = (raw.roster ?? []) as RosterEntry[];
  for (const entry of roster) {
    for (const key of ['worker', 'name', 'worktree'] as const) {
      if (!entry[key]) throw new RouterError(`roster entry ${JSON.stringify(entry)} lacks "${key}"`);
    }
  }
  if (new Set(roster.map((e) => e.worker)).size !== roster.length) throw new RouterError('roster names a worker twice');
  // Two workers on one worktree would resolve to the same terminal: one
  // nudge recorded as delivered twice, one worker never told (@codex P2, #1490).
  const worktrees = roster.map((e) => real(e.worktree));
  if (new Set(worktrees).size !== worktrees.length) throw new RouterError('roster assigns one worktree to two workers');
  if (typeof raw.app !== 'string' || typeof raw.stateDir !== 'string' || typeof raw.channel !== 'string') {
    throw new RouterError('config needs "app", "channel" and "stateDir"');
  }
  return {
    app: raw.app,
    channel: raw.channel,
    hadronCli: (raw.hadronCli as string) ?? 'hadron',
    orcaCli: (raw.orcaCli as string) ?? '/Applications/Orca.app/Contents/Resources/bin/orca',
    stateDir: expandHome(raw.stateDir),
    roster,
    busyWaitMs: Number(raw.busyWaitMs ?? 60_000),
    submitWaitS: Number(raw.submitWaitS ?? 15),
  };
}

// ── State ───────────────────────────────────────────────────────────────

interface NudgeRecord {
  /** The worker's last RELEVANT (mention) seq this nudge was about. */
  relevantSeq: number;
  at: number;
  stages: string;
}
interface Ledger {
  base: string;
  nudged: Record<string, NudgeRecord>;
  reported: Record<string, string>;
}

/**
 * The adopted token plus the delivery ledger, private to this router.
 *
 * The ledger is keyed on a hash of the adopted token: it records which
 * workers were already nudged for the attention reported since that token,
 * so a poll that has to hold the token does not nudge them again. Adopting a
 * new token starts a fresh ledger.
 */
export class State {
  readonly tokenPath: string;
  readonly ledgerPath: string;

  constructor(readonly dir: string) {
    this.tokenPath = join(dir, 'adopted.token');
    this.ledgerPath = join(dir, 'ledger.json');
  }

  /** Create the private state directory (0700). */
  ensure(): void {
    mkdirSync(this.dir, { recursive: true });
    chmodSync(this.dir, 0o700);
  }

  /** The adopted token, or null before the first adoption. */
  token(): string | null {
    if (!existsSync(this.tokenPath)) return null;
    return readFileSync(this.tokenPath, 'utf8').trim() || null;
  }

  /** A fingerprint of the adopted token; never the token itself. */
  base(): string {
    return createHash('sha256').update(this.token() ?? '').digest('hex');
  }

  /** The ledger for the current base; a stale or unreadable one starts empty. */
  ledger(): Ledger {
    const base = this.base();
    let ledger: Partial<Ledger> = {};
    try {
      ledger = JSON.parse(readFileSync(this.ledgerPath, 'utf8')) as Ledger;
    } catch {
      ledger = {};
    }
    if (ledger.base !== base) return { base, nudged: {}, reported: {} };
    return { base, nudged: ledger.nudged ?? {}, reported: ledger.reported ?? {} };
  }

  saveLedger(ledger: Ledger): void {
    atomicWrite(this.ledgerPath, JSON.stringify(ledger, null, 1));
  }

  /** Adopt a token and clear the ledger: only after every delivery succeeded. */
  adopt(token: string): void {
    atomicWrite(this.tokenPath, token);
    rmSync(this.ledgerPath, { force: true });
  }
}

/** Write via a same-directory temp file and rename, mode 0600. */
function atomicWrite(path: string, text: string): void {
  const tmpDir = mkdtempSync(join(dirname(path), '.tmp-'));
  const tmp = join(tmpDir, 'f');
  try {
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, path);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** A lock with no owner record is reclaimed once it is this old (a crash between mkdir and the write). */
const OWNERLESS_LOCK_GRACE_MS = 60_000;

/** True unless the lock's recorded owner process is provably gone. */
function lockHolderAlive(lock: string): boolean {
  let pid: number;
  try {
    pid = Number(readFileSync(join(lock, 'owner'), 'utf8').trim());
  } catch {
    try {
      return Date.now() - statSync(lock).mtimeMs < OWNERLESS_LOCK_GRACE_MS;
    } catch {
      return false;
    }
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists under another user; only ESRCH proves it gone.
    return (e as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * One writer at a time: a mkdir lock in the state directory, recording its
 * owner's pid. A lock whose owner is dead (killed, crashed, host restart) is
 * reclaimed, so a crash cannot silence the router until someone notices
 * (@codex P2, #1490). A live owner is never displaced.
 */
function withLock<T>(stateDir: string, fn: () => T): T {
  const lock = join(stateDir, '.writer-lock');
  const acquire = (): boolean => {
    try {
      mkdirSync(lock);
      writeFileSync(join(lock, 'owner'), String(process.pid));
      return true;
    } catch {
      return false;
    }
  };
  if (!acquire()) {
    if (lockHolderAlive(lock)) throw new RouterError(`another router run holds ${lock}`);
    rmSync(lock, { recursive: true, force: true });
    if (!acquire()) throw new RouterError(`another router run holds ${lock}`);
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

// ── The CLIs ────────────────────────────────────────────────────────────

function parse(res: RunResult, what: string): Record<string, any> {
  try {
    return JSON.parse(res.stdout) as Record<string, any>;
  } catch {
    throw new RouterError(`${what}: unparsable output (exit ${res.code}): ${(res.stderr || res.stdout).trim().slice(0, 300)}`);
  }
}

/** One Worker/Channel pair from the paged attention poll (`TeamAttentionPageItem`). */
export interface AttentionItem {
  worker: string;
  workerName: string;
  channel: string;
  unread: number;
  unreadMentions: number;
  firstUnreadSeq: number | null;
  /** The highest seq that counts for this worker: for a mention-only row, its latest mention. */
  lastRelevantSeq: number | null;
  lastSeq: number;
}

/** Upper bound on pages drained per poll: a runaway continuation must fail, never spin. */
const MAX_PAGES = 1000;

const PAGE_QUERY = 'query($a: ID!, $s: String, $p: String) { teamAttentionPage(appRef: $a, since: $s, page: $p) '
  + '{ scanComplete nextPage adoptableSince items { worker workerName channel unread unreadMentions firstUnreadSeq lastRelevantSeq lastSeq } } }';

/**
 * One attention poll: drain the paged v2 scan (#1384). Read-only; the final
 * page's `adoptableSince` is adopted later, if at all.
 *
 * Paged v2 rather than the CLI's v1-shaped output because only v2 carries
 * `lastRelevantSeq`, the mention frontier the ledger needs (@codex P1, #1490).
 */
export function pollAttention(cfg: Config, token: string | null, run: Runner): { token: string; items: AttentionItem[] } {
  const items: AttentionItem[] = [];
  let page: string | null = null;
  for (let n = 0; n < MAX_PAGES; n++) {
    const argv = [cfg.hadronCli, 'api', PAGE_QUERY, '-F', `a=${cfg.app}`];
    if (page) argv.push('-F', `p=${page}`);
    else if (token) argv.push('-F', `s=${token}`);
    const res = run(argv);
    let data: Record<string, any> = {};
    try {
      data = JSON.parse(res.stdout);
    } catch {
      /* reported below */
    }
    const result = data.data?.teamAttentionPage;
    if (res.code !== 0 || !result || !Array.isArray(result.items)) {
      const message = data.errors?.[0]?.message ?? data.error?.message ?? res.stderr.trim().slice(0, 300);
      throw new RouterError(`attention poll failed: ${message || 'malformed result'}`);
    }
    items.push(...(result.items as AttentionItem[]));
    if (result.nextPage) {
      page = result.nextPage as string;
      continue;
    }
    if (!result.scanComplete || typeof result.adoptableSince !== 'string' || !result.adoptableSince) {
      throw new RouterError('attention poll failed: the final page carried no adoptable token');
    }
    return { token: result.adoptableSince, items };
  }
  throw new RouterError(`attention poll failed: more than ${MAX_PAGES} pages`);
}

/**
 * Whether the worker's EFFECTIVE registration on the Channel is its own,
 * mention-only row.
 *
 * Without one, the server reports a worker for ANY new message, with its
 * FULL unread-mention backlog as the count, so an old unread mention would
 * make every chat message wake it (observed in the live run, 2026-09-30).
 * Asks `attendeeRegister`, which returns the WINNING row per Channel exactly
 * as the attention API resolves it (App over organization; Worker over Agent
 * over everyone), so an organization-owned worker row counts too (@codex P2,
 * #1490). A query failure throws: absence of evidence is not a verdict.
 */
export function hasMentionOnlyRow(cfg: Config, workerId: string, run: Runner): boolean {
  const query = 'query($w: ID, $a: ID) { attendeeRegister(workerRef: $w, appRef: $a) '
    + '{ namedBy channel { id } entry { mentionOnly } } }';
  const data = parse(run([cfg.hadronCli, 'api', query, '-F', `w=${workerId}`, '-F', `a=${cfg.app}`]), 'register query');
  const rows = data.data?.attendeeRegister;
  if (!Array.isArray(rows)) throw new RouterError(`register query failed: ${JSON.stringify(data.errors ?? data.error ?? null).slice(0, 300)}`);
  const winning = rows.find((r) => r.channel?.id === cfg.channel);
  return Boolean(winning && winning.namedBy === 'WORKER' && winning.entry?.mentionOnly);
}

interface Terminal {
  handle: string;
  worktreePath?: string;
  agentIdentity?: string | null;
  connected?: boolean;
  writable?: boolean;
}

/** Orca's live terminals. */
export function listTerminals(cfg: Config, run: Runner): Terminal[] {
  const data = parse(run([cfg.orcaCli, 'terminal', 'list', '--json']), 'orca terminal list');
  if (!data.ok) throw new RouterError(`orca terminal list failed: ${JSON.stringify(data.error)}`);
  return data.result.terminals as Terminal[];
}

/**
 * True only on positive proof the agent TUI is idle within the timeout.
 *
 * Orca 1.4.217 answers a timed-out wait with an error envelope
 * (`error.code: "timeout"`); its guide describes `satisfied: false`. Both,
 * and anything else, read as not idle.
 */
export function isIdle(cfg: Config, handle: string, timeoutMs: number, run: Runner): boolean {
  const res = run([cfg.orcaCli, 'terminal', 'wait', '--terminal', handle, '--for', 'tui-idle', '--timeout-ms', String(timeoutMs), '--json']);
  try {
    const data = JSON.parse(res.stdout);
    return Boolean(data.ok) && Boolean(data.result?.wait?.satisfied);
  } catch {
    return false;
  }
}

/** The first `requestId` anywhere in a receipt: Orca reports it for a durable retry. */
function findRequestId(node: unknown): string | null {
  if (Array.isArray(node)) {
    for (const v of node) {
      const found = findRequestId(v);
      if (found) return found;
    }
  } else if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    if (typeof obj.requestId === 'string') return obj.requestId;
    for (const v of Object.values(obj)) {
      const found = findRequestId(v);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Type one line into the terminal and submit it: [accepted, detail].
 *
 * Retries once, with the same durable request id, only after an ambiguous
 * transport failure, as Orca prescribes; never re-sends on silence.
 */
export function sendNudge(cfg: Config, handle: string, text: string, run: Runner): [boolean, string] {
  const argv = [cfg.orcaCli, 'terminal', 'send', '--terminal', handle, '--text', text, '--enter',
    '--wait-submit', String(cfg.submitWaitS), '--json'];
  const accepted = (d: Record<string, any>) => Boolean(d.ok && d.result?.send?.accepted);
  let data: Record<string, any>;
  try {
    data = JSON.parse(run(argv).stdout);
  } catch {
    return [false, 'unparsable send receipt'];
  }
  if (accepted(data)) return [true, (data.result.send.prompt?.stages ?? []).join(',')];
  const retryId = findRequestId(data);
  if (retryId) {
    try {
      data = JSON.parse(run([...argv, '--retry-request', retryId]).stdout);
      if (accepted(data)) return [true, 'accepted on retry'];
    } catch {
      return [false, 'unparsable retry receipt'];
    }
  }
  return [false, `send not accepted: ${JSON.stringify(data.error ?? null)}`];
}

// ── Resolution ──────────────────────────────────────────────────────────

const real = (p: string): string => {
  try {
    return realpathSync(expandHome(p));
  } catch {
    return resolve(expandHome(p));
  }
};

/**
 * The worker id a CLI team-session binding in this worktree names, if any.
 *
 * The binding lives in the worktree's git dir (`hadron team session start`).
 * An MCP-bound worker leaves none; absence is not a mismatch.
 */
export function boundWorker(worktree: string): string | null {
  try {
    const dotGit = join(worktree, '.git');
    let gitDir = dotGit;
    if (statSync(dotGit).isFile()) {
      const pointer = readFileSync(dotGit, 'utf8').trim().replace(/^gitdir:\s*/, '');
      gitDir = isAbsolute(pointer) ? pointer : join(worktree, pointer);
    }
    const binding = JSON.parse(readFileSync(join(gitDir, 'hadron-team-session.json'), 'utf8'));
    return typeof binding.workerId === 'string' && binding.workerId ? binding.workerId : null;
  } catch {
    return null;
  }
}

/** [handle, detail]: the ONE agent terminal in this worker's worktree, or why not. */
export function resolveTerminal(entry: RosterEntry, terminals: Terminal[]): [string | null, string] {
  const worktree = real(entry.worktree);
  const bound = boundWorker(worktree);
  if (bound && bound !== entry.worker) return [null, `worktree is bound to another worker (${bound})`];
  const agents = terminals.filter(
    (t) => t.worktreePath && real(t.worktreePath) === worktree && AGENT_IDENTITIES.has(t.agentIdentity ?? '')
      && t.connected !== false && t.writable !== false,
  );
  if (agents.length === 0) return [null, 'no live agent terminal in its worktree'];
  if (agents.length > 1) return [null, `${agents.length} agent terminals in its worktree (ambiguous)`];
  return [agents[0].handle, agents[0].agentIdentity ?? ''];
}

/**
 * A nudge sent under this token still covers the worker's current attention.
 *
 * It covers it while nothing relevant has arrived since: the worker's last
 * relevant (mention) seq is no later than the one the nudge was about. A new
 * mention always has a higher seq, so it is never mistaken for covered, no
 * matter how much older, unrelated chat the worker has left unread (@codex
 * P1, #1490: the first version compared firstUnreadSeq against the head).
 */
export function alreadyNudged(record: NudgeRecord | undefined, item: AttentionItem): boolean {
  if (!record || typeof record.relevantSeq !== 'number' || item.lastRelevantSeq === null) return false;
  return item.lastRelevantSeq <= record.relevantSeq;
}

// ── One poll ────────────────────────────────────────────────────────────

export interface Outcome {
  nudged: string[];
  covered: string[];
  held: Record<string, string>;
  adopted: boolean;
}

/** One short summary line; never a token or a message body. */
export function describeOutcome(o: Outcome): string {
  const parts = [`nudged: ${o.nudged.join(', ') || 'none'}`];
  if (o.covered.length) parts.push(`already nudged: ${o.covered.join(', ')}`);
  const held = Object.entries(o.held);
  if (held.length) parts.push(`held: ${held.map(([n, r]) => `${n} (${r})`).join('; ')}`);
  parts.push(o.adopted ? 'token adopted' : 'token held');
  return parts.join(' | ');
}

/** Poll attention, nudge each idle roster worker with new mentions, adopt only if all were. */
export function pollOnce(cfg: Config, run: Runner = runCommand, log: (line: string) => void = console.log): Outcome {
  const state = new State(cfg.stateDir);
  state.ensure();
  return withLock(cfg.stateDir, () => {
    const attention = pollAttention(cfg, state.token(), run);
    const ledger = state.ledger();
    const targets: Array<[RosterEntry, AttentionItem]> = [];
    for (const entry of cfg.roster) {
      const item = attention.items.find((i) => i.worker === entry.worker && i.channel === cfg.channel);
      // Something relevant (for a mention-only row: a mention) since the token.
      if (item && item.lastRelevantSeq !== null && item.unreadMentions > 0) targets.push([entry, item]);
    }

    const outcome: Outcome = { nudged: [], covered: [], held: {}, adopted: false };
    const terminals = targets.length ? listTerminals(cfg, run) : [];
    for (const [entry, seen] of targets) {
      if (!hasMentionOnlyRow(cfg, entry.worker, run)) {
        // A configuration error, not a delivery: never nudge on every message.
        outcome.held[entry.name] = 'no worker-specific mention-only register row on the team Channel';
        continue;
      }
      if (alreadyNudged(ledger.nudged[entry.worker], seen)) {
        outcome.covered.push(entry.name);
        continue;
      }
      const [handle, detail] = resolveTerminal(entry, terminals);
      if (!handle) {
        outcome.held[entry.name] = detail;
        continue;
      }
      if (!isIdle(cfg, handle, cfg.busyWaitMs, run)) {
        outcome.held[entry.name] = `busy for ${Math.round(cfg.busyWaitMs / 1000)}s`;
        continue;
      }
      const [ok, how] = sendNudge(cfg, handle, nudgeText(seen.unread, seen.unreadMentions), run);
      if (!ok) {
        outcome.held[entry.name] = how;
        continue;
      }
      ledger.nudged[entry.worker] = { relevantSeq: seen.lastRelevantSeq!, at: Date.now(), stages: how };
      // Persisted at once: a crash or a later failure in this poll must not
      // cause the same nudge to be sent again (@codex P2, #1490).
      state.saveLedger(ledger);
      outcome.nudged.push(entry.name);
    }

    const held = Object.entries(outcome.held);
    if (held.length) {
      // Report each held worker's reason once per token, not every poll.
      const fresh = held.filter(([n, r]) => ledger.reported[n] !== r);
      Object.assign(ledger.reported, outcome.held);
      state.saveLedger(ledger);
      if (fresh.length) log(`orca-attention-router: ${fresh.map(([n, r]) => `${n}: ${r}`).join('; ')}`);
    } else {
      state.adopt(attention.token);
      outcome.adopted = true;
    }
    return outcome;
  });
}

/** Local state only: token presence, ledger contents, lock. No network. */
export function status(cfg: Config): Record<string, unknown> {
  const state = new State(cfg.stateDir);
  const present = existsSync(cfg.stateDir);
  const ledger = present ? state.ledger() : { nudged: {}, reported: {} };
  return {
    stateDir: cfg.stateDir,
    tokenAdopted: present && state.token() !== null,
    nudgedUnderCurrentToken: Object.keys(ledger.nudged).sort(),
    held: ledger.reported,
    locked: existsSync(join(cfg.stateDir, '.writer-lock')),
    roster: cfg.roster.map((e) => e.name),
  };
}

/** CLI entry: poll | loop | status. */
export async function main(argv: string[]): Promise<number> {
  const mode = argv[0];
  const flag = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  if (!['poll', 'loop', 'status'].includes(mode ?? '')) {
    console.error('usage: router.ts poll|loop|status [--config PATH] [--interval SECONDS]');
    return 2;
  }
  const cfg = loadConfig(flag('--config') ?? process.env.ORCA_ROUTER_CONFIG ?? DEFAULT_CONFIG);
  if (mode === 'status') {
    console.log(JSON.stringify(status(cfg), null, 1));
    return 0;
  }
  const once = (): boolean => {
    try {
      const outcome = pollOnce(cfg);
      if (mode === 'poll' || outcome.nudged.length || Object.keys(outcome.held).length) {
        console.log(`${new Date().toISOString()} ${describeOutcome(outcome)}`);
      }
      return true;
    } catch (e) {
      if (!(e instanceof RouterError)) throw e;
      console.error(`${new Date().toISOString()} orca-attention-router: ${e.message} (token unchanged)`);
      return false;
    }
  };
  if (mode === 'poll') return once() ? 0 : 1;
  const interval = Number(flag('--interval') ?? 60) * 1000;
  for (;;) {
    once();
    await new Promise((r) => setTimeout(r, interval));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
