/**
 * effectiveAccess — the authoritative "what access does user X have to
 * resource Y?" composition (issue #323).
 *
 * Backs the GraphQL `effectiveAccess(user, resource)` query and the planned
 * `hadron access check` CLI command. The whole point is to CENTRALIZE the
 * per-resource grant rules here — composed from the same grant tables the
 * dedicated queries read — so an audit tool never has to re-derive (and
 * inevitably drift from) the server's real authorization decision.
 *
 * Subject perspective. We answer for a single subject USER's *standing*
 * access — a direct user with no active App / session context. Agent-mediated
 * paths (an Agent acting on the user's behalf) are out of scope: they depend
 * on a live session, not on the user's own grants.
 *
 * Alignment & known divergences. The per-class memory rules mirror the
 * canonical spec (cor:acl:010:01/02) and the `resolveMemoryAuthorization`
 * predicate: privacy is class-driven; `personal`/`private` are strict
 * single-owner (no platform/org/App bypass); `group` read requires a
 * MemoryMember row; `knowledge` is visibility-gated. This is intentionally
 * NO MORE permissive than the real gates: org-role capabilities mirror the
 * ENFORCED gates (requireMemoryWriteAccess for write, deleteMemory/cloneMemory
 * for manage, getOrgReadableMemoryIds for read) rather than the narrower
 * `resolveMemoryAuthorization` predicate — so for `group` an org member's read
 * matches getOrgReadableMemoryIds, NOT the (stricter) MemoryMember-only
 * predicate. The app class is shape-aware: only team/free-standing rows grant
 * standing App-participant read/write, Worker rows grant their current holder
 * and App managers, and session rows need their binding. We never reveal access
 * a per-table query wouldn't.
 *
 * Capabilities are derived from the grants, so an empty grant list always
 * means no access (canRead/canWrite/canManage/canDelete all false, role null).
 */

import type { PrismaClient } from '../../generated/prisma/index.js';
import { isActiveAgentSubscription } from '../agentSubscription.js';
// The pure half — grant/capability vocabulary, isPlatformAdmin, and the
// assemble() roll-up — lives in the shared package so every consumer
// (server, portal, CLI, clients) renders identical results.
import {
  isLifecycleActive,
  isPlatformAdmin,
  assemble,
  allows,
  READ,
  WRITE,
  FULL,
  type GrantWithCaps as InternalGrant,
  type Subject,
  type EffectiveAccessResult,
} from '@hadron-memory/access-control';
import { safeEntityUrnV2, safeNodeUrnV2 } from '../urnEmit.js';
import { isId } from '../entityRef/shape.js';

// Re-export the pure types so existing consumers of this module keep their
// import surface (the canonical definitions live in the package).
export type {
  ResourceKind,
  AccessSource,
  AccessGrant,
  EffectiveAccessResult,
  Subject,
} from '@hadron-memory/access-control';

// ─── Resource resolution ────────────────────────────────────────────────────

type MemoryForAccess = {
  id: string;
  urn: string;
  class: 'system' | 'app' | 'knowledge' | 'personal' | 'group' | 'private';
  visibility: 'PUBLIC' | 'ORGANIZATION' | 'GROUP' | null;
  userId: string | null;
  appId: string | null;
  userMemoryOfAgentId: string | null;
  workerOf: Array<{ id: string; appId: string; heldByUserId: string | null; retiredAt: Date | null }>;
  // spec 047: org-XOR-owner — exactly one of organizationId / ownerUserId is set.
  organizationId: string | null;
  ownerUserId: string | null;
  isEncrypted: boolean;
};

const MEMORY_SELECT = {
  id: true,
  urn: true,
  class: true,
  visibility: true,
  userId: true,
  appId: true,
  userMemoryOfAgentId: true,
  workerOf: { select: { id: true, appId: true, heldByUserId: true, retiredAt: true } },
  organizationId: true,
  ownerUserId: true,
  isEncrypted: true,
  deletedAt: true,
} as const;

type ConfigForAccess = {
  id: string;
  hadronServerId: string | null;
  organizationId: string | null;
  appId: string | null;
  agentId: string | null;
};

export type ResolvedResource =
  | { kind: 'memory'; memory: MemoryForAccess }
  | { kind: 'node'; node: { id: string; loc: string }; memory: MemoryForAccess }
  | { kind: 'app'; app: { id: string; urn: string; organizationId: string | null; ownerUserId: string | null } }
  | { kind: 'agent'; agent: { id: string; urn: string; organizationId: string | null; ownerUserId: string | null } }
  | { kind: 'aiServiceConfig'; config: ConfigForAccess }
  | { kind: 'organization'; org: { id: string; urn: string } }
  | { kind: 'user'; user: { id: string; handle: string } };

// ─── Org-role helper ────────────────────────────────────────────────────────

async function orgMemberRole(
  db: PrismaClient,
  orgId: string,
  userId: string,
): Promise<'OWNER' | 'ADMIN' | 'CONTRIBUTOR' | 'READER' | null> {
  const m = await db.orgMember.findUnique({
    where: { organizationId_userId: { organizationId: orgId, userId } },
    select: { role: true, deletedAt: true },
  });
  if (!m || m.deletedAt) return null;
  return m.role as 'OWNER' | 'ADMIN' | 'CONTRIBUTOR' | 'READER';
}

async function orgUrn(db: PrismaClient, orgId: string): Promise<string> {
  const org = await db.organization.findUnique({ where: { id: orgId }, select: { urn: true } });
  return org?.urn ?? orgId;
}

// ─── Per-kind composition ───────────────────────────────────────────────────

/**
 * Compose the grants a subject has on a single memory. Mirrors the per-class
 * rules in cor:acl:010:01/02. Returns grants only (capabilities are rolled up
 * by the caller). `personal`/`private` are strict single-owner: no
 * platform/org/App bypass is even considered for them.
 */
async function memoryGrants(
  db: PrismaClient,
  subject: Subject,
  memory: MemoryForAccess,
): Promise<InternalGrant[]> {
  const grants: InternalGrant[] = [];
  const strictOwnerClass = memory.class === 'personal' || memory.class === 'private';

  if (strictOwnerClass) {
    // The owner is the only direct path, and needs no license.
    if (memory.userId === subject.id) {
      grants.push({ source: 'MEMORY_PRINCIPAL', role: 'owner', via: null, caps: FULL });
    }
    // personal is shareable via MemoryShare; private is never shareable.
    if (memory.class === 'personal' && memory.userId !== subject.id) {
      const share = await db.memoryShare.findUnique({
        where: { memoryId_granteeId: { memoryId: memory.id, granteeId: subject.id } },
        select: { role: true },
      });
      if (share) {
        // An agent-scoped personal memory additionally requires the grantee
        // to hold an active subscription to the scoping Agent before the
        // share is honored (resolveMemoryAuthorization step 3c).
        let licensed = true;
        if (memory.userMemoryOfAgentId) {
          const sub = await db.agentSubscription.findUnique({
            where: {
              userId_agentId: { userId: subject.id, agentId: memory.userMemoryOfAgentId },
            },
            select: { activatedAt: true, revokedAt: true, expiresAt: true },
          });
          licensed = !!sub && isActiveAgentSubscription(sub);
        }
        if (licensed) {
          grants.push({
            source: 'MEMORY_SHARE',
            role: share.role,
            via: memory.urn,
            caps: share.role === 'writer' ? WRITE : READ,
          });
        }
      }
    }
    return grants;
  }

  // ── Non-strict classes (system / app / knowledge / group) ────────────────

  const hasWorkerShape = memory.class === 'app' && memory.appId !== null &&
    memory.userMemoryOfAgentId === null && memory.workerOf.some((w) =>
      w.appId === memory.appId);
  const workerApp = hasWorkerShape && await db.app.findFirst({
    where: { id: memory.appId!, deletedAt: null, uninstalledAt: null },
    select: { ownerUserId: true },
  });
  const isWorkerRow = Boolean(workerApp && workerApp.ownerUserId === memory.ownerUserId);

  // spec 047: user-owned non-strict memories are owner-only except a Worker's
  // working memory, which also grants its current holder read and write. The
  // casting must belong to a live App with the same tenant owner as the row.
  if (memory.ownerUserId !== null) {
    if (memory.ownerUserId === subject.id) {
      grants.push({ source: 'MEMORY_PRINCIPAL', role: 'owner', via: null, caps: FULL });
    } else if (isWorkerRow && memory.workerOf.some((w) =>
      w.appId === memory.appId && w.retiredAt === null && w.heldByUserId === subject.id)) {
      grants.push({ source: 'MEMORY_PRINCIPAL', role: 'worker-holder', via: null, caps: WRITE });
    }
    return grants;
  }
  // After the user-owned early return, the org-XOR-owner CHECK guarantees an org
  // owner — narrow organizationId to non-null for the org-role paths below.
  if (memory.organizationId === null) return grants;

  // System memory is universally readable, and is never written or managed
  // through this surface — its only editor is the agent-ownership surface, and
  // deleteMemory explicitly refuses to remove it. So it is read-only here, with
  // no platform/org/member write or manage grant layered on.
  if (memory.class === 'system') {
    grants.push({ source: 'PUBLIC_VISIBILITY', role: 'reader', via: null, caps: READ });
    return grants;
  }

  // Platform admin bypass — read/write/manage on every non-strict class
  // (requireMemoryWriteAccess + deleteMemory both honor the global role).
  if (isPlatformAdmin(subject.roles)) {
    grants.push({
      source: 'PLATFORM_ROLE',
      role: subject.roles.includes('OWNER') ? 'OWNER' : 'ADMIN',
      via: null,
      caps: FULL,
    });
  }

  // Per-user "holding" memories (userMemoryOfAgentId set — e.g. the startChat
  // no-App knowledge downgrade) are owner-only: getOrgReadableMemoryIds
  // EXCLUDES them on every clause (each filters userMemoryOfAgentId: null), so
  // the org-role and PUBLIC org-read paths below MUST NOT confer access to
  // them — that would over-report read/write the enforced gate denies. Holding
  // owners reach their own via the identity-scoped clause in
  // getAccessibleMemoryIds (createdBy match), which this standing-access audit
  // does not model; under-reporting a holding owner is the safe direction.
  const isHolding = memory.userMemoryOfAgentId !== null;

  // #653: an app-scoped knowledge/group memory is App-internal — the ENFORCED
  // gates (getOrgReadableMemoryIds / requireMemoryWriteAccess) exclude it from
  // every org-role and PUBLIC grant, so this audit surface MUST too or it
  // over-reports read/write the gate denies (the effectiveAccess-drift tell).
  // ADMIN/OWNER keep access — they bypass those gates on the enforced side too.
  const isAppScopedShared =
    memory.appId !== null && (memory.class === 'knowledge' || memory.class === 'group');
  const isAppTeamRow = memory.class === 'app' && memory.appId !== null &&
    memory.userMemoryOfAgentId === null && memory.workerOf.length === 0;
  if (isWorkerRow && memory.workerOf.some((w) =>
    w.appId === memory.appId && w.retiredAt === null && w.heldByUserId === subject.id)) {
    grants.push({ source: 'MEMORY_PRINCIPAL', role: 'worker-holder', via: null, caps: WRITE });
  }

  // Owning-org role. Mirrors the ENFORCED gates, not the (narrower) predicate:
  //   - ADMIN/OWNER → full: requireMemoryWriteAccess grants write,
  //     deleteMemory/cloneMemory grant manage/delete.
  //   - CONTRIBUTOR → read+write on ordinary knowledge and App team rows;
  //     Worker/session rows cannot be reached by an org role.
  //   - READER → read on knowledge/group org memories only
  //     (getOrgReadableMemoryIds; app-class is reached via AppMember, not org
  //     membership).
  const memberRole = isHolding ? null : await orgMemberRole(db, memory.organizationId, subject.id);
  // #1208 / cor:acl:010:01 — the org-role tiers mirror the ENFORCED gates,
  // and for GROUP those gates admit only MemoryMember: the MEMORY_MEMBER
  // grant at the bottom of this function is group's exclusive membership
  // source (owner/writer/reader → FULL/WRITE/READ). memberRole stays
  // computed for the PrincipalGrant block below — org-admin manage/delete
  // actions are a separate gate the read/write narrowing does not touch, and
  // this audit's omission of them for group is the safe under-reporting
  // direction the module's notes already allow.
  if (memory.class !== 'group' && (memory.class !== 'app' || isAppTeamRow || isWorkerRow)) {
    if (memberRole === 'ADMIN' || memberRole === 'OWNER') {
      grants.push({
        source: 'ORG_ROLE',
        role: memberRole,
        via: await orgUrn(db, memory.organizationId),
        caps: FULL,
      });
    } else if (memberRole === 'CONTRIBUTOR' && !isAppScopedShared && !isWorkerRow) {
      grants.push({
        source: 'ORG_ROLE',
        role: memberRole,
        via: await orgUrn(db, memory.organizationId),
        caps: WRITE,
      });
    } else if (memberRole === 'READER' && !isAppScopedShared && memory.class === 'knowledge') {
      grants.push({
        source: 'ORG_ROLE',
        role: memberRole,
        via: await orgUrn(db, memory.organizationId),
        caps: READ,
      });
    }
  }

  // PUBLIC visibility → readable by anyone (but not a per-user holding, and not
  // an app-scoped knowledge/group row — #653: it's App-internal even if a
  // visibility change set it PUBLIC).
  if (memory.visibility === 'PUBLIC' && !isHolding && !isAppScopedShared) {
    grants.push({ source: 'PUBLIC_VISIBILITY', role: 'reader', via: null, caps: READ });
  }

  // NOTE (deliberate omission, tracked by #329): cross-org
  // MemorySubscription access — requireMemoryWriteAccess + getOrgReadableMemoryIds
  // both confer read/write when the caller's org holds a CONTRIBUTOR+
  // MemorySubscription — is not yet modeled here, so a purely subscription-based
  // grant is under-reported. Under-reporting is the safe direction for an audit.

  // Individual action grants (design:grant-model, cor:acl:040:06). Mirrors
  // requireOrgAction exactly: grants count only alongside a LIVE membership
  // (memberRole non-null — a grant is an exception ON TOP of membership) and
  // only for the actions the ENFORCED gates actually consult — memory.clone
  // (cloneMemory ⇒ manage) and memory.delete (deleteMemory ⇒ delete).
  // memory.read/write entries are deliberately NOT surfaced: no enforced
  // read/write gate consults PrincipalGrant yet, and the audit must never
  // over-report. Liveness (deletedAt + expiry) is filtered IN the query.
  if (memberRole !== null) {
    const grantRows = await db.principalGrant.findMany({
      where: {
        principalType: 'USER',
        principalId: subject.id,
        organizationId: memory.organizationId,
        deletedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      select: { actions: true },
    });
    if (grantRows.length > 0) {
      const link = { allow: grantRows.flatMap((g) => g.actions) };
      // A clone grant maps to manage only where a clone could actually run:
      // cloneMemory categorically rejects app-class and (v1) encrypted
      // sources AFTER its gate, so mapping those would over-report a
      // capability the holder cannot exercise. deleteMemory has no such
      // rejection, so memory.delete maps on every class that reaches here.
      const clonable =
        (memory.class === 'knowledge' || memory.class === 'group') && !memory.isEncrypted;
      const canClone = clonable && allows(link, 'memory.clone');
      const canDelete = allows(link, 'memory.delete');
      if (canClone || canDelete) {
        grants.push({
          source: 'PRINCIPAL_GRANT',
          role: [canClone ? 'memory.clone' : null, canDelete ? 'memory.delete' : null]
            .filter(Boolean)
            .join(','),
          via: await orgUrn(db, memory.organizationId),
          caps: { read: false, write: false, manage: canClone, delete: canDelete },
        });
      }
    }
  }

  if (isAppTeamRow && memory.appId) {
    const member = await db.appMember.findUnique({
      where: { appId_userId: { appId: memory.appId, userId: subject.id } },
      select: { role: true },
    });
    if (member) {
      // AppMember existence permits read+write on the App's memory
      // (resolveMemoryAuthorization app branch). It does NOT confer
      // manage/delete — removing an app memory requires org ADMIN
      // (deleteMemory) — so the free-form member role string only labels the
      // grant; it never lifts capabilities above read+write.
      const app = await db.app.findUnique({
        where: { id: memory.appId },
        select: { urn: true },
      });
      grants.push({
        source: 'APP_MEMBER',
        role: member.role,
        via: app?.urn ?? memory.appId,
        caps: WRITE,
      });
    }
  }

  if (memory.class === 'group') {
    const member = await db.memoryMember.findUnique({
      where: { memoryId_userId: { memoryId: memory.id, userId: subject.id } },
      select: { role: true },
    });
    if (member) {
      const caps =
        member.role === 'owner' ? FULL : member.role === 'writer' ? WRITE : READ;
      grants.push({ source: 'MEMORY_MEMBER', role: member.role, via: null, caps });
    }
  }

  return grants;
}

/**
 * App access. Membership confers use (read+write at the App level); management
 * (settings, uninstall) is the owning-org admin's or a platform admin's — the
 * free-form AppMember role string never lifts an AppMember above read+write.
 */
async function appGrants(
  db: PrismaClient,
  subject: Subject,
  app: { id: string; organizationId: string | null; ownerUserId: string | null },
): Promise<InternalGrant[]> {
  const grants: InternalGrant[] = [];

  // spec 047: a USER-owned App is STRICTLY owner-only (v1). Only the owner has
  // grants; return before the platform/org paths, mirroring memoryGrants.
  if (app.ownerUserId !== null) {
    if (app.ownerUserId === subject.id) {
      grants.push({ source: 'PRINCIPAL_GRANT', role: 'owner', via: null, caps: FULL });
    }
    return grants;
  }

  if (isPlatformAdmin(subject.roles)) {
    grants.push({
      source: 'PLATFORM_ROLE',
      role: subject.roles.includes('OWNER') ? 'OWNER' : 'ADMIN',
      via: null,
      caps: FULL,
    });
  }

  // Org-owned past this point (XOR guarantees org non-null when owner is null).
  if (app.organizationId === null) return grants;
  const memberRole = await orgMemberRole(db, app.organizationId, subject.id);
  if (memberRole === 'ADMIN' || memberRole === 'OWNER') {
    grants.push({
      source: 'ORG_ROLE',
      role: memberRole,
      via: await orgUrn(db, app.organizationId),
      caps: FULL,
    });
  }

  const member = await db.appMember.findUnique({
    where: { appId_userId: { appId: app.id, userId: subject.id } },
    select: { role: true },
  });
  if (member) {
    // Membership confers use (read+write) at the App level. App management
    // (settings, uninstall) is gated on the owning-org admin role, not on the
    // free-form AppMember role string — so the role only labels the grant and
    // never lifts capabilities above read+write.
    grants.push({ source: 'APP_MEMBER', role: member.role, via: null, caps: WRITE });
  }

  return grants;
}

/**
 * Agent access. A user reaches an Agent through an active AgentSubscription
 * (use), or — at org level — an active AgentOrgGrant on any org they belong to
 * (the grant licenses that org's members to install/use the Agent). The
 * Agent's owning-org admins and platform admins manage it.
 *
 * AgentOrgGrant is org-level, not user-level (issue #323 open question): we
 * map it onto a user's access as "use" for every org member of a granted org,
 * surfaced as an AGENT_SUBSCRIPTION-class grant whose `via` is the granted
 * org's URN.
 */
async function agentGrants(
  db: PrismaClient,
  subject: Subject,
  agent: { id: string; organizationId: string | null; ownerUserId: string | null },
  // Admin impersonation: narrow the subject's membership enumeration to the
  // session's shared org so an AgentOrgGrant reached via ANOTHER org of the
  // subject can't leak that org's URN/membership into the audit result.
  restrictOrgId?: string,
): Promise<InternalGrant[]> {
  const grants: InternalGrant[] = [];

  // spec 047: a USER-owned Agent is STRICTLY owner-only (v1 — no sharing, no
  // platform-admin bypass). Only the owner has grants; return before the
  // platform/org paths, mirroring memoryGrants.
  if (agent.ownerUserId !== null) {
    if (agent.ownerUserId === subject.id) {
      grants.push({ source: 'PRINCIPAL_GRANT', role: 'owner', via: null, caps: FULL });
    }
    return grants;
  }

  if (isPlatformAdmin(subject.roles)) {
    grants.push({
      source: 'PLATFORM_ROLE',
      role: subject.roles.includes('OWNER') ? 'OWNER' : 'ADMIN',
      via: null,
      caps: FULL,
    });
  }
  // Org-owned past this point (XOR guarantees org non-null when owner is null).
  if (agent.organizationId === null) return grants;

  const memberRole = await orgMemberRole(db, agent.organizationId, subject.id);
  if (memberRole === 'ADMIN' || memberRole === 'OWNER') {
    grants.push({
      source: 'ORG_ROLE',
      role: memberRole,
      via: await orgUrn(db, agent.organizationId),
      caps: FULL,
    });
  }

  // Direct per-user subscription.
  const sub = await db.agentSubscription.findUnique({
    where: { userId_agentId: { userId: subject.id, agentId: agent.id } },
    select: { activatedAt: true, revokedAt: true, expiresAt: true },
  });
  if (sub && isActiveAgentSubscription(sub)) {
    grants.push({ source: 'AGENT_SUBSCRIPTION', role: 'subscriber', via: null, caps: READ });
  }

  // Org-level grants the subject inherits as an org member.
  const memberships = await db.orgMember.findMany({
    where: {
      userId: subject.id,
      deletedAt: null,
      ...(restrictOrgId ? { organizationId: restrictOrgId } : {}),
    },
    select: { organizationId: true },
  });
  const orgIds = memberships.map((m) => m.organizationId);
  if (orgIds.length > 0) {
    const orgGrants = await db.agentOrgGrant.findMany({
      where: { agentId: agent.id, orgId: { in: orgIds } },
    });
    const activeGrants = orgGrants.filter((g) => isLifecycleActive(g));
    if (activeGrants.length > 0) {
      // Bulk-resolve the granting orgs' URNs (one query, not one per grant).
      const orgs = await db.organization.findMany({
        where: { id: { in: activeGrants.map((g) => g.orgId) } },
        select: { id: true, urn: true },
      });
      const urnById = new Map(orgs.map((o) => [o.id, o.urn]));
      for (const grant of activeGrants) {
        grants.push({
          source: 'AGENT_SUBSCRIPTION',
          role: 'org-grant',
          via: urnById.get(grant.orgId) ?? grant.orgId,
          caps: READ,
        });
      }
    }
  }

  return grants;
}

/**
 * AiServiceConfig access. Mirrors the `aiServiceConfigs` management gate
 * (requireAiConfigOwnerAdmin): platform admin for HADRON_SERVER owners; org
 * admin of the owning org for ORGANIZATION / APP / AGENT owners. Access is
 * admin-only; this never returns key material.
 */
async function aiServiceConfigGrants(
  db: PrismaClient,
  subject: Subject,
  config: ConfigForAccess,
): Promise<InternalGrant[]> {
  const grants: InternalGrant[] = [];

  if (isPlatformAdmin(subject.roles)) {
    grants.push({
      source: 'PLATFORM_ROLE',
      role: subject.roles.includes('OWNER') ? 'OWNER' : 'ADMIN',
      via: null,
      caps: FULL,
    });
  }

  // HADRON_SERVER owner — platform admin only (handled above).
  let owningOrgId: string | null = null;
  let viaId: string | null = null;
  if (config.organizationId) {
    owningOrgId = config.organizationId;
    viaId = config.organizationId;
  } else if (config.appId) {
    const app = await db.app.findUnique({
      where: { id: config.appId },
      select: { organizationId: true, urn: true },
    });
    owningOrgId = app?.organizationId ?? null;
    viaId = app?.urn ?? config.appId;
  } else if (config.agentId) {
    const agent = await db.agent.findUnique({
      where: { id: config.agentId },
      select: { organizationId: true, urn: true },
    });
    owningOrgId = agent?.organizationId ?? null;
    viaId = agent?.urn ?? config.agentId;
  }

  if (owningOrgId) {
    const memberRole = await orgMemberRole(db, owningOrgId, subject.id);
    if (memberRole === 'ADMIN' || memberRole === 'OWNER') {
      grants.push({
        source: 'AICONFIG_OWNER',
        role: memberRole,
        via: config.organizationId ? await orgUrn(db, owningOrgId) : viaId,
        caps: FULL,
      });
    }
  }

  return grants;
}

/**
 * Organization access. The org's own members and platform admins reach it:
 *   - platform admin → full (read/write/manage/delete);
 *   - org OWNER/ADMIN → administer it (read/write/manage) but NOT delete —
 *     deleting an org is platform-admin only (`deleteOrganization` gates on the
 *     global ADMIN role), whereas renaming/settings/members is org-ADMIN
 *     (`updateOrganization` → requireOrgRole ADMIN);
 *   - org CONTRIBUTOR/READER → read (they can see the org they belong to).
 */
async function organizationGrants(
  db: PrismaClient,
  subject: Subject,
  org: { id: string; urn: string },
): Promise<InternalGrant[]> {
  const grants: InternalGrant[] = [];

  if (isPlatformAdmin(subject.roles)) {
    grants.push({
      source: 'PLATFORM_ROLE',
      role: subject.roles.includes('OWNER') ? 'OWNER' : 'ADMIN',
      via: null,
      caps: FULL,
    });
  }

  const memberRole = await orgMemberRole(db, org.id, subject.id);
  if (memberRole === 'ADMIN' || memberRole === 'OWNER') {
    // Administer (rename/settings/members) but not delete — delete is
    // platform-admin only, so an org admin's grant stops short of FULL.
    grants.push({
      source: 'ORG_ROLE',
      role: memberRole,
      via: org.urn,
      caps: { read: true, write: true, manage: true, delete: false },
    });
  } else if (memberRole === 'CONTRIBUTOR' || memberRole === 'READER') {
    grants.push({ source: 'ORG_ROLE', role: memberRole, via: org.urn, caps: READ });
  }

  return grants;
}

/**
 * User access. Unlike memory/app/agent/org a User is not an owned or shared
 * resource backed by grant tables — the only standing access to a user record
 * is identity and platform role:
 *   - the user themselves → read/write/manage their own account, but NOT delete
 *     (account removal is a platform action, not self-service);
 *   - platform admin → full (`updateUserRoles` gates on the global ADMIN role);
 *   - everyone else → none.
 *
 * Org-admin "can see a fellow member" directory visibility is deliberately NOT
 * modeled here — under-reporting is the safe direction for an audit, consistent
 * with the rest of this module.
 */
function userGrants(subject: Subject, user: { id: string }): InternalGrant[] {
  const grants: InternalGrant[] = [];

  if (isPlatformAdmin(subject.roles)) {
    grants.push({
      source: 'PLATFORM_ROLE',
      role: subject.roles.includes('OWNER') ? 'OWNER' : 'ADMIN',
      via: null,
      caps: FULL,
    });
  }

  if (subject.id === user.id) {
    // Self: manage own account (profile/settings) but not delete it.
    grants.push({
      source: 'USER_SELF',
      role: 'self',
      via: null,
      caps: { read: true, write: true, manage: true, delete: false },
    });
  }

  return grants;
}

/**
 * Compute the subject's effective access to a resolved resource. The caller is
 * responsible for authorizing WHO may invoke this (see `callerCanAudit`) and
 * for resolving the resource ref first (see `resolveResource`).
 *
 * `resourceUrn` is EMITTED, never echoed (#966). The stored `urn` column is a
 * BARE body by construction — the `chk_*_urn_not_prefixed` guardrails forbid
 * persisting a rendered form — so returning it raw handed callers a string this
 * server's own ref parsers reject, while the same row's `Memory.urn` field
 * (which does emit) disagreed about the same memory's URN. Every kind now runs
 * through the same emitter its entity's own `urn` field uses, so the value can
 * be fed straight back into another query or CLI command. Two kinds have no
 * emitter by nature and are documented exceptions: an AiServiceConfig has no URN
 * (its id is the identifier) and a user's `hrn:user:<handle>` form is composed
 * here because the core URN grammar does not address users.
 *
 * Emission is strict-then-raw (`safeEntityUrnV2` / `safeNodeUrnV2`): an
 * un-emittable STORED urn logs and serves its best-effort form rather than
 * failing the audit, which must keep answering even for a corrupt row.
 */
export async function computeEffectiveAccess(
  db: PrismaClient,
  subject: Subject,
  resolved: ResolvedResource,
  // Admin impersonation: the caller is a read-only session scoped to ONE org
  // (the resolver has already refused resources outside it); this narrows the
  // remaining cross-org enumeration (agent org-grants) to that org.
  opts?: { restrictOrgId?: string },
): Promise<EffectiveAccessResult> {
  switch (resolved.kind) {
    case 'memory': {
      const grants = await memoryGrants(db, subject, resolved.memory);
      return assemble(subject.id, safeEntityUrnV2('memory', resolved.memory.urn), 'memory', grants);
    }
    case 'node': {
      // A node's access IS its memory's access (memoryAccessFilter coupling).
      // Re-tag each memory grant as NODE_INHERITED, with `via` pointing at the
      // memory the node inherits from.
      const memGrants = await memoryGrants(db, subject, resolved.memory);
      const inherited: InternalGrant[] = memGrants.map((g) => ({
        source: 'NODE_INHERITED',
        role: g.role,
        via: resolved.memory.urn,
        caps: g.caps,
      }));
      return assemble(
        subject.id,
        safeNodeUrnV2(resolved.memory.urn, resolved.node.loc),
        'node',
        inherited,
      );
    }
    case 'app': {
      const grants = await appGrants(db, subject, resolved.app);
      return assemble(subject.id, safeEntityUrnV2('app', resolved.app.urn), 'app', grants);
    }
    case 'agent': {
      const grants = await agentGrants(db, subject, resolved.agent, opts?.restrictOrgId);
      return assemble(subject.id, safeEntityUrnV2('agent', resolved.agent.urn), 'agent', grants);
    }
    case 'aiServiceConfig': {
      const grants = await aiServiceConfigGrants(db, subject, resolved.config);
      // AiServiceConfig has no URN; echo the id as the resource identifier.
      return assemble(subject.id, resolved.config.id, 'aiServiceConfig', grants);
    }
    case 'organization': {
      const grants = await organizationGrants(db, subject, resolved.org);
      return assemble(subject.id, safeEntityUrnV2('org', resolved.org.urn), 'organization', grants);
    }
    case 'user': {
      const grants = userGrants(subject, resolved.user);
      // The form is handle-only; resolveResource guarantees a non-null handle.
      return assemble(subject.id, `hrn:user:${resolved.user.handle}`, 'user', grants);
    }
  }
}

/**
 * Authorize WHO may audit a resource's access. The same visibility bar already
 * enforced on the underlying grant tables: a platform admin, an ADMIN/OWNER of
 * the resource's owning org, or — for a strict-owner memory — the memory's
 * principal. Returns false for everyone else (the resolver maps that to
 * FORBIDDEN, never a silent empty result).
 */
export async function callerCanAudit(
  db: PrismaClient,
  caller: { userId?: string; roles?: Subject['roles'] },
  resolved: ResolvedResource,
): Promise<boolean> {
  if (caller.roles && isPlatformAdmin(caller.roles)) return true;
  if (!caller.userId) return false;

  const isOrgAdmin = async (orgId: string): Promise<boolean> => {
    const role = await orgMemberRole(db, orgId, caller.userId!);
    return role === 'ADMIN' || role === 'OWNER';
  };

  switch (resolved.kind) {
    case 'memory':
    case 'node': {
      const memory = resolved.memory;
      // The principal of a strict-owner memory may audit their own.
      if (
        (memory.class === 'personal' || memory.class === 'private') &&
        memory.userId === caller.userId
      ) {
        return true;
      }
      // spec 047: a user-owned memory — ONLY its owner may audit (strict
      // ownership; no org-admin path, and the org is null here anyway).
      if (memory.ownerUserId !== null) {
        return memory.ownerUserId === caller.userId;
      }
      return memory.organizationId !== null ? isOrgAdmin(memory.organizationId) : false;
    }
    case 'app':
      // spec 047: a user-owned App — only its owner may audit (platform admins
      // are already handled by the early return above; the result grants them
      // nothing).
      if (resolved.app.ownerUserId !== null) return resolved.app.ownerUserId === caller.userId;
      return resolved.app.organizationId ? isOrgAdmin(resolved.app.organizationId) : false;
    case 'agent':
      if (resolved.agent.ownerUserId !== null) return resolved.agent.ownerUserId === caller.userId;
      return resolved.agent.organizationId ? isOrgAdmin(resolved.agent.organizationId) : false;
    case 'organization':
      return isOrgAdmin(resolved.org.id);
    case 'user':
      // A user may audit their own access; platform admins are handled above.
      return caller.userId === resolved.user.id;
    case 'aiServiceConfig': {
      const c = resolved.config;
      if (c.organizationId) return isOrgAdmin(c.organizationId);
      if (c.appId) {
        const app = await db.app.findUnique({
          where: { id: c.appId },
          select: { organizationId: true },
        });
        // spec 047: a user-owned App has no org, so no org-admin audit path
        // (owner-audit lands with creation in Phase 2c-2).
        return app?.organizationId ? isOrgAdmin(app.organizationId) : false;
      }
      if (c.agentId) {
        const agent = await db.agent.findUnique({
          where: { id: c.agentId },
          select: { organizationId: true },
        });
        return agent?.organizationId ? isOrgAdmin(agent.organizationId) : false;
      }
      // HADRON_SERVER owner — platform admin only (already handled above).
      return false;
    }
  }
}

/**
 * Resolve a resource reference (ID or fully-qualified URN) to a loaded
 * resource. Dispatches on URN type the way `resolveUrn` does; a bare ID with
 * no scheme is treated as an AiServiceConfig id (the only resource kind
 * without a URN). Returns null for anything that doesn't resolve (→ NOT_FOUND).
 *
 * `parseUrnType` and the entity-ref resolvers are injected so the resolver can
 * reuse the same canonicalization helpers it already imports.
 */
export async function resolveResource(
  db: PrismaClient,
  ref: string,
  deps: {
    parseType: (ref: string) => string;
    resolveMemoryRef: (db: PrismaClient, ref: string) => Promise<{ id: string }>;
    resolveNodeRef: (db: PrismaClient, ref: string) => Promise<{ id: string }>;
    resolveAppRef: (db: PrismaClient, ref: string) => Promise<{ id: string }>;
    resolveAgentRef: (db: PrismaClient, ref: string) => Promise<{ id: string }>;
    resolveOrgRef: (db: PrismaClient, ref: string) => Promise<{ id: string }>;
    resolveUserRef: (db: PrismaClient, ref: string) => Promise<{ id: string }>;
  },
): Promise<ResolvedResource | null> {
  const type = deps.parseType(ref);

  const loadMemory = async (id: string): Promise<MemoryForAccess | null> => {
    const m = await db.memory.findUnique({ where: { id }, select: MEMORY_SELECT });
    if (!m || m.deletedAt) return null;
    const { deletedAt: _omit, ...rest } = m;
    return rest as MemoryForAccess;
  };

  // Soft-deleted resources resolve to NOT_FOUND, matching the dedicated
  // per-kind queries: the injected entity-ref resolvers (resolveNodeRef /
  // resolveAppRef / resolveAgentRef) all throw NotFound for a deletedAt row —
  // caught below and collapsed to null — and loadMemory drops deleted memories.
  try {
    switch (type) {
      case 'memory': {
        const { id } = await deps.resolveMemoryRef(db, ref);
        const memory = await loadMemory(id);
        return memory ? { kind: 'memory', memory } : null;
      }
      case 'node': {
        const { id } = await deps.resolveNodeRef(db, ref);
        const node = await db.node.findUnique({
          where: { id },
          select: { id: true, loc: true, memoryId: true },
        });
        if (!node) return null;
        const memory = await loadMemory(node.memoryId);
        return memory
          ? { kind: 'node', node: { id: node.id, loc: node.loc }, memory }
          : null;
      }
      case 'app': {
        const { id } = await deps.resolveAppRef(db, ref);
        const app = await db.app.findUnique({
          where: { id },
          select: { id: true, urn: true, organizationId: true, ownerUserId: true },
        });
        return app ? { kind: 'app', app } : null;
      }
      case 'agent': {
        const { id } = await deps.resolveAgentRef(db, ref);
        const agent = await db.agent.findUnique({
          where: { id },
          select: { id: true, urn: true, organizationId: true, ownerUserId: true },
        });
        return agent ? { kind: 'agent', agent } : null;
      }
      case 'org': {
        const { id } = await deps.resolveOrgRef(db, ref);
        const org = await db.organization.findUnique({
          where: { id },
          select: { id: true, urn: true, deletedAt: true },
        });
        return org && !org.deletedAt
          ? { kind: 'organization', org: { id: org.id, urn: org.urn } }
          : null;
      }
      case 'user': {
        // `hrn:user:<handle>` — recognized by the injected parseType for the
        // audit surface (the core URN parser does not address users). A user is
        // keyed by their unique handle; resolveUserRef maps it to the id.
        const { id } = await deps.resolveUserRef(db, ref);
        const user = await db.user.findUnique({
          where: { id },
          select: { id: true, handle: true, deletedAt: true },
        });
        // The form is handle-only, so a soft-deleted OR handle-less user has no
        // `hrn:user:` address → NOT_FOUND (never emit a non-resolvable id-URN).
        return user && !user.deletedAt && user.handle !== null
          ? { kind: 'user', user: { id: user.id, handle: user.handle } }
          : null;
      }
      default: {
        // No type word. A bare id (no scheme) is treated as an
        // AiServiceConfig id — the only URN-less resource kind; memory / app /
        // agent / node / org / user all require a typed URN to disambiguate,
        // exactly like resolveUrn. Anything else (e.g. a loc) is not an
        // auditable resource → null.
        if (!isId(ref)) return null;
        const config = await db.aiServiceConfig.findUnique({
          where: { id: ref },
          select: {
            id: true,
            hadronServerId: true,
            organizationId: true,
            appId: true,
            agentId: true,
          },
        });
        return config ? { kind: 'aiServiceConfig', config } : null;
      }
    }
  } catch {
    // Entity-ref resolvers throw NotFound for unknown refs — collapse to null.
    return null;
  }
}
