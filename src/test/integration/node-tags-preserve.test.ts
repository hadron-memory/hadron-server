/**
 * hadron-cli#37 — `upsertNode` tags partial-update semantics.
 *
 * Regression guard for a silent data-loss bug: a content-only update
 * (no `tags` key in the input) was clearing the node's `tags` column,
 * because the resolver wrote `serializeTags(input.tags ?? [])` into the
 * UPDATE payload unconditionally. For spec corpora that means a
 * content-only edit drops the `spec`/`p*` tags and the node silently
 * leaves the corpus (gone from `spec describe`/`lint`/`get --prefix`)
 * while still resolving by URN.
 *
 * The contract this pins (mirrors the abstract partial-update matrix in
 * node-abstract.test.ts, FR-004):
 *   - tags omitted (key absent / undefined) → PRESERVE existing
 *   - tags: []   (explicit empty array)     → CLEAR
 *   - tags: null (runtime null)             → CLEAR
 *   - tags: [..] (explicit array)           → REPLACE
 * On CREATE, absent tags default to [] (a fresh node has none to preserve).
 *
 * Also asserts the sibling preserve guarantees the issue called out —
 * a content-only update must leave `nodeType` and `data` untouched.
 *
 * Constitution refinement I — graph-touching mutation, integration test
 * against the real `hadron_test` DB (pinned by vitest.config.ts).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { generateId } from '../../lib/id.js';
import { deserializeTags } from '../../integrations/db/provider.js';

// upsertNode fires writeNodeToGit asynchronously; pin to a no-op so the
// test doesn't try to push to a real remote.
vi.mock('../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

interface Fixture {
  ctx: Context;
  memory: { id: string; urn: string };
}

let fx: Fixture;

beforeEach(async () => {
  await cleanDb(db);

  const org = await db.organization.create({
    data: { id: generateId(), name: 'gq-tags-org', urn: 'gq-tags-org' },
  });
  const admin = await db.user.create({
    data: { githubId: 9811, githubUsername: 'gq-tags-admin', roles: ['ADMIN'] },
  });
  await db.orgMember.create({
    data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
  });

  const ctx: Context = {
    db,
    roles: ['ADMIN'],
    userId: admin.id,
    clientId: `user:${admin.id}`,
  };
  const memory = await resolvers.Mutation.createMemory(
    {},
    { orgId: org.id, name: 'gqmem' },
    ctx,
  );

  fx = { ctx, memory };
});

// ───── helpers ────────────────────────────────────────────────────────────

async function upsertNode(input: Record<string, unknown>) {
  return resolvers.Mutation.upsertNode(
    {},
    { input: { memoryId: fx.memory.id, ...input } as never },
    fx.ctx,
  );
}

async function persistedTags(loc: string): Promise<string[]> {
  const node = await db.node.findFirst({
    where: { loc, memoryId: fx.memory.id, deletedAt: null },
    select: { tags: true },
  });
  return deserializeTags((node?.tags ?? []) as string[] | string);
}

// ───── create mode ─────────────────────────────────────────────────────────

describe('upsertNode — create mode tags', () => {
  it('persists tags supplied on create', async () => {
    await upsertNode({ loc: 'c1', name: 'c1', tags: ['spec', 'p1'] });
    expect(await persistedTags('c1')).toEqual(['spec', 'p1']);
  });

  it('a create without tags leaves the column empty', async () => {
    await upsertNode({ loc: 'c2', name: 'c2' });
    expect(await persistedTags('c2')).toEqual([]);
  });
});

// ───── update mode partial-update semantics ─────────────────────────────────

describe('upsertNode — update mode tags partial-update semantics', () => {
  it('a content-only update PRESERVES existing tags (hadron-cli#37)', async () => {
    await upsertNode({ loc: 'u1', name: 'u1', tags: ['spec', 'p1'], content: 'orig' });
    // The exact reproduction: update content, no `tags` key.
    await upsertNode({ loc: 'u1', name: 'u1', content: 'revised body' });
    expect(await persistedTags('u1')).toEqual(['spec', 'p1']);
  });

  it('an explicit tags array REPLACES the existing tags', async () => {
    await upsertNode({ loc: 'u2', name: 'u2', tags: ['spec', 'p1'] });
    await upsertNode({ loc: 'u2', name: 'u2', tags: ['spec', 'p2'] });
    expect(await persistedTags('u2')).toEqual(['spec', 'p2']);
  });

  it('an explicit empty array CLEARS the tags', async () => {
    await upsertNode({ loc: 'u3', name: 'u3', tags: ['spec'] });
    await upsertNode({ loc: 'u3', name: 'u3', tags: [] });
    expect(await persistedTags('u3')).toEqual([]);
  });

  it('an explicit null CLEARS the tags', async () => {
    await upsertNode({ loc: 'u4', name: 'u4', tags: ['spec'] });
    await upsertNode({ loc: 'u4', name: 'u4', tags: null });
    expect(await persistedTags('u4')).toEqual([]);
  });

  it('a non-tags field update (name only) PRESERVES tags', async () => {
    await upsertNode({ loc: 'u5', name: 'u5', tags: ['spec', 'p3'] });
    await upsertNode({ loc: 'u5', name: 'u5-renamed' });
    expect(await persistedTags('u5')).toEqual(['spec', 'p3']);
  });
});

// ───── sibling preserve guarantees on a content-only update ─────────────────

describe('upsertNode — content-only update preserves siblings (hadron-cli#37)', () => {
  it('leaves tags, nodeType, and data untouched when only content changes', async () => {
    await upsertNode({
      loc: 'sib1',
      name: 'sib1',
      nodeType: 'spec',
      tags: ['spec', 'p1'],
      data: { version: 3 },
      content: 'original',
    });

    await upsertNode({ loc: 'sib1', name: 'sib1', content: 'edited' });

    const node = await db.node.findFirst({
      where: { loc: 'sib1', memoryId: fx.memory.id, deletedAt: null },
      select: { tags: true, nodeType: true, data: true, content: true },
    });
    expect(deserializeTags((node?.tags ?? []) as string[] | string)).toEqual(['spec', 'p1']);
    expect(node?.nodeType).toBe('spec');
    expect(node?.data).toEqual({ version: 3 });
    expect(node?.content).toBe('edited');
  });
});
