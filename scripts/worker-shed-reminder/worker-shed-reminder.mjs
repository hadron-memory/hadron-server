#!/usr/bin/env node
/**
 * worker-shed-reminder — a UserPromptSubmit hook that REMINDS a Claude worker to run the shed procedure when its
 * context has grown large (#2163 part 2, source build only).
 *
 * It reminds and nothing else. It sends no terminal input, writes no handoff, stops no process, ends or rebinds no
 * session, touches no settings, and never fires on PostToolUse or PreCompact. The output is exactly one fixed JSON
 * object (hookSpecificOutput.additionalContext) on stdout, or nothing. Any failure at all is silence with exit 0, so a
 * broken reminder can never delay or alter a user prompt or the managed (Orca) hooks.
 *
 * Contract (issue #2163: amended attach 6319545474, escalation 6319741727, A0 6325900381, stamp 6326118406):
 *  - Estimate: the latest request's context, input + cache_read + cache_creation tokens of the last assistant line in
 *    the transcript tail. If a compact_boundary line is NEWER than that line, the estimate is the boundary's
 *    `postTokens` instead (an older assistant usage is never used after a newer boundary). Both are OCCUPIED
 *    context; reclaimable = max(0, occupied - FLOOR_TOKENS), then compared with the model's policy threshold.
 *  - Policy (team shed policy r16): claude-opus >= 150k, claude-sonnet >= 100k, glm >= 100k reclaimable; any other
 *    model is silent. The model is the last assistant line's; a model change does not erase the arm's fire count.
 *  - One arm: the threshold fire, then ONE escalation at +ESCALATION_TOKENS reclaimable, never a third. An arm resets
 *    on a new session_id (a /clear or a shed relaunch), on a compaction boundary NOT YET CONSUMED (identity kept in
 *    the same serialized state, so a boundary resets exactly once), and on a genuine drop of HYSTERESIS_TOKENS below
 *    the threshold. No worktree-wide cooldown.
 *  - Freshness: the source line's timestamp must be within FRESHNESS_MS of now and not in the future.
 *  - Untrusted input: session_id must match ^[A-Za-z0-9-]{8,64}$; transcript_path must resolve (realpath) to a regular
 *    file owned by this user under <CLAUDE_CONFIG_DIR or ~/.claude>/projects; only the last TAIL_BYTES are read; the
 *    emitted text, the log and the state never carry transcript text, tool output, usage objects or credentials.
 *  - One mkdir lock per session serializes BOTH fires and the boundary reset; state is written (atomically) BEFORE
 *    anything is printed, so a crash can cause at most one missed reminder, never a double fire.
 *
 * Limits (observed, not assumed: A0 on Claude Code 2.1.306, print mode): interactive TUI parity, automatic
 * compaction parity and Codex are not established; Codex is unsupported here.
 */
import { createHash } from 'node:crypto';
import {
  closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync,
  statSync, writeFileSync, appendFileSync,
} from 'node:fs';
import { basename, join, sep } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

/** Context occupied by a fresh worker before any work (measured 65.8k-68.4k across four own transcripts). */
export const FLOOR_TOKENS = 67_000;
export const THRESHOLDS = [['claude-opus', 150_000], ['claude-sonnet', 100_000], ['glm', 100_000]];
export const ESCALATION_TOKENS = 50_000;
export const HYSTERESIS_TOKENS = 30_000;
export const MAX_FIRES = 2;
export const FRESHNESS_MS = 15 * 60_000;
export const FUTURE_SKEW_MS = 60_000;
export const TAIL_BYTES = 256 * 1024;
export const STDIN_MAX_BYTES = 64 * 1024;
export const STATE_MAX_AGE_MS = 7 * 24 * 3_600_000;
export const STATE_MAX_FILES = 100;
export const LOG_MAX_BYTES = 256 * 1024;
export const LOCK_WAIT_MS = 2_000;
export const LOCK_STALE_MS = 10_000;
const SESSION_ID = /^[A-Za-z0-9-]{8,64}$/;
const STATE_FILE = /^[A-Za-z0-9-]{8,64}\.json$/;

export const REMINDER_TEXT = (reclaimableK, thresholdK) =>
  `Context reclaimable is about ${reclaimableK}k (approximate; policy ${thresholdK}k for your model). At your next completed-task ` +
  'boundary, run the shed procedure (task trim-context-clear-and-recover). Do not interrupt an irreversible operation; ' +
  'finish or record it first. This is a reminder: nothing is stopped for you.';

export function thresholdFor(model) {
  if (typeof model !== 'string') return null;
  for (const [prefix, t] of THRESHOLDS) if (model.startsWith(prefix)) return t;
  return null;
}

const isCount = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && Number.isInteger(n);
const sha8 = (v) => createHash('sha256').update(String(v)).digest('hex').slice(0, 16);

/**
 * Read the last assistant usage and the last compact boundary out of a transcript TAIL. A first, possibly cut, line is
 * dropped when the read did not start at the file's beginning; unparseable lines are ignored. "Newer" is file order.
 */
export function scanTail(text, startedAtBeginning) {
  const lines = text.split('\n');
  if (!startedAtBeginning) lines.shift();
  let assistant = null;
  let boundary = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw || raw.length > 2_000_000) continue;
    let o;
    try { o = JSON.parse(raw); } catch { continue; }
    if (!o || typeof o !== 'object') continue;
    if (o.type === 'assistant' && o.message && typeof o.message === 'object') {
      const u = o.message.usage;
      if (u && typeof u === 'object') {
        assistant = { idx: i, ts: o.timestamp, model: o.message.model, input: u.input_tokens, read: u.cache_read_input_tokens, create: u.cache_creation_input_tokens };
      }
    } else if (o.type === 'system' && o.subtype === 'compact_boundary') {
      const m = o.compactMetadata;
      boundary = { idx: i, ts: o.timestamp, uuid: o.uuid, postTokens: m && typeof m === 'object' ? m.postTokens : undefined };
    }
  }
  return { assistant, boundary };
}

/** The occupied-context observation this prompt should be judged on, or a silent reason. */
export function observe({ assistant, boundary }, now) {
  const fresh = (ts) => {
    const t = typeof ts === 'string' ? Date.parse(ts) : NaN;
    return Number.isFinite(t) && now - t <= FRESHNESS_MS && t - now <= FUTURE_SKEW_MS;
  };
  const boundaryNewer = boundary && (!assistant || boundary.idx > assistant.idx);
  if (boundaryNewer) {
    if (!isCount(boundary.postTokens) || typeof boundary.uuid !== 'string' || !boundary.uuid || !fresh(boundary.ts)) return { skip: 'bad-boundary' };
    // The model comes from the last assistant line seen; with none in the tail the policy is unknown, so silent.
    if (!assistant || thresholdFor(assistant.model) === null) return { skip: 'unknown-model' };
    return { occupied: boundary.postTokens, model: assistant.model, boundaryId: boundary.uuid };
  }
  if (!assistant) return { skip: 'no-usage' };
  if (![assistant.input, assistant.read, assistant.create].every(isCount)) return { skip: 'bad-usage' };
  if (!fresh(assistant.ts)) return { skip: 'stale' };
  if (thresholdFor(assistant.model) === null) return { skip: 'unknown-model' };
  return { occupied: assistant.input + assistant.read + assistant.create, model: assistant.model, boundaryId: null };
}

/**
 * Pure decision. `state` is the persisted arm (or null); returns the next state and whether to fire. A boundary resets
 * the arm once: its identity is stored, so a later prompt that still sees the same boundary cannot reset again.
 */
export function decide(state, obs, now) {
  const threshold = thresholdFor(obs.model);
  const reclaimable = Math.max(0, obs.occupied - FLOOR_TOKENS);
  const next = { fires: 0, atReclaimable: null, firedThreshold: null, lastBoundary: null, lastReclaimable: reclaimable, updatedAt: now, ...(state ?? {}) };
  if (obs.boundaryId && obs.boundaryId !== next.lastBoundary) {
    next.fires = 0;
    next.atReclaimable = null;
    next.firedThreshold = null;
    next.lastBoundary = obs.boundaryId;
  }
  // A model change must not erase the arm: the drop is judged against the threshold the arm FIRED under.
  const armThreshold = isCount(next.firedThreshold) ? next.firedThreshold : threshold;
  if (next.fires > 0 && reclaimable < armThreshold - HYSTERESIS_TOKENS) {
    next.fires = 0;
    next.atReclaimable = null;
    next.firedThreshold = null;
  }
  let fire = false;
  if (next.fires === 0 && reclaimable >= threshold) {
    fire = true; next.fires = 1; next.atReclaimable = reclaimable; next.firedThreshold = threshold;
  } else if (next.fires === 1 && next.fires < MAX_FIRES && next.atReclaimable !== null && reclaimable >= next.atReclaimable + ESCALATION_TOKENS) {
    fire = true; next.fires = 2; next.atReclaimable = reclaimable;
  }
  next.lastReclaimable = reclaimable;
  next.updatedAt = now;
  return { next, fire, reclaimable, threshold };
}

function readStdinSync(fd = 0) {
  const chunks = [];
  let total = 0;
  const buf = Buffer.alloc(8192);
  for (;;) {
    let n;
    try { n = readSync(fd, buf, 0, buf.length, null); } catch (e) { if (e && e.code === 'EAGAIN') continue; if (e && e.code === 'EOF') break; throw e; }
    if (n === 0) break;
    total += n;
    if (total > STDIN_MAX_BYTES) return null;
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function readTail(path) {
  const fd = openSync(path, 'r');
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size === 0) return null;
    const len = Math.min(st.size, TAIL_BYTES);
    const start = st.size - len;
    const buf = Buffer.alloc(len);
    let off = 0;
    while (off < len) {
      const n = readSync(fd, buf, off, len - off, start + off);
      if (n === 0) break;
      off += n;
    }
    return { text: buf.subarray(0, off).toString('utf8'), startedAtBeginning: start === 0 };
  } finally { closeSync(fd); }
}

/** Resolve and vet the transcript path; null for anything that is not a regular, own-user file under <config>/projects. */
export function vetTranscript(transcriptPath, env, uid) {
  if (typeof transcriptPath !== 'string' || transcriptPath.length === 0 || transcriptPath.length > 4096 || transcriptPath.includes('\0')) return null;
  const home = env.HOME || homedir();
  const configRoot = env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR.trim() ? env.CLAUDE_CONFIG_DIR : join(home, '.claude');
  let projects, real;
  try { projects = realpathSync(join(configRoot, 'projects')); real = realpathSync(transcriptPath); } catch { return null; }
  if (!real.startsWith(projects + sep)) return null;
  const st = statSync(real);
  if (!st.isFile() || (typeof uid === 'number' && st.uid !== uid)) return null;
  return real;
}

function withLock(dir, sid, fn, nowMs = () => Date.now()) {
  const lock = join(dir, `${sid}.lock`);
  const deadline = nowMs() + LOCK_WAIT_MS;
  for (;;) {
    try { mkdirSync(lock); break; } catch (e) {
      if (!e || e.code !== 'EEXIST') return undefined;
      try {
        if (nowMs() - statSync(lock).mtimeMs > LOCK_STALE_MS) { rmdirSync(lock); continue; }
      } catch { /* the holder released it between the two calls */ }
      if (nowMs() >= deadline) return undefined;
      const until = Date.now() + 20;
      while (Date.now() < until) { /* short bounded spin: the lock is held for milliseconds */ }
    }
  }
  try { return fn(); } finally { try { rmdirSync(lock); } catch { /* already gone */ } }
}

function prune(dir, now) {
  let names;
  try { names = readdirSync(dir).filter((n) => STATE_FILE.test(n)); } catch { return; }
  const rows = [];
  for (const n of names) {
    try { rows.push([n, statSync(join(dir, n)).mtimeMs]); } catch { /* raced */ }
  }
  rows.sort((a, b) => b[1] - a[1]);
  rows.forEach(([n, m], i) => {
    if (i >= STATE_MAX_FILES || now - m > STATE_MAX_AGE_MS) { try { rmSync(join(dir, n), { force: true }); } catch { /* best effort */ } }
  });
}

function logLine(stateRoot, name, text, now) {
  try {
    mkdirSync(stateRoot, { recursive: true });
    const file = join(stateRoot, 'reminder.log');
    try { if (statSync(file).size > LOG_MAX_BYTES) renameSync(file, `${file}.1`); } catch { /* none yet */ }
    appendFileSync(file, `${new Date(now).toISOString()} ${name} ${text}\n`);
  } catch { /* logging never matters */ }
}

/**
 * Run once. Returns the JSON string to print, or null for silence. Never throws.
 * `opts.now` (ms) and `opts.uid` exist for tests; the CLI passes the real clock and uid.
 */
export function run(stdinText, env, opts = {}) {
  const now = opts.now ?? Date.now();
  const uid = opts.uid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined);
  const stateRoot = env.HADRON_SHED_REMINDER_STATE_DIR || join(env.HOME || homedir(), '.local', 'state', 'hadron-worker-shed');
  let name = 'unknown';
  try {
    if (typeof stdinText !== 'string') return null;
    let input;
    try { input = JSON.parse(stdinText); } catch { return null; }
    if (!input || typeof input !== 'object' || input.hook_event_name !== 'UserPromptSubmit') return null;
    if (typeof input.cwd === 'string') { const b = basename(input.cwd).replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64); if (b) name = b; }
    const sid = input.session_id;
    if (typeof sid !== 'string' || !SESSION_ID.test(sid)) { logLine(stateRoot, name, 'skip: bad-session-id', now); return null; }
    const transcript = vetTranscript(input.transcript_path, env, uid);
    if (!transcript) { logLine(stateRoot, name, 'skip: bad-transcript-path', now); return null; }
    const tail = readTail(transcript);
    if (!tail) { logLine(stateRoot, name, 'skip: empty-transcript', now); return null; }
    const obs = observe(scanTail(tail.text, tail.startedAtBeginning), now);
    if (obs.skip) { logLine(stateRoot, name, `skip: ${obs.skip}`, now); return null; }

    const dir = join(stateRoot, 'reminder');
    mkdirSync(dir, { recursive: true });
    const out = withLock(dir, sid, () => {
      const file = join(dir, `${sid}.json`);
      let state = null;
      try { state = JSON.parse(readFileSync(file, 'utf8')); } catch { state = null; }
      if (state && (typeof state !== 'object' || !isCount(state.fires) || state.fires > MAX_FIRES)) state = null;
      const d = decide(state, obs, now);
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(d.next), { mode: 0o600 });
      renameSync(tmp, file);
      if (!d.fire) return null;
      prune(dir, now);
      logLine(stateRoot, name, `fire ${d.next.fires} reclaimable=${Math.round(d.reclaimable / 1000)}k`, now);
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: REMINDER_TEXT(Math.round(d.reclaimable / 1000), Math.round(d.threshold / 1000)),
        },
      });
    }, opts.nowMs);
    if (out === undefined) { logLine(stateRoot, name, 'skip: lock-timeout', now); return null; }
    return out;
  } catch {
    logLine(stateRoot, name, 'skip: error', now);
    return null;
  }
}

function main() {
  // A watchdog: whatever happens, the hook ends well inside its own timeout.
  const watchdog = setTimeout(() => process.exit(0), 2_500);
  watchdog.unref();
  let text = null;
  try { text = readStdinSync(); } catch { text = null; }
  const out = text === null ? null : run(text, process.env);
  if (out) process.stdout.write(out + '\n');
  process.exit(0);
}

const invokedDirectly = (() => {
  try { return process.argv[1] !== undefined && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url; } catch { return false; }
})();
if (invokedDirectly) main();
