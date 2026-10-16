/**
 * #1349 Slice 1 — an AgentMemoryItem is a LIMIT, never a grant.
 *
 * cor:dmo:050:09 (Holger "A", team chat #13055): an item narrows what an
 * Agent's App may do with a memory it can already reach, and never admits the
 * App to a memory the memory's own access rules don't. cor:acl:010:01 (Holger
 * "A", team chat #13052): PUBLIC widens who may READ a knowledge memory, never
 * who may write it.
 *
 * #1357 refuses NEW items that over-grant. Items minted before it are still
 * stored as recorded, so every fold that turns an item into reach takes the
 * item's level AND caps it here by what the Agent's tenant reaches on its own.
 * One function, so the folds cannot drift apart.
 *
 * **Whose tenant: the AGENT's**, as cor:dmo:050:09 judges every item ("another
 * tenant's memory", "a memory the Agent's organization subscribes to") and as
 * #1357's attach gate does (`agent.organizationId === memory.organizationId`).
 * An item travels with its Agent into every App that installs it under a live
 * license, so a cross-org install keeps reading what the Agent's organization
 * itself reaches (the 008 cross-org chain), and nothing more.
 *
 * **Independent reach of an Agent's tenant** (its organization, or for a
 * user-owned Agent its owner), by the memory's class, with no item consulted:
 *
 *   | memory                                   | independent reach          |
 *   |------------------------------------------|----------------------------|
 *   | knowledge, owned by the tenant's org     | READ_WRITE (the owning org's writers) |
 *   | knowledge, user-owned by the tenant or acting user | READ_WRITE       |
 *   | knowledge App-scoped to the folding App  | not capped (same-App shape, Proposed) |
 *   | knowledge, live subscription by the org  | READ_WRITE at CONTRIBUTOR+, else READ_ONLY |
 *   | knowledge, PUBLIC (org-owned, not App-scoped, not a holding) | READ_ONLY |
 *   | any other knowledge                      | none                       |
 *   | group                                    | none — MemoryMember only, and an Agent holds none |
 *   | system                                   | none — an Agent's own system memory is folded separately |
 *   | personal / private / app                 | not capped here: their strict-owner and App-participation gates run downstream, unchanged |
 *
 * A subscription is the subscribing ORGANIZATION's reach (cor:dmo:060:09);
 * capping the item at the subscription's level is still Proposed in
 * cor:dmo:050:09, and this applies exactly that cap, nothing wider.
 *
 * A same-App row (an App-scoped knowledge memory of this App) is in its own
 * org, so the owning-org row above decides it: the item grants nothing beyond
 * that. The same-App exception itself stays Proposed and is not built here.
 */
import type { PrismaClient } from '../../generated/prisma/index.js';
import { isGrantedAgentMemoryRole } from '../appAgent.js';

export type LinkLevel = 'READ_ONLY' | 'READ_WRITE';

/**
 * The Agent's tenant: its organization, or for a user-owned Agent, its owner.
 * Two optional facts about the fold that consults it:
 *   - `appId`: the App the item is being folded into. A row App-scoped to THIS
 *     App is the same-App shape — still Proposed in cor:dmo:050:09 — so it is
 *     not capped here: the item grants nothing beyond what it granted before,
 *     and no other outcome is fixed for it (Vera's control on #1349).
 *   - `userId`: a user the fold acts for (the App's owner, the chat caller).
 *     A user-owned memory is strictly that user's, so its owner reaches it.
 */
export interface LinkTenant {
  organizationId: string | null;
  ownerUserId: string | null;
  appId?: string | null;
  userId?: string | null;
}

/** The memory fields the cap reads. `subscriptions` must be LIVE rows (`deletedAt: null`). */
export interface LinkCapMemory {
  class: string;
  organizationId: string | null;
  ownerUserId: string | null;
  /** The owning user of a personal/private memory. */
  userId?: string | null;
  appId: string | null;
  userMemoryOfAgentId: string | null;
  visibility: string | null;
  subscriptions?: Array<{ organizationId: string; role: string }>;
}

/**
 * Prisma `select` for {@link LinkCapMemory}. Every LIVE subscription is
 * loaded; {@link independentReach} counts only the tenant org's own.
 */
export const LINK_CAP_MEMORY_SELECT = {
  class: true,
  organizationId: true,
  ownerUserId: true,
  userId: true,
  appId: true,
  userMemoryOfAgentId: true,
  visibility: true,
  subscriptions: { where: { deletedAt: null }, select: { organizationId: true, role: true } },
} as const;

const SUBSCRIPTION_WRITE_ROLES: ReadonlySet<string> = new Set(['CONTRIBUTOR', 'ADMIN', 'OWNER']);

/** What the Agent's tenant reaches in `memory` with no item at all. `undefined` = not capped here. */
export function independentReach(tenant: LinkTenant, memory: LinkCapMemory): LinkLevel | null | undefined {
  switch (memory.class) {
    case 'personal':
    case 'private':
    case 'app':
      return undefined;
    case 'knowledge':
      break;
    default:
      return null;
  }
  if (memory.appId !== null && tenant.appId != null && memory.appId === tenant.appId) return undefined;
  if (memory.ownerUserId !== null) {
    const owner = memory.ownerUserId;
    return owner === tenant.ownerUserId || (tenant.userId != null && owner === tenant.userId) ? 'READ_WRITE' : null;
  }
  if (tenant.organizationId !== null && memory.organizationId === tenant.organizationId) return 'READ_WRITE';
  let reach: LinkLevel | null = null;
  const free = memory.appId === null && memory.userMemoryOfAgentId === null;
  if (free && tenant.organizationId !== null) {
    for (const sub of memory.subscriptions ?? []) {
      if (sub.organizationId !== tenant.organizationId) continue;
      if (SUBSCRIPTION_WRITE_ROLES.has(sub.role)) return 'READ_WRITE';
      reach = 'READ_ONLY';
    }
  }
  if (free && memory.visibility === 'PUBLIC') reach = 'READ_ONLY';
  return reach;
}

/**
 * The level a stored item actually confers: its own level, capped by the
 * tenant's independent reach. `null` = the item confers nothing.
 */
export function cappedLinkLevel(
  tenant: LinkTenant,
  memory: LinkCapMemory,
  role: string | null | undefined,
): LinkLevel | null {
  const stored = role ?? 'read';
  if (!isGrantedAgentMemoryRole(stored)) return null;
  const linked: LinkLevel = stored === 'read-write' ? 'READ_WRITE' : 'READ_ONLY';
  const reach = independentReach(tenant, memory);
  if (reach === undefined) return linked;
  if (reach === null) return null;
  return linked === 'READ_WRITE' && reach === 'READ_WRITE' ? 'READ_WRITE' : 'READ_ONLY';
}

/**
 * Whether a link may make `memory` a WRITE target for a fold that has no
 * downstream gate of its own (the legacy startChat target, the asset upload
 * target). {@link cappedLinkLevel} passes personal, private and app through
 * because the access map's consumers strict-gate them afterwards; a write
 * target picked straight from the links has no such gate (Colin on #2002), so
 * it applies the owner rules here:
 *   - a personal or private memory only for its strict owner, which is the
 *     row's `userId` (the `chk_personal_visibility_user` invariant and the
 *     canonical owner gate), never `ownerUserId` (Riana on #2002);
 *   - an app-class memory NEVER: an App's app-class memories need no item and
 *     are reached through the App itself (cor:dmo:050:09), and the canonical
 *     write refuses a pure App key there (Riana on #2002);
 *   - everything else only at a capped READ_WRITE.
 */
export function linkWriteTargetAdmits(
  tenant: LinkTenant,
  memory: LinkCapMemory,
  role: string | null | undefined,
): boolean {
  if (cappedLinkLevel(tenant, memory, role) !== 'READ_WRITE') return false;
  if (memory.class === 'personal' || memory.class === 'private') {
    const owner = memory.userId ?? null;
    return owner !== null && tenant.userId != null && owner === tenant.userId;
  }
  return memory.class !== 'app';
}

/** Load an Agent's tenant. A missing Agent has none, so every capped item confers only PUBLIC reads. */
export async function agentLinkTenant(db: PrismaClient, agentId: string): Promise<LinkTenant> {
  const agent = await db.agent.findUnique({ where: { id: agentId }, select: { organizationId: true, ownerUserId: true } });
  return { organizationId: agent?.organizationId ?? null, ownerUserId: agent?.ownerUserId ?? null };
}
