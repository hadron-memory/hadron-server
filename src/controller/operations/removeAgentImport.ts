/**
 * Delete a dependency edge between two Agents. Per spec 008-agent-installation
 * FR-005 / User Story 3.
 *
 * Existing Apps that already installed the imported Agent keep their installation ROWS — removing the AgentImport row only
 * stops *future* installations of the parent from cascading the dep. #4172 (Holger ruling A, epic #1975): an imported Agent
 * installed in an App ONLY by derivation through this edge has left that App, so its grants there end (an Agent still
 * installed by row, or by another importing parent, keeps them).
 *
 * The mutation is idempotent: deleting a row that doesn't exist is a no-op.
 * Authorization happens at the GraphQL resolver layer (ADMIN/OWNER of the
 * parent Agent's owning org), re-judged by the caller inside the transaction `tx`.
 */

import type { Prisma } from '../../generated/prisma/index.js';
import { endGrantsOfAgentsNoLongerInstalled, importedPairsOfParent, liveAppsWhereInstalled } from '../../lib/grants/agentInstallDeparture.js';

export async function removeAgentImport(
  tx: Prisma.TransactionClient,
  parentAgentId: string,
  importedAgentId: string,
  removedBy: string | null = null,
): Promise<void> {
  // The Apps the edge could have witnessed an install in, read BEFORE the edge goes (the edge is what the pairs are named from).
  const apps = await liveAppsWhereInstalled(tx, parentAgentId);
  const pairs = await importedPairsOfParent(tx, parentAgentId, apps, importedAgentId);
  // Idempotent: a missing row is a no-op (deleteMany never throws on it); any other error surfaces.
  const gone = await tx.agentImport.deleteMany({ where: { parentAgentId, importedAgentId } });
  if (gone.count === 0) return;
  await endGrantsOfAgentsNoLongerInstalled(tx, pairs, removedBy);
}
