/**
 * #2041 S2b — the writer's read check (cor:dmo:150:04 under R110): a write is
 * refused when the writer can't read a target named by a tag the write ADDS or
 * CHANGES, with one error for missing, deleted and unreadable targets; tags
 * already in the stored text are not re-checked and keep their edges; the
 * cycle walk starts from added or changed tags only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { createTestableMcpServer } from '../../mcp/server.js';
import { sessionKeyCache } from '../sessionKeyCache.js';
import { generateDataKey } from '../crypto.js';
import { encryptNodeFields, decryptNodeFields } from '../nodeCrypto.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

/** Runs once, right after updateNode takes its address lock and before it locks and re-reads the row. */
const onLock = { fire: null as null | (() => Promise<void>) };
vi.mock('../nodeSubtreeLock.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    lockLocForWrite: async (...args: unknown[]) => {
      const r = await (real.lockLocForWrite as (...a: unknown[]) => Promise<unknown>)(...args);
      if (onLock.fire) {
        const fire = onLock.fire;
        onLock.fire = null;
        await fire();
      }
      return r;
    },
  };
});

let memoryId: string;
let memoryUrn: string;
let foreignUrn: string;
let foreignMemoryId: string;
let sealedUrn: string;
let writer: { id: string };
const as = (): Context => ({ db, userId: writer.id, roles: [] });
const M = resolvers.Mutation as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<any>>;
const mcp = () => createTestableMcpServer({ userId: writer.id, roles: [], clientId: `user:${writer.id}` });
const urn = (loc: string) => `hrn:node:${memoryUrn}:${loc}`;
const create = (loc: string, content: string) =>
  M.createNode(null, { input: { memoryId, loc, name: loc, abstract: loc, content } }, as());
const update = (loc: string, content: string, extra: Record<string, unknown> = {}) =>
  M.updateNode(null, { input: { memoryId, loc, content, ...extra } }, as());
const seed = (loc: string, content: string, mem = memoryId) =>
  db.node.create({ data: { id: generateId(), memoryId: mem, loc, name: loc, content } });
const refusal = async (p: Promise<unknown>) => {
  try { await p; return { code: 'NO_ERROR', message: '', tag: undefined as unknown }; } catch (e: any) {
    return { code: String(e.extensions?.code ?? e.message), message: String(e.message), tag: e.extensions?.tag };
  }
};
const code = async (p: Promise<unknown>) => (await refusal(p)).code;
const contentOf = async (loc: string) => (await db.node.findFirstOrThrow({ where: { memoryId, loc } })).content;
const includeTargets = async (loc: string) => (await db.edge.findMany({
  where: { source: { memoryId, loc }, governedKind: 'INCLUDE' }, include: { target: true },
})).map(e => e.target.loc).sort();
const secret = () => `{{> hrn:node:${foreignUrn}:secret}}`;

beforeEach(async () => {
  await cleanDb(db);
  sessionKeyCache.clear();
  onLock.fire = null;
  const org = await db.organization.create({ data: { id: generateId(), name: 'Wa Org', urn: 'wa.example' } });
  const other = await db.organization.create({ data: { id: generateId(), name: 'Other Org', urn: 'wa-other.example' } });
  writer = await db.user.create({ data: { githubId: 204201, githubUsername: 'wa-writer', handle: 'wa-writer', roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: writer.id, role: 'ADMIN' } });
  const m = await M.createMemory(null, { orgId: org.id, name: 'wa' }, as());
  memoryId = m.id; memoryUrn = m.urn;
  const fm = await db.memory.create({
    data: { name: 'Foreign', urn: 'wa-other.example:foreign', organizationId: other.id, class: 'knowledge', visibility: 'ORGANIZATION' },
  });
  foreignUrn = fm.urn; foreignMemoryId = fm.id;
  await seed('secret', 'FOREIGN_SECRET', fm.id);
  const sealed = await db.memory.create({
    data: { name: 'sealed', urn: 'wa.example:sealed', organizationId: org.id, class: 'knowledge', visibility: 'ORGANIZATION', isEncrypted: true },
  });
  sealedUrn = sealed.urn;
  sessionKeyCache.set('wa-seed', sealed.id, generateDataKey());
  await seed('vault', encryptNodeFields({ content: 'SEALED' }, { id: sealed.id, isEncrypted: true }).content!, sealed.id);
  sessionKeyCache.clear();
});

describe('the writer can only add an include it can read (cor:dmo:150:04)', () => {
  it('refuses an added tag to an unreadable memory on create and on update, naming the tag, leaving nothing behind', async () => {
    const r = await refusal(create('n', `x ${secret()}`));
    expect(r.code).toBe('INCLUDE_TARGET_UNAVAILABLE');
    expect(r.tag).toBe(secret());
    expect(r.message).not.toContain('FOREIGN');
    expect(await db.node.count({ where: { memoryId, loc: 'n' } })).toBe(0);

    await create('a', 'plain');
    const before = await db.node.findFirstOrThrow({ where: { memoryId, loc: 'a' } });
    expect(await code(update('a', `plain ${secret()}`))).toBe('INCLUDE_TARGET_UNAVAILABLE');
    const after = await db.node.findFirstOrThrow({ where: { memoryId, loc: 'a' } });
    expect(after.content).toBe('plain');
    expect(after.revSeq).toBe(before.revSeq);
    expect(await includeTargets('a')).toEqual([]);
  });

  it('one error for missing, deleted and unreadable targets: the refusals differ only by the tag', async () => {
    await create('gone', 'G');
    await db.node.updateMany({ where: { memoryId, loc: 'gone' }, data: { deletedAt: new Date() } });
    const tags = [
      '{{> nope}}',
      '{{> gone}}',
      secret(),
      `{{> hrn:node:${foreignUrn}:nothing-here}}`,
      '{{> hrn:node:wa-none.example:void:x}}',
    ];
    const seen = new Set<string>();
    for (const [i, tag] of tags.entries()) {
      const r = await refusal(create(`t${i}`, tag));
      expect(r.code).toBe('INCLUDE_TARGET_UNAVAILABLE');
      expect(r.tag).toBe(tag);
      seen.add(r.message.replace(tag, '<tag>'));
    }
    expect(seen.size).toBe(1);
  });

  it('a readable target saves; an encrypted target the writer may read saves with no session key', async () => {
    await create('b', 'B');
    expect(await code(create('a', '{{> b}}'))).toBe('NO_ERROR');
    expect(await includeTargets('a')).toEqual(['b']);
    expect(sessionKeyCache.getByMemoryId((await db.memory.findFirstOrThrow({ where: { urn: sealedUrn } })).id)).toBeFalsy();
    expect(await code(create('k', `{{> hrn:node:${sealedUrn}:vault}}`))).toBe('NO_ERROR');
  });

  it('the MCP writers refuse the same way', async () => {
    const created = await mcp().callToolText('hadron_create_node', { urn: urn('m'), name: 'm', content: secret() });
    expect(created).toContain('[include_target_unavailable]');
    expect(await db.node.count({ where: { memoryId, loc: 'm' } })).toBe(0);
    await mcp().callToolText('hadron_create_node', { urn: urn('m2'), name: 'm2', content: 'plain' });
    const updated = await mcp().callToolText('hadron_update_node', { urn: urn('m2'), content: `plain ${secret()}` });
    expect(updated).toContain('[include_target_unavailable]');
    expect(await contentOf('m2')).toBe('plain');
  });

  it('an MCP section re-save that adds an unreadable tag refuses, storing nothing (Ruth, #2226 P3)', async () => {
    await mcp().callToolText('hadron_create_parent_node', { urn: urn('sec'), description: 'plain section' });
    const before = await db.node.findFirstOrThrow({ where: { memoryId, loc: 'sec' } });
    const resaved = await mcp().callToolText('hadron_create_parent_node', { urn: urn('sec'), description: `plain section ${secret()}` });
    expect(resaved).toContain('[include_target_unavailable]');
    const after = await db.node.findFirstOrThrow({ where: { memoryId, loc: 'sec' } });
    expect(after.content).toBe('plain section');
    expect(after.revSeq).toBe(before.revSeq);
    expect(await includeTargets('sec')).toEqual([]);
  });
});

describe('only added or changed tags are checked (R110)', () => {
  it('an unrelated edit saves while a stored tag points at a target the writer can no longer read, and its edge stays', async () => {
    const a = await seed('a', `head ${secret()}`);
    const target = await db.node.findFirstOrThrow({ where: { memoryId: foreignMemoryId, loc: 'secret' } });
    await db.edge.create({ data: {
      id: generateId(), memoryId, sourceId: a.id, targetId: target.id, loc: `includes:${a.id}:${target.id}`, name: 'includes', governedKind: 'INCLUDE',
    } });
    expect(await code(update('a', `head ${secret()} tail`))).toBe('NO_ERROR');
    expect(await contentOf('a')).toBe(`head ${secret()} tail`);
    expect(await db.edge.count({ where: { sourceId: a.id, targetId: target.id, governedKind: 'INCLUDE' } })).toBe(1);
    // Whitespace inside the braces is not a change.
    expect(await code(update('a', `head {{>  hrn:node:${foreignUrn}:secret }} tail`))).toBe('NO_ERROR');
  });

  it('changing a stored tag\'s settings, or adding a second tag to the same target, is checked', async () => {
    await seed('a', `head ${secret()}`);
    expect(await code(update('a', `head {{> hrn:node:${foreignUrn}:secret rev=1}}`))).toBe('INCLUDE_TARGET_UNAVAILABLE');
    expect(await code(update('a', `head {{> hrn:node:${foreignUrn}:secret approved}}`))).toBe('INCLUDE_TARGET_UNAVAILABLE');
    expect(await contentOf('a')).toBe(`head ${secret()}`);
  });

  it('a rev too large for a number is still a settings change, never an alias for no rev (Gene, #2226 P2)', async () => {
    await seed('a', `head ${secret()}`);
    const huge = '9'.repeat(400); // parses to Infinity
    expect(await code(update('a', `head {{> hrn:node:${foreignUrn}:secret rev=${huge}}}`))).toBe('INCLUDE_TARGET_UNAVAILABLE');
    expect(await contentOf('a')).toBe(`head ${secret()}`);
  });

  it('the same target rewritten as another tag form is a changed tag', async () => {
    await create('b', 'B');
    await seed('a', '{{> b}}');
    await db.node.updateMany({ where: { memoryId, loc: 'b' }, data: { deletedAt: new Date() } });
    // `{{> b}}` is unchanged and saves; its URN form is a new tag to a deleted target.
    expect(await code(update('a', '{{> b}} more'))).toBe('NO_ERROR');
    expect(await code(update('a', `{{> ${urn('b')}}} more`))).toBe('INCLUDE_TARGET_UNAVAILABLE');
  });

  it('drift: a tag removed before the deciding locked read is re-checked when the write adds it back', async () => {
    await seed('a', `head ${secret()}`);
    // The resolver's first read sees the tag; the hook removes it before the row lock.
    onLock.fire = async () => { await db.node.updateMany({ where: { memoryId, loc: 'a' }, data: { content: 'head' } }); };
    expect(await code(update('a', `head ${secret()} tail`))).toBe('INCLUDE_TARGET_UNAVAILABLE');
    expect(await contentOf('a')).toBe('head');

    // Guarded: the drift is the conflict, refused before any include decision.
    await db.node.updateMany({ where: { memoryId, loc: 'a' }, data: { content: `head ${secret()}` } });
    const revision = (await db.node.findFirstOrThrow({ where: { memoryId, loc: 'a' } })).revSeq;
    onLock.fire = async () => { await db.node.updateMany({ where: { memoryId, loc: 'a' }, data: { content: 'head' } }); };
    expect(await code(update('a', `head ${secret()} tail`, { expectedRevision: revision }))).toBe('NODE_WRITE_CONFLICT');
    expect(await contentOf('a')).toBe('head');
  });

  it('on an encrypted includer the comparison is on plaintext: an unchanged tag saves, a changed one refuses', async () => {
    const encMem = await db.memory.findFirstOrThrow({ where: { urn: sealedUrn } });
    sessionKeyCache.set('wa-enc', encMem.id, generateDataKey());
    const info = { id: encMem.id, isEncrypted: true };
    await db.node.create({ data: {
      id: generateId(), memoryId: encMem.id, loc: 'inc', name: 'inc', content: encryptNodeFields({ content: `E ${secret()}` }, info).content,
    } });
    const up = (content: string) => M.updateNode(null, { input: { memoryId: encMem.id, loc: 'inc', content } }, as());
    expect(await code(up(`E ${secret()} more`))).toBe('NO_ERROR');
    expect(await code(up(`E {{> hrn:node:${foreignUrn}:secret rev=2}}`))).toBe('INCLUDE_TARGET_UNAVAILABLE');
    const row = await db.node.findFirstOrThrow({ where: { memoryId: encMem.id, loc: 'inc' } });
    expect(decryptNodeFields({ content: row.content }, info).content).toBe(`E ${secret()} more`);
  });

  it('a create that resurrects a tombstone: its old tags are not stored text, so every tag is checked', async () => {
    await seed('a', `old ${secret()}`);
    await db.node.updateMany({ where: { memoryId, loc: 'a' }, data: { deletedAt: new Date() } });
    const r = await refusal(create('a', `old ${secret()}`));
    expect(r.code).toBe('INCLUDE_TARGET_UNAVAILABLE');
  });
});

describe('the cycle walk starts from added or changed tags only', () => {
  it('a cycle formed later through an unchanged tag does not block an unrelated save; a tag that closes a cycle still refuses', async () => {
    await seed('b', 'B');
    await seed('a', '{{> b}}');
    // b now includes a, made directly: a <-> b already loops through a's stored tag.
    await db.node.updateMany({ where: { memoryId, loc: 'b' }, data: { content: 'B {{> a}}' } });
    expect(await code(update('a', '{{> b}} edited'))).toBe('NO_ERROR');
    await create('c', 'C {{> a}}');
    expect(await code(update('a', '{{> b}} edited {{> c}}'))).toBe('INCLUDE_CYCLE');
  });
});

describe('every principal writer runs the check', () => {
  it('batch replace, node merge-into and restore-revision refuse an added unreadable tag and keep an unchanged one', async () => {
    await create('r', 'swap-me');
    const replaced = await refusal(M.searchReplaceInNodes(null, { input: {
      oldText: 'swap-me', newText: secret(), memoryIds: [memoryId], fields: ['content'],
    } }, as()));
    expect(replaced.code).toBe('INCLUDE_TARGET_UNAVAILABLE');
    expect(await contentOf('r')).toBe('swap-me');

    await create('t', 'target');
    await seed('s', `source ${secret()}`);
    const merged = await refusal(M.mergeNodes(null, { input: { source: urn('s'), target: urn('t'), include: ['CONTENT'] } }, as()));
    expect(merged.code).toBe('INCLUDE_TARGET_UNAVAILABLE');
    expect(await contentOf('t')).toBe('target');

    const v = await create('v', 'v1');
    await db.node.updateMany({ where: { memoryId, loc: 'v' }, data: { content: `v1 ${secret()}` } });
    await update('v', 'v2');
    const revs = await db.nodeRevision.findMany({ where: { nodeId: v.id }, orderBy: { revNo: 'asc' } });
    const withTag = revs.find(r => (r.content ?? '').includes(foreignUrn));
    expect(withTag).toBeTruthy();
    expect(await code(M.restoreNodeRevision(null, { revisionId: withTag!.id }, as()))).toBe('INCLUDE_TARGET_UNAVAILABLE');
    expect(await contentOf('v')).toBe('v2');
  });

  it('git sync and the root-node seam are the only callers without the check (source guard)', async () => {
    const { execSync } = await import('child_process');
    const importers = execSync(
      "git grep -l \"operations/createNode\" -- 'src/**/*.ts' ':!src/**/*.test.ts'", { encoding: 'utf8' },
    ).trim().split('\n').sort();
    expect(importers).toEqual([
      'src/api/graphql/schema/resolvers.mutation.appMemory.ts',
      'src/api/graphql/schema/resolvers.mutation.memory.ts',
      'src/controller/controller.ts',
    ]);
    const systemCallers = execSync(
      "git grep -l \"includeSystemWrite\" -- 'src/**/*.ts' ':!src/**/*.test.ts'", { encoding: 'utf8' },
    ).trim().split('\n').sort();
    expect(systemCallers).toEqual([
      'src/controller/operations/createNode.ts',
      'src/integrations/github/syncGraphFromGithub.ts',
      'src/lib/includes/writeIncludes.ts',
    ]);
  });
});
