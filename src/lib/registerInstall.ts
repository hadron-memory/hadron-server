/**
 * Spec 049 Phase 5 — the install-created register row (D-2026-09-13-007 D2,
 * plan §3.5 / §7.3).
 *
 * Defaults are MATERIALISED: an install writes a real App-owned RegisterEntry
 * for the App's default Channel with the installed Agent as attendee, so it
 * can be switched off like any other row (rejected: derived-and-unstored —
 * "cannot be switched off"; builder-declared — "a forgotten line makes a
 * hermit"). A second install into the same App is a second row because the
 * attendee differs.
 *
 * Kept apart from `register.ts` (the gates) because the install core in
 * `resolvers.helpers.ts` calls this and the gates import that module — a
 * cycle otherwise.
 *
 * The insert is `ON CONFLICT DO NOTHING` on the partial unique — race-safe
 * AND transaction-safe (a caught P2002 would poison an interactive
 * transaction; the quota-row pattern in appRuns.ts).
 */

import type { Prisma, PrismaClient } from '../generated/prisma/index.js';
import { generateId } from './id.js';

export const INSTALL_DEFAULT_DESCRIPTION = 'Default channel (installed)';

/** The Agent's declared install-row defaults (`Agent.registerDefaults`), tolerant of anything else. */
export function agentRegisterDefaults(raw: unknown): { mentionOnly: boolean } {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return { mentionOnly: o.mentionOnly === true };
}

/**
 * Ensure the App-owned default row exists for every live install of `appId`
 * (or for one Agent), when the App has a default Channel. Idempotent; returns
 * the number of rows inserted. A no-op for an App without a default Channel —
 * the row is written when the Channel is (`ensureChannelRow`).
 */
export async function ensureInstallRegisterRows(
  db: PrismaClient | Prisma.TransactionClient,
  appId: string,
  opts: { agentId?: string; createdBy?: string | null } = {},
): Promise<number> {
  const app = await db.app.findFirst({ where: { id: appId, deletedAt: null }, select: { defaultChannelId: true } });
  if (!app?.defaultChannelId) return 0;
  const installs = await db.appAgent.findMany({
    where: { appId, ...(opts.agentId ? { agentId: opts.agentId } : {}) },
    select: { agentId: true, agent: { select: { deletedAt: true, registerDefaults: true } } },
  });
  let inserted = 0;
  for (const install of installs) {
    if (!install.agent || install.agent.deletedAt) continue;
    const { mentionOnly } = agentRegisterDefaults(install.agent.registerDefaults);
    // #3196: created_at is written explicitly as UTC. The column is a naive
    // timestamp holding UTC, and its DEFAULT CURRENT_TIMESTAMP would land as the
    // session's wall time, hours off under a non-UTC session.
    inserted += await db.$executeRaw`
      INSERT INTO register_entries
        (id, app_id, channel_id, attendee_agent_id, role, mention_only, description, install_default, created_by, created_at)
      VALUES
        (${generateId()}, ${appId}, ${app.defaultChannelId}, ${install.agentId}, 'BOTH'::"RegisterRole",
         ${mentionOnly}, ${INSTALL_DEFAULT_DESCRIPTION}, true, ${opts.createdBy ?? null}, (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3))
      ON CONFLICT (app_id, channel_id, attendee_agent_id)
        WHERE app_id IS NOT NULL AND attendee_agent_id IS NOT NULL AND deleted_at IS NULL
        DO NOTHING`;
  }
  return inserted;
}

/**
 * Uninstall: the attendee has left the App, so every App-owned row naming
 * that Agent is soft-deleted (D4 — the App removes its own rows). Org-owned
 * rows naming the Agent are the org's to keep or remove.
 */
export async function removeRegisterRowsForUninstall(
  db: PrismaClient | Prisma.TransactionClient,
  appId: string,
  agentId: string,
  deletedBy: string | null,
): Promise<number> {
  const r = await db.registerEntry.updateMany({
    where: { appId, attendeeAgentId: agentId, deletedAt: null },
    data: { deletedAt: new Date(), deletedBy },
  });
  return r.count;
}
