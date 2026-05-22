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

    expect(access.size).toBe(2);
    expect(access.has(systemMemoryId)).toBe(true);
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
// getAccessibleMemoryIds — list-mode for tools that don't take a memoryId
// ---------------------------------------------------------------------------

describe('getAccessibleMemoryIds', () => {
  it('returns the App\'s accessible memory ids', async () => {
    const { app } = await createDbAppWithKey(db, 'app-l', orgId);
    await createDbAppAgent(db, app.id, agentId);

    const auth: AuthContext = { appId: app.id, organizationId: orgId };
    const ids = await getAccessibleMemoryIds(db, auth);

    expect(ids).not.toBeNull();
    expect(new Set(ids)).toEqual(new Set([systemMemoryId, knowledgeMemoryId]));
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
