/**
 * Idempotent auto-provisioning of an AgentOrgGrant. Per spec
 * 008-agent-installation FR-006 + research.md §R-2.
 *
 * Mirrors `ensureAgentSubscription` (User↔Agent, from 005). This is a
 * low-level idempotent writer, not an authorization gate. Install callers
 * must first use `planOrgAgentInstallGrant`: only a same-org Agent may be
 * auto-provisioned; cross-org installs require an existing active grant.
 * `createAgentOrgGrant` is the explicit PUBLIC cross-org subscription path.
 *
 * Idempotency comes from the composite UNIQUE primary key (`org_id`,
 * `agent_id`). Prisma's `upsert` is not race-safe under concurrent
 * first-contacts (two transactions can both observe "no row" and both
 * INSERT, with one raising P2002 — see prisma/prisma#3242). Since
 * `update: {}` is a no-op, catching P2002 lands us in exactly the
 * post-condition this function promises: a single row exists for
 * (orgId, agentId). The fix mirrors `ensureAgentSubscription` (#198).
 *
 * The same-org case is implicitly authorized; this helper must not be called
 * as a substitute for checking an install's cross-org license.
 */

import { Prisma, type PrismaClient } from '../../generated/prisma/index.js';

export async function ensureAgentOrgGrant(
  db: Pick<PrismaClient, '$executeRaw'> | Prisma.TransactionClient,
  orgId: string,
  agentId: string,
  opts: { createdBy?: string | null } = {},
): Promise<void> {
  // #1573: one statement that cannot fail on the composite key. This runs
  // INSIDE anchored transactions (createApp, installAgentIntoAppCore), where a
  // caught P2002 from the old upsert-and-catch would leave the transaction
  // aborted (25P02), the hazard Atilla found in ensureAgentSubscription
  // (#1583). The conflict target is the composite PK only, so any other
  // unique constraint still raises. An existing row (including a REVOKED
  // grant) is left untouched. v1 default: activate immediately on creation,
  // since billing is out of scope (mirrors the AgentSubscription pattern).
  // activated_at and created_at are timestamp(3) WITHOUT time zone here, so
  // write both as UTC; created_at's column DEFAULT would be session wall time
  // (#3196).
  await db.$executeRaw`
    INSERT INTO agent_org_grants (org_id, agent_id, activated_at, created_by, created_at)
    VALUES (${orgId}, ${agentId}, (now() AT TIME ZONE 'UTC'), ${opts.createdBy ?? null}, (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3))
    ON CONFLICT (org_id, agent_id) DO NOTHING`;
}
