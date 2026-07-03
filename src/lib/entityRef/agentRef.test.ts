import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { PrismaClient } from '../../generated/prisma/index.js';
import { resolveAgentRef } from './agentRef.js';
import { AgentNotFoundError, UrnNotQualifiedError } from './errors.js';

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
    // 32-char hex — ID-shape, bypasses the spec-022 qualification check
    // and goes straight to DB lookup, which misses.
    await expect(
      resolveAgentRef(db, '0123456789abcdef0123456789abcdef'),
    ).rejects.toBeInstanceOf(AgentNotFoundError);
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

  // ===================================================================
  // spec 022 — API-boundary URN qualification (FR-001, FR-002, FR-019)
  // ===================================================================

  it('rejects bare single-segment input as UrnNotQualifiedError (not an agent URN)', async () => {
    await expect(resolveAgentRef(db, 'coding-agent')).rejects.toBeInstanceOf(
      UrnNotQualifiedError,
    );
  });

  it('rejects empty input as UrnNotQualifiedError', async () => {
    await expect(resolveAgentRef(db, '')).rejects.toBeInstanceOf(UrnNotQualifiedError);
  });

  it('rejects urn:org: prefix (wrong type) as UrnNotQualifiedError', async () => {
    await expect(resolveAgentRef(db, 'urn:org:acme.com')).rejects.toBeInstanceOf(
      UrnNotQualifiedError,
    );
  });

  it('excludes a soft-deleted agent by default; includeDeleted opts in', async () => {
    const agent = await db.agent.create({
      data: { organizationId: orgId, urn: `${orgId}:agentref-test-deleted`, name: 'agentref-test-deleted', deletedAt: new Date() },
    });
    await expect(resolveAgentRef(db, agent.id)).rejects.toBeInstanceOf(AgentNotFoundError);
    await expect(resolveAgentRef(db, agent.id, { includeDeleted: true })).resolves.toEqual({ id: agent.id });
  });
});
