/**
 * Idempotency + concurrency tests for ensureAgentOrgGrant.
 *
 * Per 008-agent-installation FR-006 + research.md §R-2: the helper is an
 * UPSERT keyed on the composite (org_id, agent_id). Concurrent first-contact
 * calls for the same pair MUST converge on a single row.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import { ensureAgentOrgGrant } from './ensureAgentOrgGrant.js';

let orgId: string;
let agentId: string;

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({
    data: { id: generateId(), name: 'eog-org', urn: 'eog-org' },
  });
  orgId = org.id;
  const agent = await db.agent.create({
    data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:a`, name: 'a' },
  });
  agentId = agent.id;
});

describe('ensureAgentOrgGrant', () => {
  it('creates exactly one row on first call', async () => {
    await ensureAgentOrgGrant(db, orgId, agentId);
    const grants = await db.agentOrgGrant.findMany({ where: { orgId, agentId } });
    expect(grants.length).toBe(1);
    expect(grants[0].activatedAt).not.toBeNull();
    expect(grants[0].revokedAt).toBeNull();
  });

  it('is idempotent — second call does not create a duplicate', async () => {
    await ensureAgentOrgGrant(db, orgId, agentId);
    await ensureAgentOrgGrant(db, orgId, agentId);
    const grants = await db.agentOrgGrant.findMany({ where: { orgId, agentId } });
    expect(grants.length).toBe(1);
  });

  it('preserves an existing grant (does not overwrite revokedAt)', async () => {
    // Pre-existing grant with revokedAt set — ensureAgentOrgGrant should not
    // re-activate it. (Update path is empty-update {}, leaving revokedAt
    // alone.) v1 does not "auto-reinstate" a revoked grant.
    const revokedAt = new Date('2026-04-01T00:00:00.000Z');
    await db.agentOrgGrant.create({
      data: { orgId, agentId, activatedAt: new Date('2026-03-01'), revokedAt },
    });
    await ensureAgentOrgGrant(db, orgId, agentId);
    const grant = await db.agentOrgGrant.findUniqueOrThrow({
      where: { orgId_agentId: { orgId, agentId } },
    });
    expect(grant.revokedAt?.toISOString()).toBe(revokedAt.toISOString());
  });

  it('converges on a single row under concurrent first-contact calls', async () => {
    // Stress: 50 concurrent invocations all targeting the same (org, agent).
    // The composite UNIQUE PK + Prisma upsert means all 50 collapse to one
    // row. (Some calls hit the create path; the rest hit update — both ok.)
    const N = 50;
    await Promise.all(
      Array.from({ length: N }, () => ensureAgentOrgGrant(db, orgId, agentId)),
    );
    const grants = await db.agentOrgGrant.findMany({ where: { orgId, agentId } });
    expect(grants.length).toBe(1);
  });
});
