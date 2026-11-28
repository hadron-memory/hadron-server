/**
 * The live root trigger (schedule or webhook) of a run. Moved here from src/lib/automationReadGrant.ts when #5404 retired the
 * per-automation read grant (#2883): the run-team read (src/lib/auth/runTeamRead.ts) still keys its snapshot grant on it, and a
 * grant parameter naming one automation (#5412) will too.
 */
import type { PrismaClient } from '../../generated/prisma/index.js';

export type RootTriggerKind = 'SCHEDULE' | 'WEBHOOK';
export interface RootTrigger { kind: RootTriggerKind; id: string }

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
