/**
 * createMemoryInApp / attachMemoryToApp — add a memory to an App.
 *
 * Covers the three App-associable classes (app / personal / private), the
 * create + attach paths, and the split auth model (app-class = org OWNER/ADMIN;
 * personal/private = App membership, caller owns).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import {
  cleanDb,
  createDbAppWithKey,
  createDbAppAgent,
  createDbAppMember,
} from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { generateId } from '../../../lib/id.js';
import { getOrgReadableMemoryIds } from '../../../lib/auth/orgReadableMemory.js';
import { getAppMemoryAccess } from '../../../mcp/access-control.js';
import { requireMemoryWriteAccess, getAccessibleMemoryIds } from './resolvers.helpers.js';

// Prevent git writes (createMemoryInApp creates a root node).
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

const createMemoryInApp = resolvers.Mutation.createMemoryInApp as (
  _: unknown,
  args: Record<string, unknown>,
  ctx: Context,
) => Promise<any>;
const attachMemoryToApp = resolvers.Mutation.attachMemoryToApp as (
  _: unknown,
  args: Record<string, unknown>,
  ctx: Context,
) => Promise<any>;

let org: { id: string; urn: string };
let agent: { id: string; urn: string };
let app: { id: string; urn: string };
let adminUser: { id: string }; // org ADMIN + App member
let memberUser: { id: string }; // App member only (NOT org admin)
let outsiderUser: { id: string }; // org ADMIN but NOT an App member

/** Context for a specific user with no platform roles (so requireOrgRole checks real org membership). */
const asUser = (userId: string): Context => ({ db, userId, roles: [] });

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'org-a', urn: 'org-a' } });
  agent = await db.agent.create({
    data: { id: generateId(), name: 'coach', urn: `${org.urn}:coach`, organizationId: org.id },
  });
  const seeded = await createDbAppWithKey(db, 'coach-app', org.id);
  app = { id: seeded.app.id, urn: seeded.app.urn };
  await createDbAppAgent(db, app.id, agent.id);

  adminUser = await db.user.create({ data: { githubId: 1, githubUsername: 'admin' } });
  memberUser = await db.user.create({ data: { githubId: 2, githubUsername: 'member' } });
  outsiderUser = await db.user.create({ data: { githubId: 3, githubUsername: 'outsider' } });

  await db.orgMember.create({ data: { organizationId: org.id, userId: adminUser.id, role: 'ADMIN' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: outsiderUser.id, role: 'ADMIN' } });
  // adminUser + memberUser are App members; outsiderUser is NOT.
  await createDbAppMember(db, app.id, adminUser.id, 'owner');
  await createDbAppMember(db, app.id, memberUser.id, 'eater');
});

const code = (e: unknown) => (e as { extensions?: { code?: string } })?.extensions?.code;

describe('createMemoryInApp', () => {
  it('creates an app-class memory for an org ADMIN', async () => {
    const mem = await createMemoryInApp(
      null,
      { appRef: app.id, agentRef: agent.id, memoryClass: 'app', name: 'Shared runbook' },
      asUser(adminUser.id),
    );
    expect(mem.class).toBe('app');
    expect(mem.appId).toBe(app.id);
    expect(mem.userId).toBeNull();
    expect(mem.userMemoryOfAgentId).toBeNull();
    expect(mem.visibility).toBeNull();
    expect(mem.urn).toBe(`${app.urn}:coach:app-mem:shared-runbook`);
    // Root node exists.
    expect(await db.node.count({ where: { memoryId: mem.id } })).toBe(1);
  });

  it('creates a personal memory for a plain App member (not org admin)', async () => {
    const mem = await createMemoryInApp(
      null,
      { appRef: app.id, agentRef: agent.id, memoryClass: 'personal', name: 'My notes' },
      asUser(memberUser.id),
    );
    expect(mem.class).toBe('personal');
    expect(mem.appId).toBe(app.id);
    expect(mem.userId).toBe(memberUser.id);
    expect(mem.userMemoryOfAgentId).toBe(agent.id);
    expect(mem.visibility).toBeNull();
    // Per-owner opaque URN (not name-derived) so two members can name their own
    // memories the same without colliding / leaking names.
    expect(mem.urn).toMatch(/^org-a:coach:app-user:/);
  });

  it('creates a private memory for an App member', async () => {
    const mem = await createMemoryInApp(
      null,
      { appRef: app.id, agentRef: agent.id, memoryClass: 'private', name: 'Secret' },
      asUser(memberUser.id),
    );
    expect(mem.class).toBe('private');
    expect(mem.appId).toBe(app.id);
    expect(mem.userId).toBe(memberUser.id);
    expect(mem.userMemoryOfAgentId).toBe(agent.id);
  });

  // #653: app-scoped knowledge — shared reference content for the App.
  it('creates an app-scoped knowledge memory for an org ADMIN, linked to the agent', async () => {
    const mem = await createMemoryInApp(
      null,
      { appRef: app.id, agentRef: agent.id, memoryClass: 'knowledge', name: 'App docs' },
      asUser(adminUser.id),
    );
    expect(mem.class).toBe('knowledge');
    expect(mem.appId).toBe(app.id);
    expect(mem.userId).toBeNull();
    expect(mem.userMemoryOfAgentId).toBeNull();
    expect(mem.visibility).toBe('ORGANIZATION');
    expect(mem.urn).toBe(`${app.urn}:coach:app-mem:app-docs`);
    // Linked to the App's agent so it is readable via the App surface.
    const link = await db.agentMemoryItem.findUnique({
      where: { agentId_memoryId: { agentId: agent.id, memoryId: mem.id } },
    });
    expect(link?.role).toBe('read');
  });

  it('rejects app-scoped knowledge create by a non-admin App member', async () => {
    await expect(
      createMemoryInApp(
        null,
        { appRef: app.id, agentRef: agent.id, memoryClass: 'knowledge', name: 'docs' },
        asUser(memberUser.id), // App member, but not an org ADMIN
      ),
    ).rejects.toThrow(/Forbidden/);
  });

  it('rejects app-class create by a non-admin org member', async () => {
    // Downgrade adminUser's org role to READER for this check via a fresh reader.
    const reader = await db.user.create({ data: { githubId: 9, githubUsername: 'reader' } });
    await db.orgMember.create({ data: { organizationId: org.id, userId: reader.id, role: 'READER' } });
    await createDbAppMember(db, app.id, reader.id, 'eater');
    await expect(
      createMemoryInApp(
        null,
        { appRef: app.id, agentRef: agent.id, memoryClass: 'app', name: 'x' },
        asUser(reader.id),
      ),
    ).rejects.toThrow(/Forbidden/);
  });

  it('rejects personal create by a non-App-member (even an org admin)', async () => {
    await expect(
      createMemoryInApp(
        null,
        { appRef: app.id, agentRef: agent.id, memoryClass: 'personal', name: 'x' },
        asUser(outsiderUser.id),
      ).catch((e) => {
        throw new Error(code(e));
      }),
    ).rejects.toThrow('FORBIDDEN');
  });

  it('rejects an unsupported class', async () => {
    await expect(
      // 'group' is not yet wired through this path (#653 deferred it pending its
      // App-vs-group-membership semantics); 'system' is never App-scopable.
      createMemoryInApp(
        null,
        { appRef: app.id, agentRef: agent.id, memoryClass: 'group', name: 'x' },
        asUser(adminUser.id),
      ).catch((e) => {
        throw new Error(code(e));
      }),
    ).rejects.toThrow('UNSUPPORTED_MEMORY_CLASS');
  });

  it('rejects when the agent is not installed in the app', async () => {
    const other = await db.agent.create({
      data: { id: generateId(), name: 'other', urn: `${org.urn}:other`, organizationId: org.id },
    });
    await expect(
      createMemoryInApp(
        null,
        { appRef: app.id, agentRef: other.id, memoryClass: 'app', name: 'x' },
        asUser(adminUser.id),
      ).catch((e) => {
        throw new Error(code(e));
      }),
    ).rejects.toThrow('AGENT_NOT_INSTALLED');
  });

  it('rejects an uninstalled app', async () => {
    await db.app.update({ where: { id: app.id }, data: { uninstalledAt: new Date() } });
    await expect(
      createMemoryInApp(
        null,
        { appRef: app.id, agentRef: agent.id, memoryClass: 'app', name: 'x' },
        asUser(adminUser.id),
      ).catch((e) => {
        throw new Error(code(e));
      }),
    ).rejects.toThrow('APP_UNINSTALLED');
  });

  it('rejects a duplicate URN as MEMORY_URN_CONFLICT', async () => {
    const args = { appRef: app.id, agentRef: agent.id, memoryClass: 'app', name: 'Dup' };
    await createMemoryInApp(null, args, asUser(adminUser.id));
    await expect(
      createMemoryInApp(null, { ...args }, asUser(adminUser.id)).catch((e) => {
        throw new Error(code(e));
      }),
    ).rejects.toThrow('MEMORY_URN_CONFLICT');
  });

  it('rejects a personal create with no authenticated user', async () => {
    await expect(
      createMemoryInApp(
        null,
        { appRef: app.id, agentRef: agent.id, memoryClass: 'personal', name: 'x' },
        { db, appId: app.id } as Context,
      ).catch((e) => {
        throw new Error(code(e));
      }),
    ).rejects.toThrow('UNAUTHENTICATED');
  });
});

describe('#653 — app-scoped knowledge is App-internal (no org-wide leak)', () => {
  let knowledgeId: string;
  let orgContributor: { id: string }; // org CONTRIBUTOR, NOT an App member

  beforeEach(async () => {
    const mem = await createMemoryInApp(
      null,
      { appRef: app.id, agentRef: agent.id, memoryClass: 'knowledge', name: 'App docs' },
      asUser(adminUser.id),
    );
    knowledgeId = mem.id;
    orgContributor = await db.user.create({ data: { githubId: 7, githubUsername: 'contrib' } });
    await db.orgMember.create({
      data: { organizationId: org.id, userId: orgContributor.id, role: 'CONTRIBUTOR' },
    });
  });

  it('is NOT org-wide readable (getOrgReadableMemoryIds excludes it)', async () => {
    const ids = await getOrgReadableMemoryIds(db, orgContributor.id);
    expect(ids).not.toContain(knowledgeId);
  });

  it("is NOT in a non-App org member's accessible set (portal node gate)", async () => {
    const ids = await getAccessibleMemoryIds(asUser(orgContributor.id));
    expect(ids ?? []).not.toContain(knowledgeId);
  });

  it('IS readable via the App surface (getAppMemoryAccess → READ_ONLY)', async () => {
    const access = await getAppMemoryAccess(db, app.id);
    expect(access.get(knowledgeId)).toBe('READ_ONLY');
  });

  it('is NOT writable by a JWT org CONTRIBUTOR (requireMemoryWriteAccess)', async () => {
    await expect(
      requireMemoryWriteAccess(asUser(orgContributor.id), knowledgeId),
    ).rejects.toThrow(/Forbidden/);
  });

  it('DOES stay writable by an org ADMIN (management bypass)', async () => {
    await expect(
      requireMemoryWriteAccess({ db, userId: adminUser.id, roles: ['ADMIN'] } as Context, knowledgeId),
    ).resolves.toBeUndefined();
  });
});

describe('attachMemoryToApp', () => {
  /** A free-standing personal memory owned by `userId` (app_id NULL, agent NULL). */
  async function freeStandingPersonal(userId: string, orgId = org.id, urnSlug = 'my-notes') {
    return db.memory.create({
      data: {
        id: generateId(),
        organizationId: orgId,
        urn: `${orgId === org.id ? org.urn : orgId}:${urnSlug}`,
        name: urnSlug,
        class: 'personal',
        userId,
        visibility: null,
      },
    });
  }

  it('attaches a free-standing personal memory owned by an App member', async () => {
    const mem = await freeStandingPersonal(memberUser.id);
    const out = await attachMemoryToApp(
      null,
      { memoryRef: mem.id, appRef: app.id, agentRef: agent.id },
      asUser(memberUser.id),
    );
    expect(out.appId).toBe(app.id);
    expect(out.userMemoryOfAgentId).toBe(agent.id);
    expect(out.userId).toBe(memberUser.id);
    expect(out.class).toBe('personal');
    expect(out.urn).toBe(mem.urn); // URN unchanged — no node re-addressing.
  });

  it('rejects a memory already scoped to an App', async () => {
    const mem = await createMemoryInApp(
      null,
      { appRef: app.id, agentRef: agent.id, memoryClass: 'personal', name: 'Already' },
      asUser(memberUser.id),
    );
    await expect(
      attachMemoryToApp(
        null,
        { memoryRef: mem.id, appRef: app.id, agentRef: agent.id },
        asUser(memberUser.id),
      ).catch((e) => {
        throw new Error(code(e));
      }),
    ).rejects.toThrow('MEMORY_ALREADY_APP_SCOPED');
  });

  it('does not leak another user\'s app-scoped state to a non-owner (FORBIDDEN, not MEMORY_ALREADY_APP_SCOPED)', async () => {
    const theirs = await createMemoryInApp(
      null,
      { appRef: app.id, agentRef: agent.id, memoryClass: 'private', name: 'Theirs' },
      asUser(memberUser.id),
    );
    // adminUser is an App member but not the owner — must get the same FORBIDDEN
    // as for any non-owned memory, never a state-revealing error.
    await expect(
      attachMemoryToApp(
        null,
        { memoryRef: theirs.id, appRef: app.id, agentRef: agent.id },
        asUser(adminUser.id),
      ).catch((e) => {
        throw new Error(code(e));
      }),
    ).rejects.toThrow('FORBIDDEN');
  });

  it('rejects attaching a memory the caller does not own', async () => {
    const mem = await freeStandingPersonal(memberUser.id);
    // adminUser is an App member but not the owner.
    await expect(
      attachMemoryToApp(
        null,
        { memoryRef: mem.id, appRef: app.id, agentRef: agent.id },
        asUser(adminUser.id),
      ).catch((e) => {
        throw new Error(code(e));
      }),
    ).rejects.toThrow('FORBIDDEN');
  });

  it('returns a uniform FORBIDDEN for a non-owned memory regardless of class (no class/appId enumeration leak)', async () => {
    // A knowledge memory has no owner, so ownership-first rejects it as FORBIDDEN
    // BEFORE revealing its class/app-scoped state — the same error a non-owner
    // gets for anyone else's private memory.
    const knowledge = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        urn: `${org.urn}:kb`,
        name: 'kb',
        class: 'knowledge',
        visibility: 'ORGANIZATION',
      },
    });
    await expect(
      attachMemoryToApp(
        null,
        { memoryRef: knowledge.id, appRef: app.id, agentRef: agent.id },
        asUser(adminUser.id),
      ).catch((e) => {
        throw new Error(code(e));
      }),
    ).rejects.toThrow('FORBIDDEN');
  });

  it('rejects a memory from a different organization', async () => {
    const org2 = await db.organization.create({ data: { id: generateId(), name: 'org-b', urn: 'org-b' } });
    const mem = await freeStandingPersonal(memberUser.id, org2.id, 'cross-org');
    await expect(
      attachMemoryToApp(
        null,
        { memoryRef: mem.id, appRef: app.id, agentRef: agent.id },
        asUser(memberUser.id),
      ).catch((e) => {
        throw new Error(code(e));
      }),
    ).rejects.toThrow('ORGANIZATION_MISMATCH');
  });
});
