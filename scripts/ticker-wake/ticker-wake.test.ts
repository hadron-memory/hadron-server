import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config, Runner } from '../orca-attention-router/router.js';
import { pass } from './ticker-wake.js';

const RULE = '─'.repeat(112);
// A finished Claude Code 2.1.303 turn over an empty composer (shapes from the cli#907 captures): the
// mode footer WITHOUT the transient "· ← for agents" suffix.
const CLAUDE_START = [
  '❯ reply with exactly the word ok', '● ok', '✻ Crunched for 2s · done 11:14 PM',
  RULE, '❯', RULE, '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
];
const TICK = { kind: 'TICK', ticker: { name: 'coordinator-tick' } };
const MENTION = { kind: 'MENTION', ticker: null };

interface Fake {
  run: Runner;
  wakes: any[];
  subscribers: string[];
  acked: string[];
  sent: string[];
  idle: boolean;
  screen: Record<string, any>;
  dueQueryAsked: string[];
}

function fake(): Fake {
  const f: Fake = { wakes: [], subscribers: [], acked: [], sent: [], idle: true, screen: { source: 'screen', tail: CLAUDE_START }, dueQueryAsked: [], run: undefined as any };
  f.run = (argv) => {
    const out = (o: unknown) => ({ code: 0, stdout: JSON.stringify(o), stderr: '' });
    if (argv[0] === 'hadron') {
      const q = argv[2];
      if (q.includes('acknowledgeWakes')) {
        const proofs = JSON.parse(argv[argv.indexOf('-F', 3) + 1].replace(/^p=/, ''));
        f.acked.push(...proofs);
        return out({ data: { acknowledgeWakes: { acknowledged: proofs.length, unchanged: 0 } } });
      }
      if (q.includes('dueWakes')) {
        f.dueQueryAsked.push(q);
        return out({ data: { dueWakes: { wakes: f.wakes, pageInfo: { hasNextPage: false, endCursor: null } } } });
      }
      if (q.includes('tickers(')) {
        return out({ data: { tickers: [{ subscribers: { items: f.subscribers.map((id) => ({ worker: { id } })) } }] } });
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
        return out({ ok: true, result: { send: { accepted: true } } });
      }
    }
    throw new Error(`unexpected call ${JSON.stringify(argv)}`);
  };
  return f;
}

let dir: string;
let f: Fake;
let lines: string[];
const wake = (id: string, name: string, reasons: any[], channels: any[] = [], proof = `proof-${name}`) => ({
  worker: { id, name }, reasons, channels, proof,
});
const cfg = (): Config => ({
  app: 'hrn:app:test:team', channel: 'chan', hadronCli: 'hadron', orcaCli: 'orca', stateDir: dir,
  roster: [{ worker: 'w-ada', name: 'Ada', worktree: dir, terminal: 'term_a' }],
  busyWaitMs: 10, submitWaitS: 1, coordinatorWatchMinutes: 20,
} as Config);
const go = (opts: { dry?: boolean; ackMentions?: boolean } = {}) => pass(cfg(), f.run, opts, (l) => lines.push(l));

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ticker-wake-')); f = fake(); lines = []; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('ticker-wake pass', () => {
  it('delivers a TICK wake and acks it by its own proof', () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], [{ fromSeq: 1, throughSeq: 2 }], 'proof-ada-1')];
    go();
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toContain('coordinator-tick');
    expect(f.acked).toEqual(['proof-ada-1']);
  });

  it('selects TICK only: a MENTION-only wake is neither nudged nor acked', () => {
    f.wakes = [wake('w-ada', 'Ada', [MENTION])];
    go();
    expect(f.sent).toEqual([]);
    expect(f.acked).toEqual([]);
    expect(lines.join('\n')).toContain('1 mention-only wakes ignored');
  });

  it('delivers a TICK wake with empty channels (#2068) and never asks for channels', () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], [])];
    go();
    expect(f.sent).toHaveLength(1);
    expect(f.acked).toEqual(['proof-Ada']);
    expect(f.dueQueryAsked[0]).not.toContain('channels');
  });

  it('a merged MENTION+TICK wake is delivered once and acked once', () => {
    f.wakes = [wake('w-ada', 'Ada', [MENTION, TICK])];
    go();
    expect(f.sent).toHaveLength(1);
    expect(f.acked).toEqual(['proof-Ada']);
  });

  it('a send that is not accepted leaves the wake due: no ack', () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK])];
    const base = f.run;
    f.run = (argv) => (argv[2] === 'send'
      ? { code: 0, stdout: JSON.stringify({ ok: false, error: { code: 'busy' } }), stderr: '' }
      : base(argv));
    go();
    expect(f.acked).toEqual([]);
    expect(lines.join('\n')).toContain('send not accepted');
  });

  it('a worker not on the roster is skipped without an ack', () => {
    f.wakes = [wake('w-other', 'Zed', [TICK])];
    go();
    expect(f.sent).toEqual([]);
    expect(f.acked).toEqual([]);
    expect(lines.join('\n')).toContain('Zed: not on roster');
  });

  it('--dry sends and acks nothing', () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK])];
    go({ dry: true });
    expect(f.sent).toEqual([]);
    expect(f.acked).toEqual([]);
    expect(lines.join('\n')).toContain('WOULD nudge');
  });
});

describe('--ack-mentions', () => {
  beforeEach(() => {
    f.subscribers = ['w-ada'];
    f.wakes = [wake('w-ada', 'Ada', [MENTION], [], 'proof-stuck'), wake('w-eve', 'Eve', [MENTION], [], 'proof-eve')];
  });

  it('is OFF by default: no subscriber lookup and no ack', () => {
    go();
    expect(f.acked).toEqual([]);
  });

  it('when set, acks only the subscribers\' MENTION-only wakes, with no nudge', () => {
    go({ ackMentions: true });
    expect(f.acked).toEqual(['proof-stuck']); // Eve is not a ticker subscriber
    expect(f.sent).toEqual([]);
  });

  it('never acks a subscriber\'s wake that carries a TICK as a stuck mention', () => {
    f.wakes = [wake('w-ada', 'Ada', [MENTION, TICK], [], 'proof-both')];
    go({ ackMentions: true });
    expect(f.acked).toEqual(['proof-both']); // once, through the delivery path
    expect(f.sent).toHaveLength(1);
  });
});

describe('idle gate (C1 rule)', () => {
  beforeEach(() => { f.wakes = [wake('w-ada', 'Ada', [TICK])]; });

  it('tui-idle satisfied: delivered', () => {
    go();
    expect(f.sent).toHaveLength(1);
  });

  it('Claude composer with the mode footer and NO agents suffix, no draft: delivered via the screen', () => {
    f.idle = false;
    go();
    expect(f.sent).toHaveLength(1);
    expect(f.acked).toEqual(['proof-Ada']);
  });

  it('an Orca draft holds the nudge and the wake stays due', () => {
    f.idle = false;
    f.screen = { source: 'screen', tail: CLAUDE_START, draft: 'half typed' };
    go();
    expect(f.sent).toEqual([]);
    expect(f.acked).toEqual([]);
    expect(lines.join('\n')).toContain('held');
  });

  it('a second footer row is not the mode line: held', () => {
    f.idle = false;
    f.screen = { source: 'screen', tail: [...CLAUDE_START, '  esc to interrupt'] };
    go();
    expect(f.sent).toEqual([]);
    expect(f.acked).toEqual([]);
  });
});
