import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, readFileSync, readdirSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
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

/** True inside a `withFsProjectionRollback` scope. */
export const hasFsProjectionScope = (): boolean => scope.getStore() !== undefined;

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

type Files = { yaml?: string | null; topic?: string | null };

const read = (path: string): string | null => {
  try { return readFileSync(path, 'utf-8'); } catch { return null; } // absent or not a readable file
};

/** The projection files as they are now, taken before the write so a rollback can put them back. */
export const snapshotProjection = (loc: string, graphsPath: string): Files => {
  const nodeDir = join(graphsPath, ...loc.split(':'), '.node');
  return { yaml: read(join(nodeDir, 'node.yaml')), topic: read(join(nodeDir, 'topic.md')) };
};

/**
 * Cleanup for a projection this call wrote. Ownership is by BYTES, per file: a file is
 * touched only while it still holds exactly what this call wrote (a concurrent create
 * that overwrote it, or a file this call never wrote, is left alone), and is then put
 * back to what it held before (deleted if it did not exist).
 */
export const projectionCleanupFor = (
  loc: string,
  graphsPath: string,
  prior: Files,
  written: { yaml?: string; topic?: string },
): (() => void) => () => {
  const nodeDir = join(graphsPath, ...loc.split(':'), '.node');
  const restore = (file: string, wrote: string | undefined, before: string | null | undefined) => {
    if (wrote === undefined) return;
    const path = join(nodeDir, file);
    if (read(path) !== wrote) return;
    if (before == null) rmSync(path, { force: true });
    else writeFileSync(path, before, 'utf-8');
  };
  // node.yaml carries this call's unique node id, so it is the proof of this call's GENERATION: a
  // topic.md can hold bytes identical to a concurrent create's, so it is touched only while the yaml is still ours.
  if (written.yaml === undefined || read(join(nodeDir, 'node.yaml')) !== written.yaml) return;
  restore('node.yaml', written.yaml, prior.yaml);
  restore('topic.md', written.topic, prior.topic);
  // Prune the directories this projection may have created, deepest first,
  // stopping at the first one still holding anything else.
  let current = nodeDir;
  while (current.length > graphsPath.length && current.startsWith(graphsPath)) {
    if (!existsSync(current) || readdirSync(current).length > 0) break;
    rmdirSync(current);
    current = dirname(current);
  }
};
