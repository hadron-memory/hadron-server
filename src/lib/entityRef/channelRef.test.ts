/**
 * #1171 — `resolveChannelRefId`, what is pinned:
 *   - the id form resolves unchanged, and does so WITHOUT a lookup (an unknown
 *     id comes back for the caller's own gated query to miss on);
 *   - the chat root's node URN resolves, in every spelling `resolveNodeRef`
 *     accepts — and the memory-RENAME alias arm comes with it, which is the
 *     reason this delegates rather than splitting the URN itself;
 *   - everything else is `null`, identically: a wrong-type prefix, a bare loc,
 *     a URN naming a node that is not a chat root, a nonexistent memory, and a
 *     soft-deleted Channel. The Channel surface hides existence
 *     (`cor:api:140:02`), so a ref that names nothing must not be
 *     distinguishable from one that names something you cannot see.
 *   - the SAME address in two memories resolves to two different Channels —
 *     the measurement that made #1171 more than tidiness (two live Channels
 *     named `team` at `chats:team`, separable only by their memory).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { ensureChannelWithRoot } from '../channels.js';
import { resolveChannelRefId } from './channelRef.js';

let org: { id: string; urn: string };
let memA: { id: string; urn: string };
let memB: { id: string; urn: string };
let channelA: { id: string };
let channelB: { id: string };

beforeEach(async () => {
  await cleanDb(db);
  const t = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({ data: { id: generateId(), name: 'cr', urn: `cr-${t}` } });
  const agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'a', urn: `${org.urn}:agent`, visibility: 'ORGANIZATION' } });
  const appA = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'A', urn: `${org.urn}:a` } });
  const appB = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'B', urn: `${org.urn}:b` } });
  memA = await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:a-shared`, name: 'a', class: 'app', appId: appA.id, sharedMemoryOfAgentId: agent.id } });
  memB = await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:b-shared`, name: 'b', class: 'app', appId: appB.id, sharedMemoryOfAgentId: agent.id } });
  channelA = (await ensureChannelWithRoot(db, { memoryId: memA.id, loc: 'chats:team', name: 'team', createdBy: null })).channel;
  channelB = (await ensureChannelWithRoot(db, { memoryId: memB.id, loc: 'chats:team', name: 'team', createdBy: null })).channel;
});

describe('resolveChannelRefId', () => {
  it('resolves the id form unchanged, and without a lookup', async () => {
    expect(await resolveChannelRefId(db, channelA.id)).toBe(channelA.id);
    expect(await resolveChannelRefId(db, ` ${channelA.id} `)).toBe(channelA.id);
    // An ID-SHAPED ref that names nothing is handed back rather than refused:
    // the caller's own query carries the read gate and the deletedAt filter,
    // so existence is decided there, exactly as before this widening.
    const unknown = generateId();
    expect(await resolveChannelRefId(db, unknown)).toBe(unknown);
  });

  it('resolves the chat root node URN, in each spelling the node resolver accepts', async () => {
    for (const ref of [
      `hrn:node:${org.urn}:a-shared:chats:team`,
      `urn:node:${org.urn}:a-shared:chats:team`,
      `${org.urn}:a-shared:chats:team`,
      `hrn:node:${org.urn}::a-shared::chats:team`,
    ]) {
      expect(await resolveChannelRefId(db, ref)).toBe(channelA.id);
    }
  });

  it('the same address in two memories names two different Channels', async () => {
    expect(await resolveChannelRefId(db, `hrn:node:${org.urn}:a-shared:chats:team`)).toBe(channelA.id);
    expect(await resolveChannelRefId(db, `hrn:node:${org.urn}:b-shared:chats:team`)).toBe(channelB.id);
    expect(channelA.id).not.toBe(channelB.id);
  });

  it('follows a memory RENAME, because the node resolver does', async () => {
    // A published address outlives the slug it was published under (#1079).
    // This is what delegating to resolveNodeRef buys that a hand-split of the
    // URN would have silently lost.
    const oldUrn = `${org.urn}:a-shared`;
    await db.memory.update({ where: { id: memA.id }, data: { urn: `${org.urn}:a-renamed` } });
    await db.urnAlias.create({
      data: { urn: oldUrn, entityType: 'MEMORY', entityId: memA.id, reason: 'RENAME', replacedByUrn: `${org.urn}:a-renamed` },
    });
    expect(await resolveChannelRefId(db, `hrn:node:${org.urn}:a-renamed:chats:team`)).toBe(channelA.id);
    expect(await resolveChannelRefId(db, `hrn:node:${oldUrn}:chats:team`)).toBe(channelA.id);
  });

  it('answers null for every other shape, identically', async () => {
    const root = await db.node.create({
      data: { id: generateId(), memoryId: memA.id, loc: 'notes:plain', name: 'plain', nodeType: 'record' },
    });
    for (const ref of [
      '',
      '   ',
      'nope',
      'chats:team', // a bare loc: no memory, and no active-memory dispatch at an API boundary
      `hrn:mem:${org.urn}:a-shared:chats:team`, // wrong-type prefix — never coerced
      `hrn:node:${org.urn}:a-shared:chats:absent`, // a live memory, no such node
      `hrn:node:${org.urn}:no-such-memory:chats:team`,
      `hrn:node:${org.urn}:a-shared:notes:plain`, // a real node that is not a chat root
    ]) {
      expect(await resolveChannelRefId(db, ref)).toBeNull();
    }
    // A node's ID, though, is ID-SHAPED, so it passes through unlooked-up by
    // design (above) and the caller's own query is what finds no Channel with
    // that id. Pinned here so the passthrough is a stated property rather than
    // an assumption: no Channel is reachable through a foreign entity's id.
    expect(await resolveChannelRefId(db, root.id)).toBe(root.id);
    expect(await db.channel.findFirst({ where: { id: root.id } })).toBeNull();
  });

  it('a soft-deleted Channel resolves by neither form', async () => {
    await db.channel.update({ where: { id: channelA.id }, data: { deletedAt: new Date() } });
    await db.node.updateMany({ where: { id: (await db.channel.findUniqueOrThrow({ where: { id: channelA.id } })).chatRootNodeId }, data: { deletedAt: new Date() } });
    // By URN it stops resolving one step earlier (the root is gone); by id it
    // resolves here and is filtered by the caller's `deletedAt: null`. Both
    // end as the same "no match" — which is the property that matters.
    expect(await resolveChannelRefId(db, `hrn:node:${org.urn}:a-shared:chats:team`)).toBeNull();
    expect(await resolveChannelRefId(db, channelA.id)).toBe(channelA.id);
  });
});
