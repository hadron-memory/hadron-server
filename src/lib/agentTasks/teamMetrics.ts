/**
 * #4447 (S1 of #3781): the team metrics, computed here and only shown by the clients
 * (hrn:node:hadronmemory.com:specs:cor:agt:150 and its Definitions :01-:05, Proposed). Every count carries the ids behind it.
 *
 * Aggregated in SQL with a FIXED number of statements: nothing here loops over a worker or a task, so the read costs the
 * same for 4 workers and for 400. Each count is exact (`total`); its `ids` are cut at {@link METRICS_IDS_CAP} and
 * `truncated` says so (cor:api:120:04), so a short list never reads as the whole one.
 *
 * Reports 1-3 are snapshots at read time and take no window; only report 4 reads `[since, until)`.
 *
 * Orderings (#4850), so a cut list is always the same prefix: every `ids` list is by creation (`created_at`, then `id`);
 * report 1's owners by task count descending, then owner worker id, then owner user id (NULLs last); an owner's projects by
 * task count descending, then project handle; report 2's projects by project number. A task's `handle` is NOT NULL in the
 * database (prisma/agent-task-number-invariants.sql), so every project segment is a string.
 */
import { Prisma, type PrismaClient } from '../../generated/prisma/index.js';
import { loadTeamRoster } from './roster.js';
import { alarmEpisodeKey, endedAlarmEpisodes } from './stall.js';

type Db = PrismaClient | Prisma.TransactionClient;

import { METRICS_DEFAULT_WINDOW_MS, METRICS_GROUP_CAP, METRICS_IDS_CAP, METRICS_MAX_WINDOW_DAYS, METRICS_MAX_WINDOW_MS } from './teamMetricsCaps.js';
/** Operational dials (Holger, 2026-11-18, R2: A), in one import-free module so the SDL states the same numbers (#4850). */
export { METRICS_DEFAULT_WINDOW_MS, METRICS_GROUP_CAP, METRICS_IDS_CAP, METRICS_MAX_WINDOW_MS } from './teamMetricsCaps.js';

export type MetricsCount = { total: number; ids: string[]; truncated: boolean };
const count = (total: number, ids: string[] | null): MetricsCount => {
  const kept = (ids ?? []).slice(0, METRICS_IDS_CAP);
  return { total, ids: kept, truncated: total > kept.length };
};

export class MetricsWindowError extends Error {}

/**
 * The report-4 window (R1, R2). An omitted `until` is now, an omitted `since` is `until` minus 7 days. Refused, before any
 * read: an unparseable bound, `since` after `until`, a window over 31 days. `since` is included, `until` is not.
 */
export function resolveMetricsWindow(since: unknown, until: unknown, now: Date): { since: Date; until: Date } {
  const parse = (v: unknown, name: string): Date | null => {
    if (v == null) return null;
    const d = v instanceof Date ? v : new Date(String(v));
    if (Number.isNaN(d.getTime())) throw new MetricsWindowError(`${name} is not a valid timestamp.`);
    return d;
  };
  const end = parse(until, 'until') ?? now;
  const start = parse(since, 'since') ?? new Date(end.getTime() - METRICS_DEFAULT_WINDOW_MS);
  if (start.getTime() > end.getTime()) throw new MetricsWindowError('since must not be after until.');
  if (end.getTime() - start.getTime() > METRICS_MAX_WINDOW_MS) throw new MetricsWindowError(`The window must not be longer than ${METRICS_MAX_WINDOW_DAYS} days.`);
  return { since: start, until: end };
}

export type MetricsProjectRef = { handle: string; taskId: string | null; title: string | null; noProject: boolean };
export type MetricsOwnerGroup = {
  workerId: string | null; userId: string | null; tasks: MetricsCount;
  byProject: { project: MetricsProjectRef; tasks: MetricsCount }[]; projectsTruncated: boolean;
};
export type MetricsStartedOwned = { all: MetricsCount; byOwner: MetricsOwnerGroup[]; ownersTruncated: boolean };
export type MetricsProjects = { items: { project: MetricsProjectRef; children: { status: string; tasks: MetricsCount }[] }[]; truncated: boolean };
export type MetricsWorkers = { active: MetricsCount; idle: MetricsCount; overdue: MetricsCount; inop: MetricsCount };
export type MetricsFlow = { completed: MetricsCount; started: MetricsCount };

const STATUSES = ['BACKLOG', 'PENDING', 'STARTED', 'FINISHED', 'CANCELLED'] as const;
const PROJECT_ZERO = 'AT0';

/**
 * Report 1 (cor:agt:150:01): STARTED owned tasks, grouped by the task's OWNER (never its assignee; the owner's role is
 * not consulted) and by project. An owned task names an issue reference or source, so a STARTED task that tracks no
 * external work is not counted. A task's project is the top-level segment of its handle; `AT0` is the visible "No project".
 */
export async function loadStartedOwned(db: Db, appId: string): Promise<MetricsStartedOwned> {
  const owned = Prisma.sql`app_id = ${appId} AND status = 'started' AND (COALESCE(btrim(source), '') <> '' OR external_id IS NOT NULL)`;
  const cap = METRICS_IDS_CAP;
  const [all, owners, cells] = await Promise.all([
    db.$queryRaw<{ total: number; ids: string[] | null }[]>(Prisma.sql`
      SELECT count(*)::int AS total, (array_agg(id ORDER BY created_at, id))[1:${cap}] AS ids FROM agent_tasks WHERE ${owned}`),
    db.$queryRaw<{ workerId: string | null; userId: string | null; total: number; ids: string[] }[]>(Prisma.sql`
      SELECT owner_worker_id AS "workerId", owner_user_id AS "userId", count(*)::int AS total,
             (array_agg(id ORDER BY created_at, id))[1:${cap}] AS ids
      FROM agent_tasks WHERE ${owned} GROUP BY owner_worker_id, owner_user_id
      ORDER BY total DESC, owner_worker_id NULLS LAST, owner_user_id NULLS LAST LIMIT ${METRICS_GROUP_CAP + 1}`),
    db.$queryRaw<{ workerId: string | null; userId: string | null; project: string; total: number; ids: string[] }[]>(Prisma.sql`
      SELECT "workerId", "userId", project, total, ids FROM (
        SELECT owner_worker_id AS "workerId", owner_user_id AS "userId", split_part(handle, '.', 1) AS project, count(*)::int AS total,
               (array_agg(id ORDER BY created_at, id))[1:${cap}] AS ids,
               row_number() OVER (PARTITION BY owner_worker_id, owner_user_id ORDER BY count(*) DESC, split_part(handle, '.', 1)) AS rn
        FROM agent_tasks WHERE ${owned} GROUP BY owner_worker_id, owner_user_id, split_part(handle, '.', 1)
      ) g WHERE rn <= ${METRICS_GROUP_CAP + 1} ORDER BY "workerId" NULLS LAST, "userId" NULLS LAST, rn`),
  ]);
  const shown = owners.slice(0, METRICS_GROUP_CAP);
  const keyOf = (o: { workerId: string | null; userId: string | null }) => `${o.workerId ?? ''}|${o.userId ?? ''}`;
  // #4850: the cells grouped by owner once (they arrive ordered by owner, then rank), so the regroup is linear in the cells.
  const cellsByOwner = new Map<string, typeof cells>();
  for (const c of cells) {
    const k = keyOf(c);
    const list = cellsByOwner.get(k);
    if (list) list.push(c); else cellsByOwner.set(k, [c]);
  }
  const handles = [...new Set(shown.flatMap((o) => (cellsByOwner.get(keyOf(o)) ?? []).map((c) => c.project)))];
  const projectRows = handles.length
    ? await db.agentTask.findMany({ where: { appId, parentTaskId: null, handle: { in: handles } }, select: { id: true, handle: true, title: true } })
    : [];
  const projects = new Map(projectRows.map((p) => [p.handle as string, p]));
  const refOf = (handle: string): MetricsProjectRef => {
    const p = projects.get(handle);
    return { handle, taskId: p?.id ?? null, title: p?.title ?? null, noProject: handle === PROJECT_ZERO };
  };
  return {
    all: count(all[0]?.total ?? 0, all[0]?.ids ?? null),
    ownersTruncated: owners.length > METRICS_GROUP_CAP,
    byOwner: shown.map((o) => {
      const mine = cellsByOwner.get(keyOf(o)) ?? [];
      return {
        workerId: o.workerId, userId: o.userId, tasks: count(o.total, o.ids),
        projectsTruncated: mine.length > METRICS_GROUP_CAP,
        byProject: mine.slice(0, METRICS_GROUP_CAP).map((c) => ({ project: refOf(c.project), tasks: count(c.total, c.ids) })),
      };
    }),
  };
}

/**
 * Report 2: STARTED projects, each with its direct children counted by every status. A project is a top-level task other
 * than AT0 (cor:agt:050:01, :02; R3): no new marker, flag or special treatment.
 */
export async function loadStartedProjects(db: Db, appId: string): Promise<MetricsProjects> {
  const rows = await db.agentTask.findMany({
    where: { appId, parentTaskId: null, status: 'started', taskNumber: { gt: 0 } },
    select: { id: true, handle: true, title: true }, orderBy: [{ taskNumber: 'asc' }], take: METRICS_GROUP_CAP + 1,
  });
  const shown = rows.slice(0, METRICS_GROUP_CAP);
  const children = shown.length
    ? await db.$queryRaw<{ parentId: string; status: string; total: number; ids: string[] }[]>(Prisma.sql`
        SELECT parent_task_id AS "parentId", status, count(*)::int AS total, (array_agg(id ORDER BY created_at, id))[1:${METRICS_IDS_CAP}] AS ids
        FROM agent_tasks WHERE app_id = ${appId} AND parent_task_id = ANY(${shown.map((p) => p.id)}::text[]) GROUP BY parent_task_id, status`)
    : [];
  return {
    truncated: rows.length > METRICS_GROUP_CAP,
    items: shown.map((p) => ({
      project: { handle: p.handle as string, taskId: p.id, title: p.title, noProject: false },
      children: STATUSES.map((status) => {
        const c = children.find((r) => r.parentId === p.id && r.status.toUpperCase() === status);
        return { status, tasks: count(c?.total ?? 0, c?.ids ?? null) };
      }),
    })),
  };
}

/** The stall alarms an overdue worker can hold (cor:agt:150:04; cor:agt:050:14, :15). Owner-unreactive and unassignable are not overdue clauses. */
const OVERDUE_ALARM_TYPES = ['stall.not-started', 'stall.no-progress', 'stall.finish-by'];

/** The workers that are the ASSIGNEE of an open task with a stall alarm in effect: unacknowledged, its episode not ended (cor:agt:050:20). */
async function overdueWorkerIds(db: Db, appId: string, now: Date): Promise<Set<string>> {
  const rows = await db.$queryRaw<{ workerId: string; appId: string; taskId: string; type: string; episodeStart: Date | null }[]>(Prisma.sql`
    SELECT t.assignee_worker_id AS "workerId", e.app_id AS "appId", e.task_id AS "taskId", e.type, e.episode_start AS "episodeStart"
    FROM agent_team_events e JOIN agent_tasks t ON t.id = e.task_id AND t.app_id = e.app_id
    WHERE e.app_id = ${appId} AND e.severity = 'alarm' AND e.acknowledged_at IS NULL
      AND e.type = ANY(${OVERDUE_ALARM_TYPES}::text[])
      AND t.status IN ('pending', 'started') AND t.assignee_worker_id IS NOT NULL`);
  // The roster's own classification of an ended episode: one loader, so the two cannot disagree.
  const ended = await endedAlarmEpisodes(db, rows, now);
  return new Set(rows.filter((r) => !(r.episodeStart && ended.has(alarmEpisodeKey(r.taskId, r.type, r.episodeStart)))).map((r) => r.workerId));
}

/**
 * Report 3 (cor:agt:150:02-:05) over the roster's workers (retired ones left out). `inop` reads the roster-state clause only:
 * the terminal-report clause of :05 has no corpus definition yet and is not invented here.
 */
export async function loadWorkerCounts(db: Db, appId: string, now: Date): Promise<MetricsWorkers> {
  const [entries, overdue] = await Promise.all([loadTeamRoster(db, appId, now), overdueWorkerIds(db, appId, now)]);
  const pick = (f: (e: (typeof entries)[number]) => boolean) => {
    const ids = entries.filter(f).map((e) => e.workerId).sort();
    return count(ids.length, ids);
  };
  return {
    active: pick((e) => e.startedTaskIds.length > 0),
    idle: pick((e) => e.state === 'AVAILABLE' && e.startedTaskIds.length === 0 && e.pendingTaskIds.length === 0),
    overdue: pick((e) => overdue.has(e.workerId)),
    inop: pick((e) => e.state === 'UNAVAILABLE' || e.state === 'NO_FAMILY' || e.state === 'NOT_LAUNCHABLE'),
  };
}

/**
 * Report 4: tasks completed in `[since, until)` by `finishedAt` (status FINISHED only: a cancelled task or a null
 * `finishedAt` never counts) and tasks started in it by `startedAt`.
 */
export async function loadFlow(db: Db, appId: string, since: Date, until: Date): Promise<MetricsFlow> {
  const bound = (field: 'finishedAt' | 'startedAt', extra: Prisma.AgentTaskWhereInput) =>
    ({ appId, ...extra, [field]: { gte: since, lt: until } }) as Prisma.AgentTaskWhereInput;
  const read = async (where: Prisma.AgentTaskWhereInput) => {
    const [total, rows] = await Promise.all([
      db.agentTask.count({ where }),
      db.agentTask.findMany({ where, select: { id: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: METRICS_IDS_CAP }),
    ]);
    return count(total, rows.map((r) => r.id));
  };
  const [completed, started] = await Promise.all([read(bound('finishedAt', { status: 'finished' })), read(bound('startedAt', {}))]);
  return { completed, started };
}
