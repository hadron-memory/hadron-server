/**
 * Integration tests for Query.agentSubscriptions.
 *
 * Resolver had zero existing test coverage. Added as part of spec
 * 007-entity-id-or-urn (which widens agentId to accept ID or URN);
 * tests cover the existing ID-input behavior and the new URN-input
 * paths uniformly.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

let org: { id: string; urn: string };
let adminUser: { id: string };
let outsider: { id: string };
let subscriberA: { id: string };
let subscriberB: { id: string };
let agent: { id: string; urn: string };

function adminCtx(): Context {
  return { db, userId: adminUser.id, roles: ['READER'] };
}

function outsiderCtx(): Context {
  return { db, userId: outsider.id, roles: ['READER'] };
}

beforeEach(async () => {
  await cleanDb(db);

  org = await db.organization.create({
    data: {
      id: generateId(),
      name: 'agent-sub-org',
      urn: `agent-sub-org-${Date.now()}`,
    },
  });

  adminUser = await db.user.create({
    data: { id: generateId(), githubId: 9701, githubUsername: 'agent-sub-admin', roles: ['READER'] },
  });
  outsider = await db.user.create({
    data: { id: generateId(), githubId: 9702, githubUsername: 'agent-sub-outsider', roles: ['READER'] },
  });
  subscriberA = await db.user.create({
    data: { id: generateId(), githubId: 9703, githubUsername: 'agent-sub-a', roles: ['READER'] },
  });
  subscriberB = await db.user.create({
    data: { id: generateId(), githubId: 9704, githubUsername: 'agent-sub-b', roles: ['READER'] },
  });

  await db.orgMember.create({
    data: { id: generateId(), organizationId: org.id, userId: adminUser.id, role: 'ADMIN' },
  });

  agent = await db.agent.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: `${org.urn}:research-bot`,
      name: 'research-bot',
      type: 'CHATBOT',
      surfaces: ['api'],
    },
  });

  await db.agentSubscription.createMany({
    data: [
      {
        userId: subscriberA.id,
        agentId: agent.id,
        activatedAt: new Date(Date.now() - 60_000),
      },
      {
        userId: subscriberB.id,
        agentId: agent.id,
        activatedAt: new Date(),
      },
    ],
  });
});

describe('Query.agentSubscriptions', () => {
  it('returns the agent\'s subscriptions to an org-admin caller (input by ID)', async () => {
    const subs = await resolvers.Query.agentSubscriptions(
      null,
      { agentId: agent.id },
      adminCtx(),
    );
    expect(subs).toHaveLength(2);
    expect(subs.every((s) => s.agentId === agent.id)).toBe(true);
    expect(new Set(subs.map((s) => s.userId))).toEqual(
      new Set([subscriberA.id, subscriberB.id]),
    );
  });

  // 007-entity-id-or-urn: agentId accepts ID or URN.
  it('accepts a URN as agentId input', async () => {
    const subs = await resolvers.Query.agentSubscriptions(
      null,
      { agentId: agent.urn },
      adminCtx(),
    );
    expect(subs).toHaveLength(2);
  });

  it('accepts a prefixed URN (urn:agent:...) as agentId input', async () => {
    const subs = await resolvers.Query.agentSubscriptions(
      null,
      { agentId: `urn:agent:${agent.urn}` },
      adminCtx(),
    );
    expect(subs).toHaveLength(2);
  });

  it('rejects callers without ADMIN on the agent\'s org', async () => {
    await expect(
      resolvers.Query.agentSubscriptions(
        null,
        { agentId: agent.id },
        outsiderCtx(),
      ),
    ).rejects.toThrow();
  });

  it('rejects an unknown agentId', async () => {
    await expect(
      resolvers.Query.agentSubscriptions(
        null,
        // 25-char cuid-shaped string that doesn't exist in DB.
        { agentId: 'cnonexistentnonexistent12' },
        adminCtx(),
      ),
    ).rejects.toThrow();
  });
});
