/**
 * #882 — retryFailedEmbeddings(memoryRef): the operator re-drive for failed
 * embeds. Before this mutation, recovering a node whose embed had failed
 * permanently (pendingAt cleared) required a hand-written SQL re-stamp that
 * also had to remember to reset embeddingAttempts — the documented contract
 * nobody follows. This pins:
 *
 *   - failed nodes (pendingAt cleared OR backed-off) are re-stamped with a
 *     due pendingAt and a fully reset failure state;
 *   - healthy nodes and soft-deleted nodes are untouched;
 *   - a non-vector-indexed memory returns 0 without stamping anything;
 *   - authorization matches updateMemory (org-ADMIN; a plain member is
 *     refused).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbNode } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

const M = resolvers.Mutation as any;
const ctx = (o: Partial<Context> = {}): Context => ({ db, ...o });

let org: { id: string };
let mem: { id: string; urn: string };
let admin: { id: string };
let member: { id: string };

const asAdmin = () => ctx({ userId: admin.id, roles: ['READER'] });
const asMember = () => ctx({ userId: member.id, roles: ['READER'] });

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({
    data: { id: generateId(), name: 'rfe-org', urn: 'rfe-org' },
  });
  mem = (await db.memory.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: 'rfe-org:rfe-mem',
      name: 'rfe-mem',
      class: 'knowledge',
      visibility: 'ORGANIZATION',
      vectorIndexEnabled: true,
    },
  })) as any;
  admin = await db.user.create({ data: { githubId: 9921, githubUsername: 'rfe-admin', roles: ['READER'] } });
  member = await db.user.create({ data: { githubId: 9922, githubUsername: 'rfe-member', roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: member.id, role: 'CONTRIBUTOR' } });
});

/** A node in the terminal pre-#882 shape: failed, pendingAt cleared. */
async function makeFailedNode(loc: string, extra: Record<string, unknown> = {}): Promise<string> {
  const n = await createDbNode(db, { loc, memoryId: mem.id, content: `body of ${loc}` });
  await db.node.update({
    where: { id: n.id },
    data: {
      embeddingPendingAt: null,
      embeddingFailedAt: new Date(),
      embeddingError: 'Your invocation timed out while waiting for a response from container primary',
      embeddingAttempts: 5,
      ...extra,
    },
  });
  return n.id;
}

describe('retryFailedEmbeddings (#882)', () => {
  it('re-stamps failed nodes (terminal AND backed-off) and resets their failure state', async () => {
    const terminalId = await makeFailedNode('dead');
    // A backed-off retryable failure: pendingAt future-dated.
    const backedOffId = await makeFailedNode('backed-off', {
      embeddingPendingAt: new Date(Date.now() + 60 * 60 * 1000),
      embeddingAttempts: 3,
    });
    const healthy = await createDbNode(db, { loc: 'healthy', memoryId: mem.id });

    const count = await M.retryFailedEmbeddings(null, { memoryRef: mem.id }, asAdmin());
    expect(count).toBe(2);

    for (const id of [terminalId, backedOffId]) {
      const n = await db.node.findUniqueOrThrow({ where: { id } });
      expect(n.embeddingPendingAt).not.toBeNull();
      expect(n.embeddingPendingAt!.getTime()).toBeLessThanOrEqual(Date.now()); // immediately due
      expect(n.embeddingFailedAt).toBeNull();
      expect(n.embeddingError).toBeNull();
      expect(n.embeddingAttempts).toBe(0);
    }
    // Healthy node untouched.
    const h = await db.node.findUniqueOrThrow({ where: { id: healthy.id } });
    expect(h.embeddingPendingAt).toBeNull();
  });

  it('accepts a memory URN as the ref', async () => {
    await makeFailedNode('dead');
    const count = await M.retryFailedEmbeddings(
      null,
      { memoryRef: `hrn:memory:${mem.urn.replace(':', '::')}` },
      asAdmin(),
    );
    expect(count).toBe(1);
  });

  it('ignores soft-deleted nodes', async () => {
    await makeFailedNode('dead-deleted', { deletedAt: new Date() });
    const count = await M.retryFailedEmbeddings(null, { memoryRef: mem.id }, asAdmin());
    expect(count).toBe(0);
  });

  it('returns 0 without stamping when the memory is not vector-indexed', async () => {
    await db.memory.update({ where: { id: mem.id }, data: { vectorIndexEnabled: false } });
    const id = await makeFailedNode('dead');
    const count = await M.retryFailedEmbeddings(null, { memoryRef: mem.id }, asAdmin());
    expect(count).toBe(0);
    const n = await db.node.findUniqueOrThrow({ where: { id } });
    expect(n.embeddingPendingAt).toBeNull(); // untouched — no discarded work queued
  });

  it('refuses a non-admin org member (same gate as updateMemory)', async () => {
    await makeFailedNode('dead');
    await expect(
      M.retryFailedEmbeddings(null, { memoryRef: mem.id }, asMember()),
    ).rejects.toThrow();
    const n = await db.node.findFirstOrThrow({ where: { memoryId: mem.id, loc: 'dead' } });
    expect(n.embeddingPendingAt).toBeNull();
  });
});
