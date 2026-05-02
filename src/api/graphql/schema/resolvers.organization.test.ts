/**
 * Integration tests for Organization-keyed GraphQL ops (007-entity-id-or-urn).
 *
 * Pre-007 coverage of these resolvers was thin (one each for
 * Query.organization in resolvers.memoryType.test.ts /
 * resolvers.multiUserAgent.test.ts). This file lands fresh URN-input
 * coverage for the chunk-1 ops widened in spec 007:
 *   - Query.organization(id)
 *   - Query.orgSystemMemories(orgId)
 *   - Query.apps(orgId)
 *   - Query.exchangeConnections(orgId)
 *   - Mutation.updateOrganization(id)
 *   - Mutation.deleteOrganization(id)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

let org: { id: string; urn: string };
let admin: { id: string };

function adminCtx(): Context {
  return { db, userId: admin.id, roles: ['ADMIN'] };
}

beforeEach(async () => {
  await cleanDb(db);

  org = await db.organization.create({
    data: {
      id: generateId(),
      name: 'org-sweep-test',
      urn: `org-sweep-test-${Date.now()}`,
    },
  });

  admin = await db.user.create({
    data: { id: generateId(), githubId: 9801, githubUsername: 'org-sweep-admin', roles: ['ADMIN'] },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' },
  });
});

describe('Query.organization (007-entity-id-or-urn)', () => {
  it('accepts an ID', async () => {
    const result = await resolvers.Query.organization({}, { id: org.id }, adminCtx());
    expect(result?.id).toBe(org.id);
  });

  it('accepts a URN', async () => {
    const result = await resolvers.Query.organization({}, { id: org.urn }, adminCtx());
    expect(result?.id).toBe(org.id);
  });

  it('accepts a prefixed URN (urn:org:...)', async () => {
    const result = await resolvers.Query.organization(
      {},
      { id: `urn:org:${org.urn}` },
      adminCtx(),
    );
    expect(result?.id).toBe(org.id);
  });
});

describe('Query.orgSystemMemories (007-entity-id-or-urn)', () => {
  beforeEach(async () => {
    await db.memory.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        urn: `${org.urn}:juno-system`,
        name: 'juno-system',
        class: 'knowledge',
        type: 'AGENT_SYSTEM',
      },
    });
  });

  it('accepts an ID', async () => {
    const mems = await resolvers.Query.orgSystemMemories({}, { orgId: org.id }, adminCtx());
    expect(mems).toHaveLength(1);
  });

  it('accepts a URN', async () => {
    const mems = await resolvers.Query.orgSystemMemories({}, { orgId: org.urn }, adminCtx());
    expect(mems).toHaveLength(1);
  });
});

describe('Query.apps (007-entity-id-or-urn)', () => {
  beforeEach(async () => {
    await db.app.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        urn: `${org.urn}:my-app`,
        name: 'My App',
      },
    });
  });

  it('accepts an ID', async () => {
    const apps = await resolvers.Query.apps({}, { orgId: org.id }, adminCtx());
    expect(apps).toHaveLength(1);
  });

  it('accepts a URN', async () => {
    const apps = await resolvers.Query.apps({}, { orgId: org.urn }, adminCtx());
    expect(apps).toHaveLength(1);
  });
});

describe('Query.exchangeConnections (007-entity-id-or-urn)', () => {
  it('accepts an ID', async () => {
    const conns = await resolvers.Query.exchangeConnections({}, { orgId: org.id }, adminCtx());
    expect(Array.isArray(conns)).toBe(true);
  });

  it('accepts a URN', async () => {
    const conns = await resolvers.Query.exchangeConnections({}, { orgId: org.urn }, adminCtx());
    expect(Array.isArray(conns)).toBe(true);
  });
});

describe('Mutation.updateOrganization (007-entity-id-or-urn)', () => {
  it('accepts an ID', async () => {
    const updated = await resolvers.Mutation.updateOrganization(
      {},
      { id: org.id, name: 'renamed-by-id' },
      adminCtx(),
    );
    expect(updated.name).toBe('renamed-by-id');
  });

  it('accepts a URN', async () => {
    const updated = await resolvers.Mutation.updateOrganization(
      {},
      { id: org.urn, name: 'renamed-by-urn' },
      adminCtx(),
    );
    expect(updated.id).toBe(org.id);
    expect(updated.name).toBe('renamed-by-urn');
  });
});

describe('Mutation.deleteOrganization (007-entity-id-or-urn)', () => {
  it('accepts a URN', async () => {
    const ok = await resolvers.Mutation.deleteOrganization({}, { id: org.urn }, adminCtx());
    expect(ok).toBe(true);
    const after = await db.organization.findUnique({ where: { id: org.id } });
    expect(after?.deletedAt).not.toBeNull();
  });
});
