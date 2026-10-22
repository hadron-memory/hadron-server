/**
 * #2167 — a copy is an includer write (cor:dmo:150:04, :06): every include tag
 * in every copied node counts as added, against where it lands in the new
 * memory. Clone checks after its self-URN rewrite. The copier must be able to
 * read each target, and no copied tag may close a cycle; the write walk has no
 * depth cap. Any refusal refuses the whole copy and leaves nothing behind.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { sessionKeyCache } from '../sessionKeyCache.js';
import { generateDataKey } from '../crypto.js';
import { encryptNodeFields } from '../nodeCrypto.js';
import { computeContentHash } from '../contentHash.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let memoryId: string;
let memoryUrn: string;
let foreignUrn: string;
let sealedUrn: string;
let writer: { id: string };
const as = (): Context => ({ db, userId: writer.id, roles: [] });
const M = resolvers.Mutation as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<any>>;
const urn = (loc: string) => `hrn:node:${memoryUrn}:${loc}`;
const COPY = 'cp.example:copy';
/** Stored directly, as text a guarded write could not produce today. */
const seed = (loc: string, content: string, mem = memoryId) =>
  db.node.create({ data: { id: generateId(), memoryId: mem, loc, name: loc, content } });
const clone = () => M.cloneMemory(null, { ref: memoryId, targetUrn: `hrn:mem:${COPY}` }, as());
const refusal = async (p: Promise<unknown>) => {
  try { await p; return { code: 'NO_ERROR', tag: undefined as unknown }; } catch (e: any) {
    return { code: String(e.extensions?.code ?? e.message), tag: e.extensions?.tag };
  }
};
const noResidue = async () => {
  expect(await db.memory.count({ where: { urn: COPY } })).toBe(0);
  expect(await db.node.count({ where: { memory: { urn: COPY } } })).toBe(0);
};
const copyEdges = async () => (await db.edge.findMany({
  where: { memory: { urn: COPY }, governedKind: 'INCLUDE' }, include: { source: true, target: true },
})).map(e => `${e.source.loc}>${e.target.loc}`).sort();

beforeEach(async () => {
  await cleanDb(db);
  sessionKeyCache.clear();
  const org = await db.organization.create({ data: { id: generateId(), name: 'Cp Org', urn: 'cp.example' } });
  const other = await db.organization.create({ data: { id: generateId(), name: 'Cp Other', urn: 'cp-other.example' } });
  writer = await db.user.create({ data: { githubId: 216701, githubUsername: 'cp-writer', handle: 'cp-writer', roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: writer.id, role: 'ADMIN' } });
  const m = await M.createMemory(null, { orgId: org.id, name: 'src' }, as());
  memoryId = m.id; memoryUrn = m.urn;
  const fm = await db.memory.create({
    data: { name: 'Foreign', urn: 'cp-other.example:foreign', organizationId: other.id, class: 'knowledge', visibility: 'ORGANIZATION' },
  });
  foreignUrn = fm.urn;
  await seed('secret', 'FOREIGN_SECRET', fm.id);
  const sealed = await db.memory.create({
    data: { name: 'sealed', urn: 'cp.example:sealed', organizationId: org.id, class: 'knowledge', visibility: 'ORGANIZATION', isEncrypted: true },
  });
  sealedUrn = sealed.urn;
  sessionKeyCache.set('cp-seed', sealed.id, generateDataKey());
  await seed('vault', encryptNodeFields({ content: 'SEALED' }, { id: sealed.id, isEncrypted: true }).content!, sealed.id);
  sessionKeyCache.clear();
});

describe('clone: the copier can read every copied target (cor:dmo:150:04)', () => {
  it('a tag to a memory the copier cannot read refuses the whole clone, naming the tag, with no residue', async () => {
    const tag = `{{> hrn:node:${foreignUrn}:secret}}`;
    await seed('a', `x ${tag}`);
    const r = await refusal(clone());
    expect(r).toEqual({ code: 'INCLUDE_TARGET_UNAVAILABLE', tag });
    await noResidue();
  });

  it('a relative tag whose target the source never had refuses', async () => {
    await seed('a', '{{> nowhere}}');
    expect((await refusal(clone())).code).toBe('INCLUDE_TARGET_UNAVAILABLE');
    await noResidue();
  });

  it('a copied relative tag and a self-URN tag rewritten to the clone pass, and derive their edges', async () => {
    await seed('b', 'B');
    await seed('a', `{{> b}} {{> ${urn('b')}}}`);
    expect((await refusal(clone())).code).toBe('NO_ERROR');
    expect(await copyEdges()).toEqual(['a>b']);
  });

  it('an encrypted target the copier may read passes with no session key', async () => {
    await seed('a', `{{> hrn:node:${sealedUrn}:vault}}`);
    expect((await refusal(clone())).code).toBe('NO_ERROR');
  });
});

describe('clone: no copied tag may close a cycle (cor:dmo:150:06)', () => {
  it('a stored cycle refuses the whole clone with no residue', async () => {
    await seed('a', '{{> b}}');
    await seed('b', '{{> a}}');
    const r = await refusal(clone());
    expect(r.code).toBe('INCLUDE_CYCLE');
    expect(['{{> a}}', '{{> b}}']).toContain(r.tag);
    await noResidue();
  });

  it('a self-URN cycle rewritten into the clone refuses', async () => {
    await seed('a', `{{> ${urn('b')}}}`);
    await seed('b', `{{> ${urn('a')}}}`);
    expect((await refusal(clone())).code).toBe('INCLUDE_CYCLE');
    await noResidue();
  });

  it('a cycle longer than ten hops still refuses: the write walk has no depth cap', async () => {
    for (let i = 0; i < 12; i++) await seed(`n${i}`, `{{> n${(i + 1) % 12}}}`);
    expect((await refusal(clone())).code).toBe('INCLUDE_CYCLE');
    await noResidue();
  });

  it('a chain twelve deep with no cycle clones: depth is not a write refusal', async () => {
    for (let i = 0; i < 12; i++) await seed(`n${i}`, `{{> n${i + 1}}}`);
    await seed('n12', 'end');
    expect((await refusal(clone())).code).toBe('NO_ERROR');
    expect((await copyEdges()).length).toBe(12);
  });

  it('a diamond clones', async () => {
    await seed('d', 'D');
    await seed('b', '{{> d}}');
    await seed('c', '{{> d}}');
    await seed('a', '{{> b}} {{> c}}');
    expect((await refusal(clone())).code).toBe('NO_ERROR');
    expect(await copyEdges()).toEqual(['a>b', 'a>c', 'b>d', 'c>d']);
  });
});

describe('extract: copied tags resolve where they land (cor:dmo:150:04, :06)', () => {
  const EX = (slug: string) => `cp.example:${slug}`;
  const extract = async (slug: string, move = false) => {
    const parent = await db.node.findFirstOrThrow({ where: { memoryId, loc: 'sub' } });
    return M.extractParentNodeToMemory(null, { parentRef: parent.id, targetUrn: `hrn:mem:${EX(slug)}`, move }, as());
  };
  const exEdges = async (slug: string) => (await db.edge.findMany({
    where: { memory: { urn: EX(slug) }, governedKind: 'INCLUDE' }, include: { source: true, target: true },
  })).map(e => `${e.source.loc}>${e.target.loc}`).sort();
  const exContent = async (slug: string, loc: string) =>
    // loc-scope-ok: scoped to the extracted memory by its URN.
    (await db.node.findFirstOrThrow({ where: { memory: { urn: EX(slug) }, loc } })).content;
  const sourceLive = async () => db.node.count({ where: { memoryId, loc: { startsWith: 'sub' }, deletedAt: null } });

  beforeEach(async () => {
    await seed('other', 'O');
    await seed('sub', 'root');
  });

  it('a tag inside the subtree passes when the root keeps its loc, and derives its edge', async () => {
    await seed('sub:b', 'B');
    await seed('sub:a', '{{> sub:b}}');
    expect((await refusal(extract('sub'))).code).toBe('NO_ERROR');
    expect(await exEdges('sub')).toEqual(['sub:a>sub:b']);
  });

  it('a tag inside the subtree is rebound to the rebased loc, then derives its edge (R180)', async () => {
    await seed('sub:b', 'B');
    await seed('sub:a', 'see {{> sub:b}} here');
    expect((await refusal(extract('ex', true))).code).toBe('NO_ERROR');
    expect(await exContent('ex', 'ex:a')).toBe('see {{> ex:b}} here');
    expect(await exEdges('ex')).toEqual(['ex:a>ex:b']);
  });

  it('a relative tag to a sibling left outside the subtree refuses', async () => {
    await seed('sub:a', '{{> other}}');
    expect((await refusal(extract('sub'))).code).toBe('INCLUDE_TARGET_UNAVAILABLE');
    expect(await db.memory.count({ where: { urn: EX('sub') } })).toBe(0);
  });

  it('a URN tag back to a readable node of the source passes', async () => {
    await seed('sub:a', `{{> ${urn('other')}}}`);
    expect((await refusal(extract('sub'))).code).toBe('NO_ERROR');
  });

  it('a cycle in the subtree refuses a move with no residue, and the source stays live', async () => {
    await seed('sub:a', '{{> sub:b}}');
    await seed('sub:b', '{{> sub:a}}');
    expect((await refusal(extract('sub', true))).code).toBe('INCLUDE_CYCLE');
    expect(await db.memory.count({ where: { urn: EX('sub') } })).toBe(0);
    expect(await sourceLive()).toBe(3);
  });
});

describe('extract rebinds include tags that name a copied node (R180, cor:api:160:01)', () => {
  const EX = 'cp.example:ex';
  const exUrn = (loc: string) => `hrn:node:${EX}:${loc}`;
  const extract = async (move = false) => {
    const parent = await db.node.findFirstOrThrow({ where: { memoryId, loc: 'sub' } });
    return M.extractParentNodeToMemory(null, { parentRef: parent.id, targetUrn: `hrn:mem:${EX}`, move }, as());
  };
  // loc-scope-ok: scoped to the extracted memory by its URN.
  const exNode = (loc: string) => db.node.findFirstOrThrow({ where: { memory: { urn: EX }, loc } });
  const exEdges = async () => (await db.edge.findMany({
    where: { memory: { urn: EX }, governedKind: 'INCLUDE' }, include: { source: true, target: true },
  })).map(e => `${e.source.loc}>${e.target.loc}`).sort();
  const sourceLive = async () => db.node.count({ where: { memoryId, loc: { startsWith: 'sub' }, deletedAt: null } });

  beforeEach(async () => {
    await seed('other', 'O');
    await seed('sub', 'root');
    await seed('sub:b', 'B');
  });

  it('keeps the settings, their order and the spacing byte for byte; only the target changes', async () => {
    await seed('sub:a', '{{>  sub:b   approved rev=2 }} and {{> sub}}');
    expect((await refusal(extract())).code).toBe('NO_ERROR');
    expect((await exNode('ex:a')).content).toBe('{{>  ex:b   approved rev=2 }} and {{> ex}}');
  });

  it('a URN tag to a copied node becomes the new memory\'s URN, and on a move resolves to the copy', async () => {
    await seed('sub:a', `{{> ${urn('sub:b')}}}`);
    expect((await refusal(extract(true))).code).toBe('NO_ERROR');
    expect((await exNode('ex:a')).content).toBe(`{{> ${exUrn('ex:b')}}}`);
    expect(await exEdges()).toEqual(['ex:a>ex:b']);
  });

  it('a tag outside the subtree stays as written: a URN to a readable source node passes unchanged', async () => {
    await seed('sub:a', `{{> ${urn('other')}}}`);
    expect((await refusal(extract())).code).toBe('NO_ERROR');
    expect((await exNode('ex:a')).content).toBe(`{{> ${urn('other')}}}`);
  });

  it('a sibling left behind, and a loc under the parent with no copied node, stay as written and refuse', async () => {
    await seed('sub:a', '{{> other}}');
    expect(await refusal(extract())).toEqual({ code: 'INCLUDE_TARGET_UNAVAILABLE', tag: '{{> other}}' });
    await db.node.updateMany({ where: { memoryId, loc: 'sub:a' }, data: { content: '{{> sub:missing}}' } });
    expect(await refusal(extract())).toEqual({ code: 'INCLUDE_TARGET_UNAVAILABLE', tag: '{{> sub:missing}}' });
    expect(await db.memory.count({ where: { urn: EX } })).toBe(0);
  });

  it('a tag inside code is text and is not rewritten', async () => {
    await seed('sub:a', 'run `{{> sub:b}}`\n\n```\n{{> sub:b}}\n```\n');
    expect((await refusal(extract())).code).toBe('NO_ERROR');
    expect((await exNode('ex:a')).content).toBe('run `{{> sub:b}}`\n\n```\n{{> sub:b}}\n```\n');
  });

  it('a rewritten node drops its content hash and authorship and refreshes a fresh abstract hash; an untouched one keeps them', async () => {
    const stamp = { contentHash: 'h-external', authorshipKind: 'HUMAN' as const, authoredByHuman: writer.id, authoredAt: new Date() };
    await db.node.create({ data: {
      id: generateId(), memoryId, loc: 'sub:a', name: 'a', content: '{{> sub:b}}', abstract: 'A',
      abstractOriginHash: computeContentHash('{{> sub:b}}'), ...stamp,
    } });
    await db.node.create({ data: {
      id: generateId(), memoryId, loc: 'sub:c', name: 'c', content: 'plain', abstract: 'C',
      abstractOriginHash: computeContentHash('plain'), ...stamp,
    } });
    expect((await refusal(extract())).code).toBe('NO_ERROR');
    const a = await exNode('ex:a');
    expect(a).toMatchObject({ content: '{{> ex:b}}', contentHash: null, authorshipKind: null, authoredByHuman: null });
    expect(a.abstractOriginHash).toBe(computeContentHash('{{> ex:b}}'));
    const c = await exNode('ex:c');
    expect(c).toMatchObject({ content: 'plain', contentHash: 'h-external', authorshipKind: 'HUMAN', authoredByHuman: writer.id });
    expect(c.abstractOriginHash).toBe(computeContentHash('plain'));
  });

  it('a cycle that forms after the rewrite refuses a move with no residue, and the source stays live', async () => {
    await seed('sub:a', '{{> sub:b}}');
    await db.node.updateMany({ where: { memoryId, loc: 'sub:b' }, data: { content: '{{> sub:a}}' } });
    expect((await refusal(extract(true))).code).toBe('INCLUDE_CYCLE');
    expect(await db.memory.count({ where: { urn: EX } })).toBe(0);
    expect(await sourceLive()).toBe(3);
  });

  it('a self-include rewritten to its own rebased loc refuses as a cycle', async () => {
    await seed('sub:a', '{{> sub:a}}');
    expect(await refusal(extract())).toEqual({ code: 'INCLUDE_CYCLE', tag: '{{> ex:a}}' });
  });
});
