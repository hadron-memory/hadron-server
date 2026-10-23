/**
 * #2245 amendment 3: `classifyOrgAgentLicense` is the non-throwing classifier under
 * `planOrgAgentInstallGrant`. Each parity row is asserted against BOTH, so the install and
 * base paths cannot drift from the clone's reading of the same licence.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { classifyOrgAgentLicense, planOrgAgentInstallGrant } from './orgAgentInstallLicense.js';

let orgId: string;
let otherOrgId: string;

async function agent(orgIdOwner: string, visibility: 'ORGANIZATION' | 'PUBLIC', extra: { deletedAt?: Date } = {}) {
  const id = generateId();
  await db.agent.create({
    data: { id, organizationId: orgIdOwner, urn: `lic-${id}`, name: id, visibility, ...extra },
  });
  return id;
}

async function grant(org: string, agentId: string, patch: { revokedAt?: Date } = {}) {
  await db.agentOrgGrant.create({
    data: { orgId: org, agentId, activatedAt: new Date(Date.now() - 1000), ...patch },
  });
}

/** What the old throwing function does, as a comparable string. */
async function legacy(agentId: string): Promise<string> {
  try {
    return (await planOrgAgentInstallGrant(db, orgId, agentId, agentId)) ? 'provision' : 'licensed';
  } catch (e) {
    const err = e as { extensions?: { code?: string }; name?: string };
    return err.extensions?.code ?? err.name ?? 'error';
  }
}

beforeEach(async () => {
  await cleanDb(db);
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'lic-a', urn: 'lic-a' } })).id;
  otherOrgId = (await db.organization.create({ data: { id: generateId(), name: 'lic-b', urn: 'lic-b' } })).id;
});

describe('classifyOrgAgentLicense parity with planOrgAgentInstallGrant', () => {
  it('same org, no grant: SAME_ORG_PROVISIONABLE / provision', async () => {
    const a = await agent(orgId, 'ORGANIZATION');
    expect(await classifyOrgAgentLicense(db, orgId, a)).toBe('SAME_ORG_PROVISIONABLE');
    expect(await legacy(a)).toBe('provision');
  });
  it('same org, inactive grant: SAME_ORG_INACTIVE / AGENT_ORG_GRANT_INACTIVE', async () => {
    const a = await agent(orgId, 'ORGANIZATION');
    await grant(orgId, a, { revokedAt: new Date() });
    expect(await classifyOrgAgentLicense(db, orgId, a)).toBe('SAME_ORG_INACTIVE');
    expect(await legacy(a)).toBe('AGENT_ORG_GRANT_INACTIVE');
  });
  it('foreign, active grant: LICENSED / licensed', async () => {
    const a = await agent(otherOrgId, 'ORGANIZATION');
    await grant(orgId, a);
    expect(await classifyOrgAgentLicense(db, orgId, a)).toBe('LICENSED');
    expect(await legacy(a)).toBe('licensed');
  });
  it('foreign PUBLIC, no grant: SUBSCRIBABLE / AGENT_ORG_GRANT_REQUIRED', async () => {
    const a = await agent(otherOrgId, 'PUBLIC');
    expect(await classifyOrgAgentLicense(db, orgId, a)).toBe('SUBSCRIBABLE');
    expect(await legacy(a)).toBe('AGENT_ORG_GRANT_REQUIRED');
  });
  it('foreign PUBLIC, revoked grant: FOREIGN_INACTIVE / AGENT_ORG_GRANT_INACTIVE', async () => {
    const a = await agent(otherOrgId, 'PUBLIC');
    await grant(orgId, a, { revokedAt: new Date() });
    expect(await classifyOrgAgentLicense(db, orgId, a)).toBe('FOREIGN_INACTIVE');
    expect(await legacy(a)).toBe('AGENT_ORG_GRANT_INACTIVE');
  });
  it('foreign non-PUBLIC, no active grant: CONCEALED / AgentNotFoundError', async () => {
    const a = await agent(otherOrgId, 'ORGANIZATION');
    expect(await classifyOrgAgentLicense(db, orgId, a)).toBe('CONCEALED');
    expect(await legacy(a)).toBe('AgentNotFoundError');
  });
  it('missing and retired agents: GONE / AgentNotFoundError', async () => {
    const retired = await agent(orgId, 'ORGANIZATION', { deletedAt: new Date() });
    expect(await classifyOrgAgentLicense(db, orgId, retired)).toBe('GONE');
    expect(await legacy(retired)).toBe('AgentNotFoundError');
    expect(await classifyOrgAgentLicense(db, orgId, 'nope')).toBe('GONE');
    expect(await legacy('nope')).toBe('AgentNotFoundError');
  });
});
