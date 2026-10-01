/**
 * #1370 — the ONE predicate for "this user is a live member of a live org".
 *
 * `softDeleteOrganizationCore` stamps `Organization.deletedAt` and deliberately
 * keeps every `OrgMember` row (they are the audit record). Every membership
 * read used to filter only the MEMBERSHIP's `deletedAt`, never the org's, so a
 * deleted org's former members kept their former role at every gate:
 * mutations, reads, enumeration and the MCP org-readable set.
 *
 * Spread this into the `where` of every `orgMember` read that authorizes or
 * enumerates for a caller (`...LIVE_ORG_MEMBERSHIP`), instead of writing
 * `deletedAt: null` by hand. Gates and lists must move together, or the
 * list-vs-gate drift of #362 comes back. Reads that manage or clean up rows
 * (member management behind `requireOrgRole`, `deleteUser`) intentionally see
 * dead orgs' rows too; `src/lib/auth/liveOrgMembership.test.ts` keeps the list
 * of those exceptions explicit, so a new authorizing read cannot forget this.
 *
 * Membership revocation (the row's own `deletedAt`) keeps working exactly as
 * before (PR #475): this adds the org's liveness, it does not replace it.
 */
export const LIVE_ORG_MEMBERSHIP = {
  deletedAt: null,
  organization: { deletedAt: null },
} as const;
