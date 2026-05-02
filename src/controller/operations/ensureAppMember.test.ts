/**
 * Enforcement tests for ensureAppMember. Per 008-agent-installation
 * FR-004 + FR-016 + R-7. Verifies SC-004: an Agent with maxMembers=2
 * rejects the third member at invite-acceptance time.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import {
  ensureAppMember,
  InvalidRoleError,
  MaxMembersExceededError,
  OrphanAppError,
} from './ensureAppMember.js';

let orgId: string;
let agentId: string;
let appId: string;
const userIds: string[] = [];

async function makeUser(handle: string): Promise<string> {
  const user = await db.user.create({
    data: { id: generateId(), handle, githubId: Math.floor(Math.random() * 1_000_000) + 90_000_000 },
  });
  userIds.push(user.id);
  return user.id;
}

async function setupAgent(installationPolicy: {
  maxMembers: number | 'unlimited';
  memberRoles: string[];
}): Promise<{ agentId: string; appId: string }> {
  await cleanDb(db);
  userIds.length = 0;
  const org = await db.organization.create({
    data: { id: generateId(), name: 'eam-org', urn: 'eam-org' },
  });
  orgId = org.id;
  const agent = await db.agent.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: `${org.urn}:a`,
      name: 'a',
      installationPolicy,
    },
  });
  const app = await db.app.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: `${org.urn}:app`,
      name: 'app',
      agentId: agent.id,
    },
  });
  return { agentId: agent.id, appId: app.id };
}

describe('ensureAppMember', () => {
  beforeEach(async () => {
    const fixture = await setupAgent({
      maxMembers: 2,
      memberRoles: ['owner', 'guide'],
    });
    agentId = fixture.agentId;
    appId = fixture.appId;
  });

  it('accepts a valid role within maxMembers', async () => {
    const userId = await makeUser('alice');
    await ensureAppMember(db, appId, userId, 'owner');
    const member = await db.appMember.findUniqueOrThrow({
      where: { appId_userId: { appId, userId } },
    });
    expect(member.role).toBe('owner');
  });

  it('rejects an invalid role with InvalidRoleError', async () => {
    const userId = await makeUser('bob');
    await expect(
      ensureAppMember(db, appId, userId, 'cook'), // not in memberRoles
    ).rejects.toBeInstanceOf(InvalidRoleError);
  });

  it('rejects the (maxMembers+1)th member with MaxMembersExceededError', async () => {
    const u1 = await makeUser('alice');
    const u2 = await makeUser('bob');
    const u3 = await makeUser('carol');
    await ensureAppMember(db, appId, u1, 'owner');
    await ensureAppMember(db, appId, u2, 'guide');
    await expect(
      ensureAppMember(db, appId, u3, 'guide'),
    ).rejects.toBeInstanceOf(MaxMembersExceededError);
  });

  it('updating an existing member does NOT trigger maxMembers', async () => {
    const u1 = await makeUser('alice');
    const u2 = await makeUser('bob');
    await ensureAppMember(db, appId, u1, 'owner');
    await ensureAppMember(db, appId, u2, 'guide');

    // Already 2/2 members. Updating u1's role should still succeed.
    await ensureAppMember(db, appId, u1, 'guide');
    const u1After = await db.appMember.findUniqueOrThrow({
      where: { appId_userId: { appId, userId: u1 } },
    });
    expect(u1After.role).toBe('guide');
  });
});

describe('ensureAppMember — maxMembers="unlimited"', () => {
  it('allows arbitrary member counts', async () => {
    const fixture = await setupAgent({
      maxMembers: 'unlimited',
      memberRoles: ['owner', 'cook', 'eater'],
    });
    const u1 = await makeUser('alice');
    const u2 = await makeUser('bob');
    const u3 = await makeUser('carol');
    const u4 = await makeUser('dana');
    await ensureAppMember(db, fixture.appId, u1, 'owner');
    await ensureAppMember(db, fixture.appId, u2, 'cook');
    await ensureAppMember(db, fixture.appId, u3, 'eater');
    await ensureAppMember(db, fixture.appId, u4, 'eater');

    const count = await db.appMember.count({ where: { appId: fixture.appId } });
    expect(count).toBe(4);
  });
});

describe('ensureAppMember — orphan App', () => {
  it('rejects with OrphanAppError when App.agent_id is NULL', async () => {
    await cleanDb(db);
    userIds.length = 0;
    const org = await db.organization.create({
      data: { id: generateId(), name: 'orphan-org', urn: 'orphan-org' },
    });
    const orphanApp = await db.app.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        urn: `${org.urn}:orphan`,
        name: 'orphan',
        // agentId left NULL — cutover orphan
      },
    });
    const userId = await makeUser('zelda');
    await expect(
      ensureAppMember(db, orphanApp.id, userId, 'owner'),
    ).rejects.toBeInstanceOf(OrphanAppError);
  });
});
