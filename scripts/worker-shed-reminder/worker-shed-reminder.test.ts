/**
 * #2163 part 2: the UserPromptSubmit reminder hook. Source build only: every path here is a synthetic config root and
 * state dir under a temp directory; no real worker, setting, hook or transcript is read or written.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ESCALATION_TOKENS, FLOOR_TOKENS, FRESHNESS_MS, HYSTERESIS_TOKENS, LOCK_STALE_MS, REMINDER_TEXT, STATE_MAX_FILES, TAIL_BYTES,
  decide, observe, run, scanTail, thresholdFor, withLock,
} from './worker-shed-reminder.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, 'worker-shed-reminder.mjs');
const SID = '3651d53a-2d26-4571-991c-e270bfd3ca7a';
const NOW = Date.parse('2026-10-21T12:00:00.000Z');
const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';
const SECRET = 'SECRET-PLANTED-9f3a7c';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

interface Box { root: string; home: string; config: string; projects: string; stateDir: string; env: Record<string, string>; transcript: string }
function box(over: { configEnv?: boolean } = {}): Box {
  const root = mkdtempSync(join(tmpdir(), 'shed-reminder-'));
  dirs.push(root);
  const home = join(root, 'home'); mkdirSync(home);
  const config = join(root, 'config'); const projects = join(config, 'projects', 'proj'); mkdirSync(projects, { recursive: true });
  const stateDir = join(root, 'state');
  const env: Record<string, string> = { HOME: home, HADRON_SHED_REMINDER_STATE_DIR: stateDir, PATH: process.env.PATH ?? '' };
  if (over.configEnv !== false) env.CLAUDE_CONFIG_DIR = config;
  return { root, home, config, projects, stateDir, env, transcript: join(projects, `${SID}.jsonl`) };
}

const iso = (ms: number) => new Date(ms).toISOString();
const asst = (tokens: number, o: { model?: string; ts?: number; input?: unknown; read?: unknown; create?: unknown; text?: string } = {}) => JSON.stringify({
  type: 'assistant', timestamp: iso(o.ts ?? NOW - 5_000),
  message: { model: 'model' in o ? o.model : OPUS, content: [{ type: 'text', text: o.text ?? 'hello' }],
    usage: { input_tokens: o.input ?? 2, cache_read_input_tokens: o.read ?? tokens - 2, cache_creation_input_tokens: o.create ?? 0, output_tokens: 5 } },
});
const boundary = (uuid: string, post: number, ts = NOW - 2_000) => JSON.stringify({
  type: 'system', subtype: 'compact_boundary', uuid, timestamp: iso(ts), compactMetadata: { trigger: 'manual', preTokens: 300_000, postTokens: post, durationMs: 900 },
});
const write = (b: Box, lines: string[]) => writeFileSync(b.transcript, lines.join('\n') + '\n');
const hook = (over: Record<string, unknown> = {}) => JSON.stringify({
  session_id: SID, hook_event_name: 'UserPromptSubmit', cwd: '/work/demo-wt', ...over,
});
const call = (b: Box, over: Record<string, unknown> = {}, now = NOW) =>
  run(hook({ transcript_path: b.transcript, ...over }), b.env, { now });
/** Occupied tokens that give exactly `reclaimable` after the floor. */
const occ = (reclaimable: number) => reclaimable + FLOOR_TOKENS;
const stateOf = (b: Box) => JSON.parse(readFileSync(join(b.stateDir, 'reminder', `${SID}.json`), 'utf8'));
const logOf = (b: Box) => (existsSync(join(b.stateDir, 'reminder.log')) ? readFileSync(join(b.stateDir, 'reminder.log'), 'utf8') : '');

describe('thresholds and the floor', () => {
  it.each([
    [OPUS, 150_000], [SONNET, 100_000], ['glm-5', 100_000],
  ])('%s: silent just below, fires at and above %i reclaimable', (model, threshold) => {
    const b = box();
    write(b, [asst(occ(threshold - 1), { model })]);
    expect(call(b)).toBeNull();
    rmSync(b.stateDir, { recursive: true, force: true });
    write(b, [asst(occ(threshold), { model })]);
    expect(call(b)).not.toBeNull();
  });

  it('applies the fixed floor: the occupied count minus 67k is what the policy sees', () => {
    expect(FLOOR_TOKENS).toBe(67_000);
    const b = box();
    write(b, [asst(150_000 + FLOOR_TOKENS - 1)]);
    expect(call(b)).toBeNull();
    write(b, [asst(150_000 + FLOOR_TOKENS)]);
    expect(call(b)).not.toBeNull();
  });

  it.each(['claude-haiku-5-5', 'gpt-6', 'claude-fable-5-1', '', null, 7])('an unlisted model (%s) is silent however large', (model) => {
    const b = box();
    write(b, [asst(900_000, { model: model as string })]);
    expect(call(b)).toBeNull();
    expect(thresholdFor(model)).toBeNull();
  });

  it('a count smaller than the floor reclaims nothing and never underflows', () => {
    const d = decide(null, { occupied: 10_000, model: OPUS, boundaryId: null }, NOW);
    expect(d.reclaimable).toBe(0);
    expect(d.fire).toBe(false);
  });
});

describe('exact output', () => {
  it('prints exactly one fixed hookSpecificOutput JSON object and exits 0 (CLI)', () => {
    const b = box();
    write(b, [asst(occ(160_000), { ts: Date.now() - 5_000 })]);
    const r = spawnSync('node', [SCRIPT], { input: hook({ transcript_path: b.transcript }), env: b.env, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(r.stdout);
    expect(parsed).toEqual({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: REMINDER_TEXT(160, 150) } });
    expect(Object.keys(parsed)).toEqual(['hookSpecificOutput']);
    expect(parsed.hookSpecificOutput.additionalContext).toContain('shed procedure');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('reminder');
  });

  it('prints nothing at all when it does not fire (CLI)', () => {
    const b = box();
    write(b, [asst(occ(10_000))]);
    const r = spawnSync('node', [SCRIPT], { input: hook({ transcript_path: b.transcript }), env: b.env, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
  });

  it('garbage, empty and oversize stdin, and other events, are silent exit 0 (CLI)', () => {
    const b = box();
    write(b, [asst(occ(200_000))]);
    for (const input of ['', 'not json', '{"a":', '[]', 'null', hook({ transcript_path: b.transcript, hook_event_name: 'PreCompact' }),
      hook({ transcript_path: b.transcript, hook_event_name: 'PostToolUse' }), 'x'.repeat(200_000)]) {
      const r = spawnSync('node', [SCRIPT], { input, env: b.env, encoding: 'utf8' });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
    }
  });
});

describe('malformed, stale, future and unknown data stay silent', () => {
  const cases: Array<[string, (b: Box) => void]> = [
    ['no assistant line', (b) => write(b, [JSON.stringify({ type: 'user', message: { content: 'hi' } })])],
    ['no usage object', (b) => write(b, [JSON.stringify({ type: 'assistant', timestamp: iso(NOW), message: { model: OPUS } })])],
    ['non-numeric counts', (b) => write(b, [asst(0, { input: '5', read: 'many', create: null })])],
    ['negative counts', (b) => write(b, [asst(0, { input: 2, read: -300_000, create: 0 })])],
    ['fractional counts', (b) => write(b, [asst(0, { input: 2.5, read: 300_000, create: 0 })])],
    ['non-finite counts', (b) => write(b, [JSON.stringify({ type: 'assistant', timestamp: iso(NOW), message: { model: OPUS, usage: { input_tokens: 1e999, cache_read_input_tokens: 1, cache_creation_input_tokens: 1 } } })])],
    ['stale last usage', (b) => write(b, [asst(occ(200_000), { ts: NOW - FRESHNESS_MS - 1_000 })])],
    ['future timestamp', (b) => write(b, [asst(occ(200_000), { ts: NOW + 5 * 60_000 })])],
    ['missing timestamp', (b) => write(b, [JSON.stringify({ type: 'assistant', message: { model: OPUS, usage: { input_tokens: 1, cache_read_input_tokens: occ(200_000), cache_creation_input_tokens: 0 } } })])],
    ['unparseable timestamp', (b) => write(b, [asst(occ(200_000)).replace(/"timestamp":"[^"]+"/, '"timestamp":"not-a-date"')])],
    ['empty file', (b) => writeFileSync(b.transcript, '')],
    ['binary junk', (b) => writeFileSync(b.transcript, Buffer.from([0, 255, 254, 10, 123, 34]))],
  ];
  it.each(cases)('%s', (_n, setup) => {
    const b = box();
    setup(b);
    expect(call(b)).toBeNull();
    // A skip creates no arm.
    expect(existsSync(join(b.stateDir, 'reminder', `${SID}.json`))).toBe(false);
  });

  it('a stale latest line wins over an older fresh one: it is the LATEST usage that counts', () => {
    const b = box();
    write(b, [asst(occ(200_000), { ts: NOW - 60_000 }), asst(occ(5_000), { ts: NOW - FRESHNESS_MS - 5_000 })]);
    expect(call(b)).toBeNull();
  });

  it('a boundary with bad data is silent and does not fall back to an older assistant usage', () => {
    const b = box();
    for (const bad of [boundary('b1', -5), boundary('b1', 1.5), boundary('', occ(200_000)),
      JSON.stringify({ type: 'system', subtype: 'compact_boundary', timestamp: iso(NOW - 2_000), compactMetadata: { postTokens: occ(200_000) } }),
      JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid: 'b1', timestamp: iso(NOW) }),
      boundary('b1', 200_000, NOW - FRESHNESS_MS - 1_000), boundary('b1', 200_000, NOW + 600_000)]) {
      rmSync(b.stateDir, { recursive: true, force: true });
      write(b, [asst(occ(300_000)), bad]);
      expect(call(b)).toBeNull();
    }
  });
});

describe('bounded and partial transcripts', () => {
  it('reads only the tail of a huge file, drops its cut first line, and still finds the last usage', () => {
    const b = box();
    const filler = JSON.stringify({ type: 'user', message: { content: 'x'.repeat(900) } });
    const lines: string[] = [];
    for (let i = 0; i < Math.ceil((TAIL_BYTES * 2) / filler.length); i++) lines.push(filler);
    lines.push(asst(occ(170_000)));
    write(b, lines);
    expect(statSync(b.transcript).size).toBeGreaterThan(TAIL_BYTES * 2);
    expect(call(b)).not.toBeNull();
  });

  it('a truncated final line is ignored and the previous complete usage is used', () => {
    const b = box();
    writeFileSync(b.transcript, asst(occ(170_000)) + '\n' + asst(occ(10_000)).slice(0, 40));
    expect(call(b)).not.toBeNull();
  });

  it('a usage line that sits only before the tail window is not seen (a missing tail is not a new generation)', () => {
    const b = box();
    const filler = JSON.stringify({ type: 'user', message: { content: 'x'.repeat(900) } });
    const lines = [asst(occ(300_000))];
    for (let i = 0; i < Math.ceil((TAIL_BYTES * 2) / filler.length); i++) lines.push(filler);
    write(b, lines);
    expect(call(b)).toBeNull();
    expect(logOf(b)).toContain('skip: no-usage');
  });

  it('scanTail keeps file order and ignores unparseable lines', () => {
    const s = scanTail(['junk', asst(1000), '{"x"', boundary('b1', 500), asst(2000)].join('\n'), true);
    expect(s.assistant?.idx).toBe(4);
    expect(s.boundary?.idx).toBe(3);
  });
});

describe('one arm: threshold fire, one escalation, never a third', () => {
  it('fires once at the threshold, is silent on repeated prompts, escalates once at +50k, then never again', () => {
    const b = box();
    write(b, [asst(occ(150_000))]);
    expect(call(b)).not.toBeNull();
    expect(stateOf(b)).toMatchObject({ fires: 1, atReclaimable: 150_000, firedThreshold: 150_000 });
    for (let i = 0; i < 3; i++) expect(call(b)).toBeNull();
    write(b, [asst(occ(150_000 + ESCALATION_TOKENS - 1))]);
    expect(call(b)).toBeNull();
    write(b, [asst(occ(150_000 + ESCALATION_TOKENS))]);
    expect(call(b)).not.toBeNull();
    expect(stateOf(b)).toMatchObject({ fires: 2 });
    write(b, [asst(occ(150_000 + 4 * ESCALATION_TOKENS))]);
    expect(call(b)).toBeNull();
    expect(call(b)).toBeNull();
    expect(stateOf(b).fires).toBe(2);
  });

  it('a new session_id arms again (a /clear or a shed relaunch)', () => {
    const b = box();
    write(b, [asst(occ(160_000))]);
    expect(call(b)).not.toBeNull();
    const sid2 = '0c1784fa-3702-4644-9fc6-e8993beff1b1';
    const t2 = join(b.projects, `${sid2}.jsonl`);
    writeFileSync(t2, asst(occ(160_000)) + '\n');
    expect(call(b, { session_id: sid2, transcript_path: t2 })).not.toBeNull();
    expect(call(b)).toBeNull();
  });

  it('hysteresis: inside the band nothing resets; a drop of 30k below the threshold re-arms; regrowth fires again', () => {
    const b = box();
    write(b, [asst(occ(155_000))]);
    expect(call(b)).not.toBeNull();
    write(b, [asst(occ(150_000 - HYSTERESIS_TOKENS + 1_000))]);
    expect(call(b)).toBeNull();
    expect(stateOf(b).fires).toBe(1);
    write(b, [asst(occ(155_000))]);
    expect(call(b)).toBeNull();
    write(b, [asst(occ(150_000 - HYSTERESIS_TOKENS - 1_000))]);
    expect(call(b)).toBeNull();
    expect(stateOf(b).fires).toBe(0);
    write(b, [asst(occ(152_000))]);
    expect(call(b)).not.toBeNull();
    expect(stateOf(b).fires).toBe(1);
  });

  it('a model change does not erase the arm: the drop is judged against the threshold the arm fired under', () => {
    const b = box();
    write(b, [asst(occ(105_000), { model: SONNET })]);
    expect(call(b)).not.toBeNull();
    // Same reclaimable under opus (threshold 150k) is far below 150k - 30k, but the arm fired under sonnet's 100k.
    write(b, [asst(occ(105_000), { model: OPUS })]);
    expect(call(b)).toBeNull();
    expect(stateOf(b)).toMatchObject({ fires: 1, firedThreshold: 100_000 });
    write(b, [asst(occ(105_000 + ESCALATION_TOKENS), { model: OPUS })]);
    expect(call(b)).not.toBeNull();
    expect(stateOf(b).fires).toBe(2);
  });
});

describe('compaction boundaries (A0: same id and file, a compact_boundary line appended)', () => {
  it('a newer boundary replaces an older, higher assistant usage: the old usage is never used after it', () => {
    const b = box();
    write(b, [asst(occ(400_000)), boundary('B1', occ(20_000))]);
    expect(call(b)).toBeNull();
    expect(stateOf(b)).toMatchObject({ fires: 0, lastBoundary: 'B1', lastReclaimable: 20_000 });
  });

  it('the boundary estimate is OCCUPIED context: the floor is applied before the policy comparison', () => {
    const b = box();
    write(b, [asst(occ(10_000)), boundary('B1', 150_000)]);
    expect(call(b)).toBeNull();
    write(b, [asst(occ(10_000)), boundary('B2', 150_000 + FLOOR_TOKENS)]);
    expect(call(b)).not.toBeNull();
  });

  it('a boundary resets the arm ONCE: repeated prompts against the same unchanged boundary cannot defeat the max-two rule', () => {
    const b = box();
    write(b, [asst(occ(180_000))]);
    expect(call(b)).not.toBeNull();
    write(b, [asst(occ(180_000)), boundary('B1', occ(180_000))]);
    expect(call(b)).not.toBeNull(); // the boundary reset the arm; the new arm fires once
    for (let i = 0; i < 5; i++) expect(call(b)).toBeNull();
    expect(stateOf(b)).toMatchObject({ fires: 1, lastBoundary: 'B1' });
    // A genuinely later boundary starts a new arm.
    write(b, [asst(occ(180_000)), boundary('B1', occ(180_000)), boundary('B2', occ(190_000))]);
    expect(call(b)).not.toBeNull();
    for (let i = 0; i < 3; i++) expect(call(b)).toBeNull();
  });

  it('once an assistant reply follows the boundary, ordinary usage is judged again with the consumed boundary kept', () => {
    const b = box();
    write(b, [asst(occ(10_000)), boundary('B1', occ(20_000)), asst(occ(30_000))]);
    expect(call(b)).toBeNull();
    write(b, [asst(occ(10_000)), boundary('B1', occ(20_000)), asst(occ(155_000))]);
    expect(call(b)).not.toBeNull();
    expect(stateOf(b)).toMatchObject({ fires: 1 });
  });

  it('no assistant line in the tail with a fresh boundary: the model is unknown, so silent', () => {
    const b = box();
    write(b, [boundary('B1', occ(300_000))]);
    expect(call(b)).toBeNull();
  });

  it('two concurrent callbacks observing one boundary reset and fire exactly once (CLI)', async () => {
    const b = box();
    write(b, [asst(occ(10_000)), boundary('B1', occ(180_000), Date.now() - 1_000)]);
    // The CLI uses the real clock, so build timestamps from it.
    write(b, [asst(occ(10_000), { ts: Date.now() - 3_000 }), boundary('B1', occ(180_000), Date.now() - 1_000)]);
    const outs = await Promise.all(Array.from({ length: 6 }, () => spawnHook(b)));
    expect(outs.filter((o) => o !== '')).toHaveLength(1);
    expect(stateOf(b)).toMatchObject({ fires: 1, lastBoundary: 'B1' });
  });
});

function spawnHook(b: Box, over: Record<string, unknown> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn('node', [SCRIPT], { env: b.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', reject);
    p.on('close', (code) => { code === 0 ? resolve(out) : reject(new Error(`exit ${code}`)); });
    p.stdin.end(hook({ transcript_path: b.transcript, ...over }));
  });
}

describe('concurrent callbacks (CLI, real processes)', () => {
  it('N simultaneous initial callbacks at the threshold emit exactly once', async () => {
    const b = box();
    write(b, [asst(occ(170_000), { ts: Date.now() - 2_000 })]);
    const outs = await Promise.all(Array.from({ length: 8 }, () => spawnHook(b)));
    expect(outs.filter((o) => o !== '')).toHaveLength(1);
    expect(stateOf(b).fires).toBe(1);
  });

  it('N simultaneous callbacks at the escalation crossing emit exactly once, and never a third', async () => {
    const b = box();
    write(b, [asst(occ(170_000), { ts: Date.now() - 2_000 })]);
    expect((await spawnHook(b)) !== '').toBe(true);
    write(b, [asst(occ(170_000 + ESCALATION_TOKENS), { ts: Date.now() - 2_000 })]);
    const outs = await Promise.all(Array.from({ length: 8 }, () => spawnHook(b)));
    expect(outs.filter((o) => o !== '')).toHaveLength(1);
    expect(stateOf(b).fires).toBe(2);
    write(b, [asst(occ(170_000 + 3 * ESCALATION_TOKENS), { ts: Date.now() - 2_000 })]);
    expect((await Promise.all(Array.from({ length: 4 }, () => spawnHook(b)))).filter((o) => o !== '')).toHaveLength(0);
  });
});

describe('untrusted input', () => {
  it.each(['../etc/passwd', 'a/b', 'short', 'x'.repeat(65), 'has space.json', '', '..', 'a'.repeat(8) + '/..', 'id\u0000nul-byte-xx'])(
    'session_id %j is refused before any path is built', (bad) => {
      const b = box();
      write(b, [asst(occ(200_000))]);
      expect(call(b, { session_id: bad })).toBeNull();
      expect(existsSync(b.stateDir) ? readdirSync(b.stateDir).filter((n) => n !== 'reminder.log') : []).toEqual([]);
    });

  it('a session_id that is not a string is refused', () => {
    const b = box();
    write(b, [asst(occ(200_000))]);
    for (const bad of [123, null, ['x'], { a: 1 }]) expect(call(b, { session_id: bad })).toBeNull();
  });

  it('refuses a transcript outside <config>/projects, however it is spelled', () => {
    const b = box();
    const outside = join(b.root, 'elsewhere.jsonl');
    writeFileSync(outside, asst(occ(200_000)) + '\n');
    const link = join(b.projects, 'link.jsonl');
    symlinkSync(outside, link);
    const dirLink = join(b.projects, 'dirlink');
    symlinkSync(b.root, dirLink);
    for (const p of [outside, link, join(b.projects, '..', '..', '..', 'elsewhere.jsonl'), join(dirLink, 'elsewhere.jsonl'), '/etc/passwd',
      join(b.config, 'projects.jsonl'), '', 'relative.jsonl', 'x\u0000y']) {
      expect(call(b, { transcript_path: p })).toBeNull();
    }
    expect(call(b, { transcript_path: 123 })).toBeNull();
  });

  it('uses CLAUDE_CONFIG_DIR when set (this host) and HOME/.claude otherwise', () => {
    const viaEnv = box();
    write(viaEnv, [asst(occ(200_000))]);
    expect(call(viaEnv)).not.toBeNull();
    // With the env var pointing elsewhere, a transcript under HOME/.claude is refused.
    const b = box();
    const homeProjects = join(b.home, '.claude', 'projects', 'p'); mkdirSync(homeProjects, { recursive: true });
    const t = join(homeProjects, `${SID}.jsonl`);
    writeFileSync(t, asst(occ(200_000)) + '\n');
    expect(call(b, { transcript_path: t })).toBeNull();
    // Without the env var, the default root applies.
    const d = box({ configEnv: false });
    const dp = join(d.home, '.claude', 'projects', 'p'); mkdirSync(dp, { recursive: true });
    const dt = join(dp, `${SID}.jsonl`);
    writeFileSync(dt, asst(occ(200_000)) + '\n');
    expect(call(d, { transcript_path: dt })).not.toBeNull();
  });

  it('refuses a file owned by another user, and a directory', () => {
    const b = box();
    write(b, [asst(occ(200_000))]);
    expect(run(hook({ transcript_path: b.transcript }), b.env, { now: NOW, uid: (process.getuid?.() ?? 1000) + 1 })).toBeNull();
    const dirPath = join(b.projects, 'adir.jsonl'); mkdirSync(dirPath);
    expect(call(b, { transcript_path: dirPath })).toBeNull();
  });
});

describe('failure silence', () => {
  it('a state dir that cannot be created is silent, and the hook still exits 0 (CLI)', () => {
    const b = box();
    write(b, [asst(occ(200_000), { ts: Date.now() - 1_000 })]);
    writeFileSync(b.stateDir, 'a file where the directory should be');
    expect(call(b)).toBeNull();
    const r = spawnSync('node', [SCRIPT], { input: hook({ transcript_path: b.transcript }), env: b.env, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('an unwritable state dir is silent: no output when the arm cannot be recorded', () => {
    const b = box();
    write(b, [asst(occ(200_000))]);
    mkdirSync(join(b.stateDir, 'reminder'), { recursive: true });
    chmodSync(join(b.stateDir, 'reminder'), 0o500);
    try {
      if (process.getuid?.() === 0) return; // root ignores modes
      expect(call(b)).toBeNull();
    } finally { chmodSync(join(b.stateDir, 'reminder'), 0o700); }
  });

  it('a held fresh lock makes the hook silent instead of blocking it; a stale lock is taken over', () => {
    const b = box();
    write(b, [asst(occ(200_000))]);
    const lock = join(b.stateDir, 'reminder', `${SID}.lock`);
    mkdirSync(lock, { recursive: true });
    let clock = Date.now();
    const out = run(hook({ transcript_path: b.transcript }), b.env, { now: NOW, nowMs: () => (clock += 700) });
    expect(out).toBeNull();
    expect(logOf(b)).toContain('skip: lock-timeout');
    const old = new Date(Date.now() - LOCK_STALE_MS - 5_000);
    utimesSync(lock, old, old);
    expect(call(b)).not.toBeNull();
    expect(existsSync(lock)).toBe(false);
  });

  it('a corrupt state file is replaced, not trusted and not fatal', () => {
    const b = box();
    write(b, [asst(occ(200_000))]);
    mkdirSync(join(b.stateDir, 'reminder'), { recursive: true });
    for (const junk of ['{"fires":99}', 'nope', '{"fires":"x"}', '[]']) {
      writeFileSync(join(b.stateDir, 'reminder', `${SID}.json`), junk);
      rmSync(join(b.stateDir, 'reminder.log'), { force: true });
      expect(call(b)).not.toBeNull();
    }
  });

  it('an unwritable log is silent', () => {
    const b = box();
    write(b, [asst(occ(200_000))]);
    mkdirSync(b.stateDir, { recursive: true });
    mkdirSync(join(b.stateDir, 'reminder.log'));
    expect(call(b)).not.toBeNull();
  });
});

describe('no leaks, no side effects, bounded state', () => {
  it('never copies transcript text, tool output or usage objects into the output, the log or the state', () => {
    const b = box();
    write(b, [JSON.stringify({ type: 'user', message: { content: `token ${SECRET}` } }),
      JSON.stringify({ type: 'tool_result', content: `output ${SECRET}` }),
      asst(occ(200_000), { text: `reply ${SECRET}` })]);
    const out = call(b);
    expect(out).not.toBeNull();
    const everything = [out!, logOf(b), ...readdirSync(join(b.stateDir, 'reminder')).map((n) => readFileSync(join(b.stateDir, 'reminder', n), 'utf8'))].join('\n');
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain('cache_read_input_tokens');
    expect(everything).not.toContain(b.transcript);
    // The log names the worktree (cwd basename) and a reason code or a count, nothing else.
    expect(logOf(b)).toMatch(/Z demo-wt fire 1 reclaimable=\d+k\n$/);
  });

  it('writes only inside the state dir: the config root and HOME are left byte-identical', () => {
    const b = box();
    write(b, [asst(occ(200_000))]);
    const snap = (d: string): string[] => readdirSync(d, { recursive: true, withFileTypes: true }).map((e) => `${e.parentPath}/${e.name}:${e.isFile() ? statSync(join(e.parentPath, e.name)).size : 'd'}`).sort();
    const before = [snap(b.config), snap(b.home)];
    expect(call(b)).not.toBeNull();
    expect([snap(b.config), snap(b.home)]).toEqual(before);
  });

  it('the cwd basename in the log is sanitised', () => {
    const b = box();
    write(b, [JSON.stringify({ type: 'user', message: { content: 'no usage here' } })]);
    call(b, { cwd: '/x/ev il\nname;rm -rf' });
    expect(logOf(b)).not.toMatch(/[;\n].*rm/);
    expect(logOf(b)).toContain('evilnamerm-rf');
  });

  it('prunes state older than seven days and caps the number of state files', () => {
    const b = box();
    const dir = join(b.stateDir, 'reminder');
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < STATE_MAX_FILES + 25; i++) writeFileSync(join(dir, `old-session-${String(i).padStart(4, '0')}.json`), '{"fires":1}');
    const ancient = new Date(NOW - 8 * 24 * 3_600_000);
    utimesSync(join(dir, 'old-session-0000.json'), ancient, ancient);
    write(b, [asst(occ(200_000))]);
    expect(call(b)).not.toBeNull();
    const left = readdirSync(dir).filter((n) => n.endsWith('.json'));
    expect(left.length).toBeLessThanOrEqual(STATE_MAX_FILES);
    expect(left).not.toContain('old-session-0000.json');
    expect(left).toContain(`${SID}.json`);
  });

  it('caps the log: rotates it once it is over the size limit', () => {
    const b = box();
    mkdirSync(b.stateDir, { recursive: true });
    writeFileSync(join(b.stateDir, 'reminder.log'), 'x'.repeat(300 * 1024));
    write(b, [JSON.stringify({ type: 'user', message: { content: 'no usage here' } })]);
    call(b);
    expect(existsSync(join(b.stateDir, 'reminder.log.1'))).toBe(true);
    expect(statSync(join(b.stateDir, 'reminder.log')).size).toBeLessThan(1024);
  });
});

describe('Juliet, Bindi, Rook (#2231 review): stdin, pruning, write failure, takeover, modes', () => {
  it('stdin that never reaches EOF cannot hold the hook past its watchdog (CLI)', async () => {
    const b = box();
    write(b, [asst(occ(200_000), { ts: Date.now() - 1_000 })]);
    const started = Date.now();
    const p = spawn('node', [SCRIPT], { env: b.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stdin.write('{"session_id":"' + SID + '"'); // a partial document, and the pipe stays open
    const code = await new Promise<number | null>((resolve) => { p.on('close', resolve); setTimeout(() => { p.kill('SIGKILL'); }, 6_000); });
    const elapsed = Date.now() - started;
    expect(code).toBe(0);
    expect(out).toBe('');
    expect(elapsed).toBeLessThan(3_300);
  }, 10_000);

  it('state for many below-threshold sessions stays bounded: the directory is pruned when a session first writes', () => {
    const b = box();
    const dir = join(b.stateDir, 'reminder');
    for (let i = 0; i < STATE_MAX_FILES + 5; i++) {
      const sid = `sess-${String(i).padStart(4, '0')}-aaaa`;
      const t = join(b.projects, `${sid}.jsonl`);
      writeFileSync(t, asst(occ(10_000)) + '\n');
      expect(call(b, { session_id: sid, transcript_path: t })).toBeNull();
      const m = new Date(NOW + i * 1000);
      utimesSync(join(dir, `${sid}.json`), m, m);
    }
    expect(readdirSync(dir).filter((n) => n.endsWith('.json')).length).toBeLessThanOrEqual(STATE_MAX_FILES);
  });

  it('removes leftover temp and dead-lock files from a crashed write or takeover', () => {
    const b = box();
    const dir = join(b.stateDir, 'reminder');
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `${SID}.json.4242.tmp`);
    const dead = join(dir, `${SID}.lock.dead.4242.abc123`);
    writeFileSync(tmp, 'x'); mkdirSync(dead);
    const old = new Date(NOW - 2 * 3_600_000);
    utimesSync(tmp, old, old); utimesSync(dead, old, old);
    write(b, [asst(occ(10_000))]);
    call(b);
    expect(existsSync(tmp)).toBe(false);
    expect(existsSync(dead)).toBe(false);
  });

  it('a state write that fails AFTER the directory is writable prints nothing (write-before-output is pinned)', () => {
    const b = box();
    write(b, [asst(occ(200_000))]);
    const target = join(b.stateDir, 'reminder', `${SID}.json`);
    mkdirSync(join(target, 'blocker'), { recursive: true }); // a non-empty directory where the state file goes: rename fails
    expect(call(b)).toBeNull();
    expect(logOf(b)).toContain('skip: error');
  });

  it('a stale lock is taken over by rename; a live lock that replaced it meanwhile is put back and the body never runs', () => {
    const b = box();
    const dir = join(b.stateDir, 'reminder'); mkdirSync(dir, { recursive: true });
    const lock = join(dir, `${SID}.lock`);
    mkdirSync(lock);
    const old = new Date(Date.now() - LOCK_STALE_MS - 5_000);
    utimesSync(lock, old, old);
    let ran = 0;
    let clock = Date.now();
    const out = withLock(dir, SID, () => { ran++; return 'ran'; }, () => (clock += 400), {
      // Between our look and our takeover, another process replaces the dead lock with a live one.
      beforeTakeover: (l) => { rmSync(l, { recursive: true }); mkdirSync(l); },
    });
    expect(out).toBeUndefined();
    expect(ran).toBe(0);
    expect(existsSync(lock)).toBe(true); // the live lock is still where its holder put it
    expect(readdirSync(dir).filter((n) => n.includes('.dead.'))).toEqual([]);
    // With nothing in the way, a stale lock is taken over and the body runs once.
    rmSync(lock, { recursive: true }); mkdirSync(lock); utimesSync(lock, old, old);
    expect(withLock(dir, SID, () => { ran++; return 'ran'; })).toBe('ran');
    expect(ran).toBe(1);
    expect(existsSync(lock)).toBe(false);
  });

  it('creates the state directory private (0700) and the state file 0600', () => {
    const b = box();
    write(b, [asst(occ(10_000))]);
    call(b);
    expect(statSync(join(b.stateDir, 'reminder')).mode & 0o777).toBe(0o700);
    expect(statSync(join(b.stateDir, 'reminder', `${SID}.json`)).mode & 0o777).toBe(0o600);
  });
});

describe('scope: a reminder and nothing else', () => {
  it('the source performs no process control, terminal input, network, settings write or hadron call', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    for (const banned of ['child_process', 'process.kill', 'spawn(', 'exec(', 'execSync', 'fetch(', 'node:http', 'node:net', 'settings.json',
      'settings.local.json', 'hadron ', 'PostToolUse', 'PreCompact']) {
      // The words may appear in prose comments; none may appear as code. The header names PreCompact and PostToolUse
      // only as things this hook does NOT do.
      const code = src.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
      expect(code, banned).not.toContain(banned);
    }
  });
});

describe('observe and decide stay pure', () => {
  it('observe: a newer boundary beats an older assistant line; an older boundary does not', () => {
    const newer = observe(scanTail([asst(occ(300_000)), boundary('B1', occ(20_000))].join('\n'), true), NOW);
    expect(newer).toMatchObject({ occupied: occ(20_000), boundaryId: 'B1' });
    const older = observe(scanTail([boundary('B1', occ(20_000)), asst(occ(300_000))].join('\n'), true), NOW);
    expect(older).toMatchObject({ occupied: occ(300_000), boundaryId: null });
  });
});
