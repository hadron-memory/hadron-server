/**
 * #4041 (V82/V83, hrn:node:hadronmemory.com:hadron-dev-team-shared:decisions:2026-11-12-vera-rulings-host-repair-notice;
 * hrn:node:hadronmemory.com:specs:cor:agt:070:01) — the notice a host's repair outcome produces.
 *
 * The host key writes only reports (cor:agt:070:04, unchanged); the PLATFORM posts, as the system author of the wake-budget
 * notice (cor:agt:080:15), never as a worker, a person or the key. A relaunch posts one line. A no-snapshot or cap-reached
 * outcome posts one alert per worker, mentioning the dark worker's chain (the worker it reports to, else whoever manages the
 * App: cor:agt:050:18 to :20), never a recipient resolved by role name. The mentions are filled here from the chain; nothing
 * in the report or the body adds a recipient.
 *
 * Dedupe is `workers.repair_notice_key`, claimed in the post's own append transaction: `alert` (one alert per worker, re-armed
 * by a report without a repair outcome or with a relaunch) or `relaunched:<checkedAt>` (a replayed relaunch posts nothing).
 */
import type { PrismaClient } from '../../generated/prisma/index.js';
import { mentionTokenOf } from '../mentionToken.js';
import { darkAlarmChain } from './darkWorker.js';
import type { TerminalRepair } from '../workerTerminal.js';

export const ALERT_KEY = 'alert';

export type RepairNotice = {
  workerId: string;
  workerName: string;
  hostLabel: string;
  repair: TerminalRepair;
  attempt: number | null;
  checkedAt: Date;
};

/** The marker a notice claims, or null for none. */
export const noticeKey = (n: Pick<RepairNotice, 'repair' | 'checkedAt'>): string =>
  n.repair === 'RELAUNCHED' ? `relaunched:${n.checkedAt.toISOString()}` : ALERT_KEY;

/** The line posted. Plain text: the poster neutralises any `@` in a name. */
export function noticeBody(n: RepairNotice): string {
  if (n.repair === 'RELAUNCHED') return `${n.workerName} was relaunched on ${n.hostLabel} (attempt ${n.attempt}).`;
  const why = n.repair === 'NO_SNAPSHOT' ? 'it has no launch snapshot' : 'the relaunch attempt cap was reached';
  return `${n.workerName} is dark on ${n.hostLabel} and was not relaunched: ${why}.`;
}

/** Mention tokens for the dark worker's chain: the nearest worker it reports to, else every App manager. */
async function chainTokens(db: PrismaClient, appId: string, workerId: string): Promise<string[]> {
  const app = await db.app.findUnique({ where: { id: appId }, select: { id: true, organizationId: true, ownerUserId: true } });
  if (!app) return [];
  const chain = await darkAlarmChain(db, app, workerId);
  if (chain.length === 0) return [];
  if (chain[0]!.workerId) {
    const w = await db.worker.findUnique({ where: { id: chain[0]!.workerId }, select: { name: true } });
    const t = w ? mentionTokenOf(w.name) : null;
    return t ? [t] : [];
  }
  const users = await db.user.findMany({ where: { id: { in: chain.map((p) => p.userId as string) } }, select: { handle: true } });
  return users.map((u) => u.handle).filter((h): h is string => !!h).map((h) => h.toLowerCase());
}

/**
 * Post each notice after the report committed. A failed or chat-less post leaves its marker unclaimed, so the host's next
 * report retries it; one notice's failure never fails the report or the other notices.
 */
export async function postRepairNotices(db: PrismaClient, appId: string, notices: readonly RepairNotice[]): Promise<void> {
  if (notices.length === 0) return;
  const { postSystemNotice } = await import('../../api/graphql/schema/resolvers.teamChat.js');
  for (const n of notices) {
    try {
      const key = noticeKey(n);
      const mentions = n.repair === 'RELAUNCHED' ? [] : await chainTokens(db, appId, n.workerId);
      await postSystemNotice(
        db,
        appId,
        noticeBody(n),
        async (tx) => (await tx.$executeRaw`UPDATE workers SET repair_notice_key = ${key} WHERE id = ${n.workerId} AND repair_notice_key IS DISTINCT FROM ${key}`) > 0,
        mentions,
      );
    } catch (err) {
      console.error(`[host-repair-notice] posting for worker ${n.workerId} failed:`, err);
    }
  }
}
