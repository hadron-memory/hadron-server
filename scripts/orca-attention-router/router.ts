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
 *    `orca terminal wait --for tui-idle` proves the terminal idle — except
 *    that an UNTRACKED terminal (Orca lost its output stream; happens
 *    fleet-wide on a serve restart) can never satisfy the wait, so its
 *    timeout reads as unknown and the idle-prompt screen shape decides.
 *  - `tui-idle` also reports idle while a HUMAN is typing, so a nudge got
 *    appended to Holger's half-typed text and submitted it (#5473). So the
 *    screen read must also prove the prompt empty (`promptIsEmpty`). Orca's
 *    `draft` state can go STALE — carrying text no client shows (#6736,
 *    twice on 2026-10-05, pinning workers for hours) — so for Claude, where
 *    typed text provably renders on the `❯` line, a screen that proves the
 *    composer empty REFUTES the draft; Codex's draft stays authoritative.
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
import { openTaskLine } from '../lib/openTaskLine.js';
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
 * Above this sequence span between the first unread and the head, the
 * unfiltered walk switches to the mentions-only anchor (#1811). The SPAN, not
 * the unread count, is what the unfiltered instruction would page through —
 * and a cursor-0 or stale-watermark worker following it to the head re-reads
 * the whole history. The mentions walk still covers EVERY unread mention: the
 * filter skips non-mention history, never mentions (Eden #9616 — "a mention
 * that misses its worker is exactly the failure #1811 exists to fix").
 */
const LARGE_GAP_SPAN = 400;

/**
 * The one line a worker receives: fresh counts with the seq range they cover —
 * never a message body, and never a token. The seqs let the recipient check
 * the nudge against its own read cursor, so it stays true when delivered (#1616).
 * Kept short but COMPLETE (Holger, 2026-10-05): it is typed into a working
 * terminal, so every word earns its place — but the read anchor (where to
 * start, both CLI and MCP forms, bounded) is load-bearing and stays.
 *
 * Two anchors (#1811): at or below the large-gap span, the #1805 watermark
 * anchor (start at the first unread of any kind, walk forward); above it, the
 * mentions-only anchor — a BACKWARD walk of the MENTIONS filter from the
 * head THE NUDGE NAMED (frozen as every page's --before ceiling; prevBefore
 * pages down to the fixed since floor, because beforeSeq selects the newest
 * page and a forward walk would lose the oldest mention) through the worker's
 * own session, then marking at the highest seq actually delivered, never
 * above the named head (a mentions-filtered read does not auto-mark, so the
 * mark is a separate deliberate step; an incomplete walk marks NOTHING and
 * anything outside the walked bound stays unread — nothing is silently
 * acknowledged).
 */
export function nudgeText(a: AttentionItem, openTasks = ''): string {
  const where = [
    a.firstUnreadSeq === null ? '' : `unread #${a.firstUnreadSeq}–#${a.lastSeq}`,
    a.lastRelevantSeq === null ? '' : `latest mention #${a.lastRelevantSeq}`,
  ].filter(Boolean).join(', ');
  const head = `Hadron team attention: ${a.unread} relevant unread (${a.unreadMentions} mention${a.unreadMentions === 1 ? '' : 's'}${where ? `; ${where}` : ''}).`;
  if (a.firstUnreadSeq !== null && a.lastSeq - a.firstUnreadSeq > LARGE_GAP_SPAN) {
    const since = Math.max(0, a.firstUnreadSeq - 1);
    // The walk is bounded BOTH ways by values this nudge named: the ceiling is
    // the head (a.lastSeq, frozen for every page — an H+1 mention posted
    // during the walk can neither enter a page nor be acknowledged), and the
    // floor is the first unread. And the walk runs BACKWARD from the ceiling:
    // beforeSeq forces NEWEST-page selection (resolvers.teamChat.ts, blind
    // review P2 cycle 1, #1827), so a forward nextSince walk with more than
    // one page of mentions returns the newest page, an empty next page, and a
    // mark that acknowledges the unseen OLDEST mention. Following prevBefore
    // down to the fixed since floor delivers every mention in the window
    // (live control: 201 mentions, pages 200/1/0, the H+1 arrival excluded).
    const bound = a.lastSeq + 1;
    return (
      head +
      ` LARGE GAP (unread span ${a.lastSeq - a.firstUnreadSeq} > ${LARGE_GAP_SPAN}): walk MENTIONS ONLY from your first unread to the head named here — every unread mention is on the path; the rest is history.` +
      ` CLI: \`hadron team chat read --mentions-me --since ${since} --before ${bound} --limit 200\`, then follow each page's prevBefore BACKWARD to your first unread — beforeSeq selects the NEWEST page under the bound, so page down to the floor and stop at an empty or floor page; MCP: \`hadron_team_chat_read\` with your session, \`sinceSeq=${since}\`, \`beforeSeq=${bound}\`, its mentions filter and limit 200, then re-call with \`beforeSeq\` = the smallest seq on your last page until the floor (MCP pages carry no prevBefore field).` +
      ` Then mark read through your OWN session at the highest seq actually delivered to you, never above #${a.lastSeq} (CLI: \`hadron team chat mark-read --through <that seq>\`; MCP: \`hadron_team_chat_mark_read\` — a mentions-filtered read never auto-marks).` +
      ' An incomplete walk marks NOTHING; anything outside the walked bound — messages arriving now included — stays unread. If no mention needs action, mark read and end with one short line (for example "read through #N, nothing in my lane"); do not post to team chat.' +
      ' (Orca attention router; counts as of send.)' +
      openTasks
    );
  }
  // Watermark-anchored read instruction (production lesson 2026-10-12, Eden's
  // #9017/#9035: workers with a stale read mark got count-only nudges, read the
  // NEWEST page as every recovery brief teaches, found nothing addressed to
  // them there, and concluded "nothing needs action" — while fresh mentions
  // sat unread at their watermark. Name the mark; tell them where to start.)
  const from =
    a.firstUnreadSeq === null
      ? ''
      : ` START AT #${a.firstUnreadSeq} (your first unread message of any kind) — CLI: \`hadron team chat read --since ${Math.max(0, a.firstUnreadSeq - 1)} --limit 200\` then follow nextSince; MCP: \`hadron_team_chat_read\` with your session and \`sinceSeq=${Math.max(0, a.firstUnreadSeq - 1)}\` then the returned cursor — NOT the newest page alone;`;
  return (
    head +
    `${from} ` +
    'Read team chat unfiltered with your own live session; if nothing needs action, ' +
    'mark read and end with one short line (for example "read through #N, nothing in my lane"); do not post to team chat. (Orca attention router; counts as of send.)' +
    openTasks
  );
}

/**
 * #1826 — the one line a FLAGGED worker receives from the liveness rule. Its
 * own literal, never `nudgeText`'s mention shape: the wake is not about
 * mentions at all (zero pending mentions is the normal case — that is the
 * point), so it makes NO unread/mention count claim. It NAMES ITS RULE (the
 * idle watch — a recipient must be able to tell why it arrived with no
 * mention anywhere, Taylor #9748), names the two positions it is true for —
 * the worker's cursor and the head, both read fresh immediately before the
 * send — and anchors an unfiltered catch-up from the watermark, mentions or
 * not. "Mark read" appears exactly once.
 */
export function livenessNudgeText(cursor: number, head: number, openTasks = ''): string {
  return 'Hadron team liveness check — the idle-watch rule for your roster flag, not a mention nudge: '
    + `the team chat has moved past your read watermark (your cursor #${cursor} < head #${head}). `
    + `Catch up: read team chat unfiltered with your own live session — CLI: \`hadron team chat read --since ${cursor} --limit 200\` then follow nextSince; MCP: \`hadron_team_chat_read\` with your session and \`sinceSeq=${cursor}\` then the returned cursor — `
    + 'then mark read through your OWN session. '
    + 'If nothing needs action, end with one short line (for example "read through #N, nothing in my lane"); do not post to team chat. '
    + '(Orca attention router; liveness nudge; cursor and head as of send.)'
    + openTasks;
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

/**
 * Hard per-call timeout. The only LEGITIMATELY long call is the busy-wait
 * (`orca terminal wait`, busyWaitMs = 60s by design); everything else is
 * seconds. The old 300_000 backstop is how a slow/502ing gateway wedged the
 * single-threaded loop: ~180 calls per cycle × a few multi-minute hangs =
 * 45+ minute cycles while mentions sat undelivered (2026-10-14, three
 * incidents: 16:38 and 17:35 deploy windows plus the sustained slow window
 * after). 90s bounds a hung backend to ONE cycle-slot's worth of loss, and
 * must stay ≥ busyWaitMs + margin — a timed-out call reads as code 1 with
 * empty output, which every consumer already treats fail-closed.
 */
export const CALL_TIMEOUT_MS = 90_000;
export const MIN_CALL_TIMEOUT_MS = 75_000;

/** Run a CLI and capture its output; never throws on a non-zero exit.
 * #1940 fix cycle: spawnSync's timeout sends a CATCHABLE SIGTERM, so a child
 * that ignores it overruns the bound (Andi P2-1, Chip repro #12226), and a
 * timed-out child that already printed success JSON still reports code 0 with
 * that output, letting send/idle callers act on a result the kill invalidated
 * (Andi P2-2). So: SIGKILL as the kill signal (uncatchable, unignorable), and
 * any proc.error / timed-out status is normalised to code 1 with EMPTY stdout —
 * the fail-closed shape every consumer already treats as failure. */
export const runCommand: Runner = (argv, timeoutMs: number = CALL_TIMEOUT_MS) => {
  const proc = spawnSync(argv[0], argv.slice(1), {
    encoding: 'utf8',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
  });
  // ANY spawn error (ETIMEDOUT kill, ENOENT, EPIPE, ENOBUFS…) is a failed
  // call: code 1 with EMPTY stdout (Andi #12271, Chip #12273 — a non-zero
  // exit with retained success output can reach send/idle callers as a
  // result the failure invalidated; the wrapper's contract is fail-closed
  // on every proc.error, not only the timeout arm).
  if (proc.error) {
    return { code: 1, stdout: '', stderr: `call failed: ${proc.error.code ?? String(proc.error.message ?? proc.error)}` };
  }
  const killed = proc.status === null && proc.signal === 'SIGKILL';
  if (killed) return { code: 1, stdout: '', stderr: `call exceeded ${timeoutMs}ms and was killed` };
  return { code: proc.status ?? 1, stdout: proc.stdout ?? '', stderr: proc.stderr ?? '' };
};

/** A failure that must leave the adopted token untouched. */
export class RouterError extends Error {}

export interface RosterEntry {
  /** The Worker's permanent id. */
  worker: string;
  name: string;
  /** The Orca worktree this worker is driven in. */
  worktree: string;
  /**
   * #1826 — this worker holds a watch (coordinator / lifecycle-manager) that a
   * passive wait can strand: a finished turn with unread NON-mention chat
   * generates no mention, so nothing wakes it. Flagged workers get the
   * liveness rule: after `coordinatorWatchMinutes` of continuous idle with the
   * chat past their read watermark, they are nudged to catch up — mentions or
   * not. Booleans, validated at load; absent means an ordinary mention-only
   * worker the liveness pass never touches.
   */
  coordinator?: boolean;
  lifecycle?: boolean;
  /**
   * #1845 — the handle of this worker's MAIN terminal, pinned at
   * provisioning and kept fresh at every replacement (host-side edits; the
   * router never writes it). A pin resolves FIRST, before identity and the
   * screen fallback: it survives the agentIdentity flap (#1823's target)
   * and disambiguates worktrees that host more than one agent family (review
   * spawns). The pin only ever resolves a terminal that is IN this row's
   * worktree, connected and writable — a stale pin pointing elsewhere falls
   * through to the next resolver with its reason. Absent means unpinned;
   * nothing changes for unpinned rows.
   */
  terminal?: string;
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
  /**
   * #1826 — minutes of continuous idle a flagged worker must accumulate before
   * the liveness nudge may fire (strictly greater; never at exactly N).
   * Positive finite number, validated at load; default 20.
   */
  coordinatorWatchMinutes: number;
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
    // #1826 — the watch flags are booleans or absent; anything else is a config
    // error the operator must see, not a truthy string silently counting.
    for (const flag of ['coordinator', 'lifecycle'] as const) {
      if (entry[flag] !== undefined && typeof entry[flag] !== 'boolean') {
        throw new RouterError(`roster entry ${JSON.stringify(entry)}: "${flag}" must be a boolean`);
      }
    }
    // #1845 — the terminal pin is a non-empty string handle or absent.
    if (entry.terminal !== undefined && (typeof entry.terminal !== 'string' || !entry.terminal.trim())) {
      throw new RouterError(`roster entry ${JSON.stringify(entry)}: "terminal" must be a non-empty terminal handle string`);
    }
  }
  if (new Set(roster.map((e) => e.worker)).size !== roster.length) throw new RouterError('roster names a worker twice');
  // Two rows pinning the SAME terminal would deliver one worker's nudge to
  // another's terminal — the one-worktree rule's exact failure, one layer up.
  const pins = roster.map((e) => e.terminal).filter((p): p is string => typeof p === 'string');
  if (new Set(pins).size !== pins.length) throw new RouterError('roster pins one terminal for two workers');
  // Two workers on one worktree would resolve to the same terminal: one
  // nudge recorded as delivered twice, one worker never told (@codex P2, #1490).
  const worktrees = roster.map((e) => real(e.worktree));
  if (new Set(worktrees).size !== worktrees.length) throw new RouterError('roster assigns one worktree to two workers');
  if (typeof raw.app !== 'string' || typeof raw.stateDir !== 'string' || typeof raw.channel !== 'string') {
    throw new RouterError('config needs "app", "channel" and "stateDir"');
  }
  // A JSON NUMBER or absent — never a coerced true/"20" (a boolean watch of
  // one minute is a typo passing silently, #1829 local P2-7) — and the ms
  // product must stay finite, or a huge value would silently disable delivery.
  const watchRaw = raw.coordinatorWatchMinutes;
  if (watchRaw !== undefined && typeof watchRaw !== 'number') {
    throw new RouterError(`coordinatorWatchMinutes must be a JSON number (got ${JSON.stringify(watchRaw)})`);
  }
  const watchMinutes = watchRaw ?? 20;
  if (!Number.isFinite(watchMinutes) || watchMinutes <= 0 || !Number.isFinite(watchMinutes * 60_000)) {
    throw new RouterError(`coordinatorWatchMinutes must be a positive finite number of minutes (got ${JSON.stringify(watchRaw)})`);
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
    coordinatorWatchMinutes: watchMinutes,
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
  /** Stale-draft discard notes already logged under this token (worker -> note). */
  draftNotes?: Record<string, string>;
  /** Epoch ms a worker's current hold began (cleared on delivery), for long-hold visibility. */
  heldSince?: Record<string, number>;
  /** Epoch ms the last long-hold line was logged per worker (re-log at most every 30 min). */
  heldLoggedAt?: Record<string, number>;
}

/**
 * #1826 — the liveness clock, per flagged worker. Deliberately a SEPARATE
 * durable file from the ledger: `State.adopt` deletes the ledger (a new token
 * starts fresh mention bookkeeping), but an idle episode must survive token
 * adoption and router restarts untouched — the watch outlives any one token.
 * A record with no `idleSince` holds only `coveredFrontier` (the backlog a
 * delivered liveness nudge already covered); the clock restarts on the next
 * idle observation.
 */
export interface LivenessRecord {
  /** Epoch ms the continuous idle episode began; absent while reset. */
  idleSince?: number;
  /** The terminal handle the clock is measured on; a change is a replaced terminal ⇒ reset. */
  handle?: string;
  /** The channel head at the last DELIVERED liveness nudge; re-eligibility needs head > this. */
  coveredFrontier?: number;
}

/**
 * The adopted token plus the delivery ledger, private to this router.
 *
 * The ledger is keyed on a hash of the adopted token: it records which
 * workers were already nudged for the attention reported since that token,
 * so a poll that has to hold the token does not nudge them again. Adopting a
 * new token starts a fresh ledger — and never touches liveness.json.
 */
export class State {
  readonly tokenPath: string;
  readonly ledgerPath: string;
  readonly livenessPath: string;
  readonly notesPath: string;

  constructor(readonly dir: string) {
    this.tokenPath = join(dir, 'adopted.token');
    this.ledgerPath = join(dir, 'ledger.json');
    this.livenessPath = join(dir, 'liveness.json');
    this.notesPath = join(dir, 'liveness-notes.json');
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
    if (ledger.base !== base) return { base, nudged: {}, reported: {}, draftNotes: {}, heldSince: {}, heldLoggedAt: {} };
    return {
      base,
      nudged: ledger.nudged ?? {},
      reported: ledger.reported ?? {},
      draftNotes: ledger.draftNotes ?? {},
      heldSince: ledger.heldSince ?? {},
      heldLoggedAt: ledger.heldLoggedAt ?? {},
    };
  }

  saveLedger(ledger: Ledger): void {
    atomicWrite(this.ledgerPath, JSON.stringify(ledger, null, 1));
  }

  /**
   * The liveness clocks (#1826), SANITIZED on read (a corrupt file can never
   * fail open, #1829 local P2-2): a non-object top level (including null)
   * reads as fresh rather than crashing, a non-object record reads as reset,
   * and only typed fields survive — a finite non-negative `idleSince`, a
   * non-empty string `handle`, an integer `coveredFrontier` within the seq
   * ceiling. A syntactically-valid but corrupt value (a huge frontier) is
   * DROPPED, so corruption can cost at most one repeated nudge, never a
   * suppressed worker. Unreadable/malformed JSON reads as {} — a fresh clock.
   */
  liveness(): Record<string, LivenessRecord> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.livenessPath, 'utf8'));
    } catch {
      return {};
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, LivenessRecord> = {};
    for (const [worker, raw] of Object.entries(parsed as Record<string, unknown>)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const r = raw as Record<string, unknown>;
      const rec: LivenessRecord = {};
      if (Number.isInteger(r.idleSince) && (r.idleSince as number) >= 0) rec.idleSince = r.idleSince as number;
      if (typeof r.handle === 'string' && r.handle) rec.handle = r.handle;
      if (Number.isInteger(r.coveredFrontier) && (r.coveredFrontier as number) >= 0 && (r.coveredFrontier as number) <= SEQ_MAX) {
        rec.coveredFrontier = r.coveredFrontier as number;
      }
      out[worker] = rec;
    }
    return out;
  }

  saveLiveness(workers: Record<string, LivenessRecord>): void {
    atomicWrite(this.livenessPath, JSON.stringify(workers, null, 1));
  }

  /** #1826 — each worker's last LOGGED fail-closed reason, so a persistently
   * unreadable liveness source is logged once per reason, not once per poll.
   * Deliberately its own file: the ledger's `reported` map is token-scoped
   * (cleared on adopt) and a source outage outlives tokens. A non-object file
   * reads as empty (#1829 local P2-2). */
  livenessNotes(): Record<string, string> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.notesPath, 'utf8'));
    } catch {
      return {};
    }
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {};
  }

  saveLivenessNotes(notes: Record<string, string>): void {
    atomicWrite(this.notesPath, JSON.stringify(notes, null, 1));
  }

  /** Adopt a token and clear the ledger: only after every delivery succeeded. Never touches liveness.json. */
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

/**
 * The highest value a Channel seq can be (the 32-bit seq column ceiling): a
 * "position" above it is corruption, not a place in the chat. Both liveness
 * reads and the sanitized liveness state bound checked values by it (#1829
 * local P1-1/P2-2).
 */
const SEQ_MAX = 2_147_483_647;

/**
 * A chat position from a `hadron api` response, or null when the response is
 * not POSITIVELY a live value. Fail-closed on every ambiguity (#1829 local
 * P1-1): a non-zero exit can still print a JSON body; a GraphQL errors array
 * is legal WITH partial data, and the integer fragment in it is not a verdict;
 * a negative or beyond-ceiling integer is not a cursor. Absence of evidence is
 * not evidence of a position.
 */
function seqFromResponse(res: RunResult, pick: (data: Record<string, any>) => unknown): number | null {
  if (res.code !== 0) return null;
  let data: Record<string, any> | null = null;
  try {
    data = JSON.parse(res.stdout) as Record<string, any>;
  } catch {
    return null;
  }
  if (Array.isArray(data?.errors) && data.errors.length > 0) return null;
  const v = pick(data?.data ?? {});
  return Number.isInteger(v) && (v as number) >= 0 && (v as number) <= SEQ_MAX ? (v as number) : null;
}

const CURSOR_QUERY = 'query($w: ID!, $a: ID, $c: ID!) { channelReadState(attendeeRef: $w, appRef: $a, channelRef: $c) '
  + '{ lastSeenSeq } }';

/**
 * #1826 — the worker's read cursor on the team Channel, via the EXISTING
 * authorized read-state surface. The attention API cannot serve the liveness
 * rule: it COUNTS non-self unread for mention-only registrations but poll
 * emission SUPPRESSES zero-relevant rows, so a flagged worker with unread
 * non-mention chat and zero mentions is invisible to every scan (#1826
 * delta 1). `channelReadState` answers per attendee; lastSeenSeq 0 is a real
 * cursor (never checkpointed), null means unknown/unreadable. Returns null on
 * ANY unknown or error — fail-closed: absence of evidence is not a verdict,
 * so the caller logs once and skips the candidate this poll. Reading read
 * state confers no access (cor:dmo:090:06) — this is reuse, not new law.
 */
export function readCursor(cfg: Config, workerId: string, run: Runner): number | null {
  return seqFromResponse(
    run([cfg.hadronCli, 'api', CURSOR_QUERY, '-F', `w=${workerId}`, '-F', `a=${cfg.app}`, '-F', `c=${cfg.channel}`]),
    (d) => d.channelReadState?.lastSeenSeq,
  );
}

const HEAD_QUERY = 'query($c: ID!) { channel(ref: $c) { lastSeq } }';

/**
 * #1826 — the team Channel's watermark (`channel(ref:){lastSeq}`), or null on
 * any unknown or error. Same fail-closed contract as `readCursor`.
 */
export function channelHead(cfg: Config, run: Runner): number | null {
  return seqFromResponse(
    run([cfg.hadronCli, 'api', HEAD_QUERY, '-F', `c=${cfg.channel}`]),
    (d) => d.channel?.lastSeq,
  );
}

interface Terminal {
  handle: string;
  worktreePath?: string;
  agentIdentity?: string | null;
  connected?: boolean;
  writable?: boolean;
  /** Epoch ms of the last OUTPUT Orca saw; null when tracking is lost. */
  lastOutputAt?: number | null;
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
 * [verdict, why]: whether the terminal may be typed into, with THREE outcomes
 * where tui-idle alone gave two (#7398 incident class).
 *
 * A tui-idle timeout is UNKNOWN, never busy-by-default, whichever side of
 * tracking the terminal sits on. Orca loses tracking fleet-wide on a serve
 * restart and degrades it in smaller sets mid-life (observed 2026-10-07:
 * 28/40 null from ~03:10Z with the serve continuously up); an untracked
 * terminal can NEVER satisfy tui-idle, so reading the timeout as "busy" pins
 * every idle untracked worker forever. And #1845 (2026-10-14) proved the
 * tracked side fails the same way from the other direction: a terminal at a
 * COMPLETED turn — "Worked for Xm • time" / "✻ … · done" above an empty
 * composer — can sit for hours with tui-idle unsatisfiable while tracking
 * lives (Atilla held 2,442 min, Chip 877, at idle screens the whole time),
 * because the tracked path read the timeout as busy without ever consulting
 * a screen that positively proved idle. So the rendered screen decides in
 * BOTH cases: an empty composer plus positive quiet (no running-turn
 * indicator above the prompt, @codex P2 #1700) proves idle; a live
 * indicator vetoes; anything else is missing evidence and holds.
 */
export function provesIdle(
  cfg: Config, handle: string, agent: string, lastOutputAt: number | null | undefined,
  timeoutMs: number, run: Runner,
): [boolean, string] {
  if (isIdle(cfg, handle, timeoutMs, run)) return [true, ''];
  const term = readScreen(cfg, handle, run);
  const [empty, why] = promptIsEmptyFromTerm(term, agent);
  if (!empty) return [false, `unknown idle state — screen shows ${why}`];
  // An empty composer proves nobody has TYPED; it does not prove the agent
  // is not WORKING — both agents render an empty prompt box mid-turn (the
  // #1490 steering hazard; live evidence 2026-10-09/10: '✽ Bunning… (5m 55s
  // · ↓ 15.6k tokens)' above an empty Claude box, '• Working (6s • esc to
  // interrupt)' above the Codex placeholder). The fallback requires positive
  // quiet: no running-turn indicator above the prompt (@codex P2, #1700).
  const proof = term ? idleProofAbovePrompt(term.tail as string[], agent) : (['unknown', 'screen unreadable'] as const);
  if (proof[0] === 'busy') return [false, 'a running turn is drawn above the prompt'];
  if (proof[0] === 'unknown') return [false, `unknown idle state — ${proof[1]}`];
  return [
    true,
    lastOutputAt == null
      ? 'untracked terminal, screen proves idle (empty prompt, positive idle chrome)'
      : 'screen proves idle (completed turn, empty composer)',
  ];
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
 * Claude Code's permission-mode status line: ONE line under the composer box,
 * `⏵⏵ <mode> (shift+tab to cycle)`, optionally followed by ` · <segment>`s.
 * The `· ← for agents` suffix is TRANSIENT (only on the first screen after
 * start): 9 of 12 live Claude terminals had none on 2026-10-18 (cli#907
 * captures, bcabaf4), so keying empty on it held most Claude workers forever.
 * The footer proves the screen shape; it cannot prove the composer is empty
 * (Claude draws typed whitespace as nothing, and Orca blanks pending text in
 * the tail), so the caller must ALSO see no `draft` from Orca. If Claude Code
 * reshapes the line every Claude worker holds: fail closed.
 */
const CLAUDE_MODE_FOOTER = /^⏵⏵ .+ \(shift\+tab to cycle\)( · .+)?$/;

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
 *    the box must sit over exactly one mode footer (`CLAUDE_MODE_FOOTER`).
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
    // A box that LOOKS empty may hold whitespace (Chip #5756) or text Orca
    // blanked from the tail, so the caller also requires no Orca `draft`
    // (promptIsEmptyFromTerm). Here the status line must be exactly ONE
    // permission-mode footer. And it is the terminal's LAST content: Claude draws nothing below its
    // composer footer, so unexplained trailing content — a shell prompt after
    // `cat`ing a captured idle screen — fails here even though the box and
    // hint above it look perfect. The FIRST nonblank line below the closing
    // rule proved nothing about what sits at the terminal bottom (blind
    // review P2, #1823).
    const below = lines.slice(close + 1).map(squash).filter((l) => l !== '');
    return below.length === 1 && CLAUDE_MODE_FOOTER.test(below[0]);
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
 * The terminal's rendered screen, or undefined when unreadable. A full-frame
 * `--screen` read (the default stream read returns repaint fragments, useless
 * for shape checks).
 */
export function readScreen(cfg: Config, handle: string, run: Runner): Record<string, any> | undefined {
  try {
    const data = JSON.parse(run([cfg.orcaCli, 'terminal', 'read', '--terminal', handle, '--screen', '--json']).stdout);
    return data.ok ? data.result?.terminal : undefined;
  } catch {
    return undefined;
  }
}

/** True when the line carries a parenthesized elapsed timer (a running spinner). */
const spinnerTimer = (s: string): boolean => /[（(]\d/.test(s) && /\d\s*[mh]?\s*\d*s/.test(s) && !/done/i.test(s) && !/worked for/i.test(s);

/**
 * Lines that POSITIVELY prove the agent is not working - a completed turn, or
 * the chrome a freshly launched (never-worked) terminal draws. Live evidence
 * 2026-10-10, one per family:
 *  - Claude/GLM fresh: the 'Claude Code v2.1.296' / 'glm-5.3' welcome banner;
 *    post-trust: 'Share Claude Code ... /passes'.
 *  - Claude done: the '✻ … for 1m 12s · done 3:52 PM' completed-turn line,
 *    '⏺ Done.', the '※ recap:' block, '/clear to save N tokens'.
 *  - Codex fresh: the 'OpenAI Codex (v...)' banner and its 'Update
 *    available!' box. Codex done: 'Worked for '.
 *  - Codex content-suppressed turns (#1983): when the last output was
 *    withheld (the cybersecurity-care notice box), NO 'Worked for' footer
 *    is drawn — the notice header itself is the completed-turn chrome.
 *    Live captures: Riana + Chip, 2026-10-15.
 */
const IDLE_MARKERS: readonly RegExp[] = [
  /· done/, /^⏺ Done/, /^Done\./, /^✻ \w+ for \d+[ms]/, /^✻ Compacted while idle/,
  /\/clear to save/, /^new task\? \/clear/, /recap:/, /Share Claude Code/,
  /Claude Code v\d/, /glm-[\d.]/,
  /OpenAI Codex \(v/, /Update available!/, /Worked for /,
  /Update installed/,
  // The content-suppression notice header (#1983): a suppressed turn draws
  // no footer, so the header is the completion evidence. Its BODY lines are
  // deliberately NOT markers — they prove idle only as members of an
  // identified notice block (see recapBlockSkip); standalone they are
  // ordinary output and hold (Andi's #1985 delta P2).
  /ⓘ This content can’t be shown/,
];

/**
 * Chrome that may surround a strong marker without explaining it away: a
 * historical submitted-prompt echo (Claude renders past prompts with a
 * leading `❯`), the banner layout lines around a launch logo (box-art
 * glyphs plus the worktree path) or Codex's `permissions:`/path lines, and
 * the collapsed-output indicators (`+ Show details`, `+ N lines (^t to
 * expand)`) that sit between a turn's output and its footer or notice
 * header (#1983 — weak on their own: a weak-only window still holds), and
 * Codex's background-process status line (`2 background terminals running ·
 * /ps to view · /stop to close`), drawn between the `Worked for` footer and
 * the composer for as long as a process the turn started keeps running
 * (a dev server, a watcher). It says nothing about the turn: live capture,
 * Greta 2026-10-21, held as unknown on every pass for 7.5 h.
 */
const isWeakChrome = (s: string): boolean =>
  /^❯ /.test(s) || /^[▐▛█▝▜▀│╭╮╰╯ ]*[~❯]/.test(s) || /^permissions: /.test(s)
  || /^\+ (Show details|\d+ lines)/.test(s)
  || /^\d+ background terminals? running · \/ps to view/.test(s);

/**
 * The recap block — a completed turn's OWN summary chrome, positionally NEWER
 * than the idle marker that proves the turn completed (both agents render the
 * footer ABOVE the block: Codex `Worked for …` above `↳ Recap:`, Claude
 * `✻ … · done` above `※ recap:`). Membership is STRUCTURAL, not a flat indent
 * floor: a line is continuation only inside a block, opened by a header line
 * and extending while each RAW line indents at least as deep as that header
 * (Codex recap 2→12, Claude recap 2→4, Codex notice tails 2→2 — #1983: a
 * content-suppressed turn draws NO footer, so its notice block is judged at
 * the header; both agents draw current status chrome at ≤2 or at column 0,
 * so a new status ends the block and is judged). A deep indent with NO
 * header above it is never skipped — an old marker must not rescue a
 * drifted/indented current status (Andi's P2, #1976 review: the flat ≥8 rule
 * proved idle over `Worked for` + an 8/12-space unrecognized status).
 * Returns skip flags aligned with the window; judged on RAW lines (squash
 * collapses indentation). Headers are skipped too — the Codex `↳ Recap:`
 * form is capital-R and matches no IDLE_MARKER, so the backward scan must
 * pass through it to reach the footer (Claude's `※ recap:` already matches
 * /recap:/ and skips for free).
 */
/**
 * Body shapes of the content-suppression notice box (#1983/#1985): matched on
 * the SQUASHED line (leading indent erased). They are NEVER standalone
 * evidence — a bare `Learn more: <url>` in ordinary output holds — and count
 * only as contiguous members of an identified notice block (header directly
 * above, nothing newer in between), per Ada's #12876 ruling on Andi's delta
 * P2. Mid-sentence prose wraps that match none of these shapes break the
 * block and hold — fail-closed.
 */
const NOTICE_BODY: readonly RegExp[] = [
  /^We take extra care/, /^authorized security work/, /^get broader access\./,
  /^Learn more: https:/, /^Apply for Daybreak:/,
  /^https:\/\/openai\.com\/form\//, /^openai\.com\/form\//,
];

const recapBlockSkip = (rawWindow: string[]): boolean[] => {
  const skip = rawWindow.map(() => false);
  for (let j = 0; j < rawWindow.length; j++) {
    const header = /^(\s*)(?:↳ Recap:|※ recap:)/.exec(rawWindow[j]);
    const notice = header ? null : /^(\s*)ⓘ This content can’t be shown/.exec(rawWindow[j]);
    if (!header && !notice) continue;
    if (header) {
      skip[j] = true; // the scan passes THROUGH a recap header to its older footer
      const base = header[1].length;
      for (let k = j + 1; k < rawWindow.length; k++) {
        // STRICTLY deeper than the header, as #1976 shipped: at-or-deeper
        // swallowed a newer same-indent current status after a header and
        // SENT — Andi's #1985 blind P2.
        if (/^(\s*)/.exec(rawWindow[k])![1].length > base) skip[k] = true;
        else break; // a line at/below the header's indent is new chrome, not continuation
      }
    } else {
      // A notice header is NOT skipped (a suppressed turn has no footer —
      // the header is the evidence the scan stops and judges), but its
      // body lines below are skipped so the scan REACHES the header —
      // and only while they are contiguously the notice's own shapes
      // (#12876: anything else in between is newer chrome; the block ends
      // and that line is judged).
      for (let k = j + 1; k < rawWindow.length; k++) {
        if (NOTICE_BODY.some((re) => re.test(squash(rawWindow[k])))) skip[k] = true;
        else break;
      }
    }
  }
  return skip;
};

/**
 * [verdict, detail] on the window directly above the prompt chrome: 'busy'
 * (a running-turn line is drawn), 'idle' (the NEWEST non-weak line is a
 * positive idle/completed/fresh-launch marker — everything older is then
 * history), or 'unknown' (the newest line is unrecognized, the window holds
 * only weak chrome with no strong marker, or there is no window at all:
 * missing evidence, not quiet — all hold rather than nudge, because a busy
 * presentation we failed to enumerate looks exactly like this; @codex P2
 * #1700 r2/r3, production calibration #1746). The window is bounded because
 * both agents PIN their running-turn line directly above the prompt while a
 * turn runs — which is also why depth here does not trade busy-detection
 * reliability: the busy sweep below covers the whole window, and a pinned
 * indicator is adjacent to the prompt at any depth (#1968 deepened 8 → 16
 * so a completed turn's summary tail — recap block or folded-URL receipt —
 * cannot push its `Worked for`/done footer out of evidence).
 */
export function idleProofAbovePrompt(lines: string[], agent: string): ['busy' | 'idle' | 'unknown', string] {
  let at: number; // the first line of the prompt chrome
  if (agent === 'claude') {
    const rules = lines.flatMap((l, i) => (/^─{3,}[\s ]*$/.test(l) ? [i] : []));
    if (rules.length < 2) return ['unknown', 'no prompt box'];
    at = rules[rules.length - 2];
  } else if (agent === 'codex') {
    let p = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].startsWith('\u203a')) { p = i; break; }
    }
    if (p < 0) return ['unknown', 'no prompt line'];
    at = p;
  } else {
    return ['unknown', `unknown agent ${agent}`];
  }
  const rawWindow = lines.slice(Math.max(0, at - 16), at).filter((l) => l.trim() !== '');
  const window = rawWindow.map(squash);
  const recapSkip = recapBlockSkip(rawWindow);
  for (const l of window) {
    if (l.includes('to interrupt') || l.includes('run in background') || l.includes('Working (') || /^calling [a-z]/i.test(l)) return ['busy', l];
    if (spinnerTimer(l)) return ['busy', l];
  }
  // Judge the NEWEST content positionally (production calibration, 2026-10-11:
  // Yuri's first-night report — real idle terminals carry ordinary assistant
  // output text above the done-marker, which a whole-window rule fail-closes
  // to unknown and the router delivers ~nothing after a restart). The newest
  // non-weak line decides: a STRONG marker there means everything older is
  // history (safe); weak chrome may TRAIL a strong marker (banner tail lines)
  // without hiding it. An unrecognized newest line still holds — @codex P2
  // #1700 r3's counterexample stands: a busy presentation that drifted format
  // looks exactly like that, and old completion text must not rescue it. An
  // absent or weak-only window is missing evidence, not quiet. #1968 adds the
  // one exemption that counterexample permits: a completed turn's OWN summary
  // tail (the recap BLOCK — header-anchored, judged on the RAW lines, squash
  // erases the indent) trails its marker the way banner tails do, so it is
  // skipped like weak chrome; a deep indent with no header above it is a
  // current status and is never skipped (Andi's P2, #1976 review).
  let i = window.length - 1;
  while (i >= 0 && (isWeakChrome(window[i]) || recapSkip[i])) i--;
  if (i < 0) return ['unknown', 'no positive liveness evidence above the prompt'];
  if (IDLE_MARKERS.some((re) => re.test(window[i]))) return ['idle', 'completed or fresh-launch chrome'];
  return ['unknown', 'unrecognized chrome above the prompt'];
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
  return promptIsEmptyFromTerm(readScreen(cfg, handle, run), agent);
}

/** promptIsEmpty over an already-read screen (the untracked gate reads once). */
export function promptIsEmptyFromTerm(terminal: Record<string, any> | undefined, agent: string): [boolean, string] {
  if (!terminal || terminal.source !== 'screen' || !Array.isArray(terminal.tail)) return [false, 'screen unreadable'];
  // Any draft Orca reports pins the nudge, for both agents. Orca blanks the
  // composer text in the tail and carries it in `draft` (cli#907 captures,
  // bcabaf4: c02, c09, x02, x04), so the screen can no longer refute a draft.
  // This retires the earlier rule that let a Claude screen overrule a stale
  // draft, which depended on the transient `· ← for agents` suffix.
  const draft = terminal.draft;
  if (draft !== undefined && draft !== null && draft !== '') return [false, 'text in the composer draft'];
  return promptLineIsEmpty(terminal.tail as string[], agent) ? [true, ''] : [false, 'text in the prompt'];
}

/**
 * Banner/completion markers anchor to the START of a line, optionally behind
 * banner chrome (box-art glyphs, spaces, Codex's `>_` launcher glyph, the
 * composer `›`) — never after arbitrary content. `orca$ echo "Worked for 33s"`
 * is ordinary output mentioning a marker, not Codex completion chrome (blind
 * review P2, #1823).
 */
const BANNER_CHROME = '[│╭╮╰╯─▐▛█▝▜▀ >_› ]*';

/**
 * The agent family a rendered screen POSITIVELY shows, or null — the
 * identity-flap fallback's evidence. Orca's per-terminal tracking degrades
 * mid-life: `lastOutputAt` goes null (the #7398 gate's premise) and, in the
 * same degradation family, `agentIdentity` reads null on a terminal that is
 * running its agent right now (observed 2026-10-12: Hugo's terminal was held
 * "no live agent terminal" ~6.5h while the agent worked, while the same CLI,
 * env and cwd read agentIdentity 'claude' stable in 40 consecutive polls —
 * the flap is in Orca's tracking, not in the terminal). The screen is the
 * surviving positive evidence.
 *
 * Markers are the agents' OWN chrome: banner/completion lines anchored to
 * banner-chrome line starts, strong glyphs (`✻`, `⏺`, `permissions:`) at
 * column 0, the composer box Claude's pair of `───` rules, and Codex's `›`
 * composer only WITH content after the glyph — a bare `›` is a shell-theme
 * prompt as easily as a composer. Typed text is indented onto continuation
 * lines (promptLineIsEmpty's convention), so a plain shell draws none of
 * these: `orca$ echo "Claude Code v2.1.296"` never classifies. A glyph a
 * shell theme could draw (a bare `❯`, a bare `›`, a single rule) is
 * deliberately NOT family evidence.
 * A screen carrying BOTH families' markers (an agent displaying
 * the other family's chrome in its output) reads null: hold, never guess.
 * A wrong family is caught one gate later anyway — promptLineIsEmpty and
 * idleProofAbovePrompt prove their shapes per family and hold anything
 * unrecognized — so this classifier needs recall on real agent screens more
 * than it needs perfection.
 */
export function screenAgentFamily(terminal: Record<string, any> | undefined): string | null {
  if (!terminal || terminal.source !== 'screen' || !Array.isArray(terminal.tail)) return null;
  const lines = terminal.tail as string[];
  const rules = lines.filter((l) => /^─{3,}[\s ]*$/.test(l)).length;
  let claude = rules >= 2; // the composer box promptLineIsEmpty itself keys on
  let codex = false;
  const claudeBanner = new RegExp(`^${BANNER_CHROME}(Claude Code v\\d|glm-[\\d.]|/clear to save|※ recap:)`);
  const codexBanner = new RegExp(`^${BANNER_CHROME}(OpenAI Codex \\(v|Worked for |Ask Codex to do anything)`);
  for (const l of lines) {
    if (/^✻ /.test(l) || /^⏺ /.test(l) || claudeBanner.test(l)) claude = true;
    // A BARE `›` is a shell-theme glyph as easily as Codex's composer: only
    // `›` with content after it — the idle placeholder, a submitted echo, a
    // menu line — is family evidence (blind review P2, #1823).
    if ((l.startsWith('›') && squash(l.slice(1)) !== '') || /^permissions: /.test(l) || codexBanner.test(l)) codex = true;
  }
  if (claude && !codex) return 'claude';
  if (codex && !claude) return 'codex';
  return null;
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
 * The CLI team-session binding in this worktree, if any: its worker and, when
 * the file records them, the session and App it was bound under.
 *
 * The binding lives in the worktree's git dir (`hadron team session start`).
 * An MCP-bound worker leaves none; absence is not a mismatch.
 */
export function teamBinding(worktree: string): { workerId: string; sessionId?: string; appId?: string } | null {
  try {
    const dotGit = join(worktree, '.git');
    let gitDir = dotGit;
    if (statSync(dotGit).isFile()) {
      const pointer = readFileSync(dotGit, 'utf8').trim().replace(/^gitdir:\s*/, '');
      gitDir = isAbsolute(pointer) ? pointer : join(worktree, pointer);
    }
    const binding = JSON.parse(readFileSync(join(gitDir, 'hadron-team-session.json'), 'utf8'));
    if (typeof binding.workerId !== 'string' || !binding.workerId) return null;
    const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
    return { workerId: binding.workerId, sessionId: str(binding.sessionId), appId: str(binding.appId) };
  } catch {
    return null;
  }
}

/** The worker id a CLI team-session binding in this worktree names, if any. */
export function boundWorker(worktree: string): string | null {
  return teamBinding(worktree)?.workerId ?? null;
}

/**
 * [handle, agent-or-reason, via]: the ONE agent terminal in this worker's
 * worktree, or why not. The identity path is unchanged: the terminal whose
 * `agentIdentity` is claude/codex. When identity resolves NOTHING and cfg/run
 * are given, the identity-flap fallback tries the screen: Orca's
 * agentIdentity tracking degrades mid-life (see screenAgentFamily), so ONE
 * remaining connected terminal in the worktree whose screen positively shows
 * an agent family still resolves — with via='screen' so the caller can log
 * it. The fallback never runs when identity resolves; an ambiguous screen
 * count, an unclassifiable screen, or a plain shell holds exactly as before.
 */
export function resolveTerminal(
  entry: RosterEntry, terminals: Terminal[], cfg?: Config, run?: Runner,
): [string | null, string, 'pin' | 'identity' | 'screen' | 'none'] {
  const worktree = real(entry.worktree);
  const bound = boundWorker(worktree);
  if (bound && bound !== entry.worker) return [null, `worktree is bound to another worker (${bound})`, 'none'];
  const inWorktree = terminals.filter(
    (t) => t.worktreePath && real(t.worktreePath) === worktree && t.connected !== false && t.writable !== false,
  );
  // #1845 — a pinned terminal resolves FIRST, before identity and the screen:
  // the pin names this worker's MAIN terminal (host-side, kept fresh at every
  // replacement), so it survives the agentIdentity flap and disambiguates
  // two-family worktrees without any screen guesswork. The pin is TRUSTED ONLY
  // within this row's worktree: a pin whose handle is missing, disconnected,
  // or living in another worktree is stale, and resolution falls through to
  // the next resolver with the reason — it can never redirect a nudge at
  // another worker's terminal.
  if (entry.terminal) {
    const pinned = inWorktree.find((t) => t.handle === entry.terminal);
    if (pinned) {
      // The detail carries the pinned terminal's FAMILY for the
      // untracked-terminal idle proof (provesIdle needs a family to prove
      // prompt shapes when output tracking is lost): Orca's identity when it
      // still reports one, else ONE screen read of this KNOWN terminal —
      // family detection, not terminal selection. Unknown family holds
      // fail-closed in provesIdle; a pin never widens a gate.
      const family = AGENT_IDENTITIES.has(pinned.agentIdentity ?? '')
        ? (pinned.agentIdentity as string)
        : (cfg && run ? (screenAgentFamily(readScreen(cfg, pinned.handle, run)) ?? '') : '');
      return [pinned.handle, family || 'pinned main terminal', 'pin'];
    }
  }
  const agents = inWorktree.filter((t) => AGENT_IDENTITIES.has(t.agentIdentity ?? ''));
  if (agents.length > 1) {
    if (entry.terminal) return [null, `${agents.length} agent terminals in its worktree and the pinned handle is stale`, 'none'];
    return [null, `${agents.length} agent terminals in its worktree (ambiguous)`, 'none'];
  }
  if (agents.length === 1) return [agents[0].handle, agents[0].agentIdentity ?? '', 'identity'];
  if (cfg && run) {
    const verified: Array<{ handle: string; family: string }> = [];
    for (const t of inWorktree) {
      const family = screenAgentFamily(readScreen(cfg, t.handle, run));
      if (family) verified.push({ handle: t.handle, family });
    }
    if (verified.length === 1) return [verified[0].handle, verified[0].family, 'screen'];
  }
  if (entry.terminal) return [null, 'no live agent terminal in its worktree and the pinned handle is stale', 'none'];
  return [null, 'no live agent terminal in its worktree', 'none'];
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
  /** Flagged workers the liveness rule woke this poll (#1826). */
  liveness: string[];
  /** Flagged workers that caught up while a liveness nudge waited out its gates (#1826). */
  livenessDropped: string[];
}

/** One short summary line; never a token or a message body. */
export function describeOutcome(o: Outcome): string {
  const parts = [`nudged: ${o.nudged.join(', ') || 'none'}`];
  if (o.dropped.length) parts.push(`dropped (read while waiting): ${o.dropped.join(', ')}`);
  if (o.covered.length) parts.push(`already nudged: ${o.covered.join(', ')}`);
  if (o.liveness.length) parts.push(`liveness nudged: ${o.liveness.join(', ')}`);
  if (o.livenessDropped.length) parts.push(`liveness dropped (read while waiting): ${o.livenessDropped.join(', ')}`);
  const held = Object.entries(o.held);
  if (held.length) parts.push(`held: ${held.map(([n, r]) => `${n} (${r})`).join('; ')}`);
  parts.push(o.adopted ? 'token adopted' : 'token held');
  return parts.join(' | ');
}

/**
 * Poll attention, nudge each idle roster worker with new mentions, adopt only
 * if all were — then run the #1826 liveness pass over the flagged roster.
 * `nowMs` is the clock, injectable so the strict >N boundary is testable.
 */
export function pollOnce(cfg: Config, run: Runner = runCommand, log: (line: string) => void = console.log, nowMs: () => number = Date.now): Outcome {
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
    const flagged = cfg.roster.filter((e) => e.coordinator === true || e.lifecycle === true);

    const outcome: Outcome = { nudged: [], dropped: [], covered: [], held: {}, adopted: false, liveness: [], livenessDropped: [] };
    const terminals = targets.length || flagged.length ? listTerminals(cfg, run) : [];
    /** The handle each worker's mention nudge was DELIVERED to (#1829 local P2-5): the collapse write reuses it, so a first-ever liveness record is born with its terminal and the next probe keeps the clock. */
    const mentionHandles = new Map<string, string>();
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
      const [handle, detail, via] = resolveTerminal(entry, terminals, cfg, run);
      if (via === 'screen') {
        // Not a held reason (those are deduped per token): a resolution note,
        // logged each time it carries a nudge attempt. These lines are also
        // the flap-incidence record for the upstream Orca report — grep
        // 'resolved by screen' in loop.log.
        log(`orca-attention-router: ${entry.name}: terminal resolved by screen (Orca agentIdentity tracking lost)`);
      }
      if (!handle) {
        outcome.held[entry.name] = detail;
        continue;
      }
      const tracked = new Map(terminals.map((t) => [t.handle, t.lastOutputAt]));
      const [gate, gateWhy] = provesIdle(cfg, handle, detail, tracked.get(handle), cfg.busyWaitMs, run);
      if (!gate) {
        outcome.held[entry.name] = gateWhy;
        continue;
      }
      // Checked AFTER idle, as close to the send as possible: idle says the
      // agent is not working, this says nobody is typing into it (#5473).
      const [empty, why] = promptIsEmpty(cfg, handle, detail, run);
      if (!empty) {
        outcome.held[entry.name] = `prompt not empty (${why})`;
        continue;
      }
      if (why) {
        // The gate passed by DISCARDING a screen-refuted draft. Visible once
        // per token per worker; the draft's text is never logged.
        const note = 'stale Orca draft discarded (screen proves the composer empty)';
        if ((ledger.draftNotes ?? {})[entry.worker] !== note) {
          ledger.draftNotes[entry.worker] = note;
          state.saveLedger(ledger);
          log(`orca-attention-router: ${entry.name}: ${note}`);
        }
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
        ledger.nudged[entry.worker] = { relevantSeq: seen.lastRelevantSeq!, at: nowMs(), stages: 'dropped: read while waiting' };
        delete (ledger.heldSince ?? {})[entry.worker];
        delete (ledger.heldLoggedAt ?? {})[entry.worker];
        state.saveLedger(ledger);
        outcome.dropped.push(entry.name);
        continue;
      }
      // The open-task count is one more network read, so it is taken HERE, before the rechecks below, never between
      // the last gate and the send (#2613 LOCAL P2-1). Unknown or zero is no line.
      const openLine = openTaskLine(run, cfg.hadronCli, cfg.app, entry.worker);
      // The recompute above is a network round trip (or several) that reopened
      // BOTH windows the gates had closed: the agent may have gone busy (#1490
      // steering hazard — a busy agent renders an EMPTY prompt box, so the
      // screen alone cannot catch it) or a human may have started typing
      // (#5473). Re-prove both, as close to the send as possible — the idle
      // recheck FAIL-CLOSED (see RECHECK_IDLE_TIMEOUT_MS): busy here holds,
      // and the next poll recomputes everything. An UNTRACKED terminal gets
      // the screen fallback again (it can never satisfy tui-idle) — but on
      // RELOADED tracking (@codex P2, #1700): the gate's snapshot is as old
      // as the busy-wait was long, and a terminal that produced output since
      // (healing its tracking) must get the ordinary failed-wait hold back,
      // not the untracked fallback. A vanished terminal falls to the fallback,
      // which re-resolves its screen and holds unless it positively proves idle.
      const recheckTracked = listTerminals(cfg, run).find((t) => t.handle === handle)?.lastOutputAt;
      const [recheckIdle, recheckWhy] = provesIdle(cfg, handle, detail, recheckTracked, RECHECK_IDLE_TIMEOUT_MS, run);
      if (!recheckIdle) {
        // The raw reason distinguishes the two holds: 'busy for Ns' (tracked
        // again — the ordinary failed-wait hold, #1700) vs 'unknown idle
        // state — …' (still untracked, screen shows work or text).
        outcome.held[entry.name] = `busy again after the recompute (${recheckWhy})`;
        continue;
      }
      const [stillEmpty, whyNow] = promptIsEmpty(cfg, handle, detail, run);
      if (!stillEmpty) {
        outcome.held[entry.name] = `prompt not empty on recheck (${whyNow})`;
        continue;
      }
      mustOwn();
      const [ok, how] = sendNudge(cfg, handle, nudgeText(now, openLine), run);
      if (!ok) {
        outcome.held[entry.name] = how;
        continue;
      }
      ledger.nudged[entry.worker] = { relevantSeq: now.lastRelevantSeq!, at: nowMs(), stages: how };
      delete (ledger.heldSince ?? {})[entry.worker];
      delete (ledger.heldLoggedAt ?? {})[entry.worker];
      // Persisted immediately after the send, before any other step in the
      // poll: a crash or a later failure here must not cause the same nudge to
      // be sent again (@codex P2, #1490).
      state.saveLedger(ledger);
      mentionHandles.set(entry.worker, handle);
      outcome.nudged.push(entry.name);
    }

    // ── #1826 — the liveness pass ────────────────────────────────────────
    // A flagged worker's watch must survive everything around it: token
    // adoption (State.adopt never touches liveness.json), held polls, other
    // workers' failures. Two layers, deliberately:
    //  - a CHEAP per-poll probe (short idle wait + prompt-empty proof) whose
    //    only job is the durable clock — any non-idle evidence resets it;
    //  - the FULL guard chain — fresh resolution, the busyWaitMs idle gate,
    //    the empty-prompt gate, a fresh head>cursor recompute, the
    //    fail-closed recheck — only once the clock is OWED a send: strictly
    //    more than coordinatorWatchMinutes of continuous idle, with the chat
    //    past the cursor AND past the last delivered frontier. A hold from
    //    the chain lands in outcome.held and holds the token exactly like a
    //    held mention nudge.
    if (flagged.length || existsSync(state.livenessPath)) {
      const liveness = state.liveness();
      // A removed flag resets the watch: records for workers no longer
      // flagged are pruned so a re-flagged worker starts a fresh episode.
      let mutated = false;
      for (const w of Object.keys(liveness)) {
        if (!flagged.some((e) => e.worker === w)) {
          delete liveness[w];
          mutated = true;
        }
      }
      if (mutated) state.saveLiveness(liveness);
      if (flagged.length) {
        // The mention pass touched some flagged workers: a delivered nudge
        // COLLAPSES the liveness send (one send per wake window, the idle
        // clock restarting at it); a held or dropped one observed the
        // terminal or the worker reading — interrupted idle, clock reset.
        const touched = new Set(
          [...outcome.nudged, ...Object.keys(outcome.held), ...outcome.dropped]
            .map((n) => cfg.roster.find((e) => e.name === n)?.worker)
            .filter((w): w is string => Boolean(w)),
        );
        const notes = state.livenessNotes();
        const note = (worker: string, name: string, reason: string): void => {
          if (notes[worker] === reason) return;
          notes[worker] = reason;
          state.saveLivenessNotes(notes);
          log(`orca-attention-router: ${name}: liveness: ${reason}`);
        };
        const head = channelHead(cfg, run); // one query per poll; fail-closed per worker below
        for (const entry of flagged) {
          let rec: LivenessRecord = liveness[entry.worker] ?? {};
          const save = (): void => {
            liveness[entry.worker] = rec;
            state.saveLiveness(liveness);
          };
          const resetClock = (): void => {
            if (rec.idleSince !== undefined || rec.handle !== undefined) {
              delete rec.idleSince;
              delete rec.handle;
              save();
            }
          };
          if (touched.has(entry.worker)) {
            if (outcome.nudged.includes(entry.name)) {
              // The mention nudge's own gates proved the terminal idle just
              // now: the liveness episode restarts at that send, ON the
              // terminal it was delivered to (#1829 local P2-5).
              const viaHandle = mentionHandles.get(entry.worker);
              rec = { ...rec, idleSince: nowMs(), ...(viaHandle !== undefined ? { handle: viaHandle } : {}) };
              save();
            } else {
              resetClock();
            }
            continue;
          }
          // 1) The cheap probe. `provesIdle` returns a non-empty reason ONLY
          // on its untracked screen-fallback success — which proves the
          // prompt empty too — so the extra prompt check runs exactly where
          // tui-idle alone was the evidence (a human typing reads idle,
          // #5473; the watch must not accumulate through a half-typed
          // prompt).
          const [handle, detail] = resolveTerminal(entry, terminals, cfg, run);
          if (!handle) {
            resetClock(); // unresolvable/ambiguous — no episode can be measured
            continue;
          }
          const tracked = terminals.find((t) => t.handle === handle)?.lastOutputAt;
          const [idle, via] = provesIdle(cfg, handle, detail, tracked, RECHECK_IDLE_TIMEOUT_MS, run);
          let continuous = idle;
          if (idle && via === '') {
            const [empty] = promptIsEmpty(cfg, handle, detail, run);
            continuous = empty;
          }
          if (!continuous) {
            resetClock(); // busy, draft, unreadable — interrupted idle
            continue;
          }
          if (rec.handle !== handle || typeof rec.idleSince !== 'number') {
            rec = { ...rec, idleSince: nowMs(), handle }; // first sighting, or a REPLACED terminal
            save();
          }
          // 2) The liveness source, fail-closed on BOTH sides: unknown/null/
          //    error is no candidate this poll — logged once per reason, the
          //    clock kept aging — never a reset and never a thrown poll.
          if (head === null) {
            note(entry.worker, entry.name, 'source unreadable: team channel head');
            continue;
          }
          const cursor = readCursor(cfg, entry.worker, run);
          if (cursor === null) {
            note(entry.worker, entry.name, 'source unreadable: worker read state');
            continue;
          }
          if (head <= cursor) {
            resetClock(); // observed current: the worker read the chat
            continue;
          }
          // 3) Owed a send? Strictly more than N minutes of continuous idle,
          //    chat past the cursor and past the delivered frontier.
          const owed = typeof rec.idleSince === 'number'
            && nowMs() - rec.idleSince > cfg.coordinatorWatchMinutes * 60_000
            && (typeof rec.coveredFrontier !== 'number' || head > rec.coveredFrontier);
          if (!owed) continue;
          // 4) The full guard chain, same gates and order as a mention nudge.
          const fresh = listTerminals(cfg, run);
          const [sendHandle, sendDetail] = resolveTerminal(entry, fresh, cfg, run);
          if (!sendHandle) {
            outcome.held[entry.name] = `liveness: ${sendDetail}`;
            resetClock();
            continue;
          }
          if (sendHandle !== rec.handle) {
            // The terminal was REPLACED between the probe and the chain
            // (#1829 local P2-4): the accumulated idle minutes belong to the
            // OLD terminal's episode. Reset; the new terminal earns its own.
            resetClock();
            continue;
          }
          const sendTracked = fresh.find((t) => t.handle === sendHandle)?.lastOutputAt;
          const [gate, gateWhy] = provesIdle(cfg, sendHandle, sendDetail, sendTracked, cfg.busyWaitMs, run);
          if (!gate) {
            outcome.held[entry.name] = `liveness: ${gateWhy}`;
            resetClock();
            continue;
          }
          const [empty, emptyWhy] = promptIsEmpty(cfg, sendHandle, sendDetail, run);
          if (!empty) {
            outcome.held[entry.name] = `liveness: prompt not empty (${emptyWhy})`;
            resetClock();
            continue;
          }
          mustOwn();
          // The recompute immediately before the send (#1616's analog): both
          // positions re-read; a failure fails the poll rather than send a
          // stale claim, and a worker that caught up in the gate window is
          // dropped, never nudged about what it already read.
          const nowCursor = readCursor(cfg, entry.worker, run);
          const nowHead = channelHead(cfg, run);
          if (nowCursor === null || nowHead === null) {
            throw new RouterError('liveness recompute failed: read state or channel head unreadable (token unchanged)');
          }
          if (nowHead <= nowCursor) {
            resetClock();
            outcome.livenessDropped.push(entry.name);
            continue;
          }
          // Read before the rechecks, never between the last gate and the send (#2613 LOCAL P2-1).
          const openLine = openTaskLine(run, cfg.hadronCli, cfg.app, entry.worker);
          const recheckTracked = listTerminals(cfg, run).find((t) => t.handle === sendHandle)?.lastOutputAt;
          const [idleAgain, againWhy] = provesIdle(cfg, sendHandle, sendDetail, recheckTracked, RECHECK_IDLE_TIMEOUT_MS, run);
          if (!idleAgain) {
            outcome.held[entry.name] = `liveness: busy again after the recompute (${againWhy})`;
            resetClock();
            continue;
          }
          const [stillEmpty, stillWhy] = promptIsEmpty(cfg, sendHandle, sendDetail, run);
          if (!stillEmpty) {
            outcome.held[entry.name] = `liveness: prompt not empty on recheck (${stillWhy})`;
            resetClock();
            continue;
          }
          mustOwn();
          const [ok, how] = sendNudge(cfg, sendHandle, livenessNudgeText(nowCursor, nowHead, openLine), run);
          if (!ok) {
            outcome.held[entry.name] = `liveness: ${how}`;
            continue; // a failed send holds the token; the clock stands — retried next poll
          }
          // Persisted immediately after the send, before any other step in the
          // poll (#1829 local P1-2): a crash or a LATER failure in this poll
          // cannot resend it. The sub-second window between the send and this
          // write is the same one every nudge in this router carries —
          // persist-before-send would need an undecidable "maybe sent"
          // reconciliation instead. The clock restarts AT the send; the
          // frontier covers everything through the head it named.
          rec = { idleSince: nowMs(), handle: sendHandle, coveredFrontier: nowHead };
          save();
          outcome.liveness.push(entry.name);
        }
      }
    }

    const held = Object.entries(outcome.held);
    if (held.length) {
      // Report each held worker's reason once per token, not every poll.
      const fresh = held.filter(([n, r]) => ledger.reported[n] !== r);
      Object.assign(ledger.reported, outcome.held);
      // Long-hold visibility (#6736): a worker pinned with mentions pending for
      // 30+ minutes says so in the log, at most once every 30 minutes.
      // #1845 — the clock measures ONE incident: a worker that left the held
      // set (delivered, or read its mentions itself, or covered) gets its
      // heldSince pruned here, so the next episode starts a fresh count.
      // Without the prune, a worker held yesterday and re-held today reports
      // yesterday's epoch ("held 2442 min" on a 5-minute-old stall), which
      // reads as an incident that never happened.
      const heldWorkers = new Set(held.map(([n]) => cfg.roster.find((e) => e.name === n)?.worker ?? n));
      // `reported` is keyed by NAME (Object.assign from outcome.held), unlike
      // heldSince/heldLoggedAt which are keyed by worker id — prune it by name
      // (Joshua, found while porting to Go: the id-keyed delete was a no-op,
      // so a re-held worker with a repeat reason stayed silent instead of
      // logging the fresh incident's hold line).
      const heldNames = new Set(held.map(([n]) => n));
      for (const w of Object.keys(ledger.heldSince ?? {})) {
        if (!heldWorkers.has(w)) {
          delete ledger.heldSince[w];
          delete (ledger.heldLoggedAt ?? {})[w];
        }
      }
      for (const n of Object.keys(ledger.reported ?? {})) {
        if (!heldNames.has(n)) delete ledger.reported[n];
      }
      const longHolds: string[] = [];
      for (const [n] of held) {
        const w = cfg.roster.find((e) => e.name === n)?.worker ?? n;
        const since = (ledger.heldSince ?? {})[w] ?? nowMs();
        ledger.heldSince[w] = since;
        const minutes = Math.floor((nowMs() - since) / 60_000);
        const last = (ledger.heldLoggedAt ?? {})[w] ?? 0;
        if (minutes >= 30 && nowMs() - last >= 30 * 60_000) {
          ledger.heldLoggedAt[w] = nowMs();
          longHolds.push(`${n} held ${minutes} min with mentions pending (${outcome.held[n]})`);
        }
      }
      state.saveLedger(ledger);
      if (fresh.length) log(`orca-attention-router: ${fresh.map(([n, r]) => `${n}: ${r}`).join('; ')}`);
      if (longHolds.length) log(`orca-attention-router: ${longHolds.join('; ')}`);
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
  const liveness = present ? state.liveness() : {};
  const flagged = cfg.roster.filter((e) => e.coordinator === true || e.lifecycle === true);
  return {
    stateDir: cfg.stateDir,
    tokenAdopted: present && state.token() !== null,
    nudgedUnderCurrentToken: Object.keys(ledger.nudged).sort(),
    held: ledger.reported,
    locked: existsSync(join(cfg.stateDir, '.writer-lock')),
    roster: cfg.roster.map((e) => e.name),
    // #1826 — the live watch state, per flagged roster worker.
    liveness: Object.fromEntries(flagged.map((e) => {
      const r = liveness[e.worker];
      return [e.name, r ? {
        idleMinutes: typeof r.idleSince === 'number' ? Math.round((Date.now() - r.idleSince) / 60_000) : null,
        coveredFrontier: typeof r.coveredFrontier === 'number' ? r.coveredFrontier : null,
      } : null];
    })),
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
