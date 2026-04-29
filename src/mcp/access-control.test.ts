/**
 * Phase 2 access-control tests for the Station -> App migration
 * (spec-kits/specs/003-station-to-app, US2, T018).
 *
 * Verifies that the access-control layer used by every MCP tool
 * correctly handles three principal kinds:
 *   - App-keyed (AppAgent membership) — the new path established here
 *   - Station-keyed (StationAgentSubscription) — the legacy path,
 *     kept as a transition fallback through Phase 4
 *   - Neither / ADMIN-OWNER bypass
 *
 * Tests both the per-principal helpers (getAppMemoryAccess,
 * getStationMemoryAccess) and the dispatch helpers (getMemoryAccess,
 * canWriteToMemory, getAccessibleMemoryIds).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../integrations/db/client.js';
import {
  cleanDb,
  createDbStation,
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
  getStationMemoryAccess,
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
    data: { id: generateId(), name: 'sys', urn: `${orgId}:sys`, organizationId: orgId },
  });
  const knMemory = await db.memory.create({
    data: { id: generateId(), name: 'kn', urn: `${orgId}:kn`, organizationId: orgId },
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
    await createDbAppAgent(db, app.id, agentId, { subscriptionType: 'READ_ONLY' });

    const access = await getAppMemoryAccess(db, app.id);

    expect(access.size).toBe(2);
    expect(access.get(systemMemoryId)).toBe('READ_ONLY');
    expect(access.get(knowledgeMemoryId)).toBe('READ_ONLY');
  });

  it('grants READ_WRITE on the system memory when AppAgent.subscriptionType=READ_WRITE', async () => {
    const { app } = await createDbAppWithKey(db, 'app-rw', orgId);
    await createDbAppAgent(db, app.id, agentId, { subscriptionType: 'READ_WRITE' });

    const access = await getAppMemoryAccess(db, app.id);

    expect(access.get(systemMemoryId)).toBe('READ_WRITE');
    // The knowledge memory's agentMemoryItem role defaults to 'read', so even
    // with READ_WRITE subscription it stays READ_ONLY.
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
    await createDbAppAgent(db, app.id, localAgentId, { subscriptionType: 'READ_WRITE' });

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
// getStationMemoryAccess (legacy path — kept as fallback through Phase 4)
// ---------------------------------------------------------------------------

describe('getStationMemoryAccess (Station-key principal, legacy fallback)', () => {
  it('still resolves the same access map for Station-keyed callers', async () => {
    const station = await createDbStation(db, 'st-1', 'READER', { organizationId: orgId });
    await db.stationAgentSubscription.create({
      data: {
        id: generateId(),
        stationId: station.id,
        agentId,
        subscriptionType: 'READ_ONLY',
      },
    });

    const access = await getStationMemoryAccess(db, station.id);

    expect(access.size).toBe(2);
    expect(access.get(systemMemoryId)).toBe('READ_ONLY');
    expect(access.get(knowledgeMemoryId)).toBe('READ_ONLY');
  });
});

// ---------------------------------------------------------------------------
// getMemoryAccess — dispatches based on principal kind (T018)
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

  it('dispatches to the Station path when only auth.clientId is set', async () => {
    const station = await createDbStation(db, 'st-d', 'READER', { organizationId: orgId });
    await db.stationAgentSubscription.create({
      data: { id: generateId(), stationId: station.id, agentId, subscriptionType: 'READ_ONLY' },
    });

    const auth: AuthContext = { clientId: station.id, organizationId: orgId };
    const access = await getMemoryAccess(db, auth);

    expect(access.size).toBe(2);
  });

  it('prefers the App path when both appId and clientId are set (App wins)', async () => {
    const { app } = await createDbAppWithKey(db, 'app-prefer', orgId);
    await createDbAppAgent(db, app.id, agentId);
    const station = await createDbStation(db, 'st-prefer', 'READER', { organizationId: orgId });
    // Station has NO subscriptions — if the dispatcher fell through to Station,
    // we'd get an empty map.

    const auth: AuthContext = {
      appId: app.id,
      clientId: station.id,
      organizationId: orgId,
    };
    const access = await getMemoryAccess(db, auth);

    expect(access.size).toBe(2);
  });

  it('returns empty when neither appId nor clientId is set', async () => {
    const auth: AuthContext = {};
    const access = await getMemoryAccess(db, auth);
    expect(access.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// canWriteToMemory — write-permission gate
// ---------------------------------------------------------------------------

describe('canWriteToMemory', () => {
  it('returns true for an App with READ_WRITE subscription on the system memory', async () => {
    const { app } = await createDbAppWithKey(db, 'app-w', orgId);
    await createDbAppAgent(db, app.id, agentId, { subscriptionType: 'READ_WRITE' });

    const auth: AuthContext = { appId: app.id, organizationId: orgId };

    expect(await canWriteToMemory(db, auth, systemMemoryId)).toBe(true);
  });

  it('returns false for an App with READ_ONLY subscription', async () => {
    const { app } = await createDbAppWithKey(db, 'app-ro', orgId);
    await createDbAppAgent(db, app.id, agentId, { subscriptionType: 'READ_ONLY' });

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
    await createDbAppAgent(db, app.id, agentId, { subscriptionType: 'READ_WRITE' });

    const otherMem = await db.memory.create({
      data: { id: generateId(), name: 'unrelated', urn: `${orgId}:unrelated`, organizationId: orgId },
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
