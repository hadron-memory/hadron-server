/**
 * The graph-fixture root for a test run (#1951).
 *
 * `createNode` writes every node it creates to disk under `GRAPHS_PATH`
 * (`saveNodeToFs`), so a suite leaves a directory per memory it touches. Tests
 * used to pin `GRAPHS_PATH` to ONE shared `/tmp/hadron-test-graphs` and nothing
 * ever removed what landed there: ~100K directories in nine days exhausted
 * /tmp's inodes on the shared host, and every worker's suite failed with ENOSPC.
 *
 * Each run now gets `<tmpdir>/hadron-test-graph-runs/r<scope>_p<pid>`, where the run id
 * includes verified boot/PID-namespace scope and the bare main PID (#1137). globalSetup
 * creates it, `graphRootSetup.ts` points every worker at it, and globalSetup's
 * teardown removes it — the same lifecycle as the per-worker DB clones.
 *
 * The pid is in the ROOT's name on purpose. The directories under it carry
 * names like `sp-mem-<ms>-<n>`, but `<n>` is `Math.random()`, not a pid, so
 * nothing about them proves which run owns them; the root's name does.
 *
 * Nothing here is a shared fixture. No test reads a pre-existing graph from
 * `GRAPHS_PATH`: the tests that need a graph root mock `GRAPHS_PATH` to their
 * own `mkdtemp` directory. The ~10K "named" directories in the old root (e.g.
 * `alpha`) were only the first loc segment of nodes some test created, so they
 * ride the per-run root like everything else.
 */
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isOwnedRunDead, runToken, testRunScope } from './dbWorkers.js';

/** The directory holding every run's root. */
export function graphRunsParent(): string {
  return join(tmpdir(), 'hadron-test-graph-runs');
}

/** This run's graph root. */
export function runGraphRoot(runId: string, parent = graphRunsParent()): string {
  return join(parent, `r${runToken(runId)}`);
}

/** The run id a root directory's name belongs to, or null when it is not a run root. */
export function parseRunGraphRootName(name: string): string | null {
  const m = /^r([lnu][0-9a-f]{20}_p[1-9][0-9]*)$/.exec(name);
  return m ? m[1] : null;
}

/**
 * Remove roots whose run is provably dead, then create this run's own.
 *
 * Ownership is decided by the full scope and same-scope PID liveness — never by age,
 * since a long suite's root is old and alive. A root this cannot prove dead is
 * left alone; a pid the OS reused leaves one orphan for a later run.
 *
 * Our OWN name, left by a crashed run whose pid we now hold, is removed first,
 * so this run never starts on another run's files.
 *
 * Best-effort for the orphans: one we fail to remove costs disk, not a result.
 */
export function prepareRunGraphRoot(runId: string, parent = graphRunsParent()): string {
  const root = runGraphRoot(runId, parent);
  rmSync(root, { recursive: true, force: true });
  sweepOrphanGraphRoots(runId, parent);
  mkdirSync(root, { recursive: true });
  return root;
}

/** Remove every run root under `parent` whose run is dead, except `runId`'s own. Returns what was removed. */
export function sweepOrphanGraphRoots(runId: string, parent = graphRunsParent()): string[] {
  let names: string[];
  try {
    names = readdirSync(parent);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    const owner = parseRunGraphRootName(name);
    if (owner === null || owner === runToken(runId)) continue;
    const [scope, pid] = owner.split('_p');
    if (!isOwnedRunDead(scope!, pid!, testRunScope())) continue;
    try {
      rmSync(join(parent, name), { recursive: true, force: true });
      removed.push(name);
    } catch {
      // Best-effort: the next run collects it.
    }
  }
  return removed;
}

/**
 * Teardown: remove this run's root, and fail the run if it is still there.
 *
 * Failing loud is the guard (#1951): a run that leaves its root behind is the
 * leak this exists to stop, and a swallowed failure is how it went unnoticed.
 */
export function removeRunGraphRoot(runId: string, parent = graphRunsParent()): void {
  const root = runGraphRoot(runId, parent);
  rmSync(root, { recursive: true, force: true });
  if (existsSync(root)) {
    throw new Error(`#1951: the test run left its graph-fixture root behind: ${root}`);
  }
}
