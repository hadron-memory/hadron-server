/**
 * US2 verification (per spec 005-agent-subscription / SC-005):
 * AppAgent.subscription_type was dropped; the cap previously enforced
 * by it is now exclusively governed by AgentMemoryItem.role. This
 * test confirms parity — the same set of (App, Agent, Memory, op)
 * attempts that were valid before the drop remain valid after.
 *
 * Approach: replay a fixture matrix of role × per-attached-memory-role
 * combinations and assert each effective access matches the expected
 * post-spec semantics.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb, createDbAppWithKey, createDbAppAgent, createDbAppMember } from '../helpers.js';
import { generateId } from '../../lib/id.js';
import type { AuthContext } from '../../middleware/auth.js';
import { canWriteToMemory } from '../../mcp/access-control.js';

beforeEach(async () => {
  await cleanDb(db);
});

describe('AppAgent post-subscription_type-drop parity (SC-005)', () => {
  it('AgentMemoryItem.role=read-write allows writes regardless of AppAgent.role', async () => {
    const org = await db.organization.create({
      data: { id: generateId(), name: 'pd-org-1', urn: 'pd-org-1' },
    });
    const memory = await db.memory.create({
      data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:m`, name: 'm', class: 'knowledge' },
    });
    const agent = await db.agent.create({
      data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:a`, name: 'a' },
    });
    await db.agentMemoryItem.create({
      data: { agentId: agent.id, memoryId: memory.id, role: 'read-write' },
    });

    // Both roles can write — AppAgent.role doesn't cap per-attached-memory writes
    for (const role of ['OPERATE', 'DEVELOP'] as const) {
      const { app } = await createDbAppWithKey(db, `pd-app-${role}`, org.id);
      await createDbAppAgent(db, app.id, agent.id, { role });
      // #1376: the item caps a write for a request with a user behind it; a bare App key never writes through it.
      const ctx: AuthContext = { appId: app.id, organizationId: org.id };
      expect(await canWriteToMemory(db, ctx, memory.id)).toBe(false);
      const user = await db.user.create({ data: { id: generateId(), handle: `pd-${generateId()}`, githubUsername: `pd-${generateId()}` } });
      await createDbAppMember(db, app.id, user.id, 'member');
      expect(await canWriteToMemory(db, { ...ctx, userId: user.id }, memory.id)).toBe(true);
    }
  });

  it('AgentMemoryItem.role=read denies writes regardless of AppAgent.role', async () => {
    const org = await db.organization.create({
      data: { id: generateId(), name: 'pd-org-2', urn: 'pd-org-2' },
    });
    const memory = await db.memory.create({
      data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:m`, name: 'm', class: 'knowledge' },
    });
    const agent = await db.agent.create({
      data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:a`, name: 'a' },
    });
    await db.agentMemoryItem.create({
      data: { agentId: agent.id, memoryId: memory.id, role: 'read' },
    });

    for (const role of ['OPERATE', 'DEVELOP'] as const) {
      const { app } = await createDbAppWithKey(db, `pd-app-${role}`, org.id);
      await createDbAppAgent(db, app.id, agent.id, { role });
      const ctx: AuthContext = { appId: app.id, organizationId: org.id };
      expect(await canWriteToMemory(db, ctx, memory.id)).toBe(false);
    }
  });

  it('system memory is universally read-only from any App context (008)', async () => {
    // 008-agent-installation: DEVELOP-from-App is dropped (R-10). System
    // memory writes happen in the Agent ownership surface, never through
    // an App. The legacy `role` arg is accepted for source compat but is
    // a no-op — both legacy roles deny writes to system memory.
    const org = await db.organization.create({
      data: { id: generateId(), name: 'pd-org-3', urn: 'pd-org-3' },
    });
    const sysMemory = await db.memory.create({
      data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:sys`, name: 'sys', class: 'system' },
    });
    const agent = await db.agent.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        urn: `${org.urn}:a`,
        name: 'a',
        systemMemoryId: sysMemory.id,
      },
    });

    const { app: opApp } = await createDbAppWithKey(db, 'pd-op-app', org.id);
    await createDbAppAgent(db, opApp.id, agent.id, { role: 'OPERATE' });
    const opCtx: AuthContext = { appId: opApp.id, organizationId: org.id };
    expect(await canWriteToMemory(db, opCtx, sysMemory.id)).toBe(false);

    const { app: devApp } = await createDbAppWithKey(db, 'pd-dev-app', org.id);
    await createDbAppAgent(db, devApp.id, agent.id, { role: 'DEVELOP' });
    const devCtx: AuthContext = { appId: devApp.id, organizationId: org.id };
    expect(await canWriteToMemory(db, devCtx, sysMemory.id)).toBe(false);
  });
});
