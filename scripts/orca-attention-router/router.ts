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
 *  - `tui-idle` also reports idle while a HUMAN is typing, so a nudge got
 *    appended to Holger's half-typed text and submitted it (#5473). So the
 *    screen read must also prove the prompt empty (`promptIsEmpty`).
 *  - Tab titles are not identity (agents retitle their own tabs), and a
 *    worktree's name does not prove which worker drives it. So each roster
 *    entry names its worktree; the terminal is the ONE agent terminal there,
 *    and a CLI worker binding in that worktree must agree.
 *  - The token is adopted only when every roster worker with new attention
 *    was nudged. A busy or unreachable worker HOLDS it, and a ledger keyed on
 *    the adopted token keeps the retry from re-nudging the others.
 *  - The counts a nudge carries are recomputed immediately before the send,
 *    tokenless, so they are true when delivered — a count computed at poll
 *    time is stale by however long the busy-wait lasted, and a worker that
 *    read its chat in that window is not told about nothing (#1616).
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
import { homedir, uptime } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DEFAULT_CONFIG = join(homedir(), '.config', 'hadron-orca-attention-router', 'config.json');

/**
 * The one line a worker receives: fresh counts with the seq range they cover —
 * never a message body, and never a token. The seqs let the recipient check
 * the nudge against its own read cursor, so it stays true when delivered (#1616).
 * Kept SHORT: it is typed into a working terminal (Holger, 2026-10-05).
 */
export function nudgeText(a: AttentionItem): string {
  const where = [
    a.firstUnreadSeq === null ? '' : `unread #${a.firstUnreadSeq}–#${a.lastSeq}`,
    a.lastRelevantSeq === null ? '' : `latest mention #${a.lastRelevantSeq}`,
  ].filter(Boolean).join(', ');
  return (
    `Hadron team attention: ${a.unread} relevant unread (${a.unreadMentions} mention${a.unreadMentions === 1 ? '' : 's'}${where ? `; ${where}` : ''}). ` +
    'Read team chat unfiltered with your own live session; if nothing needs action, ' +
    "mark read and finish silently — no chat post or 'read/no-action' comment. (Orca attention router; counts as of send.)"
  );
}

const AGENT_IDENTITIES = new Set(['claude', 'codex']);

/**
 * The idle RECHECK after the recompute is fail-closed: prove idle NOW, or
 * hold. A full busyWait there could outlast a turn in which the worker read
 * its own chat, and the send would then deliver counts that very wait had
 * re-aged (Atilla's delta review of 46a12ac1). An idle TUI answers in ~0.1 s,
 * so half a second proves it without ever waiting for business to clear.
 */
const RECHECK_IDLE_TIMEOUT_MS = 500;

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
/** Two readings of the boot time closer than this are the same boot. */
const BOOT_TOLERANCE_MS = 120_000;

/** This host's boot time, derived from uptime. */
const bootEpoch = (): number => Date.now() - uptime() * 1000;

/**
 * When a process started, or null when that cannot be read. Uses `ps`,
 * which reads any user's processes.
 */
export function processStartedAt(pid: number): number | null {
  const res = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' });
  const t = Date.parse((res.stdout ?? '').trim());
  return Number.isFinite(t) ? t : null;
}

interface LockOwner {
  pid: number;
  /** The host's boot time when the lock was taken: a reboot proves the owner gone. */
  boot: number;
  /** When the lock was taken: a process with this pid that started later is a REUSE of the pid. */
  startedAt: number;
}

/** This process's owner record. */
const ownRecord = (): string => JSON.stringify({ pid: process.pid, boot: bootEpoch(), startedAt: Date.now() } satisfies LockOwner);

/** The lock's raw owner record, or null when there is none (yet). */
function readOwner(lock: string): string | null {
  try {
    return readFileSync(join(lock, 'owner'), 'utf8');
  } catch {
    return null;
  }
}

/**
 * True unless the recorded owner is provably gone. Gone means one of:
 *  - the host rebooted since (the boot time moved);
 *  - no process has the pid (ESRCH);
 *  - the process with that pid started AFTER the lock was taken, so the pid
 *    was reused (@codex P2, #1490).
 * A live owner, including another user's (EPERM), is never displaced. An
 * owner record that cannot be parsed is not trusted to be alive.
 */
export function lockHolderAlive(lock: string, raw: string | null): boolean {
  if (raw === null) {
    try {
      return Date.now() - statSync(lock).mtimeMs < OWNERLESS_LOCK_GRACE_MS;
    } catch {
      return false;
    }
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    /* not JSON */
  }
  // An older, pid-only record parses as a bare NUMBER (or not at all): read the pid.
  const owner: Partial<LockOwner> = parsed !== null && typeof parsed === 'object'
    ? (parsed as Partial<LockOwner>)
    : { pid: Number(raw.trim()) };
  const pid = owner.pid;
  if (!Number.isInteger(pid) || (pid as number) <= 0) return false;
  if (typeof owner.boot === 'number' && Math.abs(owner.boot - bootEpoch()) > BOOT_TOLERANCE_MS) return false;
  try {
    process.kill(pid as number, 0);
  } catch (e) {
    // EPERM: the process exists under another user; only ESRCH proves it gone.
    if ((e as NodeJS.ErrnoException).code === 'ESRCH') return false;
  }
  if (typeof owner.startedAt === 'number') {
    const started = processStartedAt(pid as number);
    // `ps` reports whole seconds: allow for the truncation.
    if (started !== null && started > owner.startedAt + 1000) return false;
  }
  return true;
}

/**
 * Break a stale lock without ever deleting a LIVE one (@codex P2 and Chip QA,
 * #1490). Any "check it is stale, then delete it by path" races: another run
 * can break and re-take the lock between the check and the delete, and a
 * separate reclaim mutex only moves that race one level up.
 *
 * So the lock is MOVED, atomically, to a unique tomb (exactly one racer moves
 * whatever is at the path), and the tomb's owner record is compared with the
 * record judged dead. If they match, the stale lock is gone and the caller
 * may try `mkdir` again, which is atomic too. If they differ, another run
 * broke the stale lock and took it first: its live lock is renamed straight
 * back and this run backs off.
 *
 * @returns 'retry' when the lock path is free to try again; 'busy' otherwise.
 */
export function breakStaleLock(lock: string, judged: string | null): 'retry' | 'busy' {
  const tomb = `${lock}.tomb-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    renameSync(lock, tomb);
  } catch (e) {
    // Someone else broke it first (ENOENT): the path may already be free.
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'retry' : 'busy';
  }
  if (readOwner(tomb) === judged) {
    rmSync(tomb, { recursive: true, force: true });
    return 'retry';
  }
  // Not the lock judged dead: put it back. A live owner is never displaced.
  try {
    renameSync(tomb, lock);
  } catch {
    // A third run took the path meanwhile. The owner of the moved lock sees
    // it lost (the per-step ownership check below) and stops cleanly.
    rmSync(tomb, { recursive: true, force: true });
  }
  return 'busy';
}

/**
 * One writer at a time: a mkdir lock in the state directory, recording its
 * owner (pid, boot, start). A lock whose owner is provably gone (killed,
 * crashed, host restart, pid reused) is broken via `breakStaleLock`, so a
 * crash cannot silence the router. A live owner is never displaced.
 *
 * `fn` receives `stillOwner()`: the poll re-checks it before every send and
 * before adopting the token, so a run that somehow lost the lock stops
 * instead of acting alongside another. Release removes the lock only while
 * it still holds this run's record.
 */
function withLock<T>(stateDir: string, fn: (stillOwner: () => boolean) => T): T {
  const lock = join(stateDir, '.writer-lock');
  const busy = () => new RouterError(`another router run holds ${lock}`);
  const mine = ownRecord();
  const acquire = (): boolean => {
    try {
      mkdirSync(lock);
    } catch {
      return false;
    }
    writeFileSync(join(lock, 'owner'), mine);
    return true;
  };
  let acquired = acquire();
  for (let attempt = 0; !acquired && attempt < 2; attempt++) {
    const judged = readOwner(lock);
    if (lockHolderAlive(lock, judged)) throw busy();
    if (breakStaleLock(lock, judged) === 'busy') throw busy();
    acquired = acquire();
  }
  if (!acquired) throw busy();
  const stillOwner = () => readOwner(lock) === mine;
  try {
    return fn(stillOwner);
  } finally {
    if (stillOwner()) rmSync(lock, { recursive: true, force: true });
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
 * The worker's CURRENT attention, recomputed immediately before a send (#1616):
 * the poll's numbers are as old as the busy-wait was long, and a worker that
 * read its chat in that window must not be nudged about what it already read.
 *
 * Tokenless, so each row is relative to the worker's OWN read cursor — the
 * attention a fresh reader would see, not the router's incremental view.
 * Read-only; the adoptable token this scan returns is DISCARDED: adoption
 * belongs to the poll's own scan and is decided only after every nudge was
 * delivered or held.
 */
export function freshAttention(cfg: Config, workerId: string, run: Runner): AttentionItem | null {
  const scan = pollAttention(cfg, null, run);
  return scan.items.find((i) => i.worker === workerId && i.channel === cfg.channel) ?? null;
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

/**
 * What an idle, EMPTY Codex composer shows. It is rendered dim, but a screen
 * read returns it as ordinary text, so it has to be recognized by value. An
 * unknown placeholder reads as typed text and holds the nudge: the safe
 * direction. If Codex ever changes it, every Codex worker is held and the
 * reason is logged once — loud, not silent.
 */
const CODEX_PLACEHOLDERS = new Set(['Ask Codex to do anything']);

/**
 * The suffix Claude Code's status line carries only while its composer is
 * EMPTY. Typing anything, a single space included, removes it; clearing the
 * composer restores it. Same in auto, manual, accept-edits and plan mode.
 * If Claude Code renames it, every Claude worker is held and the reason is
 * logged once: fail closed, loudly.
 */
const CLAUDE_EMPTY_HINT = '· ← for agents';

/** Collapse ASCII whitespace AND NBSP: Codex draws its prompt as `›` + U+00A0. */
const squash = (s: string): string => s.replace(/[\s\u00a0]+/g, ' ').trim();

/**
 * True only on positive proof the agent's prompt holds no typed text.
 *
 * `tui-idle` alone is not enough (#5473): it reports idle while a HUMAN is
 * typing in that terminal, and a nudge sent then is appended to their
 * half-typed message and submitted with it. So the rendered screen must show
 * the input empty. Both agents draw their real chrome at COLUMN 0 and indent
 * anything the user typed onto a continuation line (live probe, 2026-10-01),
 * so only column-0 lines count as chrome; a typed `❯` or `───` never does
 * (@codex P2 and Gene, #1555):
 *  - Claude Code: the input box is the region between the last two column-0
 *    `───` rules. Its first line must be the bare `❯` marker and every other
 *    line in it blank, so a multi-line draft is caught whatever it contains.
 *    And because typed WHITESPACE renders as nothing, the status line below
 *    the box must carry the empty-input hint (`CLAUDE_EMPTY_HINT`).
 *  - Codex: the last column-0 `›` line shows the idle placeholder, and every
 *    line below it is footer (blank, `? for shortcuts`, or the `model · path`
 *    status line). Codex never draws pending text: real text shows only in
 *    `draft` (checked first, by `promptIsEmpty`), and whitespace shows
 *    nowhere except as the placeholder's absence. A Codex dialog (e.g. its
 *    update menu, `› 1. Update now`) is not the placeholder either, so it
 *    holds — sending there would pick a menu option.
 * Anything unrecognized — no box, no marker, an unknown footer or agent —
 * reads as NOT empty.
 */
export function promptLineIsEmpty(lines: string[], agent: string): boolean {
  if (agent === 'claude') {
    const rules = lines.flatMap((l, i) => (/^─{3,}[\s\u00a0]*$/.test(l) ? [i] : []));
    if (rules.length < 2) return false;
    const close = rules[rules.length - 1];
    const box = lines.slice(rules[rules.length - 2] + 1, close);
    if (!(box.length > 0 && /^❯[\s\u00a0]*$/.test(box[0]) && box.slice(1).every((l) => squash(l) === ''))) return false;
    // A box that LOOKS empty may hold whitespace (Chip #5756): Claude draws
    // typed spaces as nothing. The status line's empty-input hint is the
    // proof — `· ← for agents` shows exactly while the composer is empty, in
    // every permission mode (live probe, 2026-10-01), since ← only switches
    // agents when there is no text for it to move through.
    const status = lines.slice(close + 1).find((l) => squash(l) !== '');
    return status !== undefined && squash(status).endsWith(CLAUDE_EMPTY_HINT);
  }
  if (agent !== 'codex') return false;
  let at = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith('›')) {
      at = i;
      break;
    }
  }
  if (at < 0) return false;
  // Only the placeholder proves empty: a BARE `›` means the composer holds
  // something it does not draw — whitespace typed live left `›` bare with no
  // `draft` at all (2026-10-01), and real text leaves it bare WITH a draft.
  if (!CODEX_PLACEHOLDERS.has(squash(lines[at].slice(1)))) return false;
  return lines.slice(at + 1).map(squash).every((l) => l === '' || l === '? for shortcuts' || l.includes(' · '));
}

/**
 * [empty, detail]: whether the terminal's rendered prompt is empty right now.
 *
 * Two signals, and each agent needs a different one (live probe, 2026-10-01,
 * Orca 1.4.217, Claude Code + Codex 0.159.0, text typed but not submitted):
 *  - Claude Code renders the typed text on its `❯` line; `draft` is absent.
 *  - Codex renders an EMPTY `›` line; the typed text is only in the read's
 *    `draft` field. A screen-only check would have nudged straight into it.
 * So a non-empty `draft` holds first, then the rendered SCREEN must show an
 * empty prompt (the default stream read returns repaint fragments, useless
 * here). Never logs the text.
 */
export function promptIsEmpty(cfg: Config, handle: string, agent: string, run: Runner): [boolean, string] {
  let terminal: Record<string, any> | undefined;
  try {
    const data = JSON.parse(run([cfg.orcaCli, 'terminal', 'read', '--terminal', handle, '--screen', '--json']).stdout);
    terminal = data.ok ? data.result?.terminal : undefined;
  } catch {
    terminal = undefined;
  }
  if (!terminal || terminal.source !== 'screen' || !Array.isArray(terminal.tail)) return [false, 'screen unreadable'];
  // ANY draft holds, whitespace included: this gate promises "nobody is
  // typing", not "nothing meaningful typed" (Gene, #1555).
  if (terminal.draft !== undefined && terminal.draft !== null && terminal.draft !== '') return [false, 'text in the composer draft'];
  return promptLineIsEmpty(terminal.tail as string[], agent) ? [true, ''] : [false, 'text in the prompt'];
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
  /** Workers whose chat they read themselves while the nudge waited (#1616). */
  dropped: string[];
  covered: string[];
  held: Record<string, string>;
  adopted: boolean;
}

/** One short summary line; never a token or a message body. */
export function describeOutcome(o: Outcome): string {
  const parts = [`nudged: ${o.nudged.join(', ') || 'none'}`];
  if (o.dropped.length) parts.push(`dropped (read while waiting): ${o.dropped.join(', ')}`);
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
  return withLock(cfg.stateDir, (stillOwner) => {
    const mustOwn = (): void => {
      if (!stillOwner()) throw new RouterError('lost the writer lock mid-poll; stopping without further sends or adoption');
    };
    const attention = pollAttention(cfg, state.token(), run);
    const ledger = state.ledger();
    const targets: Array<[RosterEntry, AttentionItem]> = [];
    for (const entry of cfg.roster) {
      const item = attention.items.find((i) => i.worker === entry.worker && i.channel === cfg.channel);
      // Something relevant (for a mention-only row: a mention) since the token.
      if (item && item.lastRelevantSeq !== null && item.unreadMentions > 0) targets.push([entry, item]);
    }

    const outcome: Outcome = { nudged: [], dropped: [], covered: [], held: {}, adopted: false };
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
      // Checked AFTER idle, as close to the send as possible: idle says the
      // agent is not working, this says nobody is typing into it (#5473).
      const [empty, why] = promptIsEmpty(cfg, handle, detail, run);
      if (!empty) {
        outcome.held[entry.name] = `prompt not empty (${why})`;
        continue;
      }
      mustOwn();
      // Recomputed after every gate, as close to the send as possible: the
      // poll's numbers are as old as the busy-wait was long, and a worker that
      // read its chat in that window must not be nudged about nothing (#1616).
      const now = freshAttention(cfg, entry.worker, run);
      if (!now || now.unreadMentions <= 0 || now.lastRelevantSeq === null) {
        // The worker read the mentions itself while this nudge waited. Record
        // the frontier as covered so a held token doesn't re-run the gates for
        // it every poll; a NEW mention has a higher seq and is never mistaken
        // for covered (same argument as `alreadyNudged`).
        ledger.nudged[entry.worker] = { relevantSeq: seen.lastRelevantSeq!, at: Date.now(), stages: 'dropped: read while waiting' };
        state.saveLedger(ledger);
        outcome.dropped.push(entry.name);
        continue;
      }
      // The recompute above is a network round trip (or several) that reopened
      // BOTH windows the gates had closed: the agent may have gone busy (#1490
      // steering hazard — a busy agent renders an EMPTY prompt box, so the
      // screen alone cannot catch it) or a human may have started typing
      // (#5473). Re-prove both, as close to the send as possible — the idle
      // recheck FAIL-CLOSED (see RECHECK_IDLE_TIMEOUT_MS): busy here holds,
      // and the next poll recomputes everything.
      if (!isIdle(cfg, handle, RECHECK_IDLE_TIMEOUT_MS, run)) {
        outcome.held[entry.name] = 'busy again after the recompute (fail-closed, not waited)';
        continue;
      }
      const [stillEmpty, whyNow] = promptIsEmpty(cfg, handle, detail, run);
      if (!stillEmpty) {
        outcome.held[entry.name] = `prompt not empty on recheck (${whyNow})`;
        continue;
      }
      mustOwn();
      const [ok, how] = sendNudge(cfg, handle, nudgeText(now), run);
      if (!ok) {
        outcome.held[entry.name] = how;
        continue;
      }
      ledger.nudged[entry.worker] = { relevantSeq: now.lastRelevantSeq!, at: Date.now(), stages: how };
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
      mustOwn();
      // Adoption clears the ledger, but a nudge may have carried a frontier
      // BEYOND the adopted token's horizon: the fresh scan reads LATER than
      // the main one, so its mention can postdate the token — the next poll
      // lists that mention again and nudges a second time (blind reviews of
      // the first head, Atilla P2 / Diego P3-1). Carry records the token
      // cannot cover; `alreadyNudged` then answers them from the new base.
      const carried: Record<string, NudgeRecord> = {};
      for (const [w, record] of Object.entries(ledger.nudged)) {
        const horizon = attention.items.find((i) => i.worker === w && i.channel === cfg.channel)?.lastRelevantSeq ?? null;
        if (horizon === null || record.relevantSeq > horizon) carried[w] = record;
      }
      state.adopt(attention.token);
      if (Object.keys(carried).length) state.saveLedger({ base: state.base(), nudged: carried, reported: {} });
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
