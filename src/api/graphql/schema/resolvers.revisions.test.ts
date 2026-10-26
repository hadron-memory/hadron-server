/**
 * Tests for chatbot revisions: snapshot, publish, restore, editor lock.
 */
import { describe, it, expect, beforeEach, vi, beforeAll, afterAll } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { generateId } from '../../../lib/id.js';
import { archivedTombstoneLoc } from '../../../lib/tombstoneArchive.js';
import { revisionStateHashRefreshMarker } from '../../../lib/nodeRevisionSnapshot.js';
import { setMintedSpecPermanenceEnforcedForTests } from '../../../lib/mintedSpecPermanence.js';

// #1591: minted-spec permanence is switched off in production for now; the
// #1468 guard's own assertions run with it on.
beforeAll(() => setMintedSpecPermanenceEnforcedForTests(true));
afterAll(() => setMintedSpecPermanenceEnforcedForTests(false));

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

let orgA: { id: string };
let adminUser: { id: string };
let otherAdmin: { id: string };
let agent: { id: string };
let systemMemory: { id: string };

function adminCtx(userId?: string): Context {
  return { db, roles: ['ADMIN'], userId: userId ?? adminUser.id };
}

beforeEach(async () => {
  await cleanDb(db);

  orgA = await db.organization.create({
    data: { id: generateId(), name: 'rev-org', urn: 'rev-org' },
  });
  adminUser = await db.user.create({
    data: { githubId: 7001, githubUsername: 'rev-admin', roles: ['ADMIN'] },
  });
  otherAdmin = await db.user.create({
    data: { githubId: 7002, githubUsername: 'other-admin', roles: ['ADMIN'] },
  });
  await db.orgMember.create({
    data: { organizationId: orgA.id, userId: adminUser.id, role: 'ADMIN' },
  });
  await db.orgMember.create({
    data: { organizationId: orgA.id, userId: otherAdmin.id, role: 'ADMIN' },
  });

  const created = await resolvers.Mutation.createAgent(
    {},
    { orgId: orgA.id, name: 'rev-agent', visibility: 'PERSONAL' },
    adminCtx(),
  );
  agent = created;
  // createAgent now auto-provisions the agent's class='system' memory (#518);
  // read it straight off the returned agent rather than create + attach.
  systemMemory = await db.memory.findUniqueOrThrow({
    where: { id: created.systemMemoryId! },
  });

  // Seed a conversation + stage + prompt
  for (const n of [
    { loc: 'conversations', name: 'conversations', nodeType: 'system' },
    { loc: 'conversations:hello', name: 'hello', nodeType: 'system', data: { stageOrder: ['greet'], isSetup: false } },
    { loc: 'conversations:hello:greet', name: 'greet', nodeType: 'system', data: { promptRef: 'prompts:hello:greet' } },
    { loc: 'prompts', name: 'prompts', nodeType: 'system' },
    { loc: 'prompts:hello', name: 'hello', nodeType: 'system' },
    { loc: 'prompts:hello:greet', name: 'greet', nodeType: 'system', content: 'Hello world!' },
  ] as any[]) {
    await db.node.create({
      data: {
        id: generateId(), memoryId: systemMemory.id,
        loc: n.loc, name: n.name, nodeType: n.nodeType,
        data: n.data ?? null, content: n.content ?? null,
      },
    });
  }
});

describe('createRevision', () => {
  it('creates a snapshot of the system memory', async () => {
    const result = await resolvers.Mutation.createRevision(
      {},
      { agentId: agent.id, description: 'Initial save' },
      adminCtx(),
    );

    expect(result.revisionLoc).toBe('revisions:rev-1');
    expect(result.label).toBe('rev-1');
    expect(result.published).toBe(false);

    // Verify the revision node exists with a snapshot
    const revNode = await db.node.findFirst({
      where: { memoryId: systemMemory.id, loc: 'revisions:rev-1' },
    });
    expect(revNode).toBeTruthy();
    const revData = revNode?.data as Record<string, unknown>;
    const snapshot = revData.snapshot as { nodes: unknown[]; edges: unknown[] };
    expect(snapshot.nodes.length).toBeGreaterThanOrEqual(6);
  });

  it('auto-increments revision numbers', async () => {
    await resolvers.Mutation.createRevision({}, { agentId: agent.id }, adminCtx());
    const r2 = await resolvers.Mutation.createRevision({}, { agentId: agent.id }, adminCtx());
    expect(r2.revisionLoc).toBe('revisions:rev-2');
  });

  // 007-entity-id-or-urn: createRevision accepts agentId as ID or URN.
  it('accepts a URN as agentId input', async () => {
    const stored = await db.agent.findUniqueOrThrow({
      where: { id: agent.id },
      select: { urn: true },
    });
    const result = await resolvers.Mutation.createRevision(
      {},
      { agentId: stored.urn, description: 'urn-input' },
      adminCtx(),
    );
    expect(result.revisionLoc).toBe('revisions:rev-1');
  });

  it('accepts a prefixed URN (urn:agent:...) as agentId input', async () => {
    const stored = await db.agent.findUniqueOrThrow({
      where: { id: agent.id },
      select: { urn: true },
    });
    const result = await resolvers.Mutation.createRevision(
      {},
      { agentId: `urn:agent:${stored.urn}`, description: 'prefixed-urn-input' },
      adminCtx(),
    );
    expect(result.revisionLoc).toBe('revisions:rev-1');
  });

  // #2498: the slot (`rev-N`) used to be chosen from a count taken BEFORE the insert
  // transaction's lock, so concurrent saves chose the same loc and the loser died on a raw P2002.
  it('concurrent saves allocate distinct revision slots (#2498)', async () => {
    for (let round = 0; round < 5; round++) {
      const before = await db.node.count({ where: { memoryId: systemMemory.id, loc: { startsWith: 'revisions:' }, deletedAt: null } });
      const results = await Promise.allSettled(
        Array.from({ length: 4 }, () => resolvers.Mutation.createRevision({}, { agentId: agent.id }, adminCtx())),
      );
      expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
      const locs = results.map((r) => (r as PromiseFulfilledResult<{ revisionLoc: string }>).value.revisionLoc);
      expect(new Set(locs).size).toBe(4);
      const after = await db.node.count({ where: { memoryId: systemMemory.id, loc: { startsWith: 'revisions:' }, deletedAt: null } });
      expect(after).toBe(before + 4);
    }
  });

  // #2507: a live count collides with a live rev-N after a middle deletion, and must not reuse a deleted name.
  const slotNode = (loc: string) => db.node.findFirstOrThrow({ where: { memoryId: systemMemory.id, loc } });
  const save = () => resolvers.Mutation.createRevision({}, { agentId: agent.id }, adminCtx());
  const del = async (loc: string) => resolvers.Mutation.deleteNode({}, { nodeRef: (await slotNode(loc)).id }, adminCtx());

  it('a save after a middle deletion takes rev-3, not the live rev-2 (#2507)', async () => {
    await save(); await save();
    await del('revisions:rev-1');
    const r = await save();
    expect(r.revisionLoc).toBe('revisions:rev-3');
  });

  it('restore still auto-saves after a middle deletion (#2507)', async () => {
    const rev2 = (await save(), await save());
    await del('revisions:rev-1');
    await resolvers.Mutation.restoreRevision({}, { agentId: agent.id, revisionLoc: rev2.revisionLoc }, adminCtx());
    const auto = await db.node.findMany({
      where: { memoryId: systemMemory.id, deletedAt: null, description: { startsWith: 'Auto-save before restoring' } },
    });
    expect(auto.map((n) => n.loc)).toEqual(['revisions:rev-3']);
  });

  it('never reuses the name of a deleted highest revision, so its undelete cannot collide or retarget (#2507)', async () => {
    await save();
    const second = await save();
    const secondRow = await slotNode(second.revisionLoc);
    const originalSnapshot = (secondRow.data as { snapshot: unknown }).snapshot;
    await del('revisions:rev-2');
    const next = await save();
    expect(next.revisionLoc).toBe('revisions:rev-3');
    // undelete the deleted row: both live, distinct, the old one still holds its own snapshot
    await db.node.update({ where: { id: secondRow.id }, data: { deletedAt: null, deletedBy: null } });
    const live = await db.node.findMany({ where: { memoryId: systemMemory.id, loc: { startsWith: 'revisions:rev-' }, deletedAt: null }, orderBy: { loc: 'asc' } });
    expect(live.map((n) => n.loc)).toEqual(['revisions:rev-1', 'revisions:rev-2', 'revisions:rev-3']);
    expect((live[1].data as { snapshot: unknown }).snapshot).toEqual(originalSnapshot);
  });

  it('counts an archived tombstone slot and ignores descendant and malformed locs (#2507)', async () => {
    await save();
    const row = await slotNode('revisions:rev-1');
    await resolvers.Mutation.deleteNode({}, { nodeRef: row.id }, adminCtx());
    await db.node.update({ where: { id: row.id }, data: { loc: archivedTombstoneLoc('revisions:rev-1', row.id) } });
    for (const loc of ['revisions:rev-40:child', 'revisions:rev-oops']) {
      await db.node.create({ data: { id: generateId(), memoryId: systemMemory.id, loc, name: 'x', nodeType: 'system' } });
    }
    expect((await save()).revisionLoc).toBe('revisions:rev-2');
  });

  it('concurrent restores each auto-save into their own slot (#2498)', async () => {
    const rev = await resolvers.Mutation.createRevision({}, { agentId: agent.id }, adminCtx());
    const results = await Promise.allSettled(
      Array.from({ length: 3 }, () => resolvers.Mutation.restoreRevision({}, { agentId: agent.id, revisionLoc: rev.revisionLoc }, adminCtx())),
    );
    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
    const autoSaves = await db.node.findMany({
      where: { memoryId: systemMemory.id, loc: { startsWith: 'revisions:' }, deletedAt: null, description: { startsWith: 'Auto-save before restoring' } },
    });
    expect(autoSaves).toHaveLength(3);
  });
});

describe('publishRevision', () => {
  it('marks a revision as published and updates the agent', async () => {
    await resolvers.Mutation.createRevision({}, { agentId: agent.id }, adminCtx());

    const result = await resolvers.Mutation.publishRevision(
      {},
      { agentId: agent.id, revisionLoc: 'revisions:rev-1', versionLabel: 'v1.0' },
      adminCtx(),
    );

    expect(result.published).toBe(true);
    expect(result.label).toBe('v1.0');

    // Agent should have publishedRevisionLoc set
    const updatedAgent = await db.agent.findUnique({ where: { id: agent.id } });
    expect(updatedAgent?.publishedRevisionLoc).toBe('revisions:rev-1');
  });

  // 007-entity-id-or-urn: publishRevision accepts agentId as ID or URN.
  it('accepts a URN as agentId input', async () => {
    await resolvers.Mutation.createRevision({}, { agentId: agent.id }, adminCtx());
    const stored = await db.agent.findUniqueOrThrow({
      where: { id: agent.id },
      select: { urn: true },
    });
    const result = await resolvers.Mutation.publishRevision(
      {},
      { agentId: stored.urn, revisionLoc: 'revisions:rev-1', versionLabel: 'v1.0' },
      adminCtx(),
    );
    expect(result.published).toBe(true);
    const updatedAgent = await db.agent.findUnique({ where: { id: agent.id } });
    expect(updatedAgent?.publishedRevisionLoc).toBe('revisions:rev-1');
  });
});

describe('restoreRevision', () => {
  it('does not attach a current task stamp to content restored from a legacy agent snapshot', async () => {
    const target = await db.node.findFirstOrThrow({
      where: { memoryId: systemMemory.id, loc: 'prompts:hello:greet' },
    });
    await resolvers.Mutation.createRevision({}, { agentId: agent.id, description: 'before task stamp' }, adminCtx());
    const task = await db.node.create({
      data: { id: generateId(), memoryId: systemMemory.id, loc: 'prompts:author-task', name: 'Author task', nodeType: 'task' },
    });
    const authoredAt = new Date('2026-09-26T20:00:00Z');
    await db.node.update({
      where: { id: target.id },
      data: {
        content: 'newer task-authored content', authorshipKind: 'TASK',
        authoredByTask: task.id, authoredByRevision: 1, authoredAt,
        revisionContentHash: revisionStateHashRefreshMarker(),
      },
    });

    await resolvers.Mutation.restoreRevision({}, { agentId: agent.id, revisionLoc: 'revisions:rev-1' }, adminCtx());

    expect(await db.node.findUniqueOrThrow({ where: { id: target.id } })).toMatchObject({
      content: 'Hello world!', authorshipKind: null, authoredByTask: null,
      authoredByRevision: null, authoredAt: null,
    });
    expect(await db.nodeRevision.findFirstOrThrow({
      where: { nodeId: target.id, content: 'newer task-authored content' },
      orderBy: { revNo: 'desc' },
    })).toMatchObject({
      authorshipKind: 'TASK', authoredByTask: task.id, authoredByRevision: 1, authoredAt,
    });
  });

  it('restoring over existing nodes is a revisioned write — drift reconciled first (#1339 review)', async () => {
    // @copilot: the restore upsert rewrote existing system nodes with no
    // NodeRevision and no fingerprint refresh, so the next exposed read
    // mistook the restore for a raw writer and lost its real predecessor.
    const node = await db.node.create({
      data: { id: generateId(), memoryId: systemMemory.id, loc: 'prompts:main', name: 'main', nodeType: 'system', content: 'v1' },
    });
    await resolvers.Mutation.createRevision({}, { agentId: agent.id, description: 'v1' }, adminCtx());
    await db.node.update({ where: { id: node.id }, data: { content: 'changed by a raw writer' } });

    await resolvers.Mutation.restoreRevision({}, { agentId: agent.id, revisionLoc: 'revisions:rev-1' }, adminCtx());

    const after = await db.node.findUniqueOrThrow({ where: { id: node.id } });
    expect(after.content).toBe('v1');
    const history = await db.nodeRevision.findMany({ where: { nodeId: node.id }, orderBy: { revNo: 'asc' } });
    expect(history.map((r) => r.revLabel)).toEqual([
      'Reconciled state changed outside a revisioned writer (#1323)',
      'Restored from a published agent snapshot',
    ]);
    expect(history[1]!.content).toBe('changed by a raw writer');
    expect(after.revSeq).toBe(3);
    // The fingerprint was refreshed, so an exposed read has nothing to reconcile.
    expect(await resolvers.Node.revision(after as never, {}, adminCtx())).toBe(3);
    expect(await db.nodeRevision.count({ where: { nodeId: node.id } })).toBe(2);
  });

  it('restores nodes from a snapshot and auto-saves current state', async () => {
    // Create initial revision
    await resolvers.Mutation.createRevision({}, { agentId: agent.id, description: 'v1' }, adminCtx());

    // Modify the system memory (add a new node)
    await db.node.create({
      data: {
        id: generateId(), memoryId: systemMemory.id,
        loc: 'conversations:goodbye', name: 'goodbye', nodeType: 'system',
        data: { stageOrder: [], isSetup: false },
      },
    });

    // Restore to rev-1 (should remove the goodbye conversation)
    const result = await resolvers.Mutation.restoreRevision(
      {},
      { agentId: agent.id, revisionLoc: 'revisions:rev-1' },
      adminCtx(),
    );

    expect(result.revisionLoc).toBe('revisions:rev-1');

    // The goodbye conversation should be gone (deleted)
    const goodbye = await db.node.findFirst({
      where: { memoryId: systemMemory.id, loc: 'conversations:goodbye', deletedAt: null },
    });
    expect(goodbye).toBeNull();

    // The original nodes should still exist
    const hello = await db.node.findFirst({
      where: { memoryId: systemMemory.id, loc: 'conversations:hello', deletedAt: null },
    });
    expect(hello).toBeTruthy();

    // An auto-save revision should have been created (rev-2)
    const autoSave = await db.node.findFirst({
      where: { memoryId: systemMemory.id, loc: 'revisions:rev-2', deletedAt: null },
    });
    expect(autoSave).toBeTruthy();
    expect(((autoSave?.data as Record<string, unknown>).snapshot as any).nodes.length).toBeGreaterThan(6);
  });

  // Regression (#752, Copilot): the restore soft-deletes existing edges, whose
  // (loc, memoryId) slot survives the soft-delete (Edge @@unique is unfiltered).
  // Re-creating snapshot edges with `create` would hit the unique index for any
  // graph that already had an edge at that loc; the restore must upsert-resurrect.
  it('restores a snapshot containing edges without a unique-constraint failure', async () => {
    const hello = await db.node.findFirstOrThrow({
      where: { memoryId: systemMemory.id, loc: 'conversations:hello' },
    });
    const greet = await db.node.findFirstOrThrow({
      where: { memoryId: systemMemory.id, loc: 'conversations:hello:greet' },
    });
    await db.edge.create({
      data: {
        id: generateId(), memoryId: systemMemory.id,
        sourceId: hello.id, targetId: greet.id,
        loc: 'conversations:hello:step:greet', name: 'step',
      },
    });

    // Snapshot the graph WITH the edge, then restore it. The restore's preamble
    // soft-deletes the live edge, so the snapshot edge collides on (loc, memoryId)
    // unless it's upserted — before the fix this threw a P2002 unique violation.
    await resolvers.Mutation.createRevision({}, { agentId: agent.id, description: 'v1' }, adminCtx());
    const result = await resolvers.Mutation.restoreRevision(
      {},
      { agentId: agent.id, revisionLoc: 'revisions:rev-1' },
      adminCtx(),
    );
    expect(result.revisionLoc).toBe('revisions:rev-1');

    // Exactly one LIVE edge at that loc survives the round-trip (resurrected,
    // not duplicated).
    const liveEdges = await db.edge.findMany({
      where: { memoryId: systemMemory.id, loc: 'conversations:hello:step:greet', deletedAt: null },
    });
    expect(liveEdges).toHaveLength(1);
    expect(liveEdges[0]?.sourceId).toBe(hello.id);
    expect(liveEdges[0]?.targetId).toBe(greet.id);
  });

  // 007-entity-id-or-urn: restoreRevision accepts agentId as ID or URN.
  it('accepts a URN as agentId input', async () => {
    await resolvers.Mutation.createRevision({}, { agentId: agent.id, description: 'v1' }, adminCtx());
    const stored = await db.agent.findUniqueOrThrow({
      where: { id: agent.id },
      select: { urn: true },
    });
    const result = await resolvers.Mutation.restoreRevision(
      {},
      { agentId: stored.urn, revisionLoc: 'revisions:rev-1' },
      adminCtx(),
    );
    expect(result.revisionLoc).toBe('revisions:rev-1');
  });
});

describe('Editor lock', () => {
  it('acquires a lock for the first user', async () => {
    const result = await resolvers.Mutation.acquireEditorLock(
      {},
      { agentId: agent.id },
      adminCtx(),
    );
    expect(result.locked).toBe(true);
    expect(result.lockedBy).toBe(adminUser.id);
  });

  it('rejects a second user while lock is active', async () => {
    await resolvers.Mutation.acquireEditorLock({}, { agentId: agent.id }, adminCtx());

    const result = await resolvers.Mutation.acquireEditorLock(
      {},
      { agentId: agent.id },
      adminCtx(otherAdmin.id),
    );
    expect(result.locked).toBe(false);
    expect(result.lockedBy).toBe(adminUser.id);
  });

  it('allows the same user to renew their lock', async () => {
    await resolvers.Mutation.acquireEditorLock({}, { agentId: agent.id }, adminCtx());

    const result = await resolvers.Mutation.acquireEditorLock(
      {},
      { agentId: agent.id },
      adminCtx(), // same user
    );
    expect(result.locked).toBe(true);
  });

  it('releases the lock', async () => {
    await resolvers.Mutation.acquireEditorLock({}, { agentId: agent.id }, adminCtx());
    await resolvers.Mutation.releaseEditorLock({}, { agentId: agent.id }, adminCtx());

    // Now another user can acquire it
    const result = await resolvers.Mutation.acquireEditorLock(
      {},
      { agentId: agent.id },
      adminCtx(otherAdmin.id),
    );
    expect(result.locked).toBe(true);
    expect(result.lockedBy).toBe(otherAdmin.id);
  });

  // 007-entity-id-or-urn: editor-lock pair accepts agentId as ID or URN.
  it('acquireEditorLock accepts a URN as agentId input', async () => {
    const stored = await db.agent.findUniqueOrThrow({
      where: { id: agent.id },
      select: { urn: true },
    });
    const result = await resolvers.Mutation.acquireEditorLock(
      {},
      { agentId: stored.urn },
      adminCtx(),
    );
    expect(result.locked).toBe(true);
    expect(result.lockedBy).toBe(adminUser.id);
  });

  it('releaseEditorLock accepts a URN as agentId input', async () => {
    await resolvers.Mutation.acquireEditorLock({}, { agentId: agent.id }, adminCtx());
    const stored = await db.agent.findUniqueOrThrow({
      where: { id: agent.id },
      select: { urn: true },
    });
    const released = await resolvers.Mutation.releaseEditorLock(
      {},
      { agentId: stored.urn },
      adminCtx(),
    );
    expect(released).toBe(true);
    const updated = await db.agent.findUnique({ where: { id: agent.id } });
    expect(updated?.editorLockUserId).toBeNull();
  });
});

// #1468 (Codex on #1475) — createAgent may promote an existing memory into an
// agent's system memory, so a system memory can hold a minted corpus.
describe('#1468 — minted specs in an agent system memory', () => {
  const permanent = (e: unknown) =>
    (e as { extensions?: { code?: string } }).extensions?.code === 'SPEC_MINTED_PERMANENT';
  const stamp = () => db.memory.update({ where: { id: systemMemory.id }, data: { corpusDraft: false, corpusMintedAt: new Date() } });

  it('restoreRevision refuses a snapshot that would drop a live minted spec', async () => {
    await resolvers.Mutation.createRevision({}, { agentId: agent.id, description: 'before the spec' }, adminCtx());
    const spec = await db.node.create({
      data: { id: generateId(), memoryId: systemMemory.id, loc: 'pas:010', name: 'pas:010', tags: ['spec'] },
    });
    await stamp();
    await expect(resolvers.Mutation.restoreRevision({}, { agentId: agent.id, revisionLoc: 'revisions:rev-1' }, adminCtx()))
      .rejects.toSatisfy(permanent);
    expect(await db.node.findUniqueOrThrow({ where: { id: spec.id } })).toMatchObject({ deletedAt: null });
  });

  it('restoreRevision refuses restoring a minted spec from a snapshot without its marker', async () => {
    const n = await db.node.create({ data: { id: generateId(), memoryId: systemMemory.id, loc: 'pas:020', name: 'pas:020' } });
    await resolvers.Mutation.createRevision({}, { agentId: agent.id, description: 'unmarked' }, adminCtx());
    await db.node.update({ where: { id: n.id }, data: { tags: ['spec'], revisionContentHash: revisionStateHashRefreshMarker() } });
    await stamp();
    await expect(resolvers.Mutation.restoreRevision({}, { agentId: agent.id, revisionLoc: 'revisions:rev-1' }, adminCtx()))
      .rejects.toSatisfy(permanent);
    expect(await db.node.findUniqueOrThrow({ where: { id: n.id } })).toMatchObject({ tags: ['spec'], deletedAt: null });
  });

  it('control: restoreRevision still restores over an unstamped system memory holding a spec', async () => {
    await resolvers.Mutation.createRevision({}, { agentId: agent.id, description: 'before the spec' }, adminCtx());
    const spec = await db.node.create({
      data: { id: generateId(), memoryId: systemMemory.id, loc: 'pas:030', name: 'pas:030', tags: ['spec'] },
    });
    await resolvers.Mutation.restoreRevision({}, { agentId: agent.id, revisionLoc: 'revisions:rev-1' }, adminCtx());
    expect((await db.node.findUniqueOrThrow({ where: { id: spec.id } })).deletedAt).not.toBeNull();
  });

  it('deleteAgent refuses while its system memory holds a minted spec, deleting nothing', async () => {
    await db.node.create({ data: { id: generateId(), memoryId: systemMemory.id, loc: 'pas:040', name: 'pas:040', role: 'spec' } });
    await stamp();
    await expect(resolvers.Mutation.deleteAgent({}, { ref: agent.id }, adminCtx())).rejects.toSatisfy(permanent);
    expect(await db.agent.findUniqueOrThrow({ where: { id: agent.id } })).toMatchObject({ deletedAt: null });
    expect(await db.memory.findUniqueOrThrow({ where: { id: systemMemory.id } })).toMatchObject({ deletedAt: null });
  });

  it('control: deleteAgent still deletes an agent whose system memory holds no minted spec', async () => {
    expect(await resolvers.Mutation.deleteAgent({}, { ref: agent.id }, adminCtx())).toBe(true);
    expect((await db.agent.findUniqueOrThrow({ where: { id: agent.id } })).deletedAt).not.toBeNull();
    expect((await db.memory.findUniqueOrThrow({ where: { id: systemMemory.id } })).deletedAt).not.toBeNull();
  });
});
