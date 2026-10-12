/**
 * The Orca attention router. No network, no Orca: a fake runner plays both
 * `hadron team attention` and `orca terminal list|wait|send`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir, uptime } from 'node:os';
import { join } from 'node:path';
import { nudgeText,
  type Config, type Runner, type RunResult, type Terminal, RouterError, State, breakStaleLock, describeOutcome, loadConfig, pollOnce,
  promptLineIsEmpty, resolveTerminal, screenAgentFamily, status,
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
    if (argv[1] === 'api') {
      this.sawWait = false; // a new target begins; its fresh scan (if any) follows its idle gate
      if (this.registerFails.size && this.registerFails.has(argv[argv.indexOf('-F') + 1].replace(/^w=/, ''))) {
        return out({ errors: [{ message: 'register down' }] }, 1);
      }
      // attendeeRegister: the winning row for the team Channel.
      const w = argv[argv.indexOf('-F') + 1].replace(/^w=/, '');
      const ids = this.mentionOnly ?? new Set(['w-eli', 'w-baloo', 'w-ada']);
      const row = this.registerRow?.(w) ?? { namedBy: 'WORKER', channel: { id: CHANNEL }, entry: { mentionOnly: ids.has(w) } };
      return out({ data: { attendeeRegister: [row] } });
    }
    if (verb === 'terminal list') {
      this.listCalls++;
      const terminals = this.listCalls > 1 && this.healTracking.size
        ? this.terminals.map((t) => (this.healTracking.has(t.handle as string) ? { ...t, lastOutputAt: Date.now() } : t))
        : this.terminals;
      return out({ ok: true, result: { terminals } });
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
    busyWaitMs: 10, submitWaitS: 1,
  };
}
const poll = (c: Config) => pollOnce(c, fake.run, (l) => logs.push(l));
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
    expect(fake.sent[0][1]).toContain("no chat post or 'read/no-action' comment");
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

  it('a TRACKED terminal that times out still holds as busy — the fallback never widens that', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli'); // tracked
    fake.busy.add('term_eli');
    fake.attention.workers = [worker('w-eli', 'Eli')];
    const out = poll(c);
    expect(out.held.Eli).toContain('busy for');
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
    const out = poll(c);
    expect(out.nudged).toEqual([]);
    expect(out.held.Eli).toContain('busy again after the recompute (busy for');
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
    fake.busy.add('term_baloo'); // hold the token so the ledger's base (and its rows) survive to be read
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

  it('a STALE draft does not pin a Claude worker: a screen that proves the composer empty refutes it (#6736)', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli');
    fake.attention.workers = [worker('w-eli', 'Eli', { mentions: 1, unread: 2, relevant: 110 })];
    // Orca's draft carries text no client shows; the rendered box is bare and
    // the agents hint is up — Claude draws typed text on the ❯ line, so this
    // draft cannot be pending input.
    fake.screens.set('term_eli', { tail: CLAUDE_IDLE, draft: 'mark #1625 ready, do not wait' });
    const out = poll(c);
    expect(out).toMatchObject({ nudged: ['Eli'], adopted: true });
    expect(fake.sent).toHaveLength(1);
    expect(logs.join('\n')).toContain('Eli: stale Orca draft discarded');
    expect(logs.join('\n')).not.toContain('mark #1625'); // the draft's text is never logged
  });

  it('the stale-discard note logs once per token, and a draft that matches the box still pins (Claude)', () => {
    const c = cfg(['w-eli', 'Eli'], ['w-baloo', 'Baloo']);
    fake.terminal('eli');
    fake.terminal('baloo');
    fake.attention.workers = [worker('w-eli', 'Eli', { relevant: 110 }), worker('w-baloo', 'Baloo', { relevant: 115 })];
    fake.screens.set('term_eli', { tail: CLAUDE_IDLE, draft: 'anything stale' });
    // Baloo's box RENDERS text — the draft is corroborated, not refuted.
    fake.screens.set('term_baloo', { tail: withPrompt(CLAUDE_IDLE, '❯', 'typed words'), draft: 'typed words' });
    const first = poll(c);
    expect(first).toMatchObject({ nudged: ['Eli'] });
    expect(first.held.Baloo).toContain('text in the composer draft');
    expect(logs.filter((l) => l.includes('stale Orca draft discarded'))).toHaveLength(1);
    fake.attention.workers = [worker('w-baloo', 'Baloo', { relevant: 120 })];
    poll(c);
    expect(logs.filter((l) => l.includes('stale Orca draft discarded'))).toHaveLength(1); // once per token
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
    fake.attention.workers = [worker('w-eli', 'Eli')];
    poll(c); // held: busy
    const st = new State(c.stateDir);
    const ledger = st.ledger();
    ledger.heldSince['w-eli'] = Date.now() - 41 * 60_000; // backdate the hold
    st.saveLedger(ledger);
    logs.length = 0;
    poll(c);
    expect(logs.join('\n')).toMatch(/Eli held 4[01] min with mentions pending \(busy/);
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

  it('Claude: a box that looks empty holds whitespace unless the empty-input hint shows (Chip #5756, live 2026-10-01)', () => {
    // Three spaces typed: the box renders a bare `❯`, and only the hint vanished.
    expect(promptLineIsEmpty([RULE, '❯', RULE, '  ⏵⏵ bypass permissions on (shift+tab to cycle)'], 'claude')).toBe(false);
    // The hint is present in every permission mode while empty.
    for (const mode of ['⏵⏵ auto mode on (shift+tab to cycle)', '⏸ manual mode on', '⏵⏵ accept edits on (shift+tab to cycle)', '⏸ plan mode on (shift+tab to cycle)']) {
      expect(promptLineIsEmpty([RULE, '❯', RULE, `  ${mode} · ← for agents`], 'claude')).toBe(true);
      expect(promptLineIsEmpty([RULE, '❯', RULE, `  ${mode}`], 'claude')).toBe(false);
    }
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
