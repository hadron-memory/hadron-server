/**
 * #5412 section 5 (gate rulings issuecomment-7238580841 and issuecomment-7238581276): the MCP side of the branch arm. A memory a
 * pure App key reads ONLY through `memory.read` grants that carry a `branch` is a branch-only memory: MCP's node read tools
 * (`hadron_get_node`, `hadron_get_nodes`, `hadron_list_nodes`, `hadron_find_nodes`) admit its nodes inside the branch, and every
 * other MCP door keeps refusing it, because it never joins the MCP principal access ({@link canReadMemory} stays false for it).
 *
 * Computed per call, never cached across calls: a revoked or expired grant holds from the caller's next call.
 */
import type { PrismaClient } from '@prisma/client';
import type { AuthContext } from '../middleware/auth.js';
import { grantReadReachDetailFor } from '../lib/grants/readGrant.js';
import { NO_BRANCHES, branchOnly, type BranchScopes } from '../lib/grants/branchRead.js';
import { EXPLICIT_REF, canReadMemory } from './access-control.js';

/** Memory id → the branch prefixes, for every memory this caller reads only in part (whole-memory routes always win). */
export async function mcpNodeBranchScopes(db: PrismaClient, auth: AuthContext): Promise<BranchScopes> {
  const detail = await grantReadReachDetailFor(db, auth);
  if (detail.branches.size === 0) return NO_BRANCHES;
  const whole: string[] = [];
  for (const id of detail.branches.keys()) {
    if (await canReadMemory(db, auth, id, EXPLICIT_REF)) whole.push(id);
  }
  return branchOnly(detail.branches, whole);
}

/** The branch prefixes `memoryId` is read under by this caller, or undefined when it is read whole or not at all. */
export async function mcpBranchPrefixesFor(db: PrismaClient, auth: AuthContext, memoryId: string): Promise<readonly string[] | undefined> {
  const detail = await grantReadReachDetailFor(db, auth, [memoryId]);
  const prefixes = detail.branches.get(memoryId);
  if (!prefixes || prefixes.length === 0) return undefined;
  if (await canReadMemory(db, auth, memoryId, EXPLICIT_REF)) return undefined;
  return prefixes;
}
