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
  db: Pick<PrismaClient, 'agentOrgGrant'>,
  orgId: string,
  agentId: string,
  opts: { createdBy?: string | null } = {},
): Promise<void> {
  try {
    await db.agentOrgGrant.upsert({
      where: { orgId_agentId: { orgId, agentId } },
      create: {
        orgId,
        agentId,
        // v1 default: activate immediately on creation since billing is out
        // of scope. Mirrors the AgentSubscription pattern from 005.
        activatedAt: new Date(),
        createdBy: opts.createdBy ?? null,
      },
      update: {},
    });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002' &&
      isCompositePkViolation(err.meta)
    ) {
      return;
    }
    throw err;
  }
}

function isCompositePkViolation(meta: unknown): boolean {
  if (!meta || typeof meta !== 'object' || !('target' in meta)) return false;
  const target = (meta as { target?: unknown }).target;
  if (!Array.isArray(target) || target.length !== 2) return false;
  const fields = new Set(target.map(String));
  // Prisma emits target as field names (camelCase) on @@id; tolerate
  // snake_case mapping as a hedge — the same composite-PK constraint
  // can surface either way across Prisma engine versions.
  return (
    (fields.has('orgId') && fields.has('agentId')) ||
    (fields.has('org_id') && fields.has('agent_id'))
  );
}
