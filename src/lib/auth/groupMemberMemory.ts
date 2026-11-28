/**
 * #5027 / cor:acl:010:01 (Holger R1, 2026-11-27): the ONE predicate for "a group memory this user reaches through its
 * MemoryMember row", shared by the readable set (`getOrgReadableMemoryIds`), the writable set (`getOrgWritableMemoryIds`)
 * and the memory list (`Query.memories`), so the three cannot drift (#362).
 *
 * A group memory is read and written ONLY through MemoryMember: an org role, PUBLIC visibility or a subscription adds
 * nothing (#1208). R1 extends this to a group memory made in an App: its MemoryMembers read and write it, exactly as
 * for an org group. Before R1 the arm required `appId: null` (#653 parity), so no member could reach an App-scoped
 * group. The App-scoped row stays out of every OTHER arm (org role, PUBLIC, subscription): those keep `appId: null`.
 *
 * Per-user holdings (`userMemoryOfAgentId`) and user-owned rows (`ownerUserId`, #758) stay excluded, as before.
 * MemoryMember rows hard-delete on removal (FR-038), so `some` is liveness.
 */
import type { Prisma } from '../../generated/prisma/index.js';

export type GroupMemberRole = 'reader' | 'writer' | 'owner';

export function groupMemberMemoryWhere(
  userId: string,
  opts: { roles?: readonly GroupMemberRole[]; restrictToOrgId?: string | null } = {},
): Prisma.MemoryWhereInput {
  return {
    class: 'group' as never,
    userMemoryOfAgentId: null,
    ownerUserId: null,
    // #3595: an impersonation session's ONE shared org bounds the membership arm.
    ...(opts.restrictToOrgId ? { organizationId: opts.restrictToOrgId } : {}),
    memberships: { some: { userId, ...(opts.roles ? { role: { in: [...opts.roles] } } : {}) } },
  };
}
