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
 *   - Slim public projection: a non-member reading a PUBLIC agent sees
 *     discovery fields only — systemPrompt / systemMemoryId / memoryItems /
 *     imports / importedBy are member/admin-gated (null / []).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
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
      systemPrompt: 'SECRET-PROMPT', systemMemoryId: sysMem.id,
    },
  });
  orgAgentA = await db.agent.create({
    data: {
      id: generateId(), organizationId: orgA.id, urn: `${orgA.urn}:org-agent`,
      name: 'Org Agent', visibility: 'ORGANIZATION', systemPrompt: 'ORG-PROMPT',
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
    await expect(Q.agent(null, { ref: orgAgentA.id }, asStranger())).rejects.toThrow('Forbidden');
    await expect(Q.agent(null, { ref: orgAgentA.id }, asAnon())).rejects.toThrow('Forbidden');
  });

  it('an org member still reads their org ORGANIZATION agent (no regression)', async () => {
    expect((await Q.agent(null, { ref: orgAgentA.id }, asMember()))?.id).toBe(orgAgentA.id);
  });

  it('a REVOKED member is denied on an ORGANIZATION agent but still reads a PUBLIC one', async () => {
    await db.orgMember.updateMany({ where: { organizationId: orgA.id, userId: member.id }, data: { deletedAt: new Date() } });
    await expect(Q.agent(null, { ref: orgAgentA.id }, asMember())).rejects.toThrow('Forbidden');
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

describe('Agent fields — no field-level admin gate; object gate is the only gate (issue #551)', () => {
  // Previously apps / appAgents / orgGrants returned [] unless the caller was
  // org ADMIN/OWNER. Now the object-level read gate is the only gate, so any
  // member — and any caller who can read a PUBLIC agent — sees them.
  it('apps / appAgents / orgGrants are visible to a READER member (was ADMIN-only)', async () => {
    const app = await db.app.create({
      data: { id: generateId(), organizationId: orgA.id, urn: `${orgA.urn}:app`, name: 'App A' },
    });
    await db.appAgent.create({ data: { appId: app.id, agentId: pubAgentA.id } });
    await db.agentOrgGrant.create({ data: { orgId: orgA.id, agentId: pubAgentA.id } });
    const parent = { id: pubAgentA.id };
    // member is only a READER of orgA — previously an empty list, now full.
    expect((await A.apps(parent, {}, asMember())).map((x: any) => x.id)).toEqual([app.id]);
    expect((await A.appAgents(parent, {}, asMember()))).toHaveLength(1);
    expect((await A.orgGrants(parent, {}, asMember()))).toHaveLength(1);
    expect(await A.appCount(parent, {}, asMember())).toBe(1);
  });

  it('a non-member reading a PUBLIC agent sees its full install topology + imports', async () => {
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
    const parent = { id: pubAgentA.id };
    // stranger obtained the PUBLIC agent object → every field resolves.
    expect((await A.apps(parent, {}, asStranger()))).toHaveLength(1);
    expect((await A.appAgents(parent, {}, asStranger()))).toHaveLength(1);
    expect((await A.orgGrants(parent, {}, asStranger()))).toHaveLength(1);
    expect((await A.imports(parent, {}, asStranger())).map((i: any) => i.importedAgentId)).toEqual([dep.id]);
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
    const res = await M.installAgentIntoApp(null, { appId: app.id, agentId: pubAgentA.id }, ctx(contributor.id));
    expect(res.appAgent.agentId).toBe(pubAgentA.id);
  });

  it('a READER of the App org cannot install (CONTRIBUTOR floor)', async () => {
    await expect(
      M.installAgentIntoApp(null, { appId: app.id, agentId: pubAgentA.id }, asMember()),
    ).rejects.toThrow('Forbidden');
  });

  it('a foreign PUBLIC agent installs cross-org and auto-provisions the AgentOrgGrant', async () => {
    const res = await M.installAgentIntoApp(null, { appId: app.id, agentId: foreignPub.id }, ctx(contributor.id));
    expect(res.appAgent.agentId).toBe(foreignPub.id);
    const grant = await db.agentOrgGrant.findFirst({ where: { orgId: orgA.id, agentId: foreignPub.id } });
    expect(grant).not.toBeNull();
  });

  it('a foreign NON-PUBLIC agent is still rejected (ORGANIZATION_MISMATCH)', async () => {
    await expect(
      M.installAgentIntoApp(null, { appId: app.id, agentId: foreignPriv.id }, ctx(contributor.id)),
    ).rejects.toThrow(/organization/i);
  });
});
