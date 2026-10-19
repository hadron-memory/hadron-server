import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config, Runner } from '../orca-attention-router/router.js';
import { pass, main, acquireLock, proofTicks } from './ticker-wake.js';

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

const wake = (id: string, name: string, reasons: any[], p = proof(['T:1']), channels: any[] = []) => ({ worker: { id, name }, reasons, channels, proof: p });
const cfg = (): Config => ({
  app: 'hrn:app:test:team', channel: 'chan', hadronCli: 'hadron', orcaCli: 'orca', stateDir: dir,
  roster: [{ worker: 'w-ada', name: 'Ada', worktree: dir, terminal: 'term_a' }],
  busyWaitMs: 10, submitWaitS: 1, coordinatorWatchMinutes: 20,
} as Config);
const go = (opts: { dry?: boolean } = {}) => pass(cfg(), f.run, opts, (l) => lines.push(l));
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

  it('TICK+MENTION, TICK+TASK and TICK+unknown are left alone: no nudge, no ack, no receipt', () => {
    for (const extra of [MENTION, TASK, { kind: 'FUTURE', ticker: null }]) {
      f.wakes = [wake('w-ada', 'Ada', [TICK, extra])];
      go();
    }
    expect(f.sent).toEqual([]);
    expect(f.acked).toEqual([]);
    expect(log()).toContain('left alone');
    expect(existsSync(receiptsFile())).toBe(false);
  });

  it('a joined proof after an earlier delivery is still untouched (no send, no ack)', () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1']))];
    f.ackReply = () => ({ errors: [{ message: 'down' }] });
    go(); // typed, ack lost: a sent receipt exists
    f.ackReply = null;
    f.wakes = [wake('w-ada', 'Ada', [TICK, MENTION], proof(['T:1']))];
    go();
    expect(f.sent).toHaveLength(1);
    expect(f.acked).toEqual([]);
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
    expect(existsSync(receiptsFile())).toBe(false);
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
    expect(() => go()).toThrow('permission denied');
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
    expect(log()).toContain('pass failed: boom');
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

  it('a takeover file left by a dead process does not wedge acquisition', () => {
    const stateDir = join(dir, 'ticker-wake');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'lock'), '999999999');
    writeFileSync(join(stateDir, 'lock.takeover'), '999999998');
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
