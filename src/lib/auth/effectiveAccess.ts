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
 * NO MORE permissive than the real gates — for `group` it is slightly
 * STRICTER than `getOrgReadableMemoryIds` (which currently also lets any org
 * member read group memories); we follow the spec's MemoryMember rule and
 * never reveal access a per-table query wouldn't.
 *
 * Capabilities are derived from the grants, so an empty grant list always
 * means no access (canRead/canWrite/canManage/canDelete all false, role null).
 */

import type { PrismaClient } from '../../generated/prisma/index.js';
import { isActiveAgentSubscription } from '../agentSubscription.js';
import { isLifecycleActive } from '../lifecycle.js';
import { composeNodeUrn } from '../urn.js';
import { isId } from '../entityRef/shape.js';

// ─── Public types ─────────────────────────────────────────────────────────

export type ResourceKind = 'memory' | 'node' | 'app' | 'agent' | 'aiServiceConfig';

export type AccessSource =
  | 'PLATFORM_ROLE'
  | 'ORG_ROLE'
  | 'MEMORY_PRINCIPAL'
  | 'MEMORY_MEMBER'
  | 'MEMORY_SHARE'
  | 'NODE_INHERITED'
  | 'APP_MEMBER'
  | 'AGENT_SUBSCRIPTION'
  | 'AICONFIG_OWNER'
  | 'PUBLIC_VISIBILITY';

export interface AccessGrant {
  source: AccessSource;
  /** The role/level this particular grant confers. */
  role: string;
  /** Human label for the grant's origin (org/app/memory URN, etc.). */
  via: string | null;
}

export interface EffectiveAccessResult {
  userId: string;
  resourceUrn: string;
  resourceKind: ResourceKind;
  canRead: boolean;
  canWrite: boolean;
  canManage: boolean;
  canDelete: boolean;
  /** Highest clean role label, or null for capability-based / no access. */
  role: string | null;
  /** Strongest-first; empty means no access. */
  grants: AccessGrant[];
}

/** Subject whose access we are resolving. */
export interface Subject {
  id: string;
  roles: ('OWNER' | 'ADMIN' | 'CONTRIBUTOR' | 'READER')[];
}

// ─── Internal grant shape (carries capability bits) ─────────────────────────

interface Caps {
  read: boolean;
  write: boolean;
  manage: boolean;
  delete: boolean;
}

interface InternalGrant extends AccessGrant {
  caps: Caps;
}

const NONE: Caps = { read: false, write: false, manage: false, delete: false };
const READ: Caps = { read: true, write: false, manage: false, delete: false };
const WRITE: Caps = { read: true, write: true, manage: false, delete: false };
const FULL: Caps = { read: true, write: true, manage: true, delete: true };

function strength(c: Caps): number {
  return (c.manage ? 8 : 0) + (c.delete ? 4 : 0) + (c.write ? 2 : 0) + (c.read ? 1 : 0);
}

/** Sources whose `role` is a capability, not a clean role label. */
const CAPABILITY_SOURCES: ReadonlySet<AccessSource> = new Set<AccessSource>([
  'AGENT_SUBSCRIPTION',
  'PUBLIC_VISIBILITY',
]);

// ─── Resource resolution ────────────────────────────────────────────────────

type MemoryForAccess = {
  id: string;
  urn: string;
  class: 'system' | 'app' | 'knowledge' | 'personal' | 'group' | 'private';
  visibility: 'PUBLIC' | 'ORGANIZATION' | 'GROUP' | null;
  userId: string | null;
  appId: string | null;
  userMemoryOfAgentId: string | null;
  organizationId: string;
};

const MEMORY_SELECT = {
  id: true,
  urn: true,
  class: true,
  visibility: true,
  userId: true,
  appId: true,
  userMemoryOfAgentId: true,
  organizationId: true,
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
  | { kind: 'app'; app: { id: string; urn: string; organizationId: string } }
  | { kind: 'agent'; agent: { id: string; urn: string; organizationId: string } }
  | { kind: 'aiServiceConfig'; config: ConfigForAccess };

// ─── Org-role helper ────────────────────────────────────────────────────────

const ROLE_ORDER: Record<string, number> = { READER: 0, CONTRIBUTOR: 1, ADMIN: 2, OWNER: 3 };

function isPlatformAdmin(roles: Subject['roles']): boolean {
  return roles.includes('ADMIN') || roles.includes('OWNER');
}

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

  // Owning-org role. Mirrors the ENFORCED gates, not the (narrower) predicate:
  //   - ADMIN/OWNER → full: requireMemoryWriteAccess grants write,
  //     deleteMemory/cloneMemory grant manage/delete.
  //   - CONTRIBUTOR → read+write: requireMemoryWriteAccess grants any org
  //     CONTRIBUTOR+ write on a non-personal/private memory, regardless of
  //     class.
  //   - READER → read on knowledge/group org memories only
  //     (getOrgReadableMemoryIds; app-class is reached via AppMember, not org
  //     membership).
  const memberRole = await orgMemberRole(db, memory.organizationId, subject.id);
  if (memberRole === 'ADMIN' || memberRole === 'OWNER') {
    grants.push({
      source: 'ORG_ROLE',
      role: memberRole,
      via: await orgUrn(db, memory.organizationId),
      caps: FULL,
    });
  } else if (memberRole === 'CONTRIBUTOR') {
    grants.push({
      source: 'ORG_ROLE',
      role: memberRole,
      via: await orgUrn(db, memory.organizationId),
      caps: WRITE,
    });
  } else if (memberRole === 'READER' && (memory.class === 'knowledge' || memory.class === 'group')) {
    grants.push({
      source: 'ORG_ROLE',
      role: memberRole,
      via: await orgUrn(db, memory.organizationId),
      caps: READ,
    });
  }

  // PUBLIC visibility → readable by anyone.
  if (memory.visibility === 'PUBLIC') {
    grants.push({ source: 'PUBLIC_VISIBILITY', role: 'reader', via: null, caps: READ });
  }

  if (memory.class === 'app' && memory.appId) {
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
 * App access. Membership confers use (read+write at the App level); an
 * owner/admin member, the owning-org admin, or a platform admin can manage.
 */
async function appGrants(
  db: PrismaClient,
  subject: Subject,
  app: { id: string; organizationId: string },
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
  agent: { id: string; organizationId: string },
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
    where: { userId: subject.id, deletedAt: null },
    select: { organizationId: true },
  });
  const orgIds = memberships.map((m) => m.organizationId);
  if (orgIds.length > 0) {
    const orgGrants = await db.agentOrgGrant.findMany({
      where: { agentId: agent.id, orgId: { in: orgIds } },
    });
    for (const grant of orgGrants) {
      if (!isLifecycleActive(grant)) continue;
      grants.push({
        source: 'AGENT_SUBSCRIPTION',
        role: 'org-grant',
        via: await orgUrn(db, grant.orgId),
        caps: READ,
      });
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

// ─── Assembly ───────────────────────────────────────────────────────────────

function assemble(
  userId: string,
  resourceUrn: string,
  resourceKind: ResourceKind,
  grants: InternalGrant[],
): EffectiveAccessResult {
  // Strongest-first; stable for equal strength.
  const ordered = [...grants].sort((a, b) => strength(b.caps) - strength(a.caps));
  const caps = grants.reduce<Caps>(
    (acc, g) => ({
      read: acc.read || g.caps.read,
      write: acc.write || g.caps.write,
      manage: acc.manage || g.caps.manage,
      delete: acc.delete || g.caps.delete,
    }),
    { ...NONE },
  );

  const strongest = ordered[0];
  const role =
    strongest && !CAPABILITY_SOURCES.has(strongest.source) ? strongest.role : null;

  return {
    userId,
    resourceUrn,
    resourceKind,
    canRead: caps.read,
    canWrite: caps.write,
    canManage: caps.manage,
    canDelete: caps.delete,
    role,
    grants: ordered.map(({ source, role: r, via }) => ({ source, role: r, via })),
  };
}

/**
 * Compute the subject's effective access to a resolved resource. The caller is
 * responsible for authorizing WHO may invoke this (see `callerCanAudit`) and
 * for resolving the resource ref first (see `resolveResource`).
 */
export async function computeEffectiveAccess(
  db: PrismaClient,
  subject: Subject,
  resolved: ResolvedResource,
): Promise<EffectiveAccessResult> {
  switch (resolved.kind) {
    case 'memory': {
      const grants = await memoryGrants(db, subject, resolved.memory);
      return assemble(subject.id, resolved.memory.urn, 'memory', grants);
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
      // composeNodeUrn canonicalizes (and validates) the memory URN; the
      // resourceUrn is cosmetic, so fall back to a plain join rather than
      // failing the whole query on a non-canonical stored memory URN.
      let nodeUrn: string;
      try {
        nodeUrn = composeNodeUrn(resolved.memory.urn, resolved.node.loc);
      } catch {
        nodeUrn = `hrn:node:${resolved.memory.urn}::${resolved.node.loc}`;
      }
      return assemble(subject.id, nodeUrn, 'node', inherited);
    }
    case 'app': {
      const grants = await appGrants(db, subject, resolved.app);
      return assemble(subject.id, resolved.app.urn, 'app', grants);
    }
    case 'agent': {
      const grants = await agentGrants(db, subject, resolved.agent);
      return assemble(subject.id, resolved.agent.urn, 'agent', grants);
    }
    case 'aiServiceConfig': {
      const grants = await aiServiceConfigGrants(db, subject, resolved.config);
      // AiServiceConfig has no URN; echo the id as the resource identifier.
      return assemble(subject.id, resolved.config.id, 'aiServiceConfig', grants);
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
      return isOrgAdmin(memory.organizationId);
    }
    case 'app':
      return isOrgAdmin(resolved.app.organizationId);
    case 'agent':
      return isOrgAdmin(resolved.agent.organizationId);
    case 'aiServiceConfig': {
      const c = resolved.config;
      if (c.organizationId) return isOrgAdmin(c.organizationId);
      if (c.appId) {
        const app = await db.app.findUnique({
          where: { id: c.appId },
          select: { organizationId: true },
        });
        return app ? isOrgAdmin(app.organizationId) : false;
      }
      if (c.agentId) {
        const agent = await db.agent.findUnique({
          where: { id: c.agentId },
          select: { organizationId: true },
        });
        return agent ? isOrgAdmin(agent.organizationId) : false;
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
  },
): Promise<ResolvedResource | null> {
  const type = deps.parseType(ref);

  const loadMemory = async (id: string): Promise<MemoryForAccess | null> => {
    const m = await db.memory.findUnique({ where: { id }, select: MEMORY_SELECT });
    if (!m || m.deletedAt) return null;
    const { deletedAt: _omit, ...rest } = m;
    return rest as MemoryForAccess;
  };

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
          select: { id: true, urn: true, organizationId: true },
        });
        return app ? { kind: 'app', app } : null;
      }
      case 'agent': {
        const { id } = await deps.resolveAgentRef(db, ref);
        const agent = await db.agent.findUnique({
          where: { id },
          select: { id: true, urn: true, organizationId: true },
        });
        return agent ? { kind: 'agent', agent } : null;
      }
      default: {
        // No type word. A bare id (no scheme) is treated as an
        // AiServiceConfig id — the only URN-less resource kind; memory / app /
        // agent / node all require a typed URN to disambiguate, exactly like
        // resolveUrn. Anything else (e.g. an hrn:org: URN, a loc) is not an
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
