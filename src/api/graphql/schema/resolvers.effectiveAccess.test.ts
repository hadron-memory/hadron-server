/**
 * issue #323 — authoritative effectiveAccess(user, resource) resolver.
 *
 * Exercises the per-resource grant composition and the caller-authorization
 * gate. The resolver answers "what standing access does user X have to
 * resource Y, and which grants confer it?" reusing the server's authz rules.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import {
  cleanDb,
  createDbOrgAndGraph,
  createDbNode,
  createDbAppWithKey,
  createDbAppMember,
  createDbAgentSubscription,
  createDbAgentOrgGrant,
} from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

function ctx(overrides: Partial<Context> = {}): Context {
  return { db, ...overrides };
}

const call = (user: string, resource: string, caller: Context) =>
  resolvers.Query.effectiveAccess(null, { user, resource }, caller);

let org: { id: string; urn: string };
let graph: { id: string; urn: string };
let admin: { id: string }; // platform OWNER + org member (the privileged caller)
let orgAdmin: { id: string }; // org ADMIN (not platform)
let member: { id: string }; // plain org READER
let stranger: { id: string }; // not a member of org

const asAdmin = () => ctx({ userId: admin.id, roles: ['OWNER'] });

beforeEach(async () => {
  await cleanDb(db);
  const a = await createDbOrgAndGraph(db, {
    orgName: 'acme',
    graphName: 'acme/kb',
    visibility: 'ORGANIZATION',
  });
  org = a.org as any;
  graph = a.graph as any;
  admin = await db.user.create({ data: { githubId: 1, githubUsername: 'op', roles: ['OWNER'] } });
  orgAdmin = await db.user.create({ data: { githubId: 2, githubUsername: 'oa', roles: ['READER'] } });
  member = await db.user.create({ data: { githubId: 3, githubUsername: 'mem', roles: ['READER'] } });
  stranger = await db.user.create({ data: { githubId: 4, githubUsername: 'str', roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: orgAdmin.id, role: 'ADMIN' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: member.id, role: 'READER' } });
});

describe('caller authorization (who may CALL)', () => {
  it('a non-privileged caller gets FORBIDDEN, not an empty result', async () => {
    const memUrn = `hrn:memory:${graph.urn}`;
    await expect(call(member.id, memUrn, ctx({ userId: stranger.id, roles: ['READER'] }))).rejects.toThrow(
      'Forbidden',
    );
  });

  it('an org ADMIN of the owning org may audit', async () => {
    const memUrn = `hrn:memory:${graph.urn}`;
    const res = await call(member.id, memUrn, ctx({ userId: orgAdmin.id, roles: ['READER'] }));
    expect(res.resourceKind).toBe('memory');
  });

  it('a platform admin may audit', async () => {
    const res = await call(member.id, `hrn:memory:${graph.urn}`, asAdmin());
    expect(res.resourceKind).toBe('memory');
  });
});

describe('memory — knowledge class', () => {
  it('org ADMIN subject has manage via ORG_ROLE', async () => {
    const res = await call(orgAdmin.id, `hrn:memory:${graph.urn}`, asAdmin());
    expect(res.canRead).toBe(true);
    expect(res.canWrite).toBe(true);
    expect(res.canManage).toBe(true);
    expect(res.role).toBe('ADMIN');
    expect(res.grants[0].source).toBe('ORG_ROLE');
  });

  it('plain org member reads ORGANIZATION-visible knowledge (read only)', async () => {
    const res = await call(member.id, `hrn:memory:${graph.urn}`, asAdmin());
    expect(res.canRead).toBe(true);
    expect(res.canWrite).toBe(false);
    expect(res.canManage).toBe(false);
    expect(res.grants.map((g) => g.source)).toEqual(['ORG_ROLE']);
  });

  it('org CONTRIBUTOR can write (mirrors requireMemoryWriteAccess), not manage', async () => {
    const contributor = await db.user.create({ data: { githubId: 9, githubUsername: 'con', roles: ['READER'] } });
    await db.orgMember.create({ data: { organizationId: org.id, userId: contributor.id, role: 'CONTRIBUTOR' } });
    const res = await call(contributor.id, `hrn:memory:${graph.urn}`, asAdmin());
    expect(res.canRead).toBe(true);
    expect(res.canWrite).toBe(true);
    expect(res.canManage).toBe(false);
    expect(res.canDelete).toBe(false);
    expect(res.role).toBe('CONTRIBUTOR');
  });

  it('per-user holding (userMemoryOfAgentId set) is owner-only — org members get nothing', async () => {
    // A knowledge "holding" memory (e.g. the startChat no-App downgrade) is
    // excluded from getOrgReadableMemoryIds, so org membership must NOT confer
    // read/write — even for an ADMIN. Over-reporting here is the one direction
    // the resolver promises never to take.
    const agent = await db.agent.create({
      data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:holdingagent`, name: 'h' },
    });
    const holding = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        urn: `${org.urn}:holding`,
        name: 'holding',
        class: 'knowledge',
        visibility: 'ORGANIZATION',
        userMemoryOfAgentId: agent.id,
        createdBy: member.id,
      },
    });
    for (const subject of [member.id, orgAdmin.id]) {
      const res = await call(subject, `hrn:memory:${holding.urn}`, asAdmin());
      expect(res.canRead).toBe(false);
      expect(res.canWrite).toBe(false);
      expect(res.grants).toEqual([]);
    }
  });

  it('a non-member has no access — empty grants, not an error', async () => {
    const res = await call(stranger.id, `hrn:memory:${graph.urn}`, asAdmin());
    expect(res.canRead).toBe(false);
    expect(res.grants).toEqual([]);
    expect(res.role).toBeNull();
  });

  it('PUBLIC visibility grants read to anyone', async () => {
    await db.memory.update({ where: { id: graph.id }, data: { visibility: 'PUBLIC' } });
    const res = await call(stranger.id, `hrn:memory:${graph.urn}`, asAdmin());
    expect(res.canRead).toBe(true);
    expect(res.grants.some((g) => g.source === 'PUBLIC_VISIBILITY')).toBe(true);
  });
});

describe('memory — personal class (strict owner)', () => {
  async function freeStandingPersonal(ownerId: string) {
    return db.memory.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        urn: `${org.urn}:personal-${ownerId}`,
        name: `personal-${ownerId}`,
        class: 'personal',
        visibility: null,
        userId: ownerId,
      },
    });
  }

  it('the owner is the MEMORY_PRINCIPAL with full capabilities', async () => {
    const mem = await freeStandingPersonal(member.id);
    const res = await call(member.id, `hrn:memory:${mem.urn}`, asAdmin());
    expect(res.role).toBe('owner');
    expect(res.canRead && res.canWrite && res.canManage && res.canDelete).toBe(true);
    expect(res.grants).toEqual([{ source: 'MEMORY_PRINCIPAL', role: 'owner', via: null }]);
  });

  it('a platform admin subject gets NO access (no bypass into personal)', async () => {
    const mem = await freeStandingPersonal(member.id);
    const res = await call(admin.id, `hrn:memory:${mem.urn}`, asAdmin());
    expect(res.canRead).toBe(false);
    expect(res.grants).toEqual([]);
  });

  it('a MemoryShare writer grantee gets MEMORY_SHARE write', async () => {
    const mem = await freeStandingPersonal(member.id);
    await db.memoryShare.create({
      data: { memoryId: mem.id, granteeId: stranger.id, grantorId: member.id, role: 'writer' },
    });
    const res = await call(stranger.id, `hrn:memory:${mem.urn}`, asAdmin());
    expect(res.canRead).toBe(true);
    expect(res.canWrite).toBe(true);
    expect(res.grants[0].source).toBe('MEMORY_SHARE');
    expect(res.role).toBe('writer');
  });

  it('the owner may audit their own personal memory', async () => {
    const mem = await freeStandingPersonal(member.id);
    const res = await call(member.id, `hrn:memory:${mem.urn}`, ctx({ userId: member.id, roles: ['READER'] }));
    expect(res.role).toBe('owner');
  });
});

describe('node — inherits its memory', () => {
  it('node access is the memory access, tagged NODE_INHERITED', async () => {
    await createDbNode(db, { loc: 'note1', memoryId: graph.id });
    const res = await call(orgAdmin.id, `hrn:node:${graph.urn}:note1`, asAdmin());
    expect(res.resourceKind).toBe('node');
    expect(res.canManage).toBe(true);
    expect(res.grants[0].source).toBe('NODE_INHERITED');
    expect(res.grants[0].via).toBe(graph.urn);
  });
});

describe('app', () => {
  it('an AppMember has use (read+write) via APP_MEMBER, but not manage', async () => {
    const { app } = await createDbAppWithKey(db, 'myapp', org.id);
    await createDbAppMember(db, app.id, member.id, 'owner');
    const res = await call(member.id, `hrn:app:${app.urn}`, asAdmin());
    expect(res.resourceKind).toBe('app');
    expect(res.canRead).toBe(true);
    expect(res.canWrite).toBe(true);
    // Managing an App is an owning-org-admin capability, not an AppMember one.
    expect(res.canManage).toBe(false);
    expect(res.grants.some((g) => g.source === 'APP_MEMBER')).toBe(true);
  });

  it('an org ADMIN manages the app via ORG_ROLE', async () => {
    const { app } = await createDbAppWithKey(db, 'myapp2', org.id);
    const res = await call(orgAdmin.id, `hrn:app:${app.urn}`, asAdmin());
    expect(res.canManage).toBe(true);
    expect(res.grants.some((g) => g.source === 'ORG_ROLE')).toBe(true);
  });
});

describe('agent', () => {
  async function makeAgent(slug: string) {
    return db.agent.create({
      data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:${slug}`, name: slug },
    });
  }

  it('an active AgentSubscription confers use (read), role null (capability-based)', async () => {
    const agent = await makeAgent('juno');
    await createDbAgentSubscription(db, member.id, agent.id);
    const res = await call(member.id, `hrn:agent:${agent.urn}`, asAdmin());
    expect(res.resourceKind).toBe('agent');
    expect(res.canRead).toBe(true);
    expect(res.canManage).toBe(false);
    expect(res.role).toBeNull();
    expect(res.grants[0].source).toBe('AGENT_SUBSCRIPTION');
  });

  it('an org-level AgentOrgGrant confers use to the org member', async () => {
    const agent = await makeAgent('juno2');
    await createDbAgentOrgGrant(db, org.id, agent.id);
    const res = await call(member.id, `hrn:agent:${agent.urn}`, asAdmin());
    expect(res.canRead).toBe(true);
    expect(res.grants.some((g) => g.source === 'AGENT_SUBSCRIPTION' && g.role === 'org-grant')).toBe(true);
  });

  it('an org ADMIN manages the agent', async () => {
    const agent = await makeAgent('juno3');
    const res = await call(orgAdmin.id, `hrn:agent:${agent.urn}`, asAdmin());
    expect(res.canManage).toBe(true);
    expect(res.grants.some((g) => g.source === 'ORG_ROLE')).toBe(true);
  });

  it('a stranger has no access', async () => {
    const agent = await makeAgent('juno4');
    const res = await call(stranger.id, `hrn:agent:${agent.urn}`, asAdmin());
    expect(res.canRead).toBe(false);
    expect(res.grants).toEqual([]);
  });
});

describe('aiServiceConfig (bare id, no URN)', () => {
  it('an org ADMIN of the owning org has AICONFIG_OWNER access', async () => {
    const config = await db.aiServiceConfig.create({
      data: {
        id: generateId(),
        name: 'default',
        organizationId: org.id,
        provider: 'anthropic',
        model: 'claude',
      },
    });
    const res = await call(orgAdmin.id, config.id, asAdmin());
    expect(res.resourceKind).toBe('aiServiceConfig');
    expect(res.canManage).toBe(true);
    expect(res.grants.some((g) => g.source === 'AICONFIG_OWNER')).toBe(true);
    expect(res.resourceUrn).toBe(config.id);
  });

  it('a plain member has no access to the org config', async () => {
    const config = await db.aiServiceConfig.create({
      data: {
        id: generateId(),
        name: 'default',
        organizationId: org.id,
        provider: 'anthropic',
        model: 'claude',
      },
    });
    const res = await call(member.id, config.id, asAdmin());
    expect(res.canManage).toBe(false);
    expect(res.grants).toEqual([]);
  });
});

describe('not-found / unknown refs', () => {
  it('an unknown subject user is NOT_FOUND', async () => {
    await expect(call(generateId(), `hrn:memory:${graph.urn}`, asAdmin())).rejects.toThrow(/not found/i);
  });

  it('an unresolvable resource URN is NOT_FOUND', async () => {
    await expect(call(member.id, 'hrn:memory:acme::does-not-exist', asAdmin())).rejects.toThrow(/not found/i);
  });

  it('a garbage bare id is NOT_FOUND', async () => {
    await expect(call(member.id, generateId(), asAdmin())).rejects.toThrow(/not found/i);
  });
});

describe('the resolved user is returned', () => {
  it('exposes the subject User for the user field', async () => {
    const res = await call(member.id, `hrn:memory:${graph.urn}`, asAdmin());
    expect((res as any).user.id).toBe(member.id);
  });
});
