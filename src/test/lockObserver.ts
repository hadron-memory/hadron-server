/**
 * #3748: the lock observer and the one deadline shared by the #3737 lock-order pins
 * (`src/lib/signing/ceremonyLockOrder3737.test.ts`, `src/api/signingCeremonyLockOrder3737.test.ts`).
 *
 * Two hardenings over the helpers those files used to carry inline:
 *
 * - **Scope.** `waitBlocked` used to return ANY backend in the database waiting on ANY lock, so on a shared database
 *   (or when one of the test's own earlier statements was briefly waiting) it could hand back the wrong waiter. It
 *   flaked that way in CI on #4536 and #4177 (it returned a pre-read, not the anchor wait). It now matches only a
 *   backend whose current statement matches `query` AND whose `pg_blocking_pids` includes one of `blockedBy`: the
 *   gate connection the test holds, or the earlier waiter it queued behind.
 * - **One deadline.** Each pin builds a single `Deadline` and passes it to every bounded wait and to the final join of
 *   its racing promises, so a participant that hangs surfaces as a named message from that one deadline, never as
 *   vitest's generic test timeout.
 */
import type { Client } from 'pg';

export interface Deadline {
  /** The total budget, for the message. */
  readonly ms: number;
  /** Milliseconds left; never negative. */
  left(): number;
}

export function deadline(ms: number): Deadline {
  const at = Date.now() + ms;
  return { ms, left: () => Math.max(0, at - Date.now()) };
}

/**
 * Await `p` within what is left of `dl`. If it has not settled by then, reject with
 * `"<label> did not settle within <dl.ms> ms"`. Pass the JOIN of the racing promises (e.g. `Promise.all([c, p])`),
 * so a hang in either one is reported by this one deadline.
 */
export async function within<T>(dl: Deadline, label: string, p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not settle within ${dl.ms} ms`)), dl.left());
  });
  try {
    return await Promise.race([p, expired]);
  } finally {
    clearTimeout(timer);
  }
}

export interface Waiting { pid: number; query: string; blockers: number[] }

/** The backend pid of a connected `pg` client. */
export async function backendPid(c: Client): Promise<number> {
  return Number((await c.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid);
}

/**
 * Bounded poll, on `observer`, for the ONE expected waiter: a backend in this database waiting on a lock, whose current
 * statement matches `expect.query` and which is blocked by at least one of `expect.blockedBy`. Any other waiter, an
 * unrelated backend or one of the test's own statements waiting on something else, never satisfies it. Throws
 * `"no backend matching <query> blocked by [<pids>] within <dl.ms> ms"` when `dl` runs out.
 */
export async function waitBlocked(
  observer: Client, dl: Deadline, expect: { query: RegExp; blockedBy: number[] },
): Promise<Waiting> {
  for (;;) {
    await observer.query('SELECT pg_stat_clear_snapshot()');
    const r = await observer.query<{ pid: number; query: string; blockers: number[] }>(
      `SELECT pid, query, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'`);
    const hit = r.rows.find((x) => expect.query.test(x.query) && x.blockers.some((b) => expect.blockedBy.includes(b)));
    if (hit) return hit;
    if (dl.left() === 0) {
      throw new Error(`no backend matching ${expect.query} blocked by [${expect.blockedBy.join(', ')}] within ${dl.ms} ms`);
    }
    await new Promise((res) => setTimeout(res, Math.min(25, dl.left())));
  }
}
