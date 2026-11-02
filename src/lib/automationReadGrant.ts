/**
 * #2883 (ruling 0079 = A; hrn:node:hadronmemory.com:specs:cor:agt:010:01, the read-grant rule;
 * hrn:node:hadronmemory.com:specs:cor:acl:010:01, the system row): an automation's READ grant.
 *
 * "The automation" a grant belongs to is the run's ROOT TRIGGER: the `AgentSchedule` or `AgentWebhook` row that holds
 * the adoption pin (Vera, team chat #66533, Q1). `AutomationVersion` is the #1655 signed-JSON store and no run reads
 * it. Runs that descend from a trigger (SPAWN children, routed runs, INTEGRATION runs) carry their root trigger's
 * grant, as they are held to its adoption; a MANUAL run has no trigger and so no grant (Q2).
 *
 * This file is the key-independent half. How a grant row is keyed to the trigger (carry over a re-adoption, or end at
 * any change) waits on ruling 0081 and is not built here.
 */
import type { PrismaClient } from '../generated/prisma/index.js';

export type ReadGrantTriggerKind = 'SCHEDULE' | 'WEBHOOK';
export interface RootTrigger { kind: ReadGrantTriggerKind; id: string }

/** Lineage depth cap, the same bound `currentOriginPin` (src/lib/automation/pins.ts) applies to a run's ancestry. */
const MAX_LINEAGE = 100;

/**
 * The live root trigger of a run, or null. Walks `parentRunId` from the run to the first SCHEDULE or WEBHOOK run and
 * returns that trigger when its row is live (`deletedAt` null) and belongs to the run's own App. Null, never a throw,
 * for every other shape, since a grant lookup can only ever admit: a MANUAL ancestor (a manual launch acts as its own
 * trigger, and holds no grant), a missing run or trigger, a deleted trigger, a cycle or a lineage past the cap, an
 * ancestor in another App.
 */
export async function rootTriggerOfRun(
  db: Pick<PrismaClient, 'appRun' | 'agentSchedule' | 'agentWebhook'>,
  runId: string,
): Promise<RootTrigger | null> {
  const seen = new Set<string>();
  let appId: string | null = null;
  for (let id: string | null = runId; id;) {
    if (seen.has(id) || seen.size >= MAX_LINEAGE) return null;
    seen.add(id);
    const run: { appId: string; triggerKind: string; triggerId: string | null; parentRunId: string | null } | null =
      await db.appRun.findUnique({ where: { id }, select: { appId: true, triggerKind: true, triggerId: true, parentRunId: true } });
    if (!run) return null;
    if (appId === null) appId = run.appId;
    else if (run.appId !== appId) return null;
    if (run.triggerKind === 'MANUAL') return null;
    if (run.triggerKind === 'SCHEDULE' || run.triggerKind === 'WEBHOOK') {
      if (!run.triggerId) return null;
      const where = { id: run.triggerId, appId, deletedAt: null };
      const live = run.triggerKind === 'SCHEDULE'
        ? await db.agentSchedule.findFirst({ where, select: { id: true } })
        : await db.agentWebhook.findFirst({ where, select: { id: true } });
      return live ? { kind: run.triggerKind, id: live.id } : null;
    }
    id = run.parentRunId;
  }
  return null;
}
