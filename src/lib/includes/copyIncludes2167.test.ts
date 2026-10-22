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
