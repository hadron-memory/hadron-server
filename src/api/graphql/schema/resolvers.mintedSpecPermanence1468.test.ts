/**
 * #1468 — a spec in a mint-stamped corpus is permanent: no path may remove it.
 *
 * Only a corpus stamped by `mintSpecCorpus` (`corpusMintedAt` set) is
 * protected (Holger, team chat #4370). Draft corpora, and never-stamped
 * non-draft memories such as the live platform specs corpus, keep today's
 * behaviour. A spec is anything with the spec marker: a `spec` tag or a
 * `spec`/`spec.*` role.
 */
import { describe, it, expect, beforeEach, vi, beforeAll, afterAll } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import type { AuthContext } from '../../../middleware/auth.js';
import { generateId } from '../../../lib/id.js';
import { ensureChannelWithRoot } from '../../../lib/channels.js';
import { SPEC_MINTED_PERMANENT, assertNoMintedSpecUnmark } from '../../../lib/mintedSpecPermanence.js';
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

let org: { id: string; urn: string };
let admin: { id: string };
let minted: { id: string; urn: string };
let draft: { id: string; urn: string };
let unstamped: { id: string; urn: string };

const ctx = (): Context => ({ db, roles: ['ADMIN'], userId: admin.id }) as Context;
const auth = (): AuthContext => ({ userId: admin.id, roles: ['ADMIN'], clientId: `user:${admin.id}` });
const refusedPermanent = (e: unknown) =>
  e instanceof GraphQLError && e.extensions.code === SPEC_MINTED_PERMANENT && /[Ss]upersede/.test(e.message);

async function memory(name: string, state: { corpusDraft?: boolean; corpusMintedAt?: Date | null; deletedAt?: Date | null }) {
  return db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:${name}`, name, class: 'knowledge', ...state },
    select: { id: true, urn: true },
  });
}

async function node(
  memoryId: string,
  loc: string,
  marker: { tags?: string[]; role?: string | null; deletedAt?: Date | null } = {},
) {
  return db.node.create({
    data: {
      id: generateId(), memoryId, loc, name: loc, content: `body of ${loc}`,
      tags: marker.tags ?? [], role: marker.role ?? null, deletedAt: marker.deletedAt ?? null,
    },
  });
}

const liveIds = async (memoryId: string) =>
  (await db.node.findMany({ where: { memoryId, deletedAt: null }, select: { loc: true } })).map((n) => n.loc).sort();

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'mp-org', urn: 'mp-org' } });
  admin = await db.user.create({ data: { githubId: 14680, githubUsername: 'mp-admin', handle: 'mp-admin', roles: ['ADMIN'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  minted = await memory('minted', { corpusDraft: false, corpusMintedAt: new Date() });
  draft = await memory('draft', { corpusDraft: true });
  unstamped = await memory('unstamped', { corpusDraft: false, corpusMintedAt: null });
});

describe('#1468 — GraphQL deleteNode', () => {
  const del = (nodeRef: string, opts: { hard?: boolean; recursive?: boolean } = {}) =>
    resolvers.Mutation.deleteNode({}, { nodeRef, ...opts }, ctx());

  it('refuses soft-deleting a tag-marked spec in a minted corpus, naming supersede', async () => {
    const spec = await node(minted.id, 'pas:010', { tags: ['spec'] });
    await expect(del(spec.id)).rejects.toSatisfy(refusedPermanent);
    expect(await db.node.findUniqueOrThrow({ where: { id: spec.id } })).toMatchObject({ deletedAt: null });
  });

  it('refuses hard-deleting a role-marked spec (no tag) in a minted corpus', async () => {
    const spec = await node(minted.id, 'pas:020', { role: 'spec' });
    await expect(del(spec.id, { hard: true })).rejects.toSatisfy(refusedPermanent);
    expect(await db.node.findUnique({ where: { id: spec.id } })).not.toBeNull();
  });

  it('refuses a recursive delete of a NON-spec ancestor that holds a spec, removing nothing', async () => {
    const parent = await node(minted.id, 'pas');
    await node(minted.id, 'pas:030', { role: 'spec.rule' });
    await node(minted.id, 'pas:notes');
    await expect(del(parent.id, { recursive: true })).rejects.toSatisfy(refusedPermanent);
    expect(await liveIds(minted.id)).toEqual(['pas', 'pas:030', 'pas:notes']);
  });

  it('refuses hard-deleting an already-tombstoned spec (a hard delete also removes tombstones)', async () => {
    const spec = await node(minted.id, 'pas:040', { tags: ['spec'], deletedAt: new Date() });
    await expect(del(spec.id, { hard: true })).rejects.toSatisfy(refusedPermanent);
    expect(await db.node.findUnique({ where: { id: spec.id } })).not.toBeNull();
  });

  it('control: a non-spec node in a minted corpus still deletes, soft and hard', async () => {
    const note = await node(minted.id, 'readme', { tags: ['special'], role: 'special' });
    expect(await del(note.id)).toBe(true);
    expect(await del(note.id, { hard: true })).toBe(true);
    expect(await db.node.findUnique({ where: { id: note.id } })).toBeNull();
  });

  it('control: a draft corpus keeps spec deletion, soft, hard and recursive', async () => {
    const a = await node(draft.id, 'pas:010', { tags: ['spec'] });
    expect(await del(a.id)).toBe(true);
    const parent = await node(draft.id, 'mod');
    // A spec-role node is governed: its role is cleared first, as a caller must.
    await node(draft.id, 'mod:010', { role: null, tags: ['spec'] });
    expect(await del(parent.id, { recursive: true, hard: true })).toBe(true);
    expect(await liveIds(draft.id)).toEqual([]);
  });

  it('control: a never-stamped non-draft memory (the live-corpus case) is outside this guard', async () => {
    // Cleared first: the governed-node rule is a separate guard from this one.
    const spec = await node(unstamped.id, 'pas:010', { tags: ['spec'], role: null });
    expect(await del(spec.id)).toBe(true);
  });
});

describe('#1468 — MCP hadron_delete_node', () => {
  const del = (urn: string, opts: { hard?: boolean; recursive?: boolean } = {}) =>
    createTestableMcpServer(auth()).callToolText('hadron_delete_node', { urn, ...opts });

  it('refuses a spec in a minted corpus with [spec_minted_permanent], soft and hard', async () => {
    const spec = await node(minted.id, 'pas:010', { tags: ['spec'] });
    for (const hard of [false, true]) {
      const text = await del(`hrn:node:${minted.urn}:pas:010`, { hard });
      expect(text).toMatch(/^\[spec_minted_permanent\].*[Ss]upersede/);
    }
    expect(await db.node.findUniqueOrThrow({ where: { id: spec.id } })).toMatchObject({ deletedAt: null });
  });

  it('refuses a recursive delete whose subtree holds a spec, removing nothing', async () => {
    await node(minted.id, 'pas');
    await node(minted.id, 'pas:020', { role: 'spec' });
    const text = await del(`hrn:node:${minted.urn}:pas`, { recursive: true });
    expect(text).toMatch(/^\[spec_minted_permanent\]/);
    expect(await liveIds(minted.id)).toEqual(['pas', 'pas:020']);
  });

  it('control: deletes a spec in a draft corpus', async () => {
    await node(draft.id, 'pas:010', { tags: ['spec'] });
    const text = await del(`hrn:node:${draft.urn}:pas:010`);
    expect(text).toMatch(/^Soft-deleted/);
    expect(await liveIds(draft.id)).toEqual([]);
  });
});

describe('#1468 — mergeNodes, moves and extract', () => {
  it('mergeNodes refuses deleteSource on a minted spec; keeps it without deleteSource', async () => {
    const spec = await node(minted.id, 'pas:010', { tags: ['spec'] });
    const other = await node(minted.id, 'pas:011', { tags: ['spec'] });
    await expect(resolvers.Mutation.mergeNodes({}, {
      input: { source: spec.id, target: other.id, include: ['TAGS'], deleteSource: true },
    } as never, ctx())).rejects.toSatisfy(refusedPermanent);
    expect(await db.node.findUnique({ where: { id: spec.id } })).not.toBeNull();
    await resolvers.Mutation.mergeNodes({}, {
      input: { source: spec.id, target: other.id, include: ['TAGS'], deleteSource: false },
    } as never, ctx());
    expect(await db.node.findUnique({ where: { id: spec.id } })).not.toBeNull();
  });

  it('GraphQL moveNode refuses moving a minted spec to another memory, but renames it in place', async () => {
    const spec = await node(minted.id, 'pas:010', { role: 'spec' });
    await expect(resolvers.Mutation.moveNode({}, { sourceRef: spec.id, targetMemoryRef: draft.id }, ctx()))
      .rejects.toSatisfy(refusedPermanent);
    expect(await db.node.findUniqueOrThrow({ where: { id: spec.id } })).toMatchObject({ memoryId: minted.id, loc: 'pas:010' });

    await resolvers.Mutation.moveNode({}, { sourceRef: spec.id, targetUrn: `hrn:node:${minted.urn}:pas:099` }, ctx());
    expect(await db.node.findUniqueOrThrow({ where: { id: spec.id } })).toMatchObject({ memoryId: minted.id, loc: 'pas:099' });
  });

  it('GraphQL moveNode refuses a subtree whose descendant is a minted spec; a draft subtree moves', async () => {
    const parent = await node(minted.id, 'pas');
    await node(minted.id, 'pas:010', { tags: ['spec'] });
    await expect(resolvers.Mutation.moveNode({}, { sourceRef: parent.id, targetMemoryRef: unstamped.id }, ctx()))
      .rejects.toSatisfy(refusedPermanent);
    expect(await liveIds(minted.id)).toEqual(['pas', 'pas:010']);

    const draftParent = await node(draft.id, 'mod');
    await node(draft.id, 'mod:010', { tags: ['spec'] });
    await resolvers.Mutation.moveNode({}, { sourceRef: draftParent.id, targetMemoryRef: unstamped.id }, ctx());
    expect(await liveIds(draft.id)).toEqual([]);
  });

  it('MCP hadron_move_node refuses moving a minted spec out of its corpus', async () => {
    await node(minted.id, 'pas:010', { tags: ['spec'] });
    const text = await createTestableMcpServer(auth()).callToolText('hadron_move_node', {
      urn: `hrn:node:${minted.urn}:pas:010`, targetUrn: `hrn:node:${draft.urn}:pas:010`,
    });
    expect(text).toMatch(/^\[spec_minted_permanent\]/);
    expect(await liveIds(minted.id)).toEqual(['pas:010']);
  });

  it('MCP hadron_move_node(overwrite) refuses evicting a minted spec from its citation', async () => {
    const spec = await node(minted.id, 'pas:010', { tags: ['spec'] });
    const incoming = await node(draft.id, 'incoming');
    const text = await createTestableMcpServer(auth()).callToolText('hadron_move_node', {
      urn: `hrn:node:${draft.urn}:incoming`, targetUrn: `hrn:node:${minted.urn}:pas:010`, overwrite: true,
    });
    expect(text).toMatch(/^\[spec_minted_permanent\]/);
    expect(await db.node.findUniqueOrThrow({ where: { id: spec.id } })).toMatchObject({ loc: 'pas:010', deletedAt: null });
    expect(await db.node.findUniqueOrThrow({ where: { id: incoming.id } })).toMatchObject({ memoryId: draft.id, loc: 'incoming' });
  });

  it('control: MCP overwrite still evicts a non-spec occupant of a minted corpus', async () => {
    const note = await node(minted.id, 'notes');
    await node(draft.id, 'incoming');
    const text = await createTestableMcpServer(auth()).callToolText('hadron_move_node', {
      urn: `hrn:node:${draft.urn}:incoming`, targetUrn: `hrn:node:${minted.urn}:notes`, overwrite: true,
    });
    expect(text).not.toMatch(/spec_minted_permanent/);
    expect(await db.node.findUniqueOrThrow({ where: { id: note.id } })).toMatchObject({ deletedAt: expect.any(Date) });
  });

  it('extract refuses move:true over a subtree holding a minted spec; copy is allowed', async () => {
    const parent = await node(minted.id, 'pas');
    await node(minted.id, 'pas:010', { role: 'spec' });
    await node(minted.id, 'readme'); // extract refuses to empty its source memory
    await expect(resolvers.Mutation.extractParentNodeToMemory({}, {
      parentRef: parent.id, targetUrn: `hrn:mem:${org.urn}:extracted-move`, move: true,
    }, ctx())).rejects.toSatisfy(refusedPermanent);
    expect(await liveIds(minted.id)).toEqual(['pas', 'pas:010', 'readme']);

    await resolvers.Mutation.extractParentNodeToMemory({}, {
      parentRef: parent.id, targetUrn: `hrn:mem:${org.urn}:extracted-copy`, move: false,
    }, ctx());
    expect(await liveIds(minted.id)).toEqual(['pas', 'pas:010', 'readme']);
  });
});

describe('#1468 — the spec marker stays on a minted spec (Vera #4403)', () => {
  const update = (id: string, input: Record<string, unknown>) =>
    resolvers.Mutation.updateNode({}, { input: { id, ...input } } as never, ctx());
  const tagsOf = async (id: string) => (await db.node.findUniqueOrThrow({ where: { id } })).tags;

  it("closes the bypass: dropping a minted spec's tag is refused, so the delete after it still refuses", async () => {
    const spec = await node(minted.id, 'pas:010', { tags: ['spec', 'core'] });
    await expect(update(spec.id, { tags: ['core'] })).rejects.toSatisfy(refusedPermanent);
    expect(await tagsOf(spec.id)).toEqual(['spec', 'core']);
    await expect(resolvers.Mutation.deleteNode({}, { nodeRef: spec.id }, ctx())).rejects.toSatisfy(refusedPermanent);
  });

  it('control: a minted spec still takes edits that keep its marker, including tag edits', async () => {
    const spec = await node(minted.id, 'pas:010', { tags: ['spec'] });
    await update(spec.id, { content: 'revised', tags: ['spec', 'core'] });
    expect(await db.node.findUniqueOrThrow({ where: { id: spec.id } })).toMatchObject({
      content: 'revised', tags: ['spec', 'core'],
    });
  });

  it('control: a draft corpus, and a never-stamped memory, still allow dropping the marker', async () => {
    const a = await node(draft.id, 'pas:010', { tags: ['spec'] });
    const b = await node(unstamped.id, 'pas:010', { tags: ['spec'] });
    await update(a.id, { tags: [] });
    await update(b.id, { tags: [] });
    expect([await tagsOf(a.id), await tagsOf(b.id)]).toEqual([[], []]);
  });

  it('MCP hadron_update_node refuses tags:[] on a minted spec', async () => {
    const spec = await node(minted.id, 'pas:010', { tags: ['spec'] });
    const text = await createTestableMcpServer(auth()).callToolText('hadron_update_node', {
      urn: `hrn:node:${minted.urn}:pas:010`, tags: [],
    });
    expect(text).toMatch(/^\[spec_minted_permanent\].*[Ss]upersede/);
    expect(await tagsOf(spec.id)).toEqual(['spec']);
  });

  it('MCP hadron_create_parent_node refuses a re-save whose omitted tags would clear the marker', async () => {
    const spec = await node(minted.id, 'pas', { tags: ['spec'] });
    const text = await createTestableMcpServer(auth()).callToolText('hadron_create_parent_node', {
      urn: `hrn:node:${minted.urn}:pas`, description: 'the pas module',
    });
    expect(text).toMatch(/^\[spec_minted_permanent\]/);
    expect(await tagsOf(spec.id)).toEqual(['spec']);
  });

  it('searchReplaceInNodes refuses a tag replace that unmarks a minted spec, writing nothing', async () => {
    const spec = await node(minted.id, 'pas:010', { tags: ['spec'] });
    const note = await node(minted.id, 'notes', { tags: ['spec-draft'] });
    await expect(resolvers.Mutation.searchReplaceInNodes({}, {
      input: { oldText: '^spec', newText: 'was', regex: true, fields: ['tags'], nodeIds: [spec.id, note.id] },
    } as never, ctx())).rejects.toSatisfy(refusedPermanent);
    expect([await tagsOf(spec.id), await tagsOf(note.id)]).toEqual([['spec'], ['spec-draft']]);
  });

  it('restoreNodeRevision refuses restoring a pre-mark revision of a minted spec', async () => {
    const n = await node(minted.id, 'pas:010');
    await update(n.id, { tags: ['spec'] });
    const before = await db.nodeRevision.findFirstOrThrow({ where: { nodeId: n.id, tags: { isEmpty: true } } });
    await expect(resolvers.Mutation.restoreNodeRevision({}, { revisionId: before.id }, ctx()))
      .rejects.toSatisfy(refusedPermanent);
    expect(await tagsOf(n.id)).toEqual(['spec']);
  });

  it('createNode over a post-mint spec tombstone refuses to revive it unmarked, GraphQL and MCP', async () => {
    const mintedAt = (await db.memory.findUniqueOrThrow({ where: { id: minted.id } })).corpusMintedAt!;
    const tomb = await node(minted.id, 'pas:010', { tags: ['spec'], deletedAt: new Date(mintedAt.getTime() + 1000) });
    await expect(resolvers.Mutation.createNode({}, {
      input: { memoryId: minted.id, loc: 'pas:010', name: 'n', content: 'x', tags: ['other'] },
    } as never, ctx())).rejects.toSatisfy(refusedPermanent);
    // MCP writes omitted tags as [], so the plain create is the unmark there.
    const text = await createTestableMcpServer(auth()).callToolText('hadron_create_node', {
      urn: `hrn:node:${minted.urn}:pas:010`, name: 'n', content: 'x',
    });
    expect(text).toMatch(/^\[spec_minted_permanent\]/);
    expect(await db.node.findUniqueOrThrow({ where: { id: tomb.id } })).toMatchObject({
      tags: ['spec'], deletedAt: expect.any(Date),
    });
  });

  it('MCP hadron_create_parent_node refuses unmarking a post-mint spec tombstone it re-saves (Codex P1)', async () => {
    const mintedAt = (await db.memory.findUniqueOrThrow({ where: { id: minted.id } })).corpusMintedAt!;
    const tomb = await node(minted.id, 'pas', { tags: ['spec'], deletedAt: new Date(mintedAt.getTime() + 1000) });
    const text = await createTestableMcpServer(auth()).callToolText('hadron_create_parent_node', {
      urn: `hrn:node:${minted.urn}:pas`, description: 'the pas module',
    });
    expect(text).toMatch(/^\[spec_minted_permanent\]/);
    expect(await db.node.findUniqueOrThrow({ where: { id: tomb.id } })).toMatchObject({ tags: ['spec'] });
  });

  describe('the guard itself (role markers, which the generic doors refuse to edit anyway)', () => {
    const check = (id: string, change: { tags?: string[]; role?: string | null }) =>
      db.$transaction((tx) => assertNoMintedSpecUnmark(tx, minted.id, [{ id, ...change }], 'update'));

    it('refuses clearing the only marker, a role', async () => {
      const spec = await node(minted.id, 'pas:010', { role: 'spec.rule' });
      await expect(check(spec.id, { role: null })).rejects.toSatisfy(refusedPermanent);
      await expect(check(spec.id, { role: 'note' })).rejects.toSatisfy(refusedPermanent);
    });

    it('allows swapping one marker for another, and changes that leave the marker alone', async () => {
      const spec = await node(minted.id, 'pas:010', { tags: ['spec'], role: 'spec' });
      await check(spec.id, { role: null });
      await check(spec.id, { tags: [] });
      await check(spec.id, { tags: ['spec'], role: 'spec.rule' });
      await check(spec.id, {});
    });

    it('protects a post-mint tombstone, but not one deleted before the mint', async () => {
      const mintedAt = (await db.memory.findUniqueOrThrow({ where: { id: minted.id } })).corpusMintedAt!;
      const late = await node(minted.id, 'pas:010', { tags: ['spec'], deletedAt: new Date(mintedAt.getTime() + 1000) });
      const early = await node(minted.id, 'pas:020', { tags: ['spec'], deletedAt: new Date(mintedAt.getTime() - 1000) });
      await expect(check(late.id, { tags: [] })).rejects.toSatisfy(refusedPermanent);
      await check(early.id, { tags: [] });
    });
  });
});

describe('#1468 — mergeMemories', () => {
  it('refuses emptying a minted corpus that holds a spec, before moving anything', async () => {
    await node(minted.id, 'pas:010', { tags: ['spec'] });
    await node(minted.id, 'notes');
    await expect(resolvers.Mutation.mergeMemories({}, {
      input: { source: minted.id, target: unstamped.id },
    } as never, ctx())).rejects.toSatisfy(refusedPermanent);
    expect(await liveIds(minted.id)).toEqual(['notes', 'pas:010']);
    expect(await liveIds(unstamped.id)).toEqual([]);
  });

  it('control: merges a draft corpus holding specs', async () => {
    await node(draft.id, 'pas:010', { tags: ['spec'] });
    await resolvers.Mutation.mergeMemories({}, { input: { source: draft.id, target: unstamped.id } } as never, ctx());
    expect(await liveIds(unstamped.id)).toEqual(['pas:010']);
  });
});

describe('#1468 — tombstones: only post-mint ones are protected', () => {
  it('hard-deletes a spec tombstone deleted BEFORE the mint (a draft-era deletion)', async () => {
    const mintedAt = (await db.memory.findUniqueOrThrow({ where: { id: minted.id } })).corpusMintedAt!;
    const draftEra = await node(minted.id, 'pas:050', { tags: ['spec'], deletedAt: new Date(mintedAt.getTime() - 86_400_000) });
    expect(await resolvers.Mutation.deleteNode({}, { nodeRef: draftEra.id, hard: true }, ctx())).toBe(true);
    expect(await db.node.findUnique({ where: { id: draftEra.id } })).toBeNull();
  });
});

describe('#1468 — whole-corpus removal', () => {
  const deleteMemory = (id: string) => resolvers.Mutation.deleteMemory({}, { id }, ctx());

  it('deleteMemory refuses a minted corpus holding a spec; the memory stays live', async () => {
    await node(minted.id, 'pas:010', { tags: ['spec'] });
    await expect(deleteMemory(minted.id)).rejects.toSatisfy(refusedPermanent);
    expect(await db.memory.findUniqueOrThrow({ where: { id: minted.id } })).toMatchObject({ deletedAt: null });
  });

  it('deleteMemory: a minted corpus with no spec, a draft corpus, and an unstamped memory all delete', async () => {
    await node(minted.id, 'notes');
    await node(draft.id, 'pas:010', { tags: ['spec'] });
    await node(unstamped.id, 'pas:010', { tags: ['spec'] });
    for (const m of [minted, draft, unstamped]) expect(await deleteMemory(m.id)).toBe(true);
  });

  it('deleteMemory stays idempotent on an already-deleted minted corpus', async () => {
    await node(minted.id, 'pas:010', { tags: ['spec'] });
    await db.memory.update({ where: { id: minted.id }, data: { deletedAt: new Date() } });
    expect(await deleteMemory(minted.id)).toBe(true);
  });

  it('createMemory refuses to reclaim the URN of a deleted minted corpus that still holds a spec', async () => {
    const dead = await memory('reuse', { corpusMintedAt: new Date(), deletedAt: new Date() });
    await node(dead.id, 'pas:010', { tags: ['spec'] });
    await expect(resolvers.Mutation.createMemory({}, { orgId: org.id, name: 'reuse' } as never, ctx()))
      .rejects.toSatisfy(refusedPermanent);
    expect(await db.memory.findUnique({ where: { id: dead.id } })).not.toBeNull();
  });

  it('control: createMemory still reclaims a deleted draft corpus', async () => {
    const dead = await memory('reuse', { corpusDraft: true, deletedAt: new Date() });
    await node(dead.id, 'pas:010', { tags: ['spec'] });
    await resolvers.Mutation.createMemory({}, { orgId: org.id, name: 'reuse' } as never, ctx());
    expect(await db.memory.findUnique({ where: { id: dead.id } })).toBeNull();
  });
});

describe('#1468 — cascades: App reclaim, account erasure, anonymous expiry', () => {
  async function agent(slug: string) {
    return db.agent.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:${slug}`, name: slug, visibility: 'PUBLIC' } });
  }

  it('createApp refuses to reclaim a deleted App whose cascade would erase a minted corpus', async () => {
    const a = await agent('suite');
    const retired = await db.app.create({
      data: { id: generateId(), organizationId: org.id, name: 'Suite', urn: `${org.urn}:suite`, deletedAt: new Date() },
    });
    const appMem = await db.memory.create({
      data: { id: generateId(), organizationId: org.id, appId: retired.id, urn: `${org.urn}:suite-mem`, name: 'suite-mem', class: 'app', corpusMintedAt: new Date() },
    });
    await node(appMem.id, 'pas:010', { tags: ['spec'] });
    await expect(resolvers.Mutation.createApp({}, { orgRef: org.id, agentRef: a.id, name: 'Suite' } as never, ctx()))
      .rejects.toSatisfy(refusedPermanent);
    expect(await db.app.findUnique({ where: { id: retired.id } })).not.toBeNull();
    expect(await db.memory.findUnique({ where: { id: appMem.id } })).not.toBeNull();
  });

  it('account erasure refuses while the user owns a minted corpus holding a spec, naming the handoff', async () => {
    const user = await db.user.create({ data: { id: generateId(), handle: 'mp-leaver', email: 'mp-leaver@example.com', roles: ['READER'] } });
    const owned = await db.memory.create({
      data: { id: generateId(), userId: user.id, ownerUserId: user.id, urn: 'mp-leaver:corpus', name: 'corpus', class: 'private', corpusMintedAt: new Date() },
    });
    await node(owned.id, 'pas:010', { tags: ['spec'] });
    const leaver = { db, userId: user.id, roles: ['READER'] } as Context;
    await expect(resolvers.Mutation.deleteUser({}, {}, leaver)).rejects.toSatisfy(
      (e: unknown) => e instanceof GraphQLError && e.extensions.code === SPEC_MINTED_PERMANENT && /transfer ownership/.test(e.message),
    );
    expect(await db.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({ deletedAt: null });
    expect(await db.memory.findUnique({ where: { id: owned.id } })).not.toBeNull();

    // Control: without the stamp, erasure proceeds and takes the memory.
    await db.memory.update({ where: { id: owned.id }, data: { corpusMintedAt: null } });
    expect(await resolvers.Mutation.deleteUser({}, {}, leaver)).toBe(true);
    expect(await db.memory.findUnique({ where: { id: owned.id } })).toBeNull();
  });

  it('anonymous-memory expiry never sweeps a stamped corpus', async () => {
    const { cleanupAnonymousMemories } = await import('../../../jobs/cleanupAnonymousMemories.js');
    const a = await agent('anon-host');
    const app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Anon', urn: `${org.urn}:anon` } });
    const expired = new Date(Date.now() - 60_000);
    const mk = (slug: string, stamped: boolean) => db.memory.create({
      data: {
        id: generateId(), organizationId: org.id, appId: app.id, userMemoryOfAgentId: a.id, urn: `${org.urn}:${slug}`,
        name: slug, class: 'app', anonymousExpiresAt: expired, corpusMintedAt: stamped ? new Date() : null,
      },
    });
    const kept = await mk('anon-stamped', true);
    const swept = await mk('anon-plain', false);
    await cleanupAnonymousMemories(db);
    expect(await db.memory.findUnique({ where: { id: kept.id } })).not.toBeNull();
    expect(await db.memory.findUnique({ where: { id: swept.id } })).toBeNull();
  });
});

describe('#1468 — address reclaims that erase a deleted minted corpus (Codex P1)', () => {
  async function deletedCorpusAt(urn: string) {
    const corpus = await db.memory.create({
      data: {
        id: generateId(), organizationId: org.id, urn, name: 'corpus', class: 'knowledge',
        corpusDraft: false, corpusMintedAt: new Date(Date.now() - 60_000), deletedAt: new Date(),
      },
    });
    await node(corpus.id, 'pas:010', { tags: ['spec'] });
    return corpus;
  }

  it('createAgent refuses to reclaim its -system address from a deleted minted corpus', async () => {
    const corpus = await deletedCorpusAt(`${org.urn}:spec-bot-system`);
    await expect(resolvers.Mutation.createAgent({}, { orgId: org.id, name: 'Spec Bot' } as never, ctx()))
      .rejects.toSatisfy(refusedPermanent);
    expect(await db.memory.findUnique({ where: { id: corpus.id } })).not.toBeNull();
    expect(await db.agent.findFirst({ where: { urn: `${org.urn}:spec-bot` } })).toBeNull();
  });

  it('control: createAgent still reclaims a deleted draft memory at its -system address', async () => {
    await memory('draft-bot-system', { corpusDraft: true, deletedAt: new Date() });
    const agent = await resolvers.Mutation.createAgent({}, { orgId: org.id, name: 'Draft Bot' } as never, ctx());
    expect(agent).toMatchObject({ urn: `${org.urn}:draft-bot` });
  });

  it("a handle rename refuses to reclaim a deleted minted corpus in the new namespace", async () => {
    const newRoot = await db.user.create({ data: { githubId: 14681, githubUsername: 'mp-u2', handle: 'mp-u2' } });
    await db.user.delete({ where: { id: newRoot.id } }); // frees the handle; its namespace keeps the tombstone below
    const corpus = await db.memory.create({
      data: {
        id: generateId(), ownerUserId: admin.id, userId: admin.id, urn: 'mp-u2:corpus', name: 'corpus',
        class: 'personal', corpusDraft: false, corpusMintedAt: new Date(Date.now() - 60_000), deletedAt: new Date(),
      },
    });
    await node(corpus.id, 'pas:010', { tags: ['spec'] });
    await expect(resolvers.Mutation.updateMyProfile({}, { handle: 'mp-u2' }, ctx())).rejects.toSatisfy(
      (e: unknown) => e instanceof GraphQLError && e.extensions.code === SPEC_MINTED_PERMANENT,
    );
    expect(await db.memory.findUnique({ where: { id: corpus.id } })).not.toBeNull();
    expect((await db.user.findUniqueOrThrow({ where: { id: admin.id } })).handle).toBe('mp-admin');
  });
});

describe('#1468 — chat and Channel deletions (Codex P1)', () => {
  // #1717: deleteChat's scope is the root and its `:messages` subtree, so the
  // spec sits there; a row elsewhere under the root is no longer the chat's.
  it('deleteChat refuses a legacy chat whose subtree holds a minted spec, deleting nothing', async () => {
    await node(minted.id, 'chats:legacy');
    await node(minted.id, 'chats:legacy:messages:m1', { tags: ['spec'] });
    await expect(resolvers.Mutation.deleteChat({}, { chatId: 'chats:legacy' }, ctx())).rejects.toSatisfy(refusedPermanent);
    expect(await liveIds(minted.id)).toEqual(['chats:legacy', 'chats:legacy:messages:m1']);
  });

  it('control: deleteChat still deletes a legacy chat in a draft corpus', async () => {
    await node(draft.id, 'chats:legacy');
    await node(draft.id, 'chats:legacy:messages:m1', { tags: ['spec'] });
    expect(await resolvers.Mutation.deleteChat({}, { chatId: 'chats:legacy' }, ctx())).toBe(true);
    expect(await liveIds(draft.id)).toEqual([]);
  });

  it("deleteChannel refuses when the Channel's root is a minted spec", async () => {
    const { channel, rootId } = await ensureChannelWithRoot(db, { memoryId: minted.id, loc: 'chats:c', name: 'c', createdBy: null });
    await db.node.update({ where: { id: rootId }, data: { tags: ['spec'] } });
    await expect((resolvers.Mutation as any).deleteChannel({}, { ref: channel.id }, ctx())).rejects.toSatisfy(refusedPermanent);
    expect(await db.channel.findUniqueOrThrow({ where: { id: channel.id } })).toMatchObject({ deletedAt: null });
  });
});

describe('#1468 — Channel reuse over a minted spec (Codex P1, Chip #4912)', () => {
  async function deadChannelWithSpecBelow(memoryId: string) {
    const { channel, rootId } = await ensureChannelWithRoot(db, { memoryId, loc: 'chats:c', name: 'c', createdBy: null });
    const deletedAt = new Date();
    await db.$transaction([
      db.channel.update({ where: { id: channel.id }, data: { deletedAt } }),
      db.node.update({ where: { id: rootId }, data: { deletedAt } }),
    ]);
    return node(memoryId, 'chats:c:messages:kept', { tags: ['spec'] });
  }

  it('refuses reusing a dead Channel address whose :messages: subtree holds a live minted spec', async () => {
    const spec = await deadChannelWithSpecBelow(minted.id);
    await expect(ensureChannelWithRoot(db, { memoryId: minted.id, loc: 'chats:c', name: 'c', createdBy: null }))
      .rejects.toSatisfy(refusedPermanent);
    expect(await db.node.findUniqueOrThrow({ where: { id: spec.id } })).toMatchObject({ deletedAt: null });
  });

  it('control: reuse in a draft corpus still tombstones the old subtree', async () => {
    const spec = await deadChannelWithSpecBelow(draft.id);
    await ensureChannelWithRoot(db, { memoryId: draft.id, loc: 'chats:c', name: 'c', createdBy: null });
    expect((await db.node.findUniqueOrThrow({ where: { id: spec.id } })).deletedAt).not.toBeNull();
  });
});

describe('#1468 — a whole-corpus delete cannot race the first spec (Codex P1)', () => {
  /** Run `writer` in a transaction held open until the returned release is called. */
  async function holdOpen(writer: (tx: Parameters<Parameters<typeof db.$transaction>[0]>[0]) => Promise<void>) {
    let release!: () => void;
    let written!: () => void;
    const hold = new Promise<void>((r) => { release = r; });
    const isWritten = new Promise<void>((r) => { written = r; });
    const done = db.$transaction(async (tx) => { await writer(tx); written(); await hold; }, { timeout: 20_000 });
    await isWritten;
    return { release, done };
  }
  const deleteWaits = () => vi.waitFor(async () => {
    const waits = await db.$queryRaw<Array<{ pid: number }>>`
      SELECT pid FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%FROM memories WHERE id%'`;
    expect(waits.length).toBeGreaterThan(0);
  }, { timeout: 5_000, interval: 25 });

  it('an update marking the first spec, in flight, makes deleteMemory wait and then refuse', async () => {
    const n = await node(minted.id, 'pas:010');
    const { release, done } = await holdOpen(async (tx) => {
      await assertNoMintedSpecUnmark(tx, minted.id, [{ id: n.id, tags: ['spec'] }], 'update');
      await tx.node.update({ where: { id: n.id }, data: { tags: ['spec'] } });
    });
    const deleting = resolvers.Mutation.deleteMemory({}, { id: minted.id }, ctx());
    try { await deleteWaits(); } finally { release(); }
    await done;
    await expect(deleting).rejects.toSatisfy(refusedPermanent);
    expect(await db.memory.findUniqueOrThrow({ where: { id: minted.id } })).toMatchObject({ deletedAt: null });
  }, 20_000);

  it('the opposite order: a first-spec mark waiting on a delete that commits is refused, writing nothing (Chip #4947)', async () => {
    const n = await node(minted.id, 'pas:030');
    // Stand-in for deleteMemory: the row FOR UPDATE and the tombstone, held open.
    const { release, done } = await holdOpen(async (tx) => {
      await tx.$queryRaw`SELECT id FROM memories WHERE id = ${minted.id} FOR UPDATE`;
      await tx.memory.update({ where: { id: minted.id }, data: { deletedAt: new Date() } });
    });
    const marking = resolvers.Mutation.updateNode({}, { input: { id: n.id, tags: ['spec'] } } as never, ctx());
    try {
      await vi.waitFor(async () => {
        const waits = await db.$queryRaw<Array<{ pid: number }>>`
          SELECT pid FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%FROM memories WHERE id%FOR SHARE%'`;
        expect(waits.length).toBeGreaterThan(0);
      }, { timeout: 5_000, interval: 25 });
    } finally { release(); }
    await done;
    await expect(marking).rejects.toSatisfy(
      (e: unknown) => e instanceof GraphQLError && e.extensions.code === 'NODE_WRITE_CONFLICT',
    );
    expect(await db.node.findUniqueOrThrow({ where: { id: n.id } })).toMatchObject({ tags: [] });
  }, 20_000);

  it('an insert of the first spec, in flight, makes deleteMemory wait and then refuse', async () => {
    const { release, done } = await holdOpen(async (tx) => {
      await tx.node.create({ data: { id: generateId(), memoryId: minted.id, loc: 'pas:020', name: 'pas:020', tags: ['spec'] } });
    });
    const deleting = resolvers.Mutation.deleteMemory({}, { id: minted.id }, ctx());
    try { await deleteWaits(); } finally { release(); }
    await done;
    await expect(deleting).rejects.toSatisfy(refusedPermanent);
    expect(await db.memory.findUniqueOrThrow({ where: { id: minted.id } })).toMatchObject({ deletedAt: null });
  }, 20_000);
});

describe('#1468 — race against a concurrent mint', () => {
  it('a delete waiting on a mint in flight reads the stamp after it commits, and refuses', async () => {
    const racing = await memory('racing', { corpusDraft: true });
    const spec = await node(racing.id, 'pas:010', { tags: ['spec'] });

    // Stand-in for mintSpecCorpus's fence + flip: the memory row FOR UPDATE,
    // the stamp written, and the transaction held open.
    let release!: () => void;
    let flipped!: () => void;
    const hold = new Promise<void>((r) => { release = r; });
    const isFlipped = new Promise<void>((r) => { flipped = r; });
    const mint = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM memories WHERE id = ${racing.id} FOR UPDATE`;
      await tx.memory.update({ where: { id: racing.id }, data: { corpusDraft: false, corpusMintedAt: new Date() } });
      flipped();
      await hold;
    }, { timeout: 20_000 });
    await isFlipped;

    const deleting = resolvers.Mutation.deleteNode({}, { nodeRef: spec.id }, ctx());
    try {
      // The delete blocks on the memory row the mint holds. Since #1481 that
      // can be deleteNode's own write-gate lock (`SELECT id FROM memories …
      // FOR SHARE`) rather than the guard's stamp read; either way it waits
      // behind the mint, and the guard reads the stamp only after it commits.
      await vi.waitFor(async () => {
        const waits = await db.$queryRaw<Array<{ pid: number }>>`
          SELECT pid FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%FROM memories WHERE id%'`;
        expect(waits.length).toBeGreaterThan(0);
      }, { timeout: 5_000, interval: 25 });
    } finally {
      release();
    }
    await mint;
    await expect(deleting).rejects.toSatisfy(refusedPermanent);
    expect(await db.node.findUniqueOrThrow({ where: { id: spec.id } })).toMatchObject({ deletedAt: null });
  });
});
