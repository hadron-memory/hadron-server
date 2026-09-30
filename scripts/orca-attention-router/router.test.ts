/**
 * The Orca attention router. No network, no Orca: a fake runner plays both
 * `hadron team attention` and `orca terminal list|wait|send`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Config, type Runner, type RunResult, RouterError, State, describeOutcome, loadConfig, pollOnce, status,
} from './router.js';

const TOKEN_1 = 'tok-one-SECRET';
const TOKEN_2 = 'tok-two-SECRET';
const CHANNEL = 'chan-team';

function worker(id: string, name: string, o: { mentions?: number; unread?: number; first?: number; last?: number } = {}) {
  return {
    worker: id, name, live: true,
    channels: [{ channel: CHANNEL, unread: o.unread ?? 3, unreadMentions: o.mentions ?? 1,
      firstUnreadSeq: o.first ?? 100, lastSeq: o.last ?? 110 }],
  };
}

class FakeCLIs {
  attention: { token: string; workers: unknown[] } = { token: TOKEN_1, workers: [] };
  attentionOk = true;
  terminals: Array<Record<string, unknown>> = [];
  busy = new Set<string>();
  reject = new Set<string>();
  sent: Array<[string, string]> = [];
  /** Workers with a mention-only row; `null` = every worker queried has one. */
  mentionOnly: Set<string> | null = null;
  calls: string[][] = [];

  constructor(readonly root: string) {}

  terminal(name: string, agent: string | null = 'claude', handle?: string) {
    const wt = join(this.root, 'workspaces', name);
    mkdirSync(wt, { recursive: true });
    this.terminals.push({ handle: handle ?? `term_${name}`, worktreePath: wt, agentIdentity: agent, connected: true, writable: true });
  }

  run: Runner = (argv) => {
    this.calls.push(argv);
    const out = (d: unknown, code = 0): RunResult => ({ code, stdout: JSON.stringify(d), stderr: '' });
    const verb = argv.slice(1, 3).join(' ');
    if (verb === 'team attention') {
      return this.attentionOk ? out(this.attention) : out({ error: { message: 'boom' } }, 1);
    }
    if (argv[1] === 'api') {
      const ids = this.mentionOnly ?? new Set(['w-eli', 'w-baloo', 'w-ada']);
      return out({ data: { registerEntries: { items: [...ids].map((id) => ({ attendeeWorkerId: id, mentionOnly: true })) } } });
    }
    if (verb === 'terminal list') return out({ ok: true, result: { terminals: this.terminals } });
    const handle = argv[argv.indexOf('--terminal') + 1];
    if (verb === 'terminal wait') {
      return this.busy.has(handle)
        ? out({ ok: false, error: { code: 'timeout', message: 'timeout' } })
        : out({ ok: true, result: { wait: { satisfied: true } } });
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
    expect(fake.sent[0][1]).toContain('5 relevant unread (2 mentions)');
    const verbs = fake.calls.map((a) => a.slice(1, 3).join(' '));
    expect(verbs.indexOf('terminal wait')).toBeLessThan(verbs.indexOf('terminal send'));
  });

  it('passes the adopted token back on the next poll', () => {
    const c = cfg(['w-eli', 'Eli']);
    poll(c);
    fake.attention.token = TOKEN_2;
    poll(c);
    const polls = fake.calls.filter((a) => a[1] === 'team');
    expect(polls[0]).not.toContain('--since');
    expect(polls[1][polls[1].indexOf('--since') + 1]).toBe(TOKEN_1);
  });

  it('leaves workers off the roster, and roster workers without a mention, alone', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli');
    fake.attention.workers = [worker('w-ada', 'Ada'), worker('w-eli', 'Eli', { mentions: 0 })];
    expect(poll(c).adopted).toBe(true);
    expect(fake.sent).toEqual([]);
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

  it('nudges again a worker who read past its nudge and has a new mention', () => {
    const c = cfg(['w-eli', 'Eli'], ['w-baloo', 'Baloo']);
    fake.terminal('eli');
    fake.terminal('baloo');
    fake.busy.add('term_baloo');
    fake.attention.workers = [worker('w-eli', 'Eli', { first: 100, last: 110 }), worker('w-baloo', 'Baloo')];
    poll(c);
    fake.attention.workers = [worker('w-eli', 'Eli', { first: 115, last: 115 }), worker('w-baloo', 'Baloo')];
    expect(poll(c).nudged).toEqual(['Eli']);
    expect(sentHandles()).toEqual(['term_eli', 'term_eli']);
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

  it('a row that is not mention-only does not count', () => {
    const c = cfg(['w-eli', 'Eli']);
    fake.terminal('eli');
    const base = fake.run;
    fake.run = (argv) => (argv[1] === 'api'
      ? { code: 0, stderr: '', stdout: JSON.stringify({ data: { registerEntries: { items: [{ attendeeWorkerId: 'w-eli', mentionOnly: false }] } } }) }
      : base(argv));
    fake.attention.workers = [worker('w-eli', 'Eli')];
    expect(poll(c).held.Eli).toMatch(/mention-only/);
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

  it('a second concurrent run is refused', () => {
    const c = cfg(['w-eli', 'Eli']);
    mkdirSync(join(c.stateDir, '.writer-lock'), { recursive: true });
    expect(() => poll(c)).toThrow(RouterError);
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
  });
});
