import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { PrismaClient } from '../../generated/prisma/index.js';
import { resolveAgentRef } from './agentRef.js';
import { AgentNotFoundError } from './errors.js';

const db = new PrismaClient();

let orgId: string;

beforeAll(async () => {
  await db.$connect();
});

afterAll(async () => {
  await db.$disconnect();
});

beforeEach(async () => {
  await db.agent.deleteMany({ where: { name: { startsWith: 'agentref-test-' } } });
  await db.organization.deleteMany({ where: { name: { startsWith: 'agentref-test-' } } });
  const org = await db.organization.create({
    data: { name: 'agentref-test-org', urn: `agentref-test-org-${Date.now()}` },
  });
  orgId = org.id;
});

describe('resolveAgentRef', () => {
  it('resolves an ID-shaped reference', async () => {
    const agent = await db.agent.create({
      data: {
        organizationId: orgId,
        urn: `${orgId}:agentref-test-agent-id`,
        name: 'agentref-test-agent-id',
      },
    });
    expect(await resolveAgentRef(db, agent.id)).toEqual({ id: agent.id });
  });

  it('resolves a bare URN', async () => {
    const agent = await db.agent.create({
      data: {
        organizationId: orgId,
        urn: `${orgId}:agentref-test-agent-urn`,
        name: 'agentref-test-agent-urn',
      },
    });
    expect(await resolveAgentRef(db, agent.urn)).toEqual({ id: agent.id });
  });

  it('resolves a prefixed URN (urn:agent: prefix stripped)', async () => {
    const agent = await db.agent.create({
      data: {
        organizationId: orgId,
        urn: `${orgId}:agentref-test-agent-prefixed`,
        name: 'agentref-test-agent-prefixed',
      },
    });
    expect(await resolveAgentRef(db, `urn:agent:${agent.urn}`)).toEqual({ id: agent.id });
  });

  it('throws AgentNotFoundError on miss (ID)', async () => {
    await expect(resolveAgentRef(db, 'not-a-real-id')).rejects.toBeInstanceOf(
      AgentNotFoundError,
    );
  });

  it('throws AgentNotFoundError on miss (URN)', async () => {
    await expect(resolveAgentRef(db, 'no-such-org:no-such-agent')).rejects.toBeInstanceOf(
      AgentNotFoundError,
    );
  });

  it('throws AgentNotFoundError for a soft-deleted agent', async () => {
    const agent = await db.agent.create({
      data: {
        organizationId: orgId,
        urn: `${orgId}:agentref-test-agent-deleted`,
        name: 'agentref-test-agent-deleted',
        deletedAt: new Date(),
      },
    });
    await expect(resolveAgentRef(db, agent.id)).rejects.toBeInstanceOf(AgentNotFoundError);
    await expect(resolveAgentRef(db, agent.urn)).rejects.toBeInstanceOf(AgentNotFoundError);
  });
});
