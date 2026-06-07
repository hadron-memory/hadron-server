/**
 * Foundational schema validation for spec 005-agent-subscription.
 *
 * Verifies that the new entities + enum values + the bidirectional
 * CHECK constraint are in place after the migration. Companion to
 * `agent-subscription-backfill.test.ts` (which exercises the migration's
 * backfill rules against pre-spec data).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb, createDbAgentSubscription, createDbPersonalMemory } from '../helpers.js';
import { generateId } from '../../lib/id.js';

beforeEach(async () => {
  await cleanDb(db);
});

describe('AgentSubscription model + MemoryClass enum + PERSONAL visibility', () => {
  it('AgentSubscription is creatable with the composite primary key', async () => {
    const org = await db.organization.create({
      data: { id: generateId(), name: 'sv-org', urn: 'sv-org' },
    });
    const user = await db.user.create({ data: { id: generateId(), githubId: 9001 } });
    const agent = await db.agent.create({
      data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:a`, name: 'a' },
    });

    const sub = await createDbAgentSubscription(db, user.id, agent.id);

    expect(sub.userId).toBe(user.id);
    expect(sub.agentId).toBe(agent.id);
    expect(sub.activatedAt).not.toBeNull();
    expect(sub.revokedAt).toBeNull();
    expect(sub.expiresAt).toBeNull();
  });

  it('AgentSubscription rejects duplicate (userId, agentId) pair (composite PK)', async () => {
    const org = await db.organization.create({
      data: { id: generateId(), name: 'sv-org-dup', urn: 'sv-org-dup' },
    });
    const user = await db.user.create({ data: { id: generateId(), githubId: 9002 } });
    const agent = await db.agent.create({
      data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:a`, name: 'a' },
    });

    await createDbAgentSubscription(db, user.id, agent.id);
    await expect(createDbAgentSubscription(db, user.id, agent.id)).rejects.toThrow();
  });

  it('Memory.class enum accepts all four values', async () => {
    const org = await db.organization.create({
      data: { id: generateId(), name: 'mc-org', urn: 'mc-org' },
    });
    const user = await db.user.create({ data: { id: generateId(), githubId: 9003 } });
    const agent = await db.agent.create({
      data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:a`, name: 'a' },
    });
    // 008-agent-installation: app- and personal-class memories require app_id
    // (chk_memory_class_app_id). Seed an App linked to the agent so the
    // helper can resolve it for the personal memory below, and use the same
    // App.id explicitly for the app-class memory.
    const app = await db.app.create({
      data: {
        id: generateId(),
        name: 'mc-app',
        urn: `${org.urn}:mc-app`,
        organizationId: org.id,
        appAgents: { create: { agentId: agent.id } },
      },
    });

    // 'system' / 'app' / 'knowledge' / 'personal' all parse and round-trip.
    const memSystem = await db.memory.create({
      data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:s`, name: 's', class: 'system' },
    });
    const memApp = await db.memory.create({
      data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:p`, name: 'p', class: 'app', appId: app.id },
    });
    const memKnowledge = await db.memory.create({
      data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:k`, name: 'k', class: 'knowledge' },
    });
    const memPersonal = await createDbPersonalMemory(db, {
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
    });

    expect(memSystem.class).toBe('system');
    expect(memApp.class).toBe('app');
    expect(memKnowledge.class).toBe('knowledge');
    expect(memPersonal.class).toBe('personal');
    expect(memPersonal.visibility).toBeNull();
    expect(memPersonal.userId).toBe(user.id);
  });
});

describe('CHECK constraint: PERSONAL ⇔ userId IS NOT NULL', () => {
  it('rejects a PERSONAL memory without a userId', async () => {
    const org = await db.organization.create({
      data: { id: generateId(), name: 'check-org-1', urn: 'check-org-1' },
    });
    await expect(
      db.memory.create({
        data: {
          id: generateId(),
          organizationId: org.id,
          urn: `${org.urn}:bad-personal`,
          name: 'bad',
          class: 'personal',
          visibility: null,
          // userId intentionally omitted
        },
      }),
    ).rejects.toThrow();
  });

  it('rejects a non-PERSONAL memory with a userId set', async () => {
    const org = await db.organization.create({
      data: { id: generateId(), name: 'check-org-2', urn: 'check-org-2' },
    });
    const user = await db.user.create({ data: { id: generateId(), githubId: 9004 } });
    await expect(
      db.memory.create({
        data: {
          id: generateId(),
          organizationId: org.id,
          urn: `${org.urn}:bad-private`,
          name: 'bad-private',
          class: 'knowledge',
          visibility: 'ORGANIZATION',
          userId: user.id,
        },
      }),
    ).rejects.toThrow();
  });

  it('accepts a PERSONAL memory with a userId set', async () => {
    const org = await db.organization.create({
      data: { id: generateId(), name: 'check-org-3', urn: 'check-org-3' },
    });
    const user = await db.user.create({ data: { id: generateId(), githubId: 9005 } });
    const agent = await db.agent.create({
      data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:a`, name: 'a' },
    });
    // 008: personal memory requires app_id; seed a matching App so the helper
    // can resolve it.
    await db.app.create({
      data: {
        id: generateId(),
        name: 'check-app',
        urn: `${org.urn}:check-app`,
        organizationId: org.id,
        appAgents: { create: { agentId: agent.id } },
      },
    });
    const mem = await createDbPersonalMemory(db, {
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
    });
    expect(mem.visibility).toBeNull();
    expect(mem.userId).toBe(user.id);
  });

  it('accepts a non-PERSONAL memory without a userId (default case)', async () => {
    const org = await db.organization.create({
      data: { id: generateId(), name: 'check-org-4', urn: 'check-org-4' },
    });
    const mem = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        urn: `${org.urn}:default`,
        name: 'default',
        class: 'knowledge',
      },
    });
    expect(mem.visibility).toBeNull();
    expect(mem.userId).toBeNull();
  });
});
