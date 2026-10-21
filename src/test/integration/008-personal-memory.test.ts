/**
 * 008-agent-installation — US2 personal-memory pivot tests (T048–T053).
 *
 * Covers the load-bearing addressing change: personal-class memory pivots
 * on (app_id, user_id) (replaces 005's effective (agent_id, user_id) keying).
 * The integration test for the Mike-multi-install scenario is
 * `008-multi-install-isolation.test.ts` (T054 / SC-003) — this file holds
 * the focused unit-shape tests.
 */

import { restoreChkMemoryClassAppId } from '../memoryClassCheck.js';
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
  EXPLICIT_REF,
  canReadMemory,
  canWriteToMemory,
} from '../../mcp/access-control.js';
import type { AuthContext } from '../../middleware/auth.js';

let orgX: { id: string; urn: string };
let orgY: { id: string; urn: string };
let appAtX: { id: string };
let appAtY: { id: string };
let mealplan: { id: string };
let mike: { id: string };
let bob: { id: string };

beforeEach(async () => {
  await cleanDb(db);
  // Two orgs, both deploy the same Agent. The Agent lives in Org X (the
  // "platform" side). Org Y is the cross-org installer.
  const orgXRow = await db.organization.create({
    data: { id: generateId(), name: 'Org X', urn: 'org-x' },
  });
  const orgYRow = await db.organization.create({
    data: { id: generateId(), name: 'Org Y', urn: 'org-y' },
  });
  orgX = { id: orgXRow.id, urn: orgXRow.urn };
  orgY = { id: orgYRow.id, urn: orgYRow.urn };

  // The shared Agent.
  mealplan = await db.agent.create({
    data: {
      id: generateId(),
      organizationId: orgX.id,
      urn: `${orgX.urn}:mealplan`,
      name: 'Mealplan',
      visibility: 'PUBLIC',
      installationPolicy: { maxMembers: 'unlimited', memberRoles: ['owner'] },
    },
  });

  // App at Org X (same-org install).
  appAtX = await db.app.create({
    data: {
      id: generateId(),
      organizationId: orgX.id,
      urn: `${orgX.urn}:mealplan-app`,
      name: 'Mealplan @ Org X',
      appAgents: { create: { agentId: mealplan.id } },
    },
  });

  // App at Org Y (cross-org install — needs an AgentOrgGrant for gate 1).
  appAtY = await db.app.create({
    data: {
      id: generateId(),
      organizationId: orgY.id,
      urn: `${orgY.urn}:mealplan-app`,
      name: 'Mealplan @ Org Y',
      appAgents: { create: { agentId: mealplan.id } },
    },
  });
  await createDbAgentOrgGrant(db, orgY.id, mealplan.id);

  // Users + AppMembers + AgentSubscription for Mike↔Mealplan.
  mike = await db.user.create({
    data: { id: generateId(), handle: 'mike', githubId: 50001 },
  });
  bob = await db.user.create({
    data: { id: generateId(), handle: 'bob', githubId: 50002 },
  });
  await createDbAppMember(db, appAtX.id, mike.id, 'owner');
  await createDbAppMember(db, appAtY.id, mike.id, 'owner');
  await createDbAppMember(db, appAtX.id, bob.id, 'owner');
  await createDbAgentSubscription(db, mike.id, mealplan.id);
  await createDbAgentSubscription(db, bob.id, mealplan.id);
});

// ─────────────────────────────────────────────────────────────────────────
// T048 — personal-memory provisioning idempotency (sequential)
// ─────────────────────────────────────────────────────────────────────────

describe('T048: personal-memory provisioning idempotency (sequential)', () => {
  it('a follow-up lookup with the same (app_id, user_id) returns the existing row', async () => {
    // Seed a personal memory at (appAtX, mike). A second findFirst for the
    // same keys should return that row, not create a new one. (The
    // resolver-level lazy-create uses findFirst-then-create — sequential
    // idempotency is guaranteed by the find. Strict concurrent
    // idempotency would require a UNIQUE INDEX on (app_id, user_id) WHERE
    // class='personal'; deferred to a future tightening per the
    // 005-agent-subscription open follow-up.)
    const created = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: orgX.id,
        urn: `${appAtX.id}:mike-personal`,
        name: 'Mike\'s memory @ Org X',
        class: 'personal',
        visibility: null,
        userId: mike.id,
        userMemoryOfAgentId: mealplan.id,
        appId: appAtX.id,
      },
    });

    const found = await db.memory.findFirst({
      where: {
        appId: appAtX.id,
        userId: mike.id,
        class: 'personal',
        deletedAt: null,
      },
    });
    expect(found?.id).toBe(created.id);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// T049 — access-control gate 3 with App-isolation
// ─────────────────────────────────────────────────────────────────────────

describe('T049: access-control gate 3 enforces Memory.app_id === the call\'s App', () => {
  it('Mike\'s memory at (appAtX, mike): readable through appAtX; through appAtY only by explicit reference (#1503)', async () => {
    const memX = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: orgX.id,
        urn: `${appAtX.id}:mike-x`,
        name: 'Mike @ X',
        class: 'personal',
        visibility: null,
        userId: mike.id,
        userMemoryOfAgentId: mealplan.id,
        appId: appAtX.id,
      },
    });

    const ctxAtX: AuthContext = { appId: appAtX.id, userId: mike.id, organizationId: orgX.id };
    const ctxAtY: AuthContext = { appId: appAtY.id, userId: mike.id, organizationId: orgY.id };

    expect(await canReadMemory(db, ctxAtX, memX.id)).toBe(true);
    expect(await canWriteToMemory(db, ctxAtX, memX.id)).toBe(true);

    // 008's per-App isolation, as amended by #1503 (Holger's ruling (c),
    // 2026-10-01). Naming the memory explicitly while appAtY is selected
    // evaluates it as appAtX, the memory's own App (cor:acl:020:01), so the
    // same isolation and subscription checks pass as above.
    expect(await canReadMemory(db, ctxAtY, memX.id, EXPLICIT_REF)).toBe(true);
    expect(await canWriteToMemory(db, ctxAtY, memX.id, EXPLICIT_REF)).toBe(true);
    // Isolation still holds everywhere else:
    // a gate that was not asked about an explicit reference (a listing or a traversal),
    expect(await canReadMemory(db, ctxAtY, memX.id)).toBe(false);
    expect(await canWriteToMemory(db, ctxAtY, memX.id)).toBe(false);
    // a bound session through appAtY,
    const sessionAtY: AuthContext = { ...ctxAtY, sessionId: generateId() };
    expect(await canReadMemory(db, sessionAtY, memX.id, EXPLICIT_REF)).toBe(false);
    expect(await canWriteToMemory(db, sessionAtY, memX.id, EXPLICIT_REF)).toBe(false);
    // and a caller who could not select appAtX.
    await db.appMember.deleteMany({ where: { appId: appAtX.id, userId: mike.id } });
    expect(await canReadMemory(db, ctxAtY, memX.id, EXPLICIT_REF)).toBe(false);
    expect(await canWriteToMemory(db, ctxAtY, memX.id, EXPLICIT_REF)).toBe(false);
  });

  it('Bob (a different user) cannot read Mike\'s personal memory through any App (FR-016)', async () => {
    const memX = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: orgX.id,
        urn: `${appAtX.id}:mike-x-bob-test`,
        name: 'Mike @ X',
        class: 'personal',
        visibility: null,
        userId: mike.id,
        userMemoryOfAgentId: mealplan.id,
        appId: appAtX.id,
      },
    });

    const bobAtX: AuthContext = { appId: appAtX.id, userId: bob.id, organizationId: orgX.id };
    expect(await canReadMemory(db, bobAtX, memX.id)).toBe(false);
    // Even though Bob is a member of appAtX with an AgentSubscription, the
    // strict-ownership gate denies cross-user reads of personal memory.
  });

  it('legacy memory with app_id=NULL: a session through an App for a different agent is denied', async () => {
    // Pre-008 row that survived migration without a Session attribution
    // (i.e., the migration's R-3 fallback would have downgraded it; for the
    // test we simulate the residual case where some legacy row still has
    // class='personal' and app_id=NULL). The chk_memory_class_app_id check
    // forbids that combination, so we drop the constraint just for this row.
    await db.$executeRawUnsafe(`ALTER TABLE memories DROP CONSTRAINT IF EXISTS chk_memory_class_app_id`);
    try {
      const otherAgent = await db.agent.create({
        data: {
          id: generateId(),
          organizationId: orgX.id,
          urn: `${orgX.urn}:other-agent`,
          name: 'other-agent',
        },
      });
      // Mike has a subscription to BOTH agents — without the agent-match
      // guard, this would be the attack vector: a session through the
      // other-agent App could touch a legacy memory created for mealplan.
      await db.agentSubscription.create({
        data: {
          userId: mike.id,
          agentId: otherAgent.id,
          activatedAt: new Date(),
        },
      });
      const otherApp = await db.app.create({
        data: {
          id: generateId(),
          organizationId: orgX.id,
          urn: `${orgX.urn}:other-app`,
          name: 'Other App',
          appAgents: { create: { agentId: otherAgent.id } },
        },
      });
      const legacyMem = await db.memory.create({
        data: {
          id: generateId(),
          organizationId: orgX.id,
          urn: `${orgX.urn}:legacy-mike`,
          name: 'Legacy Mike memory (Mealplan)',
          class: 'personal',
          visibility: null,
          userId: mike.id,
          userMemoryOfAgentId: mealplan.id,
          appId: null, // legacy
        },
      });

      // The attack: Mike's session through Other App tries to read his
      // legacy-Mealplan memory. With the agent-match guard, this is denied
      // because otherApp.agentId !== legacyMem.userMemoryOfAgentId.
      const attackCtx: AuthContext = {
        appId: otherApp.id,
        userId: mike.id,
        organizationId: orgX.id,
      };
      expect(await canReadMemory(db, attackCtx, legacyMem.id)).toBe(false);
      expect(await canWriteToMemory(db, attackCtx, legacyMem.id)).toBe(false);

      // The legitimate path still works: Mike's session through appAtX
      // (whose agentId IS mealplan) can read the legacy memory.
      const goodCtx: AuthContext = {
        appId: appAtX.id,
        userId: mike.id,
        organizationId: orgX.id,
      };
      expect(await canReadMemory(db, goodCtx, legacyMem.id)).toBe(true);
    } finally {
      // Clean any class='personal' app_id=NULL rows we created (the
      // legacy-shape rows would violate the constraint we're about to
      // re-add). Downgrade them to knowledge with the same shape the
      // migration's step 4b applies.
      await db.$executeRawUnsafe(`
        UPDATE memories
           SET class = 'knowledge', user_id = NULL, visibility = 'ORGANIZATION'
         WHERE class = 'personal' AND app_id IS NULL
      `);
      // Re-add the constraint exactly as prisma/post-push.sql defines it, so later files in this worker see the real
      // shape (a hand-copied one lost the #2064 install-memory arm and broke them).
      await restoreChkMemoryClassAppId((sql) => db.$executeRawUnsafe(sql));
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// T050 + T051 — orphan re-attach behavior (FR-015)
// ─────────────────────────────────────────────────────────────────────────

describe('T050: personal memory re-attaches automatically when the user rejoins the same App', () => {
  it('removing AppMember does NOT delete the personal Memory; rejoining sees the same row', async () => {
    // Mike accumulates a personal memory at (appAtX, mike).
    const original = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: orgX.id,
        urn: `${appAtX.id}:mike-personal`,
        name: 'Mike\'s personal',
        class: 'personal',
        visibility: null,
        userId: mike.id,
        userMemoryOfAgentId: mealplan.id,
        appId: appAtX.id,
      },
    });

    // Mike leaves the App (AppMember row deletion). Per FR-015, the personal
    // memory is retained as an orphan.
    await db.appMember.delete({
      where: { appId_userId: { appId: appAtX.id, userId: mike.id } },
    });

    const afterLeave = await db.memory.findUnique({ where: { id: original.id } });
    expect(afterLeave).not.toBeNull();
    expect(afterLeave!.deletedAt).toBeNull();

    // Mike rejoins later. The auto-reattach is implicit in the addressing —
    // the next lookup at (appAtX, mike) finds the same row.
    await createDbAppMember(db, appAtX.id, mike.id, 'owner');
    const afterRejoin = await db.memory.findFirst({
      where: {
        appId: appAtX.id,
        userId: mike.id,
        class: 'personal',
        deletedAt: null,
      },
    });
    expect(afterRejoin?.id).toBe(original.id);
  });
});

describe('T051: an orphan from App A does NOT auto-attach when user joins App B (same Agent)', () => {
  it('lookup at (appAtY, mike) returns NULL even though (appAtX, mike) exists for the same Agent', async () => {
    await db.memory.create({
      data: {
        id: generateId(),
        organizationId: orgX.id,
        urn: `${appAtX.id}:mike-personal-orphan`,
        name: 'Mike @ X (orphan)',
        class: 'personal',
        visibility: null,
        userId: mike.id,
        userMemoryOfAgentId: mealplan.id,
        appId: appAtX.id,
      },
    });

    // Mike is also an AppMember of appAtY (set up in beforeEach), but no
    // personal memory exists at (appAtY, mike) yet.
    const lookupAtY = await db.memory.findFirst({
      where: {
        appId: appAtY.id,
        userId: mike.id,
        class: 'personal',
        deletedAt: null,
      },
    });
    expect(lookupAtY).toBeNull();

    // Mike's first personal-memory write through appAtY creates a fresh row
    // at (appAtY, mike). The (appAtX, mike) orphan is untouched.
    const freshAtY = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: orgY.id,
        urn: `${appAtY.id}:mike-personal`,
        name: 'Mike @ Y (fresh)',
        class: 'personal',
        visibility: null,
        userId: mike.id,
        userMemoryOfAgentId: mealplan.id,
        appId: appAtY.id,
      },
    });
    expect(freshAtY.appId).toBe(appAtY.id);

    // Both rows coexist with distinct ids.
    const allMike = await db.memory.findMany({
      where: { userId: mike.id, class: 'personal', deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
    expect(allMike.length).toBe(2);
    expect(new Set(allMike.map((m) => m.appId))).toEqual(
      new Set([appAtX.id, appAtY.id]),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// T052 — app-class memory isolation (shared)
// ─────────────────────────────────────────────────────────────────────────

describe('T052: app-class memories addressed on (app_id, agent_id) are distinct across installs', () => {
  it('two app-class memories with the same agent but different apps coexist with distinct app_ids', async () => {
    // Each install of a shared-app-memory Agent has its own app-class memory
    // row keyed on (app_id, agent_id). The find-or-create resolver-side
    // logic for this lookup is a future task (currently startAgentSession
    // creates per-session anonymous memories, which is a different concern).
    // This test asserts the SCHEMA shape supports distinct rows.
    const memAtX = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: orgX.id,
        urn: `${appAtX.id}:appmem`,
        name: 'App memory @ X',
        class: 'app',
        visibility: null,
        userMemoryOfAgentId: mealplan.id,
        appId: appAtX.id,
      },
    });
    const memAtY = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: orgY.id,
        urn: `${appAtY.id}:appmem`,
        name: 'App memory @ Y',
        class: 'app',
        visibility: null,
        userMemoryOfAgentId: mealplan.id,
        appId: appAtY.id,
      },
    });
    expect(memAtX.id).not.toBe(memAtY.id);
    expect(memAtX.appId).toBe(appAtX.id);
    expect(memAtY.appId).toBe(appAtY.id);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// T053 — per-user app memory (Juno's appMemory='user' case)
// ─────────────────────────────────────────────────────────────────────────

describe('T053: per-user app-class memory addresses on (app_id, agent_id, user_id)', () => {
  it('two users have distinct app-class memory rows in the same App when appMemory=user', async () => {
    // Juno-shaped: each member has private app-memory inside one install.
    // The test verifies the schema can hold (app_id, agent_id, user_id)
    // distinct rows; the find-or-create resolver-side logic for
    // appMemory=user is a future task.
    const juno = await db.agent.create({
      data: {
        id: generateId(),
        organizationId: orgX.id,
        urn: `${orgX.urn}:juno`,
        name: 'Juno',
        memoryProvisioning: { appMemory: 'user' },
      },
    });
    const junoApp = await db.app.create({
      data: {
        id: generateId(),
        organizationId: orgX.id,
        urn: `${orgX.urn}:juno-app`,
        name: 'Juno @ Org X',
        appAgents: { create: { agentId: juno.id } },
      },
    });

    // Two users each get their own app-class memory keyed on
    // (junoApp, juno, user). The schema doesn't model the user_id
    // dimension on Memory directly for app-class — it lives in
    // Memory.userId for personal-class. For per-user app-memory the
    // pattern in spec FR-011 is the same Memory row, distinguished by
    // class='app' AND userId set. The DB allows this; verify.
    const m1 = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: orgX.id,
        urn: `${junoApp.id}:user-${mike.id}`,
        name: 'Juno per-user memory (Mike)',
        class: 'app',
        visibility: null,
        userMemoryOfAgentId: juno.id,
        appId: junoApp.id,
        // userId on app-class memory denotes the per-user keying. The
        // chk_personal_visibility_user constraint requires PERSONAL ⇔ userId,
        // so app-class memory with userId set must keep visibility=PRIVATE.
      },
    });
    const m2 = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: orgX.id,
        urn: `${junoApp.id}:user-${bob.id}`,
        name: 'Juno per-user memory (Bob)',
        class: 'app',
        visibility: null,
        userMemoryOfAgentId: juno.id,
        appId: junoApp.id,
      },
    });
    // Both rows coexist with distinct ids; both pivot off the same
    // (app_id, agent_id) but identify their per-user owner via userId
    // (or, in v1, via urn convention since chk_personal_visibility_user
    // forbids userId on non-PERSONAL rows).
    expect(m1.id).not.toBe(m2.id);
    expect(m1.appId).toBe(junoApp.id);
    expect(m2.appId).toBe(junoApp.id);
  });
});
