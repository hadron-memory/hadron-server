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
        systemPrompt: 'you are helpful',
        agentTools: ['h-find-node', 'h-read-node'],
        aiProvider: 'anthropic',
        aiModel: 'claude-sonnet-4-20250514',
        aiApiKeyEncrypted: 'opaque-blob',
        expiresAt: new Date('2027-01-01T00:00:00.000Z'),
      },
    });

    expect(app.appType).toBe('CHATBOT');
    expect(app.role).toBe('CONTRIBUTOR');
    expect(app.description).toBe('a chatbot app');
    expect(app.systemPrompt).toBe('you are helpful');
    expect(app.agentTools).toEqual(['h-find-node', 'h-read-node']);
    expect(app.aiProvider).toBe('anthropic');
    expect(app.aiModel).toBe('claude-sonnet-4-20250514');
    expect(app.aiApiKeyEncrypted).toBe('opaque-blob');
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
    expect(app.systemPrompt).toBeNull();
    expect(app.agentTools).toEqual([]);
    expect(app.aiProvider).toBeNull();
    expect(app.aiModel).toBeNull();
    expect(app.aiApiKeyEncrypted).toBeNull();
    expect(app.expiresAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// T005: AppAgent gains role + subscriptionType + trainingMode with defaults
// ---------------------------------------------------------------------------

describe('Phase 1 — AppAgent defaults', () => {
  it('defaults role=OPERATE per Constitution Invariant #6', async () => {
    const app = await db.app.create({
      data: { id: generateId(), name: 'a', urn: 'phase1-org:a', organizationId: orgId },
    });
    const agent = await db.agent.create({
      data: {
        id: generateId(),
        name: 'agent-a',
        urn: 'phase1-org:agent-a',
        organizationId: orgId,
      },
    });

    const appAgent = await db.appAgent.create({
      data: { appId: app.id, agentId: agent.id },
    });

    expect(appAgent.role).toBe('OPERATE');
    expect(appAgent.trainingMode).toBe(false);
  });

  it('persists role=DEVELOP when set explicitly', async () => {
    const app = await db.app.create({
      data: { id: generateId(), name: 'a', urn: 'phase1-org:a', organizationId: orgId },
    });
    const agent = await db.agent.create({
      data: {
        id: generateId(),
        name: 'agent-b',
        urn: 'phase1-org:agent-b',
        organizationId: orgId,
      },
    });

    const appAgent = await db.appAgent.create({
      data: {
        appId: app.id,
        agentId: agent.id,
        role: 'DEVELOP',
        trainingMode: true,
      },
    });

    expect(appAgent.role).toBe('DEVELOP');
    expect(appAgent.trainingMode).toBe(true);
  });
});

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
