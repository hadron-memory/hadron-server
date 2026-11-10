/**
 * App.installedAgentUrn — grammar-v2 (#697 Stage 2, D10).
 *
 * An installed agent stays AUTHOR-ROOTED forever: `installedAgentUrn` now returns
 * the installed Agent's own author-rooted v2 URN (`hrn:agent:<author>:<slug>`).
 * The v1 R2 install chain (`<installing-org>::<app>::<author-org>:<slug>`) is
 * retired — the App's identity no longer appears in the URN. Two same-slug agents
 * from different authors still stay distinct, now at the ROOT (author) atom.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

async function makeOrg(urn: string, name: string = urn) {
  return db.organization.create({ data: { id: generateId(), name, urn } });
}

async function makeAgent(orgId: string, orgUrn: string, slug: string) {
  return db.agent.create({
    // PUBLIC: the resolver is called anonymously, and the URN answers as the Agent's own read does (#2640).
    data: { id: generateId(), organizationId: orgId, name: slug, urn: `${orgUrn}:${slug}`, visibility: 'PUBLIC' },
  });
}

async function makeApp(orgId: string, orgUrn: string, slug: string, agentId: string) {
  return db.app.create({
    data: {
      id: generateId(),
      organizationId: orgId,
      name: slug,
      urn: `${orgUrn}:${slug}`,
      appAgents: { create: { agentId } },
    },
  });
}

const installedAgentUrn = (app: unknown) =>
  (resolvers.App as Record<string, Function>).installedAgentUrn(app, {}, { db } as unknown as Context);

beforeEach(async () => {
  await cleanDb(db);
});

describe('App.installedAgentUrn — author-rooted (v2, D10)', () => {
  it('returns the installed agent’s author-rooted v2 URN (App identity absent)', async () => {
    const hadronOrg = await makeOrg('hadronmemory.com');
    const micromentorOrg = await makeOrg('micromentor.org');
    const agent = await makeAgent(hadronOrg.id, hadronOrg.urn, 'coding-agent');
    const app = await makeApp(micromentorOrg.id, micromentorOrg.urn, 'coding-app', agent.id);

    // Rooted at the AUTHOR (hadronmemory.com), NOT the installing org.
    expect(await installedAgentUrn(app)).toBe('hrn:agent:hadronmemory.com:coding-agent');
  });

  it('two same-slug agents from different authors stay distinct at the author root', async () => {
    const hadronOrg = await makeOrg('hadronmemory.com');
    const competitorOrg = await makeOrg('competitor.com');
    const micromentorOrg = await makeOrg('micromentor.org');
    const hadronAgent = await makeAgent(hadronOrg.id, hadronOrg.urn, 'coding-agent');
    const competitorAgent = await makeAgent(competitorOrg.id, competitorOrg.urn, 'coding-agent');

    const app = await makeApp(micromentorOrg.id, micromentorOrg.urn, 'coding-app', hadronAgent.id);
    const withHadron = await installedAgentUrn(app);

    // Re-point the App at competitor.com's same-slug agent (same App, same slug).
    await db.appAgent.deleteMany({ where: { appId: app.id } });
    await db.appAgent.create({ data: { appId: app.id, agentId: competitorAgent.id } });
    const updatedApp = await db.app.findUniqueOrThrow({ where: { id: app.id } });
    const withCompetitor = await installedAgentUrn(updatedApp);

    expect(withHadron).toBe('hrn:agent:hadronmemory.com:coding-agent');
    expect(withCompetitor).toBe('hrn:agent:competitor.com:coding-agent');
    // Distinct ONLY at the author root atom.
    expect(withHadron).not.toBe(withCompetitor);
  });

  it('install-by-self is the same author-rooted URN (no App segment to collapse)', async () => {
    const hadronOrg = await makeOrg('hadronmemory.com');
    const agent = await makeAgent(hadronOrg.id, hadronOrg.urn, 'coding-agent');
    const app = await makeApp(hadronOrg.id, hadronOrg.urn, 'coding-app', agent.id);

    expect(await installedAgentUrn(app)).toBe('hrn:agent:hadronmemory.com:coding-agent');
  });

  it('drops a legacy @ owner sigil on a user-authored agent', async () => {
    const org = await makeOrg('micromentor.org');
    const user = await db.user.create({
      data: { id: generateId(), handle: 'holger', email: `h-${generateId()}@x.test` },
    });
    const agent = await db.agent.create({
      data: { id: generateId(), ownerUserId: user.id, name: 'helper', urn: '@holger:helper', visibility: 'PUBLIC' },
    });
    const app = await makeApp(org.id, org.urn, 'my-app', agent.id);

    expect(await installedAgentUrn(app)).toBe('hrn:agent:holger:helper');
  });

  it('returns null when the App has no agent attached (008 orphan path)', async () => {
    const org = await makeOrg('micromentor.org');
    const orphan = await db.app.create({
      data: { id: generateId(), organizationId: org.id, name: 'orphan-app', urn: `${org.urn}:orphan-app` },
    });
    expect(await installedAgentUrn(orphan)).toBeNull();
  });

  it('uses the eager-loaded agent.urn when present', async () => {
    const hadronOrg = await makeOrg('hadronmemory.com');
    const micromentorOrg = await makeOrg('micromentor.org');
    const agent = await makeAgent(hadronOrg.id, hadronOrg.urn, 'coding-agent');
    const app = await makeApp(micromentorOrg.id, micromentorOrg.urn, 'coding-app', agent.id);

    const appWithAgent = { ...app, agent };
    expect(await installedAgentUrn(appWithAgent)).toBe('hrn:agent:hadronmemory.com:coding-agent');
  });

  it('#520 — fails soft (null + warn) when the agent URN can’t emit v2', async () => {
    const org = await makeOrg('micromentor.org');
    // An un-emittable stored agent urn (empty root) makes emitInstalledAgentUrnV2
    // throw; the nullable field must return null, not error the whole app read.
    const badAgent = await db.agent.create({
      data: { id: generateId(), organizationId: org.id, name: 'bad', urn: ':rootless', visibility: 'PUBLIC' },
    });
    const app = await makeApp(org.id, org.urn, 'coding-app', badAgent.id);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await installedAgentUrn(app)).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
