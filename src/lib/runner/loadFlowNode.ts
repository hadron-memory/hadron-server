/**
 * Tenant-scoped flow-node resolution — shared by the production run deps
 * (assemble/selectNext/writeOutput) and the run tools (plan-tools phase 3).
 * Lives here rather than in appRunDeps so tools ← registry ← deps stays
 * acyclic.
 *
 * Two guards every flow touch inherits (PR-493 / PR-532 review lineage):
 *  - a URN resolves only inside the run's own tenant (#5077: its App's owner, an organization or a person) — cross-tenant
 *    reads are not a run capability in v1 regardless of URN knowledge;
 *  - encrypted memories are denied on EVERY hop/touch, not just the entry
 *    (spec 041 D-2026-07-06-B — the run has no session key).
 */

import { canReadMemory } from '../../mcp/access-control.js';
import type { AuthContext } from '../../middleware/auth.js';
import type { PrismaClient } from '../../generated/prisma/index.js';
import { type OwnerRef, ownedBy } from '../owner.js';
import { splitNodeUrn, normalizeUrnForLookup, legacyMemoryUrnToCanonical } from '../urn.js';

export async function resolveFlowMemory(
  db: PrismaClient,
  memoryUrn: string,
  /** #5077: the run's tenant, an organization or a person. The filter states BOTH owner columns (never `IS NULL` alone). */
  tenant: OwnerRef,
  forUrn: string,
) {
  const normalized = normalizeUrnForLookup(memoryUrn);
  const memory = await db.memory.findFirst({
    where: {
      OR: [{ urn: normalized }, { urn: legacyMemoryUrnToCanonical(normalized) }],
      ...ownedBy(tenant),
      deletedAt: null,
    },
    select: { id: true, urn: true, isEncrypted: true },
  });
  if (!memory) throw new Error(`Flow memory not found for "${forUrn}".`);
  if (memory.isEncrypted) {
    throw new Error(
      `Headless runs are unavailable on encrypted memories — flow routed into "${forUrn}".`,
    );
  }
  return memory;
}

export async function loadFlowNode(db: PrismaClient, nodeUrn: string, tenant: OwnerRef, principal: AuthContext) {
  const { memoryUrn, loc } = splitNodeUrn(nodeUrn);
  const memory = await resolveFlowMemory(db, memoryUrn, tenant, nodeUrn);
  if (!await canReadMemory(db, principal, memory.id)) throw new Error(`Flow memory not readable under the run principal.`);
  const node = await db.node.findUnique({
    where: { loc_memoryId: { loc, memoryId: memory.id } },
    select: { id: true, name: true, data: true, content: true, deletedAt: true },
  });
  if (!node || node.deletedAt) throw new Error(`Flow node not found: "${nodeUrn}".`);
  return { memory, loc, node };
}
