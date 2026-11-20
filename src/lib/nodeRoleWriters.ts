/**
 * #1331 / #1202 Slice 1 (cor:acl:130:07, D-2026-09-24-005; Holger #13078 "A") —
 * `NodeRoleRule.writers` enforced in the AUTHORIZATION layer, never in a door.
 *
 * ## The rule
 *
 * A role rule's writer level narrows who may write nodes of that role, on top
 * of memory write access (which stays necessary and is never widened):
 *
 *   - `ALL`   — the existing memory-write audience. Grants nothing new.
 *   - `ADMIN` — the owning organization's ADMINs plus OWNERs and the owning
 *               user (who can always write). Decided by the ONE shared
 *               memory-management predicate, `requireMemoryManageAccess` at
 *               `ADMIN`, so this can never drift from the rest of the platform.
 *   - `OWNER` — the owning party (#1333, Holger's option A, Vera's ruling): the
 *               people the shared memory-management predicate admits at
 *               `CONTRIBUTOR` (the owning user, the owning org's contributors,
 *               ADMINs and OWNERs, a platform admin), plus an App PUBLISHED by
 *               the owner ({@link appCarriesOwnersAgent}). A share grantee, a
 *               subscriber org and a vendor App merely installed by the owner
 *               are not in it. It is never read as `ALL`: the level is a real
 *               check, and a level this server does not know (anything but
 *               ALL/ADMIN/OWNER) still refuses with `ROLE_WRITERS_UNSUPPORTED`.
 *
 * ## Identity (D23)
 *
 * A headless principal (a run, or an App key with no user) is the App service
 * identity: only the App's qualification counts, never the triggering user's own
 * standing, so an owner who triggers a vendor-only App does not lift it, and an
 * external driver of an owner-published App writes at owner level through it (the
 * recorded, accepted consequence). A principal with a user and no run client
 * (interactive person-through-App, still an open ruling) keeps the person's own
 * standing; the App adds nothing. Memory write access stays necessary and is
 * checked by every door before this runs.
 *
 * ## Before AND after
 *
 * The level is checked against BOTH the node's role before the write and the
 * role after it. Checking only the result lets a member declassify a node in
 * one call (ADMIN -> ALL-role, -> ordinary, -> cleared) and edit or delete it
 * as an ordinary node afterwards; checking only the prior role lets a member
 * promote a node into a governed role. A same-role edit is both at once, so a
 * member cannot rewrite an ADMIN node's body either.
 *
 * ## State, not only role
 *
 * The rule keys a node is judged under come from its full state before and after the write: its role, and the `task`
 * key when it is runnable (`governedKindsOf`). Writes of a node's outgoing edges are judged on the source node's state
 * ({@link assertEdgeSourceWriters}).
 *
 * ## Callers
 *
 * Every writer calls this inside its write transaction, on the LOCKED row, so
 * the rule and the node are judged as committed (`lockMemoryConfigShared`
 * serialises against a rulebook change, the same protocol as the strict
 * sub-role check). A write with no role on either side never loads a rulebook.
 * Server-authored platform writes (`platformWrite`) are the established system
 * authority and are not judged here; owning operations that are not a person's
 * write (channels, comments, decisions) do not call it.
 */

import { GraphQLError } from 'graphql';
import type { Prisma } from '../generated/prisma/index.js';
import type { Context } from '../api/graphql/schema/resolvers.helpers.js';
import { isAuthorizationDenial, requireMemoryManageAccess } from '../api/graphql/schema/resolvers.helpers.js';
import { lockMemoryConfigShared, resolveNodeRoleRule } from './governedRole.js';
import { isRunPrincipal } from './auth/runPrincipal.js';

/** The caller facts the audience needs; a GraphQL `Context` and an MCP `AuthContext` both carry them. */
export type RoleWriterPrincipal = Pick<Context,
  'userId' | 'roles' | 'impersonation' | 'appId' | 'sessionId' | 'organizationId' | 'clientId' | 'apiKeyId'>;

export type RoleWriterChange = {
  /** The node's role before the write; null/undefined for a new node. */
  priorRole: string | null | undefined;
  /** The node's role after the write (the merged result). */
  nextRole: string | null | undefined;
  /** Whether the node was runnable before the write. */
  priorRunnable?: boolean | null;
  /** Whether the node is runnable after the write (the merged result). */
  nextRunnable?: boolean | null;
};

/** The rule key a runnable node is judged under. */
const RUNNABLE_RULE_KEY = 'task';

/** The rule keys a node state is judged under. */
export function ruleKeysOf(role: string | null | undefined, runnable: boolean | null | undefined): string[] {
  const keys: string[] = [];
  if (role) keys.push(role);
  if (runnable === true && role !== RUNNABLE_RULE_KEY) keys.push(RUNNABLE_RULE_KEY);
  return keys;
}

/** The writer level needs an audience the caller is not in. */
export class RoleWriterLevelError extends GraphQLError {
  constructor(
    public readonly role: string,
    public readonly ruleRole: string,
    side: 'before' | 'after',
    public readonly level: 'ADMIN' | 'OWNER' = 'ADMIN',
  ) {
    super(
      `Writing a node ${side === 'before' ? 'that carries' : 'that would carry'} the role "${role}" needs the ${level} writer level` +
        `${ruleRole === role ? '' : ` (rule "${ruleRole}")`}: ` +
        (level === 'ADMIN'
          ? "the owning organization's ADMINs, its OWNERs, or the owning user. "
          : 'the owning party (its people, or an App published by it). ') +
        'Memory write access alone is not enough for this role.',
      { extensions: { code: 'ROLE_WRITER_LEVEL_REQUIRED', role, ruleRole, level, side } },
    );
    this.name = 'RoleWriterLevelError';
  }
}

/** The rule names a writer level this server does not know. Never read as ALL. */
export class RoleWritersUnsupportedError extends GraphQLError {
  constructor(public readonly role: string, public readonly ruleRole: string, public readonly level: string) {
    super(
      `The rule for role "${ruleRole}" sets the writer level ${level}, which this server does not support, ` +
        'so no write of that role is allowed. It is never read as ALL.',
      { extensions: { code: 'ROLE_WRITERS_UNSUPPORTED', role, ruleRole, level } },
    );
    this.name = 'RoleWritersUnsupportedError';
  }
}

type Db = Pick<Prisma.TransactionClient, 'memory' | 'memoryConfig' | '$queryRaw'>;

/** Whether the principal is in the ADMIN writer audience of `memoryId`, judged on `db`. */
async function inAdminAudience(db: Db, principal: RoleWriterPrincipal, memoryId: string): Promise<boolean> {
  const memory = await db.memory.findUnique({
    where: { id: memoryId },
    select: { class: true, userId: true, organizationId: true, ownerUserId: true },
  });
  if (!memory) return false;
  try {
    await requireMemoryManageAccess({ ...principal, db } as unknown as Context, memory, 'ADMIN');
    return true;
  } catch (e) {
    if (isAuthorizationDenial(e)) return false;
    throw e;
  }
}

/**
 * Whether an App currently carries an Agent of the memory's owner (#1333, option A, no schema change): the App is live
 * (`deleted_at` and `uninstalled_at` both NULL) and has an `AppAgent` row whose Agent is not deleted and belongs to the
 * memory's owning org, or, for a user-owned memory, to the owning user. Any one match qualifies (a multi-Agent App is
 * an accepted consequence). Read on live rows at write time, never cached on a session. An App the owner merely
 * installed carries a vendor Agent, so it does not match.
 *
 * This is a relationship, not a recorded publisher: nothing stores "published by". Installing an Agent into an App
 * needs the Agent to be visible to the installer (a PUBLIC Agent or an org grant), and an App still needs memory write
 * access, which the owner controls, before this is ever asked (hrn:node:hadronmemory.com:specs:cor:acl:010:03).
 *
 * The App row and the matching Agent row are locked `FOR SHARE` (the precedent is `userlessRunHoldsWriteGrant`), so an
 * uninstall or an Agent deletion either commits before this read and is seen, or waits for the write to finish. Outside
 * a transaction (a preview) the locks are plain reads. A deadlock against an App hard delete aborts one side, which the
 * write door reports as `NODE_WRITE_CONFLICT`: safe, not ordered.
 */
export async function appCarriesOwnersAgent(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  appId: string,
  owner: { organizationId: string | null; ownerUserId: string | null },
): Promise<boolean> {
  if (!owner.organizationId && !owner.ownerUserId) return false;
  const rows = owner.organizationId
    ? await db.$queryRaw<Array<{ id: string }>>`
        SELECT a.id FROM apps a
          JOIN app_agents aa ON aa.app_id = a.id
          JOIN agents ag ON ag.id = aa.agent_id
        WHERE a.id = ${appId} AND a.deleted_at IS NULL AND a.uninstalled_at IS NULL
          AND ag.deleted_at IS NULL AND ag.organization_id = ${owner.organizationId}
        LIMIT 1 FOR SHARE OF a, ag`
    : await db.$queryRaw<Array<{ id: string }>>`
        SELECT a.id FROM apps a
          JOIN app_agents aa ON aa.app_id = a.id
          JOIN agents ag ON ag.id = aa.agent_id
        WHERE a.id = ${appId} AND a.deleted_at IS NULL AND a.uninstalled_at IS NULL
          AND ag.deleted_at IS NULL AND ag.owner_user_id = ${owner.ownerUserId}
        LIMIT 1 FOR SHARE OF a, ag`;
  return rows.length > 0;
}

/** Whether the principal is in the OWNER writer audience of `memoryId` (see the file header), judged on `db`. */
async function inOwnerAudience(db: Db, principal: RoleWriterPrincipal, memoryId: string): Promise<boolean> {
  const memory = await db.memory.findUnique({
    where: { id: memoryId },
    select: { class: true, userId: true, organizationId: true, ownerUserId: true },
  });
  if (!memory) return false;
  // D23: a headless principal is the App service identity; the triggering user's own standing never counts.
  if (isRunPrincipal(principal) || (principal.appId && !principal.userId)) {
    return principal.appId ? appCarriesOwnersAgent(db, principal.appId, memory) : false;
  }
  try {
    await requireMemoryManageAccess({ ...principal, db } as unknown as Context, memory, 'CONTRIBUTOR');
    return true;
  } catch (e) {
    if (isAuthorizationDenial(e)) return false;
    throw e;
  }
}

/**
 * The refusal a write would get, or null when its roles allow it. Pure read,
 * no lock: for a preview (a dry run) that reports what the real run would do.
 * The real run uses {@link assertRoleWritersForWrite}, which judges the same
 * facts under the rulebook lock.
 */
export async function roleWritersRefusal(
  db: Db,
  principal: RoleWriterPrincipal,
  memoryId: string,
  change: RoleWriterChange,
): Promise<RoleWriterLevelError | RoleWritersUnsupportedError | null> {
  const sides: Array<['before' | 'after', string]> = [];
  const before = ruleKeysOf(change.priorRole, change.priorRunnable);
  for (const key of before) sides.push(['before', key]);
  for (const key of ruleKeysOf(change.nextRole, change.nextRunnable)) {
    if (!before.includes(key)) sides.push(['after', key]);
  }
  if (sides.length === 0) return null;

  const config = await db.memoryConfig.findUnique({ where: { memoryId }, include: { rules: true } });
  if (!config) return null;

  let admitted: boolean | undefined;
  let ownerAdmitted: boolean | undefined;
  for (const [side, role] of sides) {
    const resolution = resolveNodeRoleRule(role, config.rules);
    // A role the nearest strict parent does not declare is still governed by
    // that parent's level (a legacy node must not shed it by being undeclared).
    const rule = resolution.kind === 'RULE' ? resolution.rule
      : resolution.kind === 'UNDECLARED_UNDER_STRICT' ? resolution.ancestor
      : null;
    if (!rule || rule.writers === 'ALL') continue;
    if (rule.writers === 'ADMIN') {
      admitted ??= await inAdminAudience(db, principal, memoryId);
      if (!admitted) return new RoleWriterLevelError(role, rule.role, side);
      continue;
    }
    if (rule.writers === 'OWNER') {
      ownerAdmitted ??= await inOwnerAudience(db, principal, memoryId);
      if (!ownerAdmitted) return new RoleWriterLevelError(role, rule.role, side, 'OWNER');
      continue;
    }
    return new RoleWritersUnsupportedError(role, rule.role, rule.writers);
  }
  return null;
}

/** The MCP text for a writer-level refusal (`[role_writer_level_required] …`), or null for any other error. */
export function roleWriterRefusalText(e: unknown): string | null {
  if (e instanceof RoleWriterLevelError) return `[role_writer_level_required] ${e.message}`;
  if (e instanceof RoleWritersUnsupportedError) return `[role_writers_unsupported] ${e.message}`;
  return null;
}

/**
 * Judge a whole set of nodes that a bulk operation (move, clone, merge, extract)
 * writes or carries: each node's role must be writable by the caller in the
 * memory it LEAVES and, when it lands in another memory, in the one it ENTERS
 * (that memory's rulebook decides the destination). Roles are judged as a
 * set so one rulebook read serves the batch.
 */
export async function assertRoleWritersForNodes(
  tx: Prisma.TransactionClient,
  principal: RoleWriterPrincipal,
  nodes: ReadonlyArray<{ role: string | null | undefined; isRunnable?: boolean | null }>,
  memoryIds: { from: string; to?: string },
  opts: { platformWrite?: boolean; preview?: boolean } = {},
): Promise<void> {
  if (opts.platformWrite === true) return;
  // Judged as distinct (role, runnable) states so one rulebook read serves the batch.
  const states = new Map<string, { role: string | null; runnable: boolean }>();
  for (const n of nodes) {
    const role = n.role || null;
    const runnable = n.isRunnable === true;
    if (!role && !runnable) continue;
    states.set(`${role ?? ''}\u0000${runnable}`, { role, runnable });
  }
  const check = async (memoryId: string, change: RoleWriterChange) => {
    if (opts.preview) {
      const refusal = await roleWritersRefusal(tx, principal, memoryId, change);
      if (refusal) throw refusal;
    } else {
      await assertRoleWritersForWrite(tx, principal, memoryId, change);
    }
  };
  for (const key of [...states.keys()].sort()) {
    const { role, runnable } = states.get(key)!;
    await check(memoryIds.from, {
      priorRole: role, nextRole: role, priorRunnable: runnable, nextRunnable: runnable,
    });
    if (memoryIds.to && memoryIds.to !== memoryIds.from) {
      await check(memoryIds.to, {
        priorRole: null, nextRole: role, priorRunnable: false, nextRunnable: runnable,
      });
    }
  }
}

/**
 * Writer level for an edge write, judged under the rulebook lock. No edge writer moves an edge's source, so the
 * source's state is the same on both sides.
 */
async function assertEdgeSourceWriters(
  tx: Prisma.TransactionClient,
  principal: RoleWriterPrincipal,
  memoryId: string,
  opts: { platformWrite?: boolean } = {},
): Promise<void> {
  await assertRoleWritersForWrite(tx, principal, memoryId, {
    priorRole: null, nextRole: null, priorRunnable: true, nextRunnable: true,
  }, opts);
}

/**
 * Refuse a write whose old or new role needs a writer level the caller lacks.
 * Call inside the write transaction, after the node row is locked.
 */
export async function assertRoleWritersForWrite(
  tx: Prisma.TransactionClient,
  principal: RoleWriterPrincipal,
  memoryId: string,
  change: RoleWriterChange,
  opts: { platformWrite?: boolean } = {},
): Promise<void> {
  if (opts.platformWrite === true) return;
  // A write with no role and no runnable signal on either side never loads a rulebook.
  if (!change.priorRole && !change.nextRole && change.priorRunnable !== true && change.nextRunnable !== true) return;
  await lockMemoryConfigShared(tx, memoryId);
  const refusal = await roleWritersRefusal(tx, principal, memoryId, change);
  if (refusal) throw refusal;
}

/**
 * The same check, taking the source node by id. Locks the source row `FOR SHARE` (a concurrent change of its state
 * takes the row `FOR UPDATE`, so it commits first and is seen, or waits for this write) and judges its state as
 * committed. A source that needs no rule never loads a rulebook. Node-row locks come before the rulebook lock.
 */
export async function assertEdgeSourceWritersById(
  tx: Prisma.TransactionClient,
  principal: RoleWriterPrincipal,
  sourceNodeId: string,
  opts: { platformWrite?: boolean } = {},
): Promise<void> {
  if (opts.platformWrite === true) return;
  const [row] = await tx.$queryRaw<Array<{ memory_id: string; is_runnable: boolean | null }>>`
    SELECT memory_id, is_runnable FROM nodes WHERE id = ${sourceNodeId} FOR SHARE`;
  if (!row || row.is_runnable !== true) return;
  await assertEdgeSourceWriters(tx, principal, row.memory_id, opts);
}

/**
 * Lock an edge for update or delete under its source's writer level, in the node-then-edge order. The source id is read
 * without a lock, the source node is locked `FOR SHARE` and judged ({@link assertEdgeSourceWritersById}), then the edge
 * row is locked and its source re-read. A source that changed meanwhile is refused with `NODE_WRITE_CONFLICT` (judging
 * a new node while holding the edge row would reverse the lock order) and the caller re-runs. Returns null when the
 * edge does not exist.
 */
export async function lockEdgeUnderSourceWriters(
  tx: Prisma.TransactionClient,
  principal: RoleWriterPrincipal,
  edgeId: string,
  opts: { platformWrite?: boolean } = {},
): Promise<{ id: string; source_id: string; deleted_at: Date | null } | null> {
  const [pre] = await tx.$queryRaw<Array<{ source_id: string }>>`SELECT source_id FROM edges WHERE id = ${edgeId}`;
  if (!pre) return null;
  await assertEdgeSourceWritersById(tx, principal, pre.source_id, opts);
  const [locked] = await tx.$queryRaw<Array<{ id: string; source_id: string; deleted_at: Date | null }>>`
    SELECT id, source_id, deleted_at FROM edges WHERE id = ${edgeId} FOR UPDATE`;
  if (!locked) return null;
  if (locked.source_id !== pre.source_id) {
    throw new GraphQLError('The edge changed source while the write was running; re-run it.', {
      extensions: { code: 'NODE_WRITE_CONFLICT' },
    });
  }
  return locked;
}
