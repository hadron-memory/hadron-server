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
        class: 'system',
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

describe('Mutation.updateOrganization — URN rename propagation (#337)', () => {
  const newUrn = 'holger-pers-renamed';

  it('rewrites the org-slug prefix on every owned Memory/Agent/App urn', async () => {
    const oldUrn = org.urn;
    const mem = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        urn: `${oldUrn}::gear`,
        name: 'gear',
        class: 'knowledge',
      },
    });
    const agent = await db.agent.create({
      data: { id: generateId(), organizationId: org.id, urn: `${oldUrn}::juno`, name: 'juno' },
    });
    const app = await db.app.create({
      data: { id: generateId(), organizationId: org.id, urn: `${oldUrn}::ops`, name: 'ops' },
    });

    const updated = await resolvers.Mutation.updateOrganization(
      {},
      { id: org.id, urn: newUrn },
      adminCtx(),
    );
    expect(updated.urn).toBe(newUrn);

    expect((await db.memory.findUnique({ where: { id: mem.id } }))?.urn).toBe(`${newUrn}::gear`);
    expect((await db.agent.findUnique({ where: { id: agent.id } }))?.urn).toBe(`${newUrn}::juno`);
    expect((await db.app.findUnique({ where: { id: app.id } }))?.urn).toBe(`${newUrn}::ops`);
  });

  it('rewrites legacy single-colon child URNs too (<org>:<slug>)', async () => {
    // Pre-021 rows store the single-colon form; the rewrite must catch both.
    const oldUrn = org.urn;
    const mem = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        urn: `${oldUrn}:gear`, // single colon
        name: 'gear',
        class: 'knowledge',
      },
    });
    const agent = await db.agent.create({
      data: { id: generateId(), organizationId: org.id, urn: `${oldUrn}:juno`, name: 'juno' },
    });

    await resolvers.Mutation.updateOrganization({}, { id: org.id, urn: newUrn }, adminCtx());

    expect((await db.memory.findUnique({ where: { id: mem.id } }))?.urn).toBe(`${newUrn}:gear`);
    expect((await db.agent.findUnique({ where: { id: agent.id } }))?.urn).toBe(`${newUrn}:juno`);
  });

  it('does not touch children of OTHER orgs', async () => {
    const other = await db.organization.create({
      data: { id: generateId(), name: 'other', urn: `other-org-${Date.now()}` },
    });
    const otherMem = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: other.id,
        urn: `${other.urn}::keep`,
        name: 'keep',
        class: 'knowledge',
      },
    });

    await resolvers.Mutation.updateOrganization({}, { id: org.id, urn: newUrn }, adminCtx());

    expect((await db.memory.findUnique({ where: { id: otherMem.id } }))?.urn).toBe(`${other.urn}::keep`);
  });

  it('a name-only update leaves child urns untouched (no rename path)', async () => {
    const mem = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        urn: `${org.urn}::gear`,
        name: 'gear',
        class: 'knowledge',
      },
    });
    await resolvers.Mutation.updateOrganization({}, { id: org.id, name: 'just-a-name' }, adminCtx());
    expect((await db.memory.findUnique({ where: { id: mem.id } }))?.urn).toBe(`${org.urn}::gear`);
  });

  it('renaming the org URN to its current value is a no-op for children', async () => {
    const mem = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        urn: `${org.urn}::gear`,
        name: 'gear',
        class: 'knowledge',
      },
    });
    await resolvers.Mutation.updateOrganization({}, { id: org.id, urn: org.urn }, adminCtx());
    expect((await db.memory.findUnique({ where: { id: mem.id } }))?.urn).toBe(`${org.urn}::gear`);
  });
});

describe('Mutation.updateOrganization — rejects a malformed org URN (#376)', () => {
  // The portal pre-filled its edit form from the canonical `Organization.urn`
  // (`hrn:org:<slug>`) and resubmitted it; the server stored it verbatim and
  // cascaded the corrupt prefix into every child (hadron-portal#394). The
  // server must reject any non-bare-slug value before storing/cascading.
  for (const bad of ['hrn:org:acme', 'urn:org:acme', 'acme:foo', 'acme::foo']) {
    it(`rejects "${bad}" without storing or cascading`, async () => {
      const mem = await db.memory.create({
        data: {
          id: generateId(),
          organizationId: org.id,
          urn: `${org.urn}::gear`,
          name: 'gear',
          class: 'knowledge',
        },
      });

      await expect(
        resolvers.Mutation.updateOrganization({}, { id: org.id, urn: bad }, adminCtx()),
      ).rejects.toThrow();

      // Org urn unchanged, and no child URN was rewritten.
      expect((await db.organization.findUnique({ where: { id: org.id } }))?.urn).toBe(org.urn);
      expect((await db.memory.findUnique({ where: { id: mem.id } }))?.urn).toBe(`${org.urn}::gear`);
    });
  }

  it('still allows a valid bare-slug rename', async () => {
    const updated = await resolvers.Mutation.updateOrganization(
      {},
      { id: org.id, urn: 'acme.com' },
      adminCtx(),
    );
    expect(updated.urn).toBe('acme.com');
  });
});

describe('Mutation.createOrganization — rejects a malformed org URN (#376)', () => {
  it('rejects a scheme-prefixed urn', async () => {
    await expect(
      resolvers.Mutation.createOrganization(
        {},
        { name: 'Acme', urn: 'hrn:org:acme' },
        adminCtx(),
      ),
    ).rejects.toThrow();
  });

  it('accepts a valid bare slug', async () => {
    const created = await resolvers.Mutation.createOrganization(
      {},
      { name: 'Acme', urn: `acme-${Date.now()}.com` },
      adminCtx(),
    );
    expect(created.urn).toContain('acme-');
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

// ---------------------------------------------------------------------------
// Chunk 2: GitHub link + membership + creators
// ---------------------------------------------------------------------------

describe('Mutation.linkGithubApp (007-entity-id-or-urn)', () => {
  it('accepts a URN', async () => {
    const updated = await resolvers.Mutation.linkGithubApp(
      {},
      { orgId: org.urn, installationId: 12345 },
      adminCtx(),
    );
    expect(updated.id).toBe(org.id);
    expect(updated.githubInstallationId).toBe(12345);
  });
});

describe('Mutation.unlinkGithubApp (007-entity-id-or-urn)', () => {
  beforeEach(async () => {
    await db.organization.update({
      where: { id: org.id },
      data: { githubInstallationId: 99999 },
    });
  });

  it('accepts a URN', async () => {
    const updated = await resolvers.Mutation.unlinkGithubApp(
      {},
      { orgId: org.urn },
      adminCtx(),
    );
    expect(updated.githubInstallationId).toBeNull();
  });
});

describe('Mutation.updateOrgGithubApp (007-entity-id-or-urn)', () => {
  it('accepts a URN', async () => {
    const updated = await resolvers.Mutation.updateOrgGithubApp(
      {},
      { orgId: org.urn, appId: 'app-id-007', privateKey: 'pk-007' },
      adminCtx(),
    );
    expect(updated.githubAppId).toBe('app-id-007');
  });
});

describe('Mutation.createUserInvitation (007-entity-id-or-urn)', () => {
  it('accepts a URN', async () => {
    const invite = await resolvers.Mutation.createUserInvitation(
      {},
      { orgId: org.urn, memberRole: 'READER', name: 'urn-invite' },
      adminCtx(),
    );
    expect(invite.organizationId).toBe(org.id);
    expect(invite.memberRole).toBe('READER');
  });
});

describe('Mutation.addOrgMember / updateOrgMember / removeOrgMember (007-entity-id-or-urn)', () => {
  let target: { id: string };

  beforeEach(async () => {
    target = await db.user.create({
      data: { id: generateId(), githubId: 9810, githubUsername: 'org-target', roles: ['READER'] },
    });
  });

  it('addOrgMember accepts a URN as orgId', async () => {
    const member = await resolvers.Mutation.addOrgMember(
      {},
      { orgId: org.urn, userId: target.id, role: 'CONTRIBUTOR' },
      adminCtx(),
    );
    expect(member.organizationId).toBe(org.id);
    expect(member.userId).toBe(target.id);
    expect(member.role).toBe('CONTRIBUTOR');
  });

  it('updateOrgMember accepts a URN as orgId', async () => {
    await db.orgMember.create({
      data: { id: generateId(), organizationId: org.id, userId: target.id, role: 'READER' },
    });
    const updated = await resolvers.Mutation.updateOrgMember(
      {},
      { orgId: org.urn, userId: target.id, role: 'CONTRIBUTOR' },
      adminCtx(),
    );
    expect(updated.role).toBe('CONTRIBUTOR');
  });

  it('removeOrgMember accepts a URN as orgId', async () => {
    await db.orgMember.create({
      data: { id: generateId(), organizationId: org.id, userId: target.id, role: 'READER' },
    });
    const ok = await resolvers.Mutation.removeOrgMember(
      {},
      { orgId: org.urn, userId: target.id },
      adminCtx(),
    );
    expect(ok).toBe(true);
    const after = await db.orgMember.findUnique({
      where: { organizationId_userId: { organizationId: org.id, userId: target.id } },
    });
    expect(after).toBeNull();
  });
});

describe('Mutation.createMemory / createAgent / createApp (007-entity-id-or-urn)', () => {
  it('createMemory accepts a URN as orgId', async () => {
    const mem = await resolvers.Mutation.createMemory(
      {},
      { orgId: org.urn, name: 'urn-mem' },
      adminCtx(),
    );
    expect(mem.organizationId).toBe(org.id);
    expect(mem.urn).toBe(`${org.urn}:urn-mem`);
  });

  it('createAgent accepts a URN as orgId', async () => {
    const agent = await resolvers.Mutation.createAgent(
      {},
      { orgId: org.urn, name: 'urn-agent' },
      adminCtx(),
    );
    expect(agent.organizationId).toBe(org.id);
    expect(agent.urn).toBe(`${org.urn}:urn-agent`);
  });

  it('createApp accepts a URN as orgId', async () => {
    // 009-install-agent-flow: createApp now requires agentId. Stand up a
    // minimal Agent in the same org so the install path is satisfied.
    const agent = await resolvers.Mutation.createAgent(
      {},
      { orgId: org.id, name: 'urn-app-host-agent' },
      adminCtx(),
    );
    const app = await resolvers.Mutation.createApp(
      {},
      { orgId: org.urn, agentId: agent.id, name: 'urn-app' },
      adminCtx(),
    );
    expect(app.organizationId).toBe(org.id);
    expect(app.urn).toBe(`${org.urn}:urn-app`);
  });
});
