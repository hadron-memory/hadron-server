/**
 * The org-role ordering, in a module BOTH authorization layers can import.
 *
 * It was declared in `resolvers.helpers.ts`, which imports from
 * `src/mcp/access-control.ts` — so the MCP layer could not import it back
 * without a cycle, and any rule it needed there had to be written out a second
 * time. A second copy of a role threshold is how gates drift, which is the
 * defect class #1196 exists to remove rather than add to.
 *
 * `resolvers.helpers.ts` re-exports {@link ROLE_ORDER} so its existing
 * importers are unchanged (the `mentionTokenOf` precedent, PR #978).
 */

/**
 * Org roles, ascending. A role satisfies a requirement when its rank is greater
 * than or equal to the requirement's — the comparison `requireOrgRole` makes.
 */
export const ROLE_ORDER: Record<string, number> = { READER: 0, CONTRIBUTOR: 1, ADMIN: 2, OWNER: 3 };

/**
 * Does `role` satisfy `required`? An unknown role ranks below every
 * requirement (`-1`), so a role added to the enum without being added here
 * fails CLOSED rather than silently satisfying a threshold.
 */
export function orgRoleAtLeast(
  role: string | null | undefined,
  required: 'OWNER' | 'ADMIN' | 'CONTRIBUTOR' | 'READER',
): boolean {
  return (ROLE_ORDER[role ?? ''] ?? -1) >= ROLE_ORDER[required];
}
