/**
 * The Orca attention router. No network, no Orca: a fake runner plays both
 * `hadron team attention` and `orca terminal list|wait|send`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir, uptime } from 'node:os';
import { join } from 'node:path';
import { nudgeText, livenessNudgeText,
  type Config, type Runner, type RunResult, type Terminal, RouterError, State, breakStaleLock, describeOutcome, loadConfig, pollOnce,
  promptIsEmptyFromTerm, promptLineIsEmpty, resolveTerminal, runCommand, screenAgentFamily, status,
  CALL_TIMEOUT_MS, MIN_CALL_TIMEOUT_MS,
} from './router.js';

/** Rendered screens as Orca returned them on 2026-10-01 (idle, nobody typing). */
const RULE = '─'.repeat(60);
const CLAUDE_HINT = '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents';
const CLAUDE_IDLE = ['⏺ Done.', '❯ an earlier submitted turn', '✻ Cogitated for 1m 3s', RULE, '❯\u00a0', RULE, CLAUDE_HINT];
const CODEX_IDLE = ['  Worked for 33s • 16:32', '› Ask Codex to do anything', '  GPT-6-Sol high · ~/orca/workspaces/hadron-server/andi · Start worker session as Andi', '  ? for shortcuts'];
/** A WORKING agent renders an EMPTY composer — the running-turn line above the
 * prompt is the only separator (@codex P2, #1700; live screens 2026-10-09/10). */
const CLAUDE_BUSY_EMPTY = ['  ⎿ Tip: Use /btw to ask a quick side question', '  (ctrl+b to run in background)', '✽ Bunning… (5m 55s · ↓ 15.6k tokens)', RULE, '❯ ', RULE, CLAUDE_HINT];
const CODEX_BUSY_EMPTY = ['  • Working (6s • esc to interrupt)', '› Ask Codex to do anything', '  GPT-6-Sol high · ~/orca/workspaces/hadron-server/andi · Start worker session as Andi', '  ? for shortcuts'];
/** Fresh launches (never worked): captured live 2026-10-10 — GLM worker Cody,
 * Codex worker Dara. Positive idle chrome, no done-marker exists yet (#1700 P2 r2). */
const CLAUDE_FRESH = [' ▐▛███▛█   Claude Code v2.1.296', '▝▜██████▀  glm-5.3 · API Usage Billing', ' ▝▝   ▝▝   ~/orca/workspaces/hadron-server/cody', RULE, '❯ ', RULE, CLAUDE_HINT];
const CODEX_FRESH = ['│ ✨ Update available! 0.162.0 -> 0.162.1         │', '  >_ OpenAI Codex (v0.162.0)', '     ~/orca/workspaces/hadron-server/dara', '  permissions: YOLO mode', '› Ask Codex to do anything', '  GPT-6.1-Sol default · ~/orca/workspaces/hadron-server/dara', '  ? for shortcuts'];
/** Empty prompt, no busy marker, and nothing positively idle either — must HOLD. */
const CLAUDE_UNKNOWN_QUIET = ['  some status output nobody classified', '  another unrecognized line', RULE, '❯ ', RULE, CLAUDE_HINT];

/** REAL idle screens captured live 2026-10-11 (Yuri's first-night production report,
 * #8165): ordinary assistant output text above the done-marker - the shape the
 * synthetic fixtures lacked, which the whole-window rule fail-closed to unknown. */
const CLAUDE_IDLE_REAL_XAN = ["  Queued for my gate: Bindi's remaining attach-steps, Dan's 12-follow-up batch,", '  Session open.', '✻ Brewed for 2m 36s · done 3:20 AM', RULE, '❯ ', RULE, CLAUDE_HINT];
const CLAUDE_IDLE_REAL_LIAM = ['  both types.', "  file\". I've marked team chat read through #8177, the worktree is clean, and I'm standing by.", '✻ Cooked for 9m 42s · done 3:26 AM', '  ✔ Update installed · Restart to update', RULE, '❯ ', RULE, CLAUDE_HINT];
const CLAUDE_IDLE_COMPACTED = ['✻ Compacted while idle', RULE, '❯ ', RULE, CLAUDE_HINT];
/** REAL idle Codex screens captured live 2026-10-15 (Hugo, #1968): Diego, Gene
 * and Xavier held for hours as 'unrecognized chrome above the prompt' while
 * idle at completed turns — the `Worked for …` footer renders ABOVE its
 * `↳ Recap:` block, so the recap tail is positionally NEWEST and its
 * continuation lines indent ~12 columns. Diego's marker sits 10 lines above
 * the prompt (outside the old 8-line window), Gene's 11, Xavier's 6. Verbatim
 * screen tails, recap prose truncated only where it ran past the screen edge. */
const CODEX_IDLE_RECAP_DIEGO = [
  '    + 1 line (^t to expand)',
  '  Worked for 10s • 3:49 AM',
  '  ↳ Recap: Completed and posted the assigned blind reviews and carries,',
  '            including #1899’s race fix, #1929, #1923, cli#883, and latest',
  '            #1930/#1959 approvals. Reviews were static; local test execution is',
  '            not reported. The router classifier fix is merged but not yet',
  '            reloaded. Chat is confirmed read through #12203; the latest unread',
  '            batch remains pending.',
  '            Next: Read unfiltered team chat from #12204 using the live session,',
  '            handle dispatches, and mark read; finish silently if no action is',
  '            needed.',
  '› Ask Codex to do anything',
  '  GPT-6.1-Sol default · ~/orca/workspaces/hadron-portal/diego · Review hadron-…',
  '  ? for shortcuts',
];
const CODEX_IDLE_RECAP_GENE = [
  '  Worked for 24s • 7:38 PM',
  '  ↳ Recap: Gene completed the comment API migration in PR #1070 after #1059/',
  '            #1060 merged, then pushed hint and history-link fixes with',
  '            regression tests. The migration passed full validation; follow-ups',
  '            passed targeted tests and typecheck. Latest review/deployment',
  '            status is unconfirmed. Current task is reading unread chat from',
  '            #9605; completion and any assignments remain unconfirmed. Keep',
  '            Gene’s session open.',
  '            Next: Read chat unfiltered from #9605 using Gene’s existing',
  '            session, act on assignments, then mark read; finish silently if',
  '            none.',
  '› Ask Codex to do anything',
  '  GPT-6.1-Sol default · ~/orca/workspaces/hadron-portal/gene · Bind Gene worker…',
  '  ? for shortcuts',
];
const CODEX_IDLE_RECAP_XAVIER = [
  '    + 2 lines (^t to expand)',
  '• Read unfiltered and marked through #11441. Replied to Vera’s Built-line',
  '  survey as Xavier in #11442.',
  '  Worked for 1m 4s • 4:04 PM',
  '  ↳ Recap: The task is to read Hadron team chat unfiltered, handle actionable',
  '            mentions, and mark it read. Latest backlog was read and marked',
  '            through #11441; Xavier replied to Vera’s Built-line survey in',
  '            #11442. #1842 reached CHECKED, T2 + §10 and was posted to Eden.',
  '            #1770 was dispatched but remains in review under Xylon’s gate.',
  '› Ask Codex to do anything',
  '  GPT-6.1-Sol default · ~/orca/workspaces/hadron-server/xavier · Verify Xavier…',
  '  ? for shortcuts',
];
/** Synthetic from Atilla's canonical #1968 capture: a receipt URL folded across
 * lines plus the recap block pushes `Worked for` 9 lines above the prompt —
 * outside the old 8-line fold (recap skip alone at depth 8 cannot reach it). */
const CODEX_IDLE_URL_RECEIPT = [
  '  Reviewer approved: https://github.com/hadron-memory/hadron-portal/pull/',
  '  1118#issuecomment-6182034412',
  '  Receipt posted: https://github.com/hadron-memory/hadron-server/pull/1932#',
  '  issuecomment-6180470118',
  '    + 3 lines (^t to expand)',
  '  Worked for 1m 28s • 7:41 AM',
  '  ↳ Recap: Seat verdict saved and read back before the signed receipt was',
  '            posted; the private stack is cleaned and the binding stays live.',
  '            Chat was marked read through the receipt; nothing else was owed.',
  '            Next: available for routing.',
  '› Ask Codex to do anything',
  '  GPT-6.1-Sol default · ~/orca/workspaces/hadron-server/atilla · Static review…',
  '  ? for shortcuts',
];
/** #1968 counterexamples — the skip rules must not degenerate: a deep-indented
 * tail with NO idle marker anywhere stays unknown, and Riana's captured
 * notice-box tail (2-space indent, no marker on screen) stays unknown. */
const CODEX_UNKNOWN_INDENT_NO_MARKER = [
  '            deeply indented continuation-shaped output with no completed-',
  '            turn footer anywhere on screen',
  '› Ask Codex to do anything',
  '  GPT-6.1-Sol default · ~/orca/workspaces/hadron-server/riana · Start worker session…',
  '  ? for shortcuts',
];
const CODEX_IDLE_NOTICE_RIANA = [
  '• Ran hadron node create --help; ls /tmp/riana*1883* /tmp/riana*1877* | head -20',
  '    + 109 lines (^t to expand)',
  '  ⓘ This content can’t be shown',
  '  We take extra care with some cybersecurity requests. If you’re doing',
  '  authorized security work, apply for Daybreak to get broader access.',
  '  Learn more: https://help.openai.com/en/articles/20001326',
  '  Apply for Daybreak: https://openai.com/form/enterprise-trusted-access-for-cyber/',
  '› Ask Codex to do anything',
  '  GPT-6.1-Sol default · ~/orca/workspaces/hadron-server/riana · Start worker session…',
  '  ? for shortcuts',
];
/** Chip's verbatim capture, same class (#1983): a suppressed turn with no
 * output at all — `└ (no output)` + the notice box, NO Worked-for footer. */
const CODEX_IDLE_NOTICE_CHIP = [
  '  └ (no output)',
  '    + Show details',
  '  ⓘ This content can’t be shown',
  '  We take extra care with some cybersecurity requests. If you’re doing authorized security work, apply for Daybreak to',
  '  get broader access.',
  '  Learn more: https://help.openai.com/en/articles/20001326',
  '  Apply for Daybreak: https://openai.com/form/enterprise-trusted-access-for-cyber/',
  '› Ask Codex to do anything',
  '  GPT-6.1-Sol default · ~/orca/workspaces/hadron-server/chip-t1 · Catch up Chip QA session',
  '  ? for shortcuts',
];
/** Greta's verbatim capture, 2026-10-21: a completed Codex turn whose dev
 * server keeps running, so Codex draws its background-process status line
 * between the `Worked for` footer and the composer. */
const CODEX_IDLE_BACKGROUND_GRETA = [
  '• Checked and marked read through #28306. No new tagged messages; all four PRs remain open at unchanged heads. No task',
  '  progress changed; merge coordination remains pending.',
  '  Worked for 23s • 3:08 PM',
  '  2 background terminals running · /ps to view · /stop to close',
  '› Ask Codex to do anything',
  '  GPT-6.1-Sol default · ~/orca/workspaces/hadron-portal/greta · Recover Greta session after restart',
  '  ? for shortcuts',
];
/** Andi's P2 negative controls (#1976 review, 2026-10-15): a deep indent with
 * NO recap header above it is an unrecognized CURRENT status — the flat ≥8
 * floor proved idle over an old marker + an 8/12-space status line (only 0/2
 * spaces held), which is the send direction. Structural anchoring: only lines
 * INSIDE a header-anchored recap block are skipped. */
const CODEX_UNKNOWN_INDENTED_STATUS_NO_HEADER = [
  '  Worked for 1m 28s • 7:41 AM',
  '          an indented current status nobody classified',
  '› Ask Codex to do anything',
  '  GPT-6.1-Sol default · ~/orca/workspaces/hadron-server/andi · Static review…',
  '  ? for shortcuts',
];
const CODEX_UNKNOWN_STATUS_NO_RECAP = [
  '  Worked for 1m 28s • 7:41 AM',
  '  an unindented current status nobody classified',
  '› Ask Codex to do anything',
  '  GPT-6.1-Sol default · ~/orca/workspaces/hadron-server/andi · Static review…',
  '  ? for shortcuts',
];
/** Claude-family recap block, captured live from Yuri's terminal 2026-10-15
 * (#1977): header `※ recap:` indents 2, continuation 4 — header-RELATIVE
 * indent covers both families (Codex 2→12) in one structural rule. */
const CLAUDE_IDLE_RECAP_YURI = [
  '  #1958 progress: shed node done and corrected; rotate, start-session (both',
  '  tracks), and end-session nodes next — same ladders, rotation keeps end',
  '  --resume-claim since its successor starts fresh by design.',
  '✻ Worked for 1m 10s · done 3:54 PM',
  '  ※ recap: Executing my half of #1958: rewriting the lifecycle task nodes to use',
  '    resume claims. The shed node is done and corrected; next action is applying',
  '    the same claim ladders to the rotate and start/end-session nodes.',
  RULE, '❯ ', RULE, CLAUDE_HINT,
];
/** Claude counterexample: 4-indent output (a code block) under a done-marker
 * with NO recap header — the header-relative rule must not skip it. */
const CLAUDE_UNKNOWN_CODEBLOCK_NO_HEADER = [
  '✻ Worked for 2m 6s · done 3:58 PM',
  '    const verdict = computeLiveness(row);',
  '    return verdict;',
  RULE, '❯ ', RULE, CLAUDE_HINT,
];
const withPrompt = (screen: string[], marker: string, text: string) => {
  const i = screen.map((l) => l.trimStart().startsWith(marker)).lastIndexOf(true);
  return [...screen.slice(0, i), `${marker} ${text}`, ...screen.slice(i + 1)];
};

const TOKEN_1 = 'tok-one-SECRET';
const TOKEN_2 = 'tok-two-SECRET';
const CHANNEL = 'chan-team';

function worker(id: string, name: string, o: { mentions?: number; unread?: number; first?: number; relevant?: number | null; head?: number } = {}) {
  return {
    worker: id, workerName: name, channel: CHANNEL, unread: o.unread ?? 3, unreadMentions: o.mentions ?? 1,
    firstUnreadSeq: o.first ?? 100, lastRelevantSeq: o.relevant === undefined ? 110 : o.relevant, lastSeq: o.head ?? 120,
  };
}

class FakeCLIs {
  attention: { token: string; workers: unknown[] } = { token: TOKEN_1, workers: [] };
  attentionOk = true;
  /** Rows served to the tokenless fresh re-read before each send (#1616); null = same as the poll. */
  fresh: unknown[] | null = null;
  freshOk = true;
  /** The token a fresh scan offers; the router must never adopt it. */
  freshToken = 'tok-fresh-NEVER-ADOPT';
  freshServed = 0;
  terminals: Array<Record<string, unknown>> = [];
  busy = new Set<string>();
  /** Busy on a handle's SECOND wait — the post-recompute idle recheck. */
  busyRecheck = new Set<string>();
  /** Terminals with NO output tracking — tui-idle can never satisfy (#7398). */
  untracked = new Set<string>();
  /** Handles served as TRACKED on every `terminal list` AFTER the first — tracking healed between the gate and the recheck (@codex P2, #1700). */
  healTracking = new Set<string>();
  listCalls = 0;
  waits = new Map<string, number>();
  reject = new Set<string>();
  /** The rendered screen per handle; set by terminal() to an idle prompt for its agent. */
  screens = new Map<string, { tail?: unknown; draft?: string; source?: string; ok?: boolean }>();
  /** Served to a handle's SECOND screen read — the post-recompute recheck (#5473 window). */
  recheckScreens = new Map<string, { tail?: unknown; draft?: string; source?: string; ok?: boolean }>();
  reads = new Map<string, number>();
  sent: Array<[string, string]> = [];
  /** Workers with a mention-only row; `null` = every worker queried has one. */
  mentionOnly: Set<string> | null = null;
  /** #1826 — the team Channel's head served to `channel(ref:)`; `headOk=false` errors. */
  head = 120;
  headOk = true;
  headReads = 0;
  /** Served on the SECOND+ head query (the recompute at send); undefined = always base. */
  freshHead?: number;
  /** #1826 — the worker's cursor (channelReadState.lastSeenSeq); absent = 0 (never checkpointed). */
  cursors = new Map<string, number>();
  cursorQueries = new Map<string, number>();
  /** #2613: agentTasks rows by worker id (the delivered worker's open-task read), the page reads seen, and a failure switch. */
  openTasks = new Map<string, unknown[]>();
  openTaskReads: string[][] = [];
  openTasksFail = false;
  /** Served on the worker's SECOND+ cursor query (the recompute at send). */
  freshCursors = new Map<string, number>();
  /** channelReadState answers null (unreadable/unknown) for these workers. */
  cursorNulls = new Set<string>();
  cursorFails = new Set<string>();
  /** #1829 P1-1 — serve errors WITH partial data for these workers (legal GraphQL). */
  cursorErrors = new Set<string>();
  /** #1829 P2-4 — from this `terminal list` call on, every handle gains a suffix (a mid-poll replacement). */
  renameTerminalsFromList = 0;
  /** `terminal list` calls at and beyond this count serve an EMPTY list (#1826 chain re-resolution). */
  hideTerminalsFromList = 0;
  pages = 1;
  dropFinalToken = false;
  incompleteFinal = false;
  registerFails = new Set<string>();
  /** Override the winning register row a worker resolves to. */
  registerRow: ((worker: string) => unknown) | null = null;
  calls: string[][] = [];
  /**
   * Poll-phase tracking, to tell the MAIN scan from the fresh re-read (#1616):
   * both are bare (no `s=`, no `p=`) whenever the previous poll failed to
   * adopt. A fresh scan only ever happens AFTER that target's idle gate, and
   * every target starts with its register check — so "a wait since the last
   * register" identifies it exactly.
   */
  sawWait = false;

  constructor(readonly root: string) {}

  terminal(name: string, agent: string | null = 'claude', handle?: string, tracked = true) {
    const wt = join(this.root, 'workspaces', name);
    mkdirSync(wt, { recursive: true });
    const h = handle ?? `term_${name}`;
    this.terminals.push({
      handle: h, worktreePath: wt, agentIdentity: agent, connected: true, writable: true,
      lastOutputAt: tracked ? Date.now() : null,
    });
    if (!tracked) this.untracked.add(h);
    this.screens.set(h, { tail: agent === 'codex' ? CODEX_IDLE : CLAUDE_IDLE });
  }

  run: Runner = (argv) => {
    this.calls.push(argv);
    const out = (d: unknown, code = 0): RunResult => ({ code, stdout: JSON.stringify(d), stderr: '' });
    const verb = argv.slice(1, 3).join(' ');
    if (argv[1] === 'api' && argv[2].includes('teamAttentionPage')) {
      const pageArg = argv.find((a) => a.startsWith('p='));
      const bare = !pageArg && !argv.some((a) => a.startsWith('s='));
      // The tokenless re-read just before a send (#1616): bare, and this
      // target's idle gate has run since its register check.
      if (bare && this.sawWait) {
        this.freshServed++;
        if (!this.freshOk) return out({ errors: [{ message: 'fresh scan down' }] }, 1);
        return out({ data: { teamAttentionPage: {
          scanComplete: true, nextPage: null, adoptableSince: this.freshToken,
          items: this.fresh ?? this.attention.workers,
        } } });
      }
      if (!this.attentionOk) return out({ errors: [{ message: 'boom' }] }, 1);
      // Serve `pages` pages; the items all ride the last one; only it carries the token.
      const n = pageArg ? Number(pageArg.slice(2)) : 1;
      const last = n >= this.pages;
      return out({ data: { teamAttentionPage: {
        scanComplete: last && !this.incompleteFinal, nextPage: last ? null : String(n + 1),
        adoptableSince: last && !this.dropFinalToken ? this.attention.token : null,
        items: last ? this.attention.workers : [],
      } } });
    }
    if (argv[1] === 'api' && argv[2].includes('agentTasks(')) {
      const fa = (k: string) => argv.find((a, i) => argv[i - 1] === '-F' && a.startsWith(`${k}=`))?.slice(k.length + 1) as string;
      this.openTaskReads.push([fa('a'), fa('w'), fa('o')]);
      if (this.openTasksFail) return out({ errors: [{ message: 'tasks down' }] }, 1);
      return out({ data: { agentTasks: (this.openTasks.get(fa('w')) ?? []).slice(Number(fa('o')), Number(fa('o')) + 200) } });
    }
    if (argv[1] === 'api') {
      this.sawWait = false; // a new target begins; its fresh scan (if any) follows its idle gate
      if (argv[2].includes('channelReadState')) {
        // #1826 — the worker's read cursor (the liveness source attention cannot see).
        const w = argv[argv.indexOf('-F') + 1].replace(/^w=/, '');
        const n = (this.cursorQueries.get(w) ?? 0) + 1;
        this.cursorQueries.set(w, n);
        if (this.cursorFails.has(w)) return out({ errors: [{ message: 'read-state down' }] }, 1);
        if (this.cursorErrors.has(w)) {
          // Legal GraphQL: a field error rides WITH partial data. The integer
          // fragment must not pass as live (#1829 local P1-1).
          return out({ errors: [{ message: 'partial' }], data: { channelReadState: { lastSeenSeq: this.cursors.get(w) ?? 100 } } });
        }
        if (n >= 2 && this.freshCursors.has(w)) {
          return out({ data: { channelReadState: { lastSeenSeq: this.freshCursors.get(w) } } });
        }
        if (this.cursorNulls.has(w)) return out({ data: { channelReadState: null } });
        return out({ data: { channelReadState: { lastSeenSeq: this.cursors.get(w) ?? 0 } } });
      }
      if (argv[2].includes('channel(ref')) {
        // #1826 — the team Channel's watermark.
        this.headReads++;
        if (!this.headOk) return out({ errors: [{ message: 'channel query down' }] }, 1);
        if (this.headReads >= 2 && this.freshHead !== undefined) {
          return out({ data: { channel: { lastSeq: this.freshHead } } });
        }
        return out({ data: { channel: { lastSeq: this.head } } });
      }
      if (this.registerFails.size && this.registerFails.has(argv[argv.indexOf('-F') + 1].replace(/^w=/, ''))) {
        return out({ errors: [{ message: 'register down' }] }, 1);
      }
      // attendeeRegister: the winning row for the team Channel.
      const w = argv[argv.indexOf('-F') + 1].replace(/^w=/, '');
      const ids = this.mentionOnly ?? new Set(['w-eli', 'w-baloo', 'w-ada', 'w-diego', 'w-gene', 'w-xavier', 'w-atilla', 'w-riana', 'w-andi', 'w-yuri', 'w-chip', 'w-greta']);
      const row = this.registerRow?.(w) ?? { namedBy: 'WORKER', channel: { id: CHANNEL }, entry: { mentionOnly: ids.has(w) } };
      return out({ data: { attendeeRegister: [row] } });
    }
    if (verb === 'terminal list') {
      this.listCalls++;
      if (this.hideTerminalsFromList && this.listCalls >= this.hideTerminalsFromList) {
        return out({ ok: true, result: { terminals: [] } });
      }
      const renamed = this.renameTerminalsFromList && this.listCalls >= this.renameTerminalsFromList;
      const terminals = this.listCalls > 1 && this.healTracking.size
        ? this.terminals.map((t) => (this.healTracking.has(t.handle as string) ? { ...t, lastOutputAt: Date.now() } : t))
        : this.terminals;
      return out({ ok: true, result: { terminals: renamed ? terminals.map((t) => ({ ...t, handle: `${t.handle}_r` })) : terminals } });
    }
    const handle = argv[argv.indexOf('--terminal') + 1];
    if (verb === 'terminal wait') {
      const n = (this.waits.get(handle) ?? 0) + 1;
      this.waits.set(handle, n);
      const busyNow = n === 1 ? this.busy.has(handle) : this.busy.has(handle) || this.busyRecheck.has(handle);
      const satisfiable = !busyNow && !this.untracked.has(handle);
      // Only a SATISFIED wait precedes a fresh scan; a busy worker is held
      // before any recompute, and its failed wait must not flip the phase.
      if (satisfiable) this.sawWait = true;
      return satisfiable
        ? out({ ok: true, result: { wait: { satisfied: true } } })
        : out({ ok: false, error: { code: 'timeout', message: 'timeout' } });
    }
    if (verb === 'terminal read') {
      const n = (this.reads.get(handle) ?? 0) + 1;
      this.reads.set(handle, n);
      // The recheck screen serves at read 2 for TRACKED terminals (gate:
      // promptIsEmpty only) but at read 3+ for UNTRACKED ones — the #1700
      // gate's screen fallback reads first, shifting every later read by one.
      const rcIdx = this.untracked.has(handle) ? 3 : 2;
      const sc = (n >= rcIdx ? this.recheckScreens.get(handle) : undefined) ?? this.screens.get(handle);
      if (!sc || sc.ok === false) return out({ ok: false, error: { code: 'terminal_handle_stale' } }, 1);
      // The untracked gate's screen fallback is this target's idle gate for
      // phase purposes (#7398 / #1700 P3): an idle untracked screen on the
      // gate read plays the role a satisfied wait plays for tracked terminals.
      if (n === 1 && this.untracked.has(handle)) {
        const tailJson = JSON.stringify(sc.tail);
        if ([CLAUDE_IDLE, CODEX_IDLE, CLAUDE_FRESH, CODEX_FRESH].some((f) => JSON.stringify(f) === tailJson)) this.sawWait = true;
      }
      return out({ ok: true, result: { terminal: { handle, source: sc.source ?? 'screen', tail: sc.tail, ...(sc.draft !== undefined ? { draft: sc.draft } : {}) } } });
    }
    if (verb === 'terminal send') {
      if (this.reject.has(handle)) return out({ ok: false, error: { code: 'terminal_handle_stale' } }, 1);
      this.sent.push([handle, argv[argv.indexOf('--text') + 1]]);
      return out({ ok: true, result: { send: { accepted: true, prompt: { requestId: 'req-1', stages: ['input_accepted', 'turn_started'] } } } });
    }
    throw new Error(`unexpected call ${argv.join(' ')}`);
  };
}

let root: string;
let fake: FakeCLIs;
let logs: string[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-router-'));
  fake = new FakeCLIs(root);
  logs = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function cfg(...entries: Array<[string, string]>): Config {
  return {
    app: 'hrn:app:x:team', channel: CHANNEL, hadronCli: 'hadron', orcaCli: 'orca', stateDir: join(root, 'state'),
    roster: entries.map(([worker, name]) => ({ worker, name, worktree: join(root, 'workspaces', name.toLowerCase()) })),
    busyWaitMs: 10, submitWaitS: 1, coordinatorWatchMinutes: 20,
  };
}
const poll = (c: Config, now?: () => number) => pollOnce(c, fake.run, (l) => logs.push(l), now);
const adopted = (c: Config) => new State(c.stateDir).token();
const sentHandles = () => fake.sent.map(([h]) => h);

describe('Orca attention router — the happy path', () => {
  it('nudges an idle roster worker with a mention once, proving idle first, and adopts the token', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli');
    fake.attention.workers = [worker('w-eli', 'Eli', { mentions: 2, unread: 5 })];
    const out = poll(c);
    expect(out).toMatchObject({ nudged: ['Eli'], adopted: true });
    expect(adopted(c)).toBe(TOKEN_1);
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0][0]).toBe('term_eli');
    expect(fake.sent[0][1]).toContain('5 relevant unread (2 mentions');
    expect(fake.sent[0][1]).toContain('unread #100–#120');
    expect(fake.sent[0][1]).toContain('latest mention #110');
    expect(fake.sent[0][1]).toContain('as of send');
    expect(fake.sent[0][1]).toContain('end with one short line');
    expect(fake.sent[0][1]).toContain('do not post to team chat');
    const verbs = fake.calls.map((a) => a.slice(1, 3).join(' '));
    expect(verbs.indexOf('terminal wait')).toBeLessThan(verbs.indexOf('terminal read'));
    expect(verbs.indexOf('terminal read')).toBeLessThan(verbs.indexOf('terminal send'));
  });

  it('passes the adopted token back on the next poll', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli');
    fake.attention.workers = [worker('w-eli', 'Eli')];
    poll(c);
    fake.attention.token = TOKEN_2;
    fake.attention.workers = []; // nothing relevant since the adopted token
    poll(c);
    const polls = fake.calls.filter((a) => a[1] === 'api' && a[2].includes('teamAttentionPage'));
    // First main scan bare (no token yet); the second main scan passes the adopted
    // token back; the fresh re-read before each send (#1616) is always tokenless.
    expect(polls[0].some((a) => a.startsWith('s='))).toBe(false);
    const withSince = polls.filter((a) => a.some((x) => x.startsWith('s=')));
    expect(withSince).toHaveLength(1);
    expect(withSince[0]).toContain(`s=${TOKEN_1}`);
    expect(fake.freshServed).toBe(1); // poll 1's single nudge
    expect(polls.every((a) => !a.includes(fake.freshToken))).toBe(true);
  });

  it('leaves workers off the roster, and roster workers without a mention, alone', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli');
    fake.attention.workers = [worker('w-ada', 'Ada'), worker('w-eli', 'Eli', { mentions: 0 })];
    expect(poll(c).adopted).toBe(true);
    expect(fake.sent).toEqual([]);
  });
});

describe('Orca attention router — untracked terminals: unknown is not busy (#7398)', () => {
  it('an UNTRACKED terminal times out tui-idle forever, but a screen that proves the idle prompt still delivers', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli', 'claude', undefined, false); // lastOutputAt null — tracking lost
    fake.attention.workers = [worker('w-eli', 'Eli', { mentions: 1, unread: 2, relevant: 110 })];
    const out = poll(c);
    expect(out).toMatchObject({ nudged: ['Eli'], adopted: true });
    expect(fake.sent).toHaveLength(1);
  });

  it('an untracked terminal whose screen shows activity holds as unknown, not busy', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli', 'claude', undefined, false);
    fake.attention.workers = [worker('w-eli', 'Eli')];
    fake.screens.set('term_eli', { tail: withPrompt(CLAUDE_IDLE, '❯', 'mid-turn output') }); // no idle-prompt shape
    const out = poll(c);
    expect(out.nudged).toEqual([]);
    expect(out.held.Eli).toContain('unknown idle state');
    expect(out.held.Eli).not.toContain('busy for');
    expect(fake.sent).toEqual([]);
  });

  it('#1845 — a TRACKED terminal that times out NUDGES when the screen proves a completed turn (the busy-misread fix)', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli'); // tracked; the tui-idle wait times out below
    fake.busy.add('term_eli');
    fake.screens.set('term_eli', { tail: CLAUDE_IDLE }); // completed turn, empty composer
    fake.attention.workers = [worker('w-eli', 'Eli')];
    const out = poll(c);
    expect(out.nudged).toEqual(['Eli']);
    expect(sentHandles()).toEqual(['term_eli']);
  });

  it('#1845 codex shape — tracked timeout over a Worked-for frame nudges (Atilla/Chip, held 2442/877 min as busy)', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli', 'codex');
    fake.busy.add('term_eli');
    fake.screens.set('term_eli', { tail: CODEX_IDLE });
    fake.attention.workers = [worker('w-eli', 'Eli')];
    const out = poll(c);
    expect(out.nudged).toEqual(['Eli']);
    expect(sentHandles()).toEqual(['term_eli']);
  });

  it('a TRACKED terminal that times out still HOLDS on a live working indicator — the screen vetoes', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli'); // tracked
    fake.busy.add('term_eli');
    fake.screens.set('term_eli', { tail: CLAUDE_BUSY_EMPTY });
    fake.attention.workers = [worker('w-eli', 'Eli')];
    const out = poll(c);
    expect(out.nudged).toEqual([]);
    expect(out.held.Eli).toContain('a running turn is drawn above the prompt');
    expect(fake.sent).toEqual([]);
  });

  it('the post-recompute recheck also falls back to the screen for untracked terminals', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli', 'claude', undefined, false);
    fake.attention.workers = [worker('w-eli', 'Eli')];
    // Gate passes via the screen fallback; the recompute re-runs; the fail-closed
    // recheck (500ms) also times out for the untracked terminal — the screen
    // still proves the idle prompt, so the send proceeds.
    const out = poll(c);
    expect(out).toMatchObject({ nudged: ['Eli'], adopted: true });
    const waits = fake.calls.filter((a) => a.slice(1, 3).join(' ') === 'terminal wait');
    expect(waits.length).toBeGreaterThanOrEqual(2); // gate + recheck both attempted
    expect(fake.freshServed).toBe(1); // the fallback path really exercised the fresh re-read (#1700 P3)
  });

  it('an untracked BUSY Claude with an EMPTY composer holds as unknown — no mid-turn nudge (#1700 P2)', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli', 'claude', undefined, false);
    fake.attention.workers = [worker('w-eli', 'Eli')];
    fake.screens.set('term_eli', { tail: CLAUDE_BUSY_EMPTY }); // empty box + hint; spinner above
    const out = poll(c);
    expect(out.nudged).toEqual([]);
    expect(out.held.Eli).toContain('running turn');
    expect(out.held.Eli).not.toContain('busy for');
    expect(fake.sent).toEqual([]);
    expect(fake.freshServed).toBe(0); // held at the gate: no fresh scan ran
  });

  it('same for Codex: the Working line above the placeholder holds the nudge (#1700 P2)', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli', 'codex', undefined, false);
    fake.attention.workers = [worker('w-eli', 'Eli')];
    fake.screens.set('term_eli', { tail: CODEX_BUSY_EMPTY });
    const out = poll(c);
    expect(out.nudged).toEqual([]);
    expect(out.held.Eli).toContain('running turn');
    expect(fake.sent).toEqual([]);
  });

  it('busy only after the fresh scan: the gate passed, the recheck screen shows a running turn (#1700 P2)', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli', 'claude', undefined, false);
    fake.attention.workers = [worker('w-eli', 'Eli')];
    fake.recheckScreens.set('term_eli', { tail: CLAUDE_BUSY_EMPTY }); // it went busy during the recompute
    const out = poll(c);
    expect(out.nudged).toEqual([]);
    expect(out.held.Eli).toContain('busy again after the recompute');
    expect(out.held.Eli).toContain('running turn');
    expect(fake.sent).toEqual([]);
    expect(fake.freshServed).toBe(1);
  });

  it('tracking healed before the recheck restores the ORDINARY failed-wait hold (#1700 P2)', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli', 'claude', undefined, false);
    fake.attention.workers = [worker('w-eli', 'Eli')];
    fake.healTracking.add('term_eli'); // produced output after the gate: the recheck's list shows it tracked
    fake.busyRecheck.add('term_eli');  // and its recheck wait times out
    fake.recheckScreens.set('term_eli', { tail: CLAUDE_BUSY_EMPTY }); // #1845: a live indicator, not just the wait
    const out = poll(c);
    expect(out.nudged).toEqual([]);
    expect(out.held.Eli).toContain('busy again after the recompute (a running turn is drawn above the prompt');
    expect(out.held.Eli).not.toContain('unknown');
    expect(fake.sent).toEqual([]);
  });

  it('a FRESH Claude/GLM launch (welcome banner, no done-marker) is positively idle and delivers (#1700 P2 r2)', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli', 'claude', undefined, false);
    fake.attention.workers = [worker('w-eli', 'Eli')];
    fake.screens.set('term_eli', { tail: CLAUDE_FRESH }); // captured live (Cody, 2026-10-10)
    const out = poll(c);
    expect(out).toMatchObject({ nudged: ['Eli'], adopted: true });
    expect(fake.freshServed).toBe(1);
  });

  it('a FRESH Codex launch (version banner above the placeholder) is positively idle and delivers (#1700 P2 r2)', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli', 'codex', undefined, false);
    fake.attention.workers = [worker('w-eli', 'Eli')];
    fake.screens.set('term_eli', { tail: CODEX_FRESH }); // captured live (Dara, 2026-10-10)
    const out = poll(c);
    expect(out).toMatchObject({ nudged: ['Eli'], adopted: true });
  });

  it('an untracked screen with NEITHER a busy marker NOR a positive idle marker HOLDS as unknown (#1700 P2 r2)', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli', 'claude', undefined, false);
    fake.attention.workers = [worker('w-eli', 'Eli')];
    fake.screens.set('term_eli', { tail: CLAUDE_UNKNOWN_QUIET }); // empty prompt, quiet, unclassified chrome
    const out = poll(c);
    expect(out.nudged).toEqual([]);
    expect(out.held.Eli).toContain('unknown idle state');
    expect(out.held.Eli).toContain('unrecognized chrome');
    expect(fake.sent).toEqual([]);
  });

  it('a MINIMAL screen (prompt box only, nothing above) is MISSING liveness evidence and holds (#1700 P2 r3)', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli', 'claude', undefined, false);
    fake.attention.workers = [worker('w-eli', 'Eli')];
    fake.screens.set('term_eli', { tail: [RULE, '❯ ', RULE, CLAUDE_HINT] }); // Diego's truncated-tail counterexample
    const out = poll(c);
    expect(out.nudged).toEqual([]);
    expect(out.held.Eli).toContain('unknown idle state');
    expect(out.held.Eli).toContain('no positive liveness evidence');
    expect(fake.sent).toEqual([]);
  });

  it('a HISTORICAL done-marker does not rescue a newer unrecognized status — holds as unknown (#1700 P2 r3)', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli', 'claude', undefined, false);
    fake.attention.workers = [worker('w-eli', 'Eli')];
    // Diego's counterexample: old completion text above an unexplained current status line.
    fake.screens.set('term_eli', { tail: ['⏺ Done.', 'an unrecognized current status', RULE, '❯ ', RULE, CLAUDE_HINT] });
    const out = poll(c);
    expect(out.nudged).toEqual([]);
    expect(out.held.Eli).toContain('unknown idle state');
    expect(out.held.Eli).toContain('unrecognized chrome');
    expect(fake.sent).toEqual([]);
  });

  it('a completed Codex turn whose ↳ Recap tail trails the Worked-for footer DELIVERS — the recap is the marker’s own chrome (#1968, Diego captured 2026-10-15)', () => {
    const c = cfg(['w-diego', 'Diego']);
    fake.terminal('diego', 'codex', undefined, false);
    fake.attention.workers = [worker('w-diego', 'Diego')];
    fake.screens.set('term_diego', { tail: CODEX_IDLE_RECAP_DIEGO }); // marker 10 lines above the prompt
    const out = poll(c);
    expect(out).toMatchObject({ nudged: ['Diego'], adopted: true });
  });

  it('a Worked-for footer 11 lines above the prompt is INSIDE the deepened window and delivers (#1968, Gene captured 2026-10-15)', () => {
    const c = cfg(['w-gene', 'Gene']);
    fake.terminal('gene', 'codex', undefined, false);
    fake.attention.workers = [worker('w-gene', 'Gene')];
    fake.screens.set('term_gene', { tail: CODEX_IDLE_RECAP_GENE });
    const out = poll(c);
    expect(out).toMatchObject({ nudged: ['Gene'], adopted: true });
  });

  it('a recap tail over an in-window Worked-for footer is skipped like trailing banner chrome and delivers (#1968, Xavier captured 2026-10-15)', () => {
    const c = cfg(['w-xavier', 'Xavier']);
    fake.terminal('xavier', 'codex', undefined, false);
    fake.attention.workers = [worker('w-xavier', 'Xavier')];
    fake.screens.set('term_xavier', { tail: CODEX_IDLE_RECAP_XAVIER }); // marker 6 above, recap positionally newest
    const out = poll(c);
    expect(out).toMatchObject({ nudged: ['Xavier'], adopted: true });
  });

  it('a folded-URL receipt pushing Worked-for past the old 8-line fold still delivers — depth 16 reaches the footer (#1968, Atilla’s canonical shape)', () => {
    const c = cfg(['w-atilla', 'Atilla']);
    fake.terminal('atilla', 'codex', undefined, false);
    fake.attention.workers = [worker('w-atilla', 'Atilla')];
    fake.screens.set('term_atilla', { tail: CODEX_IDLE_URL_RECEIPT }); // marker 9 above the prompt
    const out = poll(c);
    expect(out).toMatchObject({ nudged: ['Atilla'], adopted: true });
  });

  it('a deep-indented tail with NO idle marker anywhere on screen still HOLDS — the recap skip never substitutes for a marker (#1968)', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli', 'codex', undefined, false);
    fake.attention.workers = [worker('w-eli', 'Eli')];
    fake.screens.set('term_eli', { tail: CODEX_UNKNOWN_INDENT_NO_MARKER });
    const out = poll(c);
    expect(out.nudged).toEqual([]);
    expect(out.held.Eli).toContain('unrecognized chrome');
    expect(fake.sent).toEqual([]);
  });

  it('a deep indent with NO recap header is a current status — an old Worked-for marker must NOT prove idle over it (Andi P2, #1976 review)', () => {
    const c = cfg(['w-andi', 'Andi']);
    fake.terminal('andi', 'codex', undefined, false);
    fake.attention.workers = [worker('w-andi', 'Andi')];
    fake.screens.set('term_andi', { tail: CODEX_UNKNOWN_INDENTED_STATUS_NO_HEADER });
    const out = poll(c);
    expect(out.nudged).toEqual([]);
    expect(out.held.Andi).toContain('unrecognized chrome');
    expect(fake.sent).toEqual([]);
  });

  it('the background-terminals status line trails a Worked-for footer and DELIVERS (Greta, held 7.5 h as unknown, 2026-10-21)', () => {
    const c = cfg(['w-greta', 'Greta']);
    fake.terminal('greta', 'codex', undefined, false);
    fake.attention.workers = [worker('w-greta', 'Greta')];
    fake.screens.set('term_greta', { tail: CODEX_IDLE_BACKGROUND_GRETA });
    const out = poll(c);
    expect(out).toMatchObject({ nudged: ['Greta'], adopted: true });
  });

  it('the background-terminals line alone is weak: with no completed-turn marker the window still holds', () => {
    const c = cfg(['w-greta', 'Greta']);
    fake.terminal('greta', 'codex', undefined, false);
    fake.attention.workers = [worker('w-greta', 'Greta')];
    fake.screens.set('term_greta', { tail: ['  2 background terminals running · /ps to view · /stop to close', ...CODEX_IDLE_BACKGROUND_GRETA.slice(4)] });
    const out = poll(c);
    expect(out.nudged).toEqual([]);
    expect(out.held.Greta).toContain('no positive liveness evidence');
    expect(fake.sent).toEqual([]);
  });

  it('a running turn beside the background-terminals line is still busy', () => {
    const c = cfg(['w-greta', 'Greta']);
    fake.terminal('greta', 'codex', undefined, false);
    fake.attention.workers = [worker('w-greta', 'Greta')];
    fake.screens.set('term_greta', {
      tail: [...CODEX_IDLE_BACKGROUND_GRETA.slice(0, 3), '• Working (6s • esc to interrupt)', ...CODEX_IDLE_BACKGROUND_GRETA.slice(3)],
    });
    const out = poll(c);
    expect(out.nudged).toEqual([]);
    expect(fake.sent).toEqual([]);
  });

  it('an unindented current status over an old Worked-for marker holds — the codex arm of the #1700 r3 counterexample (Andi control, #1976 review)', () => {
    const c = cfg(['w-andi', 'Andi']);
    fake.terminal('andi', 'codex', undefined, false);
    fake.attention.workers = [worker('w-andi', 'Andi')];
    fake.screens.set('term_andi', { tail: CODEX_UNKNOWN_STATUS_NO_RECAP });
    const out = poll(c);
    expect(out.nudged).toEqual([]);
    expect(out.held.Andi).toContain('unrecognized chrome');
    expect(fake.sent).toEqual([]);
  });

  it('a Claude recap block (header 2, continuation 4) trails its done-marker and DELIVERS — header-RELATIVE indent covers both families (#1977, Yuri captured 2026-10-15)', () => {
    const c = cfg(['w-yuri', 'Yuri']);
    fake.terminal('yuri', 'claude', undefined, false);
    fake.attention.workers = [worker('w-yuri', 'Yuri')];
    fake.screens.set('term_yuri', { tail: CLAUDE_IDLE_RECAP_YURI });
    const out = poll(c);
    expect(out).toMatchObject({ nudged: ['Yuri'], adopted: true });
  });

  it('4-indent output under a done-marker with NO recap header is unrecognized and HOLDS — the rule never skips without an anchor (#1977 counterexample)', () => {
    const c = cfg(['w-yuri', 'Yuri']);
    fake.terminal('yuri', 'claude', undefined, false);
    fake.attention.workers = [worker('w-yuri', 'Yuri')];
    fake.screens.set('term_yuri', { tail: CLAUDE_UNKNOWN_CODEBLOCK_NO_HEADER });
    const out = poll(c);
    expect(out.nudged).toEqual([]);
    expect(out.held.Yuri).toContain('unrecognized chrome');
    expect(fake.sent).toEqual([]);
  });

  it('a content-suppressed turn (notice box, NO Worked-for footer) is completed chrome and DELIVERS (#1983, Riana captured 2026-10-15)', () => {
    const c = cfg(['w-riana', 'Riana']);
    fake.terminal('riana', 'codex', undefined, false);
    fake.attention.workers = [worker('w-riana', 'Riana')];
    fake.screens.set('term_riana', { tail: CODEX_IDLE_NOTICE_RIANA });
    const out = poll(c);
    expect(out).toMatchObject({ nudged: ['Riana'], adopted: true });
  });

  it('a suppressed turn with NO output at all — └ (no output) + the notice — DELIVERS (#1983, Chip captured 2026-10-15)', () => {
    const c = cfg(['w-chip', 'Chip']);
    fake.terminal('chip', 'codex', undefined, false);
    fake.attention.workers = [worker('w-chip', 'Chip')];
    fake.screens.set('term_chip', { tail: CODEX_IDLE_NOTICE_CHIP });
    const out = poll(c);
    expect(out).toMatchObject({ nudged: ['Chip'], adopted: true });
  });

  it('a pinned busy line ABOVE a notice box still wins — the sweep runs before the marker judgment (#1983)', () => {
    const c = cfg(['w-chip', 'Chip']);
    fake.terminal('chip', 'codex', undefined, false);
    fake.attention.workers = [worker('w-chip', 'Chip')];
    fake.screens.set('term_chip', {
      // the notice header is at index 2 and the prompt at 7: insert the busy
      // line directly above the placeholder
      tail: [...CODEX_IDLE_NOTICE_CHIP.slice(0, 7), '  • Working (6s • esc to interrupt)', ...CODEX_IDLE_NOTICE_CHIP.slice(7)],
    });
    const out = poll(c);
    expect(out.nudged).toEqual([]);
    expect(out.held.Chip).toContain('a running turn is drawn above the prompt');
    expect(fake.sent).toEqual([]);
  });

  it('a newer SAME-INDENT unknown status after a RECAP header is judged, not swallowed — holds (Andi P2, #1985 review)', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli', 'codex', undefined, false);
    fake.attention.workers = [worker('w-eli', 'Eli')];
    fake.screens.set('term_eli', {
      tail: [
        '  Worked for 1m 4s • 4:04 PM',
        '  ↳ Recap: The task is to read Hadron team chat unfiltered,',
        '            mentions, and mark it read.',
        '  an unrecognized current status at the header indent',
        '› Ask Codex to do anything',
        '  GPT-6.1-Sol default · ~/orca/workspaces/hadron-server/andi · Static review…',
        '  ? for shortcuts',
      ],
    });
    const out = poll(c);
    expect(out.nudged).toEqual([]);
    expect(out.held.Eli).toContain('unrecognized chrome');
    expect(fake.sent).toEqual([]);
  });

  it('a newer SAME-INDENT unknown status after the NOTICE header is judged, not swallowed — holds (Andi P2, #1985 review)', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli', 'codex', undefined, false);
    fake.attention.workers = [worker('w-eli', 'Eli')];
    fake.screens.set('term_eli', {
      tail: [
        '  ⓘ This content can’t be shown',
        '  We take extra care with some cybersecurity requests.',
        '  an unrecognized current status at the header indent',
        '› Ask Codex to do anything',
        '  GPT-6.1-Sol default · ~/orca/workspaces/hadron-server/andi · Static review…',
        '  ? for shortcuts',
      ],
    });
    const out = poll(c);
    expect(out.nudged).toEqual([]);
    expect(out.held.Eli).toContain('unrecognized chrome');
    expect(fake.sent).toEqual([]);
  });

  it('a BARE Learn-more URL with no notice above is ordinary output and HOLDS (Andi delta P2, #1985 review round 2)', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli', 'codex', undefined, false);
    fake.attention.workers = [worker('w-eli', 'Eli')];
    fake.screens.set('term_eli', {
      tail: [
        '  Worked for 2m 6s • 16:32',
        '  Learn more: https://example.com/documentation',
        '› Ask Codex to do anything',
        '  GPT-6.1-Sol default · ~/orca/workspaces/hadron-server/andi · Static review…',
        '  ? for shortcuts',
      ],
    });
    const out = poll(c);
    expect(out.nudged).toEqual([]);
    expect(out.held.Eli).toContain('unrecognized chrome');
    expect(fake.sent).toEqual([]);
  });

  it('a BARE Apply label with no notice above is ordinary output and HOLDS (Andi delta P2, #1985 review round 2)', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli', 'codex', undefined, false);
    fake.attention.workers = [worker('w-eli', 'Eli')];
    fake.screens.set('term_eli', {
      tail: [
        '  Worked for 2m 6s • 16:32',
        '  Apply for Daybreak: https://openai.com/form/enterprise-trusted-access/',
        '› Ask Codex to do anything',
        '  GPT-6.1-Sol default · ~/orca/workspaces/hadron-server/andi · Static review…',
        '  ? for shortcuts',
      ],
    });
    const out = poll(c);
    expect(out.nudged).toEqual([]);
    expect(out.held.Eli).toContain('unrecognized chrome');
    expect(fake.sent).toEqual([]);
  });

  it('a BARE wrapped notice URL fragment with no notice above HOLDS (Andi delta P2, #1985 review round 2)', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli', 'codex', undefined, false);
    fake.attention.workers = [worker('w-eli', 'Eli')];
    fake.screens.set('term_eli', {
      tail: [
        '  Worked for 2m 6s • 16:32',
        '  openai.com/form/enterprise-trusted-access-for-cyber/',
        '› Ask Codex to do anything',
        '  GPT-6.1-Sol default · ~/orca/workspaces/hadron-server/andi · Static review…',
        '  ? for shortcuts',
      ],
    });
    const out = poll(c);
    expect(out.nudged).toEqual([]);
    expect(out.held.Eli).toContain('unrecognized chrome');
    expect(fake.sent).toEqual([]);
  });

  it('a status line BETWEEN the notice header and its body ends the block — the status is judged and HOLDS (nothing newer in between, #12876)', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli', 'codex', undefined, false);
    fake.attention.workers = [worker('w-eli', 'Eli')];
    fake.screens.set('term_eli', {
      tail: [
        '  ⓘ This content can’t be shown',
        '  an unrecognized current status arrived after the header',
        '  Learn more: https://help.openai.com/en/articles/20001326',
        '› Ask Codex to do anything',
        '  GPT-6.1-Sol default · ~/orca/workspaces/hadron-server/andi · Static review…',
        '  ? for shortcuts',
      ],
    });
    const out = poll(c);
    expect(out.nudged).toEqual([]);
    expect(out.held.Eli).toContain('unrecognized chrome');
    expect(fake.sent).toEqual([]);
  });

  it('a pinned busy line ABOVE a recap tail still wins — the sweep runs before the positional judgment (#1968)', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli', 'codex', undefined, false);
    fake.attention.workers = [worker('w-eli', 'Eli')];
    fake.screens.set('term_eli', {
      tail: [...CODEX_IDLE_RECAP_XAVIER.slice(0, 9), '  • Working (6s • esc to interrupt)', ...CODEX_IDLE_RECAP_XAVIER.slice(9)],
    });
    const out = poll(c);
    expect(out.nudged).toEqual([]);
    expect(out.held.Eli).toContain('a running turn is drawn above the prompt');
    expect(fake.sent).toEqual([]);
  });

  it('a COLUMN-ZERO status line after a recap block ends the block and is judged — no throw, unrecognized holds (Andi round 2, #1976 review)', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli', 'codex', undefined, false);
    fake.attention.workers = [worker('w-eli', 'Eli')];
    fake.screens.set('term_eli', {
      // A previous turn's recap, then a column-zero unrecognized current
      // status: the extension must END at indent 0, not dereference null.
      tail: [...CODEX_IDLE_RECAP_XAVIER.slice(0, 9), 'a column-zero current status nobody classified', ...CODEX_IDLE_RECAP_XAVIER.slice(9)],
    });
    const out = poll(c);
    expect(out.nudged).toEqual([]);
    expect(out.held.Eli).toContain('unrecognized chrome');
    expect(fake.sent).toEqual([]);
  });

  it('a COLUMN-ZERO known busy line after a recap block is caught by the sweep — busy wins, no throw (Chip runtime matrix, #1976 review)', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli', 'codex', undefined, false);
    fake.attention.workers = [worker('w-eli', 'Eli')];
    fake.screens.set('term_eli', {
      tail: [...CODEX_IDLE_RECAP_XAVIER.slice(0, 9), '• Working (6s • esc to interrupt)', ...CODEX_IDLE_RECAP_XAVIER.slice(9)],
    });
    const out = poll(c);
    expect(out.nudged).toEqual([]);
    expect(out.held.Eli).toContain('a running turn is drawn above the prompt');
    expect(fake.sent).toEqual([]);
  });

  it('a REAL idle screen — ordinary output text above the done-marker — DELIVERS (production calibration, #8165)', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli', 'claude', undefined, false);
    fake.attention.workers = [worker('w-eli', 'Eli')];
    fake.screens.set('term_eli', { tail: CLAUDE_IDLE_REAL_XAN }); // captured live (Xan, 2026-10-11)
    const out = poll(c);
    expect(out).toMatchObject({ nudged: ['Eli'], adopted: true });
  });

  it('a REAL idle screen with an update banner after the done-marker DELIVERS (#8165)', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli', 'claude', undefined, false);
    fake.attention.workers = [worker('w-eli', 'Eli')];
    fake.screens.set('term_eli', { tail: CLAUDE_IDLE_REAL_LIAM }); // captured live (Liam, 2026-10-11)
    const out = poll(c);
    expect(out).toMatchObject({ nudged: ['Eli'], adopted: true });
  });

  it('prose containing the word compacted is NOT the banner - holds as unknown (#1746 P2)', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli', 'claude', undefined, false);
    fake.attention.workers = [worker('w-eli', 'Eli')];
    // Diego's counterexample: an output-text line mentioning compaction is not the banner.
    fake.screens.set('term_eli', { tail: ['  the router compacted several workers overnight', RULE, '❯ ', RULE, CLAUDE_HINT] });
    const out = poll(c);
    expect(out.nudged).toEqual([]);
    expect(out.held.Eli).toContain('unrecognized chrome');
    expect(fake.sent).toEqual([]);
  });

  it('a Compacted-while-idle banner is positive idle chrome (#8165)', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli', 'claude', undefined, false);
    fake.attention.workers = [worker('w-eli', 'Eli')];
    fake.screens.set('term_eli', { tail: CLAUDE_IDLE_COMPACTED });
    const out = poll(c);
    expect(out).toMatchObject({ nudged: ['Eli'], adopted: true });
  });
});

describe('nudgeText read anchor (#1805 P2s, #1811 large-gap branch)', () => {
  it('present anchor: names the first unread, BOTH forms, bounded — no --all', () => {
    const t = nudgeText(worker('w-eli', 'Eli', { mentions: 2, unread: 5, first: 100, relevant: 110, head: 120 }));
    expect(t).toContain('START AT #100 (your first unread message of any kind)');
    expect(t).toContain('--since 99 --limit 200');
    expect(t).toContain('nextSince');
    expect(t).toContain('hadron_team_chat_read');
    expect(t).toContain('sinceSeq=99');
    expect(t).not.toContain('--all');
    expect(t).not.toContain('\n');
  });
  it('null anchor (defensive): no firstUnreadSeq means the old generic text, no START clause, no mentions walk', () => {
    const t = nudgeText({ worker: 'w-eli', workerName: 'Eli', channel: CHANNEL, unread: 3, unreadMentions: 1, firstUnreadSeq: null, lastRelevantSeq: 110, lastSeq: 120 });
    expect(t).not.toContain('START AT');
    expect(t).toContain('Read team chat unfiltered');
    expect(t).not.toContain('--mentions-me');
  });
  it('first unread 1, SMALL span (cursor-0 worker near the head): since clamps to 0, still bounded', () => {
    const t = nudgeText(worker('w-eli', 'Eli', { mentions: 2, unread: 349, first: 1, relevant: 110, head: 350 }));
    expect(t).toContain('--since 0 --limit 200');
    expect(t).toContain('sinceSeq=0');
    expect(t).not.toContain('--all');
    expect(t).not.toContain('--mentions-me');
  });
  it('cursor-0 worker with a LARGE gap: the mentions walk starts at 0 too — clamped, filtered, bounded (#1811)', () => {
    const t = nudgeText(worker('w-eli', 'Eli', { mentions: 2, unread: 9000, first: 1, relevant: 110, head: 9001 }));
    expect(t).toContain('--mentions-me --since 0 --before 9002 --limit 200');
    expect(t).toContain('sinceSeq=0');
    expect(t).toContain('beforeSeq=9002');
    expect(t).not.toContain('--all');
    expect(t).not.toContain('START AT');
  });
  it('LARGE GAP (span > 400): mentions-only anchor — filter, both forms, own-session mark ceiling, failure discipline (#1811)', () => {
    const t = nudgeText(worker('w-eli', 'Eli', { mentions: 2, unread: 9841, first: 61, relevant: 9750, head: 9901 }));
    expect(t).toContain('LARGE GAP');
    expect(t).toContain('unread #61–#9901, latest mention #9750');
    expect(t).toContain('--mentions-me --since 60 --before 9902 --limit 200');
    expect(t).toContain('sinceSeq=60');
    expect(t).toContain('hadron_team_chat_read');
    expect(t).toContain('mark-read --through');
    expect(t).toContain('hadron_team_chat_mark_read');
    expect(t).toContain('never auto-marks');
    expect(t).toContain('marks NOTHING');
    expect(t).toContain('your OWN session');
    expect(t).not.toContain('START AT');
    expect(t).not.toContain('Read team chat unfiltered');
    expect(t).not.toContain('--all');
    expect(t).not.toContain('\n');
  });
  it('a mention arriving mid-walk stays outside the FROZEN sample: every page is bounded at the head the nudge named (#1827 P2)', () => {
    // Anne's counterexample: page 1 samples head 9901; a mention posted at
    // 9902 during the walk must not enter any later page, and the mark must
    // never reach it. The walk's upper bound is the nudge's OWN head value.
    const t = nudgeText(worker('w-eli', 'Eli', { mentions: 2, unread: 9841, first: 61, relevant: 9750, head: 9901 }));
    expect(t).toContain('--before 9902');
    expect(t).toContain('beforeSeq=9902');
    expect(t).toContain('never above #9901');
    expect(t).toContain('actually delivered');
    expect(t).not.toContain('--before 9903');
  });
  it('MORE than one page of mentions incl. the OLDEST: the walk runs BACKWARD via prevBefore — beforeSeq selects the newest page under the bound (#1827 cycle-1 P2)', () => {
    // Anne's trace + Colin's live control (#9687/#9689): beforeSeq forces
    // NEWEST-page selection, so a forward nextSince walk with 201 unread
    // mentions returns 2..201, an empty next page, and a mark that
    // acknowledges the unseen oldest #1. The instruction must walk BACKWARD
    // (prevBefore, decreasing beforeSeq) down to the fixed since floor —
    // Colin's control returned all 201 that way, excluding the H+1 arrival.
    const t = nudgeText(worker('w-eli', 'Eli', { mentions: 201, unread: 9841, first: 61, relevant: 9750, head: 9901 }));
    expect(t).toContain('prevBefore');
    expect(t).toContain('BACKWARD');
    expect(t).not.toContain('nextSince'); // the forward cursor is what lost the oldest mention
    expect(t).toContain('--mentions-me --since 60 --before 9902 --limit 200');
    expect(t).toContain('sinceSeq=60');
    expect(t).toContain('beforeSeq=9902');
    expect(t).toContain('never above #9901'); // the H+1 arrival stays outside sample and mark
    expect(t).not.toContain('--before 9903');
    // The MCP tool returns numbered pages with NO prevBefore field (Anne and
    // Colin, independently): its instruction must say to re-call with
    // beforeSeq = the smallest seq on the last page, not "follow prevBefore".
    expect(t).toContain('the smallest seq on your last page');
    expect(t).toContain('no prevBefore field');
    expect(t).toContain('limit 200'); // the MCP page limit spelled with its value
  });
  it('the boundary is deterministic: span 399 and exactly 400 keep the unfiltered anchor, 401 switches (#1811)', () => {
    for (const head of [499, 500]) {
      const t = nudgeText(worker('w-eli', 'Eli', { first: 100, head }));
      expect(t).toContain('START AT #100');
      expect(t).not.toContain('--mentions-me');
    }
    expect(nudgeText(worker('w-eli', 'Eli', { first: 100, head: 501 }))).toContain('--mentions-me');
  });
});

describe('Orca attention router — fresh counts at send time (#1616)', () => {
  it('drops the nudge when the worker read its chat while the nudge waited out the gates', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli');
    fake.attention.workers = [worker('w-eli', 'Eli', { mentions: 2, unread: 5, relevant: 110 })];
    fake.fresh = [worker('w-eli', 'Eli', { mentions: 0, unread: 0, relevant: null })];
    const out = poll(c);
    expect(out).toMatchObject({ nudged: [], dropped: ['Eli'], adopted: true });
    expect(fake.sent).toEqual([]);
    expect(describeOutcome(out)).toContain('dropped (read while waiting): Eli');
  });

  it('a dropped frontier is recorded covered, so a held token does not re-run the gates for it', () => {
    const c = cfg(['w-eli', 'Eli'], ['w-baloo', 'Baloo']);
    fake.terminal('eli');
    fake.terminal('baloo');
    fake.busy.add('term_baloo');
    fake.screens.set('term_baloo', { tail: CLAUDE_BUSY_EMPTY });
    fake.screens.set('term_baloo', { tail: CLAUDE_BUSY_EMPTY });
    fake.attention.workers = [worker('w-eli', 'Eli', { relevant: 110 }), worker('w-baloo', 'Baloo')];
    fake.fresh = [worker('w-baloo', 'Baloo')]; // Eli read its chat; Baloo still has its mention
    const first = poll(c);
    expect(first).toMatchObject({ dropped: ['Eli'] });
    expect(first.held.Baloo).toBeTruthy();
    expect(new State(c.stateDir).ledger().nudged['w-eli'].relevantSeq).toBe(110);
    fake.fresh = null; // from here the fresh scan mirrors the poll rows
    const second = poll(c);
    expect(second.covered).toContain('Eli'); // answered by the ledger, not the gates
    expect(second.nudged).toEqual([]);       // Baloo is still busy
    expect(fake.freshServed).toBe(1);        // Eli's drop consumed the only fresh scan so far
  });

  it('sends FRESH counts and records the fresh mention frontier, never the stale poll numbers', () => {
    const c = cfg(['w-eli', 'Eli'], ['w-baloo', 'Baloo']);
    fake.terminal('eli');
    fake.terminal('baloo');
    fake.busy.add('term_baloo');
    fake.screens.set('term_baloo', { tail: CLAUDE_BUSY_EMPTY });
    fake.screens.set('term_baloo', { tail: CLAUDE_BUSY_EMPTY }); fake.screens.set('term_baloo', { tail: CLAUDE_BUSY_EMPTY }); // hold the token so the ledger's base (and its rows) survive to be read
    fake.attention.workers = [worker('w-eli', 'Eli', { mentions: 2, unread: 5, relevant: 110, head: 120 }), worker('w-baloo', 'Baloo')];
    fake.fresh = [worker('w-eli', 'Eli', { mentions: 3, unread: 9, relevant: 118, head: 121 })];
    const out = poll(c);
    expect(out).toMatchObject({ nudged: ['Eli'] });
    expect(out.held.Baloo).toBeTruthy();
    expect(fake.sent[0][1]).toContain('9 relevant unread (3 mentions');
    expect(fake.sent[0][1]).toContain('unread #100–#121');
    expect(fake.sent[0][1]).toContain('latest mention #118');
    expect(fake.sent[0][1]).not.toContain('5 relevant unread');
    expect(new State(c.stateDir).ledger().nudged['w-eli'].relevantSeq).toBe(118);
    expect(adopted(c)).toBeNull(); // held, and the fresh scan's own token is never adopted
  });

  it('a failed fresh scan fails the poll without sending; the token is unchanged', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli');
    fake.attention.workers = [worker('w-eli', 'Eli')];
    fake.freshOk = false;
    expect(() => poll(c)).toThrow(RouterError);
    expect(fake.sent).toEqual([]);
    expect(adopted(c)).toBeNull();
  });

  it('any Orca draft pins a Claude worker: Orca blanks the box, so the screen cannot refute it (cli#907 c02/c09)', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli');
    fake.attention.workers = [worker('w-eli', 'Eli', { mentions: 1, unread: 2, relevant: 110 })];
    fake.screens.set('term_eli', { tail: CLAUDE_IDLE, draft: 'SCRATCH-907 draft probe one' });
    const out = poll(c);
    expect(out.nudged).toEqual([]);
    expect(out.held.Eli).toContain('text in the composer draft');
    expect(fake.sent).toEqual([]);
    expect(logs.join('\n')).not.toContain('SCRATCH-907'); // the draft's text is never logged
  });

  it('a Codex draft stays authoritative: its composer renders empty while text is pending', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli', 'codex');
    fake.attention.workers = [worker('w-eli', 'Eli', { mentions: 1, unread: 2, relevant: 110 })];
    fake.screens.set('term_eli', { tail: CODEX_IDLE, draft: 'pending codex text' });
    const out = poll(c);
    expect(out.nudged).toEqual([]);
    expect(out.held.Eli).toContain('text in the composer draft');
    expect(fake.sent).toEqual([]);
  });

  it('logs a long hold: pinned 30+ minutes with mentions pending says so, at most every 30 minutes (#6736)', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli');
    fake.busy.add('term_eli');
    fake.screens.set('term_eli', { tail: CLAUDE_BUSY_EMPTY });
    fake.attention.workers = [worker('w-eli', 'Eli')];
    poll(c); // held: busy
    const st = new State(c.stateDir);
    const ledger = st.ledger();
    ledger.heldSince['w-eli'] = Date.now() - 41 * 60_000; // backdate the hold
    st.saveLedger(ledger);
    logs.length = 0;
    poll(c);
    expect(logs.join('\n')).toMatch(/Eli held 4[01] min with mentions pending \(a running turn/);
    logs.length = 0;
    poll(c); // within 30 min of the last long-hold line: silent
    expect(logs.join('\n')).not.toMatch(/held \d+ min/);
  });

  it('re-proves the prompt empty after the recompute: typing during the scan holds, not sends', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli');
    fake.attention.workers = [worker('w-eli', 'Eli', { mentions: 1, unread: 2, relevant: 110 })];
    // The recompute's round trip reopened the #5473 window; a human started
    // typing in it — and Claude RENDERS the text, so the draft is corroborated.
    fake.recheckScreens.set('term_eli', { tail: withPrompt(CLAUDE_IDLE, '❯', 'Holger typing here'), draft: 'Holger typing here' });
    const out = poll(c);
    expect(out.nudged).toEqual([]);
    expect(out.held.Eli).toContain('prompt not empty on recheck');
    expect(fake.sent).toEqual([]);
    expect(adopted(c)).toBeNull();
    expect(logs.join('\n')).not.toContain('Holger typing here'); // the reason never quotes the text
  });

  it('re-proves IDLE after the recompute: a busy agent renders an empty prompt box, so the screen alone cannot catch it', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli');
    fake.attention.workers = [worker('w-eli', 'Eli', { mentions: 1, unread: 2, relevant: 110 })];
    fake.busyRecheck.add('term_eli'); // the agent went busy during the fresh scan
    fake.recheckScreens.set('term_eli', { tail: CLAUDE_BUSY_EMPTY }); // #1845: busy needs the live indicator on screen
    const out = poll(c);
    expect(out.nudged).toEqual([]);
    expect(out.held.Eli).toContain('busy again after the recompute');
    expect(fake.sent).toEqual([]);
    expect(adopted(c)).toBeNull();
  });

  // Charles's QA probe (receipt on the PR), pinned per Xan's ruling #6495: the
  // fake ignores --timeout-ms, so without this a full busy-wait at the recheck
  // — the exact behavior Atilla's second P2 killed — survives the whole suite.
  it('waits busyWaitMs at the gate, but only a short bounded timeout at the recheck', () => {
    const c = { ...cfg(['w-eli', 'Eli']), busyWaitMs: 90_000 };
    fake.terminal('eli');
    fake.attention.workers = [worker('w-eli', 'Eli')];
    expect(poll(c)).toMatchObject({ nudged: ['Eli'] });
    const waits = fake.calls.filter((a) => a.slice(1, 3).join(' ') === 'terminal wait');
    const ms = (a: string[]) => Number(a[a.indexOf('--timeout-ms') + 1]);
    expect(waits).toHaveLength(2);
    expect(ms(waits[0])).toBe(90_000);
    expect(ms(waits[1])).toBeLessThanOrEqual(1_000);
  });

  it('adoption carries a nudge whose frontier postdates the token: no duplicate nudge next poll (blind-review P2, first head)', () => {
    const c = cfg(['w-eli', 'Eli'], ['w-baloo', 'Baloo']);
    fake.terminal('eli');
    fake.terminal('baloo');
    // Main scan: Eli's mention at 110, Baloo's at 115. Fresh scan, reading
    // later: Eli's has moved to 125; Baloo's is unchanged.
    fake.attention.workers = [worker('w-eli', 'Eli', { relevant: 110 }), worker('w-baloo', 'Baloo', { relevant: 115 })];
    fake.fresh = [worker('w-eli', 'Eli', { relevant: 125 }), worker('w-baloo', 'Baloo', { relevant: 115 })];
    const first = poll(c);
    expect(first).toMatchObject({ nudged: ['Eli', 'Baloo'], adopted: true });
    expect(fake.sent[0][1]).toContain('latest mention #125');
    // Only Eli's record outlives the adopted token (125 above its 110
    // horizon); Baloo's 115 equals its horizon, so the token covers it.
    expect(Object.keys(new State(c.stateDir).ledger().nudged)).toEqual(['w-eli']);
    // The server lists Eli again next poll: 125 postdates the token's horizon.
    fake.attention.workers = [worker('w-eli', 'Eli', { relevant: 125 })];
    fake.fresh = null;
    const second = poll(c);
    expect(second.covered).toEqual(['Eli']);
    expect(second.nudged).toEqual([]);
    expect(fake.sent).toHaveLength(2); // no re-send: Eli answered from the carried record
  });
});

describe('Orca attention router — busy: never typed into; hold the token', () => {
  it('holds the token for a busy worker, then nudges only it once idle', () => {
    const c = cfg(['w-eli', 'Eli'], ['w-baloo', 'Baloo']);
    fake.terminal('eli');
    fake.terminal('baloo', 'codex');
    fake.busy.add('term_baloo');
    fake.screens.set('term_baloo', { tail: CODEX_BUSY_EMPTY });
    fake.attention.workers = [worker('w-eli', 'Eli'), worker('w-baloo', 'Baloo')];
    let out = poll(c);
    expect(out.nudged).toEqual(['Eli']);
    expect(Object.keys(out.held)).toEqual(['Baloo']);
    expect(out.adopted).toBe(false);
    expect(adopted(c)).toBeNull();
    expect(sentHandles()).toEqual(['term_eli']);

    fake.busy.clear();
    out = poll(c);
    expect(out).toMatchObject({ covered: ['Eli'], nudged: ['Baloo'], adopted: true });
    expect(sentHandles()).toEqual(['term_eli', 'term_baloo']);
  });

  it('a held token does not re-nudge a worker whose latest mention is unchanged', () => {
    const c = cfg(['w-eli', 'Eli'], ['w-baloo', 'Baloo']);
    fake.terminal('eli');
    fake.terminal('baloo');
    fake.busy.add('term_baloo');
    fake.screens.set('term_baloo', { tail: CLAUDE_BUSY_EMPTY });
    fake.screens.set('term_baloo', { tail: CLAUDE_BUSY_EMPTY });
    fake.attention.workers = [worker('w-eli', 'Eli', { relevant: 110 }), worker('w-baloo', 'Baloo')];
    poll(c);
    // Unrelated chat moved the head; Eli's latest mention is still 110.
    fake.attention.workers = [worker('w-eli', 'Eli', { relevant: 110, head: 140 }), worker('w-baloo', 'Baloo')];
    expect(poll(c).covered).toEqual(['Eli']);
    expect(sentHandles()).toEqual(['term_eli']);
  });

  it('a NEW mention re-nudges even when the worker left older unrelated chat unread (@codex P1, #1490)', () => {
    const c = cfg(['w-eli', 'Eli'], ['w-baloo', 'Baloo']);
    fake.terminal('eli');
    fake.terminal('baloo');
    fake.busy.add('term_baloo');
    fake.screens.set('term_baloo', { tail: CLAUDE_BUSY_EMPTY });
    fake.screens.set('term_baloo', { tail: CLAUDE_BUSY_EMPTY });
    fake.attention.workers = [worker('w-eli', 'Eli', { first: 100, relevant: 110, head: 120 }), worker('w-baloo', 'Baloo')];
    poll(c);
    // Eli read only its mention: firstUnreadSeq is still 100 (at or below the old head),
    // and a new mention arrived at 125. The first version called this covered.
    fake.attention.workers = [worker('w-eli', 'Eli', { first: 100, relevant: 125, head: 130 }), worker('w-baloo', 'Baloo')];
    expect(poll(c).nudged).toEqual(['Eli']);
    expect(sentHandles()).toEqual(['term_eli', 'term_eli']);
  });

  it('an accepted nudge is persisted at once: a later failure in the same poll cannot resend it (@codex P2, #1490)', () => {
    const c = cfg(['w-eli', 'Eli'], ['w-baloo', 'Baloo']);
    fake.terminal('eli');
    fake.terminal('baloo');
    fake.registerFails.add('w-baloo'); // Baloo's check throws AFTER Eli was nudged
    fake.attention.workers = [worker('w-eli', 'Eli'), worker('w-baloo', 'Baloo')];
    expect(() => poll(c)).toThrow(RouterError);
    expect(sentHandles()).toEqual(['term_eli']);
    fake.registerFails.clear();
    const out = poll(c);
    expect(out).toMatchObject({ covered: ['Eli'], nudged: ['Baloo'], adopted: true });
    expect(sentHandles()).toEqual(['term_eli', 'term_baloo']);
  });

  it('drains every page and adopts only the final page\'s token', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli');
    fake.pages = 3;
    fake.attention.workers = [worker('w-eli', 'Eli')];
    expect(poll(c)).toMatchObject({ nudged: ['Eli'], adopted: true });
    // 3 main-scan pages + the single-page fresh re-read before the send (#1616).
    expect(fake.calls.filter((a) => a[1] === 'api' && a[2].includes('teamAttentionPage'))).toHaveLength(4);
    expect(fake.freshServed).toBe(1);
    expect(adopted(c)).toBe(TOKEN_1);
  });

  it('a final page that reports an incomplete scan is refused, even carrying a token', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli');
    fake.incompleteFinal = true;
    fake.attention.workers = [worker('w-eli', 'Eli')];
    expect(() => poll(c)).toThrow(RouterError);
    expect(adopted(c)).toBeNull();
  });

  it('a final page with no adoptable token fails the poll and changes nothing', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli');
    fake.dropFinalToken = true;
    fake.attention.workers = [worker('w-eli', 'Eli')];
    expect(() => poll(c)).toThrow(/no adoptable token/);
    expect(fake.sent).toEqual([]);
    expect(adopted(c)).toBeNull();
  });
});

describe('Orca attention router — resolution never guesses', () => {
  it('no agent terminal: holds the token and reports once, not every poll', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.attention.workers = [worker('w-eli', 'Eli')];
    poll(c);
    poll(c);
    expect(fake.sent).toEqual([]);
    expect(adopted(c)).toBeNull();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('no live agent terminal');
  });

  it('two agent terminals in one worktree are ambiguous', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli', 'claude', 'term_a');
    fake.terminal('eli', 'codex', 'term_b');
    fake.attention.workers = [worker('w-eli', 'Eli')];
    expect(poll(c).held.Eli).toMatch(/ambiguous/);
    expect(fake.sent).toEqual([]);
  });

  it('a plain shell terminal in the worktree is not an agent', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli');
    fake.terminal('eli', null, 'term_shell');
    fake.attention.workers = [worker('w-eli', 'Eli')];
    expect(poll(c).nudged).toEqual(['Eli']);
  });

  const bind = (workerId: string) => {
    const gitdir = join(root, 'gitdirs', 'eli');
    mkdirSync(gitdir, { recursive: true });
    writeFileSync(join(gitdir, 'hadron-team-session.json'), JSON.stringify({ workerId }));
    writeFileSync(join(root, 'workspaces', 'eli', '.git'), `gitdir: ${gitdir}\n`);
  };

  it('a worktree bound to another worker is refused', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli');
    bind('w-someone-else');
    fake.attention.workers = [worker('w-eli', 'Eli')];
    expect(poll(c).held.Eli).toMatch(/bound to another worker/);
    expect(fake.sent).toEqual([]);
  });

  it('a matching binding is accepted', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli');
    bind('w-eli');
    fake.attention.workers = [worker('w-eli', 'Eli')];
    expect(poll(c).nudged).toEqual(['Eli']);
  });
});

describe('Orca attention router — identity-flap fallback: the screen resolves what tracking lost', () => {
  // Orca's per-terminal tracking degrades mid-life: agentIdentity reads null
  // on a terminal that is running its agent right now (2026-10-12: held
  // "no live agent terminal" ~6.5h while the agent worked; the same CLI, env
  // and cwd read 'claude' stable in 40 consecutive polls). Same degradation
  // family as the null lastOutputAt the #7398 gate already survives.
  it('a null-identity terminal whose screen shows claude chrome still nudges', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli', null);
    fake.attention.workers = [worker('w-eli', 'Eli')];
    const out = poll(c);
    expect(out.nudged).toEqual(['Eli']);
    expect(fake.sent[0][0]).toBe('term_eli');
    expect(logs.some((l) => l.includes('resolved by screen'))).toBe(true);
  });

  it('a codex screen resolves as codex, so the family flows to the gates', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli', null);
    fake.screens.set('term_eli', { tail: CODEX_IDLE });
    fake.attention.workers = [worker('w-eli', 'Eli')];
    const out = poll(c);
    expect(out.nudged).toEqual(['Eli']);
  });

  it('a plain shell screen is never resolved by the fallback', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli', null);
    fake.screens.set('term_eli', { tail: ['orca@orca1:~/ws/eli$ '] });
    fake.attention.workers = [worker('w-eli', 'Eli')];
    const out = poll(c);
    expect(out.held.Eli).toBe('no live agent terminal in its worktree');
    expect(fake.sent).toEqual([]);
  });

  // Blind review P2 (#1823, Anne): a plain shell in the bound worktree `cat`s a
  // captured Claude idle screen and returns to its own prompt. The box and the
  // hint are HISTORY, not a live composer — the whole counterexample that
  // passed both post-recompute gates when the status check read only the FIRST
  // nonblank line below the closing rule.
  it('a shell printing a CAPTURED Claude idle screen then its own prompt HOLDS — no send (blind P2, #1823)', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli', null, 'term_eli', false); // identity lost, untracked: the fallback's regime
    fake.screens.set('term_eli', { tail: [...CLAUDE_IDLE, 'orca@orca1:~/ws/eli$ '] });
    fake.attention.workers = [worker('w-eli', 'Eli')];
    const out = poll(c);
    expect(out.nudged).toEqual([]);
    expect(fake.sent).toEqual([]);
    expect(out.held.Eli).toContain('screen shows text in the prompt');
  });

  it('a WRONG family guess is caught one gate later: banner chrome without a composer holds (blind P2 pin, #1823)', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli', null, 'term_eli', false);
    // Classifies 'claude' on the banner line; there is no Claude composer box,
    // so the family-specific empty-prompt gate must refuse what it resolved.
    fake.screens.set('term_eli', { tail: ['  Claude Code v2.1.296 — a captured banner line', '  ordinary output', 'orca@orca1:~/ws/eli$ '] });
    fake.attention.workers = [worker('w-eli', 'Eli')];
    const out = poll(c);
    expect(out.nudged).toEqual([]);
    expect(fake.sent).toEqual([]);
    expect(out.held.Eli).toContain('screen shows text in the prompt');
  });

  it('codex side: a captured Codex screen with an appended shell prompt holds at the footer check (blind P2 pin, #1823)', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli', null, 'term_eli', false);
    fake.screens.set('term_eli', { tail: [...CODEX_IDLE, 'orca@orca1:~/ws/eli$ '] });
    fake.attention.workers = [worker('w-eli', 'Eli')];
    const out = poll(c);
    expect(out.nudged).toEqual([]);
    expect(fake.sent).toEqual([]);
    expect(out.held.Eli).toContain('screen shows text in the prompt');
  });

  it('an unreadable screen holds', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli', null);
    fake.screens.set('term_eli', { tail: CLAUDE_IDLE, ok: false });
    fake.attention.workers = [worker('w-eli', 'Eli')];
    expect(poll(c).held.Eli).toBe('no live agent terminal in its worktree');
    expect(fake.sent).toEqual([]);
  });

  it('a screen showing BOTH families holds rather than guess', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli', null);
    fake.screens.set('term_eli', { tail: [...CLAUDE_IDLE, '› Ask Codex to do anything'] });
    fake.attention.workers = [worker('w-eli', 'Eli')];
    expect(poll(c).held.Eli).toBe('no live agent terminal in its worktree');
    expect(fake.sent).toEqual([]);
  });

  it('two screen-verified terminals in one worktree hold (ambiguous)', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli', null, 'term_a');
    fake.terminal('eli', null, 'term_b');
    fake.attention.workers = [worker('w-eli', 'Eli')];
    expect(poll(c).held.Eli).toBe('no live agent terminal in its worktree');
    expect(fake.sent).toEqual([]);
  });

  it('a verified identity still resolves without the fallback (no screen read at resolve time)', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli', 'claude', 'term_eli');
    fake.screens.delete('term_eli'); // identity path must not need a screen
    fake.attention.workers = [worker('w-eli', 'Eli')];
    // The gates then read the screen; serve it back only for the gate reads.
    fake.screens.set('term_eli', { tail: CLAUDE_IDLE });
    const out = poll(c);
    expect(out.nudged).toEqual(['Eli']);
    expect(logs.some((l) => l.includes('resolved by screen'))).toBe(false);
    // Resolution itself must not read: the FIRST screen read belongs to the
    // gates, so it strictly follows the first idle wait (blind P3, #1823 —
    // the absent fallback log alone could not tell a resolve-time read apart
    // from a gate read).
    const verb = (a: string[]) => a.slice(1, 3).join(' ');
    const firstWait = fake.calls.findIndex((a) => verb(a) === 'terminal wait');
    const firstRead = fake.calls.findIndex((a) => verb(a) === 'terminal read');
    expect(firstWait).toBeGreaterThanOrEqual(0);
    expect(firstRead).toBeGreaterThan(firstWait);
  });

  it('resolveTerminal with a verified identity never touches the screen: a read-trap runner proves it (blind P3, #1823)', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli', 'claude', 'term_eli');
    const trap: Runner = (argv) => {
      if (argv.slice(1, 3).join(' ') === 'terminal read') throw new Error('resolution read the screen');
      return fake.run(argv);
    };
    const entry = { worker: 'w-eli', name: 'Eli', worktree: join(root, 'workspaces', 'eli') };
    expect(resolveTerminal(entry, fake.terminals as unknown as Terminal[], c, trap)).toEqual(['term_eli', 'claude', 'identity']);
  });
});

describe('screenAgentFamily — positive family chrome only', () => {
  const term = (tail: string[]) => ({ source: 'screen', tail });
  it('claude idle, fresh-launch, compacted and real captured screens read claude', () => {
    for (const screen of [CLAUDE_IDLE, CLAUDE_FRESH, CLAUDE_IDLE_COMPACTED, CLAUDE_IDLE_REAL_XAN, CLAUDE_IDLE_REAL_LIAM, CLAUDE_BUSY_EMPTY, CLAUDE_UNKNOWN_QUIET]) {
      expect(screenAgentFamily(term(screen))).toBe('claude');
    }
  });
  it('codex idle and fresh-launch screens read codex', () => {
    for (const screen of [CODEX_IDLE, CODEX_FRESH, CODEX_BUSY_EMPTY]) {
      expect(screenAgentFamily(term(screen))).toBe('codex');
    }
  });
  it('a plain shell reads null', () => {
    expect(screenAgentFamily(term(['orca@orca1:~/workspaces/eli$ ', '']))).toBeNull();
    expect(screenAgentFamily(term(['❯ ']))).toBeNull(); // starship-like glyph alone is not claude
    expect(screenAgentFamily(term(['─'.repeat(60)]))).toBeNull(); // one rule is not the composer box
    expect(screenAgentFamily(undefined)).toBeNull();
    expect(screenAgentFamily({ source: 'stream', tail: ['x'] })).toBeNull();
    // Ordinary output MENTIONING the markers is not chrome: banner/completion
    // markers anchor to banner-chrome line starts, never after arbitrary
    // content, and a bare `›` glyph is a shell theme as easily as a composer
    // (blind review P2, #1823).
    expect(screenAgentFamily(term(['orca$ echo "Worked for 33s"', 'orca$ ']))).toBeNull();
    expect(screenAgentFamily(term(['orca$ echo "Claude Code v2.1.296"', 'orca$ ']))).toBeNull();
    expect(screenAgentFamily(term(['orca$ echo "Ask Codex to do anything"', 'orca$ ']))).toBeNull();
    expect(screenAgentFamily(term(['› ', '']))).toBeNull();
  });
});

describe('Orca attention router — the mention-only register prerequisite', () => {
  it('a roster worker without a mention-only row is held and reported, never nudged on every message', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli');
    fake.mentionOnly = new Set();
    fake.attention.workers = [worker('w-eli', 'Eli', { mentions: 230 })];
    const out = poll(c);
    expect(out.held.Eli).toMatch(/mention-only register row/);
    expect(fake.sent).toEqual([]);
    expect(adopted(c)).toBeNull();
    fake.mentionOnly = new Set(['w-eli']);
    expect(poll(c).nudged).toEqual(['Eli']);
  });

  it('a winning row that is not mention-only does not count', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli');
    fake.registerRow = () => ({ namedBy: 'WORKER', channel: { id: CHANNEL }, entry: { mentionOnly: false } });
    fake.attention.workers = [worker('w-eli', 'Eli')];
    expect(poll(c).held.Eli).toMatch(/mention-only/);
  });

  it('a winning row not named by the worker (e.g. an everyone row) does not count', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli');
    fake.registerRow = () => ({ namedBy: 'EVERYONE', channel: { id: CHANNEL }, entry: { mentionOnly: true } });
    fake.attention.workers = [worker('w-eli', 'Eli')];
    expect(poll(c).held.Eli).toMatch(/mention-only/);
  });

  it('an organization-owned worker row counts: the check reads the EFFECTIVE registration (@codex P2, #1490)', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli');
    fake.registerRow = () => ({ namedBy: 'WORKER', channel: { id: CHANNEL }, entry: { mentionOnly: true, ownerType: 'ORGANIZATION' } });
    fake.attention.workers = [worker('w-eli', 'Eli')];
    expect(poll(c).nudged).toEqual(['Eli']);
    const q = fake.calls.find((a) => a[1] === 'api' && a[2].includes('attendeeRegister'))!;
    expect(q).toBeDefined();
    expect(q[2]).not.toContain('ownerRef');
  });

  it('a failed register query throws and changes nothing', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli');
    const base = fake.run;
    fake.run = (argv) => (argv[1] === 'api' ? { code: 1, stderr: '', stdout: JSON.stringify({ errors: [{ message: 'nope' }] }) } : base(argv));
    fake.attention.workers = [worker('w-eli', 'Eli')];
    expect(() => poll(c)).toThrow(RouterError);
    expect(adopted(c)).toBeNull();
  });
});

describe('Orca attention router — failures leave the token alone', () => {
  it('a rejected send holds the token and is not recorded as delivered', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli');
    fake.reject.add('term_eli');
    fake.attention.workers = [worker('w-eli', 'Eli')];
    expect(Object.keys(poll(c).held)).toEqual(['Eli']);
    expect(adopted(c)).toBeNull();
    fake.reject.clear();
    expect(poll(c).nudged).toEqual(['Eli']);
  });

  it('a failed attention poll throws and changes nothing', () => {
    const c = cfg(['w-eli', 'Eli']);
    poll(c);
    fake.attentionOk = false;
    expect(() => poll(c)).toThrow(RouterError);
    expect(adopted(c)).toBe(TOKEN_1);
  });

  it('a second concurrent run is refused while its owner is alive', () => {
    const c = cfg(['w-eli', 'Eli']);
    mkdirSync(join(c.stateDir, '.writer-lock'), { recursive: true });
    writeFileSync(join(c.stateDir, '.writer-lock', 'owner'), String(process.pid));
    expect(() => poll(c)).toThrow(RouterError);
  });

  it('a lock owned by a live process of ANOTHER user (kill → EPERM) is never reclaimed', () => {
    const c = cfg(['w-eli', 'Eli']);
    mkdirSync(join(c.stateDir, '.writer-lock'), { recursive: true });
    writeFileSync(join(c.stateDir, '.writer-lock', 'owner'), '1'); // launchd/init: alive, not ours
    expect(() => poll(c)).toThrow(RouterError);
  });

  const lockDir = (c: Config) => join(c.stateDir, '.writer-lock');
  const writeOwner = (c: Config, rec: unknown) => {
    mkdirSync(lockDir(c), { recursive: true });
    writeFileSync(join(lockDir(c), 'owner'), typeof rec === 'string' ? rec : JSON.stringify(rec));
  };
  const boot = () => Date.now() - uptime() * 1000;

  it('L1: a lock from before a REBOOT is reclaimed, even if its pid is alive now (@codex P2, #1490)', () => {
    const c = cfg(['w-eli', 'Eli']);
    writeOwner(c, { pid: process.pid, boot: 0, startedAt: Date.now() });
    expect(poll(c).adopted).toBe(true);
  });

  it('L2: a REUSED pid (its process started after the lock was taken) is not the owner: reclaimed', () => {
    const c = cfg(['w-eli', 'Eli']);
    writeOwner(c, { pid: process.pid, boot: boot(), startedAt: 0 });
    expect(poll(c).adopted).toBe(true);
  });

  it('L3: a genuinely live owner (same boot, pid alive, started before the lock) is never displaced', () => {
    const c = cfg(['w-eli', 'Eli']);
    const rec = { pid: process.pid, boot: boot(), startedAt: Date.now() };
    writeOwner(c, rec);
    expect(() => poll(c)).toThrow(RouterError);
    expect(readFileSync(join(lockDir(c), 'owner'), 'utf8')).toBe(JSON.stringify(rec));
  });

  const tombs = (c: Config) => readdirSync(c.stateDir).filter((n) => n.includes('.tomb-'));

  it('C1 (Chip QA): a racer with a STALE judgement cannot break the lock another racer just took; the live lock is restored', () => {
    const c = cfg(['w-eli', 'Eli']);
    writeOwner(c, '999999'); // stale: judged dead by both racers
    expect(breakStaleLock(lockDir(c), '999999')).toBe('retry'); // racer A breaks it...
    writeOwner(c, 'A-live-record'); // ...and takes the lock
    expect(breakStaleLock(lockDir(c), '999999')).toBe('busy'); // racer B, same outdated judgement
    expect(readFileSync(join(lockDir(c), 'owner'), 'utf8')).toBe('A-live-record');
    expect(tombs(c)).toEqual([]);
  });

  it('C2/C3: a stale lock breaks cleanly; an already-broken one reads as free', () => {
    const c = cfg(['w-eli', 'Eli']);
    writeOwner(c, '999999');
    expect(breakStaleLock(lockDir(c), '999999')).toBe('retry');
    expect(existsSync(lockDir(c))).toBe(false);
    expect(tombs(c)).toEqual([]);
    expect(breakStaleLock(lockDir(c), '999999')).toBe('retry');
  });

  it('C4: a run that loses its lock mid-poll stops before any send or adoption, and never deletes the other lock', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli');
    fake.attention.workers = [worker('w-eli', 'Eli')];
    const base = fake.run;
    fake.run = (argv) => {
      if (argv[1] === 'api' && argv[2].includes('teamAttentionPage')) writeFileSync(join(lockDir(c), 'owner'), 'someone-else');
      return base(argv);
    };
    expect(() => poll(c)).toThrow(/lost the writer lock/);
    expect(fake.sent).toEqual([]);
    expect(adopted(c)).toBeNull();
    expect(readFileSync(join(lockDir(c), 'owner'), 'utf8')).toBe('someone-else');
  });

  it('a lock left by a dead process is reclaimed (@codex P2, #1490)', () => {
    const c = cfg(['w-eli', 'Eli']);
    mkdirSync(join(c.stateDir, '.writer-lock'), { recursive: true });
    writeFileSync(join(c.stateDir, '.writer-lock', 'owner'), '999999');
    expect(poll(c).adopted).toBe(true);
    expect(existsSync(join(c.stateDir, '.writer-lock'))).toBe(false);
  });

  it('a fresh lock with no owner record yet is respected; an old one is reclaimed', () => {
    const c = cfg(['w-eli', 'Eli']);
    const lock = join(c.stateDir, '.writer-lock');
    mkdirSync(lock, { recursive: true });
    expect(() => poll(c)).toThrow(RouterError);
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(lock, old, old);
    expect(poll(c).adopted).toBe(true);
  });
});

describe('Orca attention router — nothing secret leaks', () => {
  it('the token never appears in output, logs, nudges, status or the ledger', () => {
    const c = cfg(['w-eli', 'Eli'], ['w-baloo', 'Baloo']);
    fake.terminal('eli');
    fake.attention.workers = [worker('w-eli', 'Eli'), worker('w-baloo', 'Baloo')];
    const out = poll(c);
    const blob = describeOutcome(out) + JSON.stringify(logs) + JSON.stringify(fake.sent) + JSON.stringify(status(c))
      + readFileSync(join(c.stateDir, 'ledger.json'), 'utf8');
    expect(blob).not.toContain('SECRET');
  });

  it('state is private: directory 0700, token 0600', () => {
    const c = cfg(['w-eli', 'Eli']);
    poll(c);
    expect(statSync(c.stateDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(c.stateDir, 'adopted.token')).mode & 0o777).toBe(0o600);
  });

  it('config refuses an incomplete or duplicate roster', () => {
    const path = join(root, 'c.json');
    const base = { app: 'a', channel: 'c', stateDir: join(root, 's') };
    writeFileSync(path, JSON.stringify({ ...base, roster: [{ worker: 'w', name: 'E' }] }));
    expect(() => loadConfig(path)).toThrow(RouterError);
    const entry = { worker: 'w', name: 'E', worktree: '/x' };
    writeFileSync(path, JSON.stringify({ ...base, roster: [entry, entry] }));
    expect(() => loadConfig(path)).toThrow(RouterError);
    // Two workers on one worktree (@codex P2, #1490).
    writeFileSync(path, JSON.stringify({ ...base, roster: [entry, { ...entry, worker: 'w2', name: 'F' }] }));
    expect(() => loadConfig(path)).toThrow(/one worktree to two workers/);
  });
});

describe('Orca attention router — a human typing: never appended to; hold the token (#5473)', () => {
  it('reads an idle Claude Code and Codex screen as empty, including Codex NBSP and its placeholder', () => {
    expect(promptLineIsEmpty(CLAUDE_IDLE, 'claude')).toBe(true);
    expect(promptLineIsEmpty(CODEX_IDLE, 'codex')).toBe(true);
    expect(promptLineIsEmpty(['›\u00a0Ask Codex to do anything', '  ? for shortcuts'], 'codex')).toBe(true);
  });

  it('reads typed text as not empty: the last prompt line, a multi-line draft, or an unknown footer', () => {
    expect(promptLineIsEmpty(withPrompt(CLAUDE_IDLE, '❯', 'half-typed message'), 'claude')).toBe(false);
    expect(promptLineIsEmpty(withPrompt(CODEX_IDLE, '›', 'half-typed message'), 'codex')).toBe(false);
    // Claude: the first line is empty but a continuation line inside the box is not.
    expect(promptLineIsEmpty([RULE, '❯', '  second line of a draft', RULE], 'claude')).toBe(false);
    // Codex: something below the prompt that is not footer.
    expect(promptLineIsEmpty(['›', '  second line of a draft', '  ? for shortcuts'], 'codex')).toBe(false);
  });

  it('a typed line that looks like chrome is still draft: the literal-marker case, live 2026-10-01 (@codex P2, Gene #1555)', () => {
    // Exactly as Orca rendered a two-line Claude draft whose second line is `❯`.
    expect(promptLineIsEmpty([RULE, '❯\u00a0first line', '  ❯', RULE, '  ⏵⏵ bypass permissions on'], 'claude')).toBe(false);
    expect(promptLineIsEmpty([RULE, '❯', '  ❯', RULE], 'claude')).toBe(false);
    // Chip's QA repro (#5724), with the marker even at column 0.
    expect(promptLineIsEmpty([RULE, '❯ half typed', '❯', RULE], 'claude')).toBe(false);
    // A typed rule is indented too, so it cannot fake the box's opening rule.
    expect(promptLineIsEmpty([RULE, '❯ text', `  ${RULE}`, '❯', RULE], 'claude')).toBe(false);
    // Codex: a typed `›` continuation is indented, so it cannot pose as the prompt.
    expect(promptLineIsEmpty(['› half typed', '  ›', '  ? for shortcuts'], 'codex')).toBe(false);
    // Rules in earlier transcript output do not matter: the box is the LAST pair.
    expect(promptLineIsEmpty([RULE, 'output', RULE, '❯ old turn', RULE, '❯', RULE, CLAUDE_HINT], 'claude')).toBe(true);
  });

  it('Claude: a bare box over exactly ONE mode footer is empty, with or without the transient agents suffix (cli#907 bcabaf4)', () => {
    // 9 of 12 live terminals had no `· ← for agents` on 2026-10-18.
    expect(promptLineIsEmpty([RULE, '❯', RULE, '  ⏵⏵ bypass permissions on (shift+tab to cycle)'], 'claude')).toBe(true);
    for (const mode of ['⏵⏵ auto mode on (shift+tab to cycle)', '⏵⏵ accept edits on (shift+tab to cycle)', '⏵⏵ plan mode on (shift+tab to cycle)']) {
      expect(promptLineIsEmpty([RULE, '❯', RULE, `  ${mode} · ← for agents`], 'claude')).toBe(true);
      expect(promptLineIsEmpty([RULE, '❯', RULE, `  ${mode}`], 'claude')).toBe(true);
    }
    // Not the mode line, or more than one footer row: not proof.
    expect(promptLineIsEmpty([RULE, '❯', RULE, '  ctrl+g to edit in Vim'], 'claude')).toBe(false);
    expect(promptLineIsEmpty([RULE, '❯', RULE, '  ⏵⏵ auto mode on (shift+tab to cycle)', '  esc to interrupt'], 'claude')).toBe(false);
    expect(promptLineIsEmpty([RULE, '❯', RULE, '  ⏸ manual mode on'], 'claude')).toBe(false);
    // No status line at all cannot prove it.
    expect(promptLineIsEmpty([RULE, '❯', RULE], 'claude')).toBe(false);
  });

  it('Claude: the composer status line is the terminal BOTTOM — trailing non-chrome content holds (blind P2, #1823)', () => {
    // The blind-review counterexample: a shell `cat`s a captured Claude idle
    // screen and returns to its own prompt. Reading only the FIRST nonblank
    // line below the closing rule passed this — the trailing shell prompt is
    // the evidence that the box is history, not a live composer.
    expect(promptLineIsEmpty([...CLAUDE_IDLE, 'orca@orca1:~/ws/eli$ '], 'claude')).toBe(false);
    // Any unexplained content after the hint holds, shell-shaped or not.
    expect(promptLineIsEmpty([RULE, '❯', RULE, CLAUDE_HINT, '  some trailing output'], 'claude')).toBe(false);
    // Trailing BLANK lines are just the scroll buffer: still empty.
    expect(promptLineIsEmpty([...CLAUDE_IDLE, '', '   '], 'claude')).toBe(true);
  });

  it('Codex: only the placeholder proves empty; a bare prompt or a dialog holds (live 2026-10-01)', () => {
    // Whitespace typed into Codex: the placeholder vanished, and Orca reported no draft.
    expect(promptLineIsEmpty(['  Got a minute and a mildly unreasonable idea?', '›', '  GPT-6-Sol high · ~/orca/workspaces/hadron-server/eli'], 'codex')).toBe(false);
    expect(promptLineIsEmpty(['›', '', '  ? for shortcuts'], 'codex')).toBe(false);
    // Codex's update menu: the cursor line is a menu option, not the composer.
    expect(promptLineIsEmpty(['  Update available · 0.159.0 → 0.159.3', '› 1. Update now (runs `brew upgrade --cask codex`)', '  2. Skip', '  3. Skip until next version', '  enter continue · esc skip'], 'codex')).toBe(false);
  });

  it('cannot prove empty without a prompt marker, the closing rule, or a known agent', () => {
    expect(promptLineIsEmpty(['plain shell $'], 'claude')).toBe(false);
    expect(promptLineIsEmpty([RULE, '❯'], 'claude')).toBe(false);
    expect(promptLineIsEmpty(CODEX_IDLE, 'gemini')).toBe(false);
    expect(promptLineIsEmpty([], 'codex')).toBe(false);
  });

  it('holds an idle worker whose prompt has text, then nudges it once the prompt is empty', () => {
    const c = cfg(['w-eli', 'Eli'], ['w-baloo', 'Baloo']);
    fake.terminal('eli');
    fake.terminal('baloo', 'codex');
    fake.screens.set('term_baloo', { tail: withPrompt(CODEX_IDLE, '›', 'Holger typing here') });
    fake.attention.workers = [worker('w-eli', 'Eli'), worker('w-baloo', 'Baloo')];
    let out = poll(c);
    expect(out.nudged).toEqual(['Eli']);
    expect(out.held).toEqual({ Baloo: 'prompt not empty (text in the prompt)' });
    expect(out.adopted).toBe(false);
    expect(sentHandles()).toEqual(['term_eli']);
    // The held reason never carries the typed text.
    expect(logs.join('\n')).not.toContain('Holger typing here');

    fake.screens.set('term_baloo', { tail: CODEX_IDLE });
    out = poll(c);
    expect(out).toMatchObject({ covered: ['Eli'], nudged: ['Baloo'], adopted: true });
  });

  it('holds a Codex worker whose typed text shows only in the draft, over an empty-looking prompt', () => {
    // As observed live: Codex draws `›` empty while Orca reports the text as draft.
    const c = cfg(['w-baloo', 'Baloo']);
    fake.terminal('baloo', 'codex');
    fake.screens.set('term_baloo', { tail: ['  permissions: YOLO mode', '›', '  GPT-6-Sol high · ~/orca/workspaces/hadron-server/baloo'], draft: 'half typed' });
    fake.attention.workers = [worker('w-baloo', 'Baloo')];
    expect(poll(c).held).toEqual({ Baloo: 'prompt not empty (text in the composer draft)' });
    expect(fake.sent).toEqual([]);
  });

  it('holds on a composer draft, a non-screen read, or an unreadable terminal', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli', 'codex'); // a Codex draft is authoritative: its composer renders empty
    fake.attention.workers = [worker('w-eli', 'Eli')];
    for (const [screen, why] of [
      [{ tail: CODEX_IDLE, draft: 'typed in Orca' }, 'text in the composer draft'],
      // Whitespace is typing too (Gene, #1555): the gate promises nobody is typing.
      [{ tail: CODEX_IDLE, draft: '   ' }, 'text in the composer draft'],
      [{ tail: CODEX_IDLE, source: 'screen-unavailable' }, 'screen unreadable'],
      [{ ok: false }, 'screen unreadable'],
    ] as const) {
      fake.screens.set('term_eli', screen);
      const out = poll(c);
      expect(out.held).toEqual({ Eli: `prompt not empty (${why})` });
      expect(fake.sent).toEqual([]);
    }
  });

  it('a Claude draft still holds when the box RENDERS the text — the draft is corroborated, not stale', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli');
    fake.attention.workers = [worker('w-eli', 'Eli')];
    fake.screens.set('term_eli', { tail: withPrompt(CLAUDE_IDLE, '❯', 'typed words'), draft: 'typed words' });
    const out = poll(c);
    expect(out.held).toEqual({ Eli: 'prompt not empty (text in the composer draft)' });
    expect(fake.sent).toEqual([]);
  });
});

describe('Orca attention router — coordinator/lifecycle liveness rule (#1826)', () => {
  /** A config whose roster carries liveness flags: [worker, name, flag?]. */
  const mcfg = (
    entries: Array<[string, string, 'coordinator' | 'lifecycle' | undefined]>,
    watchMinutes = 20,
  ): Config => ({
    ...cfg(...entries.map(([w, n]) => [w, n] as [string, string])),
    coordinatorWatchMinutes: watchMinutes,
    roster: entries.map(([worker, name, flag]) => ({
      worker, name, worktree: join(root, 'workspaces', name.toLowerCase()),
      ...(flag === 'coordinator' ? { coordinator: true } : {}),
      ...(flag === 'lifecycle' ? { lifecycle: true } : {}),
    })),
  });
  /** Seed liveness.json directly — the durable file is the contract, not an API. */
  const seedLiveness = (c: Config, workers: Record<string, unknown>) => {
    mkdirSync(c.stateDir, { recursive: true });
    writeFileSync(join(c.stateDir, 'liveness.json'), JSON.stringify(workers));
  };
  const readLiveness = (c: Config): Record<string, any> =>
    JSON.parse(readFileSync(join(c.stateDir, 'liveness.json'), 'utf8'));
  const AGO_21MIN = 21 * 60_000;

  it('an idle flagged worker whose watermark fell behind — ZERO mentions — is woken through the full guard chain', () => {
    const c = mcfg([['w-ada', 'Ada', 'coordinator']]);
    fake.terminal('ada');
    fake.attention.workers = []; // attention sees nothing relevant: the suppressed-row gap (#1826 delta 1)
    fake.cursors.set('w-ada', 100); // watermark 100 < head 120, no mention anywhere in the span
    seedLiveness(c, { 'w-ada': { idleSince: Date.now() - AGO_21MIN, handle: 'term_ada' } });
    const out = poll(c);
    expect(out.liveness).toEqual(['Ada']);
    expect(out.nudged).toEqual([]);
    expect(out.adopted).toBe(true);
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0][0]).toBe('term_ada');
    const text = fake.sent[0][1];
    expect(text).toContain('liveness');
    expect(text).toContain('idle-watch rule'); // it names its rule — why it arrived with no mention (Taylor #9748)
    expect(text).toContain('#100'); // its cursor, named
    expect(text).toContain('#120'); // the head, named
    expect(text).toContain('--since 100');
    expect(text).toContain('sinceSeq=100');
    expect(text).toContain('mark read');
    expect((text.match(/mark read/g) ?? []).length).toBe(1); // once, not twice (Taylor #9748)
    expect(text).toContain('as of send');
    expect(text).not.toContain('relevant unread'); // its own literal: never a counts claim
    expect(text).not.toMatch(/\d+ mention/); // identifying the rule is fine; a count claim never is
    // The full guard chain ran, in order, with the cheap probe / full gate / recheck waits.
    const verbs = fake.calls.map((a) => a.slice(1, 3).join(' '));
    expect(verbs.indexOf('terminal wait')).toBeLessThan(verbs.indexOf('terminal read'));
    expect(verbs.indexOf('terminal read')).toBeLessThan(verbs.indexOf('terminal send'));
    const waits = fake.calls.filter((a) => a.slice(1, 3).join(' ') === 'terminal wait');
    const ms = (a: string[]) => Number(a[a.indexOf('--timeout-ms') + 1]);
    expect(waits).toHaveLength(3);
    expect(ms(waits[0])).toBeLessThanOrEqual(1_000); // cheap per-poll probe
    expect(ms(waits[1])).toBe(c.busyWaitMs); // the full gate before the send
    expect(ms(waits[2])).toBeLessThanOrEqual(1_000); // fail-closed post-recompute recheck
    // Persisted at once: frontier = the head at send, clock restarted at the send.
    const rec = readLiveness(c)['w-ada'];
    expect(rec.coveredFrontier).toBe(120);
    expect(rec.idleSince).toBeGreaterThan(Date.now() - 60_000);
  });

  it('the idle-watch wake reads the open-task count before the final gates and never after them (#2630)', () => {
    const c = mcfg([['w-ada', 'Ada', 'coordinator']]);
    fake.terminal('ada');
    fake.attention.workers = [];
    fake.cursors.set('w-ada', 100);
    fake.openTasks.set('w-ada', [{ id: 't1', status: 'STARTED', assignee: { kind: 'WORKER', id: 'w-ada' } }]);
    seedLiveness(c, { 'w-ada': { idleSince: Date.now() - AGO_21MIN, handle: 'term_ada' } });
    poll(c);
    expect(fake.sent[0][1]).toContain('You have 1 open task');
    const verbs = fake.calls.map((a) => (a[1] === 'api' && a[2].includes('agentTasks(') ? 'count' : a.slice(1, 3).join(' ')));
    const count = verbs.indexOf('count');
    expect(count).toBeGreaterThan(-1);
    expect(verbs.lastIndexOf('terminal wait')).toBeGreaterThan(count);
    expect(verbs.lastIndexOf('terminal read')).toBeGreaterThan(count);
    expect(verbs.indexOf('terminal send')).toBeGreaterThan(verbs.lastIndexOf('terminal read'));
    expect(verbs.slice(count + 1, verbs.indexOf('terminal send')).includes('count')).toBe(false);
  });

  it('a NON-flagged worker with the same idle + unread backlog gets nothing: liveness is opt-in per roster flag', () => {
    const c = mcfg([['w-eli', 'Eli', undefined]]);
    fake.terminal('eli');
    fake.attention.workers = [];
    fake.cursors.set('w-eli', 100);
    seedLiveness(c, { 'w-eli': { idleSince: Date.now() - AGO_21MIN, handle: 'term_eli' } });
    const out = poll(c);
    expect(out.liveness).toEqual([]);
    expect(fake.sent).toEqual([]);
    expect(out.adopted).toBe(true);
  });

  it('fires only at STRICTLY more than N minutes of continuous idle — never at exactly N', () => {
    const c = mcfg([['w-ada', 'Ada', 'coordinator']]); // N = 20 min
    fake.terminal('ada');
    fake.cursors.set('w-ada', 100);
    const frozen = Date.now();
    seedLiveness(c, { 'w-ada': { idleSince: frozen - 20 * 60_000, handle: 'term_ada' } });
    expect(poll(c, () => frozen).liveness).toEqual([]); // exactly N: never fires
    seedLiveness(c, { 'w-ada': { idleSince: frozen - 20 * 60_000 - 1, handle: 'term_ada' } });
    expect(poll(c, () => frozen).liveness).toEqual(['Ada']); // one tick past N: fires
  });

  it('a busy screen at the full gate HOLDS with its reason and resets the clock', () => {
    const c = mcfg([['w-ada', 'Ada', 'coordinator']]);
    fake.terminal('ada');
    fake.cursors.set('w-ada', 100);
    seedLiveness(c, { 'w-ada': { idleSince: Date.now() - AGO_21MIN, handle: 'term_ada' } });
    fake.busyRecheck.add('term_ada'); // idle at the probe, busy at the full gate
    fake.recheckScreens.set('term_ada', { tail: CLAUDE_BUSY_EMPTY }); // #1845: busy needs the live indicator
    const out = poll(c);
    expect(out.liveness).toEqual([]);
    expect(out.held.Ada).toContain('liveness');
    expect(out.held.Ada).toContain('a running turn is drawn above the prompt');
    expect(out.adopted).toBe(false); // a held liveness nudge holds the token like a held mention nudge
    expect(fake.sent).toEqual([]);
    expect(readLiveness(c)['w-ada'].idleSince).toBeUndefined();
  });

  it('a non-empty draft at the full gate HOLDS with its reason and resets the clock', () => {
    const c = mcfg([['w-ada', 'Ada', 'coordinator']]);
    fake.terminal('ada');
    fake.cursors.set('w-ada', 100);
    seedLiveness(c, { 'w-ada': { idleSince: Date.now() - AGO_21MIN, handle: 'term_ada' } });
    fake.recheckScreens.set('term_ada', { tail: withPrompt(CLAUDE_IDLE, '❯', 'typed mid-watch'), draft: 'typed mid-watch' });
    const out = poll(c);
    expect(out.held.Ada).toContain('liveness');
    expect(out.held.Ada).toContain('prompt not empty');
    expect(fake.sent).toEqual([]);
    expect(readLiveness(c)['w-ada'].idleSince).toBeUndefined();
    expect(logs.join('\n')).not.toContain('typed mid-watch'); // the reason never quotes the text
  });

  it('an unreadable screen at the full gate HOLDS with its reason', () => {
    const c = mcfg([['w-ada', 'Ada', 'coordinator']]);
    fake.terminal('ada');
    fake.cursors.set('w-ada', 100);
    seedLiveness(c, { 'w-ada': { idleSince: Date.now() - AGO_21MIN, handle: 'term_ada' } });
    fake.recheckScreens.set('term_ada', { ok: false });
    const out = poll(c);
    expect(out.held.Ada).toContain('liveness');
    expect(out.held.Ada).toContain('screen unreadable');
    expect(fake.sent).toEqual([]);
  });

  it('an ambiguous resolution at the send HOLDS with its reason (fresh re-resolution on the chain)', () => {
    const c = mcfg([['w-ada', 'Ada', 'coordinator']]);
    fake.terminal('ada');
    fake.cursors.set('w-ada', 100);
    seedLiveness(c, { 'w-ada': { idleSince: Date.now() - AGO_21MIN, handle: 'term_ada' } });
    fake.hideTerminalsFromList = 2; // the probe's list sees it; the chain's fresh list does not
    const out = poll(c);
    expect(out.held.Ada).toContain('liveness');
    expect(out.held.Ada).toContain('no live agent terminal');
    expect(fake.sent).toEqual([]);
    expect(readLiveness(c)['w-ada'].idleSince).toBeUndefined();
  });

  it('the idle clock survives token adoption: adopt clears the ledger, never liveness.json', () => {
    const c = mcfg([['w-ada', 'Ada', 'coordinator'], ['w-eli', 'Eli', undefined]]);
    fake.terminal('ada');
    fake.terminal('eli');
    fake.attention.workers = [worker('w-eli', 'Eli')]; // a mention nudge adopts the token
    fake.cursors.set('w-ada', 100);
    const seeded = Date.now() - 5 * 60_000; // behind, but only 5 idle minutes — not yet eligible
    seedLiveness(c, { 'w-ada': { idleSince: seeded, handle: 'term_ada' } });
    const out = poll(c);
    expect(out).toMatchObject({ nudged: ['Eli'], liveness: [], adopted: true });
    expect(readLiveness(c)['w-ada'].idleSince).toBe(seeded); // EXACTLY untouched by adoption
  });

  it('the idle clock survives a restart mid-wait and keeps aging the same episode across polls', () => {
    const c = mcfg([['w-ada', 'Ada', 'coordinator']]);
    fake.terminal('ada');
    fake.cursors.set('w-ada', 100);
    const seeded = Date.now() - 19 * 60_000; // one minute short of N
    seedLiveness(c, { 'w-ada': { idleSince: seeded, handle: 'term_ada' } });
    expect(poll(c).liveness).toEqual([]); // 19 < 20
    expect(readLiveness(c)['w-ada'].idleSince).toBe(seeded); // a poll is a restart: same episode
    expect(poll(c).liveness).toEqual([]);
    expect(readLiveness(c)['w-ada'].idleSince).toBe(seeded); // still the same episode, not restarted
  });

  it('interrupted idle: a busy probe observation resets the clock to zero and preserves coveredFrontier', () => {
    const c = mcfg([['w-ada', 'Ada', 'coordinator']]);
    fake.terminal('ada');
    fake.busy.add('term_ada');
    fake.screens.set('term_ada', { tail: CODEX_BUSY_EMPTY });
    fake.cursors.set('w-ada', 100);
    seedLiveness(c, { 'w-ada': { idleSince: Date.now() - AGO_21MIN, handle: 'term_ada', coveredFrontier: 90 } });
    const out = poll(c);
    expect(out.liveness).toEqual([]);
    expect(out.held).toEqual({}); // a probe reset is silent — no delivery was attempted
    expect(fake.sent).toEqual([]);
    const rec = readLiveness(c)['w-ada'];
    expect(rec.idleSince).toBeUndefined();
    expect(rec.coveredFrontier).toBe(90); // the delivered frontier still dedupes
    fake.busy.clear();
    fake.screens.set('term_ada', { tail: CLAUDE_IDLE }); // the turn finished: the probe can prove idle again (family-matched)
    expect(poll(c).liveness).toEqual([]); // clock restarted at the idle poll — N more minutes needed
    expect(typeof readLiveness(c)['w-ada'].idleSince).toBe('number');
  });

  it('a half-typed prompt at the probe is interrupted idle: silent reset, no send, no hold', () => {
    const c = mcfg([['w-ada', 'Ada', 'coordinator']]);
    fake.terminal('ada');
    fake.screens.set('term_ada', { tail: withPrompt(CLAUDE_IDLE, '❯', 'Holger typing here'), draft: 'Holger typing here' });
    fake.cursors.set('w-ada', 100);
    seedLiveness(c, { 'w-ada': { idleSince: Date.now() - AGO_21MIN, handle: 'term_ada' } });
    const out = poll(c);
    expect(out.liveness).toEqual([]);
    expect(out.held).toEqual({});
    expect(fake.sent).toEqual([]);
    expect(readLiveness(c)['w-ada'].idleSince).toBeUndefined();
  });

  it('an ambiguous resolution at the probe resets the clock silently', () => {
    const c = mcfg([['w-ada', 'Ada', 'coordinator']]);
    fake.terminal('ada', 'claude', 'term_a');
    fake.terminal('ada', 'codex', 'term_b');
    fake.cursors.set('w-ada', 100);
    seedLiveness(c, { 'w-ada': { idleSince: Date.now() - AGO_21MIN, handle: 'term_a' } });
    const out = poll(c);
    expect(out.liveness).toEqual([]);
    expect(out.held).toEqual({}); // the watch never resolved a terminal; nothing was owed a send
    expect(fake.sent).toEqual([]);
    expect(readLiveness(c)['w-ada'].idleSince).toBeUndefined();
  });

  it('a repeated unchanged backlog never re-nudges; an advancing head re-arms after idle', () => {
    const c = mcfg([['w-ada', 'Ada', 'coordinator']]);
    fake.terminal('ada');
    fake.cursors.set('w-ada', 100);
    seedLiveness(c, { 'w-ada': { idleSince: Date.now() - AGO_21MIN, handle: 'term_ada' } });
    expect(poll(c).liveness).toEqual(['Ada']); // delivered at head 120
    // Twenty more idle minutes pass, but the head has not moved past the frontier.
    seedLiveness(c, { 'w-ada': { idleSince: Date.now() - AGO_21MIN, handle: 'term_ada', coveredFrontier: 120 } });
    expect(poll(c).liveness).toEqual([]);
    expect(fake.sent).toHaveLength(1);
    // New content past the frontier: eligible again once idle > N measured from the send.
    fake.head = 130;
    seedLiveness(c, { 'w-ada': { idleSince: Date.now() - AGO_21MIN, handle: 'term_ada', coveredFrontier: 120 } });
    expect(poll(c).liveness).toEqual(['Ada']);
    expect(fake.sent).toHaveLength(2);
    expect(fake.sent[1][1]).toContain('#130');
  });

  it('mention-first collapse: a delivered mention nudge skips the liveness send and restarts the clock', () => {
    const c = mcfg([['w-ada', 'Ada', 'coordinator']]);
    fake.terminal('ada');
    fake.attention.workers = [worker('w-ada', 'Ada', { mentions: 1, unread: 4 })];
    fake.cursors.set('w-ada', 100);
    seedLiveness(c, { 'w-ada': { idleSince: Date.now() - AGO_21MIN, handle: 'term_ada' } });
    const out = poll(c);
    expect(out).toMatchObject({ nudged: ['Ada'], liveness: [] });
    expect(fake.sent).toHaveLength(1); // exactly one send — the mention nudge
    expect(fake.sent[0][1]).toContain('relevant unread (1 mention'); // the mention shape, not the liveness text
    const rec = readLiveness(c)['w-ada'];
    expect(rec.idleSince).toBeGreaterThan(Date.now() - 60_000); // clock restarted at the send
    expect(rec.coveredFrontier).toBeUndefined(); // no liveness frontier claimed
  });

  it('a HELD mention observation is non-idle evidence: the liveness clock restarts and no liveness send happens', () => {
    const c = mcfg([['w-ada', 'Ada', 'coordinator']]);
    fake.terminal('ada');
    fake.busy.add('term_ada');
    fake.screens.set('term_ada', { tail: CODEX_BUSY_EMPTY });
    fake.attention.workers = [worker('w-ada', 'Ada')];
    fake.cursors.set('w-ada', 100);
    seedLiveness(c, { 'w-ada': { idleSince: Date.now() - AGO_21MIN, handle: 'term_ada' } });
    const out = poll(c);
    expect(out.held.Ada).toBeTruthy(); // the mention hold
    expect(out.liveness).toEqual([]);
    expect(readLiveness(c)['w-ada'].idleSince).toBeUndefined();
  });

  it('read-while-waiting: the recompute right before the send re-checks head > cursor and drops the nudge', () => {
    const c = mcfg([['w-ada', 'Ada', 'coordinator']]);
    fake.terminal('ada');
    fake.cursors.set('w-ada', 100);
    seedLiveness(c, { 'w-ada': { idleSince: Date.now() - AGO_21MIN, handle: 'term_ada' } });
    fake.freshCursors.set('w-ada', 120); // the worker caught up while the gates ran
    const out = poll(c);
    expect(out.liveness).toEqual([]);
    expect(out.livenessDropped).toEqual(['Ada']);
    expect(describeOutcome(out)).toContain('liveness dropped');
    expect(fake.sent).toEqual([]);
    const rec = readLiveness(c)['w-ada'];
    expect(rec.idleSince).toBeUndefined(); // reset — the worker demonstrably acted
    expect(rec.coveredFrontier).toBeUndefined();
  });

  it('a held token (busy mention worker) neither restarts nor resets a pending liveness clock; both deliver when clear', () => {
    const c = mcfg([['w-ada', 'Ada', 'coordinator'], ['w-baloo', 'Baloo', undefined]]);
    fake.terminal('ada');
    fake.terminal('baloo');
    fake.busy.add('term_baloo');
    fake.screens.set('term_baloo', { tail: CLAUDE_BUSY_EMPTY });
    fake.screens.set('term_baloo', { tail: CLAUDE_BUSY_EMPTY });
    fake.attention.workers = [worker('w-baloo', 'Baloo')];
    fake.cursors.set('w-ada', 100);
    const seeded = Date.now() - 10 * 60_000;
    seedLiveness(c, { 'w-ada': { idleSince: seeded, handle: 'term_ada' } });
    const first = poll(c);
    expect(first.adopted).toBe(false); // Baloo's mention hold holds the token
    expect(first.liveness).toEqual([]); // 10 idle minutes < N — clock pending
    expect(readLiveness(c)['w-ada'].idleSince).toBe(seeded); // untouched by the held poll
    fake.busy.clear();
    seedLiveness(c, { 'w-ada': { idleSince: Date.now() - AGO_21MIN, handle: 'term_ada' } });
    const second = poll(c);
    expect(second).toMatchObject({ nudged: ['Baloo'], liveness: ['Ada'], adopted: true });
  });

  it('a delivered liveness nudge is persisted at once: a failure later in the same poll cannot resend it', () => {
    const c = mcfg([['w-ada', 'Ada', 'coordinator'], ['w-yuri', 'Yuri', 'lifecycle']]);
    fake.terminal('ada');
    fake.terminal('yuri');
    fake.cursors.set('w-ada', 100);
    fake.cursors.set('w-yuri', 100);
    seedLiveness(c, {
      'w-ada': { idleSince: Date.now() - AGO_21MIN, handle: 'term_ada' },
      'w-yuri': { idleSince: Date.now() - AGO_21MIN, handle: 'term_yuri' },
    });
    // Ada delivers; Yuri's recompute then fails hard — a failed fresh check fails the poll.
    const base = fake.run;
    let armed = false;
    fake.run = (argv) => {
      if (argv[1] === 'api' && argv[2].includes('channelReadState')
        && argv[argv.indexOf('-F') + 1] === 'w=w-yuri') armed = true;
      if (armed && argv[1] === 'api' && argv[2].includes('channel(ref')) return { code: 1, stdout: '', stderr: 'gateway 502' };
      return base(argv);
    };
    expect(() => poll(c)).toThrow(RouterError);
    expect(sentHandles()).toEqual(['term_ada']);
    expect(readLiveness(c)['w-ada'].coveredFrontier).toBe(120); // persisted at once
    fake.run = base;
    expect(poll(c).liveness).toEqual(['Yuri']); // Yuri delivers on the retry
    expect(sentHandles()).toEqual(['term_ada', 'term_yuri']);
    expect(fake.sent.filter(([h]) => h === 'term_ada')).toHaveLength(1); // Ada NOT re-nudged
  });

  it('fail-closed liveness source: an unreadable cursor is no candidate this poll — logged once, clock kept, poll healthy', () => {
    const c = mcfg([['w-ada', 'Ada', 'coordinator']]);
    fake.terminal('ada');
    fake.cursors.set('w-ada', 100);
    const seeded = Date.now() - AGO_21MIN;
    seedLiveness(c, { 'w-ada': { idleSince: seeded, handle: 'term_ada' } });
    fake.cursorNulls.add('w-ada'); // channelReadState: null — unknown, not zero
    const out = poll(c);
    expect(out.liveness).toEqual([]);
    expect(fake.sent).toEqual([]);
    expect(out.adopted).toBe(true); // the poll itself is healthy; only the candidate is suppressed
    expect(logs.filter((l) => l.includes('liveness')).length).toBeGreaterThan(0); // the reason logged
    logs.length = 0;
    poll(c);
    expect(logs.filter((l) => l.includes('liveness'))).toHaveLength(0); // once per reason, not per poll
    expect(readLiveness(c)['w-ada'].idleSince).toBe(seeded); // the clock kept aging through the outage
    fake.cursorNulls.clear();
    expect(poll(c).liveness).toEqual(['Ada']); // fires on recovery — the episode never restarted
  });

  it('fail-closed liveness source: a failed channel-head query is no candidate this poll and does not throw', () => {
    const c = mcfg([['w-ada', 'Ada', 'coordinator']]);
    fake.terminal('ada');
    fake.cursors.set('w-ada', 100);
    seedLiveness(c, { 'w-ada': { idleSince: Date.now() - AGO_21MIN, handle: 'term_ada' } });
    fake.headOk = false;
    expect(poll(c).liveness).toEqual([]);
    expect(fake.sent).toEqual([]);
    expect(poll(c).adopted).toBe(true); // still a healthy poll
  });

  it('an UNTRACKED flagged terminal still wakes: the #1823 screen fallback proves idle at probe and gates', () => {
    const c = mcfg([['w-ada', 'Ada', 'coordinator']]);
    fake.terminal('ada', 'claude', undefined, false); // lastOutputAt null — tracking lost
    fake.cursors.set('w-ada', 100);
    seedLiveness(c, { 'w-ada': { idleSince: Date.now() - AGO_21MIN, handle: 'term_ada' } });
    expect(poll(c).liveness).toEqual(['Ada']);
  });

  it('a replaced terminal restarts the clock: the idle episode is measured on one continuous terminal', () => {
    const c = mcfg([['w-ada', 'Ada', 'coordinator']]);
    fake.terminal('ada', 'claude', 'term_new');
    fake.cursors.set('w-ada', 100);
    seedLiveness(c, { 'w-ada': { idleSince: Date.now() - AGO_21MIN, handle: 'term_old' } });
    const out = poll(c);
    expect(out.liveness).toEqual([]); // handle mismatch ⇒ fresh clock on the new terminal
    const rec = readLiveness(c)['w-ada'];
    expect(rec.handle).toBe('term_new');
    expect(rec.idleSince).toBeGreaterThan(Date.now() - 60_000);
  });

  it('removing the roster flag resets the watch: records are pruned from liveness.json', () => {
    const c = mcfg([['w-ada', 'Ada', 'coordinator']]);
    fake.terminal('ada');
    fake.cursors.set('w-ada', 100);
    seedLiveness(c, {
      'w-ada': { idleSince: Date.now() - AGO_21MIN, handle: 'term_ada' },
      'w-gone': { idleSince: 1, handle: 'x' },
    });
    const unflagged = mcfg([['w-ada', 'Ada', undefined]]); // same stateDir
    poll(unflagged);
    expect(readLiveness(unflagged)).toEqual({}); // pruned: no flagged workers ⇒ no records
  });

  // ── #1829 local-seat cycle 1 (Xylon #9736) ─────────────────────────────

  it('P1-1: a GraphQL errors+data response never passes as live — no candidate, clock kept', () => {
    const c = mcfg([['w-ada', 'Ada', 'coordinator']]);
    fake.terminal('ada');
    fake.cursors.set('w-ada', 100);
    const seeded = Date.now() - AGO_21MIN;
    seedLiveness(c, { 'w-ada': { idleSince: seeded, handle: 'term_ada' } });
    fake.cursorErrors.add('w-ada'); // partial data WITH an error rides the same integer
    const out = poll(c);
    expect(out.liveness).toEqual([]);
    expect(fake.sent).toEqual([]);
    expect(readLiveness(c)['w-ada'].idleSince).toBe(seeded); // fail-closed, not a reset
    fake.cursorErrors.clear();
    expect(poll(c).liveness).toEqual(['Ada']); // fires on recovery
  });

  it('P1-1: a NEGATIVE lastSeenSeq is not a cursor — no candidate', () => {
    const c = mcfg([['w-ada', 'Ada', 'coordinator']]);
    fake.terminal('ada');
    fake.cursors.set('w-ada', -5); // parsed, integer, nonsense
    seedLiveness(c, { 'w-ada': { idleSince: Date.now() - AGO_21MIN, handle: 'term_ada' } });
    expect(poll(c).liveness).toEqual([]);
    expect(fake.sent).toEqual([]);
  });

  it('P1-1: a non-zero exit with parsable stdout fails the RECOMPUTE, so the poll throws and nothing sends', () => {
    const c = mcfg([['w-ada', 'Ada', 'coordinator']]);
    fake.terminal('ada');
    fake.cursors.set('w-ada', 100);
    seedLiveness(c, { 'w-ada': { idleSince: Date.now() - AGO_21MIN, handle: 'term_ada' } });
    // Candidacy passes on the clean read; the recompute's head query then exits
    // non-zero while still printing a JSON body.
    const base = fake.run;
    let served = false;
    fake.run = (argv) => {
      const r = base(argv);
      if (argv[1] === 'api' && argv[2].includes('channel(ref') && served) return { ...r, code: 1 };
      if (argv[1] === 'api' && argv[2].includes('channelReadState')) served = true;
      return r;
    };
    expect(() => poll(c)).toThrow(RouterError);
    expect(fake.sent).toEqual([]);
  });

  it('P2-2: a syntactically-valid CORRUPT record never suppresses delivery — only typed fields survive the read', () => {
    const c = mcfg([['w-ada', 'Ada', 'coordinator']]);
    fake.terminal('ada');
    fake.cursors.set('w-ada', 100);
    // A huge frontier (above any real seq) and a string handle: both drop on
    // read, so the worker cannot look covered forever (fail-closed direction).
    seedLiveness(c, { 'w-ada': { idleSince: Date.now() - AGO_21MIN, handle: 'term_ada', coveredFrontier: 9007199254740991 } });
    expect(poll(c).liveness).toEqual(['Ada']);
    expect(readLiveness(c)['w-ada'].coveredFrontier).toBe(120); // the honest frontier the send recorded
  });

  it('P2-2: a corrupt liveness.json top level (null / array / non-object record) reads as fresh and never crashes', () => {
    const c = mcfg([['w-ada', 'Ada', 'coordinator'], ['w-baloo', 'Baloo', 'coordinator']]);
    fake.terminal('ada');
    fake.terminal('baloo');
    fake.cursors.set('w-ada', 100);
    mkdirSync(c.stateDir, { recursive: true });
    writeFileSync(join(c.stateDir, 'liveness.json'), 'null'); // top-level null once crashed Object.keys
    expect(poll(c).liveness).toEqual([]); // fresh clocks, no throw
    expect(typeof readLiveness(c)['w-ada'].idleSince).toBe('number');
    seedLiveness(c, { 'w-ada': 5, 'w-baloo': ['x'] }); // non-object records
    const out = poll(c);
    expect(out.liveness).toEqual([]);
    expect(out.held).toEqual({});
    const rec = readLiveness(c)['w-ada'];
    expect(rec.idleSince).toBeGreaterThan(Date.now() - 60_000); // re-seeded by the probe, not carried
  });

  it('P2-4: a terminal replaced between the probe and the chain RESETS the clock — the episode is one terminal\'s', () => {
    const c = mcfg([['w-ada', 'Ada', 'coordinator']]);
    fake.terminal('ada');
    fake.cursors.set('w-ada', 100);
    seedLiveness(c, { 'w-ada': { idleSince: Date.now() - AGO_21MIN, handle: 'term_ada' } });
    fake.renameTerminalsFromList = 2; // the probe's list shows term_ada; the chain's shows term_ada_r
    const out = poll(c);
    expect(out.liveness).toEqual([]);
    expect(fake.sent).toEqual([]);
    expect(out.held).toEqual({}); // a reset, not a delivery failure
    expect(readLiveness(c)['w-ada'].idleSince).toBeUndefined();
  });

  it('P2-5: a FIRST-EVER record born from a mention collapse carries the handle — the next probe keeps the clock', () => {
    const c = mcfg([['w-ada', 'Ada', 'coordinator']]);
    fake.terminal('ada');
    fake.attention.workers = [worker('w-ada', 'Ada', { mentions: 1, unread: 4 })];
    fake.cursors.set('w-ada', 100);
    const out = poll(c); // no seeded record: the collapse write is its first
    expect(out.nudged).toEqual(['Ada']);
    const born = readLiveness(c)['w-ada'];
    expect(born.handle).toBe('term_ada');
    const at = born.idleSince;
    expect(at).toBeGreaterThan(Date.now() - 60_000);
    fake.attention.workers = []; // nothing new; the clock must survive the next probe
    poll(c);
    expect(readLiveness(c)['w-ada'].idleSince).toBe(at); // NOT restarted by a handle mismatch
  });

  it('P2-7: coordinatorWatchMinutes must be a JSON number whose ms product is finite — true, "20" and the overflow class throw', () => {
    const path = join(root, 'c.json');
    const write = (over: Record<string, unknown>) => {
      writeFileSync(path, JSON.stringify({
        app: 'a', channel: 'c', stateDir: join(root, 's'),
        roster: [{ worker: 'w', name: 'E', worktree: '/x' }], ...over,
      }));
      return path;
    };
    expect(loadConfig(write({})).coordinatorWatchMinutes).toBe(20);
    expect(loadConfig(write({ coordinatorWatchMinutes: 5.5 })).coordinatorWatchMinutes).toBe(5.5);
    // 1e307 × 60_000 overflows to Infinity — the class whose comparison
    // against elapsed time silently disables delivery. (A finite-but-huge
    // window stays legal: it is coherent config, equivalent to the rule off.)
    for (const bad of [true, '20', 1e307, [20]]) {
      expect(() => loadConfig(write({ coordinatorWatchMinutes: bad }))).toThrow(RouterError);
    }
  });
});

describe('loadConfig — liveness configuration (#1826)', () => {
  const write = (over: Record<string, unknown>) => {
    const path = join(root, 'c.json');
    writeFileSync(path, JSON.stringify({
      app: 'a', channel: 'c', stateDir: join(root, 's'),
      roster: [{ worker: 'w', name: 'E', worktree: '/x' }], ...over,
    }));
    return path;
  };
  it('defaults coordinatorWatchMinutes to 20 and accepts positive finite numbers', () => {
    expect(loadConfig(write({})).coordinatorWatchMinutes).toBe(20);
    expect(loadConfig(write({ coordinatorWatchMinutes: 5.5 })).coordinatorWatchMinutes).toBe(5.5);
  });
  it('rejects a non-positive or non-finite coordinatorWatchMinutes, loudly', () => {
    for (const bad of [0, -3, 'abc', null]) {
      expect(() => loadConfig(write({ coordinatorWatchMinutes: bad }))).toThrow(RouterError);
    }
  });
  it('roster flags must be booleans', () => {
    const flagged = loadConfig(write({ roster: [{ worker: 'w', name: 'E', worktree: '/x', coordinator: true }] }));
    expect(flagged.roster[0].coordinator).toBe(true);
    expect(() => loadConfig(write({ roster: [{ worker: 'w', name: 'E', worktree: '/x', coordinator: 'yes' }] }))).toThrow(RouterError);
    expect(() => loadConfig(write({ roster: [{ worker: 'w', name: 'E', worktree: '/x', lifecycle: 1 }] }))).toThrow(RouterError);
  });
});

describe('#1845 — the terminal pin: a roster row may name its MAIN terminal', () => {
  // The pin resolves FIRST, before identity and the screen, so it survives the
  // agentIdentity flap and the two-family ambiguity — the Atilla case: five
  // busy-misread holds in one day on a terminal whose identity was lost, where
  // every screen fallback failed on completed-turn chrome (Yuri #10736).
  const pinned = (handle?: string) => {
    const c = cfg(['w-eli', 'Eli']);
    if (handle) c.roster[0]!.terminal = handle;
    return c;
  };

  it('a pin resolves a TWO-AGENT worktree the identity resolver must refuse as ambiguous (the review-spawn case)', () => {
    const c = pinned('term_eli');
    fake.terminal('eli', 'claude');
    // A codex review spawn in the SAME worktree: two agent identities, one
    // worktree — the identity resolver holds 'ambiguous' without a pin, and
    // the screen fallback would too (both families present = hold).
    const eliWt = fake.terminals[fake.terminals.length - 1]!.worktreePath!;
    fake.terminals.push({
      handle: 'term_spawn', worktreePath: eliWt, agentIdentity: 'codex', connected: true, writable: true,
      lastOutputAt: Date.now(),
    });
    fake.screens.set('term_spawn', { tail: CODEX_IDLE });
    fake.attention.workers = [worker('w-eli', 'Eli', { mentions: 1, unread: 3 })];
    const unpinned = cfg(['w-eli', 'Eli']);
    expect(poll(unpinned).held.Eli).toContain('ambiguous');
    expect(fake.sent).toEqual([]);
    const out = poll(c);
    expect(out.nudged).toEqual(['Eli']);
    expect(sentHandles()).toEqual(['term_eli']);
  });

  it('a pin whose handle lives in ANOTHER worktree never resolves — it falls through as stale', () => {
    const c = pinned('term_other');
    fake.terminal('eli', null);
    fake.terminal('other', 'claude'); // exists, but not in Eli's worktree
    // A plain shell screen: the fallback refuses shells, so the stale pin
    // surfaces in the hold reason instead of being silently rescued.
    fake.screens.set('term_eli', { tail: ['orca@orca1:~/ws/eli$ '] });
    fake.attention.workers = [worker('w-eli', 'Eli', { mentions: 1, unread: 3 })];
    const out = poll(c);
    expect(out.nudged).toEqual([]);
    expect(fake.sent).toEqual([]);
    expect(out.held.Eli).toContain('pinned handle is stale');
  });

  it('a pin and a healthy identity agree on the same terminal — the pin simply wins first', () => {
    const c = pinned('term_eli');
    fake.terminal('eli', 'codex');
    fake.attention.workers = [worker('w-eli', 'Eli', { mentions: 1, unread: 3 })];
    const out = poll(c);
    expect(out.nudged).toEqual(['Eli']);
    expect(sentHandles()).toEqual(['term_eli']);
    // The identity flows as the family for the idle gates.
    const [h, detail, via] = resolveTerminal(c.roster[0]!, fake.terminals as unknown as Terminal[], c, fake.run);
    expect([h, via]).toEqual(['term_eli', 'pin']);
    expect(detail).toBe('codex');
  });

  it('a pin on an identity-lost, UNTRACKED terminal derives the family from ONE screen read and still proves idle', () => {
    const c = pinned('term_eli');
    fake.terminal('eli', null, 'term_eli', false); // flap AND untracked (#7398 regime)
    fake.screens.set('term_eli', { tail: CODEX_IDLE });
    fake.attention.workers = [worker('w-eli', 'Eli', { mentions: 1, unread: 3 })];
    const out = poll(c);
    expect(out.nudged).toEqual(['Eli']);
    expect(sentHandles()).toEqual(['term_eli']);
  });

  it('a pin never bypasses the guard chain: a busy pinned terminal holds', () => {
    const c = pinned('term_eli');
    fake.terminal('eli', 'codex');
    fake.busy.add('term_eli');
    fake.screens.set('term_eli', { tail: CLAUDE_BUSY_EMPTY });
    fake.attention.workers = [worker('w-eli', 'Eli', { mentions: 1, unread: 3 })];
    const out = poll(c);
    expect(out.nudged).toEqual([]);
    expect(fake.sent).toEqual([]);
    expect(out.held.Eli).toBeTruthy();
  });

  it('loadConfig rejects a non-string pin and two rows pinning one terminal', () => {
    const write = (roster: unknown) => {
      const path = join(root, 'c.json');
      writeFileSync(path, JSON.stringify({ app: 'a', channel: 'c', stateDir: join(root, 's'), roster }));
      return path;
    };
    expect(() => loadConfig(write([{ worker: 'w', name: 'E', worktree: '/x', terminal: 7 }]))).toThrow(/"terminal" must be a non-empty/);
    expect(() => loadConfig(write([
      { worker: 'w1', name: 'E', worktree: '/x', terminal: 'term_t' },
      { worker: 'w2', name: 'F', worktree: '/y', terminal: 'term_t' },
    ]))).toThrow(/pins one terminal for two workers/);
  });

  it('an unpinned row is untouched — resolution order and reasons identical to before', () => {
    const c = pinned(); // no terminal field
    fake.terminal('eli', 'claude');
    fake.attention.workers = [worker('w-eli', 'Eli', { mentions: 1, unread: 3 })];
    const out = poll(c);
    expect(out.nudged).toEqual(['Eli']);
    const [, , via] = resolveTerminal(c.roster[0]!, fake.terminals as unknown as Terminal[], c, fake.run);
    expect(via).toBe('identity');
  });
});

describe('per-call hard timeout (2026-10-14 wedged-cycle incidents)', () => {
  it('bounds every child call at 90s — ≥ busyWaitMs + margin, never the old 300s', () => {
    // The 300_000 backstop let a slow/502ing gateway hang each call for five
    // minutes; ~180 calls/cycle × a few hangs = 45+ minute cycles. 90s covers
    // the one legitimately long call (the 60s busy-wait) with margin.
    expect(CALL_TIMEOUT_MS).toBe(90_000);
    expect(CALL_TIMEOUT_MS).toBeLessThan(300_000);
    expect(CALL_TIMEOUT_MS).toBeGreaterThanOrEqual(MIN_CALL_TIMEOUT_MS);
    expect(60_000).toBeLessThanOrEqual(CALL_TIMEOUT_MS - 15_000); // busyWaitMs's default (loadConfig: raw.busyWaitMs ?? 60_000)
  });
  it('a killed/timed-out child reads as code 1 with empty output — the fail-closed shape every consumer already handles', () => {
    expect(runCommand(['false']).code).not.toBe(0);
    expect(runCommand(['/nonexistent/binary']).code).not.toBe(0);
    expect(runCommand(['/nonexistent/binary']).stdout).toBe('');
  });
});

describe('#1940 — reported prune is keyed by NAME (Joshua port-find)', () => {
  it('a worker re-held with a REPEAT reason after leaving the held set logs the fresh hold line', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli');
    fake.busy.add('term_eli');
    fake.screens.set('term_eli', { tail: CLAUDE_BUSY_EMPTY });
    fake.attention.workers = [worker('w-eli', 'Eli')];
    poll(c); // held once: reported['Eli'] = <busy reason>
    const st = new State(c.stateDir);
    const ledger = st.ledger();
    expect(Object.keys(ledger.reported ?? {})).toContain('Eli'); // keyed by NAME
    // The worker recovers (leaves the held set entirely): the prune must drop
    // the reported entry by name, or a later SAME-reason hold stays silent.
    fake.busy.clear();
    fake.screens.set('term_eli', { tail: CLAUDE_IDLE });
    fake.attention.workers = [worker('w-eli', 'Eli', { mentions: 1, unread: 3, relevant: 105 })];
    poll(c); // nudged: leaves the held set
    const after = new State(c.stateDir).ledger();
    expect(after.heldSince['w-eli']).toBeUndefined();
    expect(after.reported['Eli']).toBeUndefined(); // the id-keyed delete was a no-op before this fix
  });
});

describe('#1940 fix cycle — the timeout kill is hard and its result fail-closed', () => {
  it('a SIGTERM-IGNORING child that prints success JSON is killed and reads as code 1 with EMPTY stdout (Andi P2-1+2, Chip repro)', () => {
    // The production wrapper runs node; a tiny script that traps SIGTERM and
    // prints success JSON reproduces both P2s in one child: without the fix,
    // the catchable SIGTERM lets it overrun and exit 0 with output retained.
    const script = [
      'process.on("SIGTERM", () => { /* ignore: we are a wedged child */ });',
      'process.stdout.write(JSON.stringify({ ok: true }));',
      'setTimeout(() => { process.exit(0); }, 500);',
    ].join('');
    // Scaled-down bound (Chip's repro approach): 150ms bound vs a child that
    // ignores SIGTERM and would run 500ms — only the hard kill can stop it.
    const res = runCommand([process.execPath, '-e', script], 150);
    expect(res.code).toBe(1);
    expect(res.stdout).toBe('');
    expect(res.stderr).toMatch(/killed|ETIMEDOUT|call failed/); // killed at the bound — the message names the failure either way
  }, 30_000);
  it('a normally-exiting child is untouched by the kill path', () => {
    const res = runCommand([process.execPath, '-e', 'process.stdout.write("fine")']);
    expect(res.code).toBe(0);
    expect(res.stdout).toBe('fine');
  });
});

describe('#1940 cycle 2 — ANY proc.error is fail-closed (Andi #12271, Chip #12273)', () => {
  it('a spawn error with retained success JSON on the pipe reads as code 1 with EMPTY stdout', () => {
    // ENOENT: the binary does not exist — spawnSync sets proc.error with the
    // child never running. To also cover the error-with-output shape Chip
    // injected (ENOBUFS mid-write), assert the general contract on ENOENT
    // and the pipe-error equivalence in one rule: proc.error => empty stdout.
    const res = runCommand(['/nonexistent/binary/that/does/not/exist']);
    expect(res.code).toBe(1);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('call failed');
  });
  it('a SUCCESSFUL call is untouched by the error arm (control)', () => {
    const res = runCommand([process.execPath, '-e', 'process.stdout.write(JSON.stringify({ok:true}))']);
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({ ok: true });
  });
});

describe('Orca attention router — empty-composer rule pinned to the real cli#907 captures (bcabaf4)', () => {
  const load = (name: string): Record<string, any> =>
    JSON.parse(readFileSync(new URL(`./testdata/cli907-scratch-2026-10-18/${name}.json`, import.meta.url), 'utf8')).result.terminal;
  it.each([
    ['c01-start', 'claude', true],
    ['c30-restart', 'claude', true],
    ['c33-bs-on-empty', 'claude', true],
    ['c02-draft', 'claude', false],
    ['c09-multiline', 'claude', false],
    ['c20-askuser', 'claude', false],
    ['x01-start', 'codex', true],
    ['x02-draft', 'codex', false],
  ] as const)('%s (%s) empty=%s', (name, agent, empty) => {
    expect(promptIsEmptyFromTerm(load(name), agent)[0]).toBe(empty);
  });
});

// #1533 item 1: a Claude Code turn started by a prompt always ends with assistant
// text shown to the human, so "finish silently" / a ban on any "read/no-action"
// comment can never be satisfied. Every nudge ending must name an action a turn CAN
// perform: end with one short line, and keep the team-chat prohibition (the half
// that matters) word for word.
describe('nudge endings are satisfiable (#1533)', () => {
  const small = nudgeText(worker('w-eli', 'Eli', { mentions: 2, unread: 5, first: 100, relevant: 110, head: 120 }));
  const large = nudgeText(worker('w-eli', 'Eli', { mentions: 2, unread: 9841, first: 61, relevant: 9750, head: 9901 }));
  const liveness = livenessNudgeText(100, 120);
  const variants: Array<[string, string]> = [['small-gap', small], ['large-gap', large], ['liveness', liveness]];

  for (const [name, text] of variants) {
    it(`${name}: no unsatisfiable "finish silently" / "read/no-action comment" wording`, () => {
      expect(text).not.toMatch(/finish silently/i);
      expect(text).not.toContain("'read/no-action' comment");
    });
    it(`${name}: names a satisfiable ending and still forbids a team-chat post`, () => {
      expect(text).toContain('end with one short line');
      expect(text).toContain('do not post to team chat');
    });
  }

  it('liveness keeps its invariant: "mark read" appears exactly once', () => {
    expect((liveness.match(/mark read/gi) ?? []).length).toBe(1);
  });
});

describe('#2613 — the open-task line on every router wake', () => {
  const open = (worker: string, n: number, status = 'STARTED') =>
    Array.from({ length: n }, (_, i) => ({ id: `t${i}`, status, assignee: { kind: 'WORKER', id: worker } }));
  const LINE = (n: number) => ` You have ${n} open task${n === 1 ? '' : 's'} (as read when this was sent); run \`hadron team task mine\`.`;

  it('appends the line to a mention wake, after the existing instructions, read for the DELIVERED worker and the App', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli');
    fake.attention.workers = [worker('w-eli', 'Eli', { mentions: 2, unread: 5 })];
    fake.openTasks.set('w-eli', [...open('w-eli', 2), { id: 'p', status: 'PENDING', assignee: { kind: 'WORKER', id: 'w-eli' } }]);
    poll(c);
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0][1]).toBe(nudgeText(worker('w-eli', 'Eli', { mentions: 2, unread: 5 })) + LINE(3));
    expect(fake.sent[0][1].startsWith(nudgeText(worker('w-eli', 'Eli', { mentions: 2, unread: 5 })))).toBe(true);
    expect(fake.openTaskReads).toEqual([['hrn:app:x:team', 'w-eli', '0']]);
  });

  it('appends the line to the LARGE GAP wake', () => {
    const w = worker('w-eli', 'Eli', { mentions: 2, unread: 9841, first: 61, relevant: 9750, head: 9901 });
    expect(nudgeText(w, LINE(1))).toBe(nudgeText(w) + LINE(1));
    expect(nudgeText(w, LINE(1))).toContain('LARGE GAP');
  });

  it('appends the line to the idle-watch wake', () => {
    expect(livenessNudgeText(100, 120, LINE(2))).toBe(livenessNudgeText(100, 120) + LINE(2));
  });

  it('zero open tasks: the wake is byte-identical to today', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli');
    fake.attention.workers = [worker('w-eli', 'Eli', { mentions: 2, unread: 5 })];
    poll(c);
    expect(fake.sent[0][1]).toBe(nudgeText(worker('w-eli', 'Eli', { mentions: 2, unread: 5 })));
  });

  it('counts only this worker: another worker, FINISHED, CANCELLED, BACKLOG and unassigned never reach the count', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli');
    fake.attention.workers = [worker('w-eli', 'Eli', { mentions: 2, unread: 5 })];
    // The server filters; a row it should not have returned makes the count unknown, never a guess.
    fake.openTasks.set('w-eli', [...open('w-eli', 1), { id: 'x', status: 'FINISHED', assignee: { kind: 'WORKER', id: 'w-eli' } }]);
    poll(c);
    expect(fake.sent[0][1]).not.toContain('open task');
  });

  it('a refused count read still delivers the wake, with no count claim and no "none"', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli');
    fake.attention.workers = [worker('w-eli', 'Eli', { mentions: 2, unread: 5 })];
    fake.openTasksFail = true;
    const out = poll(c);
    expect(out.nudged).toEqual(['Eli']);
    expect(fake.sent[0][1]).toBe(nudgeText(worker('w-eli', 'Eli', { mentions: 2, unread: 5 })));
    expect(fake.sent[0][1]).not.toMatch(/open task|none|\b0 /);
  });

  it('a refused count read logs ONE closed-reason line with the worker name and nothing the read returned (#2630)', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli');
    fake.attention.workers = [worker('w-eli', 'Eli', { mentions: 2, unread: 5 })];
    fake.openTasksFail = true;
    poll(c);
    const diag = logs.filter((l) => l.includes('open-task count unknown'));
    expect(diag).toEqual(['orca-attention-router: Eli: open-task count unknown (refused); the wake goes without the line']);
    expect(logs.join('\n')).not.toContain('tasks down');
    expect(fake.sent).toHaveLength(1); // fail-open
  });

  it('a count or a zero logs no diagnostic (#2630)', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli');
    fake.attention.workers = [worker('w-eli', 'Eli', { mentions: 2, unread: 5 })];
    fake.openTasks.set('w-eli', open('w-eli', 2));
    poll(c);
    expect(logs.filter((l) => l.includes('open-task count unknown'))).toEqual([]);
  });

  it('pages: 201 open tasks read as 201, through two page reads', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli');
    fake.attention.workers = [worker('w-eli', 'Eli', { mentions: 2, unread: 5 })];
    fake.openTasks.set('w-eli', open('w-eli', 201));
    poll(c);
    expect(fake.sent[0][1]).toContain('You have 201 open tasks');
    expect(fake.openTaskReads.map((r) => r[2])).toEqual(['0', '200']);
  });

  it('a claude and a codex terminal receive the same text', () => {
    const c = cfg(['w-eli', 'Eli'], ['w-gene', 'Gene']);
    fake.terminal('eli');
    fake.terminal('gene', 'codex');
    fake.attention.workers = [worker('w-eli', 'Eli', { mentions: 2, unread: 5 }), worker('w-gene', 'Gene', { mentions: 2, unread: 5 })];
    fake.openTasks.set('w-eli', open('w-eli', 2));
    fake.openTasks.set('w-gene', open('w-gene', 2));
    poll(c);
    const tail = (h: string) => fake.sent.find(([x]) => x === h)![1].replace(/Eli|Gene/g, 'X');
    expect(fake.sent).toHaveLength(2);
    expect(tail('term_eli')).toBe(tail('term_gene'));
    expect(tail('term_eli')).toContain('You have 2 open tasks');
  });

  it('reads the count BEFORE the final idle and composer rechecks, never between the last gate and the send (LOCAL P2-1)', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli');
    fake.attention.workers = [worker('w-eli', 'Eli', { mentions: 2, unread: 5 })];
    fake.openTasks.set('w-eli', open('w-eli', 1));
    poll(c);
    const verbs = fake.calls.map((a) => (a[1] === 'api' && a[2].includes('agentTasks(') ? 'count' : a.slice(1, 3).join(' ')));
    const count = verbs.indexOf('count');
    expect(count).toBeGreaterThan(-1);
    expect(verbs.lastIndexOf('terminal wait')).toBeGreaterThan(count); // the idle recheck follows the count
    expect(verbs.lastIndexOf('terminal read')).toBeGreaterThan(count); // so does the composer recheck
    expect(verbs.indexOf('terminal send')).toBeGreaterThan(verbs.lastIndexOf('terminal read'));
    expect(verbs.slice(count + 1, verbs.indexOf('terminal send')).includes('count')).toBe(false);
  });
});

