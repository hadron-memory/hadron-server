/**
 * Tests for chatbot revisions: snapshot, publish, restore, editor lock.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { generateId } from '../../../lib/id.js';

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
