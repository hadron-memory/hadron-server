/**
 * #5404 (hrn:node:hadronmemory.com:specs:cor:acl:140:02, hrn:node:hadronmemory.com:specs:cor:agt:010:01; Holger, 2026-11-27, decision
 * record 2026-11-27-holger-rulings-to-victor-read-grant-shape-r1, section 6): `memory.write`, the one way a USERLESS run writes
 * outside what it already could. It replaces the unsigned App write grant of ruling 0083 (`app_memory_write_grants`), whose rows are
 * deleted at deploy ("Drop them too"): a run writes a memory only where a signed `memory.write` grant held by its App names it.
 *
 * The grant names one or more memories, or a loc prefix in one, and is signed by whoever manages EVERY named memory (Holger: "Owner
 * of each named memory"; for a personal or private memory that is its owner); there is no organization-wide form. Its values:
 *  - `memory`: one memory id, or a non-empty list of distinct ids; never the wildcard;
 *  - `prefix`: the wildcard (the whole of every named memory), or one loc, allowed only when `memory` names exactly one memory.
 *
 * What it permits, judged live at every write, as the 0083 grant did: node CREATE and UPDATE under the prefix, by a userless run of
 * the grant's App, and nothing else. Not delete, move, edges, memory settings, stored files, worker or session rows (the arm answers
 * only when the write door names a destination, {@link WriteDestination}); not another App's run, a user-backed run, an App key, a
 * worker session or a person ({@link isUserlessRunPrincipal} is the whole identity test).
 *
 * Fail-closed: every check can only refuse, and a `true` is added to whatever the write gate already decided.
 *
 * Concurrency (carried from the 0083 judge): the App and memory rows and every covering grant row are held `FOR SHARE`, so a
 * revocation (which UPDATEs the grant row) cannot return while a write that read the grant is still open, and a write that starts
 * after it sees the grant ended. The giver's deciding rows are held `FOR SHARE` too, so a demotion that would end the giver's
 * management serializes with the write. The node write door re-runs its gate on the writing transaction
 * (`assertMemoryWriteStateStable`), which is where these locks are taken for real; outside a transaction they are plain reads.
 */
import { Prisma, type PrismaClient } from '../../generated/prisma/index.js';
import type { AuthContext } from '../../middleware/auth.js';
import { isRunPrincipal } from '../auth/runPrincipal.js';
import { isUserHolding } from '../auth/userHolding.js';
import { grantLiveSql } from './live.js';

export const MEMORY_WRITE_ACTION = 'memory.write';
/** The `prefix` value that opens the whole of every named memory. */
export const WHOLE_MEMORY = '*';

/**
 * What a node write is about to do and where. Passed by the node write door (`writeNodeCore`) and by the run write pre-check; no
 * other verb names one, which is what keeps delete, move, edge and settings writes out of reach. `upsert` is create-or-update.
 */
export interface WriteDestination {
  loc: string;
  verb: 'create' | 'update' | 'upsert';
}

/** `reports:team-progress` covers itself and `reports:team-progress:<anything>`; never `reports:team-progressX`. */
export function grantCoversLoc(prefix: string, loc: string): boolean {
  return loc === prefix || loc.startsWith(`${prefix}:`);
}

/**
 * A headless AppRun acting for its App alone: the run client id, an App, and NO user, session or impersonation. A user-backed run
 * carries its user's authority and gains nothing from this grant.
 */
export function isUserlessRunPrincipal(auth: Pick<AuthContext, 'clientId' | 'userId' | 'appId' | 'sessionId' | 'impersonation'>): boolean {
  return isRunPrincipal(auth) && !auth.userId && !!auth.appId && !auth.sessionId && !auth.impersonation;
}

/** The two values of a `memory.write` grant, parsed; null when the stored shape is not one this action admits. */
export interface WriteGrantValues { memoryIds: string[]; prefix: string }

export function parseWriteGrantValues(values: unknown): WriteGrantValues | null {
  if (!values || typeof values !== 'object' || Array.isArray(values)) return null;
  const { memory, prefix } = values as Record<string, unknown>;
  const ids = Array.isArray(memory) ? memory : [memory];
  if (ids.length === 0 || !ids.every((x): x is string => typeof x === 'string' && x !== '' && x !== WHOLE_MEMORY)) return null;
  if (new Set(ids).size !== ids.length) return null;
  if (typeof prefix !== 'string' || prefix === '') return null;
  if (prefix !== WHOLE_MEMORY && ids.length !== 1) return null;
  return { memoryIds: ids, prefix };
}

type WriteGrantApp = { id: string; organizationId: string | null; ownerUserId: string | null };

/** The memory columns {@link memoryWriteTargetRefusal} reads. */
export const WRITE_GRANT_TARGET_SELECT = {
  id: true, class: true, userId: true, organizationId: true, appId: true, ownerUserId: true, deletedAt: true,
  isEncrypted: true, isInstallMemory: true, userMemoryOfAgentId: true, createdBy: true,
  workerOf: { select: { id: true } },
} as const;

export type WriteGrantTarget = Prisma.MemoryGetPayload<{ select: typeof WRITE_GRANT_TARGET_SELECT }>;

export type WriteGrantTargetRefusal =
  | 'deleted' | 'encrypted' | 'install-memory' | 'system' | 'no-owner' | 'worker-memory' | 'session-memory' | 'user-holding'
  | 'user-owned' | 'tenancy';

/**
 * May a `memory.write` grant held by `app` name this memory at all? The refusal, or null. Judged when the grant is created and again
 * at every write, so a memory that stops qualifying stops taking writes.
 *  - never: deleted, encrypted, an install memory (its own audience), `system` (written only by whoever manages the Agent,
 *    cor:agt:040:11), a Worker's or a session memory, a per-user chat holding (hadron-internal#88);
 *  - personal / private: only with an owner, whose grant it is (the signer must manage it, which for these classes is the owner);
 *  - the App's own team space (`class = 'app'` of this App): admitted, since a userless run cannot otherwise write it;
 *  - any other class: an organization-owned memory of the App's own organization; a user-owned knowledge or group memory never
 *    (as `memory.read`, #5345), and any other tenant never.
 */
export function memoryWriteTargetRefusal(app: WriteGrantApp, memory: WriteGrantTarget): WriteGrantTargetRefusal | null {
  if (memory.deletedAt) return 'deleted';
  if (memory.isEncrypted) return 'encrypted';
  if (memory.isInstallMemory) return 'install-memory';
  if (memory.class === 'system') return 'system';
  if (memory.class === 'personal' || memory.class === 'private') return memory.userId ? null : 'no-owner';
  if (memory.class === 'app') {
    if (memory.workerOf.length > 0) return 'worker-memory';
    if (memory.userMemoryOfAgentId !== null) return 'session-memory';
    return memory.appId === app.id ? null : 'tenancy';
  }
  if (isUserHolding(memory)) return 'user-holding';
  if (memory.ownerUserId !== null) return 'user-owned';
  if (memory.userMemoryOfAgentId !== null) return 'session-memory';
  if (app.organizationId !== null && memory.organizationId === app.organizationId) return null;
  return 'tenancy';
}

/**
 * Does the giver still manage this memory? Injected by the GraphQL layer (src/api/graphql/schema/resolvers.helpers.ts), whose memory
 * manage gate this module cannot import without a cycle through the MCP access layer. Unregistered, it answers false: fail closed.
 */
type GiverManages = (db: PrismaClient, giver: { id: string; roles: unknown }, memoryId: string) => Promise<boolean>;
let giverManages: GiverManages | null = null;
export function registerWriteGrantGiverCheck(check: GiverManages | null): void {
  giverManages = check;
}

interface WriteGrantRow { id: string; action_values: unknown; issuer_user_id: string | null }

/**
 * The grant arm of the write gate. True only when ALL hold, read on `db` (the writing transaction when called from the node write
 * door):
 *  1. the caller is a userless run principal and the write names a destination;
 *  2. a live `memory.write` grant held by THIS App names the memory and its prefix covers the destination loc (rows held FOR SHARE);
 *  3. the App is live and installed, the memory is live, and {@link memoryWriteTargetRefusal} still passes;
 *  4. the node carries no derived INCLUDE edge (a content write would re-derive edges outside the grant);
 *  5. the giver of one such grant still counts: erased (cor:acl:140:08), or still manages the memory.
 */
export async function userlessRunHoldsMemoryWriteGrant(
  db: PrismaClient,
  auth: AuthContext,
  memoryId: string,
  destination: WriteDestination,
): Promise<boolean> {
  if (!isUserlessRunPrincipal(auth)) return false;
  const appId = auth.appId!;
  const { loc } = destination;
  // Hold the authority rows this decision rests on. The writing transaction already holds the memory and the node row when it gets
  // here, so this takes the App after the memory, the reverse of an App hard delete's cascade: the two can deadlock, Postgres aborts
  // one, and the write door reports NODE_WRITE_CONFLICT. Safe, not ordered (as the 0083 judge).
  await db.$queryRaw`SELECT id FROM apps WHERE id = ${appId} FOR SHARE`;
  await db.$queryRaw`SELECT id FROM memories WHERE id = ${memoryId} FOR SHARE`;
  const rows = await db.$queryRaw<WriteGrantRow[]>`
    SELECT g.id, g.action_values, g.issuer_user_id FROM grants g
    WHERE g.app_id = ${appId} AND g.grantee_app_id = ${appId} AND g.user_id IS NULL AND g.agent_id IS NULL AND g.worker_id IS NULL
      AND g.action = ${MEMORY_WRITE_ACTION} AND ${grantLiveSql('g')}
      AND (g.action_values -> 'memory' = to_jsonb(${memoryId}::text) OR g.action_values -> 'memory' @> jsonb_build_array(${memoryId}::text))
    ORDER BY g.created_at ASC, g.id ASC
    FOR SHARE OF g`;
  const covering = rows.filter((r) => {
    const v = parseWriteGrantValues(r.action_values);
    return v !== null && v.memoryIds.includes(memoryId) && (v.prefix === WHOLE_MEMORY || grantCoversLoc(v.prefix, loc));
  });
  if (covering.length === 0) return false;

  const app = await db.app.findFirst({
    where: { id: appId, deletedAt: null, uninstalledAt: null },
    select: { id: true, organizationId: true, ownerUserId: true, organization: { select: { deletedAt: true } } },
  });
  if (!app || app.organization?.deletedAt) return false;
  const memory = await db.memory.findFirst({ where: { id: memoryId, deletedAt: null }, select: WRITE_GRANT_TARGET_SELECT });
  if (!memory || memoryWriteTargetRefusal(app, memory) !== null) return false;
  if (await db.edge.findFirst({ where: { governedKind: 'INCLUDE', source: { memoryId, loc } }, select: { id: true } })) return false;

  for (const row of covering) if (await giverStillCounts(db, row.issuer_user_id, memoryId)) return true;
  return false;
}

/** Erased (no row, or soft-deleted) counts (cor:acl:140:08); otherwise the giver must still manage the memory, rows held FOR SHARE. */
async function giverStillCounts(db: PrismaClient, issuerUserId: string | null, memoryId: string): Promise<boolean> {
  if (issuerUserId === null) return true;
  await db.$queryRaw`SELECT id FROM users WHERE id = ${issuerUserId} FOR SHARE`;
  await db.$queryRaw`SELECT user_id FROM org_members WHERE user_id = ${issuerUserId} FOR SHARE`;
  const user = await db.user.findUnique({ where: { id: issuerUserId }, select: { roles: true, deletedAt: true } });
  if (!user || user.deletedAt) return true;
  const check = giverManages;
  if (check === null) return false;
  return check(db, { id: issuerUserId, roles: user.roles }, memoryId);
}
