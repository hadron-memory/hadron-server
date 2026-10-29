/**
 * Phase 1 schema-absorption tests for the Station -> App migration
 * (spec-kits/specs/003-station-to-app, US1, T004-T006).
 *
 * Verifies that:
 *   - The new App fields (absorbed from Station, minus the three dropped
 *     during US1 design review: keyHash, apiKeyShown, lastUsedAt) accept
 *     values and round-trip cleanly through Prisma.
 *   - AppAgent defaults match Constitution Invariant #6 (role=OPERATE)
 *     and the StationAgentSubscription carry-over (subscriptionType=READ_ONLY,
 *     trainingMode=false).
 *   - AppLogEntry can be created and links to its App via the FK.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from './client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let orgId: string;

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({
    data: { id: generateId(), name: 'phase1-org', urn: 'phase1-org' },
  });
  orgId = org.id;
});

// ---------------------------------------------------------------------------
// T004: App accepts every absorbed Station field
// ---------------------------------------------------------------------------

describe('Phase 1 — App schema absorbs Station fields', () => {
  it('accepts the absorbed Station fields with explicit values', async () => {
    const app = await db.app.create({
      data: {
        id: generateId(),
        name: 'absorbed-app',
        urn: 'phase1-org:absorbed-app',
        organizationId: orgId,
        appType: 'CHATBOT',
        role: 'CONTRIBUTOR',
        description: 'a chatbot app',
        agentTools: ['hadron_find_nodes', 'hadron_get_node'],
        // 036-ai-service-config: AI settings live in AiServiceConfig rows
        // now (the legacy ai_* columns were dropped).
        aiServiceConfigs: {
          create: {
            name: 'default',
            provider: 'anthropic',
            model: 'claude-sonnet-4-20250514',
            apiKeyEncrypted: 'opaque-blob',
          },
        },
        expiresAt: new Date('2027-01-01T00:00:00.000Z'),
      },
      include: { aiServiceConfigs: true },
    });

    expect(app.appType).toBe('CHATBOT');
    expect(app.role).toBe('CONTRIBUTOR');
    expect(app.description).toBe('a chatbot app');
    expect(app.agentTools).toEqual(['hadron_find_nodes', 'hadron_get_node']);
    expect(app.aiServiceConfigs[0]?.provider).toBe('anthropic');
    expect(app.aiServiceConfigs[0]?.model).toBe('claude-sonnet-4-20250514');
    expect(app.aiServiceConfigs[0]?.apiKeyEncrypted).toBe('opaque-blob');
    expect(app.expiresAt?.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('uses the documented defaults when absorbed fields are omitted', async () => {
    const app = await db.app.create({
      data: {
        id: generateId(),
        name: 'default-app',
        urn: 'phase1-org:default-app',
        organizationId: orgId,
      },
    });

    expect(app.appType).toBe('WORKSTATION');
    expect(app.role).toBe('READER');
    expect(app.description).toBeNull();
    expect(app.agentTools).toEqual([]);
    expect(
      await db.aiServiceConfig.findFirst({ where: { appId: app.id } }),
    ).toBeNull();
    expect(app.expiresAt).toBeNull();
  });
});

// 008-agent-installation: the AppAgent entity is dropped (FR-007). The
// pre-008 "AppAgent defaults" tests (T005 from spec 003) targeted a join
// table that no longer exists; the App→Agent direct FK (App.agent_id) is
// covered by the addAgentToApp resolver tests in resolvers.appSurface.test.ts.

// ---------------------------------------------------------------------------
// T006: AppLogEntry exists, links to its App, cascades on App delete
// ---------------------------------------------------------------------------

describe('Phase 1 — AppLogEntry', () => {
  it('creates a log entry linked to its App', async () => {
    const app = await db.app.create({
      data: { id: generateId(), name: 'a', urn: 'phase1-org:a', organizationId: orgId },
    });

    const entry = await db.appLogEntry.create({
      data: {
        id: generateId(),
        appId: app.id,
        level: 'INFO',
        message: 'phase 1 log smoke',
        detail: { phase: 1, source: 'app-schema-phase1.test.ts' },
      },
    });

    expect(entry.appId).toBe(app.id);
    expect(entry.level).toBe('INFO');
    expect(entry.message).toBe('phase 1 log smoke');
    expect(entry.detail).toEqual({ phase: 1, source: 'app-schema-phase1.test.ts' });
  });

  it('cascade-deletes log entries when the parent App is deleted', async () => {
    const app = await db.app.create({
      data: { id: generateId(), name: 'a', urn: 'phase1-org:a', organizationId: orgId },
    });
    await db.appLogEntry.create({
      data: { id: generateId(), appId: app.id, level: 'WARN', message: 'before delete' },
    });
    expect(await db.appLogEntry.count({ where: { appId: app.id } })).toBe(1);

    await db.app.delete({ where: { id: app.id } });

    expect(await db.appLogEntry.count({ where: { appId: app.id } })).toBe(0);
  });
});
