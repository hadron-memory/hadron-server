/**
 * The Orca router's shared helpers that survive the #2030 (C6) retirement of the attention loop: the roster
 * config loader, the per-call timeout and the empty-composer rule pinned to the real cli#907 captures. The
 * screen-verdict cases that used to run through the loop live in terminalHelpers.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CALL_TIMEOUT_MS, RouterError, loadConfig, promptIsEmptyFromTerm, promptLineIsEmpty, runCommand, screenAgentFamily } from './router.js';

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

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'orca-router-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

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

describe('per-call hard timeout (2026-10-14 wedged-cycle incidents)', () => {
  it('bounds every child call at 90s — ≥ busyWaitMs + margin, never the old 300s', () => {
    // The 300_000 backstop let a slow/502ing gateway hang each call for five
    // minutes; ~180 calls/cycle × a few hangs = 45+ minute cycles. 90s covers
    // the one legitimately long call (the 60s busy-wait) with margin.
    expect(CALL_TIMEOUT_MS).toBe(90_000);
    expect(CALL_TIMEOUT_MS).toBeLessThan(300_000);
    expect(CALL_TIMEOUT_MS).toBeGreaterThanOrEqual(75_000);
    expect(60_000).toBeLessThanOrEqual(CALL_TIMEOUT_MS - 15_000); // busyWaitMs's default (loadConfig: raw.busyWaitMs ?? 60_000)
  });
  it('a killed/timed-out child reads as code 1 with empty output — the fail-closed shape every consumer already handles', () => {
    expect(runCommand(['false']).code).not.toBe(0);
    expect(runCommand(['/nonexistent/binary']).code).not.toBe(0);
    expect(runCommand(['/nonexistent/binary']).stdout).toBe('');
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

// Pure unit tests that the retired attention loop's test file held next to its loop tests (#2030 C6). They cover
// helpers ticker-wake still imports (promptLineIsEmpty, via promptIsEmptyFromTerm; loadConfig), so they stay,
// restored verbatim from the file at origin/main.
describe('promptLineIsEmpty: incident-derived empty-prompt cases (#5473, #1555, #5724)', () => {
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
});

describe('loadConfig: roster, pin and coordinator-watch validation', () => {
  const write = (over: Record<string, unknown>) => {
    const path = join(root, 'c.json');
    writeFileSync(path, JSON.stringify({
      app: 'a', channel: 'c', stateDir: join(root, 's'),
      roster: [{ worker: 'w', name: 'E', worktree: '/x' }], ...over,
    }));
    return path;
  };
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
});
