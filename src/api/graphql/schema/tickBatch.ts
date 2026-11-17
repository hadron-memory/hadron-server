import type { Context } from './resolvers.helpers.js';

/**
 * #3867: one request's field-resolver lookups raised in the current tick, served together. Keyed by the Context OBJECT
 * (a WeakMap, like the relation queues in resolvers.agentTask.ts): a copy made for another caller or transaction never inherits the queue, the
 * queue is removed before its flush starts, and no result is kept, so a later read always reaches the database. A wide
 * `agentTasks` page selects four parties and the open-children test per row; each was one statement per row, which
 * took the whole-App `--team` read to minutes.
 */
export function tickBatch<K, V>(flush: (ctx: Context, keys: K[]) => Promise<Map<K, V>>, missing: V): (ctx: Context, key: K) => Promise<V> {
  type Request = { key: K; settle: (v: V) => void; fail: (e: unknown) => void };
  const queues = new WeakMap<Context, Request[]>();
  return (ctx, key) =>
    new Promise<V>((settle, fail) => {
      let queue = queues.get(ctx);
      if (!queue) {
        const fresh: Request[] = (queue = []);
        queues.set(ctx, fresh);
        queueMicrotask(() => {
          queues.delete(ctx);
          flush(ctx, [...new Set(fresh.map((r) => r.key))]).then(
            (found) => { for (const r of fresh) r.settle(found.has(r.key) ? (found.get(r.key) as V) : missing); },
            (e) => { for (const r of fresh) r.fail(e); },
          );
        });
      }
      queue.push({ key, settle, fail });
    });
}
