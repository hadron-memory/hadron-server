/**
 * Access-control tests. The only principal kind this layer resolves is
 * App-keyed (via App.agent_id direct FK after 008-agent-installation);
 * ADMIN/OWNER roles bypass subscription checks in the dispatch helpers.
 *
 * 008 changes from 005:
 *   - AppAgent.role (OPERATE | DEVELOP) is gone. System memory is universally
 *     READ_ONLY from any App context (DEVELOP-from-App is dropped per R-10).
 *   - App→Agent is a direct FK on App.agent_id; the AppAgent join is removed.
 *   - Per-attached-memory write caps remain governed by AgentMemoryItem.role.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../integrations/db/client.js';
import {
  cleanDb,
  createDbAppWithKey,
  createDbAppAgent,
} from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import type { AuthContext } from '../middleware/auth.js';
import {
  canReadMemory,
  canWriteToMemory,
  getAccessibleMemoryIds,
  getAppMemoryAccess,
  getMemoryAccess,
} from './access-control.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let orgId: string;
let agentId: string;
let systemMemoryId: string;
let knowledgeMemoryId: string;

async function buildAgentWithMemories(opts: { agentMemoryRole?: string } = {}) {
  const sysMemory = await db.memory.create({
    data: {
      class: 'knowledge', id: generateId(), name: 'sys', urn: `${orgId}:sys`, organizationId: orgId },
  });
  const knMemory = await db.memory.create({
    data: {
      class: 'knowledge', id: generateId(), name: 'kn', urn: `${orgId}:kn`, organizationId: orgId },
  });
  const agent = await db.agent.create({
    data: {
      id: generateId(),
      name: 'a',
      urn: `${orgId}:a`,
      organizationId: orgId,
      systemMemoryId: sysMemory.id,
    },
  });
  await db.agentMemoryItem.create({
    data: {
      agentId: agent.id,
      memoryId: knMemory.id,
      role: opts.agentMemoryRole ?? 'read',
    },
  });
  return { agent, sysMemory, knMemory };
}

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({
    data: { id: generateId(), name: 'access-test-org', urn: 'access-test-org' },
  });
  orgId = org.id;
  const built = await buildAgentWithMemories();
  agentId = built.agent.id;
  systemMemoryId = built.sysMemory.id;
  knowledgeMemoryId = built.knMemory.id;
});

// ---------------------------------------------------------------------------
// getAppMemoryAccess — App-keyed via App.agent_id direct FK
// ---------------------------------------------------------------------------

describe('getAppMemoryAccess (App-key principal)', () => {
  it('returns the agent system memory + memoryItems (system always READ_ONLY)', async () => {
    const { app } = await createDbAppWithKey(db, 'app-ro', orgId);
    await createDbAppAgent(db, app.id, agentId);

    const access = await getAppMemoryAccess(db, app.id);

    expect(access.size).toBe(2);
    // 008: system memory is universally READ_ONLY from an App context.
    expect(access.get(systemMemoryId)).toBe('READ_ONLY');
    expect(access.get(knowledgeMemoryId)).toBe('READ_ONLY');
  });

  it('keeps system memory READ_ONLY regardless of legacy DEVELOP arg', async () => {
    // 008: the legacy `role: 'DEVELOP'` arg on createDbAppAgent is a no-op;
    // system memory is read-only from any App.
    const { app } = await createDbAppWithKey(db, 'app-rw', orgId);
    await createDbAppAgent(db, app.id, agentId, { role: 'DEVELOP' });

    const access = await getAppMemoryAccess(db, app.id);

    expect(access.get(systemMemoryId)).toBe('READ_ONLY');
    expect(access.get(knowledgeMemoryId)).toBe('READ_ONLY');
  });

  it('grants READ_WRITE on a memoryItem when AgentMemoryItem.role allows it', async () => {
    await cleanDb(db);
    const org = await db.organization.create({
      data: { id: generateId(), name: 'rw-org', urn: 'rw-org' },
    });
    orgId = org.id;
    const built = await buildAgentWithMemories({ agentMemoryRole: 'read-write' });
    const localAgentId = built.agent.id;
    const localKnId = built.knMemory.id;
    const { app } = await createDbAppWithKey(db, 'app-rw', orgId);
    await createDbAppAgent(db, app.id, localAgentId);

    const access = await getAppMemoryAccess(db, app.id);

    expect(access.get(localKnId)).toBe('READ_WRITE');
  });

  it('treats a malformed legacy memoryItem role as no grant', async () => {
    const { app } = await createDbAppWithKey(db, 'app-invalid-role', orgId);
    await createDbAppAgent(db, app.id, agentId);
    const invalid = await db.memory.create({
      data: { id: generateId(), name: 'invalid role', urn: `${orgId}:invalid-role`, organizationId: orgId, class: 'knowledge' },
    });
    await db.agentMemoryItem.create({ data: { agentId, memoryId: invalid.id, role: 'bogus' } });
    const auth: AuthContext = { appId: app.id, organizationId: orgId };
    expect((await getAppMemoryAccess(db, app.id)).get(knowledgeMemoryId)).toBe('READ_ONLY');
    expect((await getAppMemoryAccess(db, app.id)).has(invalid.id)).toBe(false);
    expect(await canReadMemory(db, auth, invalid.id)).toBe(false);
  });

  it('returns an empty map when the App is orphan (agent_id IS NULL)', async () => {
    const { app } = await createDbAppWithKey(db, 'app-orphan', orgId);

    const access = await getAppMemoryAccess(db, app.id);

    expect(access.size).toBe(0);
  });

  it('returns an empty map when the App\'s linked Agent is soft-deleted', async () => {
    const { app } = await createDbAppWithKey(db, 'app-soft', orgId);
    await createDbAppAgent(db, app.id, agentId);
    await db.agent.update({ where: { id: agentId }, data: { deletedAt: new Date() } });

    const access = await getAppMemoryAccess(db, app.id);

    expect(access.size).toBe(0);
  });

  it('drops Agent reach when a retained AppAgent belongs to an uninstalled App', async () => {
    const { app } = await createDbAppWithKey(db, 'app-uninstalled', orgId);
    await createDbAppAgent(db, app.id, agentId);
    expect((await getAppMemoryAccess(db, app.id)).has(knowledgeMemoryId)).toBe(true);
    await db.app.update({ where: { id: app.id }, data: { uninstalledAt: new Date() } });
    expect((await getAppMemoryAccess(db, app.id)).size).toBe(0);
    expect(await canReadMemory(db, { appId: app.id, organizationId: orgId }, knowledgeMemoryId)).toBe(false);
  });

  it('drops a same-org install when its organization is soft-deleted', async () => {
    const { app } = await createDbAppWithKey(db, 'app-deleted-org', orgId);
    await createDbAppAgent(db, app.id, agentId);
    expect((await getAppMemoryAccess(db, app.id)).has(knowledgeMemoryId)).toBe(true);
    await db.organization.update({ where: { id: orgId }, data: { deletedAt: new Date() } });
    expect((await getAppMemoryAccess(db, app.id)).size).toBe(0);
    expect(await canReadMemory(db, { appId: app.id, organizationId: orgId }, knowledgeMemoryId)).toBe(false);
  });

  it('drops a licensed cross-org install when the Agent’s organization is soft-deleted', async () => {
    const appOrg = await db.organization.create({
      data: { id: generateId(), name: 'Foreign App', urn: `foreign-app-${generateId()}` },
    });
    const { app } = await createDbAppWithKey(db, 'app-deleted-agent-org', appOrg.id);
    await createDbAppAgent(db, app.id, agentId);
    await db.agentOrgGrant.create({
      data: { orgId: appOrg.id, agentId, activatedAt: new Date() },
    });
    expect((await getAppMemoryAccess(db, app.id)).has(knowledgeMemoryId)).toBe(true);
    await db.organization.update({ where: { id: orgId }, data: { deletedAt: new Date() } });
    expect((await getAppMemoryAccess(db, app.id)).size).toBe(0);
  });

  it('does not fold a legacy per-user holding into a foreign App key through a PUBLIC Agent', async () => {
    const creator = await db.user.create({ data: { id: generateId(), name: 'Holding creator' } });
    const holding = await db.memory.create({
      data: {
        id: generateId(), name: 'Legacy holding', urn: `${orgId}:legacy-holding`,
        organizationId: orgId, class: 'knowledge', visibility: 'PUBLIC',
        userMemoryOfAgentId: agentId, createdBy: creator.id,
      },
    });
    await db.agent.update({ where: { id: agentId }, data: { visibility: 'PUBLIC' } });
    await db.agentMemoryItem.create({ data: { agentId, memoryId: holding.id, role: 'read' } });
    const foreignOrg = await db.organization.create({
      data: { id: generateId(), name: 'Foreign', urn: `foreign-${generateId()}` },
    });
    const { app } = await createDbAppWithKey(db, 'foreign-holding-app', foreignOrg.id);
    await createDbAppAgent(db, app.id, agentId);
    await db.agentOrgGrant.create({
      data: { orgId: foreignOrg.id, agentId, activatedAt: new Date() },
    });
    expect((await getAppMemoryAccess(db, app.id)).has(knowledgeMemoryId)).toBe(true);
    expect((await getAppMemoryAccess(db, app.id)).has(holding.id)).toBe(false);
    expect(await canReadMemory(db, { appId: app.id, organizationId: foreignOrg.id }, holding.id)).toBe(false);
  });

  it('does not fold another App’s scoped knowledge through a globally linked Agent', async () => {
    const { app: appA } = await createDbAppWithKey(db, 'scoped-a', orgId);
    const { app: appB } = await createDbAppWithKey(db, 'scoped-b', orgId);
    await createDbAppAgent(db, appA.id, agentId);
    await createDbAppAgent(db, appB.id, agentId);
    const scoped = await db.memory.create({
      data: {
        id: generateId(), name: 'A only', urn: `${orgId}:scoped-a-only`,
        organizationId: orgId, appId: appA.id, class: 'knowledge', visibility: 'ORGANIZATION',
      },
    });
    await db.agentMemoryItem.create({ data: { agentId, memoryId: scoped.id, role: 'read' } });
    expect((await getAppMemoryAccess(db, appA.id)).has(scoped.id)).toBe(true);
    expect((await getAppMemoryAccess(db, appB.id)).has(scoped.id)).toBe(false);
    expect(await canReadMemory(db, { appId: appB.id, organizationId: orgId }, scoped.id)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getMemoryAccess — dispatches based on principal kind
// ---------------------------------------------------------------------------

describe('getMemoryAccess (dispatch by principal kind)', () => {
  it('dispatches to the App path when auth.appId is set', async () => {
    const { app } = await createDbAppWithKey(db, 'app-d', orgId);
    await createDbAppAgent(db, app.id, agentId);

    const auth: AuthContext = { appId: app.id, organizationId: orgId };
    const access = await getMemoryAccess(db, auth);

    // #1376: a bare App key keeps only the Agent's own system memory; the item-linked ORGANIZATION knowledge is not a grant.
    expect(access.size).toBe(1);
    expect(access.has(systemMemoryId)).toBe(true);
    expect(access.has(knowledgeMemoryId)).toBe(false);
  });

  it('returns empty when no appId AND no userId is set', async () => {
    const auth: AuthContext = {};
    const access = await getMemoryAccess(db, auth);
    expect(access.size).toBe(0);
  });

  // Spec 026 / D-2026-05-21-003 advisory branch
  it('returns cross-App union when auth.userId is set but auth.appId is not (advisory)', async () => {
    // User is a member of two Apps, both linked to the same Agent.
    // Each App grants access to the same memories (system + knowledge) via
    // the App→AppAgent→Agent→memoryItems path. Without an active App,
    // getMemoryAccess unions across both Apps; with both linked to the
    // same Agent + memories, the union equals each App's individual set.
    const { app: appA } = await createDbAppWithKey(db, 'app-cross-a', orgId);
    await createDbAppAgent(db, appA.id, agentId);
    const { app: appB } = await createDbAppWithKey(db, 'app-cross-b', orgId);
    await createDbAppAgent(db, appB.id, agentId);

    const user = await db.user.create({
      data: { id: generateId(), name: 'cross-app-user' },
    });
    await db.appMember.create({
      data: { appId: appA.id, userId: user.id, role: 'owner' },
    });
    await db.appMember.create({
      data: { appId: appB.id, userId: user.id, role: 'owner' },
    });

    const auth: AuthContext = { userId: user.id };
    const access = await getMemoryAccess(db, auth);

    // Both memories accessible via the union — even though no active App is set.
    expect(access.size).toBe(2);
    expect(access.has(systemMemoryId)).toBe(true);
    expect(access.has(knowledgeMemoryId)).toBe(true);
  });

  it('returns empty when userId is set but the user has no AppMember rows', async () => {
    const user = await db.user.create({
      data: { id: generateId(), name: 'no-apps-user' },
    });
    const auth: AuthContext = { userId: user.id };
    const access = await getMemoryAccess(db, auth);
    expect(access.size).toBe(0);
  });

  // Pins D-2026-05-21-003 focus-vs-access distinction. Active App
  // **narrows the view to that App's memories**, not the set of
  // accessible memories — both paths reach the same memory IDs in this
  // test because both Apps share the same Agent (so identical memory
  // bindings). The shape of the returned map is what's load-bearing:
  // (userId, no appId) returns the cross-App union, (userId, appId)
  // returns the per-App view, and both are bounded by the user's
  // AppMember rows. If a future change shifted authz semantics so the
  // active-App view differed from the union in ways the user couldn't
  // produce by switching active App, this test would catch it.
  it('cross-App union without selection matches the per-App view when selecting either App', async () => {
    const { app: appA } = await createDbAppWithKey(db, 'app-cmp-a', orgId);
    await createDbAppAgent(db, appA.id, agentId);
    const { app: appB } = await createDbAppWithKey(db, 'app-cmp-b', orgId);
    await createDbAppAgent(db, appB.id, agentId);

    const user = await db.user.create({
      data: { id: generateId(), name: 'cmp-user' },
    });
    await db.appMember.create({ data: { appId: appA.id, userId: user.id, role: 'owner' } });
    await db.appMember.create({ data: { appId: appB.id, userId: user.id, role: 'owner' } });

    const unionView = await getMemoryAccess(db, { userId: user.id });
    const appAView = await getMemoryAccess(db, { userId: user.id, appId: appA.id, organizationId: orgId });
    const appBView = await getMemoryAccess(db, { userId: user.id, appId: appB.id, organizationId: orgId });

    // Both per-App views see the same memories (same Agent backing both
    // Apps). The union view equals their (identical) set — no spurious
    // memories appear in the cross-App view, no memories are missing.
    expect([...unionView.keys()].sort()).toEqual([...appAView.keys()].sort());
    expect([...unionView.keys()].sort()).toEqual([...appBView.keys()].sort());
    expect(unionView.size).toBe(2);
  });

  // FR-016 / spec 021 partial-uniqueness — App.urn is unique only across
  // active rows. A user with an uninstalled history App + an active
  // re-install must see the active App's memory access, not the
  // history row's. Regression test for the resolveAppIdentifier bug
  // (separately tested in user-app-resolution.test.ts) applied at the
  // access-control layer.
  it('cross-App union via getMemoryAccess prefers the active App row for a re-installed App', async () => {
    const { app: history } = await createDbAppWithKey(db, 'app-reinstall', orgId);
    await createDbAppAgent(db, history.id, agentId);
    // Uninstall the first row.
    await db.app.update({ where: { id: history.id }, data: { uninstalledAt: new Date() } });
    // Re-install with the same URN: new row, active.
    const { app: active } = await createDbAppWithKey(db, 'app-reinstall', orgId);
    await createDbAppAgent(db, active.id, agentId);

    const user = await db.user.create({
      data: { id: generateId(), name: 'reinstall-user' },
    });
    // Membership on the ACTIVE row.
    await db.appMember.create({ data: { appId: active.id, userId: user.id, role: 'owner' } });

    const access = await getMemoryAccess(db, { userId: user.id });
    // The user IS a member of the active App → cross-App union returns
    // its memories. resolveUserApps's filter (`app: { is: { deletedAt:
    // null, uninstalledAt: null } }`) already excludes the history row;
    // this test pins that downstream-of-resolveUserApps behavior.
    expect(access.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// getMemoryAccess — direct org-read (portal parity; Micromentor onboarding fix)
// ---------------------------------------------------------------------------

describe('getMemoryAccess — direct org-read (portal parity)', () => {
  // A knowledge memory owned by the org but NOT attached to the Agent —
  // reachable only via org membership, never via the App/agent path. The
  // discriminator between "org-read" and "app-read".
  async function createOrphanOrgKnowledgeMemory() {
    return db.memory.create({
      data: {
        class: 'knowledge',
        id: generateId(),
        name: 'orphan-org-kn',
        urn: `${orgId}:orphan-org-kn`,
        organizationId: orgId,
      },
    });
  }

  async function makeOrgMember(name: string) {
    const user = await db.user.create({ data: { id: generateId(), name } });
    await db.orgMember.create({
      data: { id: generateId(), organizationId: orgId, userId: user.id, role: 'READER' },
    });
    return user;
  }

  it('grants an OrgMember READ_ONLY on org memories with zero AppMember rows', async () => {
    const orphan = await createOrphanOrgKnowledgeMemory();
    const user = await makeOrgMember('org-only-user');

    const access = await getMemoryAccess(db, { userId: user.id });

    // All three org knowledge memories — including the orphan never attached
    // to the Agent — are readable purely via org membership. No App install
    // required. This is the Micromentor onboarding fix.
    expect(access.get(systemMemoryId)).toBe('READ_ONLY');
    expect(access.get(knowledgeMemoryId)).toBe('READ_ONLY');
    expect(access.get(orphan.id)).toBe('READ_ONLY');
  });

  it('org-read is READ_ONLY — an OrgMember can read but not write without an App role', async () => {
    const user = await makeOrgMember('org-ro-user');

    expect(await canReadMemory(db, { userId: user.id }, knowledgeMemoryId)).toBe(true);
    expect(await canWriteToMemory(db, { userId: user.id }, knowledgeMemoryId)).toBe(false);
  });

  it('getAccessibleMemoryIds includes org memories for a bare OrgMember', async () => {
    const orphan = await createOrphanOrgKnowledgeMemory();
    const user = await makeOrgMember('org-ids-user');

    const ids = await getAccessibleMemoryIds(db, { userId: user.id });

    expect(new Set(ids)).toEqual(
      new Set([systemMemoryId, knowledgeMemoryId, orphan.id]),
    );
  });

  it('a user who is neither OrgMember nor AppMember sees nothing', async () => {
    await createOrphanOrgKnowledgeMemory();
    const stranger = await db.user.create({
      data: { id: generateId(), name: 'stranger' },
    });

    const access = await getMemoryAccess(db, { userId: stranger.id });

    expect(access.size).toBe(0);
  });

  it('App Key callers (no userId) get NO org-read — App isolation preserved', async () => {
    // The org has a knowledge memory the Agent isn't attached to.
    const orphan = await createOrphanOrgKnowledgeMemory();
    const { app } = await createDbAppWithKey(db, 'app-iso', orgId);
    await createDbAppAgent(db, app.id, agentId);

    const access = await getMemoryAccess(db, { appId: app.id, organizationId: orgId });

    // #1376: only the Agent's own system memory — neither the orphan org memory nor the
    // item-linked ORGANIZATION knowledge reaches a bare App key.
    expect(access.size).toBe(1);
    expect(access.has(systemMemoryId)).toBe(true);
    expect(access.has(knowledgeMemoryId)).toBe(false);
    expect(access.has(orphan.id)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// canWriteToMemory — write-permission gate
// ---------------------------------------------------------------------------

describe('canWriteToMemory', () => {
  it('returns false for an App on the system memory (universally read-only)', async () => {
    // 008: DEVELOP-from-App is gone. Any App context cannot write system memory.
    const { app } = await createDbAppWithKey(db, 'app-w', orgId);
    await createDbAppAgent(db, app.id, agentId, { role: 'DEVELOP' });

    const auth: AuthContext = { appId: app.id, organizationId: orgId };

    expect(await canWriteToMemory(db, auth, systemMemoryId)).toBe(false);
  });

  it('returns false for an App on the system memory (no DEVELOP role exists)', async () => {
    const { app } = await createDbAppWithKey(db, 'app-ro', orgId);
    await createDbAppAgent(db, app.id, agentId);

    const auth: AuthContext = { appId: app.id, organizationId: orgId };

    expect(await canWriteToMemory(db, auth, systemMemoryId)).toBe(false);
  });

  it('returns true for an ADMIN role regardless of subscription', async () => {
    const auth: AuthContext = { roles: ['ADMIN'], userId: 'u' };
    expect(await canWriteToMemory(db, auth, systemMemoryId)).toBe(true);
  });

  it('returns true for an OWNER role regardless of subscription', async () => {
    const auth: AuthContext = { roles: ['OWNER'], userId: 'u' };
    expect(await canWriteToMemory(db, auth, systemMemoryId)).toBe(true);
  });

  it('returns false when no principal is set', async () => {
    const auth: AuthContext = {};
    expect(await canWriteToMemory(db, auth, systemMemoryId)).toBe(false);
  });

  it('returns false for a memoryId outside the App\'s subscriptions', async () => {
    const { app } = await createDbAppWithKey(db, 'app-w', orgId);
    await createDbAppAgent(db, app.id, agentId);

    const otherMem = await db.memory.create({
      data: {
      class: 'knowledge', id: generateId(), name: 'unrelated', urn: `${orgId}:unrelated`, organizationId: orgId },
    });

    const auth: AuthContext = { appId: app.id, organizationId: orgId };

    expect(await canWriteToMemory(db, auth, otherMem.id)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Free-standing personal/private memory (spec 034) — owner-only, App-agnostic
// ---------------------------------------------------------------------------

describe('canReadMemory / canWriteToMemory — free-standing personal/private (034)', () => {
  // A free-standing memory: user-owned, created outside any App context. Both
  // app_id and user_memory_of_agent_id are NULL (relaxed by spec 034). The
  // owner is the sole gate — App context must not affect access.
  async function createFreeStanding(cls: 'personal' | 'private') {
    const owner = await db.user.create({
      data: { id: generateId(), name: `fs-${cls}-owner` },
    });
    const mem = await db.memory.create({
      data: {
        class: cls,
        id: generateId(),
        name: `free-${cls}`,
        urn: `${orgId}:free-${cls}-${generateId()}`,
        organizationId: orgId,
        userId: owner.id,
        appId: null,
        userMemoryOfAgentId: null,
      },
    });
    return { owner, mem };
  }

  // An active App the user is working through. Its identity must NOT gate a
  // free-standing memory — the membership row just makes `auth.appId` realistic.
  async function activeAppFor(userId: string, slug: string) {
    const { app } = await createDbAppWithKey(db, slug, orgId);
    await createDbAppAgent(db, app.id, agentId);
    await db.appMember.create({ data: { appId: app.id, userId, role: 'owner' } });
    return app;
  }

  it('owner reads+writes with NO active App', async () => {
    const { owner, mem } = await createFreeStanding('personal');
    const auth: AuthContext = { userId: owner.id };
    expect(await canReadMemory(db, auth, mem.id)).toBe(true);
    expect(await canWriteToMemory(db, auth, mem.id)).toBe(true);
  });

  // The #282 regression: pre-fix, an active App (auth.appId set) sent a
  // free-standing memory down the legacy app_id-NULL branch, which demands an
  // installed agent the row doesn't have — denying the owner their own memory.
  it('owner reads+writes WITH an active App (regression: #282 free-standing gate)', async () => {
    const { owner, mem } = await createFreeStanding('personal');
    const app = await activeAppFor(owner.id, 'fs-app');
    const auth: AuthContext = { userId: owner.id, appId: app.id, organizationId: orgId };
    expect(await canReadMemory(db, auth, mem.id)).toBe(true);
    expect(await canWriteToMemory(db, auth, mem.id)).toBe(true);
  });

  it('free-standing PRIVATE memory: owner allowed with an active App', async () => {
    const { owner, mem } = await createFreeStanding('private');
    const app = await activeAppFor(owner.id, 'fs-app-priv');
    const auth: AuthContext = { userId: owner.id, appId: app.id, organizationId: orgId };
    expect(await canReadMemory(db, auth, mem.id)).toBe(true);
    expect(await canWriteToMemory(db, auth, mem.id)).toBe(true);
  });

  it('strict ownership: a non-owner is denied even as ADMIN, App or not (FR-016)', async () => {
    const { mem } = await createFreeStanding('personal');
    const other = await db.user.create({ data: { id: generateId(), name: 'fs-other' } });
    const app = await activeAppFor(other.id, 'fs-app-other');

    expect(await canReadMemory(db, { userId: other.id }, mem.id)).toBe(false);
    expect(
      await canReadMemory(db, { userId: other.id, appId: app.id, organizationId: orgId }, mem.id),
    ).toBe(false);
    // Even ADMIN cannot read another user's personal/private memory — the
    // strict-owner check fires before the short-circuit and before any bypass.
    expect(await canReadMemory(db, { userId: other.id, roles: ['ADMIN'] }, mem.id)).toBe(false);
    expect(await canWriteToMemory(db, { userId: other.id }, mem.id)).toBe(false);
  });

  it('an App Key principal (no userId) cannot reach a free-standing memory', async () => {
    const { mem } = await createFreeStanding('personal');
    const { app } = await createDbAppWithKey(db, 'fs-appkey', orgId);
    await createDbAppAgent(db, app.id, agentId);
    const auth: AuthContext = { appId: app.id, organizationId: orgId };
    expect(await canReadMemory(db, auth, mem.id)).toBe(false);
    expect(await canWriteToMemory(db, auth, mem.id)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getAccessibleMemoryIds — list-mode for tools that don't take a memoryId
// ---------------------------------------------------------------------------

describe('getAccessibleMemoryIds', () => {
  it('returns the App\'s accessible memory ids', async () => {
    const { app } = await createDbAppWithKey(db, 'app-l', orgId);
    await createDbAppAgent(db, app.id, agentId);

    const auth: AuthContext = { appId: app.id, organizationId: orgId };
    const ids = await getAccessibleMemoryIds(db, auth);

    expect(ids).not.toBeNull();
    // #1376: a bare App key's ids are the Agent's system memory only (an item is a limit, not a grant).
    expect(new Set(ids)).toEqual(new Set([systemMemoryId]));
  });

  it('returns null (means: all memories) for ADMIN', async () => {
    const auth: AuthContext = { roles: ['ADMIN'], userId: 'u' };
    expect(await getAccessibleMemoryIds(db, auth)).toBeNull();
  });

  it('returns an empty array when no principal is set', async () => {
    const auth: AuthContext = {};
    expect(await getAccessibleMemoryIds(db, auth)).toEqual([]);
  });
});
