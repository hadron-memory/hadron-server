/**
 * #4172 (Holger ruling A, epic #1975; cor:acl:140:01, :03): an agent's grants in an App END when the agent has no EFFECTIVE
 * installation left there. "Effective" is `resolveAppInstallation`'s judgement (a physical row, or a derived install through a live
 * importing parent under a usable licence), so deleting one witness while another remains is NOT a departure.
 *
 * One predicate for every door (uninstall, the deprecated alias, an importing parent's uninstall, removeAgentImport,
 * revokeAgentOrgGrant, the soft delete of an importing parent): the door names the (App, agent) pairs its change may have
 * affected, AFTER its own write and under its own anchors, and this function judges each pair under the installation locks and
 * ends the grants of those left with none. No door stamps on a row delete without asking.
 *
 * LOCK ORDER (departure.ts): the door's anchors, then the installation locks here (each App's rows, then every agent in one pass:
 * those judged FOR NO KEY UPDATE, which fences a concurrent agent-grant create, #4715), then the register rows, then ONE sorted grant lock phase last. Nothing is ended
 * inside the per-App loop. Only AGENT-held grants end; a worker's, a person's and an App's are never touched, and reinstalling
 * revives nothing (the SQL guard never lets the stamp clear).
 */
import type { Prisma } from '../../generated/prisma/index.js';
import { lockAppInstallationsFenced, resolveAppInstallation } from '../appInstallations.js';
import { removeRegisterRowsForUninstall } from '../registerInstall.js';
import { endAgentGrantsAtApps, type AgentDepartureReason } from './departure.js';

export interface AppAgentPair { appId: string; agentId: string }
/** #4180: the cause a door records for a pair that departed (the door knows why; this function only judges whether). */
export type PairDepartureReason = AgentDepartureReason | ((pair: AppAgentPair) => AgentDepartureReason);

/** Judge each candidate pair, end the grants of agents with no installation left, return the pairs that departed. */
export async function endGrantsOfAgentsNoLongerInstalled(
  tx: Prisma.TransactionClient,
  candidates: readonly AppAgentPair[],
  removedBy: string | null,
  reason: PairDepartureReason,
): Promise<{ departed: AppAgentPair[]; ended: number }> {
  const unique = [...new Map(candidates.map((p) => [`${p.appId}\u0000${p.agentId}`, p])).values()]
    .sort((a, b) => a.appId.localeCompare(b.appId) || a.agentId.localeCompare(b.agentId));
  const byApp = new Map<string, string[]>();
  for (const p of unique) byApp.set(p.appId, [...(byApp.get(p.appId) ?? []), p.agentId]);
  const departed: AppAgentPair[] = [];
  await lockAppInstallationsFenced(tx, byApp); // every App's structure, then every agent in ONE global pass (#4715)
  for (const [appId, agentIds] of byApp) {
    for (const agentId of agentIds) {
      if (!(await resolveAppInstallation(tx, appId, agentId))) departed.push({ appId, agentId });
    }
  }
  for (const p of departed) await removeRegisterRowsForUninstall(tx, p.appId, p.agentId, removedBy);
  const causeOf = typeof reason === 'function' ? reason : () => reason;
  const ended = await endAgentGrantsAtApps(tx, departed.map((p) => ({ ...p, reason: causeOf(p) })));
  return { departed, ended };
}

/**
 * Fence the Apps a door is about to delete a witness (an app_agents row or an agent_imports edge) from, BEFORE the delete, in id
 * order. Without it two doors on the same App under different anchors (two parents' owners, say) each delete their own witness and
 * then FOR SHARE-scan the other's still-visible one: a lock cycle (40P01, #4210 LOCAL F1). NO KEY UPDATE conflicts with the
 * installation locks' FOR SHARE and with itself, so the second door waits here, holding nothing, and then sees the first one's
 * committed result; it does not conflict with the FOR KEY SHARE an app_agents insert takes. Returns the Apps fenced.
 */
export async function fenceAppsForWitnessDelete(tx: Prisma.TransactionClient, appIds: readonly string[]): Promise<string[]> {
  const ids = [...new Set(appIds)].sort();
  if (ids.length) await tx.$queryRaw`SELECT id FROM apps WHERE id = ANY(${ids}::text[]) ORDER BY id FOR NO KEY UPDATE`;
  return ids;
}

/** The live org Apps in which `parentAgentId` is physically installed (a derived install needs such a witness). */
export async function liveAppsWhereInstalled(tx: Prisma.TransactionClient, parentAgentId: string, organizationId?: string): Promise<string[]> {
  const rows = await tx.appAgent.findMany({
    where: {
      agentId: parentAgentId,
      app: { organizationId: organizationId ?? { not: null }, deletedAt: null, uninstalledAt: null },
    },
    select: { appId: true },
  });
  return rows.map((r) => r.appId);
}

/** Every (App, imported agent) pair a parent's installation may have witnessed: its imports, in the Apps it is installed in. */
export async function importedPairsOfParent(
  tx: Prisma.TransactionClient, parentAgentId: string, appIds: readonly string[], onlyImportedAgentId?: string,
): Promise<AppAgentPair[]> {
  if (!appIds.length) return [];
  const edges = await tx.agentImport.findMany({
    where: { parentAgentId, ...(onlyImportedAgentId ? { importedAgentId: onlyImportedAgentId } : {}) },
    select: { importedAgentId: true },
  });
  return appIds.flatMap((appId) => edges.map((e) => ({ appId, agentId: e.importedAgentId })));
}
