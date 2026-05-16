/**
 * Integration tests for the addToMyMemories resolver.
 *
 * This op had zero existing test coverage. Added as part of spec
 * 007-entity-id-or-urn (which widens memoryId to accept ID or URN);
 * tests cover both the existing ID-input behavior and the new
 * URN-input path.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

let userA: { id: string };
let publicMemory: { id: string; urn: string };
let privateMemory: { id: string; urn: string };

function readerCtx(userId: string): Context {
  return {
    db,
    userId,
    roles: ['READER'],
  };
}

beforeEach(async () => {
  await cleanDb(db);

  // User with a personal organization and a default agent.
  // The personal org has isVisible != true, matching the resolver's
  // org membership lookup.
  userA = await db.user.create({
    data: {
      id: generateId(),
      githubId: 9501,
      githubUsername: 'add-memories-user',
      roles: ['READER'],
    },
  });
  const personalOrg = await db.organization.create({
    data: {
      id: generateId(),
      name: 'add-memories-personal',
      urn: `add-memories-personal-${Date.now()}`,
      isVisible: false,
    },
  });
  await db.orgMember.create({
    data: {
      id: generateId(),
      organizationId: personalOrg.id,
      userId: userA.id,
      role: 'OWNER',
    },
  });
  await db.agent.create({
    data: {
      id: generateId(),
      organizationId: personalOrg.id,
      urn: `${personalOrg.urn}:default-agent`,
      name: 'default-agent',
    },
  });

  // A separate org publishing a public memory the user can subscribe to.
  const publisherOrg = await db.organization.create({
    data: {
      id: generateId(),
      name: 'add-memories-publisher',
      urn: `add-memories-publisher-${Date.now()}`,
      isVisible: true,
    },
  });
  publicMemory = await db.memory.create({
    data: {
      id: generateId(),
      organizationId: publisherOrg.id,
      urn: `${publisherOrg.urn}:public-mem`,
      name: 'public-mem',
      class: 'knowledge',
      visibility: 'PUBLIC',
    },
  });
  privateMemory = await db.memory.create({
    data: {
      id: generateId(),
      organizationId: publisherOrg.id,
      urn: `${publisherOrg.urn}:private-mem`,
      name: 'private-mem',
      class: 'knowledge',
      visibility: 'PRIVATE',
    },
  });
});

describe('addToMyMemories', () => {
  it('subscribes the user\'s personal org to a public memory and adds it to the default agent (input by ID)', async () => {
    const result = await resolvers.Mutation.addToMyMemories(
      null,
      { memoryId: publicMemory.id },
      readerCtx(userA.id),
    );
    expect(result).toBe(true);

    const subscriptions = await db.memorySubscription.findMany({
      where: { memoryId: publicMemory.id },
    });
    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0]!.role).toBe('READER');

    const agentItems = await db.agentMemoryItem.findMany({
      where: { memoryId: publicMemory.id },
    });
    expect(agentItems).toHaveLength(1);
  });

  // 007-entity-id-or-urn: addToMyMemories accepts memoryId as ID or URN.
  it('accepts a URN as memoryId input — identical effect to the ID-input path', async () => {
    const result = await resolvers.Mutation.addToMyMemories(
      null,
      { memoryId: publicMemory.urn },
      readerCtx(userA.id),
    );
    expect(result).toBe(true);

    // Same DB rows as the ID-input case — verifies the helper resolved
    // the URN to the same memory.
    const subscriptions = await db.memorySubscription.findMany({
      where: { memoryId: publicMemory.id },
    });
    expect(subscriptions).toHaveLength(1);
    const agentItems = await db.agentMemoryItem.findMany({
      where: { memoryId: publicMemory.id },
    });
    expect(agentItems).toHaveLength(1);
  });

  it('accepts a prefixed URN (urn:memory:...) as memoryId input', async () => {
    const result = await resolvers.Mutation.addToMyMemories(
      null,
      { memoryId: `urn:memory:${publicMemory.urn}` },
      readerCtx(userA.id),
    );
    expect(result).toBe(true);
    const subscriptions = await db.memorySubscription.findMany({
      where: { memoryId: publicMemory.id },
    });
    expect(subscriptions).toHaveLength(1);
  });

  it('rejects a non-public memory', async () => {
    await expect(
      resolvers.Mutation.addToMyMemories(
        null,
        { memoryId: privateMemory.id },
        readerCtx(userA.id),
      ),
    ).rejects.toThrow(/not public/);
  });

  it('rejects a non-existent memoryId with MEMORY_NOT_FOUND', async () => {
    // 32-char hex — ID-shape; bypasses the spec-022 qualification check
    // and goes to DB lookup, which misses → MEMORY_NOT_FOUND.
    await expect(
      resolvers.Mutation.addToMyMemories(
        null,
        { memoryId: '0123456789abcdef0123456789abcdef' },
        readerCtx(userA.id),
      ),
    ).rejects.toThrow(/MEMORY_NOT_FOUND/);
  });

  it('rejects an unqualified memoryId with URN_NOT_QUALIFIED (spec 022)', async () => {
    await expect(
      resolvers.Mutation.addToMyMemories(
        null,
        { memoryId: 'no-such-memory-id' },
        readerCtx(userA.id),
      ),
    ).rejects.toThrow(/not fully qualified/);
  });
});
