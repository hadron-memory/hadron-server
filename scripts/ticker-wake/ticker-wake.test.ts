import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config, Runner } from '../orca-attention-router/router.js';
import { buildSchema, parse, validate } from 'graphql';
import { typeDefs } from '../../src/api/graphql/schema/typeDefs.js';
import { pass, main, acquireLock, proofCoverage, nudgeText, QUERY, ACK, WORKER_CHECK, TASK_STATE, SUBSCRIBERS, SUBSCRIBERS_PAGE, CURRENT_SESSION, ALARM_EVENT, DELIVERY_POOL, SUBMIT_PROBE_S, runCommandAsync, holdOf } from './ticker-wake.js';
import type { RunResult } from '../orca-attention-router/router.js';

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
/** A TASK reason for task `id`, event `event` (#1708); its proof entry is `taskEntry(...)`. */
const task = (id: string, event = 'ASSIGNED', eventId = `e-${id}`, chainIndex = 0) =>
  ({ kind: 'TASK', ticker: null, task: { id, eventId, chainIndex, event } });
const taskEntry = (id: string, eventId = `e-${id}`, chainIndex = 0) => ({ eventId, chainIndex });
/** A task event this script never delivers (#1704: END_SESSION needs the host poller). */
const TASK = task('t1', 'END_SESSION');
const CONFIRMED = { ok: true, result: { send: { accepted: true, prompt: { requestId: 'r1', stages: ['input_accepted', 'turn_started'] } } } };
const NO_ID_ACCEPTED = { ok: true, result: { send: { accepted: true, prompt: { stages: ['input_accepted'] } } } };
/** A bare `--enter` reply (Hugo's host check, #26146): the raw input path, no request id, no stages. */
const ENTER_WRITTEN = { ok: true, result: { send: { accepted: true, bytesWritten: 1 } } };
const ACCEPTED_ONLY = { ok: true, result: { send: { accepted: true, prompt: { requestId: 'r1', stages: ['input_accepted'] } } } };

/** A proof whose payload carries the given ticks ("T:k"), like the server's (opaque to everything else). */
const proof = (ticks: string[], salt: string | number = 'x', tasks: Array<{ eventId: string; chainIndex: number }> = []) =>
  `${Buffer.from(JSON.stringify({ ticks: ticks.map((t) => ({ tickerId: t.split(':')[0], k: Number(t.split(':')[1]) })), tasks, issuedAt: salt })).toString('base64url')}.sig`;

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
  /** The worker's checkStatus.lastCheckedAt as the server reports it; null = never checked. */
  lastCheckedAt: string | null;
  /** agentTask(id) replies, by task id. */
  tasks: Record<string, unknown>;
  evidenceQueries: string[];
  /** When set, the worker check-status read answers this GraphQL error. */
  checkError: string | null;
  /** Bare `--enter` sends (no --text), by terminal handle (#2138 stranded drafts). */
  enters: string[];
  enterReply: (() => string) | null;
  /** #2138: the App's live tickers, each with its subscriber pages ([[{id,name}...], ...]). */
  tickers: Array<{ id: string; pages: Array<Array<{ id: string; name: string }>> }>;
  subscribersError: string | null;
  /** Terminals listed besides term_a. */
  extraTerminals: any[];
  terminalReply?: () => unknown;
  /** #2161: each worker's sessions as the server lists them, newest first. */
  sessions: Record<string, Array<{ id: string; workerId: string; appId: string; endedAt: string | null }>>;
  sessionsError: string | null;
  sessionQueries: string[];
  /** #1704: agentTeamEvents(taskId, alarmsOnly) replies, by task id. */
  alarms: Record<string, unknown[]>;
  /** When set, the alarm read answers this GraphQL error. */
  alarmError: string | null;
  alarmQueries: string[];
  /** #2613: agentTasks rows by worker id (the open-task read), the reads seen, and a failure switch. */
  openTasks: Record<string, unknown[]>;
  openTaskReads: string[][];
  openTasksError: boolean;
  /** #2613: the order of the open-task read, screen reads and sends. */
  order: string[];
  /** #2613: runs when the open-task read is served (a test clock advances here). */
  onCount: (() => void) | null;
}

let dir: string;
let f: Fake;
let lines: string[];

function fake(): Fake {
  const f: Fake = {
    wakes: [], acked: [], sent: [], idle: true, screen: { source: 'screen', tail: CLAUDE_IDLE },
    dueQueries: [], pages: 0, alwaysMore: false, ackReply: null, sendReply: null, dueError: null,
    incarnation: 'inc-1', retries: [], retryReply: null, run: undefined as any,
    lastCheckedAt: null, tasks: {}, evidenceQueries: [], checkError: null, enters: [], enterReply: null,
    tickers: [], subscribersError: null, extraTerminals: [], sessions: {}, sessionsError: null, sessionQueries: [],
    alarms: {}, alarmError: null, alarmQueries: [], openTasks: {}, openTaskReads: [], openTasksError: false, order: [], onCount: null,
  };
  const subPage = (t: { pages: Array<Array<{ id: string; name: string }>> }, i: number) => ({
    items: (t.pages[i] ?? []).map((w) => ({ worker: w })), hasNextPage: i + 1 < t.pages.length, endCursor: i + 1 < t.pages.length ? `p${i + 1}` : null,
  });
  const fArg = (argv: string[], k: string): string | undefined => argv.find((a, i) => argv[i - 1] === '-F' && a.startsWith(`${k}=`))?.slice(k.length + 1);
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
      if (q.includes('tickers(appRef')) {
        if (f.subscribersError) return out({ errors: [{ message: f.subscribersError, extensions: { code: 'INTERNAL_SERVER_ERROR' } }] });
        return out({ data: { tickers: f.tickers.map((t) => ({ id: t.id, subscribers: subPage(t, 0) })) } });
      }
      if (q.includes('ticker(ref')) {
        const t = f.tickers.find((x) => x.id === fArg(argv, 't'));
        return out({ data: { ticker: t ? { subscribers: subPage(t, Number((fArg(argv, 'p') ?? 'p0').slice(1))) } : null } });
      }
      if (q.includes('sessions(workerRef')) {
        const w = fArg(argv, 'w') as string;
        f.sessionQueries.push(w);
        if (f.sessionsError) return out({ errors: [{ message: f.sessionsError, extensions: { code: 'INTERNAL_SERVER_ERROR' } }] });
        return out({ data: { sessions: (f.sessions[w] ?? []).slice(0, 1) } });
      }
      if (q.includes('checkStatus')) {
        f.evidenceQueries.push(`worker ${fArg(argv, 'w')}`);
        if (f.checkError) return out({ errors: [{ message: f.checkError, extensions: { code: 'INTERNAL_SERVER_ERROR' } }] });
        return out({ data: { worker: { id: fArg(argv, 'w'), checkStatus: { lastCheckedAt: f.lastCheckedAt } } } });
      }
      if (q.includes('agentTeamEvents(')) {
        const t = fArg(argv, 't') as string;
        f.alarmQueries.push(`${fArg(argv, 'a')} ${t}`);
        if (f.alarmError) return out({ errors: [{ message: f.alarmError, extensions: { code: 'INTERNAL_SERVER_ERROR' } }] });
        // Like the server: oldest first, strictly after the given event, at most 200.
        const all = (f.alarms[t] ?? []) as Array<{ id: string }>;
        const after = fArg(argv, 'p');
        const from = after === undefined ? 0 : all.findIndex((e) => e.id === after) + 1;
        return out({ data: { agentTeamEvents: all.slice(from, from + 200) } });
      }
      if (q.includes('agentTasks(')) {
        f.order.push('count');
        f.onCount?.();
        f.openTaskReads.push([fArg(argv, 'a') as string, fArg(argv, 'w') as string, fArg(argv, 'o') as string]);
        if (f.openTasksError) return out({ errors: [{ message: 'tasks down', extensions: { code: 'INTERNAL_SERVER_ERROR' } }] });
        const o = Number(fArg(argv, 'o'));
        return out({ data: { agentTasks: (f.openTasks[fArg(argv, 'w') as string] ?? []).slice(o, o + 200) } });
      }
      if (q.includes('agentTask(')) {
        const t = fArg(argv, 't') as string;
        f.evidenceQueries.push(`task ${t}`);
        return out({ data: { agentTask: f.tasks[t] ?? null } });
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
        if (f.terminalReply) return out(f.terminalReply());
        return out({ ok: true, result: { hostScope: { hostIds: ['local'], omittedHostIds: [] }, terminals: [{ handle: 'term_a', incarnationId: f.incarnation, worktreePath: dir, connected: true, writable: true, agentIdentity: 'claude' }, ...f.extraTerminals] } });
      }
      if (argv[2] === 'wait') return out({ ok: f.idle, result: { wait: { satisfied: f.idle } }, error: f.idle ? undefined : { code: 'timeout' } });
      if (argv[2] === 'read') f.order.push('read');
      if (argv[2] === 'read') return out({ ok: true, result: { terminal: f.screen } });
      if (argv[2] === 'send' && !argv.includes('--text')) {
        f.enters.push(argv[argv.indexOf('--terminal') + 1]);
        return { code: 0, stdout: f.enterReply ? f.enterReply() : JSON.stringify(ENTER_WRITTEN), stderr: '' };
      }
      if (argv[2] === 'send' && argv.includes('--retry-request')) {
        f.retries.push(argv[argv.indexOf('--retry-request') + 1]);
        return { code: 0, stdout: f.retryReply ? f.retryReply() : JSON.stringify(ACCEPTED_ONLY), stderr: '' };
      }
      if (argv[2] === 'send') {
        f.order.push('send');
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
const wake = (id: string, name: string, reasons: any[], p = proof(['T:1']), channels: any[] = [], timing?: { anchorAt: string; deliverAfter: string; busyDeadline: string }, tickText?: string | null) => ({
  worker: { id, name }, reasons, channels, proof: p,
  // #2754: absent (not null) when the caller passes nothing, like a reply recorded before the server wrote a tick line.
  ...(tickText === undefined ? {} : { tickText }),
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
  it('delivers a TICK-only wake and acks it by its own proof', async () => {
    const p = proof(['T:1'], 'a');
    f.wakes = [wake('w-ada', 'Ada', [TICK], p, [{ fromSeq: 1, throughSeq: 2 }])];
    await go();
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toContain('coordinator-tick');
    expect(f.acked).toEqual([p]);
  });

  it('a MENTION-only wake is neither nudged nor acked', async () => {
    f.wakes = [wake('w-ada', 'Ada', [MENTION])];
    await go();
    expect(f.sent).toEqual([]);
    expect(f.acked).toEqual([]);
    expect(log()).toContain('1 other wakes ignored');
  });

  it('delivers a TICK wake with empty channels (#2068) and never asks for channels', async () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1']), [])];
    await go();
    expect(f.sent).toHaveLength(1);
    expect(f.acked).toHaveLength(1);
    expect(f.dueQueries[0]).not.toContain('channels');
  });

  // #2069 (landed in #2102): a MENTION-only reservation absorbs a later tick, so the due wake is TICK+MENTION. R53
  // (#2072, cor:agt:080:04/:16): a wake carries no message text and acknowledging it moves NO message mark, so acking the
  // joined proof records the tick and spends the reservation and never marks the mention delivered or read (S1 text
  // batches and the worker's own read do that). Without delivering the joined wake, every worker holding an outstanding
  // mention would never get its ticks: the dark team #2069 describes.
  it('TICK+MENTION is delivered: nudged once and acked (the ack moves no message mark, R53)', async () => {
    const p = proof(['T:1']);
    f.wakes = [wake('w-ada', 'Ada', [TICK, MENTION], p)];
    await go();
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toContain('coordinator-tick');
    expect(f.acked).toEqual([p]);
  });

  // Vera's pin (spec fit at fd5d2f33, cor:agt:080:04/:13): the ack moved no mark, so the mention stays due and the server
  // offers it again past the floor. The server half is proven live (Coco's stack); this is the loop's half of the sequence:
  // it must not swallow or ack the re-offered mention, and it must still deliver the next tick that joins it.
  it('after a joined TICK+MENTION ack, the re-offered MENTION-only wake is left alone and the next joined tick is delivered', async () => {
    const p1 = proof(['T:1'], 'one');
    f.wakes = [wake('w-ada', 'Ada', [TICK, MENTION], p1)];
    await go();
    expect(f.sent).toHaveLength(1);
    expect(f.acked).toEqual([p1]);
    f.wakes = [wake('w-ada', 'Ada', [MENTION], proof([], 'again'))]; // the mention, offered again past the floor
    await go();
    expect(f.sent, 'a MENTION-only wake must not be typed').toHaveLength(1);
    expect(f.acked, 'a MENTION-only wake must not be acked').toEqual([p1]);
    const p2 = proof(['T:2'], 'two');
    f.wakes = [wake('w-ada', 'Ada', [TICK, MENTION], p2)]; // the next tick joins the still-due mention
    await go();
    expect(f.sent).toHaveLength(2);
    expect(f.acked).toEqual([p1, p2]);
  });

  it('TICK+TASK (not an assignment) and TICK+unknown are left alone: no nudge, no ack, no receipt (a proof naming task events records them delivered)', async () => {
    for (const extra of [TASK, { kind: 'FUTURE', ticker: null }]) {
      f.wakes = [wake('w-ada', 'Ada', [TICK, extra])];
      await go();
    }
    expect(f.sent).toEqual([]);
    expect(f.acked).toEqual([]);
    expect(log()).toContain('left alone');
    expect(existsSync(receiptsFile())).toBe(false);
  });

  it('a joined TICK+MENTION proof after an earlier delivery is never retyped; the lost ack is recovered ack-only', async () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1']))];
    f.ackReply = () => ({ errors: [{ message: 'down' }] });
    await go(); // typed, ack lost: a sent receipt exists
    f.ackReply = null;
    const joined = proof(['T:1'], 'joined');
    f.wakes = [wake('w-ada', 'Ada', [TICK, MENTION], joined)];
    await go();
    expect(f.sent).toHaveLength(1); // still the one original nudge: the joined re-offer is not typed again
    expect(f.acked).toEqual([joined]); // its tick coverage is fully covered by the confirmed receipt
  });

  it('a worker with no roster row and no binding on this host is held without an ack, and logged unreachable', async () => {
    f.wakes = [wake('w-other', 'Zed', [TICK])];
    await go();
    expect(f.sent).toEqual([]);
    expect(f.acked).toEqual([]);
    expect(log()).toContain('Zed: held (no binding on this host)');
    expect(log()).toContain('unreachable on this host (1): Zed (no binding)');
  });

  it('a proof whose tick coverage cannot be decoded is held', async () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], 'opaque')];
    await go();
    expect(f.sent).toEqual([]);
    expect(f.acked).toEqual([]);
    expect(log()).toContain('tick coverage cannot be established');
  });

  it('a roster/identity mismatch holds: the worktree is bound to another worker', async () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK])];
    mkdirSync(join(dir, '.git'), { recursive: true });
    writeFileSync(join(dir, '.git', 'hadron-team-session.json'), JSON.stringify({ workerId: 'w-someone-else' }));
    await go();
    expect(f.sent).toEqual([]);
    expect(f.acked).toEqual([]);
    expect(log()).toContain('bound to another worker');
  });

  it('--dry sends and acks nothing and writes no receipt', async () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK])];
    await go({ dry: true });
    expect(f.sent).toEqual([]);
    expect(f.acked).toEqual([]);
    expect(log()).toContain('WOULD nudge');
    expect(existsSync(receiptsFile())).toBe(false);
  });

  it('proofCoverage decodes the ticks and task events, sorted, and returns null for an opaque or empty proof', async () => {
    expect(proofCoverage(proof(['B:2', 'A:1']))).toEqual(['A:1', 'B:2']);
    expect(proofCoverage(proof(['A:1'], 'x', [taskEntry('t1')]))).toEqual(['A:1', 'task:e-t1#0']);
    expect(proofCoverage(proof([], 'x', [taskEntry('t1', 'e9', 2)]))).toEqual(['task:e9#2']);
    expect(proofCoverage('opaque')).toBeNull();
    expect(proofCoverage(`${Buffer.from(JSON.stringify({ ticks: [], tasks: [] })).toString('base64url')}.s`)).toBeNull();
    expect(proofCoverage(`${Buffer.from(JSON.stringify({ ticks: [], tasks: [{ eventId: 'e' }] })).toString('base64url')}.s`)).toBeNull();
  });
});

describe('#2138 §5.2: the nudge text, task assignments and live-check', () => {
  /** The reads and the mark-read a nudge must name (Yuri #26114; George's #2156 P2: a cursorless read is the newest page only). */
  const PROBE = '`hadron team chat read --mentions-me --limit 1` (it prints `cursor #C; channel head #H`)';
  const FULL = '`hadron team chat read --mentions-me --since C --all`';
  const MARK = "only if that read succeeded and you saw all of its output (if your tool truncated or saved it, read the rest first; if you can't, don't mark), run `hadron team chat mark-read --through H` with the H that read printed";
  const CHECK = `run ${PROBE}, then ${FULL} and act on the tagged messages it returns; ${MARK}`;

  /**
   * A worker that follows the nudge's commands literally, against the read semantics of the released CLI v0.26.0
   * (8c428a7, internal/cmd/team/chat.go): the read-state line (cursor, head) is sampled BEFORE the fetch; with no
   * --since/--all it is a tail read of the newest `--limit` (default 200) matching messages; `--since N --all` walks
   * 200-message pages forward from N until a short page, and any failed page fails the whole command before output.
   * `C` resolves to the printed cursor, `H` to the head printed by the latest read; a conditional mark is skipped when
   * that read failed. `tool` models the worker's host: it may show only the first `shows` messages of the full read's
   * output (truncated, or saved to a file), and the worker may or may not be able to read the rest; a worker reads the
   * rest, or holds the mark, only when the nudge tells it to. Returns the seqs it saw and the mark (null: none).
   */
  const follow = (nudge: string, chat: { cursor: number; head: number; tagged: number[] }, failFullRead = false,
    tool: { shows?: number; canReadRest?: boolean } = {}) => {
    const toldSeeAll = nudge.includes('you saw all of its output');
    let sawAll = true;
    const cmds = [...nudge.matchAll(/`(hadron team chat [^`]+)`/g)].map((m) => m[1].split(/\s+/).slice(3));
    const seen = new Set<number>();
    let printed: { cursor: number; head: number } | null = null;
    let lastOk = false;
    let marked: number | null = null;
    const tagged = chat.tagged.filter((t) => t <= chat.head).sort((a, b) => a - b);
    for (const a of cmds) {
      const flag = (k: string): string | undefined => (a.includes(k) ? a[a.indexOf(k) + 1] : undefined);
      if (a[0] === 'read') {
        printed = { cursor: chat.cursor, head: chat.head };
        const sinceArg = flag('--since');
        const since = sinceArg === undefined ? undefined : sinceArg === 'C' ? printed.cursor : Number(sinceArg);
        const limit = Number(flag('--limit') ?? 200);
        if (a.includes('--all') && failFullRead) { lastOk = false; continue; }
        const page = since === undefined ? tagged.slice(-limit)
          : a.includes('--all') ? tagged.filter((t) => t > since) : tagged.filter((t) => t > since).slice(0, limit);
        const truncated = a.includes('--all') && tool.shows !== undefined && page.length > tool.shows;
        const readRest = truncated && toldSeeAll && Boolean(tool.canReadRest);
        (truncated && !readRest ? page.slice(0, tool.shows) : page).forEach((t) => seen.add(t));
        sawAll = !truncated || readRest;
        lastOk = true;
      } else if (a[0] === 'mark-read') {
        if (nudge.includes('only if that read succeeded') && !lastOk) continue;
        if (toldSeeAll && !sawAll) continue;
        const through = flag('--through');
        marked = through === 'H' || through?.startsWith('<') ? (printed?.head ?? null) : Number(through); // any placeholder names the printed head
      }
    }
    return { seen, marked };
  };
  /** Nothing tagged at or below the mark was left unseen. */
  const noGap = (chat: { cursor: number; tagged: number[] }, r: { seen: Set<number>; marked: number | null }) =>
    r.marked === null || chat.tagged.filter((t) => t > chat.cursor && t <= (r.marked as number)).every((t) => r.seen.has(t));

  it("George's #2156 fixture: cursor 0, head 201, 201 tagged messages; following the nudge marks nothing read unseen", () => {
    const chat = { cursor: 0, head: 201, tagged: Array.from({ length: 201 }, (_, i) => i + 1) };
    for (const text of [nudgeText(['coordinator-tick'], []), nudgeText([], ['t1'])]) {
      const r = follow(text, chat);
      expect(r.marked).toBe(201);
      expect(r.seen.has(1)).toBe(true);
      expect(noGap(chat, r)).toBe(true);
    }
  });

  it('a backlog over several pages from a mid-channel cursor is read in full before the mark; an empty one still marks', () => {
    const big = { cursor: 1_000, head: 1_650, tagged: Array.from({ length: 600 }, (_, i) => 1_001 + i) };
    expect(noGap(big, follow(nudgeText(['t'], []), big))).toBe(true);
    const empty = { cursor: 1_000, head: 1_010, tagged: [] };
    expect(follow(nudgeText(['t'], []), empty).marked).toBe(1_010); // the check is still stamped on an empty read
  });

  it('truncated output: a worker that cannot read the rest marks nothing; one that reads the saved rest marks with no gap', () => {
    const chat = { cursor: 0, head: 201, tagged: Array.from({ length: 201 }, (_, i) => i + 1) };
    const cannot = follow(nudgeText(['coordinator-tick'], []), chat, false, { shows: 50, canReadRest: false });
    expect(cannot.marked).toBeNull();
    expect(noGap(chat, cannot)).toBe(true);
    const can = follow(nudgeText(['coordinator-tick'], []), chat, false, { shows: 50, canReadRest: true });
    expect(can.marked).toBe(201);
    expect(noGap(chat, can)).toBe(true);
  });

  it('a failed full read marks nothing', () => {
    const chat = { cursor: 0, head: 201, tagged: Array.from({ length: 201 }, (_, i) => i + 1) };
    expect(follow(nudgeText(['coordinator-tick'], []), chat, true).marked).toBeNull();
  });

  // #2138 (Marco #26709): the coordinator's ticker asks for its base tick, the tagged check first, then the sweep.
  const BASE = `run your base tick (coordinator-system:tasks:on-base-tick): first the tagged check: ${CHECK}; then the sweep of your owned tasks, alarms and ready heads`;

  it('a tick nudge names the exact commands, in order, on one line (pinned text): the coordinator-tick runs the base tick', async () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK])];
    await go();
    expect(f.sent).toEqual([`Hadron ticker wake (coordinator-tick): ${BASE}; then continue your in-progress work; end your turn only if you have none. No unfiltered chat catch-up.`]);
    expect(f.sent[0]).not.toContain('\n');
  });

  it('#2138: a team-tick nudge keeps today\'s text; a wake carrying both tickers is the coordinator\'s (pinned texts)', () => {
    expect(nudgeText(['team-tick'], [])).toBe(`Hadron ticker wake (team-tick): ${CHECK}; then continue your in-progress work; end your turn only if you have none. No unfiltered chat catch-up.`);
    expect(nudgeText(['coordinator-tick', 'team-tick'], [])).toBe(
      `Hadron ticker wake (coordinator-tick, team-tick): ${BASE}; then continue your in-progress work; end your turn only if you have none. No unfiltered chat catch-up.`,
    );
    expect(nudgeText(['team-tick', 'coordinator-tick'], [])).toContain(BASE);
    for (const t of [nudgeText(['team-tick'], []), nudgeText(['coordinator-tick'], [])]) expect(t).not.toContain('\n');
  });

  it('#2138 (Diego #28498): a tick nudge never tells a worker mid-build to stop; it resumes the work in progress', () => {
    for (const t of [nudgeText(['team-tick'], []), nudgeText(['coordinator-tick'], []), nudgeText(['coordinator-tick', 'team-tick'], [])]) {
      expect(t).not.toMatch(/then end your turn\./);
      expect(t).toContain('; then continue your in-progress work; end your turn only if you have none. ');
    }
  });

  it('a task nudge names the same reads and mark, then the task, on one line (pinned text)', () => {
    expect(nudgeText(['team-tick'], ['t1'])).toBe(
      `Hadron task assigned (t1; ticker team-tick): ${CHECK}; then start the task (\`hadron team task get t1\`). No unfiltered chat catch-up.`,
    );
    expect(nudgeText(['coordinator-tick'], ['t1'])).toBe(
      `Hadron task assigned (t1; ticker coordinator-tick): ${BASE}; then start the task (\`hadron team task get t1\`). No unfiltered chat catch-up.`,
    );
    expect(nudgeText([], ['t1', 't2'])).toContain('(`hadron team task list`)');
    for (const t of [nudgeText(['a'], []), nudgeText([], ['t1']), nudgeText(['a'], ['t1', 't2'])]) expect(t).not.toContain('\n');
  });

  it('live-check fires an ordinary TICK reason, so it is nudged and acked like any tick', async () => {
    const p = proof(['L:1']);
    f.wakes = [wake('w-ada', 'Ada', [{ kind: 'TICK', ticker: { id: 'L', name: 'team' } }], p)];
    await go();
    expect(f.sent).toEqual([nudgeText(['team'], [])]);
    expect(f.acked).toEqual([p]);
  });

  it.each(['ASSIGNED', 'REASSIGNED', 'MATCHED'])('a TASK-only %s wake is nudged once, naming the task, then acked', async (event) => {
    const p = proof([], 'x', [taskEntry('t42')]);
    f.wakes = [wake('w-ada', 'Ada', [task('t42', event)], p)];
    await go();
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toContain('Hadron task assigned (t42)');
    expect(f.sent[0]).toContain('hadron team task get t42');
    expect(f.sent[0]).toContain('hadron team chat mark-read --through');
    expect(f.sent[0]).toContain('No unfiltered chat catch-up');
    expect(f.acked).toEqual([p]);
    expect(JSON.parse(readFileSync(receiptsFile(), 'utf8'))).toEqual({});
  });

  it('TASK+MENTION is delivered (the ack moves no message mark), and two assignments point at the task list', async () => {
    const p = proof([], 'x', [taskEntry('t1'), taskEntry('t2')]);
    f.wakes = [wake('w-ada', 'Ada', [task('t1'), task('t2', 'MATCHED'), MENTION], p)];
    await go();
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toContain('(t1, t2)');
    expect(f.sent[0]).toContain('hadron team task list');
    expect(f.acked).toEqual([p]);
  });

  it('TICK+TASK assignment: ONE nudge names the task and the ticker, and one ack covers both', async () => {
    const p = proof(['T:1'], 'x', [taskEntry('t1')]);
    f.wakes = [wake('w-ada', 'Ada', [TICK, task('t1')], p)];
    await go();
    expect(f.sent).toEqual([nudgeText(['coordinator-tick'], ['t1'])]);
    expect(f.sent[0]).toContain('ticker coordinator-tick');
    expect(f.acked).toEqual([p]);
  });

  it.each([
    ['END_SESSION', task('t1', 'END_SESSION')],
    ['an ALARM whose event id is not a plain id', task('t1', 'ALARM', 'e1; rm -rf ~')],
    ['a TASK reason without its task', { kind: 'TASK', ticker: null, task: null }],
    ['a task id that is not a plain id', task('t1; rm -rf ~', 'ASSIGNED')],
  ])('%s is left alone, alone or beside an assignment: no nudge, no ack, no receipt', async (_label, reason) => {
    f.wakes = [wake('w-ada', 'Ada', [reason], proof([], 'x', [taskEntry('t1')]))];
    await go();
    f.wakes = [wake('w-ada', 'Ada', [task('t9'), reason], proof([], 'y', [taskEntry('t9'), taskEntry('t1')]))];
    await go();
    expect(f.sent).toEqual([]);
    expect(f.acked).toEqual([]);
    expect(log()).toContain('left alone');
    expect(log()).not.toContain('rm -rf');
    expect(existsSync(receiptsFile())).toBe(false);
  });

  it('a delivered assignment whose ack was lost is never named again: the re-offer joined with a tick names only the ticker', async () => {
    const p1 = proof([], 'one', [taskEntry('t1')]);
    f.wakes = [wake('w-ada', 'Ada', [task('t1')], p1)];
    f.ackReply = () => ({ errors: [{ message: 'down' }] });
    await go();
    expect(f.sent).toHaveLength(1);
    f.ackReply = null;
    const p2 = proof(['T:1'], 'two', [taskEntry('t1')]);
    f.wakes = [wake('w-ada', 'Ada', [TICK, task('t1')], p2)];
    await go();
    expect(f.sent).toHaveLength(2);
    expect(f.sent[1]).toEqual(nudgeText(['coordinator-tick'], []));
    expect(f.acked).toEqual([p2]);
  });

  it('a lost ack on a TASK-only wake is recovered ack-only, never retyped', async () => {
    const p = proof([], 'one', [taskEntry('t1')]);
    f.wakes = [wake('w-ada', 'Ada', [task('t1')], p)];
    f.ackReply = () => ({ errors: [{ message: 'down' }] });
    await go();
    f.ackReply = null;
    await go();
    expect(f.sent).toHaveLength(1);
    expect(f.acked).toEqual([p]);
    expect(log()).toContain('ack-only recovery acked');
  });

  it('a task event in the proof that no reason names is held, not guessed', async () => {
    f.wakes = [wake('w-ada', 'Ada', [task('t1')], proof([], 'x', [taskEntry('t1'), taskEntry('zz')]))];
    await go();
    expect(f.sent).toEqual([]);
    expect(f.acked).toEqual([]);
    expect(log()).toContain('cannot be identified');
  });

  it('asks the server for each task reason\'s id, event and coverage key', async () => {
    expect(QUERY).toContain('task{id eventId chainIndex event}');
  });
});

describe('idle gate (C1 rule)', () => {
  beforeEach(() => { f.wakes = [wake('w-ada', 'Ada', [TICK])]; });

  it('tui-idle satisfied and an empty composer: delivered', async () => {
    await go();
    expect(f.sent).toHaveLength(1);
  });

  it('tui-idle satisfied is NOT enough: any Orca draft holds, whitespace and multiline included', async () => {
    for (const draft of ['half typed', '   ', 'line one\nline two']) {
      f.sent = []; f.acked = []; lines = [];
      f.screen = { source: 'screen', tail: CLAUDE_IDLE, draft };
      await go();
      expect(f.sent).toEqual([]);
      expect(f.acked).toEqual([]);
      expect(log()).toContain('composer not provably empty');
    }
  });

  it('tui-idle satisfied over a menu or an unknown screen: held', async () => {
    f.screen = { source: 'screen', tail: ['Which option do you pick?', '❯ 1. Alpha', '  2. Beta', 'Enter to select · ↑/↓ to navigate'] };
    await go();
    expect(f.sent).toEqual([]);
    expect(f.acked).toEqual([]);
  });

  it('Claude composer with the mode footer and NO agents suffix, no draft, tui-idle unavailable: delivered via the screen', async () => {
    f.idle = false;
    await go();
    expect(f.sent).toHaveLength(1);
    expect(f.acked).toHaveLength(1);
  });

  it('screen fallback with an Orca draft holds and the wake stays due', async () => {
    f.idle = false;
    f.screen = { source: 'screen', tail: CLAUDE_IDLE, draft: 'half typed' };
    await go();
    expect(f.sent).toEqual([]);
    expect(f.acked).toEqual([]);
  });

  it('a second footer row is not the mode line: held', async () => {
    f.idle = false;
    f.screen = { source: 'screen', tail: [...CLAUDE_IDLE, '  esc to interrupt'] };
    await go();
    expect(f.sent).toEqual([]);
    expect(f.acked).toEqual([]);
  });

  it('a running turn is held, and nothing is cleared or interrupted', async () => {
    f.idle = false;
    f.screen = { source: 'screen', tail: ['✽ Bunning… (5m 55s · ↓ 15.6k tokens)', RULE, '❯', RULE, '  ⏵⏵ bypass permissions on (shift+tab to cycle)'] };
    await go();
    expect(f.sent).toEqual([]);
  });
});

describe('R63 timing (server-owned anchor, floor and busy deadline)', () => {
  const BUSY = ['✽ Bunning… (5m 55s · ↓ 15.6k tokens)', RULE, '❯', RULE, '  ⏵⏵ bypass permissions on (shift+tab to cycle)'];
  const T0 = Date.parse('2026-10-19T02:00:00.000Z');
  const timing = (deliverAfter: number, busyDeadline: number) => ({ anchorAt: iso(T0 - 900_000), deliverAfter: iso(deliverAfter), busyDeadline: iso(busyDeadline) });
  const at = (ms: number) => ({ now: () => ms });

  it('nothing is typed before deliverAfter, even to an idle terminal; at deliverAfter it is delivered', async () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1']), [], timing(T0 + 60_000, T0 + 600_000))];
    await go(at(T0 + 59_999));
    expect(f.sent).toEqual([]);
    expect(log()).toContain('before deliverAfter');
    await go(at(T0 + 60_000));
    expect(f.sent).toHaveLength(1);
  });

  it('busy vetoes before busyDeadline, and stops vetoing at and after it', async () => {
    f.idle = false;
    f.screen = { source: 'screen', tail: BUSY };
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1']), [], timing(T0 - 1, T0 + 600_000))];
    await go(at(T0 + 599_999));
    expect(f.sent).toEqual([]);
    expect(log()).toContain('busy until the server');
    await go(at(T0 + 600_000));
    expect(f.sent).toHaveLength(1); // at the deadline busy alone no longer vetoes
    expect(f.acked).toHaveLength(1);
  });

  it('after the deadline a busy terminal is delivered to; after it nothing else relaxes', async () => {
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
      await go(at(T0 + 3_600_000)); // an hour past the deadline
      expect(f.sent, label).toEqual([]);
      expect(f.acked, label).toEqual([]);
    }
  });

  it('timing comes only from the wake: a restart, re-offer or join decides identically and keeps no local clock', async () => {
    f.idle = false;
    f.screen = { source: 'screen', tail: BUSY };
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1'], 'first-offer'), [], timing(T0 - 1, T0 + 600_000))];
    await go(at(T0 + 10_000)); // held
    // a re-offer carries the SAME stored anchor/floor/deadline (new proof bytes): decided by the wake's fields alone
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1'], 're-offer'), [], timing(T0 - 1, T0 + 600_000))];
    await go(at(T0 + 10_000));
    expect(f.sent).toEqual([]);
    // a fresh process (no memory of the earlier passes) at the deadline delivers
    await go(at(T0 + 600_000));
    expect(f.sent).toHaveLength(1);
    // a joined TASK reason leaves the wake untouched whatever the clock says
    f.sent = []; f.acked = [];
    f.wakes = [wake('w-ada', 'Ada', [TICK, TASK], proof(['T:1']), [], timing(T0 - 1, T0 + 1))];
    await go(at(T0 + 3_600_000));
    expect(f.sent).toEqual([]);
    expect(f.acked).toEqual([]);
  });

  it('a wake without server timing (old server) is held, never given a local default', async () => {
    f.wakes = [{ worker: { id: 'w-ada', name: 'Ada' }, reasons: [TICK], channels: [], proof: proof(['T:1']) }];
    await go();
    expect(f.sent).toEqual([]);
    expect(f.acked).toEqual([]);
    expect(log()).toContain('no server timing');
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1']), [], { anchorAt: 'x', deliverAfter: iso(Date.now()), busyDeadline: iso(Date.now()) })];
    await go();
    expect(f.sent).toEqual([]);
  });

  it('asks the server for anchorAt, deliverAfter and busyDeadline', async () => {
    f.wakes = [];
    await go();
    expect(f.dueQueries[0]).toMatch(/anchorAt deliverAfter busyDeadline/);
  });
});

describe('typed-once, coverage and ambiguity', () => {
  const lostAck = () => { f.ackReply = () => ({ errors: [{ message: 'upstream 502' }] }); };
  const T = (k: number) => `T:${k}`;

  it('a confirmed send whose ack fails is retried ack-only for a fully covered proof, never retyped', async () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof([T(1)]))];
    lostAck();
    await go();
    expect(f.sent).toHaveLength(1);
    expect(log()).toContain('ack FAILED');
    expect(JSON.parse(readFileSync(receiptsFile(), 'utf8'))['w-ada']).toMatchObject({ state: 'sent', coverage: [T(1)], receiver: 'term_a#inc-1' });
    f.ackReply = null;
    lines = [];
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof([T(1)], 'reissued'))]; // a re-read proof: same ticks, new bytes
    await go();
    expect(f.sent).toHaveLength(1);
    expect(f.acked).toHaveLength(1);
    expect(log()).toContain('ack-only recovery acked');
    expect(JSON.parse(readFileSync(receiptsFile(), 'utf8'))).toEqual({});
  });

  it('overlapping ticks: the second nudge names ONLY the uncovered ticker, coverage is the union, the combined proof is acked', async () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof([T(1)]))];
    lostAck();
    await go();
    expect(f.sent[0]).toContain('coordinator-tick');
    f.ackReply = null;
    const both = proof([T(1), 'U:1'], 'both');
    f.wakes = [wake('w-ada', 'Ada', [TICK, TICK2], both)];
    await go();
    expect(f.sent).toHaveLength(2);
    expect(f.sent[1]).toContain('eden-queue-tick');
    expect(f.sent[1]).not.toContain('coordinator-tick'); // the covered work is not asked for again
    expect(f.acked).toEqual([both]);
    expect(JSON.parse(readFileSync(receiptsFile(), 'utf8'))).toEqual({});
  });

  it('a later tick of the SAME ticker is new work and is named', async () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof([T(1)]))];
    lostAck();
    await go();
    f.ackReply = null;
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof([T(1), T(2)]))];
    await go();
    expect(f.sent).toHaveLength(2);
    expect(f.sent[1]).toContain('coordinator-tick');
    expect(f.acked).toHaveLength(1);
  });

  it('uncovered tick work that cannot be mapped to a ticker is held, not repeated', async () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof([T(1)]))];
    lostAck();
    await go();
    f.ackReply = null;
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof([T(1), 'Z:9']))]; // Z is not among the wake's reasons
    await go();
    expect(f.sent).toHaveLength(1);
    expect(f.acked).toEqual([]);
    expect(log()).toContain('cannot be identified');
  });

  it('a changed receiver (replacement terminal) does not inherit the old receipt', async () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof([T(1)]))];
    lostAck();
    await go();
    f.ackReply = null;
    f.incarnation = 'inc-2';
    await go();
    expect(f.sent).toHaveLength(2); // the new terminal never received the first nudge
  });

  it('an ack reply without an acknowledgement result is not reported as acked', async () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK])];
    f.ackReply = () => ({ data: {} });
    await go();
    expect(log()).toContain('ack FAILED');
    expect(log()).not.toMatch(/; acked /);
  });

  it('accepted without a confirmed turn start is ambiguous and kept with its request id; it is reconciled by that id, never retyped', async () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK])];
    f.sendReply = () => JSON.stringify(ACCEPTED_ONLY);
    await go();
    expect(f.sent).toHaveLength(1);
    expect(f.acked).toEqual([]);
    expect(JSON.parse(readFileSync(receiptsFile(), 'utf8'))['w-ada']).toMatchObject({ state: 'ambiguous', requestId: 'r1', handle: 'term_a' });
    f.sendReply = null;
    await go(); // still unconfirmed on retry
    expect(f.retries).toEqual(['r1']);
    expect(f.sent).toHaveLength(1);
    expect(f.acked).toEqual([]);
    expect(log()).toContain('still unreconciled');
    f.retryReply = () => JSON.stringify(CONFIRMED); // the retry now reports the turn started
    lines = [];
    await go();
    expect(f.sent).toHaveLength(1);
    expect(f.acked).toHaveLength(1);
    expect(log()).toContain('reconciled as delivered');
    expect(JSON.parse(readFileSync(receiptsFile(), 'utf8'))).toEqual({});
  });

  it('only the exact stage turn_started confirms', async () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK])];
    f.sendReply = () => JSON.stringify({ ok: true, result: { send: { accepted: true, prompt: { requestId: 'r2', stages: ['input_accepted', 'no_turn_started_yet'] } } } });
    await go();
    expect(f.acked).toEqual([]);
    expect(JSON.parse(readFileSync(receiptsFile(), 'utf8'))['w-ada'].state).toBe('ambiguous');
  });

  it('an unparsable or id-less receipt is ambiguous with no request id: held for a human, no retry calls', async () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK])];
    f.sendReply = () => 'not json';
    await go();
    f.sendReply = null;
    await go();
    await go();
    expect(f.sent).toHaveLength(1);
    expect(f.retries).toEqual([]);
    expect(f.acked).toEqual([]);
    expect(log()).toContain('unreconciled');
  });

  it('a failure that names a request id is reissued once with that same id: confirmed on retry means one send, acked', async () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK])];
    f.sendReply = () => JSON.stringify({ ok: false, error: { code: 'transport', details: { requestId: 'rq9' } } });
    f.retryReply = () => JSON.stringify(CONFIRMED);
    await go();
    expect(f.sent).toHaveLength(1);
    expect(f.retries).toEqual(['rq9']);
    expect(f.acked).toHaveLength(1);
  });

  it('a failure after possible submission whose retry also fails stays ambiguous with its request id', async () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK])];
    f.sendReply = () => JSON.stringify({ ok: false, error: { code: 'transport', details: { requestId: 'rq9' } } });
    f.retryReply = () => JSON.stringify({ ok: false, error: { code: 'transport', details: { requestId: 'rq9' } } });
    await go();
    expect(f.acked).toEqual([]);
    expect(JSON.parse(readFileSync(receiptsFile(), 'utf8'))['w-ada']).toMatchObject({ state: 'ambiguous', requestId: 'rq9' });
    await go();
    expect(f.sent).toHaveLength(1); // not retyped
  });

  it('uncertain with an id, then a same-id retry that fails WITHOUT an id, stays uncertain across restarts: no fresh type, no ack', async () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK])];
    f.sendReply = () => JSON.stringify(ACCEPTED_ONLY);
    f.retryReply = () => JSON.stringify({ ok: false, error: { code: 'invalid_argument' } });
    await go();
    expect(f.sent).toHaveLength(1);
    expect(JSON.parse(readFileSync(receiptsFile(), 'utf8'))['w-ada']).toMatchObject({ state: 'ambiguous', requestId: 'r1' });
    for (let i = 0; i < 3; i++) await go(); // "restarts": every pass rereads the receipts
    expect(f.sent).toHaveLength(1);
    expect(f.acked).toEqual([]);
    expect(log()).toContain('still unreconciled');
    expect(log()).not.toContain('will retry'); // never downgraded to a fresh-send refusal
    f.retryReply = () => JSON.stringify(CONFIRMED); // a same-id confirmation may still promote it
    await go();
    expect(f.acked).toHaveLength(1);
  });

  it('reissuing an unresolved request keeps the receiver and composer guard: no retry while a draft is pending or the receiver identity is unknown', async () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK])];
    f.sendReply = () => JSON.stringify(ACCEPTED_ONLY);
    await go();
    f.screen = { source: 'screen', tail: CLAUDE_IDLE, draft: 'half typed' };
    await go();
    expect(f.retries).toEqual([]);
    expect(log()).toContain('not reissued');
    f.screen = { source: 'screen', tail: CLAUDE_IDLE };
    f.incarnation = ''; // unknown is not proof that the old incarnation is gone
    await go();
    expect(f.retries).toEqual([]);
    expect(log()).toContain('another receiver');
  });

  it('an ambiguous receipt older than a day is still kept (no silent expiry)', async () => {
    mkdirSync(join(dir, 'ticker-wake'), { recursive: true });
    writeFileSync(receiptsFile(), JSON.stringify({ 'w-ada': { state: 'ambiguous', coverage: ['T:1'], receiver: 'term_a#inc-1', at: 1, detail: 'old', text: 't', handle: 'term_a' } }));
    f.wakes = [wake('w-ada', 'Ada', [TICK])];
    await go();
    expect(f.sent).toEqual([]);
    expect(log()).toContain('unreconciled');
  });

  it('a structured refusal (no request id, nothing typed) leaves the wake due and retypes later', async () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK])];
    f.sendReply = () => JSON.stringify({ ok: false, error: { code: 'invalid_argument' } });
    await go();
    expect(f.acked).toEqual([]);
    expect(log()).toContain('send refused');
    // The intent written before the send is withdrawn: no entry for the worker remains (the file may exist, empty).
    const left = existsSync(receiptsFile()) ? JSON.parse(readFileSync(receiptsFile(), 'utf8')) : {};
    expect(left['w-ada']).toBeUndefined();
    f.sendReply = null;
    await go();
    expect(f.acked).toHaveLength(1);
  });

  it('unreadable or malformed receipt state stops the pass: nothing is sent or acked', async () => {
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
      await expect((async () => go())(), raw).rejects.toThrow('malformed');
    }
    writeFileSync(receiptsFile(), '{}');
    chmodSync(receiptsFile(), 0o000);
    if (process.getuid?.() !== 0) await expect((async () => go())()).rejects.toThrow('unreadable');
    chmodSync(receiptsFile(), 0o600);
    expect(f.sent).toEqual([]);
    expect(f.acked).toEqual([]);
  });

  it('a receipt file replaced by [] after a lost ack stops the restart instead of retyping', async () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof([T(1)]))];
    lostAck();
    await go();
    expect(f.sent).toHaveLength(1);
    writeFileSync(receiptsFile(), '[]');
    f.ackReply = null;
    await expect((async () => go())()).rejects.toThrow('malformed');
    expect(f.sent).toHaveLength(1);
  });
});

describe('failure and paging', () => {
  it('a GraphQL failure on dueWakes throws and sends and acks nothing', async () => {
    f.dueError = 'permission denied';
    // The server's message is not echoed (P2-2): the class is. Its text can carry a proof or private text.
    await expect((async () => go())()).rejects.toThrow('graphql error');
    await expect((async () => go())()).rejects.not.toThrow('permission denied');
    expect(f.sent).toEqual([]);
  });

  it('stops after 10 pages and says so', async () => {
    f.alwaysMore = true;
    f.wakes = [];
    await go();
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

  it('a stale lock (dead pid) is taken over and released', async () => {
    const stateDir = join(dir, 'ticker-wake');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'lock'), '999999999');
    const release = acquireLock(stateDir);
    expect(readFileSync(join(stateDir, 'lock'), 'utf8')).toBe(String(process.pid));
    release();
    expect(existsSync(join(stateDir, 'lock'))).toBe(false);
  });

  it('stale-lock takeover race: a second contender during the takeover is refused, exactly one proceeds', async () => {
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

  it('stale-lock takeover never unlinks a live replacement owner that arrived after the stale judgment', async () => {
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

  it('a takeover file left behind by a dead process fails closed for operator cleanup, and is not removed', async () => {
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
  it('the dueWakes query validates and asks for the timing fields the loop consumes', async () => {
    expect(validate(schema, parse(QUERY)).map((e) => e.message)).toEqual([]);
    for (const f of ['anchorAt', 'deliverAfter', 'busyDeadline']) expect(QUERY).toContain(f);
  });
  it('#2754: the dueWakes query selects the server tick line and each reason\'s action state, and validates', async () => {
    expect(validate(schema, parse(QUERY)).map((e) => e.message)).toEqual([]);
    expect(QUERY).toContain('tickText');
    expect(QUERY).toMatch(/action\s*\{\s*state\s*\}/);
  });
  it('the acknowledgeWakes mutation validates', async () => {
    expect(validate(schema, parse(ACK)).map((e) => e.message)).toEqual([]);
  });
  it('the evidence reads (worker check status, task state) validate', async () => {
    expect(validate(schema, parse(WORKER_CHECK)).map((e) => e.message)).toEqual([]);
    expect(validate(schema, parse(TASK_STATE)).map((e) => e.message)).toEqual([]);
  });
  it('the alarm read (#1704) validates', async () => {
    expect(validate(schema, parse(ALARM_EVENT)).map((e) => e.message)).toEqual([]);
  });
});

// George's two P2s on #2070 (LOCAL REQUEST_CHANGES at fd5d2f33).
describe('send intent is persisted BEFORE a possible submission (P2-1)', () => {
  // The temp file saveReceipts writes first. Making it a directory (EISDIR, like the reviewer's repro) is portable:
  // it fails for root and non-root alike, and it only appears once the send has happened.
  const tmpPath = () => `${receiptsFile()}.${process.pid}.tmp`;

  it('a confirmed send whose receipt write then fails is never retyped by the next pass', async () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1']))];
    f.sendReply = () => { mkdirSync(tmpPath()); return JSON.stringify(CONFIRMED); };
    try { await go(); } catch { /* the old code lets the write failure end the pass */ }
    expect(f.sent).toHaveLength(1);
    rmSync(tmpPath(), { recursive: true, force: true }); // the operator clears the fault
    f.sendReply = null;
    await go();
    expect(f.sent, 'the same wake was typed a second time').toHaveLength(1);
    expect(f.acked, 'an unreconciled send must not be acked').toEqual([]);
    expect(log()).toContain('unreconciled');
  });

  it('if the intent cannot be recorded, nothing is sent (fail closed)', async () => {
    mkdirSync(join(dir, 'ticker-wake'), { recursive: true });
    mkdirSync(tmpPath()); // the very first write fails
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1']))];
    try { await go(); } catch { /* may throw or log */ }
    expect(f.sent).toEqual([]);
    expect(f.acked).toEqual([]);
  });

  it('a send that was refused (nothing typed) leaves no intent behind, so it is retried', async () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1']))];
    f.sendReply = () => JSON.stringify({ ok: false, error: { code: 'not_accepted' } });
    await go();
    expect(f.sent).toHaveLength(1);
    f.sendReply = null;
    await go();
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

  it('#2754: a tick line holding a sentinel reaches the typed text and never the log or the receipt', async () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1']), [], undefined, `tick coordinator-tick: run hrn:node:hadronmemory.com:x:${TEXT_SENTINEL}`)];
    await go();
    expect(f.sent[0]).toContain(TEXT_SENTINEL);
    clean();
  });

  it('#2754: an untypeable tick line holding a sentinel is dropped, and the sentinel never reaches the log, the receipt or the terminal', async () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1']), [], undefined, `tick coordinator-tick: ${TEXT_SENTINEL}\u0007`)];
    await go();
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).not.toContain(TEXT_SENTINEL);
    clean();
  });

  it('a failed ack logs its server error CODE but not the server message', async () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1']))];
    f.ackReply = () => ({ errors: [{ message: `stale ${PROOF_SENTINEL} ${TEXT_SENTINEL}`, extensions: { code: 'WAKE_PROOF_STALE' } }] });
    await go();
    expect(log()).toContain('WAKE_PROOF_STALE');
    clean();
  });

  it('an unparsable hadron reply does not log its stderr', async () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1']))];
    const run = f.run;
    f.run = (argv) => (argv[0] === 'hadron' && String(argv[2]).includes('acknowledgeWakes')
      ? { code: 1, stdout: 'not json', stderr: `boom ${PROOF_SENTINEL} ${TEXT_SENTINEL}` }
      : run(argv));
    await go();
    clean();
  });

  it('a refused send does not log the raw send error', async () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1']))];
    f.sendReply = () => JSON.stringify({ ok: false, error: { code: 'composer_not_empty', message: `draft: ${TEXT_SENTINEL}` } });
    await go();
    expect(log()).toContain('composer_not_empty');
    clean();
  });

  it('an uncertain send with a request identity keeps the identity but logs and stores no raw error', async () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1']))];
    const uncertain = () => JSON.stringify({ ok: false, requestId: 'r-9', error: { message: `echo ${TEXT_SENTINEL} ${PROOF_SENTINEL}` } });
    f.sendReply = uncertain;
    f.retryReply = uncertain; // the same-identity retry fails the same way
    await go();
    clean();
    expect(JSON.parse(readFileSync(receiptsFile(), 'utf8'))['w-ada']).toMatchObject({ state: 'ambiguous', requestId: 'r-9' });
  });

  it('a failed dueWakes read throws a message without the server text', async () => {
    f.dueError = `bad ${TEXT_SENTINEL} ${PROOF_SENTINEL}`;
    let msg = '';
    try { await go(); } catch (e) { msg = (e as Error).message; }
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

    it('Rodolfo 2: an arbitrary Orca stage string cannot become log or stored diagnostic text', async () => {
      const text = 'PRIVATE_STAGE_TEXT_SENTINEL';
      f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1']))];
      f.sendReply = () => JSON.stringify({ ok: true, result: { send: { accepted: true, prompt: { requestId: 'r1', stages: ['input_accepted', text] } } } });
      f.retryReply = f.sendReply;
      await go();
      expect(log()).not.toContain(text);
      const entry = JSON.parse(readFileSync(receiptsFile(), 'utf8'))['w-ada'];
      expect(entry.detail).not.toContain(text);
      expect(entry.state).toBe('ambiguous'); // still never retyped or acked
    });

    it('Rodolfo 3: a legacy receipt\'s raw detail is not logged while the worker is held', async () => {
      const text = 'PRIVATE_LEGACY_TEXT_SENTINEL';
      mkdirSync(join(dir, 'ticker-wake'), { recursive: true });
      writeFileSync(receiptsFile(), JSON.stringify({ 'w-ada': { state: 'ambiguous', coverage: ['T:1'], receiver: 'term_a#inc-1', at: 1, detail: text, text: 'a nudge', handle: 'term_a' } }));
      f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1']))];
      await go();
      expect(log()).not.toContain(text);
      expect(log()).toContain('unreconciled'); // still held for a human
      expect(f.sent).toEqual([]);
    });

    // Rodolfo's §10 delta at 73ed4120 and Xan's scope note: a code or a name is validated against a FIXED PUBLIC
    // VOCABULARY, not by its character shape. Ordinary code-shaped private text must collapse to the generic class.
    describe('code-shaped private text is not elevated to a safe code or name', () => {
      const SHAPED = 'PRIVATE_CODE_SHAPED_SENTINEL_77';
      it('a server error code that is not a known public code collapses to the generic class', async () => {
        f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1']))];
        f.ackReply = () => ({ errors: [{ message: 'x', extensions: { code: SHAPED } }] });
        await go();
        expect(log()).toContain('graphql error');
        expect(log()).not.toContain(SHAPED);
      });
      it('an Orca send error code that is not a known public code is not logged', async () => {
        f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1']))];
        f.sendReply = () => JSON.stringify({ ok: false, error: { code: SHAPED, message: 'm' } });
        await go();
        expect(log()).toContain('send refused');
        expect(log()).not.toContain(SHAPED);
      });
      it('a code token extracted from a helper message must be a known public code', async () => {
        await asLoop((argv) => isTerminalList(argv)
          ? { code: 0, stdout: JSON.stringify({ ok: false, error: { code: SHAPED, message: 'm' } }), stderr: '' } : undefined);
        expect(log()).toContain('pass failed');
        expect(log()).not.toContain(SHAPED);
      });
      it('a dynamic error name is not logged unless it is a standard class', async () => {
        await asLoop((argv) => { if (isTerminalList(argv)) { const e = new Error('x'); e.name = SHAPED; throw e; } return undefined; });
        expect(log()).toContain('unexpected other');
        expect(log()).not.toContain(SHAPED);
      });
      it('an errno-like code property that is not a real errno is not logged', async () => {
        await asLoop((argv) => { if (isTerminalList(argv)) throw Object.assign(new Error('x'), { code: SHAPED }); return undefined; });
        expect(log()).not.toContain(SHAPED);
      });
      it('a stored detail that fits a template but carries an unknown code is withheld', async () => {
        mkdirSync(join(dir, 'ticker-wake'), { recursive: true });
        writeFileSync(receiptsFile(), JSON.stringify({ 'w-ada': { state: 'ambiguous', coverage: ['T:1'], receiver: 'term_a#inc-1', at: 1, detail: `send refused: ${SHAPED}`, text: 'a nudge', handle: 'term_a' } }));
        f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1']))];
        await go();
        expect(log()).not.toContain(SHAPED);
        expect(log()).toContain('unreconciled');
      });
      it('real codes are still kept (backend_failure, WAKE_PROOF_STALE, EISDIR)', async () => {
        await asLoop((argv) => isTerminalList(argv)
          ? { code: 0, stdout: JSON.stringify({ ok: false, error: { code: 'backend_failure', message: 'm' } }), stderr: '' } : undefined);
        expect(log()).toContain('backend_failure');
      });
    });

    // Ada #24610 (fold in only because this finding forces a new head): the same sentinels through the REAL default sink,
    // console.log, with no log callback at all.
    it('end to end through console.log: stage, legacy detail and helper-code sentinels never reach the real sink', async () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        mkdirSync(join(dir, 'ticker-wake'), { recursive: true });
        writeFileSync(receiptsFile(), JSON.stringify({ 'w-ada': { state: 'ambiguous', coverage: ['T:1'], receiver: 'term_a#inc-1', at: 1, detail: 'PRIVATE_E2E_LEGACY_SENTINEL', text: 'a nudge', handle: 'term_a' } }));
        f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1']))];
        const run = f.run;
        f.run = (argv) => (isTerminalList(argv) ? { code: 0, stdout: JSON.stringify({ ok: false, error: { code: 'PRIVATE_E2E_CODE_SENTINEL', message: 'PRIVATE_E2E_TEXT_SENTINEL' } }), stderr: '' } : run(argv));
        await main(['loop', '--interval', '10'], { load: cfg, run: f.run, sleep: async () => {}, maxPasses: 2 });
        const printed = spy.mock.calls.map((c) => c.join(' ')).join('\n');
        expect(printed).toContain('pass failed');
        for (const s of ['PRIVATE_E2E_LEGACY_SENTINEL', 'PRIVATE_E2E_CODE_SENTINEL', 'PRIVATE_E2E_TEXT_SENTINEL']) expect(printed).not.toContain(s);
      } finally { spy.mockRestore(); }
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

  it('screen-derived reasons are logged as a class, not as screen text', async () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1']))];
    f.screen = { source: 'screen', tail: ['❯ ' + TEXT_SENTINEL, RULE, '❯ ' + TEXT_SENTINEL, RULE, '  ⏵⏵ bypass permissions on (shift+tab to cycle)'], draft: TEXT_SENTINEL };
    await go();
    expect(f.sent).toEqual([]);
    expect(log()).toContain('held');
    clean();
  });
});

describe('#2138 experiment: a pass must fit inside one cadence', () => {
  const T0 = Date.parse('2026-10-20T06:00:00.000Z');
  const timed = (anchorMs: number) => ({ anchorAt: iso(anchorMs), deliverAfter: iso(anchorMs), busyDeadline: iso(anchorMs + 3_600_000) });
  /** A clock that returns `t` and lets a fake call move it. */
  const clock = () => { const c = { t: T0, now: () => c.t }; return c; };

  it('a busy terminal is probed, never waited on: tui-idle is asked with a short timeout, not busyWaitMs', async () => {
    const waits: string[] = [];
    const run: Runner = (argv) => { if (argv[1] === 'terminal' && argv[2] === 'wait') waits.push(argv[argv.indexOf('--timeout-ms') + 1]); return f.run(argv); };
    f.idle = false;
    f.screen = { source: 'screen', tail: ['✽ Bunning… (5m 55s · ↓ 15.6k tokens)', RULE, '❯', RULE, '  ⏵⏵ bypass permissions on (shift+tab to cycle)'] };
    f.wakes = [wake('w-ada', 'Ada', [TICK])];
    await pass({ ...cfg(), busyWaitMs: 60_000 }, run, {}, (l) => lines.push(l));
    expect(waits.length).toBeGreaterThan(0);
    for (const w of waits) expect(Number(w)).toBeLessThanOrEqual(1000);
    expect(f.sent).toEqual([]);
    expect(log()).toContain('busy until the server');
  });

  it('a pass stops starting deliveries once its budget is spent, and leaves the rest for the next pass', async () => {
    const c = clock();
    const run: Runner = (argv) => { if (argv[2]?.includes?.('dueWakes')) c.t += 2_000; return f.run(argv); };
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1']), [], timed(T0 - 600_000))];
    await pass(cfg(), run, { now: c.now, budgetMs: 1_000 }, (l) => lines.push(l));
    expect(f.sent).toEqual([]);
    expect(f.acked).toEqual([]);
    expect(log()).toMatch(/budget spent; 1 due wake\(s\) left for the next pass/);
  });

  it('the oldest wake is served first, so a spent budget never starves the same workers', async () => {
    const c = clock();
    const run: Runner = (argv) => { if (argv[2] === 'send') c.t += 5_000; return f.run(argv); };
    f.wakes = [
      wake('w-bob', 'Bob', [TICK], proof(['T:2']), [], timed(T0 - 60_000)), // newer, listed first by the server
      wake('w-ada', 'Ada', [TICK], proof(['T:1']), [], timed(T0 - 600_000)),
    ];
    await pass(cfg(), run, { now: c.now, budgetMs: 4_000 }, (l) => lines.push(l));
    expect(f.sent).toHaveLength(1); // Ada, the older one
    expect(f.acked).toHaveLength(1);
    expect(log()).not.toContain('Bob: held');
    expect(log()).toMatch(/1 due wake\(s\) left for the next pass/);
  });

  it('a stale proof at ack time is re-fetched and the fresh proof acked when the receipt covers it', async () => {
    const fresh = proof(['T:1'], 'fresh');
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1'], 'old'))];
    let calls = 0;
    f.ackReply = () => {
      calls++;
      if (calls === 1) { f.wakes = [wake('w-ada', 'Ada', [TICK], fresh)]; return { errors: [{ message: 'too old', extensions: { code: 'WAKE_PROOF_STALE' } }] }; }
      return { data: { acknowledgeWakes: { acknowledged: 1, unchanged: 0 } } };
    };
    const acks: string[] = [];
    const run: Runner = (argv) => { if (argv[0] === 'hadron' && argv[2].includes('acknowledgeWakes')) acks.push(JSON.parse(argv[argv.indexOf('-F') + 1].slice(2))[0]); return f.run(argv); };
    await pass(cfg(), run, {}, (l) => lines.push(l));
    expect(f.sent).toHaveLength(1);
    expect(acks).toHaveLength(2);
    expect(acks[0]).not.toBe(fresh);
    expect(acks[1]).toBe(fresh);
    expect(log()).toContain('acked');
    expect(JSON.parse(readFileSync(receiptsFile(), 'utf8'))).toEqual({});
  });

  it('a re-fetched proof that carries NEW work is not acked: the receipt stays and the next pass names only the new work', async () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1'], 'old'))];
    f.ackReply = () => {
      f.wakes = [wake('w-ada', 'Ada', [TICK, TICK2], proof(['T:1', 'U:1'], 'fresh'))];
      return { errors: [{ message: 'too old', extensions: { code: 'WAKE_PROOF_STALE' } }] };
    };
    await go();
    expect(f.sent).toHaveLength(1);
    expect(log()).toMatch(/fresh proof carries new work/);
    expect(JSON.parse(readFileSync(receiptsFile(), 'utf8'))['w-ada']).toMatchObject({ state: 'sent', coverage: ['T:1'] });
    f.ackReply = null;
    lines = [];
    await go();
    expect(f.sent).toHaveLength(2);
    expect(f.sent[1]).toContain('eden-queue-tick');
    expect(f.sent[1]).not.toContain('coordinator-tick');
  });

  it('a proof near the end of its life is refreshed BEFORE the ack, so the old proof is never sent to the server', async () => {
    const c = clock();
    const old = proof(['T:1'], T0 - 11 * 60_000);
    const fresh = proof(['T:1'], T0);
    f.wakes = [wake('w-ada', 'Ada', [TICK], old, [], timed(T0 - 600_000))];
    const run: Runner = (argv) => { if (argv[2] === 'send') f.wakes = [wake('w-ada', 'Ada', [TICK], fresh, [], timed(T0 - 600_000))]; return f.run(argv); };
    await pass(cfg(), run, { now: c.now }, (l) => lines.push(l));
    expect(f.sent).toHaveLength(1);
    expect(f.acked).toEqual([fresh]);
  });

  it('--budget is accepted by once and loop; a bad value, or a loop budget longer than the interval, is a usage error', async () => {
    const deps = { load: cfg, run: f.run, log: (l: string) => lines.push(l), sleep: async () => {} };
    expect(await main(['once', '--budget', '30'], deps)).toBe(0);
    expect(await main(['loop', '--interval', '60', '--budget', '30'], { ...deps, maxPasses: 1 })).toBe(0);
    for (const argv of [['once', '--budget', 'x'], ['once', '--budget', '5'], ['once', '--budget'], ['loop', '--interval', '20', '--budget', '30']]) {
      expect(await main(argv, deps)).toBe(2);
    }
  });

  it('the loop keeps fixed slots: a pass that overruns its slot skips the missed slots (logged) instead of running back to back', async () => {
    const c = clock();
    const sleeps: number[] = [];
    const run: Runner = (argv) => { if (argv[2]?.includes?.('dueWakes')) c.t += 25_000; return f.run(argv); };
    const deps = { load: cfg, run, log: (l: string) => lines.push(l), now: c.now, maxPasses: 2,
      sleep: async (ms: number) => { sleeps.push(ms); c.t += ms; } };
    expect(await main(['loop', '--interval', '10'], deps)).toBe(0);
    expect(sleeps).toEqual([5_000]); // pass 1 ran 0..25 s: slots at 10 s and 20 s are skipped, the next pass starts at 30 s
    expect(log()).toMatch(/overran its slot; skipped 2 slot\(s\)/);
  });
});

describe('#2138: an ambiguous receipt is resolved on evidence, never on a timeout alone', () => {
  const T0 = Date.parse('2026-10-20T07:30:00.000Z');
  const at = (ms: number) => ({ now: () => ms });
  const timing = { anchorAt: iso(T0 - 600_000), deliverAfter: iso(T0 - 300_000), busyDeadline: iso(T0 + 3_600_000) };
  const ambiguous = async () => {
    f.sendReply = () => JSON.stringify(ACCEPTED_ONLY);
    await go(at(T0));
    f.sendReply = null;
    expect(JSON.parse(readFileSync(receiptsFile(), 'utf8'))['w-ada']).toMatchObject({ state: 'ambiguous', requestId: 'r1', at: T0 });
    lines = [];
    f.evidenceQueries = []; // the pre-send check read is not an evidence read
  };
  const receipt = () => JSON.parse(readFileSync(receiptsFile(), 'utf8'))['w-ada'];

  it('accepted + same receiver + empty composer + a channel check after the send: resolved as delivered and acked, never retyped', async () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1']), [], timing)];
    await ambiguous();
    f.lastCheckedAt = iso(T0 + 60_000);
    await go(at(T0 + 120_000));
    expect(f.retries).toEqual(['r1']); // reissued by its id first
    expect(f.sent).toHaveLength(1);
    expect(f.acked).toHaveLength(1);
    expect(log()).toContain('resolved as delivered on evidence');
    expect(JSON.parse(readFileSync(receiptsFile(), 'utf8'))).toEqual({});
  });

  it('a reissue that Orca now confirms needs no evidence read', async () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1']), [], timing)];
    await ambiguous();
    f.retryReply = () => JSON.stringify(CONFIRMED);
    await go(at(T0 + 120_000));
    expect(f.acked).toHaveLength(1);
    expect(f.evidenceQueries).toEqual([]);
  });

  it('(a) a request Orca never reported accepted is not resolved, whatever the evidence', async () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1']), [], timing)];
    const failed = JSON.stringify({ ok: false, error: { code: 'timeout' }, requestId: 'r9' });
    f.sendReply = () => failed;
    f.retryReply = () => failed;
    await go(at(T0));
    expect(receipt()).toMatchObject({ state: 'ambiguous', requestId: 'r9' });
    f.lastCheckedAt = iso(T0 + 60_000);
    lines = [];
    await go(at(T0 + 120_000));
    expect(f.acked).toEqual([]);
    expect(f.sent).toHaveLength(1);
    expect(log()).toContain('Orca never reported the input accepted');
    expect(receipt().state).toBe('ambiguous');
  });

  it('(b) an unknown receiver is not resolved, and no evidence is read', async () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1']), [], timing)];
    await ambiguous();
    f.lastCheckedAt = iso(T0 + 60_000);
    f.incarnation = '';
    await go(at(T0 + 120_000));
    expect(f.acked).toEqual([]);
    expect(f.evidenceQueries).toEqual([]);
    expect(log()).toContain('another receiver');
  });

  it('(c) a composer that is not provably empty is not resolved', async () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1']), [], timing)];
    await ambiguous();
    f.lastCheckedAt = iso(T0 + 60_000);
    f.screen = { source: 'screen', tail: CLAUDE_IDLE, draft: 'half typed' };
    await go(at(T0 + 120_000));
    expect(f.acked).toEqual([]);
    expect(f.retries).toEqual([]);
    expect(log()).toMatch(/no delivery evidence yet \(composer not provably empty\)/);
    expect(receipt().state).toBe('ambiguous');
  });

  it('(c) a busy terminal with an empty composer is not reissued, but may still be resolved on evidence', async () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1']), [], timing)];
    await ambiguous();
    f.lastCheckedAt = iso(T0 + 60_000);
    f.idle = false;
    f.screen = { source: 'screen', tail: ['✽ Bunning… (5m 55s · ↓ 15.6k tokens)', RULE, '❯', RULE, '  ⏵⏵ bypass permissions on (shift+tab to cycle)'] };
    await go(at(T0 + 120_000));
    expect(f.retries).toEqual([]);
    expect(f.acked).toHaveLength(1);
    expect(log()).toContain('resolved as delivered on evidence');
  });

  it('(d) no channel check since the one recorded before the send, or an earlier one, is not evidence', async () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1']), [], timing)];
    f.lastCheckedAt = iso(T0 - 30_000);
    await ambiguous();
    for (const checked of [iso(T0 - 30_000), iso(T0 - 31_000), null]) {
      f.lastCheckedAt = checked;
      lines = [];
      await go(at(T0 + 120_000));
      expect(f.acked).toEqual([]);
      expect(log()).toContain('no channel check since the send');
    }
    expect(receipt().state).toBe('ambiguous');
  });

  it('(d) a covered task assignment also needs that task STARTED (or finished) by this worker', async () => {
    const p = proof([], 'a', [taskEntry('t7')]);
    f.wakes = [wake('w-ada', 'Ada', [task('t7')], p, [], timing)];
    await ambiguous();
    f.lastCheckedAt = iso(T0 + 60_000);
    f.tasks.t7 = { id: 't7', status: 'PENDING', assignee: { kind: 'WORKER', id: 'w-ada' } };
    await go(at(T0 + 120_000));
    expect(f.acked).toEqual([]);
    expect(log()).toContain('a covered task is not started by this worker');
    f.tasks.t7 = { id: 't7', status: 'STARTED', assignee: { kind: 'WORKER', id: 'w-bob' } };
    lines = [];
    await go(at(T0 + 130_000));
    expect(f.acked).toEqual([]);
    expect(log()).toContain('a covered task is not started by this worker');
    f.tasks.t7 = { id: 't7', status: 'STARTED', assignee: { kind: 'WORKER', id: 'w-ada' } };
    lines = [];
    await go(at(T0 + 140_000));
    expect(f.acked).toEqual([p]);
    expect(f.evidenceQueries).toContain('task t7');
    expect(log()).toContain('resolved as delivered on evidence');
  });

  it('a legacy receipt covering a task with no recorded task identity is held, never guessed', async () => {
    mkdirSync(join(dir, 'ticker-wake'), { recursive: true });
    writeFileSync(receiptsFile(), JSON.stringify({ 'w-ada': { state: 'ambiguous', coverage: ['T:1', 'task:e-gone#0'], receiver: 'term_a#inc-1', at: T0, detail: 'accepted, turn start not confirmed (input_accepted)', text: 't', handle: 'term_a', requestId: 'r1', checkedBefore: null } }));
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1']), [], timing)];
    f.lastCheckedAt = iso(T0 + 60_000);
    await go(at(T0 + 120_000));
    expect(f.acked).toEqual([]);
    expect(f.evidenceQueries).not.toContain('task t7');
    expect(log()).toContain('a covered task was not recorded with the send');
  });

  it("George's lifecycle probe (#2154 P2): STARTING the task removes its wake, and a later tick still resolves the receipt by the task recorded at send time", async () => {
    const p = proof([], 'a', [taskEntry('t7')]);
    f.wakes = [wake('w-ada', 'Ada', [task('t7')], p, [], timing)];
    await ambiguous();
    expect(receipt().tasks).toEqual({ 'task:e-t7#0': 't7' });
    // The worker started the task: the server drops the assignment wake; only a later tick is due.
    f.tasks.t7 = { id: 't7', status: 'STARTED', assignee: { kind: 'WORKER', id: 'w-ada' } };
    f.lastCheckedAt = iso(T0 + 60_000);
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1']), [], timing)];
    await go(at(T0 + 120_000));
    expect(f.evidenceQueries).toContain('task t7');
    expect(log()).toContain('resolved as delivered on evidence');
    expect(f.sent).toHaveLength(2); // the tick is new work: one nudge for it, never the task again
    expect(f.sent[1]).toContain('coordinator-tick');
    expect(f.sent[1]).not.toContain('t7');
  });

  it('only the tasks a send newly named are recorded; a send naming no task records none', async () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1']), [], timing)];
    await ambiguous();
    expect(receipt().tasks).toEqual({});
  });

  it('a malformed recorded task map stops the pass (fail closed)', async () => {
    mkdirSync(join(dir, 'ticker-wake'), { recursive: true });
    for (const tasks of [[], { 'task:e-x#0': 7 }, { 'T:1': 't1' }, { 'task:e-other#0': 't1' }, { 'task:e-x#0': 'bad id!' }]) {
      writeFileSync(receiptsFile(), JSON.stringify({ 'w-ada': { state: 'ambiguous', coverage: ['T:1', 'task:e-x#0'], receiver: 'term_a#inc-1', at: T0, detail: 'accepted, turn start not confirmed (input_accepted)', text: 't', handle: 'term_a', requestId: 'r1', tasks } }));
      f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1']), [], timing)];
      await expect((async () => go(at(T0 + 120_000)))()).rejects.toThrow(/receipts malformed/);
    }
  });

  it('after 2 cadences without evidence it stays held and is listed as needing a person; before that it only waits', async () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1']), [], timing)];
    await ambiguous();
    await go(at(T0 + 19 * 60_000));
    expect(log()).not.toContain('needs a person');
    lines = [];
    await go(at(T0 + 20 * 60_000));
    expect(f.acked).toEqual([]);
    expect(f.sent).toHaveLength(1);
    expect(log()).toContain('needs a person');
    expect(receipt().state).toBe('ambiguous');
  });

  it('a resolved receipt with new ticks gets a nudge for ONLY the new work', async () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1']), [], timing)];
    await ambiguous();
    f.lastCheckedAt = iso(T0 + 60_000);
    f.wakes = [wake('w-ada', 'Ada', [TICK, TICK2], proof(['T:1', 'U:1']), [], timing)];
    await go(at(T0 + 120_000));
    expect(f.sent).toHaveLength(2);
    expect(f.sent[1]).toContain('eden-queue-tick');
    expect(f.sent[1]).not.toContain('coordinator-tick');
    expect(f.acked).toHaveLength(1);
  });
});

describe('#2138: a stranded draft is detected and listed for a person, never submitted (Ada #26150)', () => {
  // Orca accepted our text but the Enter never submitted it: the composer still holds exactly that text, so neither the
  // reissue (an idempotent replay, Hugo #26146) nor the #2154 evidence path can run. A raw Enter is bound to neither the
  // incarnation nor the draft (George's #2157 P2), so the script only records and reports it.
  const T0 = Date.parse('2026-10-20T07:30:00.000Z');
  const at = (ms: number) => ({ now: () => ms });
  const timing = { anchorAt: iso(T0 - 600_000), deliverAfter: iso(T0 - 300_000), busyDeadline: iso(T0 + 3_600_000) };
  const receipt = () => JSON.parse(readFileSync(receiptsFile(), 'utf8'))['w-ada'];
  const BUSY = ['✽ Bunning… (5m 55s · ↓ 15.6k tokens)', RULE, '❯', RULE, '  ⏵⏵ bypass permissions on (shift+tab to cycle)'];
  /** Leave an accepted-but-unconfirmed send whose text is still in the composer; returns that text. */
  const stranded = async (): Promise<string> => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1']), [], timing)];
    f.sendReply = () => JSON.stringify(ACCEPTED_ONLY);
    await go(at(T0));
    f.sendReply = null;
    const text = receipt().text as string;
    f.screen = { source: 'screen', tail: CLAUDE_IDLE, draft: text };
    lines = [];
    return text;
  };
  const noInput = () => {
    expect(f.enters, 'no keystroke is ever sent').toEqual([]);
    expect(f.sent, 'nothing is typed again').toHaveLength(1);
    expect(f.acked).toEqual([]);
  };

  it('composer holds exactly our text, idle, 60 s after the send: recorded once, logged as stranded for a person, no keystroke', async () => {
    await stranded();
    await go(at(T0 + 61_000));
    noInput();
    expect(f.retries).toEqual([]);
    expect(receipt()).toMatchObject({ state: 'ambiguous', requestId: 'r1', strandedAt: T0 + 61_000 });
    expect(log()).toContain('stranded draft, 61s');
    expect(log()).toContain('needs a person');
  });

  it('later passes keep the first strandedAt and report the age, still with no keystroke', async () => {
    await stranded();
    await go(at(T0 + 60_000));
    lines = [];
    await go(at(T0 + 180_000));
    noInput();
    expect(receipt().strandedAt).toBe(T0 + 60_000);
    expect(log()).toContain(`stranded draft, 180s (first seen ${iso(T0 + 60_000)})`);
  });

  it('a draft that later submits on its own resolves on evidence as in #2154', async () => {
    await stranded();
    await go(at(T0 + 60_000));
    f.screen = { source: 'screen', tail: CLAUDE_IDLE };
    f.lastCheckedAt = iso(T0 + 200_000);
    lines = [];
    await go(at(T0 + 240_000));
    expect(f.enters).toEqual([]);
    expect(f.acked).toHaveLength(1);
    expect(log()).toContain('resolved as delivered on evidence');
  });

  it('trailing whitespace on the draft is ignored', async () => {
    const text = await stranded();
    f.screen = { ...f.screen, draft: `${text}  \n` };
    await go(at(T0 + 60_000));
    expect(receipt().strandedAt).toBe(T0 + 60_000);
    noInput();
  });

  it("a differing, partial or extended draft is not called ours: not recorded, ordinary hold", async () => {
    const text = await stranded();
    for (const draft of [text.slice(0, -5), `${text} and more`, `x${text}`, 'half typed']) {
      f.screen = { source: 'screen', tail: CLAUDE_IDLE, draft };
      await go(at(T0 + 60_000));
    }
    noInput();
    expect(receipt().strandedAt).toBeUndefined();
    expect(log()).not.toContain('stranded draft');
  });

  it('our draft plus anything else on the composer line is not recorded', async () => {
    const text = await stranded();
    f.screen = { source: 'screen', tail: [...CLAUDE_IDLE.slice(0, 3), RULE, '❯ more text', RULE, CLAUDE_IDLE[6]], draft: text };
    await go(at(T0 + 60_000));
    noInput();
    expect(receipt().strandedAt).toBeUndefined();
  });

  it('a busy terminal is not recorded as stranded, even past the busy deadline', async () => {
    const text = await stranded();
    f.idle = false;
    f.screen = { source: 'screen', tail: BUSY, draft: text };
    await go(at(T0 + 3_700_000));
    noInput();
    expect(receipt().strandedAt).toBeUndefined();
    expect(log()).toContain('not idle');
  });

  it('under 60 s since the send it is not yet stranded (a slow submit may still be in progress)', async () => {
    await stranded();
    await go(at(T0 + 59_999));
    noInput();
    expect(receipt().strandedAt).toBeUndefined();
    expect(log()).not.toContain('stranded draft');
  });

  it("George's race schedule (#2157 P2): the terminal is replaced with a foreign draft during the idle probe; nothing is sent", async () => {
    await stranded();
    const base = f.run;
    let waits = 0;
    f.run = (argv) => {
      if (argv[0] === 'orca' && argv[2] === 'wait' && ++waits === 2) {
        f.incarnation = 'inc-2';
        f.screen = { source: 'screen', tail: CLAUDE_IDLE, draft: 'someone else has typed this' };
      }
      return base(argv);
    };
    await go(at(T0 + 60_000));
    noInput();
    expect(f.retries).toEqual([]);
  });

  it('if strandedAt cannot be recorded it is still reported, and still nothing is sent', async () => {
    await stranded();
    mkdirSync(`${receiptsFile()}.${process.pid}.tmp`);
    try { await go(at(T0 + 60_000)); } finally { rmSync(`${receiptsFile()}.${process.pid}.tmp`, { recursive: true, force: true }); }
    noInput();
    expect(log()).toMatch(/stranded draft, 60s \(not recorded: \w+\); .*needs a person/);
    expect(receipt().strandedAt).toBeUndefined();
  });

  describe('#2746 the hold file names a mature stranded draft', () => {
    const holdsPath = () => join(dir, 'ticker-wake', 'holds.log');
    const lastHold = () => readFileSync(holdsPath(), 'utf8').split('\n').filter(Boolean).at(-1) ?? '';

    it('before 60 s, at first detection, on a later pass and when not recorded, the file says stranded-draft', async () => {
      await stranded();
      await go(at(T0 + 30_000));
      expect(lastHold()).toMatch(/ Ada w-ada stranded-draft$/);
      await go(at(T0 + 61_000)); // first detection: `stranded draft, 61s; ... needs a person`
      expect(log()).toContain('stranded draft, 61s');
      expect(lastHold()).toMatch(/ Ada w-ada stranded-draft$/);
      await go(at(T0 + 180_000)); // later pass: `(first seen ...)`
      expect(log()).toContain('first seen');
      expect(lastHold()).toMatch(/ Ada w-ada stranded-draft$/);
    });

    it('a draft whose strandedAt cannot be recorded is still stranded-draft in the file', async () => {
      await stranded();
      mkdirSync(`${receiptsFile()}.${process.pid}.tmp`);
      try { await go(at(T0 + 60_000)); } finally { rmSync(`${receiptsFile()}.${process.pid}.tmp`, { recursive: true, force: true }); }
      expect(log()).toMatch(/not recorded/);
      expect(lastHold()).toMatch(/ Ada w-ada stranded-draft$/);
    });
  });

  it('dry run is a no-op', async () => {
    await stranded();
    await go({ ...at(T0 + 60_000), dry: true });
    noInput();
    expect(receipt().strandedAt).toBeUndefined();
  });

  it('a request Orca never reported accepted is not called stranded', async () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1']), [], timing)];
    const failed = JSON.stringify({ ok: false, error: { code: 'timeout' }, requestId: 'r9' });
    f.sendReply = () => failed;
    f.retryReply = () => failed;
    await go(at(T0));
    f.screen = { source: 'screen', tail: CLAUDE_IDLE, draft: receipt().text };
    await go(at(T0 + 60_000));
    expect(f.enters).toEqual([]);
    expect(receipt().strandedAt).toBeUndefined();
  });

  it('another receiver is not called stranded', async () => {
    await stranded();
    f.incarnation = 'inc-2';
    await go(at(T0 + 60_000));
    noInput();
    expect(receipt().strandedAt).toBeUndefined();
  });

  it('the draft text never reaches the log', async () => {
    const text = await stranded();
    await go(at(T0 + 60_000));
    expect(log()).not.toContain(text.slice(0, 40));
  });

  it('a malformed strandedAt stops the pass (fail closed)', async () => {
    await stranded();
    for (const v of ['x', null, {}]) {
      const r = JSON.parse(readFileSync(receiptsFile(), 'utf8'));
      r['w-ada'].strandedAt = v;
      writeFileSync(receiptsFile(), JSON.stringify(r));
      await expect((async () => go(at(T0 + 60_000)))()).rejects.toThrow(/receipts malformed/);
    }
  });
});

describe('#2138: check evidence is compared on the server clock, never the host clock (Ada #26165)', () => {
  // lastCheckedAt is stamped with the DATABASE's now(); on alpha it ran ~19 s behind the host (Liam #26163), so a compliant
  // check after the nudge read as "before the send" against the host's send time. The receipt now records the worker's
  // lastCheckedAt as read just before the send, and evidence is a LATER lastCheckedAt: both values are server times.
  const T0 = Date.parse('2026-10-20T10:54:42.000Z'); // host time of Victor's send (Hugo #26162)
  const at = (ms: number) => ({ now: () => ms });
  const timing = { anchorAt: iso(T0 - 600_000), deliverAfter: iso(T0 - 300_000), busyDeadline: iso(T0 + 3_600_000) };
  const receipt = () => JSON.parse(readFileSync(receiptsFile(), 'utf8'))['w-ada'];
  const send = async () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1']), [], timing)];
    f.sendReply = () => JSON.stringify(ACCEPTED_ONLY);
    await go(at(T0));
    f.sendReply = null;
    lines = [];
  };

  it("Victor's case: a check the server stamped 19 s behind the host's send time still resolves, because it is later than the pre-send one", async () => {
    f.lastCheckedAt = '2026-10-20T10:40:00.000Z';
    await send();
    expect(receipt().checkedBefore).toBe('2026-10-20T10:40:00.000Z');
    f.lastCheckedAt = '2026-10-20T10:54:43.821Z'; // his mark-read at 10:55:03 host time, on the DB clock
    await go(at(T0 + 120_000));
    expect(f.acked).toHaveLength(1);
    expect(f.sent).toHaveLength(1);
    expect(log()).toContain('resolved as delivered on evidence');
  });

  it('a server clock running AHEAD of the host is no evidence on its own: the unchanged pre-send check does not resolve', async () => {
    f.lastCheckedAt = iso(T0 + 30_000);
    await send();
    await go(at(T0 + 120_000));
    expect(f.acked).toEqual([]);
    expect(log()).toContain('no channel check since the send');
  });

  it('a worker that had never checked records null, and any check after that is evidence', async () => {
    await send();
    expect(receipt().checkedBefore).toBeNull();
    f.lastCheckedAt = iso(T0 - 19_000);
    await go(at(T0 + 120_000));
    expect(f.acked).toHaveLength(1);
  });

  it('if the check status cannot be read before the send, nothing is sent and no intent is left', async () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1']), [], timing)];
    f.checkError = 'boom';
    await go(at(T0));
    expect(f.sent).toEqual([]);
    expect(log()).toContain("held (the worker's check status is unreadable before the send");
    expect(existsSync(receiptsFile()) ? JSON.parse(readFileSync(receiptsFile(), 'utf8')) : {}).toEqual({});
    f.checkError = null;
    await go(at(T0 + 60_000));
    expect(f.sent).toHaveLength(1);
  });

  it('a legacy receipt with no recorded pre-send check is held, never compared against a host time', async () => {
    mkdirSync(join(dir, 'ticker-wake'), { recursive: true });
    writeFileSync(receiptsFile(), JSON.stringify({ 'w-ada': { state: 'ambiguous', coverage: ['T:1'], receiver: 'term_a#inc-1', at: T0, detail: 'accepted, turn start not confirmed (input_accepted)', text: 't', handle: 'term_a', requestId: 'r1', tasks: {} } }));
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1']), [], timing)];
    f.lastCheckedAt = iso(T0 + 600_000);
    await go(at(T0 + 120_000));
    expect(f.acked).toEqual([]);
    expect(log()).toContain('the pre-send check was not recorded with the send');
  });

  it('a malformed recorded pre-send check stops the pass (fail closed)', async () => {
    mkdirSync(join(dir, 'ticker-wake'), { recursive: true });
    for (const checkedBefore of [7, 'not a time', {}, '']) {
      writeFileSync(receiptsFile(), JSON.stringify({ 'w-ada': { state: 'ambiguous', coverage: ['T:1'], receiver: 'term_a#inc-1', at: T0, detail: 'accepted, turn start not confirmed (input_accepted)', text: 't', handle: 'term_a', requestId: 'r1', tasks: {}, checkedBefore } }));
      f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1']), [], timing)];
      await expect((async () => go(at(T0 + 120_000)))()).rejects.toThrow(/receipts malformed/);
    }
  });
});

describe('#2138: a pass does not pay the turn-start wait per send (bounded concurrent delivery)', () => {
  /** N roster workers, each with its own worktree and pinned terminal, all idle with an empty composer. */
  const crew = (n: number, shareTerminal = false) => {
    const roster = Array.from({ length: n }, (_, i) => {
      const wt = join(dir, shareTerminal ? 'shared' : `w${i}`);
      mkdirSync(wt, { recursive: true });
      return { worker: `w-${i}`, name: `W${i}`, worktree: wt, terminal: shareTerminal ? 'term_s' : `term_${i}` };
    });
    const terminals = roster.map((r) => ({ handle: r.terminal, incarnationId: 'inc-1', worktreePath: r.worktree, connected: true, writable: true, agentIdentity: 'claude' }));
    const uniq = [...new Map(terminals.map((t) => [t.handle, t])).values()];
    f.wakes = roster.map((r, i) => wake(r.worker, r.name, [TICK], proof([`T:${i + 1}`])));
    const run: Runner = (argv) => (argv[0] === 'orca' && argv[2] === 'list'
      ? { code: 0, stdout: JSON.stringify({ ok: true, result: { terminals: uniq } }), stderr: '' } : f.run(argv));
    return { cfg: { ...cfg(), roster } as Config, run };
  };
  /** An async runner whose sends stay in flight until released; everything else answers from `run`. */
  const held = (run: Runner) => {
    const pending: Array<() => void> = [];
    const st = { inFlight: 0, max: 0, waits: [] as string[], pending };
    const runAsync = (argv: string[]): Promise<RunResult> => {
      if (argv[0] === 'orca' && argv[2] === 'send') {
        st.waits.push(argv[argv.indexOf('--wait-submit') + 1]);
        st.inFlight++; st.max = Math.max(st.max, st.inFlight);
        return new Promise((resolveSend) => pending.push(() => { st.inFlight--; resolveSend(run(argv)); }));
      }
      return Promise.resolve(run(argv));
    };
    return { st, runAsync };
  };
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
  const drain = async (st: { pending: Array<() => void> }, done: { v: boolean }) => {
    while (!done.v) { await settle(); while (st.pending.length) st.pending.shift()!(); }
  };

  it("a send observes the turn start for SUBMIT_PROBE_S (2 s), not the router's submitWaitS, on a fresh send and on a reissue", async () => {
    expect(SUBMIT_PROBE_S).toBe(2);
    const waits: string[] = [];
    const run: Runner = (argv) => { if (argv[0] === 'orca' && argv[2] === 'send') waits.push(argv[argv.indexOf('--wait-submit') + 1]); return f.run(argv); };
    f.wakes = [wake('w-ada', 'Ada', [TICK])];
    f.sendReply = () => JSON.stringify(ACCEPTED_ONLY);
    await pass({ ...cfg(), submitWaitS: 15 }, run, {}, (l) => lines.push(l));
    f.sendReply = null;
    await pass({ ...cfg(), submitWaitS: 15 }, run, {}, (l) => lines.push(l)); // reissue by id
    expect(f.retries).toEqual(['r1']);
    expect(waits).toEqual(['2', '2']);
  });

  it('due workers are delivered to concurrently, up to DELIVERY_POOL sends in flight at once, and every one is acked', async () => {
    const n = DELIVERY_POOL + 4;
    const { cfg: c, run } = crew(n);
    const { st, runAsync } = held(run);
    const done = { v: false };
    const p = pass(c, run, { runAsync }, (l) => lines.push(l)).finally(() => { done.v = true; });
    await settle();
    expect(st.inFlight).toBe(DELIVERY_POOL); // the pool is full before any send completes
    await drain(st, done);
    await p;
    expect(st.max).toBe(DELIVERY_POOL);
    expect(f.sent).toHaveLength(n);
    expect(f.acked).toHaveLength(n);
  });

  it('two workers that resolve to the SAME terminal never have sends in flight at once: the second is held', async () => {
    const { cfg: c, run } = crew(2, true);
    const { st, runAsync } = held(run);
    const done = { v: false };
    const p = pass(c, run, { runAsync }, (l) => lines.push(l)).finally(() => { done.v = true; });
    await settle();
    expect(st.inFlight).toBe(1);
    await drain(st, done);
    await p;
    expect(f.sent).toHaveLength(1);
    expect(log()).toContain('another send to this terminal is in flight');
  });

  it('a worker that fails stops new deliveries, but the pass waits for sends in flight (and their receipts) before it fails', async () => {
    const { cfg: c, run: base } = crew(2);
    let failNext = false;
    const run: Runner = (argv) => {
      if (failNext && argv[0] === 'orca' && argv[2] === 'wait' && argv.includes('term_1')) throw new Error('boom');
      return base(argv);
    };
    failNext = true;
    const { st, runAsync } = held(run);
    let settled = false;
    const p = pass(c, run, { runAsync }, (l) => lines.push(l)).then(() => { settled = true; }, (e) => { settled = true; throw e; });
    await settle();
    expect(st.inFlight).toBe(1); // W0's send is in flight; W1 threw
    expect(settled).toBe(false); // the pass has not given up on W0's send
    st.pending.shift()!();
    await expect(p).rejects.toThrow('boom');
    expect(f.acked).toHaveLength(1); // W0 completed: receipt then ack
  });

  it('runCommandAsync: a real process answers with its exit code and output; a spawn failure is code 1 with EMPTY stdout', async () => {
    expect(await runCommandAsync(['node', '-e', 'process.stdout.write("ok"); process.exit(3)'])).toMatchObject({ code: 3, stdout: 'ok' });
    expect(await runCommandAsync(['/nonexistent/ticker-wake-binary'])).toMatchObject({ code: 1, stdout: '' });
    const [a, b] = await Promise.all([1, 2].map(() => (async () => { const t = Date.now(); await runCommandAsync(['node', '-e', 'setTimeout(() => {}, 400)']); return Date.now() - t; })()));
    expect(Math.max(a, b)).toBeLessThan(1500); // the two overlap; they do not queue behind each other
  });

  it('production entry wires the real async runner; a test runner without one is wrapped', async () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK])];
    expect(await main(['once'], { load: cfg, run: f.run, log: (l: string) => lines.push(l), sleep: async () => {} })).toBe(0);
    expect(f.sent).toHaveLength(1);
    expect(f.acked).toHaveLength(1);
  });
});

describe('#2138: the roster comes from the ticker\'s subscribers and this host\'s bound terminals (Hugo #26221)', () => {
  /**
   * A worktree under `dir` bound (CLI binding file) to `workerId` under `sessionId` (default: that worker's current open
   * session, registered on the server), with a live agent terminal `handle` listed by Orca.
   */
  const bound = (slug: string, workerId: string | null, handle = `term_${slug}`, live = true, sessionId?: string) => {
    const wt = join(dir, slug);
    mkdirSync(join(wt, '.git'), { recursive: true });
    if (workerId) {
      const sid = sessionId ?? `s-${workerId}`;
      if (sessionId === undefined) f.sessions[workerId] ??= [{ id: sid, workerId, appId: 'app-1', endedAt: null }];
      writeFileSync(join(wt, '.git', 'hadron-team-session.json'), JSON.stringify({ workerName: slug, workerId, sessionId: sid, appId: 'app-1' }));
    }
    f.extraTerminals.push({ handle, incarnationId: 'inc-1', worktreePath: wt, connected: live, writable: true, agentIdentity: 'claude' });
    return wt;
  };
  const sub = (id: string, name: string) => ({ id, name });

  it('a subscriber missing from the hand-kept roster file is delivered through its bound terminal', async () => {
    bound('bo', 'w-bo');
    f.tickers = [{ id: 'T', pages: [[sub('w-ada', 'Ada'), sub('w-bo', 'Bo')]] }];
    f.wakes = [wake('w-bo', 'Bo', [TICK])];
    await go();
    expect(f.sent).toEqual([nudgeText(['coordinator-tick'], [])]);
    expect(f.acked).toHaveLength(1);
    expect(log()).not.toContain('unreachable');
  });

  it('a task wake for a bound worker that subscribes to nothing is still delivered', async () => {
    bound('cy', 'w-cy');
    f.wakes = [wake('w-cy', 'Cy', [task('t1')], proof([], 'x', [taskEntry('t1')]))];
    await go();
    expect(f.sent).toHaveLength(1);
    expect(f.acked).toHaveLength(1);
  });

  it("logs every subscriber it cannot reach, once per pass, with the reason, even with nothing due (today's six)", async () => {
    bound('pia', 'w-pia', 'term_pia', false); // bound, but its only terminal is disconnected
    bound('loose', null); // a terminal in an unbound worktree reaches nobody
    const six = ['Bo', 'Calvin', 'Cody', 'Mira', 'Pia', 'Udo'];
    f.tickers = [
      { id: 'T', pages: [[sub('w-ada', 'Ada'), ...six.slice(0, 3).map((n) => sub(`w-${n.toLowerCase()}`, n))]] },
      // a second page carries Udo alone, and Bo again (listed once)
      { id: 'U', pages: [six.slice(3, 5).map((n) => sub(`w-${n.toLowerCase()}`, n)), [sub('w-udo', 'Udo'), sub('w-bo', 'Bo')]] },
    ];
    await go();
    const unreachable = lines.filter((l) => l.includes('unreachable on this host'));
    expect(unreachable).toHaveLength(1);
    expect(unreachable[0]).toContain('unreachable on this host (6): Bo (no binding), Calvin (no binding), Cody (no binding), Mira (no binding), Pia (no terminal), Udo (no binding)');
    expect(unreachable[0]).not.toContain('Ada');
  });

  it('a worker bound in two worktrees under its current session is not guessed at: held, and logged', async () => {
    bound('d1', 'w-dup');
    bound('d2', 'w-dup');
    f.wakes = [wake('w-dup', 'Dup', [TICK])];
    await go();
    expect(f.sent).toEqual([]);
    expect(f.acked).toEqual([]);
    expect(log()).toContain('Dup (no binding (bound in 2 worktrees))');
  });

  it('the roster file still overrides: its row decides the worktree and pin for that worker', async () => {
    bound('ada2', 'w-ada'); // two more worktrees bound to Ada would be ambiguous, but the file row names one
    bound('ada3', 'w-ada');
    f.wakes = [wake('w-ada', 'Ada', [TICK])];
    await go();
    expect(f.sent).toHaveLength(1);
    expect(f.acked).toHaveLength(1);
  });

  it('an unreadable subscriber list stops the pass: nothing typed, nothing acked', async () => {
    f.subscribersError = 'down';
    bound('bo', 'w-bo');
    f.wakes = [wake('w-bo', 'Bo', [TICK])];
    await expect(go()).rejects.toThrow('graphql error INTERNAL_SERVER_ERROR');
    expect(f.sent).toEqual([]);
    expect(f.acked).toEqual([]);
  });

  describe("a binding counts only while it names the worker's current open session (George's #2161 P2, Ada #26314)", () => {
    const old = (w: string, endedAt: string | null = '2026-10-20T10:00:00.000Z') => ({ id: `old-${w}`, workerId: w, appId: 'app-1', endedAt });

    it("George's case: Bo's binding from an ended session, in a worktree whose idle agent terminal was reused: held, never nudged", async () => {
      f.sessions = { 'w-bo': [old('w-bo')] };
      bound('reused', 'w-bo', 'term_reused', true, 'old-w-bo');
      f.tickers = [{ id: 'T', pages: [[sub('w-bo', 'Bo')]] }];
      f.wakes = [wake('w-bo', 'Bo', [TICK])];
      await go();
      expect(f.sent).toEqual([]);
      expect(f.acked).toEqual([]);
      expect(log()).toContain('Bo: held (stale binding (session ended) on this host)');
      expect(log()).toContain('Bo (stale binding (session ended))');
      expect(f.sessionQueries).toEqual(['w-bo']); // once per pass, though asked twice
    });

    it('a binding whose session was replaced by a newer open one elsewhere is held', async () => {
      f.sessions = { 'w-bo': [{ id: 'new-w-bo', workerId: 'w-bo', appId: 'app-1', endedAt: null }, old('w-bo')] };
      bound('reused', 'w-bo', 'term_reused', true, 'old-w-bo');
      f.wakes = [wake('w-bo', 'Bo', [TICK])];
      await go();
      expect(f.sent).toEqual([]);
      expect(log()).toContain('stale binding (session replaced)');
    });

    it('the stale worktree is passed over and the current one is nudged, when both are on this host', async () => {
      f.sessions = { 'w-bo': [{ id: 'new-w-bo', workerId: 'w-bo', appId: 'app-1', endedAt: null }, old('w-bo')] };
      bound('reused', 'w-bo', 'term_reused', true, 'old-w-bo');
      bound('bo-now', 'w-bo', 'term_bo_now', true, 'new-w-bo');
      const sends: string[] = [];
      const run = f.run;
      f.run = (argv) => { if (argv[0] === 'orca' && argv[2] === 'send') sends.push(argv[argv.indexOf('--terminal') + 1]); return run(argv); };
      f.wakes = [wake('w-bo', 'Bo', [TICK])];
      await go();
      expect(sends).toEqual(['term_bo_now']);
      expect(f.acked).toHaveLength(1);
    });

    it.each([
      ['an unreadable session read', () => { f.sessionsError = 'down'; }, 'stale binding (session unreadable: graphql error INTERNAL_SERVER_ERROR)'],
      ['no visible session at all', () => { f.sessions['w-bo'] = []; }, 'stale binding (no session)'],
      ['a session of another worker', () => { f.sessions['w-bo'] = [{ id: 's-w-bo', workerId: 'w-x', appId: 'app-1', endedAt: null }]; }, 'stale binding (session mismatched)'],
      ['a session in another App', () => { f.sessions['w-bo'] = [{ id: 's-w-bo', workerId: 'w-bo', appId: 'app-2', endedAt: null }]; }, 'stale binding (app mismatched)'],
    ])('%s holds, never nudges', async (_label, arrange, why) => {
      bound('bo', 'w-bo');
      arrange();
      f.wakes = [wake('w-bo', 'Bo', [TICK])];
      await go();
      expect(f.sent).toEqual([]);
      expect(f.acked).toEqual([]);
      expect(log()).toContain(why);
      expect(log()).not.toContain('down');
    });

    it('a binding file that records no session holds (a workerId alone proves nothing)', async () => {
      const wt = join(dir, 'bare');
      mkdirSync(join(wt, '.git'), { recursive: true });
      writeFileSync(join(wt, '.git', 'hadron-team-session.json'), JSON.stringify({ workerId: 'w-bo' }));
      f.extraTerminals.push({ handle: 'term_bare', incarnationId: 'inc-1', worktreePath: wt, connected: true, writable: true, agentIdentity: 'claude' });
      f.sessions = { 'w-bo': [{ id: 's-w-bo', workerId: 'w-bo', appId: 'app-1', endedAt: null }] };
      f.wakes = [wake('w-bo', 'Bo', [TICK])];
      await go();
      expect(f.sent).toEqual([]);
      expect(log()).toContain('stale binding (session replaced)');
    });

    it('a roster-file row is the operator\'s statement and is not session-checked', async () => {
      f.wakes = [wake('w-ada', 'Ada', [TICK])];
      await go();
      expect(f.sent).toHaveLength(1);
      expect(f.sessionQueries).toEqual([]);
    });
  });

  it('the subscriber reads validate against the server SDL', () => {
    const schema = buildSchema(typeDefs);
    expect(validate(schema, parse(SUBSCRIBERS)).map((e) => e.message)).toEqual([]);
    expect(validate(schema, parse(SUBSCRIBERS_PAGE)).map((e) => e.message)).toEqual([]);
    expect(validate(schema, parse(CURRENT_SESSION)).map((e) => e.message)).toEqual([]);
  });
});

describe('#1704: stall ALARM and CHILD_FINISHED task wakes are delivered and named; END_SESSION is left alone', () => {
  const PROBE = '`hadron team chat read --mentions-me --limit 1` (it prints `cursor #C; channel head #H`)';
  const FULL = '`hadron team chat read --mentions-me --since C --all`';
  const MARK = "only if that read succeeded and you saw all of its output (if your tool truncated or saved it, read the rest first; if you can't, don't mark), run `hadron team chat mark-read --through H` with the H that read printed";
  const CHECK = `run ${PROBE}, then ${FULL} and act on the tagged messages it returns; ${MARK}`;
  /** An alarm on task `t` as agentTeamEvents returns it. */
  const alarm = (t: string, id = `e-${t}`, type = 'stall.not-started', acknowledgedAt: string | null = null) => ({ id, type, acknowledgedAt });
  const receipts = () => (existsSync(receiptsFile()) ? JSON.parse(readFileSync(receiptsFile(), 'utf8')) : {});

  it('an ALARM-only wake is nudged once, naming the task, the rule and the ack command, then acked (pinned text)', async () => {
    const p = proof([], 'x', [taskEntry('t1', 'a1', 1)]);
    f.alarms = { t1: [alarm('t1', 'a0', 'stall.no-progress'), alarm('t1', 'a1')] };
    f.wakes = [wake('w-ada', 'Ada', [task('t1', 'ALARM', 'a1', 1)], p)];
    await go();
    expect(f.sent).toEqual([
      `Hadron task wake (stall alarm stall.not-started on task t1): ${CHECK}; then act on task t1 (\`hadron team task get t1\`), `
      + 'then acknowledge its alarm with `hadron team alarm ack a1` (this message is not an acknowledgement). No unfiltered chat catch-up.',
    ]);
    expect(f.alarmQueries).toEqual(['hrn:app:test:team t1']);
    expect(f.acked).toEqual([p]);
    expect(receipts()).toEqual({});
  });

  it('a CHILD_FINISHED-only wake is nudged once, naming the child task, then acked; no alarm read', async () => {
    const p = proof([], 'x', [taskEntry('c1')]);
    f.wakes = [wake('w-ada', 'Ada', [task('c1', 'CHILD_FINISHED')], p)];
    await go();
    expect(f.sent).toEqual([
      `Hadron task wake (child task c1 finished): ${CHECK}; then review the finished child task (\`hadron team task get c1\`). No unfiltered chat catch-up.`,
    ]);
    expect(f.alarmQueries).toEqual([]);
    expect(f.acked).toEqual([p]);
  });

  it('TICK + assignment + alarm + finished child + MENTION: ONE one-line nudge names them all, and one ack covers them', async () => {
    const p = proof(['T:1'], 'x', [taskEntry('t1'), taskEntry('t2', 'a2'), taskEntry('c3')]);
    f.alarms = { t2: [alarm('t2', 'a2', 'stall.owner-unreactive')] };
    f.wakes = [wake('w-ada', 'Ada', [TICK, task('t1'), task('t2', 'ALARM', 'a2'), task('c3', 'CHILD_FINISHED'), MENTION], p)];
    await go();
    expect(f.sent).toHaveLength(1);
    const t = f.sent[0];
    expect(t).toMatch(/^Hadron task wake \(assigned t1; stall alarm stall.owner-unreactive on task t2; child task c3 finished; ticker coordinator-tick\): /);
    for (const c of ['`hadron team task get t1`', '`hadron team alarm ack a2`', '`hadron team task get c3`', 'hadron team chat mark-read --through H']) expect(t).toContain(c);
    expect(t).not.toContain('\n');
    expect(f.acked).toEqual([p]);
  });

  it('nudgeText keeps the assignment-only text unchanged', () => {
    expect(nudgeText(['coordinator-tick'], [{ id: 't1', event: 'ASSIGNED' }])).toBe(nudgeText(['coordinator-tick'], ['t1']));
    expect(nudgeText([], ['t1'])).toMatch(/^Hadron task assigned \(t1\): /);
  });

  it.each([
    ['the alarm read fails', () => { f.alarmError = 'boom'; }, 'the alarm cannot be read'],
    ['the alarm is not found on its task', () => { f.alarms = { t1: [alarm('t1', 'other')] }; }, "the alarm's rule cannot be established"],
    ['the rule is not a plain rule', () => { f.alarms = { t1: [alarm('t1', 'e-t1', 'stall; rm -rf ~')] }; }, "the alarm's rule cannot be established"],
    ['the alarm was acknowledged meanwhile', () => { f.alarms = { t1: [alarm('t1', 'e-t1', 'stall.not-started', iso(Date.now()))] }; }, 'acknowledged meanwhile'],
  ])('%s: held, no nudge, no ack, no receipt', async (_label, arrange, why) => {
    arrange();
    f.wakes = [wake('w-ada', 'Ada', [TICK, task('t1', 'ALARM')], proof(['T:1'], 'x', [taskEntry('t1')]))];
    await go();
    expect(f.sent).toEqual([]);
    expect(f.acked).toEqual([]);
    expect(log()).toContain(why);
    expect(log()).not.toContain('rm -rf');
    expect(log()).not.toContain('boom');
    expect(receipts()).toEqual({});
  });

  it("George's #2160 P2: the due alarm is the 201st, after a full page of acknowledged history; the lookup pages to it", async () => {
    const old = Array.from({ length: 200 }, (_, i) => alarm('t1', `old${i}`, 'stall.no-progress', iso(Date.now() - 86_400_000)));
    f.alarms = { t1: [...old, alarm('t1', 'new201')] };
    f.wakes = [wake('w-ada', 'Ada', [TICK, task('t1', 'ALARM', 'new201')], proof(['T:1'], 'x', [taskEntry('t1', 'new201')]))];
    await go();
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toContain('`hadron team alarm ack new201`');
    expect(f.alarmQueries).toHaveLength(2);
    expect(f.acked).toHaveLength(1);
  });

  it('an alarm absent from a history that ends exactly on a full page is held after the empty next page, never guessed', async () => {
    f.alarms = { t1: Array.from({ length: 200 }, (_, i) => alarm('t1', `old${i}`)) };
    f.wakes = [wake('w-ada', 'Ada', [task('t1', 'ALARM', 'gone')], proof([], 'x', [taskEntry('t1', 'gone')]))];
    await go();
    expect(f.sent).toEqual([]);
    expect(f.acked).toEqual([]);
    expect(f.alarmQueries).toHaveLength(2);
    expect(log()).toContain("the alarm's rule cannot be established");
  });

  it('a failed later page holds the wake rather than reading the alarm as absent', async () => {
    f.alarms = { t1: [...Array.from({ length: 200 }, (_, i) => alarm('t1', `old${i}`)), alarm('t1', 'new201')] };
    const run = f.run;
    let n = 0;
    f.run = (argv) => (argv[0] === 'hadron' && argv[2]?.includes('agentTeamEvents(') && ++n === 2
      ? { code: 0, stdout: JSON.stringify({ errors: [{ message: 'x', extensions: { code: 'INTERNAL_SERVER_ERROR' } }] }), stderr: '' } : run(argv));
    f.wakes = [wake('w-ada', 'Ada', [task('t1', 'ALARM', 'new201')], proof([], 'x', [taskEntry('t1', 'new201')]))];
    await go();
    expect(f.sent).toEqual([]);
    expect(f.acked).toEqual([]);
    expect(log()).toContain('the alarm cannot be read: graphql error INTERNAL_SERVER_ERROR');
  });

  it('a delivered alarm whose ack was lost is never named again: ack-only recovery, and a re-offer joined with a tick names only the ticker', async () => {
    f.alarms = { t1: [alarm('t1')] };
    const p1 = proof([], 'one', [taskEntry('t1')]);
    f.wakes = [wake('w-ada', 'Ada', [task('t1', 'ALARM')], p1)];
    f.ackReply = () => ({ errors: [{ message: 'down' }] });
    await go();
    expect(f.sent).toHaveLength(1);
    f.ackReply = null;
    const p2 = proof(['T:1'], 'two', [taskEntry('t1')]);
    f.wakes = [wake('w-ada', 'Ada', [TICK, task('t1', 'ALARM')], p2)];
    await go();
    expect(f.sent).toHaveLength(2);
    expect(f.sent[1]).toEqual(nudgeText(['coordinator-tick'], []));
    expect(f.acked).toEqual([p2]);
    expect(f.alarmQueries).toHaveLength(1); // a covered alarm is not read again
  });

  it('delivery is never an alarm acknowledgement: the script only ever acks the wake proof', async () => {
    f.alarms = { t1: [alarm('t1')] };
    const calls: string[][] = [];
    const run = f.run;
    f.run = (argv) => { calls.push(argv); return run(argv); };
    f.wakes = [wake('w-ada', 'Ada', [task('t1', 'ALARM')], proof([], 'x', [taskEntry('t1')]))];
    await go();
    expect(f.sent).toHaveLength(1);
    expect(calls.filter((a) => a[0] === 'hadron' && /mutation/.test(a[2] ?? '')).map((a) => a[2])).toEqual([ACK]);
  });

  describe('an ambiguous alarm or child send resolves on the channel check alone (its receiver need not be the assignee)', () => {
    const T0 = Date.parse('2026-10-20T07:30:00.000Z');
    const at = (ms: number) => ({ now: () => ms });
    const timing = { anchorAt: iso(T0 - 600_000), deliverAfter: iso(T0 - 300_000), busyDeadline: iso(T0 + 3_600_000) };

    it.each([
      ['ALARM', task('t1', 'ALARM')],
      ['CHILD_FINISHED', task('t1', 'CHILD_FINISHED')],
    ])('%s: no task is recorded for task evidence, and a later check resolves it with no task read', async (_label, reason) => {
      f.alarms = { t1: [alarm('t1')] };
      f.lastCheckedAt = iso(T0 - 60_000);
      f.wakes = [wake('w-ada', 'Ada', [reason], proof([], 'x', [taskEntry('t1')]), [], timing)];
      f.sendReply = () => JSON.stringify(ACCEPTED_ONLY);
      await go(at(T0));
      f.sendReply = null;
      expect(receipts()['w-ada']).toMatchObject({ state: 'ambiguous', tasks: {}, checkedBefore: iso(T0 - 60_000) });
      f.evidenceQueries = [];
      f.lastCheckedAt = iso(T0 + 30_000);
      await go(at(T0 + 120_000));
      expect(f.sent).toHaveLength(1);
      expect(f.evidenceQueries).toEqual(['worker w-ada']);
      expect(log()).toContain('resolved as delivered on evidence');
      expect(f.acked).toHaveLength(1);
    });

    it('an assignment joined with an alarm still needs the assigned task started', async () => {
      f.alarms = { t2: [alarm('t2')] };
      f.wakes = [wake('w-ada', 'Ada', [task('t1'), task('t2', 'ALARM')], proof([], 'x', [taskEntry('t1'), taskEntry('t2')]), [], timing)];
      f.sendReply = () => JSON.stringify(ACCEPTED_ONLY);
      await go(at(T0));
      f.sendReply = null;
      expect(receipts()['w-ada'].tasks).toEqual({ 'task:e-t1#0': 't1' });
      f.lastCheckedAt = iso(T0 + 30_000);
      f.tasks = { t1: { id: 't1', status: 'PENDING', assignee: { kind: 'WORKER', id: 'w-ada' } } };
      await go(at(T0 + 120_000));
      expect(f.acked).toEqual([]);
      expect(log()).toContain('a covered task is not started by this worker');
    });
  });
});


describe('#2138 — fresh ticks after two unreconciled cadences', () => {
  const T0 = Date.UTC(2026, 9, 21, 0);
  const timing = {anchorAt: iso(T0 - 600_000), deliverAfter: iso(T0 - 300_000), busyDeadline: iso(T0 + 3_600_000)};
  const at = (ms: number) => ({now: () => ms});
  const current = () => JSON.parse(readFileSync(receiptsFile(), 'utf8'))['w-ada'];
  const archived = () => Object.values(JSON.parse(readFileSync(join(dir, 'ticker-wake', 'needs-person.json'), 'utf8'))) as any[];
  async function stuck() {
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1'], T0), [], timing)];
    f.sendReply = () => JSON.stringify(ACCEPTED_ONLY);
    await go(at(T0));
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:3'], T0 + 1_200_000), [], timing)];
  }
  it('sends one NEW request for a newer tick, keeping the old accepted ambiguity for a person', async () => {
    await stuck();
    const old = current();
    f.sendReply = () => JSON.stringify({...ACCEPTED_ONLY, result: {send: {accepted: true, prompt: {requestId: 'r2', stages: ['input_accepted']}}}});
    await go(at(T0 + 1_200_000));
    expect(f.sent).toHaveLength(2);
    expect(f.sent[1]).not.toBe(old.text);
    expect(f.sent[1]).toContain('run your base tick (coordinator-system:tasks:on-base-tick)');
    expect(f.retries).toEqual(['r1']);
    expect(current()).toMatchObject({state: 'ambiguous', requestId: 'r2', coverage: ['T:3'], checkedBefore: null});
    expect(archived()).toEqual([expect.objectContaining({...old, workerId: 'w-ada'})]);
    expect(log()).toMatch(/needs a person.*1200s/);
    expect(f.acked).toEqual([]);
    await go(at(T0 + 1_200_001));
    expect(f.sent).toHaveLength(2); // restart/re-offer is not another fresh request
  });
  it('#2746: a hold logged earlier in a delivery is cleared when the same delivery then succeeds', async () => {
    await stuck();
    const holdsPath = join(dir, 'ticker-wake', 'holds.log');
    expect(readFileSync(holdsPath, 'utf8').trim().split('\n')).toHaveLength(1); // pass one: send accepted but unconfirmed
    f.sendReply = () => JSON.stringify(CONFIRMED);
    await go(at(T0 + 1_200_000));
    expect(f.acked).toHaveLength(1);
    expect(log()).toContain('earlier request still unreconciled'); // a hold line was logged before the fresh request succeeded
    expect(readFileSync(holdsPath, 'utf8').trim().split('\n')).toHaveLength(1); // pass two delivered: no new hold line
  });
  it('a confirmed replacement acks only its newer proof; the old entry survives the ack', async () => {
    await stuck();
    f.sendReply = () => JSON.stringify(CONFIRMED);
    await go(at(T0 + 1_200_000));
    expect(f.sent).toHaveLength(2);
    expect(f.acked).toEqual([f.wakes[0].proof]);
    expect(archived()).toHaveLength(1);
    expect(archived()[0]).toMatchObject({coverage: ['T:1'], state: 'ambiguous'});
  });
  it('resolves an id-less accepted request on evidence before considering newer-tick recovery', async () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1'], T0), [], timing)];
    f.sendReply = () => JSON.stringify(NO_ID_ACCEPTED);
    await go(at(T0));
    expect(current().requestId).toBeUndefined();
    f.lastCheckedAt = iso(T0 + 60_000);
    // New tick is legitimate new work, but the handled old request must not be archived or called unresolved.
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:3'], T0 + 1_200_000), [], timing)];
    f.sendReply = () => JSON.stringify(CONFIRMED);
    await go(at(T0 + 1_200_000));
    expect(f.sent).toHaveLength(2); // old handled request plus the new tick, via normal delivery
    expect(f.sent[1]).not.toContain('Fresh tick request at');
    expect(existsSync(join(dir, 'ticker-wake', 'needs-person.json'))).toBe(false);
    expect(log()).toContain('resolved as delivered on evidence');
    expect(f.acked).toEqual([f.wakes[0].proof]);
  });
  it('acks only, without archiving or typing again, when an id-less old request is handled and its proof is re-offered', async () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1'], T0), [], timing)];
    f.sendReply = () => JSON.stringify(NO_ID_ACCEPTED);
    await go(at(T0));
    f.lastCheckedAt = iso(T0 + 60_000);
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1'], T0 + 1_200_000), [], timing)];
    await go(at(T0 + 1_200_000));
    expect(f.sent).toHaveLength(1);
    expect(f.acked).toEqual([f.wakes[0].proof]);
    expect(existsSync(join(dir, 'ticker-wake', 'needs-person.json'))).toBe(false);
    expect(log()).toContain('resolved as delivered on evidence');
  });
  it('requires a new two-cadence wait for a replacement that also remains ambiguous', async () => {
    await stuck();
    f.sendReply = () => JSON.stringify({...ACCEPTED_ONLY, result: {send: {accepted:true, prompt:{requestId:'r2', stages:['input_accepted']}}}});
    await go(at(T0 + 1_200_000));
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:5'], T0 + 2_400_000), [], timing)];
    await go(at(T0 + 2_399_999));
    expect(f.sent).toHaveLength(2);
    await go(at(T0 + 2_400_000));
    expect(f.sent).toHaveLength(3);
    expect(archived()).toHaveLength(2);
    expect(current().coverage).toEqual(['T:5']);
    expect(f.acked).toEqual([]);
  });
  it('rejects malformed needs-person state before any send or ack', async () => {
    await stuck();
    writeFileSync(join(dir, 'ticker-wake', 'needs-person.json'), JSON.stringify({x:{...current(), workerId: 7}}));
    await expect(go(at(T0 + 1_200_000))).rejects.toThrow(/needs-person receipts malformed/);
    expect(f.sent).toHaveLength(1);
    expect(f.acked).toEqual([]);
  });
  it('re-checks incarnation after the old request replay, before making a fresh request', async () => {
    await stuck();
    f.retryReply = () => { f.incarnation = 'inc-2'; return JSON.stringify(ACCEPTED_ONLY); };
    await go(at(T0 + 1_200_000));
    expect(f.sent).toHaveLength(1);
    expect(f.acked).toEqual([]);
    expect(log()).toContain('incarnation changed before the fresh request');
  });
  it('does not ack or re-name old task coverage bundled with a newer tick', async () => {
    const oldTask = taskEntry('t7');
    f.wakes = [wake('w-ada', 'Ada', [TICK, task('t7')], proof(['T:1'], T0, [oldTask]), [], timing)];
    f.sendReply = () => JSON.stringify(ACCEPTED_ONLY);
    await go(at(T0));
    f.wakes = [wake('w-ada', 'Ada', [TICK, task('t7')], proof(['T:3'], T0 + 1_200_000, [oldTask]), [], timing)];
    f.sendReply = () => JSON.stringify(CONFIRMED);
    await go(at(T0 + 1_200_000));
    expect(f.sent).toHaveLength(2);
    expect(f.sent[1]).not.toContain('t7');
    expect(current()).toMatchObject({state: 'sent', coverage: ['T:3']});
    expect(f.acked).toEqual([]);
    await go(at(T0 + 1_200_001));
    expect(f.sent).toHaveLength(2);
    expect(f.acked).toEqual([]);
  });
  it('fails closed if retaining the old ambiguity is not possible', async () => {
    await stuck();
    mkdirSync(join(dir, 'ticker-wake', 'needs-person.json.' + process.pid + '.tmp'));
    await go(at(T0 + 1_200_000));
    expect(f.sent).toHaveLength(1);
    expect(f.acked).toEqual([]);
    expect(current().coverage).toEqual(['T:1']);
    expect(log()).toContain('old request could not be retained');
  });
  for (const guard of ['draft', 'incomplete inventory', 'busy', 'before cadence', 'same tick', 'missing incarnation', 'server check failed'] as const) {
    it(`holds a replacement with ${guard}`, async () => {
      await stuck();
      if (guard === 'draft') f.screen = {...f.screen, draft: 'human typing'};
      if (guard === 'incomplete inventory') {
        f.incarnation = 'inc-2';
        f.terminalReply = () => ({ ok: true, result: { hasNextPage: true, terminals: [{ handle: 'term_a', incarnationId: f.incarnation, worktreePath: dir, agentIdentity: 'claude' }] } });
      }
      if (guard === 'missing incarnation') f.incarnation = '';
      if (guard === 'busy') { f.idle = false; f.screen = {source:'screen', tail:['✽ Bunning… (5m 55s · ↓ 15.6k tokens)', RULE, '❯', RULE, '  ⏵⏵ bypass permissions on (shift+tab to cycle)']}; }
      if (guard === 'same tick') f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1'], T0 + 1_200_000), [], timing)];
      if (guard === 'server check failed') f.checkError = 'unavailable';
      await go(at(T0 + (guard === 'before cadence' ? 1_199_999 : 1_200_000)));
      expect(f.sent).toHaveLength(1);
      expect(f.acked).toEqual([]);
      expect(current().state).toBe('ambiguous');
    });
  }
});


describe('#2275 dead-receiver replacement', () => {
  const old = () => ({ state: 'ambiguous', coverage: ['T:1'], receiver: 'term_old#inc-old',
    at: Date.now() - 60_000, detail: 'accepted, turn start not confirmed (input_accepted)',
    text: 'old notification', handle: 'term_old', requestId: 'old-request', checkedBefore: null });
  const stored = () => JSON.parse(readFileSync(receiptsFile(), 'utf8'));
  const inventory = () => ({ ok: true, result: { hostScope: { hostIds: ['local'], omittedHostIds: [] }, terminals: [{ handle: 'term_a', incarnationId: f.incarnation,
    worktreePath: dir, connected: true, writable: true, agentIdentity: 'claude' }, ...f.extraTerminals] } });
  function seed(prior = old()) {
    mkdirSync(join(dir, 'ticker-wake'), { recursive: true });
    writeFileSync(receiptsFile(), JSON.stringify({ 'w-ada': prior, unrelated: {
      state: 'sent', coverage: ['U:9'], receiver: 'term_other#inc-other', at: 1 } }));
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1']))];
    f.sendReply = () => JSON.stringify(ACCEPTED_ONLY);
    return prior;
  }
  it('replaces an absent accepted-but-unconfirmed receiver without acknowledging old delivery or unrelated state', async () => {
    const prior = seed();
    await go();
    expect(f.sent).toHaveLength(1); expect(f.retries).toEqual([]); expect(f.acked).toEqual([]);
    expect(stored()['w-ada']).toMatchObject({ state: 'ambiguous', receiver: 'term_a#inc-1', handle: 'term_a' });
    expect(stored().unrelated).toMatchObject({ receiver: 'term_other#inc-other' });
    const archive = Object.values(JSON.parse(readFileSync(join(dir, 'ticker-wake', 'needs-person.json'), 'utf8')));
    expect(archive).toEqual([expect.objectContaining({ ...prior, workerId: 'w-ada' })]);
  });
  it('keeps a still-present prior incarnation held even when it cannot currently accept input', async () => {
    const prior = seed();
    f.extraTerminals = [{ handle: 'term_old', incarnationId: 'inc-old', worktreePath: dir, connected: false, writable: false }];
    await go();
    expect(f.sent).toEqual([]); expect(f.acked).toEqual([]); expect(stored()['w-ada']).toEqual(prior);
  });
  it('recognizes a reused handle only with a known different incarnation', async () => {
    seed({ ...old(), handle: 'term_a', receiver: 'term_a#inc-old' });
    await go();
    expect(f.sent).toHaveLength(1); expect(f.acked).toEqual([]);
    expect(stored()['w-ada'].receiver).toBe('term_a#inc-1');
  });
  for (const kind of ['failed', 'partial', 'unknown-old', 'unknown-current', 'unknown-row'] as const) {
    it(`holds replacement on ${kind} inventory/identity`, async () => {
      const prior = seed();
      if (kind === 'failed') f.terminalReply = () => ({ ok: false, error: { code: 'terminal_list_failed' } });
      if (kind === 'partial') f.terminalReply = () => ({ ...inventory(), result: { ...inventory().result, hasNextPage: true } });
      if (kind === 'unknown-old') { prior.receiver = 'term_old#'; writeFileSync(receiptsFile(), JSON.stringify({ 'w-ada': prior })); }
      if (kind === 'unknown-current') f.incarnation = '';
      if (kind === 'unknown-row') f.extraTerminals = [{ incarnationId: 'inc-old', worktreePath: dir }];
      try { await go(); } catch { /* an unreadable inventory may stop the whole pass */ }
      expect(f.sent).toEqual([]); expect(f.retries).toEqual([]); expect(f.acked).toEqual([]);
      expect(stored()['w-ada']).toEqual(prior);
    });
  }
  for (const guard of ['draft', 'busy', 'future-floor', 'dry'] as const) {
    it(`keeps replacement behind the normal ${guard} send gate`, async () => {
      const prior = seed();
      if (guard === 'draft') f.screen.draft = 'human work';
      if (guard === 'busy') { f.idle = false; f.screen = { source: 'screen', tail: ['✽ Bunning… (5m 55s · ↓ 15.6k tokens)', RULE, '❯', RULE, '  ⏵⏵ bypass permissions on (shift+tab to cycle)'] }; }
      if (guard === 'future-floor') f.wakes[0].deliverAfter = iso(Date.now() + 60_000);
      await go({ dry: guard === 'dry' });
      expect(f.sent).toEqual([]); expect(f.acked).toEqual([]); expect(stored()['w-ada']).toEqual(prior);
    });
  }
  const incompleteScopes = [
    ['missing scope', undefined], ['null scope', null],
    ['empty covered hosts', { hostIds: [], omittedHostIds: [] }],
    ['unknown covered hosts', { hostIds: ['future:host'], omittedHostIds: [] }],
    ['omitted SSH host', { hostIds: ['local'], omittedHostIds: ['ssh:devbox'] }],
    ['omitted local host', { hostIds: ['ssh:devbox'], omittedHostIds: ['local'] }],
    ['omitted unknown host', { hostIds: ['local'], omittedHostIds: ['future:host'] }],
    ['missing omitted list', { hostIds: ['local'] }],
    ['invalid encoded host', { hostIds: ['ssh:%ZZ'], omittedHostIds: [] }],
    ['invalid runtime omission', { hostIds: ['local'], omittedHostIds: ['runtime:'] }],
    ['pipe in runtime omission', { hostIds: ['local'], omittedHostIds: ['runtime:a|b'] }],
  ] as const;
  for (const [label, scope] of incompleteScopes) {
    it(`holds without Orca census completeness: ${label}`, async () => {
      const prior = seed();
      f.terminalReply = () => ({ ...inventory(), result: { ...inventory().result, hostScope: scope } });
      await go();
      expect(f.sent).toEqual([]); expect(f.retries).toEqual([]); expect(f.acked).toEqual([]);
      expect(stored()['w-ada']).toEqual(prior);
      expect(existsSync(join(dir, 'ticker-wake', 'needs-person.json'))).toBe(false);
    });
  }
  it('accepts a legible covered host with runtime-only omissions, including unknown future covered host kinds', async () => {
    seed();
    f.terminalReply = () => ({ ...inventory(), result: { ...inventory().result,
      hostScope: { hostIds: ['future:host', 'ssh:dev%20box'], omittedHostIds: ['runtime:peer%20box'] } } });
    await go();
    expect(f.sent).toHaveLength(1); expect(f.acked).toEqual([]);
  });
  it('rechecks host-scope coverage before archiving or replacement intent', async () => {
    const prior = seed(); let calls = 0;
    f.terminalReply = () => ({ ...inventory(), result: { ...inventory().result,
      hostScope: { hostIds: ['local'], omittedHostIds: ++calls > 1 ? ['ssh:lost'] : [] } } });
    await go();
    expect(f.sent).toEqual([]); expect(f.acked).toEqual([]); expect(stored()['w-ada']).toEqual(prior);
  });
  it('duplicate terminal handles cannot prove the old receiver gone', async () => {
    const prior = seed();
    f.extraTerminals = [{ handle: 'term_a', incarnationId: 'different', worktreePath: dir }];
    await go();
    expect(f.sent).toEqual([]); expect(f.acked).toEqual([]); expect(stored()['w-ada']).toEqual(prior);
  });
  it('archives before replacement intent: archive failure leaves the old receipt and unrelated entries intact', async () => {
    const prior = seed(); mkdirSync(join(dir, 'ticker-wake', `needs-person.json.${process.pid}.tmp`));
    await go();
    expect(f.sent).toEqual([]); expect(f.acked).toEqual([]); expect(stored()['w-ada']).toEqual(prior);
    expect(stored().unrelated).toMatchObject({ receiver: 'term_other#inc-other' });
  });
  it('retains new intent and the old archive if a confirmed replacement crashes before receipt persistence', async () => {
    const prior = seed();
    f.sendReply = () => { mkdirSync(`${receiptsFile()}.${process.pid}.tmp`); return JSON.stringify(CONFIRMED); };
    await go();
    expect(f.sent).toHaveLength(1); expect(f.acked).toEqual([]);
    expect(stored()['w-ada']).toMatchObject({ state: 'ambiguous', receiver: 'term_a#inc-1', detail: 'send intent recorded before submission; outcome unknown' });
    expect(Object.values(JSON.parse(readFileSync(join(dir, 'ticker-wake', 'needs-person.json'), 'utf8')))).toEqual([
      expect.objectContaining({ ...prior, workerId: 'w-ada' }),
    ]);
    rmSync(`${receiptsFile()}.${process.pid}.tmp`, { recursive: true });
    f.sendReply = null; await go();
    expect(f.sent).toHaveLength(1); expect(f.acked).toEqual([]);
    expect(stored().unrelated).toMatchObject({ receiver: 'term_other#inc-other' });
  });
  for (const change of ['old receiver returns', 'current replaced', 'inventory fails', 'draft appears'] as const) {
    it(`revalidates before durable retirement when ${change}`, async () => {
      const prior = seed(); let count = 0;
      f.terminalReply = () => {
        if (++count === 2) {
          if (change === 'old receiver returns') f.extraTerminals = [{ handle: 'term_old', incarnationId: 'inc-old', worktreePath: dir }];
          if (change === 'current replaced') f.incarnation = 'inc-2';
          if (change === 'draft appears') f.screen.draft = 'human typing';
          if (change === 'inventory fails') return { ok: false, error: { code: 'terminal_list_failed' } };
        }
        return inventory();
      };
      try { await go(); } catch { /* failed inventory aborts rather than writes */ }
      expect(f.sent).toEqual([]); expect(f.acked).toEqual([]); expect(stored()['w-ada']).toEqual(prior);
    });
  }
  it('does not retire the old receipt when replacement intent cannot be saved', async () => {
    const prior = seed(); mkdirSync(`${receiptsFile()}.${process.pid}.tmp`);
    await go();
    expect(f.sent).toEqual([]); expect(f.acked).toEqual([]); expect(stored()['w-ada']).toEqual(prior);
    expect(stored().unrelated).toMatchObject({ receiver: 'term_other#inc-other' });
  });
});

// #2275 slice A: a failed request identity is still uncertain, not proof of non-delivery.
describe('#2275 same-receiver never-accepted recovery', () => {
  const T0 = Date.UTC(2026, 9, 24, 0);
  const at = (ms: number) => ({ now: () => ms });
  const timing = { anchorAt: iso(T0 - 600_000), deliverAfter: iso(T0 - 300_000), busyDeadline: iso(T0 + 3_600_000) };
  const stored = () => JSON.parse(readFileSync(receiptsFile(), 'utf8'));
  const archived = () => Object.values(JSON.parse(readFileSync(join(dir, 'ticker-wake', 'needs-person.json'), 'utf8'))) as any[];
  const failed = { ok: false, error: { code: 'transport' }, requestId: 'failed-request' };
  function seed(joined = false) {
    const prior = { state: 'ambiguous', coverage: ['T:1', 'task:old-event:0'], receiver: 'term_a#inc-1', at: T0,
      detail: 'failed with a request identity' + (joined ? '; same-id retry: failed with a request identity' : ''),
      text: 'original prompt must not be replayed as fresh', handle: 'term_a', requestId: 'failed-request', checkedBefore: null };
    mkdirSync(join(dir, 'ticker-wake'), { recursive: true });
    writeFileSync(receiptsFile(), JSON.stringify({ 'w-ada': prior, unrelated: { state: 'sent', coverage: ['U:9'], receiver: 'other#inc', at: 1 } }));
    f.wakes = [wake('w-ada', 'Ada', [TICK, task('old-task', 'ASSIGNED', 'old-event')], proof(['T:3'], T0 + 1_200_000, [taskEntry('old-task', 'old-event')]), [], timing)];
    f.retryReply = () => JSON.stringify(failed);
    f.sendReply = () => JSON.stringify({ ...ACCEPTED_ONLY, result: { send: { accepted: true, prompt: { requestId: 'new-request', stages: ['input_accepted'] } } } });
    return prior;
  }
  for (const joined of [false, true]) {
    it(`replaces old failure${joined ? ' with joined retry detail' : ''} with newer tick only, keeping old coverage and unrelated receipts`, async () => {
      const prior = seed(joined);
      await go(at(T0 + 1_200_000));
      expect(f.sent).toHaveLength(1);
      expect(f.sent[0]).toContain('Fresh tick request at');
      expect(f.sent[0]).not.toContain('original prompt');
      expect(f.sent[0]).not.toContain('old-task');
      expect(f.retries).toEqual(['failed-request']); // only the existing own-id reconciliation
      expect(stored()['w-ada']).toMatchObject({ requestId: 'new-request', coverage: ['T:3'] });
      expect(stored().unrelated).toMatchObject({ receiver: 'other#inc' });
      expect(archived()).toEqual([expect.objectContaining({ ...prior, workerId: 'w-ada' })]);
      expect(log()).toContain('Orca never reported the input accepted');
      expect(log()).toMatch(/needs a person.*not a retype/);
      expect(f.acked).toEqual([]);
      expect(f.enters).toEqual([]);
      await go(at(T0 + 1_200_001));
      expect(f.sent).toHaveLength(1); // restart/re-offer cannot repeat archived coverage
      expect(f.acked).toEqual([]);
    });
  }
  for (const guard of ['young', 'different live receiver', 'draft', 'busy', 'missing incarnation', 'same tick', 'dry'] as const) {
    it(`still holds failed identity with ${guard}`, async () => {
      const prior = seed();
      if (guard === 'different live receiver') {
        prior.handle = 'term_old'; prior.receiver = 'term_old#inc-old';
        writeFileSync(receiptsFile(), JSON.stringify({ ...stored(), 'w-ada': prior }));
        f.extraTerminals = [{ handle: 'term_old', incarnationId: 'inc-old', worktreePath: dir }];
      }
      if (guard === 'draft') f.screen.draft = 'human typing';
      if (guard === 'busy') { f.idle = false; f.screen = { source: 'screen', tail: ['✽ Bunning… (5m 55s · ↓ 15.6k tokens)', RULE, '❯', RULE, '  ⏵⏵ bypass permissions on (shift+tab to cycle)'] }; }
      if (guard === 'missing incarnation') f.incarnation = '';
      if (guard === 'same tick') f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1'], T0 + 1_200_000), [], timing)];
      await go({ ...at(T0 + (guard === 'young' ? 1_199_999 : 1_200_000)), dry: guard === 'dry' });
      expect(f.sent).toEqual([]);
      expect(f.acked).toEqual([]);
      expect(stored()['w-ada']).toEqual(prior);
    });
  }
  for (const fault of ['archive', 'intent', 'after send'] as const) {
    it(`keeps durable old ambiguity and unrelated receipts on ${fault} persistence failure`, async () => {
      const prior = seed();
      const blocked = fault === 'archive' ? join(dir, 'ticker-wake', `needs-person.json.${process.pid}.tmp`) : `${receiptsFile()}.${process.pid}.tmp`;
      if (fault === 'after send') f.sendReply = () => { mkdirSync(blocked); return JSON.stringify(CONFIRMED); };
      else mkdirSync(blocked);
      await go(at(T0 + 1_200_000));
      expect(f.sent).toHaveLength(fault === 'after send' ? 1 : 0);
      expect(f.acked).toEqual([]);
      expect(stored().unrelated).toMatchObject({ receiver: 'other#inc' });
      if (fault === 'after send') {
        expect(stored()['w-ada']).toMatchObject({ state: 'ambiguous', detail: 'send intent recorded before submission; outcome unknown' });
        expect(archived()).toEqual([expect.objectContaining(prior)]);
        rmSync(blocked, { recursive: true });
        await go(at(T0 + 1_200_001));
        expect(f.sent).toHaveLength(1);
        expect(f.acked).toEqual([]);
      } else {
        expect(stored()['w-ada']).toEqual(prior);
        expect(log()).toContain(fault === 'archive' ? 'old request could not be retained' : 'send intent could not be recorded');
      }
    });
  }
});

describe('#2613 — the open-task line on every ticker-wake form', () => {
  const open = (worker: string, n: number, status = 'STARTED') =>
    Array.from({ length: n }, (_, i) => ({ id: `o${i}`, status, assignee: { kind: 'WORKER', id: worker } }));
  const LINE = (n: number) => ` You have ${n} open task${n === 1 ? '' : 's'} (as read when this was sent); run \`hadron team task mine\`.`;

  it('appends the line after the existing bytes on the team-tick, assignment, alarm and finished-child forms', () => {
    expect(nudgeText(['team-tick'], [], LINE(2))).toBe(nudgeText(['team-tick'], []) + LINE(2));
    expect(nudgeText([], ['t1'], LINE(2))).toBe(nudgeText([], ['t1']) + LINE(2));
    const forms: Array<Array<{ id: string; event: 'ALARM' | 'CHILD_FINISHED'; eventId?: string; rule?: string }>> = [
      [{ id: 't9', event: 'ALARM', eventId: 'e9', rule: 'STALL_NOT_STARTED' }], [{ id: 'c1', event: 'CHILD_FINISHED' }],
    ];
    for (const tasks of forms) expect(nudgeText(['team-tick'], tasks as any, LINE(2))).toBe(nudgeText(['team-tick'], tasks as any) + LINE(2));
    expect(nudgeText(['coordinator-tick'], [], LINE(1))).toBe(nudgeText(['coordinator-tick'], []) + LINE(1));
  });

  it('delivers a tick wake carrying the line, read for THIS worker in the wake App', async () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1'], 'a'))];
    f.openTasks['w-ada'] = open('w-ada', 4);
    f.openTasks['w-other'] = open('w-other', 9); // another worker's tasks are never read for Ada
    await go();
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toBe(nudgeText(['coordinator-tick'], [], LINE(4)));
    expect(f.openTaskReads).toEqual([['hrn:app:test:team', 'w-ada', '0']]);
  });

  it('delivers an assignment wake carrying the line', async () => {
    f.wakes = [wake('w-ada', 'Ada', [task('t7')], proof([], 'b', [taskEntry('t7')]))];
    f.openTasks['w-ada'] = open('w-ada', 1, 'PENDING');
    await go();
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toBe(nudgeText([], ['t7'], LINE(1)));
  });

  it('zero open tasks leaves the wake byte-identical to today', async () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1'], 'a'))];
    await go();
    expect(f.sent[0]).toBe(nudgeText(['coordinator-tick'], []));
  });

  it('a refused count read still delivers the wake, with no count claim and no "none"', async () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1'], 'a'))];
    f.openTasksError = true;
    await go();
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toBe(nudgeText(['coordinator-tick'], []));
    expect(f.sent[0]).not.toMatch(/open task|You have \d/);
  });

  it('a refused count read logs ONE closed-reason line with the worker name and nothing the read returned (#2630)', async () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1'], 'a'))];
    f.openTasksError = true;
    await go();
    const diag = lines.filter((l) => l.includes('open-task count unknown'));
    expect(diag).toHaveLength(1);
    expect(diag[0]).toMatch(/Ada: open-task count unknown \(refused\); the wake goes without the line$/);
    expect(lines.join('\n')).not.toMatch(/tasks down|INTERNAL_SERVER_ERROR/);
    expect(f.sent).toHaveLength(1); // fail-open
  });

  it('a count or a zero logs no diagnostic (#2630)', async () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1'], 'a'))];
    f.openTasks['w-ada'] = open('w-ada', 2);
    await go();
    expect(lines.filter((l) => l.includes('open-task count unknown'))).toEqual([]);
  });

  it('an empty result (the read answered, zero rows): no diagnostic, no open-task clause, the plain wake still delivers (#2641)', async () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1'], 'a'))];
    f.openTasks['w-ada'] = [];
    await go();
    expect(f.openTaskReads).toEqual([['hrn:app:test:team', 'w-ada', '0']]); // the read ran and answered empty
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toBe(nudgeText(['coordinator-tick'], []));
    expect(f.sent[0]).not.toMatch(/open task|You have \d/);
    expect(lines.filter((l) => l.includes('open-task count unknown'))).toEqual([]);
  });

  it('a row that is not open or not this worker makes the count unknown; the wake is plain', async () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1'], 'a'))];
    f.openTasks['w-ada'] = [...open('w-ada', 2), { id: 'x', status: 'CANCELLED', assignee: { kind: 'WORKER', id: 'w-ada' } }];
    await go();
    expect(f.sent[0]).toBe(nudgeText(['coordinator-tick'], []));
  });

  it('pages: 201 open tasks read as 201', async () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1'], 'a'))];
    f.openTasks['w-ada'] = open('w-ada', 201);
    await go();
    expect(f.sent[0]).toBe(nudgeText(['coordinator-tick'], [], LINE(201)));
    expect(f.openTaskReads.map((r) => r[2])).toEqual(['0', '200']);
  });

  it('a dry run reads nothing and sends nothing', async () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1'], 'a'))];
    f.openTasks['w-ada'] = open('w-ada', 2);
    await go({ dry: true });
    expect(f.sent).toEqual([]);
    expect(f.openTaskReads).toEqual([]);
  });

  it('reads the count BEFORE the final screen proofs, never between the last gate and the send (LOCAL P2-1)', async () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1'], 'a'))];
    f.openTasks['w-ada'] = open('w-ada', 2);
    await go();
    expect(f.sent).toHaveLength(1);
    const count = f.order.indexOf('count');
    expect(count).toBeGreaterThan(-1);
    expect(f.order.lastIndexOf('read')).toBeGreaterThan(count);
    expect(f.order.indexOf('send')).toBeGreaterThan(f.order.lastIndexOf('read'));
    expect(f.order.slice(count + 1, f.order.indexOf('send')).includes('count')).toBe(false);
  });

  it("the count shares the pass deadline: a read that ends past the pass end adds no line, and the wake is still sent plain", async () => {
    const base = Date.now();
    let t = 0;
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1'], 'a'))];
    f.openTasks['w-ada'] = open('w-ada', 2);
    f.onCount = () => { t += 3_000; }; // the read itself takes 3 s; the pass has 2 s left
    await pass(cfg(), f.run, { now: () => base + t, budgetMs: 2_000 }, (l) => lines.push(l));
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toBe(nudgeText(['coordinator-tick'], []));
  });

  it('inside the pass deadline the same read still counts', async () => {
    const base = Date.now();
    let t = 0;
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1'], 'a'))];
    f.openTasks['w-ada'] = open('w-ada', 2);
    f.onCount = () => { t += 100; };
    await pass(cfg(), f.run, { now: () => base + t, budgetMs: 2_000 }, (l) => lines.push(l));
    expect(f.sent[0]).toBe(nudgeText(['coordinator-tick'], [], LINE(2)));
  });
});

describe('#2754 — the server tick line', () => {
  const stored = () => JSON.parse(readFileSync(receiptsFile(), 'utf8'));
  const OPEN = (n: number) => ` You have ${n} open task${n === 1 ? '' : 's'} (as read when this was sent); run \`hadron team task mine\`.`;
  const FORMS = [
    'tick team-tick: run hrn:node:hadronmemory.com:x-system:tasks:on-team-tick',
    'tick eden-queue-tick: same task as above',
    'tick team-tick: no task is mapped for tick.team',
    'tick team-tick: no task found at x-system:tasks:on-team-tick for tick.team',
    'tick team-tick: resolve your task for tick.team yourself',
  ];
  const TEAM = { kind: 'TICK', ticker: { id: 'V', name: 'team-tick' } };
  const mapped = (t: any, state: string) => ({ ...t, action: { state } });

  it('2. a due TICK wake sends the server line first, then one space, then today\'s nudge', async () => {
    f.wakes = [wake('w-ada', 'Ada', [TEAM], proof(['V:1']), [], undefined, FORMS[0])];
    await go();
    expect(f.sent).toEqual([`${FORMS[0]} ${nudgeText(['team-tick'], [])}`]);
  });

  for (const form of FORMS) {
    it(`3. types the line byte for byte: ${form.slice(0, 40)}`, async () => {
      f.wakes = [wake('w-ada', 'Ada', [TEAM], proof(['V:1']), [], undefined, form)];
      await go();
      expect(f.sent[0].startsWith(form + ' Hadron ticker wake (team-tick)')).toBe(true);
      expect(f.sent[0]).not.toContain('\n');
    });
  }

  it('3. does not trim, re-case or re-space the line (double spaces and edge spaces survive)', async () => {
    const odd = ' tick team-tick:  run  hrn:node:hadronmemory.com:x:y ';
    f.wakes = [wake('w-ada', 'Ada', [TEAM], proof(['V:1']), [], undefined, odd)];
    await go();
    expect(f.sent[0]).toBe(`${odd} ${nudgeText(['team-tick'], [])}`);
  });

  it('4. a null tick line, and a reply with no tickText field at all, send today\'s text', async () => {
    for (const tickText of [null, undefined]) {
      f.sent.length = 0; f.wakes = [wake('w-ada', 'Ada', [TEAM], proof(['V:1'], String(tickText)), [], undefined, tickText)];
      rmSync(join(dir, 'ticker-wake'), { recursive: true, force: true });
      await go();
      expect(f.sent).toEqual([nudgeText(['team-tick'], [])]);
    }
  });

  it('5. a TICK + ASSIGNED wake starts with the line, then the assignment text; a TASK-only wake is unchanged', async () => {
    f.wakes = [wake('w-ada', 'Ada', [TEAM, task('t7')], proof(['V:1'], 'a', [taskEntry('t7')]), [], undefined, FORMS[0])];
    await go();
    expect(f.sent).toEqual([`${FORMS[0]} ${nudgeText(['team-tick'], ['t7'])}`]);
    f.sent.length = 0; rmSync(join(dir, 'ticker-wake'), { recursive: true, force: true });
    f.wakes = [wake('w-ada', 'Ada', [task('t8')], proof([], 'b', [taskEntry('t8')]), [], undefined, null)];
    await go();
    expect(f.sent).toEqual([nudgeText([], ['t8'])]);
  });

  it('6. a displaced request is the line, then the fresh-request prefix, then the nudge', async () => {
    const T0 = Date.UTC(2026, 9, 24, 0);
    const prior = { state: 'ambiguous', coverage: ['V:1'], receiver: 'term_a#inc-1', at: T0, detail: 'failed with a request identity',
      text: 'original', handle: 'term_a', requestId: 'failed-request', checkedBefore: null };
    mkdirSync(join(dir, 'ticker-wake'), { recursive: true });
    writeFileSync(receiptsFile(), JSON.stringify({ 'w-ada': prior }));
    const timing = { anchorAt: iso(T0 - 600_000), deliverAfter: iso(T0 - 300_000), busyDeadline: iso(T0 + 3_600_000) };
    f.wakes = [wake('w-ada', 'Ada', [TEAM], proof(['V:3'], T0 + 1_200_000), [], timing, FORMS[0])];
    f.retryReply = () => JSON.stringify({ ok: false, error: { code: 'transport' }, requestId: 'failed-request' });
    f.sendReply = () => JSON.stringify(ACCEPTED_ONLY);
    await go({ now: () => T0 + 1_200_000 });
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0].startsWith(`${FORMS[0]} Fresh tick request at `)).toBe(true);
  });

  const BAD: Array<[string, string]> = [
    ['a C0 control character', 'tick team-tick: run x\u0007y'],
    ['a C1 control character', 'tick team-tick: run x\u0085y'],
    ['a tab', 'tick team-tick:\trun x'],
    ['a line break', 'tick team-tick: run x\ntick u: y'],
    ['a carriage return', 'tick team-tick: run x\ry'],
    ['U+2028', 'tick team-tick: run x\u2028y'],
    ['U+2029', 'tick team-tick: run x\u2029y'],
    ['an empty string', ''],
    ['a non-string', 42 as any],
    ['over the length cap', 'tick team-tick: ' + 'x'.repeat(5000)],
  ];
  for (const [why, bad] of BAD) {
    it(`7. a tick line holding ${why} is dropped: today's text goes out, one closed-reason log line, no text in the log or receipt`, async () => {
      f.wakes = [wake('w-ada', 'Ada', [TEAM], proof(['V:1']), [], undefined, bad)];
      await go();
      expect(f.sent).toEqual([nudgeText(['team-tick'], [])]);
      if (bad === '' || typeof bad !== 'string') return;
      expect(log().split('\n').filter((l) => l.includes('tick line not typeable'))).toHaveLength(1);
      expect(log()).toMatch(/Ada: .*tick line not typeable/);
      expect(log()).not.toContain('x\u0007y');
      expect(log()).not.toContain('tick team-tick');
      expect(readFileSync(receiptsFile(), 'utf8')).not.toContain('tick team-tick: ');
    });
  }

  it('8. a coordinator-tick whose action is MAPPED no longer gets the hard-coded base-tick sentence, and still gets the tagged check', async () => {
    const line = 'tick coordinator-tick: run hrn:node:hadronmemory.com:coordinator-system:tasks:on-base-tick';
    f.wakes = [wake('w-ada', 'Ada', [mapped(TICK, 'MAPPED')], proof(['T:1']), [], undefined, line)];
    await go();
    expect(f.sent).toHaveLength(1);
    const rest = f.sent[0].replace(line + ' ', '');
    expect(rest).not.toContain('coordinator-system:tasks:on-base-tick');
    expect(rest).not.toContain('run your base tick');
    expect(rest).toBe(nudgeText(['coordinator-tick'], [], '', new Set(['coordinator-tick'])));
    expect(rest).toContain('hadron team chat read --mentions-me --limit 1');
  });

  for (const action of [null, undefined, { state: 'UNMAPPED' }, { state: 'UNRESOLVED' }, { state: 'WITHHELD' }]) {
    it(`9. a coordinator-tick with action ${JSON.stringify(action)} keeps today's base-tick sentence`, async () => {
      f.wakes = [wake('w-ada', 'Ada', [{ ...TICK, ...(action === undefined ? {} : { action }) }], proof(['T:1']), [], undefined, 'tick coordinator-tick: resolve your task for tick.coordinator yourself')];
      await go();
      expect(f.sent[0]).toContain('run your base tick (coordinator-system:tasks:on-base-tick)');
    });
  }

  const BEL = String.fromCharCode(7); // a real control character, built explicitly so no diff view can show it as text
  for (const [why, tickText] of [['null', null], ['absent', undefined], ['untypeable', `tick coordinator-tick: run x${BEL}y`]] as const) {
    it(`8b. a MAPPED coordinator-tick whose tick line is ${why} keeps the base-tick sentence (the task is named nowhere else)`, async () => {
      f.wakes = [wake('w-ada', 'Ada', [mapped(TICK, 'MAPPED')], proof(['T:1']), [], undefined, tickText)];
      await go();
      expect(f.sent).toHaveLength(1);
      expect(f.sent[0]).toContain('run your base tick (coordinator-system:tasks:on-base-tick)');
    });
  }

  it('9. only the coordinator-tick\'s own state counts: WITHHELD coordinator-tick with a MAPPED team-tick keeps the base-tick sentence', async () => {
    f.wakes = [wake('w-ada', 'Ada', [mapped(TICK, 'WITHHELD'), mapped(TEAM, 'MAPPED')], proof(['T:1', 'V:1']), [], undefined, FORMS[0])];
    await go();
    expect(f.sent[0]).toContain('run your base tick (coordinator-system:tasks:on-base-tick)');
  });

  it('10. coverage keys and the ack proof are identical with and without tickText and action', async () => {
    const p = proof(['T:1', 'V:1'], 'same');
    f.sendReply = () => JSON.stringify(ACCEPTED_ONLY); // accepted but unconfirmed: the receipt (and its coverage) stays on disk
    f.wakes = [wake('w-ada', 'Ada', [TICK, TEAM], p)];
    await go();
    const plain = { coverage: stored()['w-ada'].coverage, acked: [...f.acked] };
    f.sent.length = 0; f.acked.length = 0; rmSync(join(dir, 'ticker-wake'), { recursive: true, force: true });
    f.wakes = [wake('w-ada', 'Ada', [mapped(TICK, 'MAPPED'), mapped(TEAM, 'WITHHELD')], p, [], undefined, FORMS[0])];
    await go();
    expect(f.sent).toHaveLength(1);
    expect({ coverage: stored()['w-ada'].coverage, acked: [...f.acked] }).toEqual(plain);
  });

  it('11. a covered tick T and a new tick U: the header names only U, and the typed line is the server\'s whole line', async () => {
    mkdirSync(join(dir, 'ticker-wake'), { recursive: true });
    writeFileSync(receiptsFile(), JSON.stringify({ 'w-ada': { state: 'sent', coverage: ['T:1'], receiver: 'term_a#inc-1', at: Date.now() - 60_000, text: 'earlier', handle: 'term_a' } }));
    const whole = `${FORMS[0]} · ${FORMS[1]}`;
    f.wakes = [wake('w-ada', 'Ada', [TICK, TICK2], proof(['T:1', 'U:1'], 'c'), [], undefined, whole)];
    await go();
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0].startsWith(whole + ' Hadron ticker wake (eden-queue-tick)')).toBe(true);
  });

  it('puts the tick line before the open-task line\'s host text: line, nudge, then the open-task count', async () => {
    f.wakes = [wake('w-ada', 'Ada', [TEAM], proof(['V:1']), [], undefined, FORMS[0])];
    f.openTasks['w-ada'] = Array.from({ length: 2 }, (_, i) => ({ id: `o${i}`, status: 'STARTED', assignee: { kind: 'WORKER', id: 'w-ada' } }));
    await go();
    expect(f.sent).toEqual([`${FORMS[0]} ${nudgeText(['team-tick'], [], OPEN(2))}`]);
  });

  it('a dry pass never types the line', async () => {
    f.wakes = [wake('w-ada', 'Ada', [TEAM], proof(['V:1']), [], undefined, FORMS[0])];
    await go({ dry: true });
    expect(f.sent).toEqual([]);
  });
});

describe('#2746: a readable per-pass hold reason', () => {
  const holdsFile = () => join(dir, 'ticker-wake', 'holds.log');
  const holds = () => (existsSync(holdsFile()) ? readFileSync(holdsFile(), 'utf8').split('\n').filter(Boolean) : []);
  const TEXT_SENTINEL = 'PRIVATE-TICK-TEXT-SENTINEL-2746a1';
  const PROOF_SENTINEL = 'OPAQUE-PROOF-SENTINEL-2746b2';

  it('a held wake writes one line naming the worker and a closed reason', async () => {
    f.wakes = [wake('w-other', 'Zed', [TICK])];
    await go();
    expect(f.sent).toEqual([]);
    const lines = holds();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\S+ Zed w-other no-receiver-on-host$/);
  });

  it('each hold site maps to its own closed code', async () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], 'opaque')];
    await go();
    expect(holds()[0]).toMatch(/ Ada w-ada proof-coverage-unreadable$/);
    rmSync(holdsFile());
    f.wakes = [wake('w-ada', 'Ada', [TICK, task('t1', 'END_SESSION')], proof(['T:1']))];
    await go();
    expect(holds()[0]).toMatch(/ Ada w-ada carries-other-reasons$/);
  });

  it.each([
    ['left alone (also carries END_SESSION; the proof would record them delivered unseen)', 'carries-other-reasons'],
    ['held (no receiver on this host)', 'no-receiver-on-host'],
    ["held (the proof's tick coverage cannot be read)", 'proof-coverage-unreadable'],
    ['held (the wake carries no server timing)', 'no-server-timing'],
    ['held (another send to this terminal is in flight)', 'terminal-send-in-flight'],
    ['an earlier send is unreconciled for another receiver', 'unreconciled-other-receiver'],
    ['an earlier send is unreconciled', 'unreconciled-earlier-send'],
    ['earlier request still unreconciled (x); no delivery evidence yet (y); needs a person', 'unreconciled-earlier-send'],
    ['our nudge is in the composer', 'stranded-draft'],
    ['held (the uncovered tick work cannot be identified)', 'uncovered-work-unidentified'],
    ['held (the alarm cannot be read)', 'alarm-unreadable'],
    ["held (the alarm's rule is not established)", 'alarm-rule-unestablished'],
    ['held (the alarm was acknowledged)', 'alarm-acknowledged'],
    ["held (the worker's check status cannot be read)", 'check-status-unreadable'],
    ['held (the terminal incarnation changed)', 'terminal-changed'],
    ['held (the old request could not be retained)', 'state-write-failed'],
    ['nudged x but the receipt could not be written', 'state-write-failed'],
    ['send not confirmed', 'send-unconfirmed'],
    ['could not type; will retry', 'send-failed-will-retry'],
    ['nudged x; ack FAILED', 'ack-failed'],
    ['nudged x; acked', 'ok'],
    ['tick line not typeable', 'info'],
    ['held (something new)', 'other'],
    ['a line nobody mapped', 'other'],
  ])('#2746 every log wording maps to its closed code: %s', (body, code) => {
    expect(holdOf(body)).toBe(code);
  });

  it('a delivered wake writes no hold line', async () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1']))];
    await go();
    expect(f.acked).toHaveLength(1);
    expect(holds()).toEqual([]);
  });

  it('an earlier unreconciled send is reported as such, the incident of #2746', async () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1']))];
    f.sendReply = () => JSON.stringify({ ok: true, result: { send: { accepted: false } } });
    await go();
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1'], 'y'))];
    await go();
    expect(holds().some((l) => / Ada w-ada (unreconciled-earlier-send|send-unconfirmed)$/.test(l))).toBe(true);
  });

  it('the file never carries tick text, a proof, or a server message', async () => {
    f.wakes = [wake('w-other', `Zed`, [TICK], `${PROOF_SENTINEL}.sig`, [], undefined, `tick coordinator-tick: ${TEXT_SENTINEL}`)];
    await go();
    f.wakes = [wake('w-ada', 'Ada', [TICK], `${PROOF_SENTINEL}`, [], undefined, `tick coordinator-tick: ${TEXT_SENTINEL}`)];
    await go();
    const text = holds().join('\n');
    expect(text).not.toBe('');
    expect(text).not.toContain(TEXT_SENTINEL);
    expect(text).not.toContain(PROOF_SENTINEL);
  });

  it('a worker name or id outside the plain shape is not written as sent', async () => {
    f.wakes = [wake('w-x y\nFORGED', 'Bad Name\nFORGED 2026 w-ada ok', [TICK])];
    await go();
    const lines = holds();
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('FORGED');
    expect(lines[0].split(' ')).toHaveLength(4);
  });

  it('the file is capped: it keeps only the newest lines', async () => {
    f.wakes = [wake('w-other', 'Zed', [TICK])];
    for (let i = 0; i < 230; i++) await go();
    const lines = holds();
    expect(lines.length).toBe(200);
  });

  it('the file is world-readable, so the orca user can read it', async () => {
    f.wakes = [wake('w-other', 'Zed', [TICK])];
    await go();
    const { statSync } = await import('node:fs');
    expect(statSync(holdsFile()).mode & 0o444).toBe(0o444);
  });

  it('--dry writes no hold file', async () => {
    f.wakes = [wake('w-other', 'Zed', [TICK])];
    await go({ dry: true });
    expect(existsSync(holdsFile())).toBe(false);
  });

  it('a failed ack is reported as ack-failed', async () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1']))];
    f.ackReply = () => ({ errors: [{ message: 'x', extensions: { code: 'WAKE_PROOF_STALE' } }] });
    await go();
    expect(holds()).toHaveLength(1);
    expect(holds()[0]).toMatch(/ Ada w-ada ack-failed$/);
  });

  it('a wake left past the pass budget is reported as pass-budget-spent', async () => {
    f.wakes = [wake('w-ada', 'Ada', [TICK], proof(['T:1']))];
    await pass(cfg(), f.run, { budgetMs: 0 }, (l) => lines.push(l));
    expect(f.sent).toEqual([]);
    expect(holds()[0]).toMatch(/ Ada w-ada pass-budget-spent$/);
  });

  it('--dry writes nothing even when the state directory exists', async () => {
    mkdirSync(join(dir, 'ticker-wake'), { recursive: true });
    f.wakes = [wake('w-other', 'Zed', [TICK])];
    await go({ dry: true });
    expect(existsSync(holdsFile())).toBe(false);
  });

  it('the file is world-readable even under a restrictive umask', async () => {
    const { statSync } = await import('node:fs');
    const old = process.umask(0o077);
    try {
      f.wakes = [wake('w-other', 'Zed', [TICK])];
      await go();
    } finally { process.umask(old); }
    expect(statSync(holdsFile()).mode & 0o777).toBe(0o644);
  });

  it('an unwritable hold file is logged and never fails the pass', async () => {
    mkdirSync(join(dir, 'ticker-wake'), { recursive: true });
    mkdirSync(holdsFile());
    f.wakes = [wake('w-other', 'Zed', [TICK])];
    await go();
    expect(log()).toContain('hold reasons not written');
  });
});
