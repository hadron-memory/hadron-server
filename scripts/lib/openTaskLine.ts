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
export interface OpenTaskRun { (argv: string[]): { code: number; stdout: string } }

/** The server's page cap for agentTasks (typeDefs: limit defaults to 20, cap 200). */
export const OPEN_TASKS_PAGE = 200;
/** Per-wake page budget; a worker holding more than this many open tasks reads as unknown, not as a partial count. */
export const OPEN_TASKS_MAX_PAGES = 10;

export const OPEN_TASKS_QUERY =
  'query($a:ID!,$w:String!,$o:Int){agentTasks(appRef:$a,assignee:{worker:$w},status:[PENDING,STARTED],limit:200,offset:$o)'
  + '{id status assignee{kind id}}}';

const OPEN_STATUSES: ReadonlySet<string> = new Set(['PENDING', 'STARTED']);

/** The number of open tasks the worker holds, or null when it cannot be established. Never throws. */
export function countOpenTasks(run: OpenTaskRun, hadronCli: string, app: string, workerId: string): number | null {
  if (!app || !workerId) return null;
  const ids = new Set<string>();
  for (let page = 0; page < OPEN_TASKS_MAX_PAGES; page++) {
    let rows: unknown;
    try {
      const res = run([hadronCli, 'api', OPEN_TASKS_QUERY, '-F', `a=${app}`, '-F', `w=${workerId}`, '-F', `o=${page * OPEN_TASKS_PAGE}`]);
      if (res.code !== 0) return null;
      const body = JSON.parse(res.stdout);
      if (body?.errors?.length || body?.error) return null;
      rows = body?.data?.agentTasks;
    } catch { return null; }
    if (!Array.isArray(rows)) return null;
    for (const r of rows) {
      if (typeof r?.id !== 'string' || !OPEN_STATUSES.has(r.status)) return null;
      // A row that is not this worker's means the filter was not honored: nothing here can be trusted as a count.
      if (r.assignee?.kind !== 'WORKER' || r.assignee?.id !== workerId) return null;
      ids.add(r.id);
    }
    if (rows.length < OPEN_TASKS_PAGE) return ids.size;
  }
  return null;
}

/** The sentence appended to a wake, with its leading space; '' for zero or unknown. */
export function openTaskLine(run: OpenTaskRun, hadronCli: string, app: string, workerId: string): string {
  const n = countOpenTasks(run, hadronCli, app, workerId);
  if (!n) return '';
  return ` You have ${n} open task${n === 1 ? '' : 's'} (as read when this was sent); run \`hadron team task mine\`.`;
}
