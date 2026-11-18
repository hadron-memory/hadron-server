/**
 * hadron-internal#40 (rulings 0196/0197) — a resolved read is bounded, and over a bound it refuses
 * with one typed error naming the limit, never partial text. Every fixture here stays small enough
 * to run safely on a shared host at the default limits; this file uses no new module, so it runs
 * (red) against the base commit as written.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import Mustache from 'mustache';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { typeDefs } from '../../api/graphql/schema/typeDefs.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { BROKEN_INCLUDE_NOTICE } from './resolveNodeContent.js';
import { compileTemplate } from '../template.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

const server = new ApolloServer<Context>({ typeDefs, resolvers });
async function run(query: string, ctx: Context, variables?: Record<string, unknown>) {
  const res = await server.executeOperation({ query, variables }, { contextValue: ctx });
  if (res.body.kind !== 'single') throw new Error('unexpected incremental result');
  return res.body.singleResult;
}

const CODE = 'CONTENT_RESOLUTION_LIMIT_EXCEEDED';
let memoryId: string;
let memoryUrn: string;
let foreignMemoryId: string;
let foreignUrn: string;
let reader: { id: string };
const as = (u: { id: string }): Context => ({ db, userId: u.id, roles: [] });
const urn = (loc: string) => `hrn:node:${memoryUrn}:${loc}`;
const mk = (loc: string, content: string | null, extra: Record<string, unknown> = {}) =>
  db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, content, ...extra } });
const NODE_Q = `query($ref: ID!, $raw: Boolean) { node(ref: $ref, raw: $raw) { content } }`;

/** The read's outcome: its content, or the refusal's code and limit. */
async function read(loc: string, raw?: boolean) {
  const res = await run(NODE_Q, as(reader), { ref: urn(loc), ...(raw === undefined ? {} : { raw }) });
  const node = (res.data as { node: { content: string | null } | null } | null | undefined)?.node;
  const err = res.errors?.[0];
  return {
    content: node?.content ?? null,
    code: err?.extensions?.code ?? null,
    limit: (err?.extensions?.limit as string | undefined) ?? null,
    message: err?.message ?? null,
  };
}

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Rl Org', urn: 'rl.example' } });
  const other = await db.organization.create({ data: { id: generateId(), name: 'Rl Other', urn: 'rl-other.example' } });
  reader = await db.user.create({ data: { githubId: 404001, githubUsername: 'rl-reader', handle: 'rl-reader', roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: reader.id, role: 'ADMIN' } });
  const m = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'rl' }, as(reader));
  memoryId = m.id; memoryUrn = m.urn;
  const fm = await db.memory.create({
    data: { name: 'Foreign', urn: 'rl-other.example:foreign', organizationId: other.id, class: 'knowledge', visibility: 'ORGANIZATION' },
  });
  foreignMemoryId = fm.id; foreignUrn = fm.urn;
});

describe('#40 byte limit (UTF-8, before parse)', () => {
  it('a fan-out of one large target refuses as bytes, with no partial text; raw still returns the stored text', async () => {
    await mk('t', 'x'.repeat(300_000));
    await mk('p', '{{> t}}'.repeat(4));
    const r = await read('p');
    expect([r.code, r.limit, r.content]).toEqual([CODE, 'bytes', null]);
    expect(r.message).not.toMatch(/\bt\b|300|p\b/);
    expect((await read('p', true)).content).toBe('{{> t}}'.repeat(4));
  });

  it('control: under the limit the same shape resolves in full', async () => {
    await mk('t', 'x'.repeat(300_000));
    await mk('p', '{{> t}}'.repeat(3));
    const r = await read('p');
    expect(r.code).toBeNull();
    expect(r.content).toHaveLength(900_000);
  });

  it('multibyte text is counted in UTF-8 bytes, not string length', async () => {
    // 600,000 characters, 1,200,000 bytes.
    await mk('t', 'é'.repeat(300_000));
    await mk('p', '{{> t}}{{> t}}');
    expect(await read('p')).toMatchObject({ code: CODE, limit: 'bytes', content: null });
  });

  it('a large template body with no includes is charged before it is parsed', async () => {
    await mk('p', '{{x}}' + 'y'.repeat(1_100_000));
    expect(await read('p')).toMatchObject({ code: CODE, limit: 'bytes', content: null });
  });

  it('a large body with no template syntax is served as stored, uncharged', async () => {
    await mk('p', 'z'.repeat(1_200_000));
    expect((await read('p')).content).toHaveLength(1_200_000);
  });
});

describe('#40 render limits', () => {
  it('a data value repeated by the template refuses as bytes, with no includes and no spliced-text fallback', async () => {
    await mk('p', '{{{x}}}{{{x}}}{{{x}}}', { data: { x: 'v'.repeat(400_000) } });
    expect(await read('p')).toMatchObject({ code: CODE, limit: 'bytes', content: null });
  });

  it('escaping growth is charged after escaping', async () => {
    // 250,000 apostrophes escape to 1,250,000 bytes.
    await mk('p', '{{x}}', { data: { x: "'".repeat(250_000) } });
    expect(await read('p')).toMatchObject({ code: CODE, limit: 'bytes', content: null });
  });

  it('nested empty sections refuse on render steps even though they write nothing', async () => {
    await mk('p', '{{#a}}{{#a}}{{#a}}{{/a}}{{/a}}{{/a}}', { data: { a: Array.from({ length: 100 }, () => ({})) } });
    expect(await read('p')).toMatchObject({ code: CODE, limit: 'steps', content: null });
  });

  it('control: an ordinary template renders as before', async () => {
    await mk('p', 'Hi {{name}}, {{#items}}[{{.}}]{{/items}} {{^none}}none{{/none}}', { data: { name: 'Ann & co', items: [1, 2] } });
    expect((await read('p')).content).toBe('Hi Ann &amp; co, [1][2] none');
  });
});

describe('#40 work limits', () => {
  it('an empty-leaf fan-out that serves no bytes refuses on expansions', async () => {
    await mk('e', '');
    await mk('a', '{{> e}}'.repeat(101));
    await mk('p', '{{> a}}'.repeat(100));
    expect(await read('p')).toMatchObject({ code: CODE, limit: 'expansions', content: null });
  });

  it('many distinct missing targets refuse on lookups', async () => {
    await mk('p', Array.from({ length: 1_001 }, (_, i) => `{{> m${i}}}`).join(''));
    expect(await read('p')).toMatchObject({ code: CODE, limit: 'lookups', content: null });
  });

  it('missing and unreadable targets cost the same: both refuse identically, neither reveals the other', async () => {
    // Only some unreadable targets exist; a missing one costs the same.
    await db.node.createMany({ data: Array.from({ length: 501 }, (_, j) => ({ id: generateId(), memoryId: foreignMemoryId, loc: `s${j * 2}`, name: 's', content: 'S' })) });
    await mk('unreadable', Array.from({ length: 1_001 }, (_, i) => `{{> hrn:node:${foreignUrn}:s${i}}}`).join(''));
    await mk('missing', Array.from({ length: 1_001 }, (_, i) => `{{> hrn:node:${foreignUrn}:none${i}}}`).join(''));
    const a = await read('unreadable');
    const b = await read('missing');
    expect(a).toMatchObject({ code: CODE, limit: 'lookups', content: null });
    expect(b).toEqual(a);
  }, 30_000);

  it('an unreadable target larger than the limit costs only its notice: the reader still gets the node', async () => {
    await db.node.create({ data: { id: generateId(), memoryId: foreignMemoryId, loc: 'huge', name: 'h', content: 'H'.repeat(2_000_000) } });
    await mk('p', `a {{> hrn:node:${foreignUrn}:huge}} b`);
    expect(await read('p')).toMatchObject({ code: null, content: `a ${BROKEN_INCLUDE_NOTICE} b` });
  });
});

describe('#40 request aggregate', () => {
  it('one request past the aggregate refuses only the fields over it; earlier siblings return', async () => {
    await mk('t', 'x'.repeat(950_000));
    for (let i = 0; i < 9; i++) await mk(`n${i}`, '{{> t}}');
    const q = `query { ${Array.from({ length: 9 }, (_, i) => `n${i}: node(ref: "${urn(`n${i}`)}") { content }`).join(' ')} }`;
    const res = await run(q, as(reader));
    const data = res.data as Record<string, { content: string | null } | null>;
    const served = Object.values(data).filter(n => n?.content?.length === 950_000).length;
    const refused = (res.errors ?? []).filter(e => e.extensions?.code === CODE && e.extensions?.limit === 'requestBytes');
    expect(served).toBe(8);
    expect(refused).toHaveLength(1);
    expect(Object.values(data).filter(n => n?.content === null)).toHaveLength(1);
  });
});

describe('#40 no retained parse', () => {
  it('a render leaves nothing in the shared Mustache template cache', async () => {
    const cache = (Mustache as unknown as { templateCache?: { _cache?: Record<string, unknown> } }).templateCache;
    cache?._cache && Object.keys(cache._cache).forEach(k => delete cache._cache![k]);
    const marker = `marker-${generateId()}`;
    expect(await compileTemplate(`${marker} {{name}}`, { name: 'n' }, memoryId, db, {})).toBe(`${marker} n`);
    expect(Object.keys(cache?._cache ?? {}).filter(k => k.includes(marker))).toEqual([]);
  });
});
