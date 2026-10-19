import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config, Runner } from '../orca-attention-router/router.js';
import { buildSchema, parse, validate } from 'graphql';
import { typeDefs } from '../../src/api/graphql/schema/typeDefs.js';
import { pass, main, acquireLock, proofTicks, QUERY, ACK } from './ticker-wake.js';

const RULE = '─'.repeat(112);
// A finished Claude Code 2.1.303 turn over an empty composer (shapes from the cli#907 captures): the
// mode footer WITHOUT the transient "· ← for agents" suffix.
const CLAUDE_IDLE = [
  '❯ reply with exactly the word ok', '● ok', '✻ Crunched for 2s · done 11:14 PM',
  RULE, '❯', RULE, '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
];
const TICK = { kind: 'TICK', ticker: { id: 'T', name: 'coordinator-tick' } };
const TICK2 = { kind: 'TICK', ticker: { id: 'U', name: 'eden-queue-tick' } };
const MENTION = { kind: 'MENTION', ticker: null };
const TASK = { kind: 'TASK', ticker: null };
const CONFIRMED = { ok: true, result: { send: { accepted: true, prompt: { requestId: 'r1', stages: ['input_accepted', 'turn_started'] } } } };
const NO_ID_ACCEPTED = { ok: true, result: { send: { accepted: true, prompt: { stages: ['input_accepted'] } } } };
const ACCEPTED_ONLY = { ok: true, result: { send: { accepted: true, prompt: { requestId: 'r1', stages: ['input_accepted'] } } } };

/** A proof whose payload carries the given ticks ("T:k"), like the server's (opaque to everything else). */
const proof = (ticks: string[], salt = 'x') =>
  `${Buffer.from(JSON.stringify({ ticks: ticks.map((t) => ({ tickerId: t.split(':')[0], k: Number(t.split(':')[1]) })), issuedAt: salt })).toString('base64url')}.sig`;

interface Fake {
  run: Runner;
  wakes: any[];
  acked: string[];
  sent: string[];
  idle: boolean;
  screen: Record<string, any>;
  dueQueries: string[];
  pages: number;
  alwaysMore: boolean;
  ackReply: (() => unknown) | null;
  sendReply: (() => string) | null;
  dueError: string | null;
  incarnation: string;
  retries: string[];
  retryReply: (() => string) | null;
}

let dir: string;
let f: Fake;
let lines: string[];

function fake(): Fake {
  const f: Fake = {
    wakes: [], acked: [], sent: [], idle: true, screen: { source: 'screen', tail: CLAUDE_IDLE },
    dueQueries: [], pages: 0, alwaysMore: false, ackReply: null, sendReply: null, dueError: null,
    incarnation: 'inc-1', retries: [], retryReply: null, run: undefined as any,
  };
  f.run = (argv) => {
    const out = (o: unknown) => ({ code: 0, stdout: JSON.stringify(o), stderr: '' });
    if (argv[0] === 'hadron') {
      const q = argv[2];
      if (q.includes('acknowledgeWakes')) {
        if (f.ackReply) return out(f.ackReply());
        const proofs = JSON.parse(argv[argv.indexOf('-F') + 1].replace(/^p=/, ''));
        f.acked.push(...proofs);
        return out({ data: { acknowledgeWakes: { acknowledged: proofs.length, unchanged: 0 } } });
      }
      if (q.includes('dueWakes')) {
        f.dueQueries.push(q);
        f.pages++;
        if (f.dueError) return out({ errors: [{ message: f.dueError }] });
        return out({ data: { dueWakes: { wakes: f.wakes, pageInfo: { hasNextPage: f.alwaysMore, endCursor: 'c' } } } });
      }
    }
    if (argv[0] === 'orca' && argv[1] === 'terminal') {
      if (argv[2] === 'list') {
        return out({ ok: true, result: { terminals: [{ handle: 'term_a', incarnationId: f.incarnation, worktreePath: dir, connected: true, writable: true, agentIdentity: 'claude' }] } });
      }
      if (argv[2] === 'wait') return out({ ok: f.idle, result: { wait: { satisfied: f.idle } }, error: f.idle ? undefined : { code: 'timeout' } });
      if (argv[2] === 'read') return out({ ok: true, result: { terminal: f.screen } });
      if (argv[2] === 'send' && argv.includes('--retry-request')) {
        f.retries.push(argv[argv.indexOf('--retry-request') + 1]);
        return { code: 0, stdout: f.retryReply ? f.retryReply() : JSON.stringify(ACCEPTED_ONLY), stderr: '' };
      }
      if (argv[2] === 'send') {
        f.sent.push(argv[argv.indexOf('--text') + 1]);
        if (f.sendReply) return { code: 0, stdout: f.sendReply(), stderr: '' };
        return out(CONFIRMED);
      }
    }
    throw new Error(`unexpected call ${JSON.stringify(argv)}`);
  };
  return f;
}

// Server-owned timing (R63): by default past the floor, busy deadline still ahead.
const iso = (ms: number): string => new Date(ms).toISOString();
const wake = (id: string, name: string, reasons: any[], p = proof(['T:1']), channels: any[] = [], timing?: { anchorAt: string; deliverAfter: string; busyDeadline: string }) => ({
  worker: { id, name }, reasons, channels, proof: p,
  ...(timing ?? { anchorAt: iso(Date.now() - 600_000), deliverAfter: iso(Date.now() - 300_000), busyDeadline: iso(Date.now() + 3_600_000) }),
});
const cfg = (): Config => ({
  app: 'hrn:app:test:team', channel: 'chan', hadronCli: 'hadron', orcaCli: 'orca', stateDir: dir,
  roster: [{ worker: 'w-ada', name: 'Ada', worktree: dir, terminal: 'term_a' }],
  busyWaitMs: 10, submitWaitS: 1, coordinatorWatchMinutes: 20,
} as Config);
const go = (opts: { dry?: boolean; now?: () => number } = {}) => pass(cfg(), f.run, opts, (l) => lines.push(l));
const log = () => lines.join('\n');
const receiptsFile = () => join(dir, 'ticker-wake', 'receipts.json');

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ticker-wake-')); f = fake(); lines = []; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('selection and delivery', () => {
  it('delivers a TICK-only wake and acks it by its own proof', () => {
    const p = proof(['T:1'], 'a');
    f.wakes = [wake('w-ada', 'Ada', [TICK], p, [{ fromSeq: 1, throughSeq: 2 }])];
    go();
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toContain('coordinator-tick');
    expect(f.acked).toEqual([p]);
  });

  it('a MENTION-only wake is neither nudged nor acked', () => {
    f.wakes = [wake('w-ada', 'Ada', [MENTION])];
    go();
    expect(f.sent).toEqual([]);
    expect(f.acked).toEqual([]);
    expect(log()).toContain('1 other wakes ignored');
  });

  it('delivers a TICK wake with empty channels (#2068) and never asks for channels', () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1']), [])];
    go();
    expect(f.sent).toHaveLength(1);
    expect(f.acked).toHaveLength(1);
    expect(f.dueQueries[0]).not.toContain('channels');
  });

  // #2069 (landed in #2102): a MENTION-only reservation absorbs a later tick, so the due wake is TICK+MENTION. R53
  // (#2072, cor:agt:080:04/:16): a wake carries no message text and acknowledging it moves NO message mark, so acking the
  // joined proof records the tick and spends the reservation and never marks the mention delivered or read (S1 text
  // batches and the worker's own read do that). Without delivering the joined wake, every worker holding an outstanding
  // mention would never get its ticks: the dark team #2069 describes.
  it('TICK+MENTION is delivered: nudged once and acked (the ack moves no message mark, R53)', () => {
    const p = proof(['T:1']);
    f.wakes = [wake('w-ada', 'Ada', [TICK, MENTION], p)];
    go();
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toContain('coordinator-tick');
    expect(f.acked).toEqual([p]);
  });

  // Vera's pin (spec fit at fd5d2f33, cor:agt:080:04/:13): the ack moved no mark, so the mention stays due and the server
  // offers it again past the floor. The server half is proven live (Coco's stack); this is the loop's half of the sequence:
  // it must not swallow or ack the re-offered mention, and it must still deliver the next tick that joins it.
  it('after a joined TICK+MENTION ack, the re-offered MENTION-only wake is left alone and the next joined tick is delivered', () => {
    const p1 = proof(['T:1'], 'one');
    f.wakes = [wake('w-ada', 'Ada', [TICK, MENTION], p1)];
    go();
    expect(f.sent).toHaveLength(1);
    expect(f.acked).toEqual([p1]);
    f.wakes = [wake('w-ada', 'Ada', [MENTION], proof([], 'again'))]; // the mention, offered again past the floor
    go();
    expect(f.sent, 'a MENTION-only wake must not be typed').toHaveLength(1);
    expect(f.acked, 'a MENTION-only wake must not be acked').toEqual([p1]);
    const p2 = proof(['T:2'], 'two');
    f.wakes = [wake('w-ada', 'Ada', [TICK, MENTION], p2)]; // the next tick joins the still-due mention
    go();
    expect(f.sent).toHaveLength(2);
    expect(f.acked).toEqual([p1, p2]);
  });

  it('TICK+TASK and TICK+unknown are left alone: no nudge, no ack, no receipt (a proof naming task events records them delivered)', () => {
    for (const extra of [TASK, { kind: 'FUTURE', ticker: null }]) {
      f.wakes = [wake('w-ada', 'Ada', [TICK, extra])];
      go();
    }
    expect(f.sent).toEqual([]);
    expect(f.acked).toEqual([]);
    expect(log()).toContain('left alone');
    expect(existsSync(receiptsFile())).toBe(false);
  });

  it('a joined TICK+MENTION proof after an earlier delivery is never retyped; the lost ack is recovered ack-only', () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1']))];
    f.ackReply = () => ({ errors: [{ message: 'down' }] });
    go(); // typed, ack lost: a sent receipt exists
    f.ackReply = null;
    const joined = proof(['T:1'], 'joined');
    f.wakes = [wake('w-ada', 'Ada', [TICK, MENTION], joined)];
    go();
    expect(f.sent).toHaveLength(1); // still the one original nudge: the joined re-offer is not typed again
    expect(f.acked).toEqual([joined]); // its tick coverage is fully covered by the confirmed receipt
  });

  it('a worker not on the roster is skipped without an ack', () => {
    f.wakes = [wake('w-other', 'Zed', [TICK])];
    go();
    expect(f.sent).toEqual([]);
    expect(f.acked).toEqual([]);
    expect(log()).toContain('Zed: not on roster');
  });

  it('a proof whose tick coverage cannot be decoded is held', () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], 'opaque')];
    go();
    expect(f.sent).toEqual([]);
    expect(f.acked).toEqual([]);
    expect(log()).toContain('tick coverage cannot be established');
  });

  it('a roster/identity mismatch holds: the worktree is bound to another worker', () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK])];
    mkdirSync(join(dir, '.git'), { recursive: true });
    writeFileSync(join(dir, '.git', 'hadron-team-session.json'), JSON.stringify({ workerId: 'w-someone-else' }));
    go();
    expect(f.sent).toEqual([]);
    expect(f.acked).toEqual([]);
    expect(log()).toContain('bound to another worker');
  });

  it('--dry sends and acks nothing and writes no receipt', () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK])];
    go({ dry: true });
    expect(f.sent).toEqual([]);
    expect(f.acked).toEqual([]);
    expect(log()).toContain('WOULD nudge');
    expect(existsSync(receiptsFile())).toBe(false);
  });

  it('proofTicks decodes the tick set, sorted, and returns null for an opaque proof', () => {
    expect(proofTicks(proof(['B:2', 'A:1']))).toEqual(['A:1', 'B:2']);
    expect(proofTicks('opaque')).toBeNull();
    expect(proofTicks(`${Buffer.from(JSON.stringify({ ticks: [] })).toString('base64url')}.s`)).toBeNull();
  });
});

describe('idle gate (C1 rule)', () => {
  beforeEach(() => { f.wakes = [wake('w-ada', 'Ada', [TICK])]; });

  it('tui-idle satisfied and an empty composer: delivered', () => {
    go();
    expect(f.sent).toHaveLength(1);
  });

  it('tui-idle satisfied is NOT enough: any Orca draft holds, whitespace and multiline included', () => {
    for (const draft of ['half typed', '   ', 'line one\nline two']) {
      f.sent = []; f.acked = []; lines = [];
      f.screen = { source: 'screen', tail: CLAUDE_IDLE, draft };
      go();
      expect(f.sent).toEqual([]);
      expect(f.acked).toEqual([]);
      expect(log()).toContain('composer not provably empty');
    }
  });

  it('tui-idle satisfied over a menu or an unknown screen: held', () => {
    f.screen = { source: 'screen', tail: ['Which option do you pick?', '❯ 1. Alpha', '  2. Beta', 'Enter to select · ↑/↓ to navigate'] };
    go();
    expect(f.sent).toEqual([]);
    expect(f.acked).toEqual([]);
  });

  it('Claude composer with the mode footer and NO agents suffix, no draft, tui-idle unavailable: delivered via the screen', () => {
    f.idle = false;
    go();
    expect(f.sent).toHaveLength(1);
    expect(f.acked).toHaveLength(1);
  });

  it('screen fallback with an Orca draft holds and the wake stays due', () => {
    f.idle = false;
    f.screen = { source: 'screen', tail: CLAUDE_IDLE, draft: 'half typed' };
    go();
    expect(f.sent).toEqual([]);
    expect(f.acked).toEqual([]);
  });

  it('a second footer row is not the mode line: held', () => {
    f.idle = false;
    f.screen = { source: 'screen', tail: [...CLAUDE_IDLE, '  esc to interrupt'] };
    go();
    expect(f.sent).toEqual([]);
    expect(f.acked).toEqual([]);
  });

  it('a running turn is held, and nothing is cleared or interrupted', () => {
    f.idle = false;
    f.screen = { source: 'screen', tail: ['✽ Bunning… (5m 55s · ↓ 15.6k tokens)', RULE, '❯', RULE, '  ⏵⏵ bypass permissions on (shift+tab to cycle)'] };
    go();
    expect(f.sent).toEqual([]);
  });
});

describe('R63 timing (server-owned anchor, floor and busy deadline)', () => {
  const BUSY = ['✽ Bunning… (5m 55s · ↓ 15.6k tokens)', RULE, '❯', RULE, '  ⏵⏵ bypass permissions on (shift+tab to cycle)'];
  const T0 = Date.parse('2026-10-19T02:00:00.000Z');
  const timing = (deliverAfter: number, busyDeadline: number) => ({ anchorAt: iso(T0 - 900_000), deliverAfter: iso(deliverAfter), busyDeadline: iso(busyDeadline) });
  const at = (ms: number) => ({ now: () => ms });

  it('nothing is typed before deliverAfter, even to an idle terminal; at deliverAfter it is delivered', () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1']), [], timing(T0 + 60_000, T0 + 600_000))];
    go(at(T0 + 59_999));
    expect(f.sent).toEqual([]);
    expect(log()).toContain('before deliverAfter');
    go(at(T0 + 60_000));
    expect(f.sent).toHaveLength(1);
  });

  it('busy vetoes before busyDeadline, and stops vetoing at and after it', () => {
    f.idle = false;
    f.screen = { source: 'screen', tail: BUSY };
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1']), [], timing(T0 - 1, T0 + 600_000))];
    go(at(T0 + 599_999));
    expect(f.sent).toEqual([]);
    expect(log()).toContain('busy until the server');
    go(at(T0 + 600_000));
    expect(f.sent).toHaveLength(1); // at the deadline busy alone no longer vetoes
    expect(f.acked).toHaveLength(1);
  });

  it('after the deadline a busy terminal is delivered to; after it nothing else relaxes', () => {
    f.idle = false;
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1']), [], timing(T0 - 1, T0 + 1))];
    for (const [label, screen] of [
      ['draft', { source: 'screen', tail: BUSY, draft: 'half typed' }],
      ['menu/question', { source: 'screen', tail: ['Which option do you pick?', '❯ 1. Alpha', '  2. Beta', 'Enter to select · ↑/↓ to navigate'] }],
      ['second footer row', { source: 'screen', tail: [...BUSY, '  esc to interrupt'] }],
      ['unknown screen', { source: 'screen', tail: [RULE, '❯', RULE, '  ⏵⏵ bypass permissions on (shift+tab to cycle)'] }],
    ] as const) {
      f.sent = []; f.acked = []; lines = [];
      f.screen = screen as any;
      go(at(T0 + 3_600_000)); // an hour past the deadline
      expect(f.sent, label).toEqual([]);
      expect(f.acked, label).toEqual([]);
    }
  });

  it('timing comes only from the wake: a restart, re-offer or join decides identically and keeps no local clock', () => {
    f.idle = false;
    f.screen = { source: 'screen', tail: BUSY };
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1'], 'first-offer'), [], timing(T0 - 1, T0 + 600_000))];
    go(at(T0 + 10_000)); // held
    // a re-offer carries the SAME stored anchor/floor/deadline (new proof bytes): decided by the wake's fields alone
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1'], 're-offer'), [], timing(T0 - 1, T0 + 600_000))];
    go(at(T0 + 10_000));
    expect(f.sent).toEqual([]);
    // a fresh process (no memory of the earlier passes) at the deadline delivers
    go(at(T0 + 600_000));
    expect(f.sent).toHaveLength(1);
    // a joined TASK reason leaves the wake untouched whatever the clock says
    f.sent = []; f.acked = [];
    f.wakes = [wake('w-ada', 'Ada', [TICK, TASK], proof(['T:1']), [], timing(T0 - 1, T0 + 1))];
    go(at(T0 + 3_600_000));
    expect(f.sent).toEqual([]);
    expect(f.acked).toEqual([]);
  });

  it('a wake without server timing (old server) is held, never given a local default', () => {
    f.wakes = [{ worker: { id: 'w-ada', name: 'Ada' }, reasons: [TICK], channels: [], proof: proof(['T:1']) }];
    go();
    expect(f.sent).toEqual([]);
    expect(f.acked).toEqual([]);
    expect(log()).toContain('no server timing');
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1']), [], { anchorAt: 'x', deliverAfter: iso(Date.now()), busyDeadline: iso(Date.now()) })];
    go();
    expect(f.sent).toEqual([]);
  });

  it('asks the server for anchorAt, deliverAfter and busyDeadline', () => {
    f.wakes = [];
    go();
    expect(f.dueQueries[0]).toMatch(/anchorAt deliverAfter busyDeadline/);
  });
});

describe('typed-once, coverage and ambiguity', () => {
  const lostAck = () => { f.ackReply = () => ({ errors: [{ message: 'upstream 502' }] }); };
  const T = (k: number) => `T:${k}`;

  it('a confirmed send whose ack fails is retried ack-only for a fully covered proof, never retyped', () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof([T(1)]))];
    lostAck();
    go();
    expect(f.sent).toHaveLength(1);
    expect(log()).toContain('ack FAILED');
    expect(JSON.parse(readFileSync(receiptsFile(), 'utf8'))['w-ada']).toMatchObject({ state: 'sent', coverage: [T(1)], receiver: 'term_a#inc-1' });
    f.ackReply = null;
    lines = [];
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof([T(1)], 'reissued'))]; // a re-read proof: same ticks, new bytes
    go();
    expect(f.sent).toHaveLength(1);
    expect(f.acked).toHaveLength(1);
    expect(log()).toContain('ack-only recovery acked');
    expect(JSON.parse(readFileSync(receiptsFile(), 'utf8'))).toEqual({});
  });

  it('overlapping ticks: the second nudge names ONLY the uncovered ticker, coverage is the union, the combined proof is acked', () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof([T(1)]))];
    lostAck();
    go();
    expect(f.sent[0]).toContain('coordinator-tick');
    f.ackReply = null;
    const both = proof([T(1), 'U:1'], 'both');
    f.wakes = [wake('w-ada', 'Ada', [TICK, TICK2], both)];
    go();
    expect(f.sent).toHaveLength(2);
    expect(f.sent[1]).toContain('eden-queue-tick');
    expect(f.sent[1]).not.toContain('coordinator-tick'); // the covered work is not asked for again
    expect(f.acked).toEqual([both]);
    expect(JSON.parse(readFileSync(receiptsFile(), 'utf8'))).toEqual({});
  });

  it('a later tick of the SAME ticker is new work and is named', () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof([T(1)]))];
    lostAck();
    go();
    f.ackReply = null;
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof([T(1), T(2)]))];
    go();
    expect(f.sent).toHaveLength(2);
    expect(f.sent[1]).toContain('coordinator-tick');
    expect(f.acked).toHaveLength(1);
  });

  it('uncovered tick work that cannot be mapped to a ticker is held, not repeated', () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof([T(1)]))];
    lostAck();
    go();
    f.ackReply = null;
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof([T(1), 'Z:9']))]; // Z is not among the wake's reasons
    go();
    expect(f.sent).toHaveLength(1);
    expect(f.acked).toEqual([]);
    expect(log()).toContain('cannot be identified');
  });

  it('a changed receiver (replacement terminal) does not inherit the old receipt', () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof([T(1)]))];
    lostAck();
    go();
    f.ackReply = null;
    f.incarnation = 'inc-2';
    go();
    expect(f.sent).toHaveLength(2); // the new terminal never received the first nudge
  });

  it('an ack reply without an acknowledgement result is not reported as acked', () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK])];
    f.ackReply = () => ({ data: {} });
    go();
    expect(log()).toContain('ack FAILED');
    expect(log()).not.toMatch(/; acked /);
  });

  it('accepted without a confirmed turn start is ambiguous and kept with its request id; it is reconciled by that id, never retyped', () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK])];
    f.sendReply = () => JSON.stringify(ACCEPTED_ONLY);
    go();
    expect(f.sent).toHaveLength(1);
    expect(f.acked).toEqual([]);
    expect(JSON.parse(readFileSync(receiptsFile(), 'utf8'))['w-ada']).toMatchObject({ state: 'ambiguous', requestId: 'r1', handle: 'term_a' });
    f.sendReply = null;
    go(); // still unconfirmed on retry
    expect(f.retries).toEqual(['r1']);
    expect(f.sent).toHaveLength(1);
    expect(f.acked).toEqual([]);
    expect(log()).toContain('still unreconciled');
    f.retryReply = () => JSON.stringify(CONFIRMED); // the retry now reports the turn started
    lines = [];
    go();
    expect(f.sent).toHaveLength(1);
    expect(f.acked).toHaveLength(1);
    expect(log()).toContain('reconciled as delivered');
    expect(JSON.parse(readFileSync(receiptsFile(), 'utf8'))).toEqual({});
  });

  it('only the exact stage turn_started confirms', () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK])];
    f.sendReply = () => JSON.stringify({ ok: true, result: { send: { accepted: true, prompt: { requestId: 'r2', stages: ['input_accepted', 'no_turn_started_yet'] } } } });
    go();
    expect(f.acked).toEqual([]);
    expect(JSON.parse(readFileSync(receiptsFile(), 'utf8'))['w-ada'].state).toBe('ambiguous');
  });

  it('an unparsable or id-less receipt is ambiguous with no request id: held for a human, no retry calls', () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK])];
    f.sendReply = () => 'not json';
    go();
    f.sendReply = null;
    go();
    go();
    expect(f.sent).toHaveLength(1);
    expect(f.retries).toEqual([]);
    expect(f.acked).toEqual([]);
    expect(log()).toContain('unreconciled');
  });

  it('a failure that names a request id is reissued once with that same id: confirmed on retry means one send, acked', () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK])];
    f.sendReply = () => JSON.stringify({ ok: false, error: { code: 'transport', details: { requestId: 'rq9' } } });
    f.retryReply = () => JSON.stringify(CONFIRMED);
    go();
    expect(f.sent).toHaveLength(1);
    expect(f.retries).toEqual(['rq9']);
    expect(f.acked).toHaveLength(1);
  });

  it('a failure after possible submission whose retry also fails stays ambiguous with its request id', () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK])];
    f.sendReply = () => JSON.stringify({ ok: false, error: { code: 'transport', details: { requestId: 'rq9' } } });
    f.retryReply = () => JSON.stringify({ ok: false, error: { code: 'transport', details: { requestId: 'rq9' } } });
    go();
    expect(f.acked).toEqual([]);
    expect(JSON.parse(readFileSync(receiptsFile(), 'utf8'))['w-ada']).toMatchObject({ state: 'ambiguous', requestId: 'rq9' });
    go();
    expect(f.sent).toHaveLength(1); // not retyped
  });

  it('uncertain with an id, then a same-id retry that fails WITHOUT an id, stays uncertain across restarts: no fresh type, no ack', () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK])];
    f.sendReply = () => JSON.stringify(ACCEPTED_ONLY);
    f.retryReply = () => JSON.stringify({ ok: false, error: { code: 'invalid_argument' } });
    go();
    expect(f.sent).toHaveLength(1);
    expect(JSON.parse(readFileSync(receiptsFile(), 'utf8'))['w-ada']).toMatchObject({ state: 'ambiguous', requestId: 'r1' });
    for (let i = 0; i < 3; i++) go(); // "restarts": every pass rereads the receipts
    expect(f.sent).toHaveLength(1);
    expect(f.acked).toEqual([]);
    expect(log()).toContain('still unreconciled');
    expect(log()).not.toContain('will retry'); // never downgraded to a fresh-send refusal
    f.retryReply = () => JSON.stringify(CONFIRMED); // a same-id confirmation may still promote it
    go();
    expect(f.acked).toHaveLength(1);
  });

  it('reissuing an unresolved request keeps the receiver and composer guard: no retry while a draft is pending or the receiver changed', () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK])];
    f.sendReply = () => JSON.stringify(ACCEPTED_ONLY);
    go();
    f.screen = { source: 'screen', tail: CLAUDE_IDLE, draft: 'half typed' };
    go();
    expect(f.retries).toEqual([]);
    expect(log()).toContain('not reissued');
    f.screen = { source: 'screen', tail: CLAUDE_IDLE };
    f.incarnation = 'inc-2';
    go();
    expect(f.retries).toEqual([]);
    expect(log()).toContain('another receiver');
  });

  it('an ambiguous receipt older than a day is still kept (no silent expiry)', () => {
    mkdirSync(join(dir, 'ticker-wake'), { recursive: true });
    writeFileSync(receiptsFile(), JSON.stringify({ 'w-ada': { state: 'ambiguous', coverage: ['T:1'], receiver: 'term_a#inc-1', at: 1, detail: 'old', text: 't', handle: 'term_a' } }));
    f.wakes = [wake('w-ada', 'Ada', [TICK])];
    go();
    expect(f.sent).toEqual([]);
    expect(log()).toContain('unreconciled');
  });

  it('a structured refusal (no request id, nothing typed) leaves the wake due and retypes later', () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK])];
    f.sendReply = () => JSON.stringify({ ok: false, error: { code: 'invalid_argument' } });
    go();
    expect(f.acked).toEqual([]);
    expect(log()).toContain('send refused');
    // The intent written before the send is withdrawn: no entry for the worker remains (the file may exist, empty).
    const left = existsSync(receiptsFile()) ? JSON.parse(readFileSync(receiptsFile(), 'utf8')) : {};
    expect(left['w-ada']).toBeUndefined();
    f.sendReply = null;
    go();
    expect(f.acked).toHaveLength(1);
  });

  it('unreadable or malformed receipt state stops the pass: nothing is sent or acked', () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK])];
    mkdirSync(join(dir, 'ticker-wake'), { recursive: true });
    const bad = [
      '{not json', '[]', 'null', '"x"', '7',
      JSON.stringify({ 'w-ada': { state: 'sent' } }),
      JSON.stringify({ 'w-ada': { state: 'sent', coverage: [], receiver: 'r', at: 1 } }),
      JSON.stringify({ 'w-ada': { state: 'sent', coverage: [1], receiver: 'r', at: 1 } }),
      JSON.stringify({ 'w-ada': { state: 'sent', coverage: ['T:1'], receiver: 'r', at: 'x' } }),
      JSON.stringify({ 'w-ada': { state: 'ambiguous', coverage: ['T:1'], receiver: 'r', at: 1 } }),
      JSON.stringify({ 'w-ada': [] }),
    ];
    for (const raw of bad) {
      writeFileSync(receiptsFile(), raw);
      expect(() => go(), raw).toThrow('malformed');
    }
    writeFileSync(receiptsFile(), '{}');
    chmodSync(receiptsFile(), 0o000);
    if (process.getuid?.() !== 0) expect(() => go()).toThrow('unreadable');
    chmodSync(receiptsFile(), 0o600);
    expect(f.sent).toEqual([]);
    expect(f.acked).toEqual([]);
  });

  it('a receipt file replaced by [] after a lost ack stops the restart instead of retyping', () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof([T(1)]))];
    lostAck();
    go();
    expect(f.sent).toHaveLength(1);
    writeFileSync(receiptsFile(), '[]');
    f.ackReply = null;
    expect(() => go()).toThrow('malformed');
    expect(f.sent).toHaveLength(1);
  });
});

describe('failure and paging', () => {
  it('a GraphQL failure on dueWakes throws and sends and acks nothing', () => {
    f.dueError = 'permission denied';
    // The server's message is not echoed (P2-2): the class is. Its text can carry a proof or private text.
    expect(() => go()).toThrow('graphql error');
    expect(() => go()).not.toThrow('permission denied');
    expect(f.sent).toEqual([]);
  });

  it('stops after 10 pages and says so', () => {
    f.alwaysMore = true;
    f.wakes = [];
    go();
    expect(f.pages).toBe(10);
    expect(log()).toContain('more than 10 pages');
  });
});

describe('CLI entry and single instance', () => {
  const deps = () => ({ load: cfg, run: f.run, log: (l: string) => lines.push(l), sleep: async () => {} });

  it('rejects an unknown mode or flag, --ack-mentions, loop --dry or a bad interval with exit 2 and does nothing', async () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK])];
    for (const argv of [['bogus'], [], ['once', '--nope'], ['once', '--ack-mentions'], ['loop', '--ack-mentions'], ['loop', '--dry'], ['loop', '--interval', '0'], ['loop', '--interval', 'x'], ['loop', '--interval', 'Infinity'], ['loop', '--interval'], ['once', '--interval', '30']]) {
      expect(await main(argv, deps())).toBe(2);
    }
    expect(f.sent).toEqual([]);
    expect(f.pages).toBe(0);
  });

  it('once --dry through the real entry never sends or acks', async () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK])];
    expect(await main(['once', '--dry'], deps())).toBe(0);
    expect(f.sent).toEqual([]);
    expect(f.acked).toEqual([]);
  });

  it('loop runs passes until stopped and survives a failing pass', async () => {
    f.dueError = 'boom';
    expect(await main(['loop', '--interval', '10'], { ...deps(), maxPasses: 2 })).toBe(0);
    expect(f.pages).toBe(2);
    expect(log()).toContain('pass failed: graphql error');
    expect(existsSync(join(dir, 'ticker-wake', 'lock'))).toBe(false); // released
  });

  it('refuses to start while another live ticker-wake holds the lock', async () => {
    const holder = spawn('node', ['-e', 'setTimeout(() => {}, 20000)', 'ticker-wake'], { stdio: 'ignore' });
    try {
      const stateDir = join(dir, 'ticker-wake');
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, 'lock'), String(holder.pid));
      f.wakes = [wake('w-ada', 'Ada', [TICK])];
      expect(await main(['once'], deps())).toBe(1);
      expect(log()).toContain('holds');
      expect(f.sent).toEqual([]);
      expect(f.pages).toBe(0);
    } finally { holder.kill(); }
  });

  it('a stale lock (dead pid) is taken over and released', () => {
    const stateDir = join(dir, 'ticker-wake');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'lock'), '999999999');
    const release = acquireLock(stateDir);
    expect(readFileSync(join(stateDir, 'lock'), 'utf8')).toBe(String(process.pid));
    release();
    expect(existsSync(join(stateDir, 'lock'))).toBe(false);
  });

  it('stale-lock takeover race: a second contender during the takeover is refused, exactly one proceeds', () => {
    const stateDir = join(dir, 'ticker-wake');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'lock'), '999999999');
    // The first contender is a live process named ticker-wake (liveness is judged from /proc cmdline).
    const first = spawn('node', ['-e', 'setTimeout(() => {}, 20000)', 'ticker-wake'], { stdio: 'ignore' });
    try {
      let nested = '';
      const release = acquireLock(stateDir, first.pid!, {
        beforeUnlink: () => {
          try { acquireLock(stateDir, process.pid + 1); nested = 'GOT'; } catch (e) { nested = (e as Error).message; }
        },
      });
      expect(nested).toContain('taking over');
      expect(readFileSync(join(stateDir, 'lock'), 'utf8')).toBe(String(first.pid));
      release();
      expect(existsSync(join(stateDir, 'lock.takeover'))).toBe(false);
    } finally { first.kill(); }
  });

  it('stale-lock takeover never unlinks a live replacement owner that arrived after the stale judgment', () => {
    const stateDir = join(dir, 'ticker-wake');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'lock'), '999999999');
    const holder = spawn('node', ['-e', 'setTimeout(() => {}, 20000)', 'ticker-wake'], { stdio: 'ignore' });
    try {
      expect(() => acquireLock(stateDir, process.pid, {
        afterJudgedStale: () => { writeFileSync(join(stateDir, 'lock'), String(holder.pid)); }, // replacement arrives
      })).toThrow('holds');
      expect(readFileSync(join(stateDir, 'lock'), 'utf8')).toBe(String(holder.pid)); // left intact
      expect(existsSync(join(stateDir, 'lock.takeover'))).toBe(false);
    } finally { holder.kill(); }
  });

  it('a takeover file left behind by a dead process fails closed for operator cleanup, and is not removed', () => {
    const stateDir = join(dir, 'ticker-wake');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'lock'), '999999999');
    writeFileSync(join(stateDir, 'lock.takeover'), '999999998');
    expect(() => acquireLock(stateDir)).toThrow('operator must remove');
    expect(readFileSync(join(stateDir, 'lock.takeover'), 'utf8')).toBe('999999998');
    expect(readFileSync(join(stateDir, 'lock'), 'utf8')).toBe('999999999');
    rmSync(join(stateDir, 'lock.takeover')); // the operator cleanup
    const release = acquireLock(stateDir);
    expect(readFileSync(join(stateDir, 'lock'), 'utf8')).toBe(String(process.pid));
    release();
  });

  it('simultaneous starters: exactly one process wins the lock', async () => {
    const stateDir = join(dir, 'ticker-wake');
    const mod = fileURLToPath(new URL('./ticker-wake.ts', import.meta.url));
    const start = Date.now() + 1500; // all children spin until the same instant, then race
    const child = () => new Promise<string>((resolve) => {
      const p = spawn(process.execPath, ['--import', 'tsx', '-e',
        `const m = await import(${JSON.stringify(mod)}); while (Date.now() < ${start}) {}; ` +
        `try { m.acquireLock(${JSON.stringify(stateDir)}); console.log('GOT'); await new Promise(r => setTimeout(r, 2500)); } catch (e) { console.log('DENIED'); }`,
        'ticker-wake'], { stdio: ['ignore', 'pipe', 'ignore'], cwd: process.cwd() });
      let out = '';
      p.stdout.on('data', (d) => { out += d; });
      p.on('close', () => resolve(out.trim()));
    });
    const results = await Promise.all(Array.from({ length: 6 }, child));
    expect(results.filter((r) => r === 'GOT')).toHaveLength(1);
    expect(results.filter((r) => r === 'DENIED')).toHaveLength(5);
  }, 30_000);
});

// The loop sends two GraphQL documents. The R63 timing seam (anchorAt, deliverAfter,
// busyDeadline on a due wake) is server-owned and landed with S1 (#2102); this pins that the
// documents the loop actually sends are valid against the server's own SDL, so a rename or a
// removal on the server side fails here instead of at the first live poll.
describe('GraphQL contract with the server SDL (#2102 / R63)', () => {
  const schema = buildSchema(typeDefs);
  it('the dueWakes query validates and asks for the timing fields the loop consumes', () => {
    expect(validate(schema, parse(QUERY)).map((e) => e.message)).toEqual([]);
    for (const f of ['anchorAt', 'deliverAfter', 'busyDeadline']) expect(QUERY).toContain(f);
  });
  it('the acknowledgeWakes mutation validates', () => {
    expect(validate(schema, parse(ACK)).map((e) => e.message)).toEqual([]);
  });
});

// George's two P2s on #2070 (LOCAL REQUEST_CHANGES at fd5d2f33).
describe('send intent is persisted BEFORE a possible submission (P2-1)', () => {
  // The temp file saveReceipts writes first. Making it a directory (EISDIR, like the reviewer's repro) is portable:
  // it fails for root and non-root alike, and it only appears once the send has happened.
  const tmpPath = () => `${receiptsFile()}.${process.pid}.tmp`;

  it('a confirmed send whose receipt write then fails is never retyped by the next pass', () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1']))];
    f.sendReply = () => { mkdirSync(tmpPath()); return JSON.stringify(CONFIRMED); };
    try { go(); } catch { /* the old code lets the write failure end the pass */ }
    expect(f.sent).toHaveLength(1);
    rmSync(tmpPath(), { recursive: true, force: true }); // the operator clears the fault
    f.sendReply = null;
    go();
    expect(f.sent, 'the same wake was typed a second time').toHaveLength(1);
    expect(f.acked, 'an unreconciled send must not be acked').toEqual([]);
    expect(log()).toContain('unreconciled');
  });

  it('if the intent cannot be recorded, nothing is sent (fail closed)', () => {
    mkdirSync(join(dir, 'ticker-wake'), { recursive: true });
    mkdirSync(tmpPath()); // the very first write fails
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1']))];
    try { go(); } catch { /* may throw or log */ }
    expect(f.sent).toEqual([]);
    expect(f.acked).toEqual([]);
  });

  it('a send that was refused (nothing typed) leaves no intent behind, so it is retried', () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1']))];
    f.sendReply = () => JSON.stringify({ ok: false, error: { code: 'not_accepted' } });
    go();
    expect(f.sent).toHaveLength(1);
    f.sendReply = null;
    go();
    expect(f.sent, 'a refused send must be retried').toHaveLength(2);
    expect(f.acked).toHaveLength(1);
  });
});

describe('diagnostics never carry a proof, typed text or a server message (P2-2)', () => {
  const PROOF_SENTINEL = 'OPAQUE-PROOF-SENTINEL-8f3a91c2d7';
  const TEXT_SENTINEL = 'PRIVATE-DRAFT-TEXT-SENTINEL-51b0e4';
  const clean = () => {
    const everything = log() + '\n' + (existsSync(receiptsFile()) ? readFileSync(receiptsFile(), 'utf8') : '');
    expect(everything).not.toContain(PROOF_SENTINEL);
    expect(everything).not.toContain(TEXT_SENTINEL);
  };

  it('a failed ack logs its server error CODE but not the server message', () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1']))];
    f.ackReply = () => ({ errors: [{ message: `stale ${PROOF_SENTINEL} ${TEXT_SENTINEL}`, extensions: { code: 'WAKE_PROOF_STALE' } }] });
    go();
    expect(log()).toContain('WAKE_PROOF_STALE');
    clean();
  });

  it('an unparsable hadron reply does not log its stderr', () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1']))];
    const run = f.run;
    f.run = (argv) => (argv[0] === 'hadron' && String(argv[2]).includes('acknowledgeWakes')
      ? { code: 1, stdout: 'not json', stderr: `boom ${PROOF_SENTINEL} ${TEXT_SENTINEL}` }
      : run(argv));
    go();
    clean();
  });

  it('a refused send does not log the raw send error', () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1']))];
    f.sendReply = () => JSON.stringify({ ok: false, error: { code: 'composer_not_empty', message: `draft: ${TEXT_SENTINEL}` } });
    go();
    expect(log()).toContain('composer_not_empty');
    clean();
  });

  it('an uncertain send with a request identity keeps the identity but logs and stores no raw error', () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1']))];
    const uncertain = () => JSON.stringify({ ok: false, requestId: 'r-9', error: { message: `echo ${TEXT_SENTINEL} ${PROOF_SENTINEL}` } });
    f.sendReply = uncertain;
    f.retryReply = uncertain; // the same-identity retry fails the same way
    go();
    clean();
    expect(JSON.parse(readFileSync(receiptsFile(), 'utf8'))['w-ada']).toMatchObject({ state: 'ambiguous', requestId: 'r-9' });
  });

  it('a failed dueWakes read throws a message without the server text', () => {
    f.dueError = `bad ${TEXT_SENTINEL} ${PROOF_SENTINEL}`;
    let msg = '';
    try { go(); } catch (e) { msg = (e as Error).message; }
    expect(msg).not.toBe('');
    expect(msg).not.toContain(TEXT_SENTINEL);
    expect(msg).not.toContain(PROOF_SENTINEL);
  });

  // George's residual P2-2 at 8154a672: an exception thrown by a router HELPER reaches the outer catch, and scrub() only
  // removes token shapes. Every exception that is not this script's own is logged as a class plus an allowlisted code.
  describe('helper and outer exceptions are normalised at the boundary', () => {
    const deps = () => ({ load: cfg, run: f.run, log: (l: string) => lines.push(l), sleep: async () => {} });
    const asLoop = async (mutate: (argv: string[]) => { code: number; stdout: string; stderr: string } | undefined) => {
      f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1']))];
      const run = f.run;
      f.run = (argv) => mutate(argv) ?? run(argv);
      expect(await main(['loop', '--interval', '10'], { ...deps(), maxPasses: 1 })).toBe(0);
    };
    const isTerminalList = (argv: string[]) => argv[0] === 'orca' && argv[1] === 'terminal' && argv[2] === 'list';

    it('a terminal-list error carrying private text logs the class and the code, not the message', async () => {
      await asLoop((argv) => isTerminalList(argv)
        ? { code: 0, stdout: JSON.stringify({ ok: false, error: { code: 'backend_failure', message: TEXT_SENTINEL } }), stderr: '' }
        : undefined);
      expect(log()).toContain('pass failed');
      expect(log()).toContain('backend_failure');
      clean();
    });

    it('a helper reading unparsable output that contains private text logs a class only', async () => {
      await asLoop((argv) => isTerminalList(argv) ? { code: 1, stdout: `garbage ${TEXT_SENTINEL} ${PROOF_SENTINEL}`, stderr: TEXT_SENTINEL } : undefined);
      expect(log()).toContain('pass failed');
      clean();
    });

    it('an arbitrary exception from the runner is logged by its class, never its message', async () => {
      await asLoop((argv) => { if (isTerminalList(argv)) throw new Error(`boom ${TEXT_SENTINEL} ${PROOF_SENTINEL}`); return undefined; });
      expect(log()).toContain('pass failed');
      clean();
    });

    // Rodolfo's three reproductions at 8154a672 (his checkpoint), all ordinary non-token-shaped text.
    it('Rodolfo 1: an ordinary terminal-list helper message cannot echo through the outer catch', async () => {
      await asLoop((argv) => isTerminalList(argv)
        ? { code: 1, stdout: JSON.stringify({ ok: false, error: { code: 'terminal_list_failed', message: 'PRIVATE_HELPER_TEXT_SENTINEL' } }), stderr: '' }
        : undefined);
      expect(log()).not.toContain('PRIVATE_HELPER_TEXT_SENTINEL');
      expect(f.sent).toEqual([]);
    });

    it('Rodolfo 2: an arbitrary Orca stage string cannot become log or stored diagnostic text', () => {
      const text = 'PRIVATE_STAGE_TEXT_SENTINEL';
      f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1']))];
      f.sendReply = () => JSON.stringify({ ok: true, result: { send: { accepted: true, prompt: { requestId: 'r1', stages: ['input_accepted', text] } } } });
      f.retryReply = f.sendReply;
      go();
      expect(log()).not.toContain(text);
      const entry = JSON.parse(readFileSync(receiptsFile(), 'utf8'))['w-ada'];
      expect(entry.detail).not.toContain(text);
      expect(entry.state).toBe('ambiguous'); // still never retyped or acked
    });

    it('Rodolfo 3: a legacy receipt\'s raw detail is not logged while the worker is held', () => {
      const text = 'PRIVATE_LEGACY_TEXT_SENTINEL';
      mkdirSync(join(dir, 'ticker-wake'), { recursive: true });
      writeFileSync(receiptsFile(), JSON.stringify({ 'w-ada': { state: 'ambiguous', coverage: ['T:1'], receiver: 'term_a#inc-1', at: 1, detail: text, text: 'a nudge', handle: 'term_a' } }));
      f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1']))];
      go();
      expect(log()).not.toContain(text);
      expect(log()).toContain('unreconciled'); // still held for a human
      expect(f.sent).toEqual([]);
    });

    it('this script\'s own errors keep their readable message (receipts unreadable stops the pass with a code)', async () => {
      mkdirSync(join(dir, 'ticker-wake'), { recursive: true });
      mkdirSync(receiptsFile()); // a directory where the file should be: EISDIR on read
      f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1']))];
      expect(await main(['loop', '--interval', '10'], { ...deps(), maxPasses: 1 })).toBe(0);
      expect(log()).toContain('receipts unreadable (EISDIR)');
      expect(f.sent).toEqual([]);
    });
  });

  it('screen-derived reasons are logged as a class, not as screen text', () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1']))];
    f.screen = { source: 'screen', tail: ['❯ ' + TEXT_SENTINEL, RULE, '❯ ' + TEXT_SENTINEL, RULE, '  ⏵⏵ bypass permissions on (shift+tab to cycle)'], draft: TEXT_SENTINEL };
    go();
    expect(f.sent).toEqual([]);
    expect(log()).toContain('held');
    clean();
  });
});
