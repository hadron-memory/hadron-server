/**
 * Regression: production showed empty organization lists (then `myOrganizations`,
 * now the uniform `organizations` #473) after the
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
import { parseUrn } from '../../../lib/urn.js';

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
        visibility: 'ORGANIZATION',
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
    const orgs = (await resolvers.Query.organizations({}, {}, ctx(user.id))).items;
    expect(orgs).toHaveLength(1);
    const apps = (orgs[0] as { apps: unknown[] }).apps;
    expect(apps).toHaveLength(1);

    // 023-app-shape: App.agent is no longer a Prisma scalar relation — it
    // resolves via the AppAgent join through the App.agent resolver. Call
    // the resolver to bridge from the eager Prisma payload to the GraphQL
    // shape. The original regression (Agent.memoryItems non-null contract
    // when the agent is soft-deleted) is still what we're guarding here.
    const linkedAgent = (await resolvers.App.agent(
      apps[0] as { id: string; appAgents?: unknown },
      {},
      ctx(user.id),
    )) as { id: string; memoryItems: unknown[] } | null;
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
        visibility: 'ORGANIZATION',
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

    const orgs = (await resolvers.Query.organizations({}, {}, ctx(user.id))).items;
    const apps = (orgs[0] as { apps: unknown[] }).apps;
    // 023-app-shape: invoke the App.agent resolver — see explanation in
    // the soft-deleted-agent test above.
    const linkedAgent = (await resolvers.App.agent(
      apps[0] as { id: string; appAgents?: unknown },
      {},
      ctx(user.id),
    )) as { id: string; memoryItems: unknown[] };
    expect(linkedAgent.id).toBe(agent.id);
    expect(linkedAgent.memoryItems).toHaveLength(1);
  });
});

// 298 follow-up regression: a corrupted/legacy stored URN must not throw inside
// the non-nullable `urn` field resolver — that error nulls out the whole
// parent list and 500s every memory-listing page (`/app/orgs`). The resolver
// must fall back to the raw stored value. Reproduces the
// `hadronmemory.com:memory:hadronmemory.com::experiments` shape a pre-fix
// updateMemory persisted.
describe('urn field resolvers — corrupted URN falls back to raw, never throws', () => {
  const corrupted = 'hadronmemory.com:memory:hadronmemory.com::experiments';

  it('Memory.urn returns the raw value instead of throwing on a malformed URN', () => {
    expect(() => resolvers.Memory.urn({ urn: corrupted })).not.toThrow();
    expect(resolvers.Memory.urn({ urn: corrupted })).toBe(corrupted);
  });

  it('Memory.urn still canonicalizes a valid legacy single-colon URN', () => {
    expect(resolvers.Memory.urn({ urn: 'acme.com:dev' })).toBe('hrn:memory:acme.com::dev');
  });

  it('Agent / App / Organization urn resolvers also fall back instead of throwing', () => {
    expect(resolvers.Agent.urn({ urn: corrupted })).toBe(corrupted);
    expect(resolvers.App.urn({ urn: corrupted })).toBe(corrupted);
    expect(resolvers.Organization.urn({ urn: corrupted })).toBe(corrupted);
  });
});

// #352 regression: the per-user (`:user:`) and anonymous (`:anon:`) runtime
// memory markers used to bypass the canonical role-marker set, so `Memory.urn`
// served non-canonical values (`user` threw → raw single-colon fallback;
// `anon` had its marker:id boundary severed to `…::anon::id`). Storage is now
// aligned to `app-user`, and `anon` is a first-class marker. Assert
// `Memory.urn` is canonical AND round-trips through strict `parseUrn` for every
// stored shape — the coverage PR #318 omitted.
describe('Memory.urn — canonical + parseUrn round-trip for every stored shape (#352)', () => {
  const STORED: ReadonlyArray<readonly [string, string]> = [
    ['hadronmemory.com:specs', 'hrn:memory:hadronmemory.com::specs'],
    ['micromentor.org:coding-agent:system', 'hrn:memory:micromentor.org::coding-agent::system'],
    // Per-user, post storage-alignment (was the non-canonical `:user:`).
    ['micromentor.org:coding-agent:app-user:abc123', 'hrn:memory:micromentor.org::coding-agent::app-user:abc123'],
    ['micromentor.org:coding-agent:priv:abc123', 'hrn:memory:micromentor.org::coding-agent::priv:abc123'],
    // Anonymous session — boundary preserved now that `anon` is a marker.
    ['micromentor.org:coding-agent:anon:abc123', 'hrn:memory:micromentor.org::coding-agent::anon:abc123'],
  ];

  for (const [stored, expected] of STORED) {
    it(`serves canonical + round-trips: ${stored}`, () => {
      const served = resolvers.Memory.urn({ urn: stored });
      expect(served).toBe(expected);
      expect(() => parseUrn(served)).not.toThrow();
    });
  }
});
