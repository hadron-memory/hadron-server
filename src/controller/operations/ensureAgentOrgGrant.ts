/**
 * Idempotent auto-provisioning of an AgentOrgGrant. Per spec
 * 008-agent-installation FR-006 + research.md §R-2.
 *
 * Mirrors `ensureAgentSubscription` (User↔Agent, from 005). Called from:
 *   - `createApp` mutation when an org creates an App for an Agent it
 *     doesn't yet have a grant for.
 *   - `publishAgentImport` mutation when a Builder declares a dep import.
 *
 * Idempotency comes from the composite UNIQUE primary key (`org_id`,
 * `agent_id`) plus Prisma's `upsert`: concurrent first-contact requests
 * for the same `(orgId, agentId)` converge on a single row.
 *
 * v1 auto-provisions on first contact regardless of cross-org or same-org
 * — a future spec adds the explicit "subscribe to Agent" UX for the
 * marketplace flow. The same-org case is implicitly authorized (the
 * Agent's owning org has the right to deploy its own Agent); the cross-org
 * case is currently auto-approved because there's no marketplace yet.
 */

import type { PrismaClient } from '../../generated/prisma/index.js';

export async function ensureAgentOrgGrant(
  db: PrismaClient,
  orgId: string,
  agentId: string,
): Promise<void> {
  await db.agentOrgGrant.upsert({
    where: { orgId_agentId: { orgId, agentId } },
    create: {
      orgId,
      agentId,
      // v1 default: activate immediately on creation since billing is out
      // of scope. Mirrors the AgentSubscription pattern from 005.
      activatedAt: new Date(),
    },
    update: {},
  });
}
