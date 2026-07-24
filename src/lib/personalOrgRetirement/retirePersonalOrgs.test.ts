/**
 * Spec 048 Phase B — the personal-org retirement migration.
 *
 * Pins: a clean scaffold org is re-homed (Agent/App/Memory → ownerUserId, URN
 * re-rooted onto @handle) and deleted (principal released); a live URN collision
 * re-mints to a `-personal` alias (never aborts); the run is idempotent; and any
 * non-scaffold shape (extra member, side-data) is SKIPPED, not destroyed. Dry-run
 * mutates nothing.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { ensureUserPrincipal, ensureOrgPrincipal } from '../principal/mintPrincipal.js';
import { retirePersonalOrgs } from './retirePersonalOrgs.js';

/** Seed a personal-workspace-shaped org (hidden, single OWNER) for a fresh user
 *  with the given handle: an org principal, an org-owned agent + app. */
async function seedPersonalOrg(handle: string) {
  const user = await db.user.create({ data: { handle, roles: ['READER'] } });
  await ensureUserPrincipal(db, { id: user.id, handle, principalId: null });
  const orgUrn = `${handle}-org`;
  const org = await db.organization.create({
    data: { id: generateId(), name: 'Personal', urn: orgUrn, isVisible: false, createdBy: user.id },
  });
  await ensureOrgPrincipal(db, { id: org.id, urn: org.urn, principalId: null });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: org.id, userId: user.id, role: 'OWNER', createdBy: user.id },
  });
  const agent = await db.agent.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: `${orgUrn}:my-agent`,
      name: 'My Agent',
      createdBy: user.id,
      editorLockUserId: user.id,
    },
  });
  const app = await db.app.create({
    data: { id: generateId(), organizationId: org.id, name: 'My Workstation', urn: `${orgUrn}:my-workstation` },
  });
  return { user, org, agent, app, orgUrn };
}

beforeEach(async () => {
  await cleanDb(db);
});

describe('retirePersonalOrgs — happy path', () => {
  it('re-homes the agent + app to the owner, re-roots URNs, and deletes the org', async () => {
    const { user, org, agent, app } = await seedPersonalOrg('alice');

    const [report] = await retirePersonalOrgs(db);
    expect(report.action).toBe('retired');
    expect(report.reHomed.agents).toHaveLength(1);
    expect(report.reHomed.apps).toHaveLength(1);

    const a = await db.agent.findUnique({ where: { id: agent.id } });
    expect(a!.organizationId).toBeNull();
    expect(a!.ownerUserId).toBe(user.id);
    expect(a!.urn).toBe('alice:my-agent');
    expect(a!.legacyUrn).toBe('alice-org:my-agent');

    const p = await db.app.findUnique({ where: { id: app.id } });
    expect(p!.organizationId).toBeNull();
    expect(p!.ownerUserId).toBe(user.id);
    expect(p!.urn).toBe('alice:my-workstation');

    // Org gone, membership gone, org principal tombstoned, user principal intact.
    expect(await db.organization.findUnique({ where: { id: org.id } })).toBeNull();
    expect(await db.orgMember.findFirst({ where: { organizationId: org.id } })).toBeNull();
    const orgPrincipal = await db.principal.findUnique({ where: { name: 'alice-org' } });
    expect(orgPrincipal!.status).toBe('released');
    const userPrincipal = await db.principal.findUnique({ where: { name: 'alice' } });
    expect(userPrincipal!.status).toBe('active');
  });

  it('re-roots an org-owned memory onto the owner', async () => {
    const { user, orgUrn } = await seedPersonalOrg('carol');
    const mem = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: (await db.organization.findFirst({ where: { urn: orgUrn } }))!.id,
        urn: `${orgUrn}:notes`,
        name: 'Notes',
        class: 'knowledge',
        visibility: 'ORGANIZATION',
        createdBy: user.id,
      },
    });

    const [report] = await retirePersonalOrgs(db);
    expect(report.action).toBe('retired');

    const m = await db.memory.findUnique({ where: { id: mem.id } });
    expect(m!.organizationId).toBeNull();
    expect(m!.ownerUserId).toBe(user.id);
    expect(m!.urn).toBe('carol:notes');
    expect(m!.legacyUrn).toBe('carol-org:notes');
  });
});

describe('retirePersonalOrgs — collision safety', () => {
  it('re-mints a colliding slug to a -personal alias instead of aborting', async () => {
    const { user, agent } = await seedPersonalOrg('dave');
    // Dave already owns a user-owned agent at the target URN (spec-047 org-less
    // create path) — the re-root would collide on the globally-unique urn.
    await db.agent.create({
      data: {
        id: generateId(),
        ownerUserId: user.id,
        urn: 'dave:my-agent',
        name: 'Existing',
        createdBy: user.id,
        editorLockUserId: user.id,
      },
    });

    const [report] = await retirePersonalOrgs(db);
    expect(report.action).toBe('retired');

    const migrated = await db.agent.findUnique({ where: { id: agent.id } });
    expect(migrated!.urn).toBe('dave:my-agent-personal');
    expect(migrated!.legacyUrn).toBe('dave-org:my-agent');
    // The pre-existing user-owned agent is untouched.
    expect(await db.agent.findFirst({ where: { urn: 'dave:my-agent' } })).not.toBeNull();
  });
});

describe('retirePersonalOrgs — dry-run + idempotency', () => {
  it('dry-run reports would-retire and mutates nothing', async () => {
    const { org, agent } = await seedPersonalOrg('erin');

    const [report] = await retirePersonalOrgs(db, { dryRun: true });
    expect(report.action).toBe('would-retire');
    expect(report.reHomed.agents).toHaveLength(1);

    // Nothing changed.
    expect(await db.organization.findUnique({ where: { id: org.id } })).not.toBeNull();
    const a = await db.agent.findUnique({ where: { id: agent.id } });
    expect(a!.organizationId).toBe(org.id);
    expect(a!.ownerUserId).toBeNull();
    expect(a!.urn).toBe('erin-org:my-agent');
  });

  it('is idempotent — a second run finds no candidates', async () => {
    await seedPersonalOrg('frank');
    const first = await retirePersonalOrgs(db);
    expect(first).toHaveLength(1);
    expect(first[0].action).toBe('retired');

    const second = await retirePersonalOrgs(db);
    expect(second).toHaveLength(0);
  });
});

describe('retirePersonalOrgs — refuse-and-report guardrail', () => {
  it('skips (does not destroy) an org with a live mailbox connection', async () => {
    const { user, org, agent } = await seedPersonalOrg('grace');
    await db.exchangeConnection.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        userId: user.id,
        mailboxEmail: 'grace@example.com',
      },
    });

    const [report] = await retirePersonalOrgs(db);
    expect(report.action).toBe('skipped');
    expect(report.skipReason).toMatch(/side-data/);
    expect(report.sideData).toMatchObject({ exchange_connections: 1 });

    // Org + agent are untouched — nothing cascade-deleted.
    expect(await db.organization.findUnique({ where: { id: org.id } })).not.toBeNull();
    expect((await db.agent.findUnique({ where: { id: agent.id } }))!.organizationId).toBe(org.id);
  });

  it('skips an org that is not a single-OWNER scaffold', async () => {
    const { org } = await seedPersonalOrg('heidi');
    const other = await db.user.create({ data: { handle: 'heidi-friend', roles: ['READER'] } });
    await db.orgMember.create({
      data: { id: generateId(), organizationId: org.id, userId: other.id, role: 'CONTRIBUTOR', createdBy: other.id },
    });

    const [report] = await retirePersonalOrgs(db);
    expect(report.action).toBe('skipped');
    expect(report.skipReason).toMatch(/single-member/);
    expect(await db.organization.findUnique({ where: { id: org.id } })).not.toBeNull();
  });
});
