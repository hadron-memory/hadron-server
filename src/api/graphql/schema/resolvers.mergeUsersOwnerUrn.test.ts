/**
 * #695 — `mergeUsers` re-owns owner-namespaced resources onto the surviving
 * user, re-rooting each `source:slug` URN to `target:slug` (bare handle root,
 * #697 v2 — no `@` sigil) and re-minting (author-derived) any slug that would
 * collide with a live target resource. Merely-linked resources (subscriptions)
 * are moved but never materialized under a local root.
 *
 * Sibling of resolvers.handleRename.test.ts (the rename-time analogue).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { mergeUsers } from '../../../controller/operations/mergeUsers.js';
import { resolveAgentRef } from '../../../lib/entityRef/agentRef.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

let source: { id: string };
let target: { id: string };

function ctxFor(userId: string): Context {
  return { db, userId, roles: ['READER'] };
}

beforeEach(async () => {
  await cleanDb(db);
  source = await db.user.create({ data: { id: generateId(), handle: 'merge-source', roles: ['READER'] } });
  target = await db.user.create({ data: { id: generateId(), handle: 'merge-target', roles: ['READER'] } });
});

describe('mergeUsers — owner-namespaced URN re-own (#695)', () => {
  it('re-roots a source owner-owned agent + its system memory onto the target', async () => {
    const agent = await resolvers.Mutation.createAgent({}, { name: 'Notes' }, ctxFor(source.id));
    expect(agent.urn).toBe('merge-source:notes');

    await mergeUsers(db, { sourceUserId: source.id, targetUserId: target.id });

    const moved = await db.agent.findUniqueOrThrow({ where: { id: agent.id } });
    expect(moved.urn).toBe('merge-target:notes');
    expect(moved.ownerUserId).toBe(target.id);

    const sys = await db.memory.findUniqueOrThrow({ where: { id: moved.systemMemoryId! } });
    expect(sys.urn).toBe('merge-target:notes-system');
    expect(sys.ownerUserId).toBe(target.id);
  });

  it('records the pre-merge URN in legacyUrn so old @source references still resolve (#697)', async () => {
    const agent = await resolvers.Mutation.createAgent({}, { name: 'Notes' }, ctxFor(source.id));
    expect(agent.urn).toBe('merge-source:notes');

    await mergeUsers(db, { sourceUserId: source.id, targetUserId: target.id });

    const moved = await db.agent.findUniqueOrThrow({ where: { id: agent.id } });
    expect(moved.urn).toBe('merge-target:notes');
    // The alias map now carries the pre-merge URN…
    expect(moved.legacyUrn).toBe('merge-source:notes');
    // …so an old owner-rooted reference redirects to the re-owned row.
    expect(await resolveAgentRef(db, 'hrn:agent:merge-source:notes')).toEqual({ id: agent.id });
  });

  it('re-mints a colliding slug on the loser (source) side, leaving the target resource intact', async () => {
    const srcAgent = await resolvers.Mutation.createAgent({}, { name: 'Notes' }, ctxFor(source.id));
    const tgtAgent = await resolvers.Mutation.createAgent({}, { name: 'Notes' }, ctxFor(target.id));
    expect(srcAgent.urn).toBe('merge-source:notes');
    expect(tgtAgent.urn).toBe('merge-target:notes');

    await mergeUsers(db, { sourceUserId: source.id, targetUserId: target.id });

    // Target keeps its own resource verbatim.
    const kept = await db.agent.findUniqueOrThrow({ where: { id: tgtAgent.id } });
    expect(kept.urn).toBe('merge-target:notes');
    expect(kept.ownerUserId).toBe(target.id);

    // Source's is re-rooted with a deterministic, author-derived alias.
    const reminted = await db.agent.findUniqueOrThrow({ where: { id: srcAgent.id } });
    expect(reminted.urn).toBe('merge-target:notes-merge-source');
    expect(reminted.ownerUserId).toBe(target.id);

    // Its system memory re-mints independently (FK-linked, so slugs may diverge).
    const rmSys = await db.memory.findUniqueOrThrow({ where: { id: reminted.systemMemoryId! } });
    expect(rmSys.urn).toBe('merge-target:notes-system-merge-source');
    expect(rmSys.ownerUserId).toBe(target.id);
  });

  it('re-roots a source owner-owned App', async () => {
    // A PUBLIC org agent to install into a personal App.
    const org = await db.organization.create({ data: { id: generateId(), name: 'pub-org', urn: `pub-org-${generateId()}` } });
    const pub = await db.agent.create({ data: { id: generateId(), name: 'Pub', urn: `${org.urn}:pub`, organizationId: org.id, visibility: 'PUBLIC' } });
    const app = await resolvers.Mutation.createApp({}, { agentId: pub.id, name: 'My App' }, ctxFor(source.id));
    expect(app.urn).toBe('merge-source:my-app');

    await mergeUsers(db, { sourceUserId: source.id, targetUserId: target.id });

    const moved = await db.app.findUniqueOrThrow({ where: { id: app.id } });
    expect(moved.urn).toBe('merge-target:my-app');
    expect(moved.ownerUserId).toBe(target.id);
    // The org-owned public agent is untouched (linked, not owned).
    expect((await db.agent.findUniqueOrThrow({ where: { id: pub.id } })).urn).toBe(`${org.urn}:pub`);
  });

  it('rewrites a durable entry_node_urn that embeds a re-rooted memory URN', async () => {
    const agent = await resolvers.Mutation.createAgent({}, { name: 'Notes' }, ctxFor(source.id));
    await db.node.create({ data: { id: generateId(), memoryId: agent.systemMemoryId!, loc: 'intro', name: 'Intro' } });

    // Trigger tables are org-NOT-NULL, so insert directly (as handleRename does).
    const org = await db.organization.create({ data: { id: generateId(), name: 'sched-org', urn: `sched-org-${generateId()}` } });
    const app = await db.app.create({ data: { id: generateId(), name: 'sched-app', urn: `${org.urn}:sched-app`, organizationId: org.id } });
    const sched = await db.agentSchedule.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        appId: app.id,
        name: 'nightly',
        runAt: new Date('2026-08-01T00:00:00Z'),
        entryNodeUrn: 'hrn:node:merge-source:notes-system:intro',
      },
    });

    await mergeUsers(db, { sourceUserId: source.id, targetUserId: target.id });

    const after = await db.agentSchedule.findUniqueOrThrow({ where: { id: sched.id } });
    expect(after.entryNodeUrn).toBe('hrn:node:merge-target:notes-system:intro');
  });

  it('rewrites entry_node_urn to the RE-MINTED memory URN under a collision', async () => {
    const srcAgent = await resolvers.Mutation.createAgent({}, { name: 'Notes' }, ctxFor(source.id));
    await resolvers.Mutation.createAgent({}, { name: 'Notes' }, ctxFor(target.id)); // target owns merge-target:notes(-system)
    await db.node.create({ data: { id: generateId(), memoryId: srcAgent.systemMemoryId!, loc: 'intro', name: 'Intro' } });

    const org = await db.organization.create({ data: { id: generateId(), name: 'sched-org', urn: `sched-org-${generateId()}` } });
    const app = await db.app.create({ data: { id: generateId(), name: 'sched-app', urn: `${org.urn}:sched-app`, organizationId: org.id } });
    const sched = await db.agentSchedule.create({
      data: { id: generateId(), organizationId: org.id, appId: app.id, name: 'nightly', runAt: new Date('2026-08-01T00:00:00Z'), entryNodeUrn: 'hrn:node:merge-source:notes-system:intro' },
    });

    await mergeUsers(db, { sourceUserId: source.id, targetUserId: target.id });

    // The source system memory was re-minted, so the ref follows the new slug.
    const after = await db.agentSchedule.findUniqueOrThrow({ where: { id: sched.id } });
    expect(after.entryNodeUrn).toBe('hrn:node:merge-target:notes-system-merge-source:intro');
  });

  it("does NOT touch the target's unrelated soft-deleted resources in its namespace", async () => {
    // Target has a soft-deleted agent + system memory that collide with nothing
    // the source owns — a namespace-wide reclaim would hard-delete them (with a
    // node cascade). The reclaim must be surgical (only the exact re-rooted URN).
    const dead = await resolvers.Mutation.createAgent({}, { name: 'Archive' }, ctxFor(target.id));
    await db.agent.update({ where: { id: dead.id }, data: { deletedAt: new Date() } });
    await db.memory.update({ where: { id: dead.systemMemoryId! }, data: { deletedAt: new Date() } });
    // Source owns an unrelated agent.
    await resolvers.Mutation.createAgent({}, { name: 'Notes' }, ctxFor(source.id));

    await mergeUsers(db, { sourceUserId: source.id, targetUserId: target.id });

    // The target's tombstoned resources survive the merge.
    expect(await db.agent.findUnique({ where: { id: dead.id } })).not.toBeNull();
    expect(await db.memory.findUnique({ where: { id: dead.systemMemoryId! } })).not.toBeNull();
  });

  it('reclaims a soft-deleted holder sitting at the EXACT re-rooted URN', async () => {
    // Source's `merge-source:notes` re-roots onto `merge-target:notes`, where a
    // soft-deleted holder already sits — it must be reclaimed so the re-root
    // succeeds (matching the create-path reclaim semantics), not re-minted.
    const srcAgent = await resolvers.Mutation.createAgent({}, { name: 'Notes' }, ctxFor(source.id));
    const ghost = await resolvers.Mutation.createAgent({}, { name: 'Notes' }, ctxFor(target.id));
    await db.agent.update({ where: { id: ghost.id }, data: { deletedAt: new Date() } });
    await db.memory.update({ where: { id: ghost.systemMemoryId! }, data: { deletedAt: new Date() } });

    await mergeUsers(db, { sourceUserId: source.id, targetUserId: target.id });

    const moved = await db.agent.findUniqueOrThrow({ where: { id: srcAgent.id } });
    expect(moved.urn).toBe('merge-target:notes'); // reclaimed the ghost's URN, no alias
    expect(await db.agent.findUnique({ where: { id: ghost.id } })).toBeNull(); // ghost reclaimed
  });

  it('a merely-subscribed (linked) resource mints no local URN', async () => {
    const org = await db.organization.create({ data: { id: generateId(), name: 'pub-org', urn: `pub-org-${generateId()}` } });
    const pub = await db.agent.create({ data: { id: generateId(), name: 'Pub', urn: `${org.urn}:pub`, organizationId: org.id, visibility: 'PUBLIC' } });
    await db.agentSubscription.create({ data: { userId: source.id, agentId: pub.id, activatedAt: new Date(), createdBy: source.id } });

    await mergeUsers(db, { sourceUserId: source.id, targetUserId: target.id });

    // The subscription moved to the target …
    expect(await db.agentSubscription.findUnique({ where: { userId_agentId: { userId: target.id, agentId: pub.id } } })).not.toBeNull();
    // … but nothing was materialized under the target's root.
    expect(await db.memory.count({ where: { urn: { startsWith: 'merge-target:' } } })).toBe(0);
    expect(await db.agent.count({ where: { urn: { startsWith: 'merge-target:' } } })).toBe(0);
    expect(await db.app.count({ where: { urn: { startsWith: 'merge-target:' } } })).toBe(0);
    // The org-owned agent is untouched.
    expect((await db.agent.findUniqueOrThrow({ where: { id: pub.id } })).urn).toBe(`${org.urn}:pub`);
  });
});
