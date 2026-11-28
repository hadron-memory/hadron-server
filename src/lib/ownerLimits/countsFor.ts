/**
 * #5434 (owner limits; Holger's answer A on cor:acl:150:02): the owner a node COUNTS FOR in the `nodes` limit. The nodes a user
 * writes in their personal memory made under an Agent (`memories.user_memory_of_agent_id` set, class personal or private, so
 * `user_id` is set) count toward that USER, not toward the Agent's organization (or the person who owns the Agent). Every other
 * memory counts for its stored owner (`organization_id` XOR `owner_user_id`). The STORED owner is not changed: it still decides
 * billing, asset ownership, transfers and access; only the count and the doors that judge the count follow this one function.
 *
 * Two forms of the same rule, so they cannot drift: {@link nodesCountedFor} (the SQL predicate on a `memories` row aliased `o`, used
 * by both count paths) and {@link countsForOwnerOf} (the row-level form every door reads). A test holds the two to one answer.
 * `nodeBytes` and `assetBytes` are NOT counted by this rule: they stay on the stored owner until Holger rules them (via Vera).
 */
import { Prisma } from '../../generated/prisma/index.js';
import { ownerRefOf, type OwnerRef } from '../owner.js';

/** The memory columns the rule reads. `userId` and `userMemoryOfAgentId` are optional only so a caller that has no per-Agent memory in hand can omit them. */
export interface CountsForRow {
  organizationId: string | null;
  ownerUserId: string | null;
  userId?: string | null;
  userMemoryOfAgentId?: string | null;
}

/** A user's own memory under an Agent: the shape whose nodes count for the user. A row with no `user_id` falls back to its stored owner. */
export const isPerUserAgentMemory = (m: CountsForRow): boolean => m.userMemoryOfAgentId != null && m.userId != null;

/** The owner `m`'s nodes count for, or null for a row that names none (a gone row). */
export function countsForOwnerOf(m: CountsForRow): OwnerRef | null {
  if (isPerUserAgentMemory(m)) return { userId: m.userId as string };
  return ownerRefOf(m);
}

/**
 * The SQL form of {@link countsForOwnerOf} on a `memories` row aliased `o`: "this memory's nodes count for `owner`". Branches on the
 * owner's kind first and on the per-Agent shape second, so two NULL owner columns never match (finding
 * `org-xor-owner-null-comparison-bypass`). The columns are constants; the ids are bound.
 */
export function nodesCountedFor(owner: OwnerRef): Prisma.Sql {
  const perUserAgent = Prisma.sql`(o.user_memory_of_agent_id IS NOT NULL AND o.user_id IS NOT NULL)`;
  return 'organizationId' in owner
    ? Prisma.sql`(o.organization_id = ${owner.organizationId} AND NOT ${perUserAgent})`
    : Prisma.sql`((o.owner_user_id = ${owner.userId} AND NOT ${perUserAgent}) OR (${perUserAgent} AND o.user_id = ${owner.userId}))`;
}
