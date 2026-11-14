/**
 * #4160 item 2: TEST-ONLY owned-descendant containment for the worker-auto-shed suites. Not imported by any production file.
 *
 * Why: GNU `timeout` puts its child in a NEW process group, so killing a spawned hook's group (the old afterEach) missed
 * a TERM-ignoring step started by a nested `timeout`; if vitest itself died, no afterEach ran at all. Every process a
 * test starts is therefore launched under `setsid` with HARNESS_RUN_ID=<uuid> in its environment, which every
 * descendant inherits whatever its group, and cleanup finds them by that id.
 *
 * Contract (hrn:node:hadronmemory.com:hadron-dev-team-bob:contracts:server-4160-aggregate-deadline, v3.2 R2/R3):
 *  - ONE function, `signalOwned`, is the only path to a signal for a single pid. It re-reads start-time (stat field 22,
 *    parsed from AFTER the last `)`), uid and the exact run id in the same synchronous tick before `kill`.
 *  - The group kill is sent only with a verified live member (the unreaped launcher, or a /proc entry in the group).
 *  - Cleanup: SIGSTOP the launcher, group SIGKILL, launcher SIGKILL + reap, then a bounded environ sweep:
 *    MAX_PASSES 6, 50 ms gaps, 2 s total, stop only after TWO consecutive passes with zero owned and zero unverifiable.
 *  - Unreadable evidence for a pid already seen as owned is `unverifiable`, never zero: it FAILS the cleanup.
 *  - An independent `setsid` POSIX-shell watchdog, given vitest's pid + start-time, sweeps the same way on the earliest of
 *    vitest's death or the harness deadline + 5 s, so it reaches nested groups when no afterEach ever runs.
 * Limits (stated, not claimed away): a descendant that scrubs its environment escapes both the sweep and the watchdog;
 * the watchdog cannot fire if the host reboots or something SIGKILLs it first; a verified non-child that exits and whose
 * pid wraps within the same tick is not excluded; nothing is ever matched by command name.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

export const MAX_PASSES = 6;
export const PASS_GAP_MS = 50;
export const CLEANUP_DEADLINE_MS = 2000;

export interface ProcStat { state: string; ppid: number; pgrp: number; sid: number; start: string }
export type ProcRead<T> = T | 'gone' | 'unreadable';

/** The /proc and kill seam. The real implementation reads /proc; the unit pins inject mocks. */
export interface ProcOps {
  list(): number[];
  stat(pid: number): ProcRead<ProcStat>;
  uid(pid: number): ProcRead<number>;
  environ(pid: number): ProcRead<string>;
  kill(target: number, sig: NodeJS.Signals): void;
}

/** Parses /proc/<pid>/stat from AFTER the last `)`, so a command name containing spaces or parentheses cannot shift fields. */
export function parseStat(text: string): ProcStat | null {
  const i = text.lastIndexOf(')');
  if (i < 0) return null;
  const f = text.slice(i + 1).trim().split(/\s+/);
  // After the comm: state(3) ppid(4) pgrp(5) session(6) ... starttime(22): index n-3.
  if (f.length < 20) return null;
  const [state, ppid, pgrp, sid] = [f[0], Number(f[1]), Number(f[2]), Number(f[3])];
  if (!state || [ppid, pgrp, sid].some((n) => !Number.isInteger(n))) return null;
  return { state, ppid, pgrp, sid, start: f[19] };
}

function readProc<T>(path: string, parse: (s: string) => T | null): ProcRead<T> {
  try {
    const v = parse(readFileSync(path, 'latin1'));
    return v === null ? 'unreadable' : v;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // ENOENT / ESRCH on a /proc entry: the process is gone. EACCES, EIO and the rest are NOT evidence of absence.
    if (code === 'ENOENT' || code === 'ESRCH') return 'gone';
    return existsSync(path.replace(/\/[^/]+$/, '')) ? 'unreadable' : 'gone';
  }
}

export const realOps: ProcOps = {
  list: () => readdirSync('/proc').filter((n) => /^\d+$/.test(n)).map(Number),
  stat: (pid) => readProc(`/proc/${pid}/stat`, parseStat),
  uid: (pid) => readProc(`/proc/${pid}/status`, (t) => { const m = /^Uid:\s+(\d+)/m.exec(t); return m ? Number(m[1]) : null; }),
  environ: (pid) => readProc(`/proc/${pid}/environ`, (t) => t),
  kill: (target, sig) => { try { process.kill(target, sig); } catch { /* gone */ } },
};

export interface LauncherRecord { pid: number; start: string; sid: number; pgid: number }
export interface OwnedRun {
  runId: string;
  uid: number;
  /** vitest's own pid and its ancestors: never signaled. */
  protectedPids: Set<number>;
  launcher: LauncherRecord | null;
  child: Pick<ChildProcess, 'exitCode' | 'signalCode'> | null;
  watchdog: { pid: number; start: string } | null;
  watchdogLog: string | null;
}

export function ancestors(ops: ProcOps = realOps, from = process.pid): Set<number> {
  const out = new Set<number>([from]);
  let p = from;
  for (let i = 0; i < 64; i++) {
    const st = ops.stat(p);
    if (typeof st === 'string' || st.ppid <= 0 || out.has(st.ppid)) break;
    out.add(st.ppid); p = st.ppid;
  }
  return out;
}

const ownsEnv = (run: OwnedRun, env: string): boolean => env.split('\0').includes(`HARNESS_RUN_ID=${run.runId}`);

export type Verdict = 'ok' | 'gone' | 'mismatch' | 'unverifiable';

/** Reads identity now and decides whether `pid` is provably ours. `start` is the start-time first recorded for this pid. */
export function verifyOwned(run: OwnedRun, pid: number, start: string | null, ops: ProcOps): Verdict {
  if (run.protectedPids.has(pid)) return 'mismatch';
  const st = ops.stat(pid);
  if (st === 'gone') return 'gone';
  if (st === 'unreadable') return 'unverifiable';
  if (st.state === 'Z' || st.state === 'X') return 'gone';
  if (start !== null && st.start !== start) return 'mismatch';
  const uid = ops.uid(pid);
  if (uid === 'gone') return 'gone';
  if (uid === 'unreadable') return 'unverifiable';
  if (uid !== run.uid) return 'mismatch';
  const env = ops.environ(pid);
  if (env === 'gone') return 'gone';
  if (env === 'unreadable') return 'unverifiable';
  return ownsEnv(run, env) ? 'ok' : 'mismatch';
}

/** The ONLY path to a signal for a single pid: identity re-read and the kill in the same synchronous tick. */
export function signalOwned(run: OwnedRun, pid: number, sig: NodeJS.Signals, start: string | null, ops: ProcOps): Verdict | 'signaled' {
  const v = verifyOwned(run, pid, start, ops);
  if (v !== 'ok') return v;
  ops.kill(pid, sig);
  return 'signaled';
}

export interface CleanupResult { passes: number; clean: boolean; owned: number; unverifiable: number; groupKills: number; deadlineHit: boolean }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** One sweep pass: signals every provably owned pid, tallies the ones that cannot be proven either way. */
function sweepPass(run: OwnedRun, ops: ProcOps, seen: Map<number, string>, skip: Set<number>): { owned: number; unverifiable: number } {
  let owned = 0;
  let unverifiable = 0;
  for (const pid of ops.list()) {
    if (run.protectedPids.has(pid) || skip.has(pid)) continue;
    const st = ops.stat(pid);
    if (st === 'gone') { seen.delete(pid); continue; }
    if (st === 'unreadable') { if (seen.has(pid)) unverifiable++; continue; }
    if (st.state === 'Z' || st.state === 'X') { seen.delete(pid); continue; }
    const uid = ops.uid(pid);
    if (uid === 'gone') { seen.delete(pid); continue; }
    if (uid === 'unreadable') { if (seen.has(pid)) unverifiable++; continue; }
    if (uid !== run.uid) continue;
    const env = ops.environ(pid);
    if (env === 'gone') { seen.delete(pid); continue; }
    if (env === 'unreadable') {
      // Someone in the launcher's session whose evidence we cannot read, or one we already proved owned: never zero.
      if (seen.has(pid) || (run.launcher && st.sid === run.launcher.sid)) unverifiable++;
      continue;
    }
    if (!ownsEnv(run, env)) continue;
    const start = seen.get(pid) ?? st.start;
    seen.set(pid, start);
    owned++;
    // The start-time first recorded here is re-checked inside signalOwned in the tick of the kill.
    signalOwned(run, pid, 'SIGKILL', start, ops);
  }
  return { owned, unverifiable };
}

async function sweepLoop(run: OwnedRun, ops: ProcOps, seen: Map<number, string>, skip: Set<number>, t0: number, deadlineMs: number, maxPasses: number, gapMs: number): Promise<CleanupResult & { used: number }> {
  let clean = 0;
  let last = { owned: 0, unverifiable: 0 };
  let passes = 0;
  let deadlineHit = false;
  while (passes < maxPasses) {
    if (Date.now() - t0 > deadlineMs) { deadlineHit = true; break; }
    last = sweepPass(run, ops, seen, skip);
    passes++;
    clean = last.owned === 0 && last.unverifiable === 0 ? clean + 1 : 0;
    if (clean >= 2) break;
    await sleep(gapMs);
  }
  return { passes, clean: clean >= 2, owned: last.owned, unverifiable: last.unverifiable, groupKills: 0, deadlineHit, used: passes };
}

/** Group kill needs a VERIFIED live member: the launcher while Node has not reaped it, else a /proc entry in the group. */
function verifiedGroupMember(run: OwnedRun, ops: ProcOps): number | null {
  const l = run.launcher;
  if (!l) return null;
  const unreaped = run.child !== null && run.child.exitCode === null && run.child.signalCode === null;
  const lst = ops.stat(l.pid);
  if (unreaped && typeof lst !== 'string' && lst.sid === l.sid && lst.pgrp === l.pgid && verifyOwned(run, l.pid, l.start, ops) === 'ok') return l.pid;
  for (const pid of ops.list()) {
    const st = ops.stat(pid);
    if (typeof st === 'string' || st.pgrp !== l.pgid) continue;
    if (verifyOwned(run, pid, st.start, ops) === 'ok') return pid;
  }
  return null;
}

export interface CleanupOpts { ops?: ProcOps; maxPasses?: number; deadlineMs?: number; gapMs?: number }

export async function cleanupOwned(run: OwnedRun, o: CleanupOpts = {}): Promise<CleanupResult> {
  const ops = o.ops ?? realOps;
  const [maxPasses, deadlineMs, gapMs] = [o.maxPasses ?? MAX_PASSES, o.deadlineMs ?? CLEANUP_DEADLINE_MS, o.gapMs ?? PASS_GAP_MS];
  const t0 = Date.now();
  const seen = new Map<number, string>();
  let groupKills = 0;
  const l = run.launcher;
  if (l) {
    const member = verifiedGroupMember(run, ops);
    if (member !== null) {
      // Freeze new forks from the launcher, re-verify, then the group, then the launcher itself.
      if (run.child && run.child.exitCode === null && run.child.signalCode === null) signalOwned(run, l.pid, 'SIGSTOP', l.start, ops);
      if (verifiedGroupMember(run, ops) !== null) { ops.kill(-l.pgid, 'SIGKILL'); groupKills++; }
      signalOwned(run, l.pid, 'SIGKILL', l.start, ops);
    }
  }
  const skip = new Set<number>(run.watchdog ? [run.watchdog.pid] : []);
  let r = await sweepLoop(run, ops, seen, skip, t0, deadlineMs, maxPasses, gapMs);
  if (run.watchdog) {
    // The watchdog goes LAST, after its own passes; its transient `sleep` child is caught by the confirming loop.
    signalOwned(run, run.watchdog.pid, 'SIGKILL', run.watchdog.start, ops);
    r = await sweepLoop(run, ops, seen, new Set(), t0, deadlineMs, maxPasses, gapMs);
  }
  return { passes: r.passes, clean: r.clean, owned: r.owned, unverifiable: r.unverifiable, groupKills, deadlineHit: r.deadlineHit };
}

/** The final zero-survivor assertion: counts only, plus the stated limitation for unverifiable evidence. */
export function assertNoSurvivors(r: CleanupResult): void {
  if (r.clean && r.owned === 0 && r.unverifiable === 0) return;
  const limit = r.unverifiable > 0 ? ` limitation: ${r.unverifiable} process(es) could not be verified as owned or gone (unreadable /proc evidence); none were signaled` : '';
  throw new Error(`containment4160: ${r.owned} owned survivor(s), ${r.unverifiable} unverifiable after ${r.passes} pass(es)${r.deadlineHit ? ' (cleanup deadline hit)' : ''}.${limit}`);
}

/** POSIX sh watchdog, no node and no vitest dependency. Args: run-id vitest-pid vitest-start deadline-s logfile. */
export const WATCHDOG_SH = String.raw`
rid=$1; vpid=$2; vst=$3; dl=$4; log=$5; me=$$; uid=$(id -u)
rd() { S=; PP=; ST=; set -- $(sed 's/^.*) //' "/proc/$1/stat" 2>/dev/null); S=$1; PP=$2; ST=\${20}; }
i=0; max=$((dl * 2))
while [ "$i" -lt "$max" ]; do
  rd "$vpid"; [ "$ST" = "$vst" ] && [ -n "$ST" ] || break
  sleep 0.5; i=$((i + 1))
done
clk() { read -r up _ </proc/uptime; up=\${up%.*}\${up#*.}; echo "$up"; }
t0=$(clk); clean=0; pass=0
while [ "$pass" -lt 6 ] && [ "$clean" -lt 2 ]; do
  [ $(( $(clk) - t0 )) -le 200 ] || break
  hit=0; unv=0
  for d in /proc/[0-9]*; do
    p=\${d#/proc/}
    [ "$p" = "$me" ] && continue
    [ "$(stat -c %u "$d" 2>/dev/null)" = "$uid" ] || continue
    rd "$p"; [ "$PP" = "$me" ] && continue; st0=$ST
    case "$S" in Z|X|"") continue;; esac
    env=$(tr '\0' '\n' < "$d/environ" 2>/dev/null) || { unv=$((unv + 1)); continue; }
    printf '%s\n' "$env" | grep -qx "HARNESS_RUN_ID=$rid" || continue
    hit=$((hit + 1))
    rd "$p"; [ "$ST" = "$st0" ] || continue
    env=$(tr '\0' '\n' < "$d/environ" 2>/dev/null) || continue
    printf '%s\n' "$env" | grep -qx "HARNESS_RUN_ID=$rid" && kill -KILL "$p" 2>/dev/null
  done
  if [ "$hit" -eq 0 ] && [ "$unv" -eq 0 ]; then clean=$((clean + 1)); else clean=0; fi
  pass=$((pass + 1)); sleep 0.05
done
echo "watchdog done passes=$pass unverifiable=$unv" >> "$log"
`.replace(/\\\$/g, '$');

/** Starts the independent watchdog for `runId`: it watches (pid, start-time) and sweeps after `waitS` seconds at the latest. */
export function startWatchdog(runId: string, watchPid: number, watchStart: string, waitS: number, logFile: string, ops: ProcOps = realOps): { pid: number; start: string } | null {
  const wd = spawn('setsid', ['sh', '-c', WATCHDOG_SH, 'wd', runId, String(watchPid), watchStart, String(waitS), logFile], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HARNESS_RUN_ID: runId }, stdio: 'ignore',
  });
  wd.unref();
  if (!wd.pid) return null;
  const w = ops.stat(wd.pid);
  return typeof w === 'string' ? null : { pid: wd.pid, start: w.start };
}

/** Creates a run: a fresh id, vitest's identity, and the independent watchdog. Nothing is spawned for the test yet. */
export function newRun(o: { harnessDeadlineS: number; logFile: string; ops?: ProcOps; vitestPid?: number }): OwnedRun {
  const ops = o.ops ?? realOps;
  const runId = randomUUID();
  const vpid = o.vitestPid ?? process.pid;
  const vst = ops.stat(vpid);
  const run: OwnedRun = {
    runId, uid: process.getuid?.() ?? 0, protectedPids: ancestors(ops), launcher: null, child: null, watchdog: null, watchdogLog: o.logFile,
  };
  if (typeof vst !== 'string') run.watchdog = startWatchdog(runId, vpid, vst.start, o.harnessDeadlineS + 5, o.logFile, ops);
  return run;
}

/** Live processes carrying this run's id (zombies excluded): what a survivor check counts. */
export function ownedProcesses(run: OwnedRun, ops: ProcOps = realOps): number[] {
  const out: number[] = [];
  for (const pid of ops.list()) {
    if (run.protectedPids.has(pid)) continue;
    const st = ops.stat(pid);
    if (typeof st === 'string' || st.state === 'Z' || st.state === 'X') continue;
    const env = ops.environ(pid);
    if (typeof env !== 'string' || env === 'gone') continue;
    if (ownsEnv(run, env)) out.push(pid);
  }
  return out;
}

/** Env every process of the run must carry. */
export const ownedEnv = (run: OwnedRun, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({ ...env, HARNESS_RUN_ID: run.runId });

/** Spawns `cmd` under `setsid` (so pid == pgid == sid) and records the launcher. */
export function spawnOwned(run: OwnedRun, cmd: string, args: string[], env: NodeJS.ProcessEnv, stdio: 'pipe' | 'ignore' = 'pipe', ops: ProcOps = realOps): ChildProcess {
  const child = spawn('setsid', [cmd, ...args], { env: ownedEnv(run, env), stdio: stdio === 'pipe' ? ['pipe', 'pipe', 'pipe'] : 'ignore' });
  const st = child.pid ? ops.stat(child.pid) : 'gone';
  if (child.pid && typeof st !== 'string') {
    run.launcher = { pid: child.pid, start: st.start, sid: st.sid, pgid: st.pgrp };
    run.child = child;
  }
  return child;
}
