/**
 * #1468 — a spec in a mint-stamped corpus is permanent: no path may remove it.
 *
 * Only a corpus stamped by `mintSpecCorpus` (`corpusMintedAt` set) is
 * protected (Holger, team chat #4370). Draft corpora, and never-stamped
 * non-draft memories such as the live platform specs corpus, keep today's
 * behaviour. A spec is anything with the spec marker: a `spec` tag or a
 * `spec`/`spec.*` role.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import type { AuthContext } from '../../../middleware/auth.js';
import { generateId } from '../../../lib/id.js';
import { SPEC_MINTED_PERMANENT } from '../../../lib/mintedSpecPermanence.js';

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

async function memory(name: string, state: { corpusDraft?: boolean; corpusMintedAt?: Date | null }) {
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
    await node(draft.id, 'mod:010', { role: 'spec' });
    expect(await del(parent.id, { recursive: true, hard: true })).toBe(true);
    expect(await liveIds(draft.id)).toEqual([]);
  });

  it('control: a never-stamped non-draft memory (the live-corpus case) is outside this guard', async () => {
    const spec = await node(unstamped.id, 'pas:010', { tags: ['spec'], role: 'spec' });
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
