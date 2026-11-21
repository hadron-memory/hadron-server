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
import { endGrantsOfAgentsNoLongerInstalled, fenceAppsForWitnessDelete, liveAppsWhereInstalled } from '../../lib/grants/agentInstallDeparture.js';

/**
 * #4318 test seam: runs between the first fence and the re-read (no-op in production). A concurrency pin parks two removals
 * here to land installs between their reads and form the crossed-fence cycle; nothing else may set it.
 */
export const removeAgentImportHooks: { betweenFenceReads?: (parentAgentId: string) => Promise<void> } = {};

export async function removeAgentImport(
  tx: Prisma.TransactionClient,
  parentAgentId: string,
  importedAgentId: string,
  removedBy: string | null = null,
): Promise<void> {
  // Fence every App the edge could witness an install in BEFORE the delete (two parents' removals would otherwise deadlock on
  // each other's post-delete witness scans, #4210 F1), then re-read: an App the parent was installed in meanwhile is fenced too.
  const fenced = new Set(await fenceAppsForWitnessDelete(tx, await liveAppsWhereInstalled(tx, parentAgentId)));
  await removeAgentImportHooks.betweenFenceReads?.(parentAgentId);
  // #4318: this second batch is sorted, but not together with the first, so two removals whose parents were installed into
  // each other's Apps between their reads can 40P01 here; the resolver retries the whole transaction (retryOnDeadlock).
  const apps = await liveAppsWhereInstalled(tx, parentAgentId);
  await fenceAppsForWitnessDelete(tx, apps.filter((a) => !fenced.has(a)));
  // Idempotent: a missing row is a no-op (deleteMany never throws on it); any other error surfaces.
  const gone = await tx.agentImport.deleteMany({ where: { parentAgentId, importedAgentId } });
  if (gone.count === 0) return;
  // Candidates are named AFTER the delete from the imported agent we already hold, over the Apps seen before AND after it: a parent
  // installed in a new App between the reads is not missed (#4210 §10 P3-2). Extra candidates are harmless, each is judged.
  const after = await liveAppsWhereInstalled(tx, parentAgentId);
  const pairs = [...new Set([...apps, ...after])].map((appId) => ({ appId, agentId: importedAgentId }));
  await endGrantsOfAgentsNoLongerInstalled(tx, pairs, removedBy, 'AGENT_IMPORT_REMOVED');
}
