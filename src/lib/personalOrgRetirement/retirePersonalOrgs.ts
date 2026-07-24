/**
 * Spec 048 Phase B — retire the auto-personal ("shadow") organizations.
 *
 * Spec 047 made Memory/Agent/App user-ownable, so the invisible personal org a
 * user was provisioned at signup (`isVisible !== true`) is now pure legacy
 * scaffolding. Phase A stopped creating new ones; this is the one-shot,
 * idempotent migration that retires the existing set: re-home each org's
 * Agent / App / Memory to the OWNER user (`ownerUserId`, `organizationId` NULL),
 * re-root their URNs onto the owner's `@handle` namespace, then delete the empty
 * org (releasing its pool principal).
 *
 * **Collision-safe re-rooting.** Modeled on {@link mergeOwnerNamespacedUrns},
 * NOT `renameOwnerNamespacedUrns` — the latter fail-closes the whole transaction
 * on a live URN collision, and the default workspace slugs (`my-agent`,
 * `my-workstation`) make a collision plausible for any owner who ALSO created a
 * user-owned entity via the spec-047 org-less path. `mintLocalSlug` re-mints a
 * colliding slug to a deterministic `<slug>-personal` alias instead of aborting.
 * Node/Edge URNs self-heal (composed from the memory URN + loc); each row records
 * its pre-migration URN in `legacyUrn`; durable `entry_node_urn` refs are
 * rewritten via the old→new remap.
 *
 * **Refuse-and-report guardrail.** The 12 production personal orgs are
 * auto-created scaffolds, so they carry no connections / integrations / billing.
 * Rather than trust that, the migration SKIPS (never silently destroys) any org
 * that isn't a clean scaffold — a non-single-OWNER shape, an owner with no
 * URN-legal handle, or any row in a {@link SIDE_DATA_TABLES} that a plain
 * org-delete would cascade away. Skipped orgs are reported for manual handling.
 *
 * Runs against `DATABASE_URL`. Idempotent — a re-run finds no `isVisible !== true`
 * orgs left (each is deleted on success). Dry-run executes the REAL code path
 * inside a transaction and rolls it back, so the preview matches the apply.
 */

import type { Prisma, PrismaClient } from '../../generated/prisma/index.js';
import { mintLocalSlug } from '../mintLocalSlug.js';
import { releasePrincipal } from '../principal/mintPrincipal.js';
import { normalizeHandleOrNull } from '../userHandle.js';

/**
 * The `authorRoot` seed handed to {@link mintLocalSlug} — a collision yields a
 * `<slug>-personal` alias (a stable, readable marker that the entity came from
 * the user's retired personal workspace), per spec 048 open-question #3.
 */
const PERSONAL_AUTHOR = 'personal';

/**
 * Tables an `Organization` delete would `onDelete: Cascade` and whose presence
 * therefore means a personal org is NOT a clean scaffold — deleting it would
 * destroy real data (a live connection, a registered integration's encrypted
 * creds, a billing-ledger row, or a cross-org grant). An org with any of these
 * is skipped for manual handling rather than migrated. (`org_members` and the
 * `usage_events` SetNull are the only cascades left after a scaffold delete and
 * are benign, so they are deliberately absent here.)
 */
const SIDE_DATA_TABLES: ReadonlyArray<{ table: string; orgCol: string }> = [
  { table: 'exchange_connections', orgCol: 'organization_id' },
  { table: 'slack_connections', orgCol: 'organization_id' },
  { table: 'mcp_servers', orgCol: 'organization_id' },
  { table: 'home_assistant_instances', orgCol: 'organization_id' },
  { table: 'resend_senders', orgCol: 'organization_id' },
  { table: 'credit_ledger_entries', orgCol: 'organization_id' },
  { table: 'memory_subscriptions', orgCol: 'organization_id' },
  { table: 'agent_org_grants', orgCol: 'org_id' }, // NB: org_id, not organization_id
  { table: 'principal_grants', orgCol: 'organization_id' },
  { table: 'ai_service_configs', orgCol: 'organization_id' },
];

/** A single URN re-root: the pre-migration URN and its re-rooted replacement. */
export interface ReHome {
  from: string;
  to: string;
}

/** Per-org outcome of the migration (or its dry-run preview). */
export interface OrgRetirementReport {
  orgId: string;
  orgUrn: string;
  ownerUserId: string | null;
  ownerHandle: string | null;
  /** `retired` (applied), `would-retire` (dry-run preview), or `skipped`. */
  action: 'retired' | 'would-retire' | 'skipped';
  /** Set when `action === 'skipped'` — why the org was left untouched. */
  skipReason?: string;
  /** Blocking `organization_id` row counts by table (only on a side-data skip). */
  sideData?: Record<string, number>;
  /** The entities re-homed to the owner (empty on a skip). */
  reHomed: { agents: ReHome[]; apps: ReHome[]; memories: ReHome[] };
}

/** Options controlling the migration run. */
export interface RetireOptions {
  /** Preview only — execute the real path in a transaction, then roll back. */
  dryRun?: boolean;
  /** Restrict to these org ids (default: every `isVisible !== true` org). */
  orgIds?: string[];
}

/** Strip the root (everything up to the first colon) off an owner-namespaced URN. */
function slugOf(urn: string): string {
  const colon = urn.indexOf(':');
  return colon >= 0 ? urn.slice(colon + 1) : urn;
}

/** Escape POSIX-regex metacharacters in a dynamic URN atom (a slug may contain
 *  `.`), keeping the `^`-anchored `entry_node_urn` rewrite precise. */
function reEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Internal sentinel: thrown at the end of a dry-run to roll the transaction
 *  back while carrying the fully-computed report out. */
class DryRunRollback extends Error {
  constructor(public readonly report: OrgRetirementReport) {
    super('dry-run rollback');
  }
}

/**
 * Retire every eligible auto-personal org (or the subset in `opts.orgIds`),
 * returning a per-org report. Each org is processed in its own transaction, so
 * one org's failure or skip never blocks the others. Safe to re-run.
 */
export async function retirePersonalOrgs(
  db: PrismaClient,
  opts: RetireOptions = {},
): Promise<OrgRetirementReport[]> {
  const orgs = await db.organization.findMany({
    where: {
      isVisible: { not: true },
      deletedAt: null,
      ...(opts.orgIds ? { id: { in: opts.orgIds } } : {}),
    },
    select: { id: true, urn: true, createdBy: true, principalId: true },
  });

  const reports: OrgRetirementReport[] = [];
  for (const org of orgs) {
    reports.push(await retireOneOrg(db, org, opts.dryRun ?? false));
  }
  return reports;
}

/** Shape of the org row the migration operates on. */
type OrgRow = { id: string; urn: string; createdBy: string | null; principalId: string | null };

/**
 * Validate one org is a clean scaffold, then (unless dry-run) re-home its
 * entities and delete it inside a single transaction. Returns the outcome; a
 * validation failure or a mid-flight error yields a `skipped` report rather than
 * throwing, so the caller's loop continues.
 */
async function retireOneOrg(
  db: PrismaClient,
  org: OrgRow,
  dryRun: boolean,
): Promise<OrgRetirementReport> {
  const base: OrgRetirementReport = {
    orgId: org.id,
    orgUrn: org.urn,
    ownerUserId: null,
    ownerHandle: null,
    action: 'skipped',
    reHomed: { agents: [], apps: [], memories: [] },
  };

  // 1. Scaffold shape: exactly one live OWNER member, and the org's createdBy
  //    (the durable personal-org discriminator) matches that owner.
  const members = await db.orgMember.findMany({
    where: { organizationId: org.id, deletedAt: null },
    select: { userId: true, role: true },
  });
  if (members.length !== 1) {
    return { ...base, skipReason: `not a single-member org (${members.length} live members)` };
  }
  const ownerUserId = members[0].userId;
  base.ownerUserId = ownerUserId;
  if (members[0].role !== 'OWNER') {
    return { ...base, skipReason: `sole member role is ${members[0].role}, not OWNER` };
  }
  if (org.createdBy && org.createdBy !== ownerUserId) {
    return { ...base, skipReason: 'createdBy does not match the sole owner' };
  }

  // 2. Owner has a URN-legal handle (the re-root target root). Guaranteed
  //    NON-NULL post-spec-047, but re-checked so a grandfathered illegal handle
  //    can't mint an invalid URN.
  const ownerRow = await db.user.findUnique({
    where: { id: ownerUserId },
    select: { handle: true },
  });
  const handle = normalizeHandleOrNull(ownerRow?.handle);
  base.ownerHandle = handle;
  if (!handle) {
    return { ...base, skipReason: 'owner has no URN-legal handle' };
  }

  // 3. Side-data guard: any cascade-destructive row means this isn't a clean
  //    scaffold — skip for manual handling (never silently cascade-delete it).
  const sideData: Record<string, number> = {};
  for (const { table, orgCol } of SIDE_DATA_TABLES) {
    // Table + column are hardcoded constants (never caller input), so the
    // interpolation is injection-safe; the org id is a bound parameter.
    const rows = await db.$queryRawUnsafe<Array<{ count: number }>>(
      `SELECT count(*)::int AS count FROM ${table} WHERE ${orgCol} = $1`,
      org.id,
    );
    if (rows[0]?.count > 0) sideData[table] = rows[0].count;
  }
  if (Object.keys(sideData).length > 0) {
    return { ...base, skipReason: 'has cascade-destructive side-data', sideData };
  }

  // 4. Re-home + delete inside one transaction. Dry-run runs the identical path
  //    and rolls back via the sentinel, so the preview equals the apply.
  try {
    return await db.$transaction(async (tx) => {
      const report = await reHomeAndDelete(tx, org, ownerUserId, handle, base);
      if (dryRun) throw new DryRunRollback({ ...report, action: 'would-retire' });
      return report;
    });
  } catch (err) {
    if (err instanceof DryRunRollback) return err.report;
    return {
      ...base,
      skipReason: `error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * The write path (inside `retireOneOrg`'s transaction): re-root the org's live
 * Memory/Agent/App onto the owner's handle (collision-safe), move any remaining
 * (tombstoned/uninstalled) owned rows so the org-delete cascade can't hard-delete
 * them, rewrite durable `entry_node_urn` refs, then release the principal, drop
 * the owner's PendingSetup, and delete the org (cascading only the benign
 * `org_members` row; `usage_events.organization_id` SetNull-s).
 */
async function reHomeAndDelete(
  tx: Prisma.TransactionClient,
  org: OrgRow,
  ownerUserId: string,
  handle: string,
  base: OrgRetirementReport,
): Promise<OrgRetirementReport> {
  const memories: ReHome[] = [];
  const agents: ReHome[] = [];
  const apps: ReHome[] = [];
  const memRemap: Array<readonly [string, string]> = [];

  // ── Memories ──────────────────────────────────────────────────────────────
  const memRows = await tx.memory.findMany({
    where: { organizationId: org.id, deletedAt: null },
    select: { id: true, urn: true },
  });
  for (const m of memRows) {
    const { urn: newUrn } = await mintLocalSlug({
      root: handle,
      desiredSlug: slugOf(m.urn),
      authorRoot: PERSONAL_AUTHOR,
      isTaken: (u) =>
        tx.memory.findFirst({ where: { urn: u, deletedAt: null }, select: { id: true } }).then(Boolean),
    });
    // memories_urn_key spans tombstones — reclaim a soft-deleted holder parked
    // at the exact target URN so the re-root can't abort on the unique index.
    await tx.memory.deleteMany({ where: { urn: newUrn, deletedAt: { not: null } } });
    await tx.memory.update({
      where: { id: m.id },
      data: { urn: newUrn, ownerUserId, organizationId: null, legacyUrn: m.urn },
    });
    memories.push({ from: m.urn, to: newUrn });
    memRemap.push([m.urn, newUrn]);
  }

  // ── Agents ────────────────────────────────────────────────────────────────
  const agentRows = await tx.agent.findMany({
    where: { organizationId: org.id, deletedAt: null },
    select: { id: true, urn: true },
  });
  for (const a of agentRows) {
    const { urn: newUrn } = await mintLocalSlug({
      root: handle,
      desiredSlug: slugOf(a.urn),
      authorRoot: PERSONAL_AUTHOR,
      isTaken: (u) =>
        tx.agent.findFirst({ where: { urn: u, deletedAt: null }, select: { id: true } }).then(Boolean),
    });
    await tx.agent.deleteMany({ where: { urn: newUrn, deletedAt: { not: null } } });
    await tx.agent.update({
      where: { id: a.id },
      data: { urn: newUrn, ownerUserId, organizationId: null, legacyUrn: a.urn },
    });
    agents.push({ from: a.urn, to: newUrn });
  }

  // ── Apps ──────────────────────────────────────────────────────────────────
  // App.urn is partial-unique over active rows (uninstalled_at IS NULL), so the
  // liveness probe uses that predicate and no tombstone reclaim is needed.
  const appRows = await tx.app.findMany({
    where: { organizationId: org.id, uninstalledAt: null, deletedAt: null },
    select: { id: true, urn: true },
  });
  for (const app of appRows) {
    const { urn: newUrn } = await mintLocalSlug({
      root: handle,
      desiredSlug: slugOf(app.urn),
      authorRoot: PERSONAL_AUTHOR,
      isTaken: (u) =>
        tx.app.findFirst({ where: { urn: u, uninstalledAt: null }, select: { id: true } }).then(Boolean),
    });
    await tx.app.update({
      where: { id: app.id },
      data: { urn: newUrn, ownerUserId, organizationId: null, legacyUrn: app.urn },
    });
    apps.push({ from: app.urn, to: newUrn });
  }

  // Move ownership of any REMAINING owned rows (soft-deleted memories/agents,
  // uninstalled apps) off the org so its delete can't hard-delete them via
  // cascade. Their URN stays as-is — a dead row holds no live namespace to
  // re-root. Mirrors mergeOwnerNamespacedUrns' final sweep.
  await tx.memory.updateMany({
    where: { organizationId: org.id },
    data: { ownerUserId, organizationId: null },
  });
  await tx.agent.updateMany({
    where: { organizationId: org.id },
    data: { ownerUserId, organizationId: null },
  });
  await tx.app.updateMany({
    where: { organizationId: org.id },
    data: { ownerUserId, organizationId: null },
  });

  // ── Durable node-URN references (spec 040) ─────────────────────────────────
  // Swap each re-rooted memory URN at the front of entry_node_urn (any accepted
  // v2 form) via a `^`-anchored regex, so a matching substring inside the loc is
  // never touched. Mirrors mergeOwnerNamespacedUrns.
  for (const [oldUrn, newUrn] of memRemap) {
    if (oldUrn === newUrn) continue;
    const pattern = `^((hrn|urn):node:)?${reEscape(oldUrn)}:`;
    const replacement = `\\1${newUrn}:`;
    await tx.$executeRaw`
      UPDATE agent_schedules SET entry_node_urn = regexp_replace(entry_node_urn, ${pattern}, ${replacement})
      WHERE entry_node_urn ~ ${pattern}`;
    await tx.$executeRaw`
      UPDATE agent_webhooks SET entry_node_urn = regexp_replace(entry_node_urn, ${pattern}, ${replacement})
      WHERE entry_node_urn ~ ${pattern}`;
    await tx.$executeRaw`
      UPDATE webfetch_poll_bindings SET entry_node_urn = regexp_replace(entry_node_urn, ${pattern}, ${replacement})
      WHERE entry_node_urn ~ ${pattern}`;
  }

  // ── Retire the now-empty org ───────────────────────────────────────────────
  // The one-time setup key is obsolete once there's no personal workspace.
  await tx.pendingSetup.deleteMany({ where: { userId: ownerUserId } });
  // Tombstone the org's pool principal (name kept forever, never recycled). The
  // org root (`<handle>-org` / `personal-<id>`) is disjoint from the owner's own
  // handle principal, which stays active.
  if (org.principalId) await releasePrincipal(tx, org.principalId);
  // Cascade removes the sole org_members row; usage_events.organization_id
  // SetNull-s (history preserved on the re-homed App). The side-data guard
  // already proved nothing destructive remains to cascade.
  await tx.organization.delete({ where: { id: org.id } });

  return { ...base, action: 'retired', reHomed: { agents, apps, memories } };
}
