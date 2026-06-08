/**
 * 008-agent-installation — User Story 2 acceptance test (T054 / SC-003).
 *
 * The Mike-multi-install scenario — the load-bearing privacy invariant:
 *   - Agent "Juno" is owned by MentorCo.
 *   - App A in MentorCo deploys Juno (same-org install).
 *   - App B in CompanyX deploys Juno (cross-org install — needs grant).
 *   - Mike is an AppMember of both Apps.
 *
 * Verifies:
 *   (a) Mike's chat through App A creates a personal Memory at (A.id, mike.id).
 *   (b) Mike's chat through App B creates a separate personal Memory at
 *       (B.id, mike.id).
 *   (c) Reads from App-A session never return App-B's data and vice versa
 *       across all access-control read paths.
 *   (d) Knowledge memory attached to Juno is visible to both sessions
 *       (per-Agent, not per-App).
 *
 * Per spec.md User Story 2 + FR-011 + FR-015 + SC-003.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../integrations/db/client.js';
import {
  cleanDb,
  createDbAgentOrgGrant,
  createDbAgentSubscription,
  createDbAppMember,
} from '../helpers.js';
import { generateId } from '../../lib/id.js';
import {
  canReadMemory,
  canWriteToMemory,
  getAppMemoryAccess,
  getAccessibleMemoryIds,
} from '../../mcp/access-control.js';
import type { AuthContext } from '../../middleware/auth.js';

// ─────────────────────────────────────────────────────────────────────────
// Fixture: the four-org Juno scenario
// ─────────────────────────────────────────────────────────────────────────

interface MultiInstallFixture {
  mentorOrg: { id: string; urn: string };
  companyXOrg: { id: string; urn: string };
  juno: { id: string; urn: string; systemMemoryId: string };
  appA: { id: string; urn: string };
  appB: { id: string; urn: string };
  mike: { id: string };
  dana: { id: string };
  knowledgeMemory: { id: string };
  mikePersonalAtA: {
    id: string;
    appId: string | null;
    userId: string | null;
    userMemoryOfAgentId: string | null;
  };
  mikePersonalAtB: {
    id: string;
    appId: string | null;
    userId: string | null;
    userMemoryOfAgentId: string | null;
  };
}

async function buildFixture(): Promise<MultiInstallFixture> {
  await cleanDb(db);

  const mentorOrg = await db.organization.create({
    data: { id: generateId(), name: 'MentorCo', urn: 'mentor-co' },
  });
  const companyXOrg = await db.organization.create({
    data: { id: generateId(), name: 'CompanyX', urn: 'company-x' },
  });

  // Mike — the multi-install user — is a member of both orgs.
  const mike = await db.user.create({
    data: { id: generateId(), handle: 'mike', githubId: 60001 },
  });
  // Dana — a CompanyX-only user, used for cross-user denial check.
  const dana = await db.user.create({
    data: { id: generateId(), handle: 'dana', githubId: 60002 },
  });
  await db.orgMember.createMany({
    data: [
      { id: generateId(), organizationId: mentorOrg.id, userId: mike.id, role: 'OWNER' },
      { id: generateId(), organizationId: companyXOrg.id, userId: mike.id, role: 'OWNER' },
      { id: generateId(), organizationId: companyXOrg.id, userId: dana.id, role: 'CONTRIBUTOR' },
    ],
  });

  // Juno's system memory + a knowledge memory both Apps will see.
  const sysMem = await db.memory.create({
    data: {
      id: generateId(),
      organizationId: mentorOrg.id,
      urn: `${mentorOrg.urn}:juno-sys`,
      name: 'juno-sys',
      class: 'system',
    },
  });
  const knowledge = await db.memory.create({
    data: {
      id: generateId(),
      organizationId: mentorOrg.id,
      urn: `${mentorOrg.urn}:juno-knowledge`,
      name: 'juno-knowledge',
      class: 'knowledge',
      visibility: 'PUBLIC',
    },
  });

  // Juno itself: visibility=PUBLIC so CompanyX can install it cross-org.
  const juno = await db.agent.create({
    data: {
      id: generateId(),
      organizationId: mentorOrg.id,
      urn: `${mentorOrg.urn}:juno`,
      name: 'Juno',
      visibility: 'PUBLIC',
      systemMemoryId: sysMem.id,
      // appMemory='user' is Juno's spec-008 case; not load-bearing for the
      // personal-memory isolation test, but matches the narrative.
      memoryProvisioning: { appMemory: 'user' },
      installationPolicy: { maxMembers: 2, memberRoles: ['principal', 'guide'] },
    },
  });
  await db.agentMemoryItem.create({
    data: {
      id: generateId(),
      agentId: juno.id,
      memoryId: knowledge.id,
      role: 'read',
    },
  });

  // App A at MentorCo (same-org). App B at CompanyX (cross-org → grant).
  const appA = await db.app.create({
    data: {
      id: generateId(),
      organizationId: mentorOrg.id,
      urn: `${mentorOrg.urn}:juno-app`,
      name: 'Juno @ MentorCo',
      appAgents: { create: { agentId: juno.id } },
    },
  });
  const appB = await db.app.create({
    data: {
      id: generateId(),
      organizationId: companyXOrg.id,
      urn: `${companyXOrg.urn}:juno-app`,
      name: 'Juno @ CompanyX',
      appAgents: { create: { agentId: juno.id } },
    },
  });
  // Cross-org grant for App B (gate 1 in access-control).
  await createDbAgentOrgGrant(db, companyXOrg.id, juno.id);
  // Same-org grant for App A — auto-passes gate 1, but we seed it for
  // symmetry with the createApp resolver behavior.
  await createDbAgentOrgGrant(db, mentorOrg.id, juno.id);

  // Memberships: Mike in both Apps; Dana only in App B.
  await createDbAppMember(db, appA.id, mike.id, 'principal');
  await createDbAppMember(db, appB.id, mike.id, 'principal');
  await createDbAppMember(db, appB.id, dana.id, 'guide');

  // AgentSubscription for Mike↔Juno (the personal-memory grant).
  await createDbAgentSubscription(db, mike.id, juno.id);

  // Pre-seed Mike's personal memories at each install. (Step (a)+(b) of the
  // user-story acceptance — in production, these are lazy-created on first
  // user-attributed write through startAgentSession; we seed them here to
  // exercise the access-control path directly.)
  const mikePersonalAtA = await db.memory.create({
    data: {
      id: generateId(),
      organizationId: mentorOrg.id,
      urn: `${appA.urn}:mike-personal`,
      name: 'Mike personal @ MentorCo',
      class: 'personal',
      visibility: null,
      userId: mike.id,
      userMemoryOfAgentId: juno.id,
      appId: appA.id,
    },
  });
  const mikePersonalAtB = await db.memory.create({
    data: {
      id: generateId(),
      organizationId: companyXOrg.id,
      urn: `${appB.urn}:mike-personal`,
      name: 'Mike personal @ CompanyX',
      class: 'personal',
      visibility: null,
      userId: mike.id,
      userMemoryOfAgentId: juno.id,
      appId: appB.id,
    },
  });

  return {
    mentorOrg: { id: mentorOrg.id, urn: mentorOrg.urn },
    companyXOrg: { id: companyXOrg.id, urn: companyXOrg.urn },
    juno: { id: juno.id, urn: juno.urn, systemMemoryId: sysMem.id },
    appA: { id: appA.id, urn: appA.urn },
    appB: { id: appB.id, urn: appB.urn },
    mike,
    dana,
    knowledgeMemory: { id: knowledge.id },
    mikePersonalAtA,
    mikePersonalAtB,
  };
}

let f: MultiInstallFixture;

beforeEach(async () => {
  f = await buildFixture();
});

// ─────────────────────────────────────────────────────────────────────────
// (a)+(b): Mike has distinct personal memories per install
// ─────────────────────────────────────────────────────────────────────────

describe('T054 (a)+(b): Mike\'s personal memories pivot on (app_id, mike.id)', () => {
  it('two distinct Memory rows exist with distinct app_ids', async () => {
    expect(f.mikePersonalAtA.id).not.toBe(f.mikePersonalAtB.id);
    expect(f.mikePersonalAtA.appId).toBe(f.appA.id);
    expect(f.mikePersonalAtB.appId).toBe(f.appB.id);
    expect(f.mikePersonalAtA.userId).toBe(f.mike.id);
    expect(f.mikePersonalAtB.userId).toBe(f.mike.id);
    // Both reference the same Agent — the spec invariant.
    expect(f.mikePersonalAtA.userMemoryOfAgentId).toBe(f.juno.id);
    expect(f.mikePersonalAtB.userMemoryOfAgentId).toBe(f.juno.id);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// (c): App-A session can NEVER read App-B's personal memory and vice versa
// ─────────────────────────────────────────────────────────────────────────

describe('T054 (c): cross-App reads of Mike\'s personal memory are denied (SC-003)', () => {
  function ctxFor(app: 'A' | 'B', user: 'mike' | 'dana'): AuthContext {
    return {
      appId: app === 'A' ? f.appA.id : f.appB.id,
      userId: user === 'mike' ? f.mike.id : f.dana.id,
      organizationId: app === 'A' ? f.mentorOrg.id : f.companyXOrg.id,
    };
  }

  it('Mike\'s session through App A can read his memory at App A', async () => {
    expect(await canReadMemory(db, ctxFor('A', 'mike'), f.mikePersonalAtA.id)).toBe(true);
    expect(await canWriteToMemory(db, ctxFor('A', 'mike'), f.mikePersonalAtA.id)).toBe(true);
  });

  it('Mike\'s session through App A is DENIED reading his memory at App B', async () => {
    expect(await canReadMemory(db, ctxFor('A', 'mike'), f.mikePersonalAtB.id)).toBe(false);
    expect(await canWriteToMemory(db, ctxFor('A', 'mike'), f.mikePersonalAtB.id)).toBe(false);
  });

  it('Mike\'s session through App B is DENIED reading his memory at App A', async () => {
    expect(await canReadMemory(db, ctxFor('B', 'mike'), f.mikePersonalAtA.id)).toBe(false);
    expect(await canWriteToMemory(db, ctxFor('B', 'mike'), f.mikePersonalAtA.id)).toBe(false);
  });

  it('Mike\'s session through App B can read his memory at App B', async () => {
    expect(await canReadMemory(db, ctxFor('B', 'mike'), f.mikePersonalAtB.id)).toBe(true);
    expect(await canWriteToMemory(db, ctxFor('B', 'mike'), f.mikePersonalAtB.id)).toBe(true);
  });

  it('Dana (a different user in App B) cannot read Mike\'s memory through App B (FR-016)', async () => {
    expect(await canReadMemory(db, ctxFor('B', 'dana'), f.mikePersonalAtB.id)).toBe(false);
    expect(await canWriteToMemory(db, ctxFor('B', 'dana'), f.mikePersonalAtB.id)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// (d): Knowledge memory attached to the Agent is visible to both sessions
// ─────────────────────────────────────────────────────────────────────────

describe('T054 (d): knowledge memory is per-Agent, not per-App — visible to both installs', () => {
  it('App A and App B both see Juno\'s knowledge memory in their access map', async () => {
    const accessAtA = await getAppMemoryAccess(db, f.appA.id);
    const accessAtB = await getAppMemoryAccess(db, f.appB.id);
    expect(accessAtA.has(f.knowledgeMemory.id)).toBe(true);
    expect(accessAtB.has(f.knowledgeMemory.id)).toBe(true);
    // System memory is visible to both (READ_ONLY post-008).
    expect(accessAtA.get(f.juno.systemMemoryId)).toBe('READ_ONLY');
    expect(accessAtB.get(f.juno.systemMemoryId)).toBe('READ_ONLY');
  });

  it('getAccessibleMemoryIds returns the same per-Agent ids for both Apps', async () => {
    const idsAtA = await getAccessibleMemoryIds(db, {
      appId: f.appA.id,
      organizationId: f.mentorOrg.id,
    } as AuthContext);
    const idsAtB = await getAccessibleMemoryIds(db, {
      appId: f.appB.id,
      organizationId: f.companyXOrg.id,
    } as AuthContext);
    expect(idsAtA).not.toBeNull();
    expect(idsAtB).not.toBeNull();
    expect(new Set(idsAtA)).toEqual(new Set([f.juno.systemMemoryId, f.knowledgeMemory.id]));
    expect(new Set(idsAtB)).toEqual(new Set([f.juno.systemMemoryId, f.knowledgeMemory.id]));
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Cross-org gate symmetry: revoking the AgentOrgGrant for App B isolates it
// ─────────────────────────────────────────────────────────────────────────

describe('T054 cross-cut: revoking the AgentOrgGrant for App B denies access to App B', () => {
  it('App B\'s access map collapses when its AgentOrgGrant is revoked (gate 1)', async () => {
    // Pre-revoke: App B sees the agent's memories.
    let accessAtB = await getAppMemoryAccess(db, f.appB.id);
    expect(accessAtB.size).toBeGreaterThan(0);

    // Revoke the grant.
    await db.agentOrgGrant.update({
      where: { orgId_agentId: { orgId: f.companyXOrg.id, agentId: f.juno.id } },
      data: { revokedAt: new Date() },
    });

    // Post-revoke: cross-org gate 1 fires → no memories.
    accessAtB = await getAppMemoryAccess(db, f.appB.id);
    expect(accessAtB.size).toBe(0);

    // App A (same-org) is unaffected because same-org installs auto-pass
    // gate 1 even without an active grant row.
    const accessAtA = await getAppMemoryAccess(db, f.appA.id);
    expect(accessAtA.size).toBeGreaterThan(0);
  });
});
