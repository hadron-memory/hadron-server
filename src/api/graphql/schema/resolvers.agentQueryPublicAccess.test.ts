/**
 * Issue #551 — the Agent read surfaces must honor visibility=PUBLIC, mirroring
 * the resolved memory PUBLIC carve-out (#362):
 *
 *   - agent(ref:) admits a PUBLIC agent for ANY caller; non-public keeps the
 *     org-membership gate.
 *   - publicAgents() is a dedicated, cross-org marketplace slice — every live
 *     PUBLIC agent, readable without membership. Kept SEPARATE from the
 *     member-scoped agents() so the widening is explicit (not a filter value).
 *   - resolveUrn's agent branch resolves a PUBLIC agent for any caller (share
 *     links), otherwise falls back to membership.
 *   - Field exposure (PR #552 review): the Agent's OWN definition
 *     (description / memoryItems / imports / importedBy) is public on a PUBLIC
 *     agent, but the "who uses this agent" fields (apps / appAgents / orgGrants
 *     / appCount) are NOT — apps/appAgents return other tenants' App objects
 *     (whose keys/members aren't re-gated), so they are scoped to the caller's
 *     own orgs; appCount/orgGrants to the agent's owning-org members.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAgentImport, createDbAgentOrgGrant } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const Q = resolvers.Query as any;
const A = resolvers.Agent as any;

const ctx = (userId?: string, roles: Context['roles'] = ['READER']): Context =>
  ({ db, userId, roles });

let orgA: { id: string; urn: string };
let orgB: { id: string; urn: string };
let member: { id: string };   // member of orgA
let stranger: { id: string }; // member of NO org
let admin: { id: string };    // platform ADMIN, member of nothing

let pubAgentA: { id: string; urn: string };  // PUBLIC, orgA
let orgAgentA: { id: string; urn: string };   // ORGANIZATION, orgA
let sysMem: { id: string };                    // pubAgentA's system memory

beforeEach(async () => {
  await cleanDb(db);
  orgA = await db.organization.create({ data: { id: generateId(), name: 'pa-a', urn: `pa-a-${Date.now()}` } });
  orgB = await db.organization.create({ data: { id: generateId(), name: 'pa-b', urn: `pa-b-${Date.now()}` } });
  member = await db.user.create({ data: { id: generateId(), githubId: 55101, githubUsername: 'pa-member', roles: ['READER'] } });
  stranger = await db.user.create({ data: { id: generateId(), githubId: 55102, githubUsername: 'pa-stranger', roles: ['READER'] } });
  admin = await db.user.create({ data: { id: generateId(), githubId: 55103, githubUsername: 'pa-admin', roles: ['ADMIN'] } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: orgA.id, userId: member.id, role: 'READER' } });

  sysMem = await db.memory.create({
    data: { id: generateId(), organizationId: orgA.id, urn: `${orgA.urn}:sys`, name: 'pa sys', class: 'knowledge', visibility: 'ORGANIZATION' },
  });
  pubAgentA = await db.agent.create({
    data: {
      id: generateId(), organizationId: orgA.id, urn: `${orgA.urn}:pub-agent`,
      name: 'Pub Agent', visibility: 'PUBLIC',
      description: 'SECRET-PROMPT', systemMemoryId: sysMem.id,
    },
  });
  orgAgentA = await db.agent.create({
    data: {
      id: generateId(), organizationId: orgA.id, urn: `${orgA.urn}:org-agent`,
      name: 'Org Agent', visibility: 'ORGANIZATION', description: 'ORG-PROMPT',
    },
  });
});

const asMember = () => ctx(member.id);
const asStranger = () => ctx(stranger.id);
const asAdmin = () => ctx(admin.id, ['ADMIN']);
const asAnon = () => ctx();

describe('agent(ref:) — PUBLIC visibility (issue #551)', () => {
  it('lets a non-member read a PUBLIC agent (by id and by urn)', async () => {
    expect((await Q.agent(null, { ref: pubAgentA.id }, asStranger()))?.id).toBe(pubAgentA.id);
    expect((await Q.agent(null, { ref: pubAgentA.urn }, asStranger()))?.id).toBe(pubAgentA.id);
  });

  it('lets an unauthenticated caller read a PUBLIC agent', async () => {
    expect((await Q.agent(null, { ref: pubAgentA.id }, asAnon()))?.id).toBe(pubAgentA.id);
  });

  it('still forbids a non-member on an ORGANIZATION agent', async () => {
    // #1944: an Agent the caller can't read reads as absent (null), never FORBIDDEN.
    expect(await Q.agent(null, { ref: orgAgentA.id }, asStranger())).toBeNull();
    expect(await Q.agent(null, { ref: orgAgentA.id }, asAnon())).toBeNull();
  });

  it('an org member still reads their org ORGANIZATION agent (no regression)', async () => {
    expect((await Q.agent(null, { ref: orgAgentA.id }, asMember()))?.id).toBe(orgAgentA.id);
  });

  it('a REVOKED member is denied on an ORGANIZATION agent but still reads a PUBLIC one', async () => {
    await db.orgMember.updateMany({ where: { organizationId: orgA.id, userId: member.id }, data: { deletedAt: new Date() } });
    expect(await Q.agent(null, { ref: orgAgentA.id }, asMember())).toBeNull(); // #1944: as absent
    expect((await Q.agent(null, { ref: pubAgentA.id }, asMember()))?.id).toBe(pubAgentA.id);
  });
});

describe('publicAgents() — the marketplace slice (issue #551)', () => {
  beforeEach(async () => {
    // A PUBLIC agent owned by a DIFFERENT org (orgB) — the foreign public
    // agent the member/stranger could never see via agents().
    await db.agent.create({
      data: { id: generateId(), organizationId: orgB.id, urn: `${orgB.urn}:b-pub`, name: 'B Pub', visibility: 'PUBLIC', type: 'CHATBOT' },
    });
  });

  it('returns every PUBLIC agent cross-org, regardless of membership', async () => {
    for (const c of [asMember(), asStranger(), asAnon(), asAdmin()]) {
      const page = await Q.publicAgents(null, {}, c);
      expect(page.total).toBe(2); // pubAgentA (orgA) + B Pub (orgB)
      expect(page.items.every((a: any) => a.visibility === 'PUBLIC')).toBe(true);
    }
  });

  it('excludes ORGANIZATION and soft-deleted agents', async () => {
    await db.agent.update({ where: { id: pubAgentA.id }, data: { deletedAt: new Date() } });
    const page = await Q.publicAgents(null, {}, asStranger());
    expect(page.total).toBe(1); // only B Pub survives; orgAgentA never counted
    expect(page.items.map((a: any) => a.name)).toEqual(['B Pub']);
  });

  it('filter.type narrows the slice', async () => {
    const page = await Q.publicAgents(null, { filter: { type: 'CHATBOT' } }, asStranger());
    expect(page.total).toBe(1);
    expect(page.items[0].name).toBe('B Pub');
  });

  it('limit: 0 returns the count only', async () => {
    const page = await Q.publicAgents(null, { limit: 0 }, asStranger());
    expect(page).toEqual({ items: [], total: 2 });
  });
});

describe('resolveUrn — agent branch honors PUBLIC (issue #551)', () => {
  it('a non-member resolves a PUBLIC agent urn', async () => {
    expect(await Q.resolveUrn(null, { urn: `urn:agent:${pubAgentA.urn}` }, asStranger())).toEqual({ kind: 'agent', id: pubAgentA.id });
  });

  it('a non-member cannot resolve an ORGANIZATION agent urn', async () => {
    expect(await Q.resolveUrn(null, { urn: `urn:agent:${orgAgentA.urn}` }, asStranger())).toBeNull();
  });

  it('a member still resolves their ORGANIZATION agent urn', async () => {
    expect(await Q.resolveUrn(null, { urn: `urn:agent:${orgAgentA.urn}` }, asMember())).toEqual({ kind: 'agent', id: orgAgentA.id });
  });
});

describe('Agent field exposure — own definition public, "who uses it" scoped (issue #551 / PR #552 review)', () => {
  it('apps / appAgents / orgGrants / appCount are visible to a READER member (was ADMIN-only)', async () => {
    const app = await db.app.create({
      data: { id: generateId(), organizationId: orgA.id, urn: `${orgA.urn}:app`, name: 'App A' },
    });
    await db.appAgent.create({ data: { appId: app.id, agentId: pubAgentA.id } });
    await db.agentOrgGrant.create({ data: { orgId: orgA.id, agentId: pubAgentA.id } });
    const parent = { id: pubAgentA.id, organizationId: orgA.id };
    // member is only a READER of orgA — previously ADMIN-only, now member-level.
    expect((await A.apps(parent, {}, asMember())).map((x: any) => x.id)).toEqual([app.id]);
    expect((await A.appAgents(parent, {}, asMember()))).toHaveLength(1);
    expect((await A.orgGrants(parent, {}, asMember()))).toHaveLength(1);
    expect(await A.appCount(parent, {}, asMember())).toBe(1);
  });

  it("a non-member reading a PUBLIC agent sees the agent's OWN definition (imports) but NOT who uses it", async () => {
    const app = await db.app.create({
      data: { id: generateId(), organizationId: orgA.id, urn: `${orgA.urn}:app2`, name: 'App A2' },
    });
    await db.appAgent.create({ data: { appId: app.id, agentId: pubAgentA.id } });
    await db.agentOrgGrant.create({ data: { orgId: orgA.id, agentId: pubAgentA.id } });
    const dep = await db.agent.create({
      data: { id: generateId(), organizationId: orgA.id, urn: `${orgA.urn}:dep`, name: 'Dep', visibility: 'ORGANIZATION' },
    });
    await db.agentOrgGrant.create({ data: { orgId: orgA.id, agentId: dep.id } });
    await db.agentImport.create({
      data: {
        parentAgentId: pubAgentA.id, importedAgentId: dep.id, position: 100,
        agentOrgGrantOrgId: orgA.id, agentOrgGrantAgentId: dep.id,
      },
    });
    const parent = { id: pubAgentA.id, organizationId: orgA.id };
    // Own definition (imports) is public …
    expect((await A.imports(parent, {}, asStranger())).map((i: any) => i.importedAgentId)).toEqual([dep.id]);
    // … but the "who uses it" fields never leak other tenants' Apps / grants.
    expect(await A.apps(parent, {}, asStranger())).toEqual([]);
    expect(await A.appAgents(parent, {}, asStranger())).toEqual([]);
    expect(await A.orgGrants(parent, {}, asStranger())).toEqual([]);
    expect(await A.appCount(parent, {}, asStranger())).toBe(0);
    // Same for an unauthenticated caller.
    expect(await A.apps(parent, {}, asAnon())).toEqual([]);
  });

  it('apps never returns a FOREIGN org\'s App, even to a member of the agent\'s org (no App-key leak)', async () => {
    // orgB installs the PUBLIC agent into orgB's App (cross-org marketplace).
    const foreignApp = await db.app.create({
      data: { id: generateId(), organizationId: orgB.id, urn: `${orgB.urn}:fapp`, name: 'Foreign App' },
    });
    await db.appAgent.create({ data: { appId: foreignApp.id, agentId: pubAgentA.id } });
    const parent = { id: pubAgentA.id, organizationId: orgA.id };
    // member belongs to orgA only → the orgB App (with its keys/members) is
    // filtered out; they see none of it through the agent.
    expect(await A.apps(parent, {}, asMember())).toEqual([]);
    expect(await A.appAgents(parent, {}, asMember())).toEqual([]);
    // A platform admin sees all installers.
    expect((await A.apps(parent, {}, asAdmin())).map((x: any) => x.id)).toEqual([foreignApp.id]);
  });
});

describe('installAgentIntoApp — CONTRIBUTOR floor + cross-org PUBLIC (issue #551)', () => {
  const M = resolvers.Mutation as any;
  let app: { id: string };
  let contributor: { id: string }; // CONTRIBUTOR of orgA
  let foreignPub: { id: string };  // PUBLIC agent owned by orgB
  let foreignPriv: { id: string }; // ORGANIZATION agent owned by orgB

  beforeEach(async () => {
    app = await db.app.create({
      data: { id: generateId(), organizationId: orgA.id, urn: `${orgA.urn}:iapp`, name: 'Install App' },
    });
    contributor = await db.user.create({ data: { id: generateId(), githubId: 55201, githubUsername: 'pa-contrib', roles: ['READER'] } });
    await db.orgMember.create({ data: { id: generateId(), organizationId: orgA.id, userId: contributor.id, role: 'CONTRIBUTOR' } });
    foreignPub = await db.agent.create({
      data: { id: generateId(), organizationId: orgB.id, urn: `${orgB.urn}:fpub`, name: 'Foreign Pub', visibility: 'PUBLIC' },
    });
    foreignPriv = await db.agent.create({
      data: { id: generateId(), organizationId: orgB.id, urn: `${orgB.urn}:fpriv`, name: 'Foreign Priv', visibility: 'ORGANIZATION' },
    });
  });

  it('a CONTRIBUTOR of the App org can install a same-org agent (was ADMIN-only)', async () => {
    const res = await M.installAgentIntoApp(null, { appRef: app.id, agentRef: pubAgentA.id }, ctx(contributor.id));
    expect(res.appAgent.agentId).toBe(pubAgentA.id);
  });

  it('a READER of the App org cannot install (CONTRIBUTOR floor)', async () => {
    await expect(
      M.installAgentIntoApp(null, { appRef: app.id, agentRef: pubAgentA.id }, asMember()),
    ).rejects.toThrow('Forbidden');
  });

  it('a foreign PUBLIC agent requires an existing active AgentOrgGrant', async () => {
    await expect(M.installAgentIntoApp(null, { appRef: app.id, agentRef: foreignPub.id }, ctx(contributor.id)))
      .rejects.toMatchObject({ extensions: { code: 'AGENT_ORG_GRANT_REQUIRED' } });
    await createDbAgentOrgGrant(db, orgA.id, foreignPub.id);
    const res = await M.installAgentIntoApp(null, { appRef: app.id, agentRef: foreignPub.id }, ctx(contributor.id));
    expect(res.appAgent.agentId).toBe(foreignPub.id);
    const grant = await db.agentOrgGrant.findFirst({ where: { orgId: orgA.id, agentId: foreignPub.id } });
    expect(grant).not.toBeNull();
  });

  it('a foreign NON-PUBLIC agent without a grant is concealed', async () => {
    await expect(
      M.installAgentIntoApp(null, { appRef: app.id, agentRef: foreignPriv.id }, ctx(contributor.id)),
    ).rejects.toThrow(/AGENT_NOT_FOUND/);
  });
});

/**
 * #757 — `Agent.importedBy` returns OTHER tenants' parent agents, and
 * `AgentImport.parentAgent` hydrates each with no gate of its own. On a PUBLIC
 * agent that leaked foreign orgs' private agent definitions (description) to
 * any caller, including anonymous. Same class as #552.
 */
describe('Agent.importedBy — cross-tenant parent-agent scoping (#757)', () => {
  // orgB privately bundles orgA's PUBLIC agent — the intended marketplace flow.
  let orgBPrivateParent: { id: string };
  let orgBMember: { id: string };

  beforeEach(async () => {
    await createDbAgentOrgGrant(db, orgB.id, pubAgentA.id);
    orgBPrivateParent = await db.agent.create({
      data: {
        id: generateId(), organizationId: orgB.id, urn: `${orgB.urn}:suite`,
        name: 'Org B Suite', visibility: 'ORGANIZATION',
        description: 'ORG-B-PROPRIETARY-PROMPT',
      },
    });
    await createDbAgentImport(db, orgBPrivateParent.id, pubAgentA.id);
    orgBMember = await db.user.create({
      data: { id: generateId(), githubId: 55104, githubUsername: 'pa-orgb', roles: ['READER'] },
    });
    await db.orgMember.create({
      data: { id: generateId(), organizationId: orgB.id, userId: orgBMember.id, role: 'READER' },
    });
  });

  it('an ANONYMOUS caller gets no importedBy row for a foreign private parent', async () => {
    expect(await A.importedBy(pubAgentA, {}, asAnon())).toEqual([]);
  });

  it('a NON-MEMBER of the parent org gets nothing (member of orgA only)', async () => {
    expect(await A.importedBy(pubAgentA, {}, asMember())).toEqual([]);
    expect(await A.importedBy(pubAgentA, {}, asStranger())).toEqual([]);
  });

  it('a member of the PARENT org still sees the row (no regression)', async () => {
    const rows = await A.importedBy(pubAgentA, {}, ctx(orgBMember.id));
    expect(rows.map((r: { parentAgentId: string }) => r.parentAgentId)).toEqual([orgBPrivateParent.id]);
  });

  it('a platform ADMIN sees every row unscoped', async () => {
    const rows = await A.importedBy(pubAgentA, {}, asAdmin());
    expect(rows.map((r: { parentAgentId: string }) => r.parentAgentId)).toEqual([orgBPrivateParent.id]);
  });

  it('a PUBLIC parent stays visible to everyone (it publishes itself)', async () => {
    const publicParent = await db.agent.create({
      data: {
        id: generateId(), organizationId: orgB.id, urn: `${orgB.urn}:pub-suite`,
        name: 'Org B Public Suite', visibility: 'PUBLIC',
      },
    });
    await createDbAgentImport(db, publicParent.id, pubAgentA.id, { position: 200 });
    const anonRows = await A.importedBy(pubAgentA, {}, asAnon());
    expect(anonRows.map((r: { parentAgentId: string }) => r.parentAgentId)).toEqual([publicParent.id]);
  });

  it('the leak is closed end-to-end: the foreign description is unreachable', async () => {
    // The pre-#757 exploit: read the PUBLIC agent, walk importedBy →
    // parentAgent → description.
    const agent = await Q.agent(null, { ref: pubAgentA.id }, asAnon());
    expect(agent).not.toBeNull();
    const rows = await A.importedBy(agent, {}, asAnon());
    const parents = await Promise.all(
      rows.map((r: unknown) => (resolvers.AgentImport as any).parentAgent(r, {}, asAnon())),
    );
    expect(parents.map((p: { description: string } | null) => p?.description))
      .not.toContain('ORG-B-PROPRIETARY-PROMPT');
  });

  // PR #843 review (Copilot): `AgentImport.parentAgent` hydrates by bare
  // findUnique with no soft-delete check, so an unfiltered admin branch let a
  // platform admin resolve a DELETED parent — while Query.agent returns null
  // for one. `deletedAt: null` is now unconditional in the filter.
  it('a SOFT-DELETED parent is unreachable, including for a platform ADMIN', async () => {
    await db.agent.update({
      where: { id: orgBPrivateParent.id },
      data: { deletedAt: new Date() },
    });
    expect(await A.importedBy(pubAgentA, {}, asAdmin())).toEqual([]);
    expect(await A.importedBy(pubAgentA, {}, ctx(orgBMember.id))).toEqual([]);
    // Parity check: the top-level read surface agrees.
    expect(await Q.agent(null, { ref: orgBPrivateParent.id }, asAdmin())).toBeNull();
  });

  // PR #843 review (Codex P2): an App-key principal has ctx.appId and NO
  // ctx.userId, so the member-org clauses can't match. It is nonetheless
  // authorized for the agents installed in its App via myApp.agents, and
  // dropping those parents would regress importedBy for deployed Apps.
  it('an APP-KEY caller sees a parent installed in its own App', async () => {
    const app = await db.app.create({
      data: {
        id: generateId(), organizationId: orgB.id,
        urn: `${orgB.urn}:ik-app-${generateId()}`, name: 'Installed App',
        appAgents: { create: { agentId: orgBPrivateParent.id } },
      },
    });
    const rows = await A.importedBy(pubAgentA, {}, { db, appId: app.id, roles: ['READER'] } as Context);
    expect(rows.map((r: { parentAgentId: string }) => r.parentAgentId)).toEqual([orgBPrivateParent.id]);
  });

  it('an APP-KEY caller does NOT see a parent installed in a DIFFERENT App', async () => {
    const otherApp = await db.app.create({
      data: {
        id: generateId(), organizationId: orgB.id,
        urn: `${orgB.urn}:other-app-${generateId()}`, name: 'Other App',
      },
    });
    const rows = await A.importedBy(pubAgentA, {}, { db, appId: otherApp.id, roles: ['READER'] } as Context);
    expect(rows).toEqual([]);
  });

  it('the agent’s OWN definition stays public (#551 not regressed)', async () => {
    const agent = await Q.agent(null, { ref: pubAgentA.id }, asAnon());
    expect(agent.description).toBe('SECRET-PROMPT');
    expect(await A.imports(agent, {}, asAnon())).toEqual([]);
  });
});
