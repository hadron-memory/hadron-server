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
  // The memory slug is deliberately a MINTABLE one (v2 atom charset). The
  // helper's default carries a `/`, which no create path can produce since
  // FR-016 — and an un-emittable stored urn would exercise the #966 fallback
  // on every case in this file instead of the emission it is pinning.
  const a = await createDbOrgAndGraph(db, {
    orgName: 'acme',
    graphName: 'kb',
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

  it('a plain org member may audit their OWN access to a memory (issue #364)', async () => {
    // Self-audit is ungated: the member learns only what they could already
    // infer by trying the operation, so there's no info-leak.
    const res = await call(member.id, `hrn:memory:${graph.urn}`, ctx({ userId: member.id, roles: ['READER'] }));
    expect(res.resourceKind).toBe('memory');
    expect(res.canRead).toBe(true);
  });

  it('a plain org member may audit their OWN access to an agent (issue #364)', async () => {
    const agent = await db.agent.create({
      data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:selfauditagent`, name: 'sa' },
    });
    await createDbAgentSubscription(db, member.id, agent.id);
    const res = await call(member.id, `hrn:agent:${agent.urn}`, ctx({ userId: member.id, roles: ['READER'] }));
    expect(res.resourceKind).toBe('agent');
    expect(res.canRead).toBe(true);
  });

  it('self-audit does NOT let a member audit a DIFFERENT subject (still FORBIDDEN)', async () => {
    // The relaxation is strictly subject == caller; cross-subject stays gated.
    await expect(
      call(orgAdmin.id, `hrn:memory:${graph.urn}`, ctx({ userId: member.id, roles: ['READER'] })),
    ).rejects.toThrow('Forbidden');
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

describe('organization', () => {
  it('an org ADMIN administers the org (manage) but cannot delete it', async () => {
    const res = await call(orgAdmin.id, `hrn:org:${org.urn}`, asAdmin());
    expect(res.resourceKind).toBe('organization');
    expect(res.resourceUrn).toBe(`hrn:org:${org.urn}`);
    expect(res.canManage).toBe(true);
    expect(res.canDelete).toBe(false);
    expect(res.grants.some((g) => g.source === 'ORG_ROLE')).toBe(true);
  });

  it('a plain org member reads the org, no manage', async () => {
    const res = await call(member.id, `hrn:org:${org.urn}`, asAdmin());
    expect(res.canRead).toBe(true);
    expect(res.canManage).toBe(false);
    expect(res.grants[0].source).toBe('ORG_ROLE');
  });

  it('a platform admin has full access incl. delete', async () => {
    const res = await call(admin.id, `hrn:org:${org.urn}`, asAdmin());
    expect(res.canManage).toBe(true);
    expect(res.canDelete).toBe(true);
    expect(res.grants.some((g) => g.source === 'PLATFORM_ROLE')).toBe(true);
  });

  it('a stranger has no access — empty grants, not an error', async () => {
    const res = await call(stranger.id, `hrn:org:${org.urn}`, asAdmin());
    expect(res.canRead).toBe(false);
    expect(res.grants).toEqual([]);
  });

  it('an unknown org URN is NOT_FOUND (not a misleading bare-id miss)', async () => {
    await expect(call(member.id, 'hrn:org:no-such-org', asAdmin())).rejects.toThrow(/not found/i);
  });
});

describe('user (hrn:user:<handle>)', () => {
  // `member` etc. are created without a handle; give the subjects one to address.
  async function withHandle(userId: string, handle: string) {
    await db.user.update({ where: { id: userId }, data: { handle } });
    return handle;
  }

  it('the user themselves has manage on their own account, but not delete', async () => {
    const h = await withHandle(member.id, 'mem-handle');
    const res = await call(member.id, `hrn:user:${h}`, asAdmin());
    expect(res.resourceKind).toBe('user');
    expect(res.resourceUrn).toBe(`hrn:user:${h}`);
    expect(res.canManage).toBe(true);
    expect(res.canDelete).toBe(false);
    expect(res.role).toBe('self');
    expect(res.grants.some((g) => g.source === 'USER_SELF')).toBe(true);
  });

  it('a platform admin has full access (incl. delete) to any user', async () => {
    const h = await withHandle(member.id, 'mem-handle2');
    const res = await call(admin.id, `hrn:user:${h}`, asAdmin());
    expect(res.canDelete).toBe(true);
    expect(res.grants.some((g) => g.source === 'PLATFORM_ROLE')).toBe(true);
  });

  it('a different non-admin user has no standing access', async () => {
    const h = await withHandle(member.id, 'mem-handle3');
    const res = await call(stranger.id, `hrn:user:${h}`, asAdmin());
    expect(res.canRead).toBe(false);
    expect(res.grants).toEqual([]);
  });

  it('a non-admin caller may NOT audit another user (FORBIDDEN)', async () => {
    // Subject (member) ≠ caller (stranger): a genuine cross-subject audit, still
    // gated. (Self-audit, where subject == caller, is allowed — see #364.)
    const h = await withHandle(member.id, 'mem-handle4');
    await expect(
      call(member.id, `hrn:user:${h}`, ctx({ userId: stranger.id, roles: ['READER'] })),
    ).rejects.toThrow(/forbidden/i);
  });

  it('a user may audit their own access', async () => {
    const h = await withHandle(member.id, 'mem-handle5');
    const res = await call(member.id, `hrn:user:${h}`, ctx({ userId: member.id, roles: ['READER'] }));
    expect(res.canManage).toBe(true);
  });

  it('an unknown handle is NOT_FOUND', async () => {
    await expect(call(member.id, 'hrn:user:nobody-here', asAdmin())).rejects.toThrow(/not found/i);
  });

  it('a soft-deleted user is NOT_FOUND (handle resolves but row is gone)', async () => {
    const h = await withHandle(member.id, 'gone-handle');
    await db.user.update({ where: { id: member.id }, data: { deletedAt: new Date() } });
    await expect(call(member.id, `hrn:user:${h}`, asAdmin())).rejects.toThrow(/not found/i);
  });

  it('accepts a hrn:user:<handle> URN as the SUBJECT (#325)', async () => {
    // The subject (whose access we audit) may be addressed by URN, not just id.
    const h = await withHandle(member.id, 'subject-handle');
    const res = await call(`hrn:user:${h}`, `hrn:memory:${graph.urn}`, asAdmin());
    expect(res.resourceKind).toBe('memory');
    expect((res as { user: { id: string } }).user.id).toBe(member.id);
  });
});

describe('resourceUrn is emitted, not echoed (#966 / hadron-cli#423)', () => {
  // The stored `urn` column is a BARE body by construction (the
  // chk_*_urn_not_prefixed guardrails), so echoing it handed callers a string
  // this server's own ref parsers reject — while the same row's `Memory.urn`
  // field emitted the canonical form. The contract is the SHAPE: resourceUrn is
  // the only URN the caller gets back, and callers feed it to other commands.

  it('a memory resolves to its canonical hrn:mem: URN, not the stored column', async () => {
    const res = await call(orgAdmin.id, `hrn:memory:${graph.urn}`, asAdmin());
    expect(res.resourceUrn).toBe(`hrn:mem:${graph.urn}`);
    expect(res.resourceUrn).not.toBe(graph.urn);
  });

  it('an app resolves to its canonical hrn:app: URN', async () => {
    const { app } = await createDbAppWithKey(db, 'urnapp', org.id);
    const res = await call(orgAdmin.id, `hrn:app:${app.urn}`, asAdmin());
    expect(res.resourceUrn).toBe(`hrn:app:${app.urn}`);
  });

  it('an agent resolves to its canonical hrn:agent: URN', async () => {
    const agent = await db.agent.create({
      data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:urnagent`, name: 'ua' },
    });
    const res = await call(orgAdmin.id, `hrn:agent:${agent.urn}`, asAdmin());
    expect(res.resourceUrn).toBe(`hrn:agent:${agent.urn}`);
  });

  it('a node still resolves to its flat v2 node URN (unchanged)', async () => {
    await createDbNode(db, { loc: 'urnnode', memoryId: graph.id });
    const res = await call(orgAdmin.id, `hrn:node:${graph.urn}:urnnode`, asAdmin());
    expect(res.resourceUrn).toBe(`hrn:node:${graph.urn}:urnnode`);
  });

  it('every kind round-trips: the returned resourceUrn re-audits to the same resource', async () => {
    // The property the CLI actually needs — `hadron access check` printed a URN
    // its own argument parser then refused (hadron-cli#423).
    const { app } = await createDbAppWithKey(db, 'rtapp', org.id);
    const agent = await db.agent.create({
      data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:rtagent`, name: 'rt' },
    });
    await createDbNode(db, { loc: 'rtnode', memoryId: graph.id });
    const refs = [
      `hrn:memory:${graph.urn}`,
      `hrn:node:${graph.urn}:rtnode`,
      `hrn:app:${app.urn}`,
      `hrn:agent:${agent.urn}`,
      `hrn:org:${org.urn}`,
    ];
    for (const ref of refs) {
      const first = await call(orgAdmin.id, ref, asAdmin());
      const again = await call(orgAdmin.id, first.resourceUrn, asAdmin());
      expect(again.resourceKind).toBe(first.resourceKind);
      expect(again.resourceUrn).toBe(first.resourceUrn);
    }
  });

  it('an un-emittable STORED urn falls back to the raw value instead of failing the audit', async () => {
    // A legacy row whose slug predates the FR-016 charset. The audit must keep
    // answering — a corrupt row is exactly when someone runs an access check.
    const legacy = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        urn: `${org.urn}:legacy/slug`,
        name: 'legacy/slug',
        class: 'knowledge',
        visibility: 'ORGANIZATION',
      },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await call(orgAdmin.id, `hrn:memory:${legacy.urn}`, asAdmin());
      expect(res.resourceUrn).toBe(legacy.urn);
      expect(res.canRead).toBe(true);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
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

describe('memory — individual action grants (PRINCIPAL_GRANT, cor:acl:040:06)', () => {
  const grantRow = (userId: string, actions: string[], overrides: Record<string, unknown> = {}) =>
    db.principalGrant.create({
      data: {
        id: generateId(),
        principalType: 'USER',
        principalId: userId,
        organizationId: org.id,
        actions,
        ...overrides,
      },
    });

  it('a memory.clone grant surfaces as manage with PRINCIPAL_GRANT lineage', async () => {
    await grantRow(member.id, ['memory.clone']);
    const res = await call(member.id, `hrn:memory:${graph.urn}`, asAdmin());
    expect(res.canManage).toBe(true);
    expect(res.canDelete).toBe(false);
    const g = res.grants.find((x: any) => x.source === 'PRINCIPAL_GRANT');
    expect(g).toBeTruthy();
    expect(g!.role).toBe('memory.clone');
    expect(g!.via).toBe(org.urn);
    // Capability-shaped source: it must not become the clean role label.
    expect(res.role).toBeNull();
  });

  it('a memory.* wildcard grant confers manage AND delete', async () => {
    await grantRow(member.id, ['memory.*']);
    const res = await call(member.id, `hrn:memory:${graph.urn}`, asAdmin());
    expect(res.canManage).toBe(true);
    expect(res.canDelete).toBe(true);
  });

  it('read/write-only grants are NOT surfaced (no enforced gate consults them)', async () => {
    await grantRow(member.id, ['memory.read', 'memory.write']);
    const res = await call(member.id, `hrn:memory:${graph.urn}`, asAdmin());
    expect(res.grants.some((x: any) => x.source === 'PRINCIPAL_GRANT')).toBe(false);
    expect(res.canWrite).toBe(false);
  });

  it('an expired or revoked grant is absent', async () => {
    await grantRow(member.id, ['memory.clone'], { expiresAt: new Date(Date.now() - 60_000) });
    await grantRow(member.id, ['memory.delete'], { deletedAt: new Date() });
    const res = await call(member.id, `hrn:memory:${graph.urn}`, asAdmin());
    expect(res.grants.some((x: any) => x.source === 'PRINCIPAL_GRANT')).toBe(false);
    expect(res.canManage).toBe(false);
    expect(res.canDelete).toBe(false);
  });

  it('a grant without live membership confers nothing (requireOrgAction parity)', async () => {
    await grantRow(stranger.id, ['memory.clone']);
    const res = await call(stranger.id, `hrn:memory:${graph.urn}`, asAdmin());
    expect(res.grants.some((x: any) => x.source === 'PRINCIPAL_GRANT')).toBe(false);
    expect(res.canManage).toBe(false);
  });

  it('on an app-class memory a clone grant confers nothing, a delete grant confers delete', async () => {
    // cloneMemory categorically rejects app-class sources after its gate, so
    // mapping clone → manage there would over-report; deleteMemory does gate
    // app-class through requireOrgAction, so delete maps.
    const { app } = await createDbAppWithKey(db, 'grantapp', org.id);
    const appMem = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        urn: `${org.urn}:grantappmem`,
        name: 'grantappmem',
        class: 'app',
        appId: app.id,
      },
    });
    await grantRow(member.id, ['memory.clone', 'memory.delete']);
    const res = await call(member.id, `hrn:memory:${appMem.urn}`, asAdmin());
    expect(res.canManage).toBe(false);
    expect(res.canDelete).toBe(true);
    const g = res.grants.find((x: any) => x.source === 'PRINCIPAL_GRANT');
    expect(g).toEqual({ source: 'PRINCIPAL_GRANT', role: 'memory.delete', via: org.urn });
  });

  it('on an ENCRYPTED memory a clone grant confers nothing (cloneMemory rejects encrypted sources)', async () => {
    await db.memory.update({ where: { id: graph.id }, data: { isEncrypted: true } });
    await grantRow(member.id, ['memory.clone', 'memory.delete']);
    const res = await call(member.id, `hrn:memory:${graph.urn}`, asAdmin());
    expect(res.canManage).toBe(false);
    expect(res.canDelete).toBe(true); // deleteMemory has no encryption guard
    const g = res.grants.find((x: any) => x.source === 'PRINCIPAL_GRANT');
    expect(g).toEqual({ source: 'PRINCIPAL_GRANT', role: 'memory.delete', via: org.urn });
  });

  it('a node inherits the grant-derived capabilities as NODE_INHERITED', async () => {
    await grantRow(member.id, ['memory.clone']);
    const node = await createDbNode(db, { loc: 'grantnode', name: 'grantnode', memoryId: graph.id });
    const res = await call(member.id, `hrn:node:${graph.urn}:${node.loc}`, asAdmin());
    expect(res.canManage).toBe(true);
    expect(res.grants.some((g) => g.source === 'NODE_INHERITED' && g.role === 'memory.clone')).toBe(true);
  });
});
