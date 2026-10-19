import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config, Runner } from '../orca-attention-router/router.js';
import { pass, main, acquireLock, wakeIdentity } from './ticker-wake.js';

const RULE = '─'.repeat(112);
// A finished Claude Code 2.1.303 turn over an empty composer (shapes from the cli#907 captures): the
// mode footer WITHOUT the transient "· ← for agents" suffix.
const CLAUDE_IDLE = [
  '❯ reply with exactly the word ok', '● ok', '✻ Crunched for 2s · done 11:14 PM',
  RULE, '❯', RULE, '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
];
const TICK = { kind: 'TICK', ticker: { name: 'coordinator-tick' } };
const MENTION = { kind: 'MENTION', ticker: null };
const TASK = { kind: 'TASK', ticker: null };

interface Fake {
  run: Runner;
  wakes: any[];
  subscribers: string[];
  subsTruncated: boolean;
  acked: string[];
  sent: string[];
  idle: boolean;
  screen: Record<string, any>;
  dueQueries: string[];
  pages: number; // dueWakes calls made
  alwaysMore: boolean;
  ackReply: (() => unknown) | null;
  sendReply: (() => unknown) | null;
  dueError: string | null;
}

let dir: string;
let f: Fake;
let lines: string[];

function fake(): Fake {
  const f: Fake = {
    wakes: [], subscribers: [], subsTruncated: false, acked: [], sent: [], idle: true,
    screen: { source: 'screen', tail: CLAUDE_IDLE }, dueQueries: [], pages: 0, alwaysMore: false,
    ackReply: null, sendReply: null, dueError: null, run: undefined as any,
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
      if (q.includes('tickers(')) {
        return out({ data: { tickers: [{ subscribers: { items: f.subscribers.map((id) => ({ worker: { id } })), hasNextPage: f.subsTruncated } }] } });
      }
    }
    if (argv[0] === 'orca' && argv[1] === 'terminal') {
      if (argv[2] === 'list') {
        return out({ ok: true, result: { terminals: [{ handle: 'term_a', worktreePath: dir, connected: true, writable: true, agentIdentity: 'claude' }] } });
      }
      if (argv[2] === 'wait') return out({ ok: f.idle, result: { wait: { satisfied: f.idle } }, error: f.idle ? undefined : { code: 'timeout' } });
      if (argv[2] === 'read') return out({ ok: true, result: { terminal: f.screen } });
      if (argv[2] === 'send') {
        f.sent.push(argv[argv.indexOf('--text') + 1]);
        if (f.sendReply) return { code: 0, stdout: String(f.sendReply()), stderr: '' };
        return out({ ok: true, result: { send: { accepted: true } } });
      }
    }
    throw new Error(`unexpected call ${JSON.stringify(argv)}`);
  };
  return f;
}

const wake = (id: string, name: string, reasons: any[], channels: any[] = [], proof = `proof-${name}`) => ({
  worker: { id, name }, reasons, channels, proof,
});
const cfg = (): Config => ({
  app: 'hrn:app:test:team', channel: 'chan', hadronCli: 'hadron', orcaCli: 'orca', stateDir: dir,
  roster: [{ worker: 'w-ada', name: 'Ada', worktree: dir, terminal: 'term_a' }],
  busyWaitMs: 10, submitWaitS: 1, coordinatorWatchMinutes: 20,
} as Config);
const go = (opts: { dry?: boolean; ackMentions?: boolean } = {}) => pass(cfg(), f.run, opts, (l) => lines.push(l));
const log = () => lines.join('\n');

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ticker-wake-')); f = fake(); lines = []; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('selection and delivery', () => {
  it('delivers a TICK wake and acks it by its own proof', () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], [{ fromSeq: 1, throughSeq: 2 }], 'proof-ada-1')];
    go();
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toContain('coordinator-tick');
    expect(f.acked).toEqual(['proof-ada-1']);
  });

  it('a MENTION-only wake is neither nudged nor acked', () => {
    f.wakes = [wake('w-ada', 'Ada', [MENTION])];
    go();
    expect(f.sent).toEqual([]);
    expect(f.acked).toEqual([]);
    expect(log()).toContain('1 other wakes ignored');
  });

  it('delivers a TICK wake with empty channels (#2068) and never asks for channels', () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], [])];
    go();
    expect(f.sent).toHaveLength(1);
    expect(f.acked).toEqual(['proof-Ada']);
    expect(f.dueQueries[0]).not.toContain('channels');
  });

  it('a merged MENTION+TICK wake is delivered once and acked once', () => {
    f.wakes = [wake('w-ada', 'Ada', [MENTION, TICK])];
    go();
    expect(f.sent).toHaveLength(1);
    expect(f.acked).toEqual(['proof-Ada']);
  });

  it('a wake carrying TASK (alone with TICK, or with MENTION) is left alone: no nudge, no ack', () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK, TASK])];
    go();
    expect(f.sent).toEqual([]);
    expect(f.acked).toEqual([]);
    expect(log()).toContain('left alone');
  });

  it('a worker not on the roster is skipped without an ack', () => {
    f.wakes = [wake('w-other', 'Zed', [TICK])];
    go();
    expect(f.sent).toEqual([]);
    expect(f.acked).toEqual([]);
    expect(log()).toContain('Zed: not on roster');
  });

  it('a roster/identity mismatch holds: the worktree is bound to another worker', () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK])];
    mkdirSyncGit(dir, 'w-someone-else');
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
    expect(existsSync(join(dir, 'ticker-wake', 'receipts.json'))).toBe(false);
  });
});

function mkdirSyncGit(root: string, workerId: string): void {
  // boundWorker() reads <worktree>/.git (a dir here) / hadron-team-session.json
  mkdirSync(join(root, '.git'), { recursive: true });
  writeFileSync(join(root, '.git', 'hadron-team-session.json'), JSON.stringify({ workerId }));
}

describe('--ack-mentions', () => {
  beforeEach(() => {
    f.subscribers = ['w-ada'];
    f.wakes = [wake('w-ada', 'Ada', [MENTION], [], 'proof-stuck'), wake('w-eve', 'Eve', [MENTION], [], 'proof-eve')];
  });

  it('is OFF by default: no ack', () => {
    go();
    expect(f.acked).toEqual([]);
  });

  it('when set, acks only a subscriber\'s MENTION-only wake on the roster, with no nudge', () => {
    go({ ackMentions: true });
    expect(f.acked).toEqual(['proof-stuck']); // Eve is neither subscriber nor on the roster
    expect(f.sent).toEqual([]);
  });

  it('never consumes TASK or other unseen reasons', () => {
    f.wakes = [wake('w-ada', 'Ada', [TASK], [], 'p1'), wake('w-ada', 'Ada', [MENTION, TASK], [], 'p2')];
    go({ ackMentions: true });
    expect(f.acked).toEqual([]);
  });

  it('a subscriber off the roster is not acked', () => {
    f.subscribers = ['w-eve'];
    f.wakes = [wake('w-eve', 'Eve', [MENTION], [], 'proof-eve')];
    go({ ackMentions: true });
    expect(f.acked).toEqual([]);
  });

  it('a truncated subscriber list skips the workaround entirely', () => {
    f.subsTruncated = true;
    go({ ackMentions: true });
    expect(f.acked).toEqual([]);
    expect(log()).toContain('subscriber list truncated');
  });

  it('--dry only reports', () => {
    go({ ackMentions: true, dry: true });
    expect(f.acked).toEqual([]);
    expect(log()).toContain('WOULD ack mention-only');
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
    expect(f.acked).toEqual(['proof-Ada']);
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

describe('typed-once and ack recovery', () => {
  beforeEach(() => { f.wakes = [wake('w-ada', 'Ada', [TICK])]; });

  it('a confirmed send whose ack fails is retried ack-only and never retyped', () => {
    f.ackReply = () => ({ errors: [{ message: 'upstream 502' }] });
    go();
    expect(f.sent).toHaveLength(1);
    expect(log()).toContain('ack FAILED');
    expect(log()).not.toMatch(/ nudged term_a; acked/);
    f.ackReply = null;
    lines = [];
    go();
    expect(f.sent).toHaveLength(1); // not retyped
    expect(f.acked).toEqual(['proof-Ada']);
    expect(log()).toContain('ack-only recovery acked');
    go(); // receipt cleared: a new identical-identity wake would be a new send, but none is due after the ack in real life
  });

  it('an ack reply without an acknowledgement result is not reported as acked', () => {
    f.ackReply = () => ({ data: {} });
    go();
    expect(log()).toContain('ack FAILED');
    expect(log()).not.toMatch(/; acked /);
  });

  it('an ambiguous send is never retyped and never acked', () => {
    f.sendReply = () => 'not json';
    go();
    expect(f.sent).toHaveLength(1);
    f.sendReply = null;
    lines = [];
    go();
    expect(f.sent).toHaveLength(1);
    expect(f.acked).toEqual([]);
    expect(log()).toContain('ambiguous');
  });

  it('a refused send leaves the wake due and retypes later', () => {
    f.sendReply = () => JSON.stringify({ ok: false, error: { code: 'busy' } });
    go();
    expect(f.acked).toEqual([]);
    expect(log()).toContain('send not confirmed');
    f.sendReply = null;
    go();
    expect(f.acked).toEqual(['proof-Ada']);
  });

  it('identity is stable across a re-read proof: worker + ticker ticks', () => {
    const payload = (k: number, iat: number) => `${Buffer.from(JSON.stringify({ ticks: [{ tickerId: 'T', k }], issuedAt: iat })).toString('base64url')}.sig`;
    expect(wakeIdentity('w', payload(5, 1))).toBe(wakeIdentity('w', payload(5, 999)));
    expect(wakeIdentity('w', payload(5, 1))).not.toBe(wakeIdentity('w', payload(6, 1)));
    expect(wakeIdentity('w', 'opaque')).toBe('w|proof:opaque');
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

  it('rejects an unknown mode, flag, or a bad interval with exit 2 and does nothing', async () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK])];
    for (const argv of [['bogus'], [], ['once', '--nope'], ['loop', '--dry'], ['loop', '--interval', '0'], ['loop', '--interval', 'x'], ['loop', '--interval', 'Infinity'], ['loop', '--interval'], ['once', '--interval', '30']]) {
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
    f.wakes = [wake('w-ada', 'Ada', [TICK])];
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

  it('a stale lock (dead pid) is taken over', () => {
    const stateDir = join(dir, 'ticker-wake');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'lock'), '999999999');
    const release = acquireLock(stateDir);
    expect(readFileSync(join(stateDir, 'lock'), 'utf8')).toBe(String(process.pid));
    release();
    expect(existsSync(join(stateDir, 'lock'))).toBe(false);
  });
});
