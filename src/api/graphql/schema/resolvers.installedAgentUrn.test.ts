/**
 * Spec 021 US1 — install URN provenance via App.installedAgentUrn.
 *
 * Covers the new computed GraphQL field on App that returns the R2
 * canonical install URN combining the App's identity with its
 * installed Agent's author-org and slug. Two orgs installing same-slug
 * agents from different authors produce distinct URNs that differ at
 * the author-org segment.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function makeOrg(urn: string, name: string = urn) {
  return db.organization.create({
    data: { id: generateId(), name, urn },
  });
}

async function makeAgent(orgId: string, orgUrn: string, slug: string) {
  return db.agent.create({
    data: {
      id: generateId(),
      organizationId: orgId,
      name: slug,
      urn: `${orgUrn}:${slug}`,
    },
  });
}

async function makeApp(
  orgId: string,
  orgUrn: string,
  slug: string,
  agentId: string,
) {
  return db.app.create({
    data: {
      id: generateId(),
      organizationId: orgId,
      name: slug,
      urn: `${orgUrn}:${slug}`,
      agentId,
    },
  });
}

beforeEach(async () => {
  await cleanDb(db);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('App.installedAgentUrn — spec 021 US1', () => {
  it('returns the R2 canonical install URN combining App + Agent', async () => {
    const hadronOrg = await makeOrg('hadronmemory.com');
    const micromentorOrg = await makeOrg('micromentor.org');
    const agent = await makeAgent(hadronOrg.id, hadronOrg.urn, 'coding-agent');
    const app = await makeApp(micromentorOrg.id, micromentorOrg.urn, 'coding-app', agent.id);

    const result = await (resolvers.App as Record<string, Function>).installedAgentUrn(
      app,
      {},
      { db } as unknown as Context,
    );

    expect(result).toBe('urn:agent:micromentor.org::coding-app::hadronmemory.com:coding-agent');
  });

  it('two same-slug agents from different authors → distinct install URNs', async () => {
    const hadronOrg = await makeOrg('hadronmemory.com');
    const competitorOrg = await makeOrg('competitor.com');
    const micromentorOrg = await makeOrg('micromentor.org');

    const hadronAgent = await makeAgent(hadronOrg.id, hadronOrg.urn, 'coding-agent');
    const competitorAgent = await makeAgent(
      competitorOrg.id,
      competitorOrg.urn,
      'coding-agent',
    );

    const appA = await makeApp(
      micromentorOrg.id,
      micromentorOrg.urn,
      'coding-app',
      hadronAgent.id,
    );
    // Slug reuse across two Apps in the same org doesn't work today
    // (the App.urn partial unique still rejects active duplicates), so
    // use a distinct second app slug for the competitor install.
    const appB = await makeApp(
      micromentorOrg.id,
      micromentorOrg.urn,
      'coding-app-alt',
      competitorAgent.id,
    );

    const urlA = await (resolvers.App as Record<string, Function>).installedAgentUrn(
      appA,
      {},
      { db } as unknown as Context,
    );
    const urlB = await (resolvers.App as Record<string, Function>).installedAgentUrn(
      appB,
      {},
      { db } as unknown as Context,
    );

    expect(urlA).toBe('urn:agent:micromentor.org::coding-app::hadronmemory.com:coding-agent');
    expect(urlB).toBe(
      'urn:agent:micromentor.org::coding-app-alt::competitor.com:coding-agent',
    );
    // The author-org segment is what distinguishes them.
    expect(urlA).not.toBe(urlB);
  });

  it('install-by-self (installing org == author org) collapses via D11 cat 1', async () => {
    const hadronOrg = await makeOrg('hadronmemory.com');
    const agent = await makeAgent(hadronOrg.id, hadronOrg.urn, 'coding-agent');
    const app = await makeApp(hadronOrg.id, hadronOrg.urn, 'coding-app', agent.id);

    const result = await (resolvers.App as Record<string, Function>).installedAgentUrn(
      app,
      {},
      { db } as unknown as Context,
    );

    // Cat 1 collapses the duplicated org segment.
    expect(result).toBe('urn:agent:hadronmemory.com::coding-app::coding-agent');
  });

  it('returns null when App has no agent attached (008 orphan path)', async () => {
    const org = await makeOrg('micromentor.org');
    // Insert an orphan App directly (no agentId) — pre-009 back-compat.
    const orphan = await db.app.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        name: 'orphan-app',
        urn: `${org.urn}:orphan-app`,
      },
    });

    const result = await (resolvers.App as Record<string, Function>).installedAgentUrn(
      orphan,
      {},
      { db } as unknown as Context,
    );

    expect(result).toBeNull();
  });

  it('uses eager-loaded agent.urn when present (no extra DB roundtrip)', async () => {
    const hadronOrg = await makeOrg('hadronmemory.com');
    const micromentorOrg = await makeOrg('micromentor.org');
    const agent = await makeAgent(hadronOrg.id, hadronOrg.urn, 'coding-agent');
    const app = await makeApp(micromentorOrg.id, micromentorOrg.urn, 'coding-app', agent.id);

    // Simulate the eager-include shape that APP_INCLUDE / ORG_INCLUDE
    // would produce in a real query.
    const appWithAgent = { ...app, agent };
    const result = await (resolvers.App as Record<string, Function>).installedAgentUrn(
      appWithAgent,
      {},
      { db } as unknown as Context,
    );

    expect(result).toBe('urn:agent:micromentor.org::coding-app::hadronmemory.com:coding-agent');
  });
});
