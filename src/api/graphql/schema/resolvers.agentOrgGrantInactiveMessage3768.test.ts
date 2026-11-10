/**
 * #3768 slice 1: the AGENT_ORG_GRANT_INACTIVE refusal of createAgentOrgGrant
 * must name no remedy that does not exist. The Mutation type has exactly two
 * grant fields (create, revoke), so "issue a new grant" / "clear the
 * revocation" described calls nobody can make. The code, the gate and the
 * extensions payload are unchanged; only the message text is pinned here.
 * (Slice 2, a restore or re-issue door, is unruled and out of scope.)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

const M = resolvers.Mutation as any;

let ownerOrg: { id: string; urn: string };
let subscriberOrg: { id: string; urn: string };
let publicAgent: { id: string };
let subscriberAdmin: { id: string };

const ctx = (userId: string): Context => ({ db, userId, roles: ['READER'] });

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  ownerOrg = await db.organization.create({
    data: { id: generateId(), name: 'g3768-owner', urn: `g3768-owner-${suffix}` },
  });
  subscriberOrg = await db.organization.create({
    data: { id: generateId(), name: 'g3768-sub', urn: `g3768-sub-${suffix}` },
  });
  subscriberAdmin = await db.user.create({
    data: { id: generateId(), githubId: 76801, githubUsername: `g3768-admin-${suffix}`, roles: ['READER'] },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: subscriberOrg.id, userId: subscriberAdmin.id, role: 'ADMIN' },
  });
  publicAgent = await db.agent.create({
    data: {
      id: generateId(),
      organizationId: ownerOrg.id,
      urn: `${ownerOrg.urn}:public-agent`,
      name: 'Public Agent',
      visibility: 'PUBLIC',
    },
  });
});

async function refusal(state: { revokedAt?: Date; expiresAt?: Date }): Promise<any> {
  await db.agentOrgGrant.create({
    data: {
      orgId: subscriberOrg.id,
      agentId: publicAgent.id,
      activatedAt: new Date('2026-06-01T00:00:00.000Z'),
      ...state,
    },
  });
  return M.createAgentOrgGrant(
    null,
    { agentRef: publicAgent.id, orgRef: subscriberOrg.id },
    ctx(subscriberAdmin.id),
  ).then(
    () => { throw new Error('expected AGENT_ORG_GRANT_INACTIVE'); },
    (e: unknown) => e,
  );
}

describe('#3768 AGENT_ORG_GRANT_INACTIVE message names no nonexistent remedy', () => {
  it.each([
    ['revoked', { revokedAt: new Date('2026-07-01T00:00:00.000Z') }],
    ['expired', { expiresAt: new Date('2026-07-01T00:00:00.000Z') }],
  ])('%s grant: message offers no issue/clear remedy, still reads as inactive', async (_n, state) => {
    const err = await refusal(state);

    expect(err.extensions.code).toBe('AGENT_ORG_GRANT_INACTIVE');
    expect(err.message).not.toMatch(/issue a new grant/i);
    expect(err.message).not.toMatch(/clear the revocation/i);
    expect(err.message).not.toMatch(/ask the agent owner/i);
    expect(err.message).toContain('already exists for this organization and Agent');
    expect(err.message).toContain('not active');
    expect(err.message).toContain('not reactivated');
    expect(err.message).toContain('cor:dmo:050:07');
  });

  it('keeps the extensions payload unchanged', async () => {
    const revokedAt = new Date('2026-07-01T00:00:00.000Z');
    const err = await refusal({ revokedAt });

    expect(err.extensions).toEqual({
      code: 'AGENT_ORG_GRANT_INACTIVE',
      orgId: subscriberOrg.id,
      agentId: publicAgent.id,
      revokedAt: revokedAt.toISOString(),
      expiresAt: null,
      activatedAt: '2026-06-01T00:00:00.000Z',
    });
  });
});
