/**
 * #2856 — changing or unsetting an Agent's system memory is a typed refusal.
 *
 * The first check in `updateAgent` threw a plain `Error` for a text the second,
 * in-transaction check already raises as `BAD_USER_INPUT`. Per cor:api:260:01 a
 * plain Error is a fault: the caller saw `INTERNAL_SERVER_ERROR` for what is a
 * refusal of their own input.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

const M = resolvers.Mutation as any;

function ctx(userId: string): Context {
  return { db, userId, roles: ['READER'] };
}

async function refusal(p: Promise<unknown>): Promise<GraphQLError> {
  try {
    await p;
  } catch (e) {
    return e as GraphQLError;
  }
  throw new Error('expected a rejection');
}

let org: { id: string; urn: string };
let admin: { id: string };
let agent: { id: string; systemMemoryId: string | null };
let otherMemory: { id: string };

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({
    data: { id: generateId(), name: 'sysmem-2856', urn: `sysmem-2856-${suffix}.com` },
  });
  admin = await db.user.create({
    data: { id: generateId(), githubId: 92856, githubUsername: `sysmem-admin-${suffix}`, roles: ['READER'] },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' },
  });
  agent = await M.createAgent({}, { orgId: org.id, name: 'Sysmem Agent' }, ctx(admin.id));
  otherMemory = await db.memory.create({
    data: { id: generateId(), name: 'other', urn: `other-2856-${suffix}`, organizationId: org.id, class: 'knowledge' },
  });
});

describe('updateAgent systemMemoryId on an Agent that has one (#2856)', () => {
  it('refuses a different memory with BAD_USER_INPUT, not a plain Error', async () => {
    const err = await refusal(
      M.updateAgent({}, { ref: agent.id, systemMemoryId: otherMemory.id }, ctx(admin.id)),
    );
    expect(err).toBeInstanceOf(GraphQLError);
    expect(err.extensions?.code).toBe('BAD_USER_INPUT');
    expect(err.message).toMatch(/Cannot unset or change/);
  });

  it('refuses unsetting (empty string) with BAD_USER_INPUT', async () => {
    const err = await refusal(
      M.updateAgent({}, { ref: agent.id, systemMemoryId: '' }, ctx(admin.id)),
    );
    expect(err).toBeInstanceOf(GraphQLError);
    expect(err.extensions?.code).toBe('BAD_USER_INPUT');
  });

  it('writes nothing when it refuses', async () => {
    await refusal(
      M.updateAgent({}, { ref: agent.id, name: 'Renamed', systemMemoryId: otherMemory.id }, ctx(admin.id)),
    );
    const after = await db.agent.findUniqueOrThrow({ where: { id: agent.id } });
    expect(after.systemMemoryId).toBe(agent.systemMemoryId);
    expect(after.name).toBe('Sysmem Agent');
  });

  it('still accepts the unchanged id', async () => {
    const updated = await M.updateAgent(
      {},
      { ref: agent.id, name: 'Renamed', systemMemoryId: agent.systemMemoryId },
      ctx(admin.id),
    );
    expect(updated.name).toBe('Renamed');
    expect(updated.systemMemoryId).toBe(agent.systemMemoryId);
  });
});
