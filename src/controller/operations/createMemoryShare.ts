/**
 * createMemoryShare — spec 023-app-shape US3 (T039).
 *
 * Asymmetric cross-user grant on a personal-class Memory. The
 * principal (Memory.userId) grants a grantee read or write access.
 * Used for the per-pairing pattern (e.g., Alice grants Mentor A
 * access to her paired-with-A Memory, separately from her
 * paired-with-B Memory).
 *
 * Invariants enforced (spec 023):
 *   - **FR-018** class scoping: Memory MUST have class = 'personal'.
 *     Other classes throw INVALID_MEMORY_CLASS_FOR_SHARE.
 *   - **FR-019** grantor identity: `grantorId` is set to the
 *     Memory's principal (`memory.userId`), NOT the API actor.
 *     The actor identity is recorded in `createdBy`.
 *   - **FR-020** role: `reader` or `writer` only (enforced by the
 *     Prisma enum; rejected with a typed error if otherwise).
 *
 * **Caller-authority guard** (per spec 023 contracts/graphql-app-shape.md):
 * for v1 the caller MUST be the principal themselves (Memory.userId
 * === actor). The Agent-mediated path (App backend acting on the
 * principal's behalf via MCP) is supported by the auth predicate
 * but not by this CRUD surface yet — see the resolver-layer caller
 * check + the TODO in joinApp.ts for the broader policy discussion.
 *
 * Idempotent on the (memoryId, granteeId) PK — if a row already
 * exists, its role is updated to the supplied value rather than
 * the call throwing.
 */

import type {
  PrismaClient,
  MemoryShareRole,
  MemoryShare,
} from '../../generated/prisma/index.js';

export class InvalidMemoryClassForShareError extends Error {
  constructor(memoryId: string, actualClass: string) {
    super(
      `Cannot share memory ${memoryId}: only personal-class memories can be ` +
        `shared with an individual user, but this memory is class='${actualClass}' ` +
        `(spec 023 FR-018). Check Memory.shareable before attempting a share.`,
    );
    this.name = 'InvalidMemoryClassForShareError';
  }
}

export class MemoryNotFoundForShareError extends Error {
  constructor(memoryId: string) {
    super(`Memory ${memoryId} does not exist or has been deleted.`);
    this.name = 'MemoryNotFoundForShareError';
  }
}

export class MemoryShareGranteeMissingError extends Error {
  constructor(granteeId: string) {
    super(`Grantee user ${granteeId} does not exist.`);
    this.name = 'MemoryShareGranteeMissingError';
  }
}

/**
 * An ORG-OWNED personal memory (organizationId set) may be shared only with a
 * current member of that same org (#778). A free-standing (org-less) personal
 * memory has no such restriction — its owner may share it with anyone. This
 * keeps a share from handing a cross-org user the full org-owned Memory, whose
 * nested `organization → apps → keys/members` fields would otherwise leak the
 * owning org's secrets (the #552 nested-read-gate class).
 */
export class CrossOrgShareNotAllowedError extends Error {
  constructor(organizationId: string) {
    super(
      `An org-owned personal memory can only be shared with a member of its ` +
        `organization (${organizationId}). To share with someone outside the org, ` +
        `use a free-standing personal memory (created without an orgId).`,
    );
    this.name = 'CrossOrgShareNotAllowedError';
  }
}

export async function createMemoryShare(
  db: PrismaClient,
  args: {
    memoryId: string;
    granteeId: string;
    role: MemoryShareRole;
    /** Actor identity recorded in `createdBy`. May differ from the
     *  Memory's principal (e.g., App backend acting on behalf). */
    actorId: string;
  },
): Promise<MemoryShare> {
  const memory = await db.memory.findUnique({
    where: { id: args.memoryId },
    select: {
      id: true,
      class: true,
      userId: true,
      organizationId: true,
      userMemoryOfAgentId: true,
      deletedAt: true,
    },
  });
  if (!memory || memory.deletedAt) {
    throw new MemoryNotFoundForShareError(args.memoryId);
  }
  if (memory.class !== 'personal') {
    throw new InvalidMemoryClassForShareError(args.memoryId, memory.class);
  }
  if (!memory.userId) {
    // chk_personal_visibility_user should guarantee userId is set for
    // personal-class rows. Defensive fail-closed if a stale row slips
    // through (matches the auth predicate's invariant guard).
    throw new MemoryNotFoundForShareError(args.memoryId);
  }
  // Confirm the grantee exists (a stale userId reference would FK-cascade
  // on grantee delete, but a typed up-front error gives clearer feedback).
  const grantee = await db.user.findUnique({
    where: { id: args.granteeId },
    select: { id: true, deletedAt: true },
  });
  if (!grantee || grantee.deletedAt) {
    throw new MemoryShareGranteeMissingError(args.granteeId);
  }
  // #778 — a plain org-owned personal memory stays inside its org: the grantee
  // MUST be a current member of the memory's org. A free-standing (org-less)
  // personal memory skips this check. AGENT-SCOPED personal memories
  // (userMemoryOfAgentId set — the spec-023 per-pairing App/mentor pattern) are
  // ALSO exempt: their sharing is governed by AppMember + AgentSubscription (the
  // resolveMemoryAuthorization predicate), not org membership, and they are never
  // surfaced through the portal's sharedWithMe list / read gate (both exclude
  // userMemoryOfAgentId rows), so no cross-org portal leak arises. findFirst +
  // deletedAt: null so a REVOKED membership no longer qualifies.
  if (memory.organizationId !== null && memory.userMemoryOfAgentId === null) {
    const member = await db.orgMember.findFirst({
      where: { organizationId: memory.organizationId, userId: args.granteeId, deletedAt: null },
      select: { userId: true },
    });
    if (!member) {
      throw new CrossOrgShareNotAllowedError(memory.organizationId);
    }
  }
  // FR-019: grantor = principal, always. The acting party is `actorId`
  // recorded in `createdBy` — distinct from `grantorId`.
  const grantorId = memory.userId;
  return db.memoryShare.upsert({
    where: {
      memoryId_granteeId: { memoryId: args.memoryId, granteeId: args.granteeId },
    },
    create: {
      memoryId: args.memoryId,
      granteeId: args.granteeId,
      grantorId,
      role: args.role,
      createdBy: args.actorId,
    },
    update: {
      role: args.role,
      updatedBy: args.actorId,
    },
  });
}
