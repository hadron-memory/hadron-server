/**
 * Access-control tests. The only principal kind this layer resolves is
 * App-keyed (via AppAgent membership); ADMIN/OWNER roles bypass
 * subscription checks in the dispatch helpers.
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
// getAppMemoryAccess (US2 — the new path)
// ---------------------------------------------------------------------------

describe('getAppMemoryAccess (App-key principal)', () => {
  it('returns the agent system memory + memoryItems for a READ_ONLY AppAgent', async () => {
    const { app } = await createDbAppWithKey(db, 'app-ro', orgId);
    await createDbAppAgent(db, app.id, agentId, {  });

    const access = await getAppMemoryAccess(db, app.id);

    expect(access.size).toBe(2);
    expect(access.get(systemMemoryId)).toBe('READ_ONLY');
    expect(access.get(knowledgeMemoryId)).toBe('READ_ONLY');
  });

  it('grants READ_WRITE on the system memory when AppAgent.role=DEVELOP', async () => {
    const { app } = await createDbAppWithKey(db, 'app-rw', orgId);
    await createDbAppAgent(db, app.id, agentId, { role: 'DEVELOP' });

    const access = await getAppMemoryAccess(db, app.id);

    expect(access.get(systemMemoryId)).toBe('READ_WRITE');
    // The knowledge memory's agentMemoryItem role defaults to 'read'.
    // Per 005-agent-subscription, AppAgent.role no longer caps per-attached-memory
    // writes; only AgentMemoryItem.role does. Default 'read' → READ_ONLY.
    expect(access.get(knowledgeMemoryId)).toBe('READ_ONLY');
  });

  it('grants READ_WRITE on a memoryItem when both subscription and item role allow it', async () => {
    await cleanDb(db);
    const org = await db.organization.create({
      data: { id: generateId(), name: 'rw-org', urn: 'rw-org' },
    });
    orgId = org.id;
    const built = await buildAgentWithMemories({ agentMemoryRole: 'read-write' });
    const localAgentId = built.agent.id;
    const localKnId = built.knMemory.id;
    const { app } = await createDbAppWithKey(db, 'app-rw', orgId);
    await createDbAppAgent(db, app.id, localAgentId, {  });

    const access = await getAppMemoryAccess(db, app.id);

    expect(access.get(localKnId)).toBe('READ_WRITE');
  });

  it('returns an empty map when the App has no AppAgent rows', async () => {
    const { app } = await createDbAppWithKey(db, 'app-orphan', orgId);

    const access = await getAppMemoryAccess(db, app.id);

    expect(access.size).toBe(0);
  });

  it('skips soft-deleted AppAgent rows', async () => {
    const { app } = await createDbAppWithKey(db, 'app-soft', orgId);
    await createDbAppAgent(db, app.id, agentId);
    await db.appAgent.update({
      where: { appId_agentId: { appId: app.id, agentId } },
      data: { deletedAt: new Date() },
    });

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

  it('returns empty when no appId is set', async () => {
    const auth: AuthContext = {};
    const access = await getMemoryAccess(db, auth);
    expect(access.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// canWriteToMemory — write-permission gate
// ---------------------------------------------------------------------------

describe('canWriteToMemory', () => {
  it('returns true for an App with role=DEVELOP on the system memory', async () => {
    const { app } = await createDbAppWithKey(db, 'app-w', orgId);
    await createDbAppAgent(db, app.id, agentId, { role: 'DEVELOP' });

    const auth: AuthContext = { appId: app.id, organizationId: orgId };

    expect(await canWriteToMemory(db, auth, systemMemoryId)).toBe(true);
  });

  it('returns false for an App with role=OPERATE on the system memory', async () => {
    const { app } = await createDbAppWithKey(db, 'app-ro', orgId);
    await createDbAppAgent(db, app.id, agentId, { role: 'OPERATE' });

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
    await createDbAppAgent(db, app.id, agentId, { role: 'DEVELOP' });

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
