/**
 * Foundational schema validation for spec 008-agent-installation.
 *
 * Verifies that the two-layer Agent + App model is in place after the
 * migration: Agent gains memoryProvisioning + installationPolicy; App gains
 * agentId + trainingMode + surfaces; Memory gains appId; the new
 * AppMember / AgentImport / AgentOrgGrant joins exist; AppAgent is gone;
 * and chk_memory_class_app_id is enforced.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { getPrimaryAgentId } from '../../lib/appAgent.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { generateId } from '../../lib/id.js';

beforeEach(async () => {
  await cleanDb(db);
});

// ---------------------------------------------------------------------------
// New / modified models exist
// ---------------------------------------------------------------------------

describe('008 schema — new entities + dropped AppAgent', () => {
  it('AppMember is creatable on the composite (appId, userId) PK', async () => {
    const org = await db.organization.create({
      data: { id: generateId(), name: 'mv-org', urn: 'mv-org' },
    });
    const user = await db.user.create({ data: { id: generateId(), githubId: 80001 } });
    const agent = await db.agent.create({
      data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:a`, name: 'a' },
    });
    const app = await db.app.create({
      data: {
        id: generateId(),
        name: 'mv-app',
        urn: `${org.urn}:mv-app`,
        organizationId: org.id,
        appAgents: { create: { agentId: agent.id } },
      },
    });

    const member = await db.appMember.create({
      data: { appId: app.id, userId: user.id, role: 'owner' },
    });
    expect(member.appId).toBe(app.id);
    expect(member.userId).toBe(user.id);
    expect(member.role).toBe('owner');
  });

  it('AgentImport is creatable with the AgentOrgGrant FK', async () => {
    const org = await db.organization.create({
      data: { id: generateId(), name: 'imp-org', urn: 'imp-org' },
    });
    const parent = await db.agent.create({
      data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:suite`, name: 'suite' },
    });
    const dep = await db.agent.create({
      data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:dep`, name: 'dep' },
    });
    // Spec FR-005 + R-2: AgentImport.agentOrgGrant is the universal Builder
    // grant. Same-org parent→dep still requires the row to satisfy the FK;
    // production code auto-provisions via ensureAgentOrgGrant.
    await db.agentOrgGrant.create({
      data: { orgId: org.id, agentId: dep.id, activatedAt: new Date() },
    });

    const imp = await db.agentImport.create({
      data: {
        parentAgentId: parent.id,
        importedAgentId: dep.id,
        position: 100,
        required: true,
        agentOrgGrantOrgId: org.id,
        agentOrgGrantAgentId: dep.id,
      },
    });
    expect(imp.parentAgentId).toBe(parent.id);
    expect(imp.importedAgentId).toBe(dep.id);
    expect(imp.position).toBe(100);
    expect(imp.required).toBe(true);
  });

  it('AgentImport rejects two imports at the same (parent, position) — sparse-int uniqueness (R-8)', async () => {
    const org = await db.organization.create({
      data: { id: generateId(), name: 'pos-org', urn: 'pos-org' },
    });
    const parent = await db.agent.create({
      data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:suite`, name: 'suite' },
    });
    const a = await db.agent.create({
      data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:a`, name: 'a' },
    });
    const b = await db.agent.create({
      data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:b`, name: 'b' },
    });
    await db.agentOrgGrant.create({
      data: { orgId: org.id, agentId: a.id, activatedAt: new Date() },
    });
    await db.agentOrgGrant.create({
      data: { orgId: org.id, agentId: b.id, activatedAt: new Date() },
    });
    await db.agentImport.create({
      data: {
        parentAgentId: parent.id,
        importedAgentId: a.id,
        position: 100,
        agentOrgGrantOrgId: org.id,
        agentOrgGrantAgentId: a.id,
      },
    });
    await expect(
      db.agentImport.create({
        data: {
          parentAgentId: parent.id,
          importedAgentId: b.id,
          position: 100, // collision
          agentOrgGrantOrgId: org.id,
          agentOrgGrantAgentId: b.id,
        },
      }),
    ).rejects.toThrow();
  });

  it('AgentOrgGrant is creatable with the composite (orgId, agentId) PK', async () => {
    const org = await db.organization.create({
      data: { id: generateId(), name: 'gr-org', urn: 'gr-org' },
    });
    const agent = await db.agent.create({
      data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:a`, name: 'a' },
    });
    const grant = await db.agentOrgGrant.create({
      data: { orgId: org.id, agentId: agent.id, activatedAt: new Date() },
    });
    expect(grant.orgId).toBe(org.id);
    expect(grant.agentId).toBe(agent.id);
    expect(grant.activatedAt).not.toBeNull();
    expect(grant.revokedAt).toBeNull();
  });

  // Removed: "AppAgent is removed from the Prisma client" — spec 023
  // reintroduced AppAgent as the N:M App↔Agent join. The removal this test
  // documented has been intentionally reversed.
});

// ---------------------------------------------------------------------------
// Modified entities: new fields with defaults
// ---------------------------------------------------------------------------

describe('008 schema — Agent declarative fields', () => {
  it('Agent.memoryProvisioning defaults to { appMemory: shared }', async () => {
    const org = await db.organization.create({
      data: { id: generateId(), name: 'ag-org', urn: 'ag-org' },
    });
    const agent = await db.agent.create({
      data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:a`, name: 'a' },
    });
    expect(agent.memoryProvisioning).toEqual({ appMemory: 'shared' });
  });

  it('Agent.installationPolicy defaults to maxMembers=unlimited / memberRoles=[owner]', async () => {
    const org = await db.organization.create({
      data: { id: generateId(), name: 'ag-org-2', urn: 'ag-org-2' },
    });
    const agent = await db.agent.create({
      data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:a`, name: 'a' },
    });
    expect(agent.installationPolicy).toEqual({
      maxMembers: 'unlimited',
      memberRoles: ['owner'],
    });
  });
});

describe('008 schema — App fields', () => {
  it('App.agentId is nullable; defaults to false/[chat] for trainingMode/surfaces', async () => {
    const org = await db.organization.create({
      data: { id: generateId(), name: 'ap-org', urn: 'ap-org' },
    });
    const app = await db.app.create({
      data: {
        id: generateId(),
        name: 'orphan-app',
        urn: `${org.urn}:orphan`,
        organizationId: org.id,
      },
    });
    expect((await getPrimaryAgentId(db, app.id))).toBeNull();
    expect(app.trainingMode).toBe(false);
    expect(app.surfaces).toEqual(['chat']);
  });

  it('App.agentId becomes NULL when the linked Agent is deleted (SET NULL cascade)', async () => {
    const org = await db.organization.create({
      data: { id: generateId(), name: 'cas-org', urn: 'cas-org' },
    });
    const agent = await db.agent.create({
      data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:a`, name: 'a' },
    });
    const app = await db.app.create({
      data: {
        id: generateId(),
        name: 'cas-app',
        urn: `${org.urn}:cas-app`,
        organizationId: org.id,
        appAgents: { create: { agentId: agent.id } },
      },
    });
    await db.agent.delete({ where: { id: agent.id } });
    // 023-app-shape Phase 2b: Agent deletion cascades to AppAgent rows
    // (the previous behavior was "App.agentId set to null on SET NULL");
    // either way, the App is left with no primary Agent.
    expect(await getPrimaryAgentId(db, app.id)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// chk_memory_class_app_id constraint
// ---------------------------------------------------------------------------

describe('008 schema — chk_memory_class_app_id', () => {
  it('rejects class=app with app_id=NULL', async () => {
    const org = await db.organization.create({
      data: { id: generateId(), name: 'chk-org-1', urn: 'chk-org-1' },
    });
    await expect(
      db.memory.create({
        data: {
          id: generateId(),
          organizationId: org.id,
          urn: `${org.urn}:bad-app`,
          name: 'bad-app',
          class: 'app',
        },
      }),
    ).rejects.toThrow();
  });

  // 034-memory-class-access: app_id is now OPTIONAL for personal/private — a
  // free-standing (user-owned, app-less) personal memory is valid.
  it('accepts class=personal with app_id=NULL (free-standing, owner set)', async () => {
    const org = await db.organization.create({
      data: { id: generateId(), name: 'chk-org-2', urn: 'chk-org-2' },
    });
    const user = await db.user.create({ data: { id: generateId(), githubId: 80042 } });
    const mem = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        urn: `${org.urn}:free-standing-personal`,
        name: 'free-standing-personal',
        class: 'personal',
        visibility: null,
        userId: user.id,
      },
    });
    expect(mem.appId).toBeNull();
    expect(mem.userId).toBe(user.id);
  });

  // #653: knowledge + group memories may now be attached to an App (app_id set).
  it('accepts class=knowledge and class=group with a non-NULL app_id (#653)', async () => {
    const org = await db.organization.create({
      data: { id: generateId(), name: 'chk-org-3', urn: 'chk-org-3' },
    });
    const agent = await db.agent.create({
      data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:a`, name: 'a' },
    });
    const app = await db.app.create({
      data: {
        id: generateId(),
        name: 'chk-app',
        urn: `${org.urn}:chk-app`,
        organizationId: org.id,
        appAgents: { create: { agentId: agent.id } },
      },
    });
    const knowledge = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        urn: `${org.urn}:app-knowledge`,
        name: 'app-knowledge',
        class: 'knowledge',
        visibility: 'ORGANIZATION',
        appId: app.id,
      },
    });
    expect(knowledge.appId).toBe(app.id);
    const group = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        urn: `${org.urn}:app-group`,
        name: 'app-group',
        class: 'group',
        visibility: 'GROUP',
        appId: app.id,
      },
    });
    expect(group.appId).toBe(app.id);
  });

  // #653 boundary: class='system' stays app_id-forbidden (an agent's own
  // definition is never app-scoped).
  it('rejects class=system with a non-NULL app_id', async () => {
    const org = await db.organization.create({
      data: { id: generateId(), name: 'chk-org-3b', urn: 'chk-org-3b' },
    });
    const agent = await db.agent.create({
      data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:a`, name: 'a' },
    });
    const app = await db.app.create({
      data: {
        id: generateId(),
        name: 'chk-app-sys',
        urn: `${org.urn}:chk-app-sys`,
        organizationId: org.id,
        appAgents: { create: { agentId: agent.id } },
      },
    });
    await expect(
      db.memory.create({
        data: {
          id: generateId(),
          organizationId: org.id,
          urn: `${org.urn}:wrong-system`,
          name: 'wrong',
          class: 'system',
          appId: app.id,
        },
      }),
    ).rejects.toThrow();
  });

  it('accepts class=app with app_id set', async () => {
    const org = await db.organization.create({
      data: { id: generateId(), name: 'chk-org-4', urn: 'chk-org-4' },
    });
    const agent = await db.agent.create({
      data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:a`, name: 'a' },
    });
    const app = await db.app.create({
      data: {
        id: generateId(),
        name: 'chk-app-ok',
        urn: `${org.urn}:chk-app-ok`,
        organizationId: org.id,
        appAgents: { create: { agentId: agent.id } },
      },
    });
    const mem = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        urn: `${org.urn}:ok-app`,
        name: 'ok-app',
        class: 'app',
        appId: app.id,
      },
    });
    expect(mem.class).toBe('app');
    expect(mem.appId).toBe(app.id);
  });

  it('hard App deletion cascades to its app/personal-class memories', async () => {
    const org = await db.organization.create({
      data: { id: generateId(), name: 'cas-org-2', urn: 'cas-org-2' },
    });
    const agent = await db.agent.create({
      data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:a`, name: 'a' },
    });
    const app = await db.app.create({
      data: {
        id: generateId(),
        name: 'cas-app-2',
        urn: `${org.urn}:cas-app-2`,
        organizationId: org.id,
        appAgents: { create: { agentId: agent.id } },
      },
    });
    const mem = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        urn: `${org.urn}:cas-mem`,
        name: 'cas-mem',
        class: 'app',
        appId: app.id,
      },
    });
    await db.app.delete({ where: { id: app.id } });
    const after = await db.memory.findUnique({ where: { id: mem.id } });
    expect(after).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// spec 047 Phase 2c — org-XOR-owner CHECK (exactly one owner)
// ---------------------------------------------------------------------------

describe('047 schema — chk_<entity>_owner_xor', () => {
  it('accepts an org-owned App (org set, owner NULL) — the existing shape', async () => {
    const org = await db.organization.create({
      data: { id: generateId(), name: 'xor-org-1', urn: 'xor-org-1' },
    });
    const app = await db.app.create({
      data: { id: generateId(), name: 'org-app', urn: `${org.urn}:org-app`, organizationId: org.id },
    });
    expect(app.ownerUserId).toBeNull();
  });

  it('accepts a user-owned App (owner set, org NULL)', async () => {
    const user = await db.user.create({ data: { githubId: 88010 } });
    const app = await db.app.create({
      data: { id: generateId(), name: 'user-app', urn: `@u:user-app`, ownerUserId: user.id },
    });
    expect(app.organizationId).toBeNull();
    expect(app.ownerUserId).toBe(user.id);
  });

  it('rejects an App with BOTH an org and a user owner', async () => {
    const org = await db.organization.create({
      data: { id: generateId(), name: 'xor-org-2', urn: 'xor-org-2' },
    });
    const user = await db.user.create({ data: { githubId: 88011 } });
    await expect(
      db.app.create({
        data: {
          id: generateId(),
          name: 'both',
          urn: `${org.urn}:both`,
          organizationId: org.id,
          ownerUserId: user.id,
        },
      }),
    ).rejects.toThrow();
  });

  it('rejects an App with NEITHER an org nor a user owner', async () => {
    await expect(
      db.app.create({ data: { id: generateId(), name: 'orphan', urn: `@x:orphan` } }),
    ).rejects.toThrow();
  });

  it('rejects a Memory with both org and user owner (chk_memory_owner_xor)', async () => {
    const org = await db.organization.create({
      data: { id: generateId(), name: 'xor-org-3', urn: 'xor-org-3' },
    });
    const user = await db.user.create({ data: { githubId: 88012 } });
    await expect(
      db.memory.create({
        data: {
          id: generateId(),
          organizationId: org.id,
          ownerUserId: user.id,
          urn: `${org.urn}:xor-mem`,
          name: 'xor-mem',
          class: 'knowledge',
          visibility: 'ORGANIZATION',
        },
      }),
    ).rejects.toThrow();
  });
});
