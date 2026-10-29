import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, readdirSync, rmSync, rmdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * #2731 — the filesystem projection of a node is written BEFORE its database
 * row (so an fs failure leaves no row, the #2728 mirror). The write is not part
 * of any database transaction, so a rollback or a failed insert would leave an
 * orphan `<GRAPHS_PATH>/<loc>/.node/node.yaml` with no row. A projection this
 * call created registers a cleanup; the database failure runs it.
 *
 * A caller-supplied transaction outlives `createNode`, so its creating resolver
 * wraps the whole transaction in `withFsProjectionRollback`: the cleanups run
 * only when the wrapped work throws (every retry attempt's cleanup included),
 * and are dropped when it succeeds.
 */
const scope = new AsyncLocalStorage<Array<() => void>>();

/** Run `fn`; if it throws, undo every projection `createNode` registered inside it, then rethrow. */
export const withFsProjectionRollback = async <T>(fn: () => Promise<T>): Promise<T> => {
  const cleanups: Array<() => void> = [];
  try {
    return await scope.run(cleanups, fn);
  } catch (err) {
    runCleanups(cleanups);
    throw err;
  }
};

/** Register a cleanup with the enclosing scope; false when there is none. */
export const registerFsProjectionCleanup = (cleanup: () => void): boolean => {
  const cleanups = scope.getStore();
  if (!cleanups) return false;
  cleanups.push(cleanup);
  return true;
};

export const runCleanups = (cleanups: Array<() => void>): void => {
  for (const cleanup of cleanups.reverse()) {
    try { cleanup(); } catch { /* best effort: the row is gone either way, an orphan file is only disk */ }
  }
};

/**
 * Cleanup for a projection this call created. Returns null when the node's
 * `node.yaml` already existed (an overwrite of an earlier projection is not
 * ours to delete).
 */
export const projectionCleanupFor = (loc: string, graphsPath: string): (() => void) | null => {
  const parts = loc.split(':');
  const dir = join(graphsPath, ...parts);
  if (existsSync(join(dir, '.node', 'node.yaml'))) return null;
  return () => {
    rmSync(join(dir, '.node', 'node.yaml'), { force: true });
    rmSync(join(dir, '.node', 'topic.md'), { force: true });
    // Prune the directories this projection may have created, deepest first,
    // stopping at the first one still holding anything else.
    let current = join(dir, '.node');
    while (current.length > graphsPath.length && current.startsWith(graphsPath)) {
      if (!existsSync(current) || readdirSync(current).length > 0) break;
      rmdirSync(current);
      current = dirname(current);
    }
  };
};
