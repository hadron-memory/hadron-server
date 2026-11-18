/**
 * Orca terminal and idle helpers, shared with the live deliverer (scripts/ticker-wake/, #2138).
 *
 * This module used to be the polling attention router: it read the count-only team attention API and nudged
 * Orca-hosted workers. That loop was retired in #2030 (C6; it had been stopped on orca1 since 2026-10-16), and
 * with it the attention poll, the nudge ledger, the state lock and the loop entrypoint. What stays is what the
 * deliverer imports: the roster config loader, the guarded command runner, terminal resolution and the
 * screen-proof idle and empty-prompt checks. Nothing here calls the network or sends input by itself.
 *
 * Why the idle rules exist (measured 2026-09-30, finding
 * hrn:node:hadronmemory.com:hadron-server:findings:orca-terminal-send-busy-agent-claude-queues-codex-steers):
 *
 *  - A prompt typed into a BUSY Codex agent steers its turn, and it silently drops the rest of its task. So a
 *    send is attempted only after `orca terminal wait --for tui-idle` proves the terminal idle, except that an
 *    UNTRACKED terminal (Orca lost its output stream; happens fleet-wide on a serve restart) can never satisfy
 *    the wait, so its timeout reads as unknown and the idle-prompt screen shape decides.
 *  - `tui-idle` also reports idle while a HUMAN is typing, so the screen read must also prove the prompt empty
 *    (`promptIsEmptyFromTerm`). Orca's `draft` state can go STALE (#6736), so for Claude, where typed text
 *    provably renders on the `❯` line, a screen that proves the composer empty REFUTES the draft; Codex's draft
 *    stays authoritative.
 *  - Tab titles are not identity (agents retitle their own tabs), and a worktree's name does not prove which
 *    worker drives it. So each roster entry names its worktree; the terminal is the ONE agent terminal there,
 *    and a CLI worker binding in that worktree must agree.
 *
 * The config file (`~/.config/hadron-orca-attention-router/config.json`) and its state directory are still
 * read by ticker-wake and by `hadron team worker onboard --config`, so they stay.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export const DEFAULT_CONFIG = join(homedir(), '.config', 'hadron-orca-attention-router', 'config.json');

const AGENT_IDENTITIES = new Set(['claude', 'codex']);

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

function parse(res: RunResult, what: string): Record<string, any> {
  try {
    return JSON.parse(res.stdout) as Record<string, any>;
  } catch {
    throw new RouterError(`${what}: unparsable output (exit ${res.code}): ${(res.stderr || res.stdout).trim().slice(0, 300)}`);
  }
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
      // untracked-terminal idle proof (the deliverer's idle proof needs a family to prove
      // prompt shapes when output tracking is lost): Orca's identity when it
      // still reports one, else ONE screen read of this KNOWN terminal —
      // family detection, not terminal selection. Unknown family holds
      // fail-closed in that proof; a pin never widens a gate.
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

