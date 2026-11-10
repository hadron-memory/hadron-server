/**
 * #3222 (#2213 S3, cor:api:120:04) — `specBacklinksPage` and `specUnresolvedReferencesPage`, the paged siblings of
 * `specBacklinks` / `specUnresolvedReferences`.
 *
 * Pins (gate: Xanthos 6569295349):
 *   - each page field calls the SAME `loadScannableCorpus` gate as its old field: an unreadable and a missing corpus
 *     get the old field's refusal byte for byte (name, message, extensions), never an empty page;
 *   - over 20 references: page 1 has 20 items, hasMore true and total the full count; the last page has hasMore
 *     false; the pages concatenated equal the old field's list exactly, order included, with no duplicate or gap;
 *   - ties: rows identical in every output field (one URN cited many times in one field) straddle the page
 *     boundaries and the order is the same on every request;
 *   - limit 201 is served as 200; limit 0 is count-only; omitted is 20;
 *   - the old fields still return the full set.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let admin: { id: string };
let outsider: { id: string };
let org: { id: string; urn: string };
let draft: { id: string; urn: string };

const as = (userId = admin.id): Context => ({ db, userId, roles: [] });
const urnOf = (loc: string) => `hrn:node:${draft.urn}:${loc}`;
const repeat = (loc: string, n: number) => Array.from({ length: n }, () => urnOf(loc)).join(' and ');
const spec = (loc: string, content: string | null) => db.node.create({
  data: { id: generateId(), memoryId: draft.id, loc, name: `Spec [${loc}]`, content, role: 'spec', nodeType: 'info' },
});
/** The thrown error as everything a client could observe of it. */
const refusalOf = async (p: Promise<unknown>) => {
  try { await p; return 'NO_ERROR'; } catch (e) {
    const err = e as Error & { extensions?: unknown };
    return JSON.stringify({ name: err.name, message: err.message, extensions: err.extensions ?? null });
  }
};
type Page = { items: unknown[]; total: number; hasMore: boolean };
const Q = () => resolvers.Query as unknown as Record<string, (p: null, a: Record<string, unknown>, c: Context) => Promise<Page>>;
const backlinksPage = (args: Record<string, unknown>, ctx = as()) => Q().specBacklinksPage(null, { memoryRef: draft.id, loc: 'pas:010', ...args }, ctx);
const unresolvedPage = (args: Record<string, unknown>, ctx = as()) => Q().specUnresolvedReferencesPage(null, { memoryRef: draft.id, ...args }, ctx);

/** Walk every page at `limit`, asserting the envelope on each. */
async function walk(fetchPage: (a: Record<string, unknown>) => Promise<Page>, limit: number) {
  const all: unknown[] = [];
  for (let offset = 0; ; offset += limit) {
    const page = await fetchPage({ limit, offset });
    all.push(...page.items);
    expect(page.hasMore).toBe(offset + page.items.length < page.total);
    if (!page.hasMore) return { all, total: page.total };
  }
}

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'Pages Org', urn: 'pages3222.example' } });
  admin = await db.user.create({ data: { githubId: 322201, githubUsername: 'pages-admin', roles: [] } });
  outsider = await db.user.create({ data: { githubId: 322202, githubUsername: 'pages-outsider', roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  draft = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'specs-draft', draftCorpus: true }, as());

  const target = await spec('pas:010', 'The target.');
  await resolvers.Mutation.reserveSpecCitation(null, { memoryRef: draft.id, loc: 'pas:030' }, as());
  const placeholder = await db.node.findFirstOrThrow({ where: { memoryId: draft.id, loc: 'pas:030' } });
  // Ties: one source cites pas:010 13 times in content and pas:099 (missing) 13 times, every row identical in
  // every output field; a second source repeats the shape in another field; edges follow the text rows.
  const a = await spec('pas:020', `${repeat('pas:010', 13)}; ${repeat('pas:099', 13)}`);
  const b = await db.node.create({ data: {
    id: generateId(), memoryId: draft.id, loc: 'pas:040', name: `Spec ${repeat('pas:010', 4)}`,
    content: `${repeat('pas:010', 6)} ${repeat('pas:030', 5)}`, role: 'spec', nodeType: 'info',
  } });
  for (const [src, name] of [[a, 'depends-on'], [b, 'depends-on'], [b, 'cites']] as const) {
    await db.edge.create({ data: { memoryId: draft.id, sourceId: src.id, targetId: target.id, loc: `${src.id}:${name}:pas:010`, name } });
    await db.edge.create({ data: { memoryId: draft.id, sourceId: src.id, targetId: placeholder.id, loc: `${src.id}:${name}:pas:030`, name } });
  }
});

describe('the page fields share the old fields\' gate and refusals', () => {
  it('an unreadable corpus refuses byte-identically to the old field, never an empty page', async () => {
    const oldB = await refusalOf(resolvers.Query.specBacklinks(null, { memoryRef: draft.id, loc: 'pas:010' }, as(outsider.id)));
    expect(oldB).not.toBe('NO_ERROR');
    expect(await refusalOf(backlinksPage({}, as(outsider.id)))).toBe(oldB);
    const oldU = await refusalOf(resolvers.Query.specUnresolvedReferences(null, { memoryRef: draft.id }, as(outsider.id)));
    expect(oldU).not.toBe('NO_ERROR');
    expect(await refusalOf(unresolvedPage({}, as(outsider.id)))).toBe(oldU);
  });

  it('a missing corpus refuses byte-identically to the old field', async () => {
    const memoryRef = `hrn:mem:${org.urn}:no-such`;
    const oldB = await refusalOf(resolvers.Query.specBacklinks(null, { memoryRef, loc: 'pas:010' }, as()));
    expect(oldB).not.toBe('NO_ERROR');
    expect(await refusalOf(backlinksPage({ memoryRef }))).toBe(oldB);
    const oldU = await refusalOf(resolvers.Query.specUnresolvedReferences(null, { memoryRef }, as()));
    expect(oldU).not.toBe('NO_ERROR');
    expect(await refusalOf(unresolvedPage({ memoryRef }))).toBe(oldU);
  });
});

describe.each([
  ['specBacklinksPage', () => resolvers.Query.specBacklinks(null, { memoryRef: draft.id, loc: 'pas:010' }, as()), backlinksPage],
  ['specUnresolvedReferencesPage', () => resolvers.Query.specUnresolvedReferences(null, { memoryRef: draft.id }, as()), unresolvedPage],
] as const)('%s pages the old field\'s list', (_name, oldField, page) => {
  it('page 1 is 20 with the full total; the pages concatenate to the old list, order included', async () => {
    const full = await oldField();
    expect(full.length).toBeGreaterThan(20);
    const first = await page({});
    expect(first.items).toHaveLength(20);
    expect(first).toMatchObject({ total: full.length, hasMore: true });
    expect(first.items).toEqual(full.slice(0, 20));
    for (const limit of [7, 20]) {
      const { all, total } = await walk(page, limit);
      expect(total).toBe(full.length);
      expect(all).toEqual(full);
    }
  });

  it('rows identical in every output field straddle a page boundary in a stable order', async () => {
    const full = await oldField();
    const keys = full.map((r) => JSON.stringify(r));
    expect(new Set(keys).size).toBeLessThan(keys.length);
    const twice = [await walk(page, 5), await walk(page, 5)];
    expect(twice[0].all).toEqual(twice[1].all);
    expect(twice[0].all).toEqual(full);
  });

  it('limit 201 is served as 200, 0 is count-only, past the end is empty', async () => {
    await spec('pas:050', `${repeat('pas:010', 220)} ${repeat('pas:099', 220)}`);
    const full = await oldField();
    expect(full.length).toBeGreaterThan(201);
    expect(await page({ limit: 201 })).toEqual({ items: full.slice(0, 200), total: full.length, hasMore: true });
    expect(await page({ limit: 0 })).toEqual({ items: [], total: full.length, hasMore: full.length > 0 });
    expect(await page({ offset: full.length })).toEqual({ items: [], total: full.length, hasMore: false });
  });
});

describe('the old fields are unchanged', () => {
  it('specBacklinks and specUnresolvedReferences still return every row', async () => {
    const backlinks = await resolvers.Query.specBacklinks(null, { memoryRef: draft.id, loc: 'pas:010' }, as());
    // 13 + 4 + 6 text references, then 3 edges.
    expect(backlinks).toHaveLength(26);
    expect(backlinks.slice(-3).map((r) => r.kind)).toEqual(['EDGE', 'EDGE', 'EDGE']);
    const unresolved = await resolvers.Query.specUnresolvedReferences(null, { memoryRef: draft.id }, as());
    // 13 MISSING + 5 PLACEHOLDER text references, then 3 edges to the placeholder.
    expect(unresolved).toHaveLength(21);
  });
});
