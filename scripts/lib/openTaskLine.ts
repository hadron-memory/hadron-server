/**
 * #2613 — the one line every wake carries about the receiving worker's open tasks (Holger, via Bo): a worker that
 * was told only to read chat could forget work it already held.
 *
 * Shared by the ticker-wake and attention-router producers so the text and the failure rules cannot drift between
 * them or between host/model-family adapters (an adapter only types what it is handed).
 *
 * The count is the delivered Worker's own assigned tasks in the wake's App, PENDING or STARTED: the same set as
 * `hadron team task mine`. It comes from the existing `agentTasks` read under the script's own credential; no
 * server field is added. Unknown is never zero: a refused, malformed, truncated or over-budget read yields no line
 * at all, so the wake still goes out and never claims "none". Zero also yields no line (quiet). The number is what
 * this read observed at send, not a snapshot atomic with a later `task mine`.
 */
export interface OpenTaskRun { (argv: string[], timeoutMs?: number): { code: number; stdout: string } }

/**
 * The whole count's time budget, across every page (#2613 LOCAL P2-2). Each call is handed only the time left, so a
 * slow gateway cannot stretch a wake by a call timeout per page; a spent budget is unknown, never a partial count.
 * Callers read the count BEFORE their final idle and composer gates, so none of this time sits between the last gate
 * and the send (#2613 LOCAL P2-1).
 */
export const OPEN_TASKS_BUDGET_MS = 5_000;

/** The server's page cap for agentTasks (typeDefs: limit defaults to 20, cap 200). */
export const OPEN_TASKS_PAGE = 200;
/** Per-wake page budget; a worker holding more than this many open tasks reads as unknown, not as a partial count. */
export const OPEN_TASKS_MAX_PAGES = 10;

export const OPEN_TASKS_QUERY =
  'query($a:ID!,$w:String!,$o:Int){agentTasks(appRef:$a,assignee:{worker:$w},status:[PENDING,STARTED],limit:200,offset:$o)'
  + '{id status assignee{kind id}}}';

const OPEN_STATUSES: ReadonlySet<string> = new Set(['PENDING', 'STARTED']);

/** Why a count is unknown: a closed set, so a diagnostic can never carry anything the read returned (#2630). */
export type OpenTaskUnknown = 'refused' | 'malformed' | 'timeout' | 'page_cap';

/**
 * The number of open tasks the worker holds, or null when it cannot be established. Never throws. `onUnknown`, when
 * given, is called ONCE with the closed reason when the answer is null for one of those four causes (an unbound
 * worker or App reads nothing and reports nothing); it is handed nothing the read returned.
 */
export function countOpenTasks(
  run: OpenTaskRun, hadronCli: string, app: string, workerId: string,
  budgetMs: number = OPEN_TASKS_BUDGET_MS, now: () => number = Date.now, until?: number,
  onUnknown?: (reason: OpenTaskUnknown) => void,
): number | null {
  if (!app || !workerId) return null;
  const unknown = (reason: OpenTaskUnknown): null => {
    try { onUnknown?.(reason); } catch { /* a diagnostic never changes the answer */ }
    return null;
  };
  // `until` is the caller's own absolute deadline (the ticker's pass end, on the pass clock): the count never runs past
  // it, so a read cannot start fresh 5 s just before the pass ends (#2613 LOCAL P2, delta).
  const deadline = Math.min(now() + budgetMs, until ?? Infinity);
  const ids = new Set<string>();
  for (let page = 0; page < OPEN_TASKS_MAX_PAGES; page++) {
    const left = deadline - now();
    if (left <= 0) return unknown('timeout');
    let rows: unknown;
    let res: { code: number; stdout: string };
    try {
      res = run([hadronCli, 'api', OPEN_TASKS_QUERY, '-F', `a=${app}`, '-F', `w=${workerId}`, '-F', `o=${page * OPEN_TASKS_PAGE}`], left);
    } catch { return unknown('refused'); }
    // Checked AFTER the call too: a page that answered late is unknown, even a short final one.
    if (now() > deadline) return unknown('timeout');
    if (res.code !== 0) return unknown('refused');
    let body: any;
    try { body = JSON.parse(res.stdout); } catch { return unknown('malformed'); }
    if (body?.errors?.length || body?.error) return unknown('refused');
    rows = body?.data?.agentTasks;
    if (!Array.isArray(rows)) return unknown('malformed');
    for (const r of rows) {
      if (typeof r?.id !== 'string' || !OPEN_STATUSES.has(r.status)) return unknown('malformed');
      // A row that is not this worker's means the filter was not honored: nothing here can be trusted as a count.
      if (r.assignee?.kind !== 'WORKER' || r.assignee?.id !== workerId) return unknown('malformed');
      ids.add(r.id);
    }
    if (rows.length < OPEN_TASKS_PAGE) return ids.size;
  }
  return unknown('page_cap');
}

/** The sentence appended to a wake, with its leading space; '' for zero or unknown. */
export function openTaskLine(
  run: OpenTaskRun, hadronCli: string, app: string, workerId: string,
  budgetMs: number = OPEN_TASKS_BUDGET_MS, now: () => number = Date.now, until?: number,
  onUnknown?: (reason: OpenTaskUnknown) => void,
): string {
  const n = countOpenTasks(run, hadronCli, app, workerId, budgetMs, now, until, onUnknown);
  if (!n) return '';
  return ` You have ${n} open task${n === 1 ? '' : 's'} (as read when this was sent); run \`hadron team task mine\`.`;
}
