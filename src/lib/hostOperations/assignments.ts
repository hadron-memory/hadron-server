/**
 * #4222 (S1a of #4229) — the workers the platform says a host runs (cor:agt:070:01; the change, "the platform states
 * what a host runs and the host confirms", is drafted as Proposed in #4226).
 *
 * An assignment names a worker, a host of its App, the working directory the worker runs in there, the model family
 * and, optionally, the model. Every field a host acts on is a NAME TOKEN the host resolves through its own
 * configuration (an Orca worktree name, or a plain directory name for a worker without Git): never a path, a command
 * or a credential (cor:agt:070:03; decision G1 of the Team on Orca queue). The database holds the same shapes
 * (prisma/host-assignment-invariants.sql).
 *
 * THE SWITCH. An App's `hostSetupSource` is `host` (the default) or `server`. While it is `host` the assignments are
 * only a record: registration, matching and starts behave exactly as before. Once it is `server`:
 *  - `registerHost` accepts only the workers assigned to that host and reports the rest per row;
 *  - a worker is launchable through a host only while it is assigned there, the host's live registration lists it,
 *    and that registration lists the assigned workdir (the host's confirmation that it exists: cor:agt:070:06, :08
 *    are unchanged, nothing here creates a directory);
 *  - a start names the assignment's workdir and family, whatever the host stated.
 * An assignment of a retired worker is not in effect anywhere.
 *
 * THE LOCK. Every writer of an assignment or of the switch holds the App's host-setup lock EXCLUSIVE; a registration
 * and a start's host decision hold it SHARED through their own write, so a start is never issued from an assignment
 * removed while it was being decided. It is taken AFTER the worker rows a transaction locks (a start locks its
 * worker first, registerHost the workers it lists) and is never upgraded.
 */

import { Prisma, type PrismaClient } from '../../generated/prisma/index.js';
import { normalizeFamily } from '../agentTasks/family.js';
import { HOST_ID_PATTERN, isHostToken } from './types.js';

type Db = PrismaClient | Prisma.TransactionClient;

/** Who states which workers a host runs (the App's switch). */
export const HOST_SETUP_SOURCES = ['host', 'server'] as const;
export type HostSetupSource = (typeof HOST_SETUP_SOURCES)[number];
export const isHostSetupSource = (v: unknown): v is HostSetupSource =>
  typeof v === 'string' && (HOST_SETUP_SOURCES as readonly string[]).includes(v);

/** The per-row refusal a checked registration reports for a worker the platform did not assign to that host. */
export const HOST_WORKER_NOT_ASSIGNED = 'HOST_WORKER_NOT_ASSIGNED';

/** A model family token, as a host operation carries it. */
const FAMILY = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** A model is a name token of at most this many characters. */
export const HOST_ASSIGNMENT_MODEL_MAX = 128;

/** An assignment refused by its shape; nothing was written. */
export class HostAssignmentArgsError extends Error {
  readonly code = 'BAD_HOST_ASSIGNMENT_ARGS';
  constructor(message: string) {
    super(message);
    this.name = 'HostAssignmentArgsError';
  }
}

const TOKEN_RULE = 'a name token (letters, digits and . _ / @ + -, starting with a letter or digit, no "..", "//" or trailing "/")';

/**
 * Validate an assignment's fields, returning them exactly as they will be stored. Throws
 * {@link HostAssignmentArgsError}: the refusal depends only on the caller's own input.
 */
export function validateHostAssignment(input: { hostId: unknown; workdir: unknown; family: unknown; model?: unknown }): {
  hostId: string; workdir: string; family: string; model: string | null;
} {
  const hostId = typeof input.hostId === 'string' ? input.hostId.trim() : '';
  if (!HOST_ID_PATTERN.test(hostId)) {
    throw new HostAssignmentArgsError('hostId is a host token: letters, digits, ".", "_", ":" or "-", up to 128 characters.');
  }
  if (!isHostToken(input.workdir)) {
    throw new HostAssignmentArgsError(`workdir is ${TOKEN_RULE}: the name the host knows the working directory by, never a path.`);
  }
  const family = typeof input.family === 'string' ? normalizeFamily(input.family) : null;
  if (!family || !FAMILY.test(family)) throw new HostAssignmentArgsError('family is a lowercase model family token, e.g. claude or codex.');
  let model: string | null = null;
  if (input.model !== null && input.model !== undefined) {
    if (!isHostToken(input.model) || input.model.length > HOST_ASSIGNMENT_MODEL_MAX) {
      throw new HostAssignmentArgsError(`model is ${TOKEN_RULE}, at most ${HOST_ASSIGNMENT_MODEL_MAX} characters.`);
    }
    model = input.model;
  }
  return { hostId, workdir: input.workdir, family, model };
}

/** Is `v` a host id an assignment read may filter by? */
export const isAssignmentHostId = (v: unknown): v is string => typeof v === 'string' && HOST_ID_PATTERN.test(v);

/**
 * The App's host-setup lock (see the file header): `exclusive` for a writer of an assignment or of the switch,
 * `shared` for a registration or a start deciding from them. An advisory lock, because an App with no assignment has
 * no row to lock. Transaction-scoped; re-entrant; never upgrade.
 */
export async function lockHostSetup(tx: Prisma.TransactionClient, appId: string, mode: 'exclusive' | 'shared'): Promise<void> {
  const key = 'host-setup:' + appId;
  if (mode === 'shared') await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtext(${key}))`;
  else await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
}

/** The App's switch, as stored. A missing App reads `host`: its caller has already refused it or will. */
export async function loadHostSetupSource(db: Db, appId: string): Promise<HostSetupSource> {
  const row = await db.app.findUnique({ where: { id: appId }, select: { hostSetupSource: true } });
  return isHostSetupSource(row?.hostSetupSource) ? row.hostSetupSource : 'host';
}

export type HostAssignmentRow = Prisma.HostWorkerAssignmentGetPayload<Record<string, never>>;

/**
 * The assignments in effect in an App, optionally of one host: those of workers that are not retired, by host then
 * worker id. A retired worker's row stays (retiring never rewrites the setup) and is simply never read.
 */
export async function loadHostAssignments(db: Db, appId: string, hostId?: string): Promise<HostAssignmentRow[]> {
  return db.hostWorkerAssignment.findMany({
    where: { appId, ...(hostId !== undefined ? { hostId } : {}), worker: { retiredAt: null, appId } },
    orderBy: [{ hostId: 'asc' }, { workerId: 'asc' }],
  });
}

/** The workers assigned to one host and in effect (not retired), for a checked registration. */
export async function assignedWorkerIds(db: Db, appId: string, hostId: string, workerIds: string[]): Promise<Set<string>> {
  if (workerIds.length === 0) return new Set();
  const rows = await db.hostWorkerAssignment.findMany({
    where: { appId, hostId, workerId: { in: workerIds }, worker: { retiredAt: null, appId } },
    select: { workerId: true },
  });
  return new Set(rows.map((r) => r.workerId));
}

/**
 * SQL for every reader that decides a launch from a registration row `w` (host_registration_workers), its
 * registration `r` and the App `a`. Join {@link ASSIGNMENT_JOIN}, filter with {@link ASSIGNMENT_IN_EFFECT}, and read
 * the family through {@link ASSIGNMENT_FAMILY}: under `host` they are the registration's own values, unchanged.
 */
export const ASSIGNMENT_JOIN = Prisma.sql`
  LEFT JOIN host_worker_assignments ha
    ON a.host_setup_source = 'server' AND ha.app_id = r.app_id AND ha.host_id = r.host_id AND ha.worker_id = w.worker_id`;
/** Under `server`: assigned to this host, and the host's registration confirms the assigned workdir. */
export const ASSIGNMENT_IN_EFFECT = Prisma.sql`(a.host_setup_source <> 'server' OR (ha.id IS NOT NULL AND ha.workdir = ANY(w.worktrees)))`;
export const ASSIGNMENT_FAMILY = Prisma.sql`COALESCE(ha.family, w.family)`;
/** The worktrees a start may name: under `server` only the assigned workdir. */
export const ASSIGNMENT_WORKTREES = Prisma.sql`CASE WHEN ha.id IS NOT NULL THEN ARRAY[ha.workdir] ELSE w.worktrees END`;
