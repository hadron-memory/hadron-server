/**
 * Regression: production showed empty `myOrganizations` after the
 * 008-agent-installation portal flip went out. Root cause:
 *
 * - The portal's new APP_FIELDS fragment selects
 *   `apps { agent { memoryItems { ... } } }`.
 * - Schema declares `Agent.memoryItems: [AgentMemoryItem!]!`.
 * - `ORG_INCLUDE.apps.agent` was eagerly loaded as `agent: true` —
 *   no `memoryItems` include — so when the linked Agent had been
 *   soft-deleted (Apps keep their FK after agent soft-delete), the
 *   field resolved to undefined, GraphQL raised "Cannot return null
 *   for non-nullable field Agent.memoryItems", graphql-request threw,
 *   and the portal's silent `.catch(() => ({ myOrganizations: [] }))`
 *   rendered the page empty with no console error.
 *
 * Fix: deeply include AGENT_INCLUDE on App.agent in ORG_INCLUDE.
 * This test fails on the pre-fix resolver (errors with the non-null
 * violation) and passes after.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

let org: { id: string; urn: string };
let user: { id: string };

function ctx(userId: string, overrides: Partial<Context> = {}): Context {
  return { db, userId, roles: ['OWNER'], ...overrides };
}

beforeEach(async () => {
  await cleanDb(db);
  const orgRow = await db.organization.create({
    data: { id: generateId(), name: 'Acme', urn: 'acme' },
  });
  org = { id: orgRow.id, urn: orgRow.urn };

  user = await db.user.create({
    data: { id: generateId(), handle: 'holger', githubId: 9000, name: 'Holger' },
  });

  await db.orgMember.create({
    data: { id: generateId(), organizationId: org.id, userId: user.id, role: 'OWNER' },
  });
});

describe('myOrganizations — Apps with soft-deleted Agent (regression)', () => {
  it('returns the org + apps + the app.agent payload (with memoryItems list) when the linked Agent is soft-deleted', async () => {
    // Step 1: create an Agent + memory + memory-item association.
    const memory = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        urn: `${org.urn}:notes`,
        name: 'notes',
        visibility: 'PRIVATE',
        class: 'knowledge',
      },
    });
    const agent = await db.agent.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        urn: `${org.urn}:my-agent`,
        name: 'My Agent',
      },
    });
    await db.agentMemoryItem.create({
      data: {
        id: generateId(),
        agentId: agent.id,
        memoryId: memory.id,
        role: 'read-write',
      },
    });

    // Step 2: create an App that links to the agent.
    await db.app.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        appAgents: { create: { agentId: agent.id } },
        name: 'My App',
        urn: `${org.urn}:my-app`,
        appType: 'WORKSTATION',
        role: 'OWNER',
      },
    });

    // Step 3: soft-delete the Agent. App.agent_id stays set (FR-024:
    // App keeps its agent reference for audit/UX purposes).
    await db.agent.update({
      where: { id: agent.id },
      data: { deletedAt: new Date() },
    });

    // Step 4: call the resolver and walk the path the portal traverses.
    const orgs = await resolvers.Query.myOrganizations({}, {}, ctx(user.id));
    expect(orgs).toHaveLength(1);
    const apps = (orgs[0] as { apps: unknown[] }).apps;
    expect(apps).toHaveLength(1);

    // The App's agent field is still resolvable (singular form does not
    // filter deletedAt — it's an audit/historical reference). The eager
    // include must populate memoryItems so the GraphQL non-null contract
    // on Agent.memoryItems is satisfied.
    const linkedAgent = (apps[0] as { agent: unknown }).agent as
      | { id: string; memoryItems: unknown[] }
      | null;
    expect(linkedAgent).not.toBeNull();
    expect(linkedAgent!.id).toBe(agent.id);
    expect(Array.isArray(linkedAgent!.memoryItems)).toBe(true);
    // The memoryItem persists; the deletedAt filter on memoryItems
    // (`memoryItems.where: { deletedAt: null, memory.deletedAt: null }`)
    // doesn't drop rows when only the parent Agent is soft-deleted.
    expect(linkedAgent!.memoryItems).toHaveLength(1);
  });

  it('also returns memoryItems for an App whose Agent is alive — the eager include is the same code path', async () => {
    const memory = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        urn: `${org.urn}:notes2`,
        name: 'notes2',
        visibility: 'PRIVATE',
        class: 'knowledge',
      },
    });
    const agent = await db.agent.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        urn: `${org.urn}:live-agent`,
        name: 'Live Agent',
      },
    });
    await db.agentMemoryItem.create({
      data: {
        id: generateId(),
        agentId: agent.id,
        memoryId: memory.id,
        role: 'read-write',
      },
    });
    await db.app.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        appAgents: { create: { agentId: agent.id } },
        name: 'Live App',
        urn: `${org.urn}:live-app`,
        appType: 'WORKSTATION',
        role: 'OWNER',
      },
    });

    const orgs = await resolvers.Query.myOrganizations({}, {}, ctx(user.id));
    const apps = (orgs[0] as { apps: unknown[] }).apps;
    const linkedAgent = (apps[0] as { agent: unknown }).agent as {
      id: string;
      memoryItems: unknown[];
    };
    expect(linkedAgent.id).toBe(agent.id);
    expect(linkedAgent.memoryItems).toHaveLength(1);
  });
});
