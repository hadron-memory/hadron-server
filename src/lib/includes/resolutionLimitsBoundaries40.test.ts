/**
 * hadron-internal#40 — boundary pins for the resolution budget, with the limits lowered through
 * `setResolutionLimits` so each boundary is reached exactly with tiny fixtures: one fixture at the
 * limit resolves, the next unit over refuses. Also pins that the budgeted writer renders exactly
 * as `Mustache.render` does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Mustache from 'mustache';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { computeApprovalHash } from '../approvalHash.js';
import { compileTemplate } from '../template.js';
import { BROKEN_INCLUDE_NOTICE } from './resolveNodeContent.js';
import { renderBudgeted } from './budgetedWriter.js';
import {
  CONTENT_RESOLUTION_LIMIT_EXCEEDED, ContentResolutionLimitError, ResolutionBudget, setResolutionLimits,
  type ResolutionLimits,
} from './resolutionBudget.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let memoryId: string;
let reader: { id: string };
const ctx = (): Context => ({ db, userId: reader.id, roles: [] });
const mk = (loc: string, content: string | null, extra: Record<string, unknown> = {}) =>
  db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, content, ...extra } });

/** Resolve `loc` as the reader, under `limits`: its content, or the refusal's limit. */
async function readUnder(loc: string, limits: Partial<ResolutionLimits>) {
  setResolutionLimits({ limits });
  try {
    const n = await resolvers.Query.node(null, { ref: loc, memoryId } as never, ctx());
    // A fresh Context per read, so the request aggregate never carries between reads.
    const content = (await (resolvers as any).Node.content(n, {}, ctx(), {})) as string;
    return { content, limit: null as string | null };
  } catch (e) {
    if (e instanceof ContentResolutionLimitError) {
      expect(e.extensions.code).toBe(CONTENT_RESOLUTION_LIMIT_EXCEEDED);
      return { content: null, limit: e.limit as string };
    }
    throw e;
  }
}

/** A node with one revision; `approved` gives the live revision a valid approval record. */
async function target(loc: string, text: string, approved: boolean) {
  return mk(loc, text, {
    revSeq: 1,
    ...(approved ? {
      approvedRevNo: 1, approvedBy: reader.id, approvedAt: new Date(),
      approvalHash: computeApprovalHash({ title: loc, abstract: null, content: text }),
    } : {}),
  });
}

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Rb Org', urn: 'rb.example' } });
  reader = await db.user.create({ data: { githubId: 404101, githubUsername: 'rb-reader', handle: 'rb-reader', roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: reader.id, role: 'ADMIN' } });
  const m = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'rb' }, ctx());
  memoryId = m.id;
});
afterEach(() => setResolutionLimits(null));

describe('#40 byte boundary (UTF-8)', () => {
  it('exactly at the limit resolves; one byte over refuses', async () => {
    await mk('at', 'é'.repeat(5)); // 10 bytes
    await mk('over', 'é'.repeat(5) + 'x'); // 11 bytes
    await mk('pa', '{{> at}}');
    await mk('po', '{{> over}}');
    expect(await readUnder('pa', { maxBytes: 10 })).toEqual({ content: 'é'.repeat(5), limit: null });
    expect(await readUnder('po', { maxBytes: 10 })).toEqual({ content: null, limit: 'bytes' });
  });

  it('a multibyte target under the limit in characters but over it in bytes refuses', async () => {
    await mk('t', 'é'.repeat(6)); // 6 characters, 12 bytes
    await mk('p', '{{> t}}');
    expect(await readUnder('p', { maxBytes: 10 })).toEqual({ content: null, limit: 'bytes' });
  });
});

describe('#40 repetition is charged per tag', () => {
  it('a diamond charges the shared target once per path', async () => {
    await mk('t', 'xxxx');
    await mk('a', '{{> t}}{{> t}}');
    await mk('p', '{{> a}}{{> a}}'); // 4 paths to t: 16 bytes, 6 expansions
    expect(await readUnder('p', { maxBytes: 16 })).toEqual({ content: 'x'.repeat(16), limit: null });
    expect(await readUnder('p', { maxBytes: 15 })).toEqual({ content: null, limit: 'bytes' });
    expect(await readUnder('p', { maxExpansions: 6 })).toMatchObject({ limit: null });
    expect(await readUnder('p', { maxExpansions: 5 })).toEqual({ content: null, limit: 'expansions' });
  });

  it('a memo hit costs no lookup but still costs its expansion', async () => {
    await mk('t', 'y');
    await mk('p', '{{> t}}'.repeat(5));
    // One lookup for t (the rest are memo hits) plus one for the default data node.
    expect(await readUnder('p', { maxLookups: 2 })).toEqual({ content: 'yyyyy', limit: null });
    expect(await readUnder('p', { maxExpansions: 5 })).toMatchObject({ limit: null });
    expect(await readUnder('p', { maxExpansions: 4 })).toEqual({ content: null, limit: 'expansions' });
  });
});

describe('#40 loaded text', () => {
  // The approval reads load the live row again (its name `t` and its content), and that is charged: the meter
  // counts what each query actually loads, not what is served (private #40, second engineering read P2-2).
  it('a target with no qualifying approved revision still charges its loaded text, though only the notice is served', async () => {
    await target('t', 'L'.repeat(100), false);
    await mk('p', '{{> t approved}}');
    // The target row (100), then the verdict's live row (1 + 100).
    expect(await readUnder('p', { maxLoadedBytes: 201 })).toEqual({ content: BROKEN_INCLUDE_NOTICE, limit: null });
    expect(await readUnder('p', { maxLoadedBytes: 200 })).toEqual({ content: null, limit: 'loaded' });
  });

  it('an approved revision served charges every row its approval reads load', async () => {
    await target('t', 'A'.repeat(50), true);
    await mk('p', '{{> t approved}}');
    // The target row (50), the search's verdict on the live row (1 + 50), and the served verdict's (1 + 50).
    expect(await readUnder('p', { maxLoadedBytes: 152 })).toEqual({ content: 'A'.repeat(50), limit: null });
    expect(await readUnder('p', { maxLoadedBytes: 151 })).toEqual({ content: null, limit: 'loaded' });
  });
});

describe('#40 approved lookups are not memoized, and every approval query is charged', () => {
  // Lookups: 1 for the target (memoized), each tag's own, 1 for the default data node. A verdict is 3 queries
  // (the live row, the revision, the memories); an unpinned search adds 3 of its own (the live row, the
  // snapshot numbers, the live number) before it asks for verdicts.
  it('unpinned: every tag pays the search (3 + a verdict) and the served verdict (3)', async () => {
    await target('t', 'v', true);
    await mk('two', '{{> t approved}}'.repeat(2)); // 1 + 2 × 9 + 1 = 20
    await mk('three', '{{> t approved}}'.repeat(3)); // 1 + 3 × 9 + 1 = 29
    expect(await readUnder('two', { maxLookups: 20 })).toEqual({ content: 'vv', limit: null });
    expect(await readUnder('two', { maxLookups: 19 })).toEqual({ content: null, limit: 'lookups' });
    expect(await readUnder('three', { maxLookups: 28 })).toEqual({ content: null, limit: 'lookups' });
  });

  it('pinned: every tag pays one verdict (3)', async () => {
    await target('t', 'v', true);
    await mk('two', '{{> t rev=1 approved}}'.repeat(2)); // 1 + 2 × 3 + 1 = 8
    await mk('three', '{{> t rev=1 approved}}'.repeat(3)); // 1 + 3 × 3 + 1 = 11
    expect(await readUnder('two', { maxLookups: 8 })).toEqual({ content: 'vv', limit: null });
    expect(await readUnder('two', { maxLookups: 7 })).toEqual({ content: null, limit: 'lookups' });
    expect(await readUnder('three', { maxLookups: 10 })).toEqual({ content: null, limit: 'lookups' });
  });

  // Approval state is not hidden from this reader (it may read the target, and its approval with it), so the two
  // need not cost the same: the charge follows the queries each actually runs. A target the reader may NOT read
  // never reaches the approval reads at all (the URN parity pins below).
  it('a target with no approved revision pays for the queries it runs: the search, one verdict, one history page', async () => {
    await target('t', 'v', false);
    await mk('two', '{{> t approved}}'.repeat(2)); // 1 + 2 × (3 + 3 + 1) + 1 = 16
    expect(await readUnder('two', { maxLookups: 16 })).toEqual({ content: `${BROKEN_INCLUDE_NOTICE}${BROKEN_INCLUDE_NOTICE}`, limit: null });
    expect(await readUnder('two', { maxLookups: 15 })).toEqual({ content: null, limit: 'lookups' });
  });
});

describe('#40 the budgeted writer renders exactly as Mustache.render', () => {
  const big = (): ResolutionBudget => new ResolutionBudget({
    maxBytes: 1e9, maxRenderSteps: 1e9, maxExpansions: 1e9, maxLookups: 1e9, maxLoadedBytes: 1e9,
  });
  const cases: Array<[string, string, Record<string, unknown>]> = [
    ['variables and escaping', 'a {{x}} {{{x}}} {{&x}} b', { x: `<a href="q">'&'</a>` }],
    ['nested sections', '{{#outer}}[{{name}}{{#inner}}({{.}}){{/inner}}]{{/outer}}', {
      outer: [{ name: 'o1', inner: [1, 2] }, { name: 'o2', inner: [] }],
    }],
    ['inverted sections', '{{^empty}}none{{/empty}}{{^full}}never{{/full}}{{#full}}yes{{/full}}', { empty: [], full: [1] }],
    ['dotted names and context lookup', '{{a.b.c}} {{#a}}{{b.c}}{{/a}}', { a: { b: { c: 'deep' } } }],
    ['delimiter change', '{{=<% %>=}}<% x %> {{x}} <%={{ }}=%>{{x}}', { x: 'v' }],
    ['comments and missing values', 'a{{! note }}b{{missing}}c{{#missing}}d{{/missing}}', {}],
    ['standalone lines', 'top\n{{#s}}\n  line {{.}}\n{{/s}}\nbottom', { s: [1, 2] }],
    ['falsy and boolean sections', '{{#f}}F{{/f}}{{#t}}T{{/t}}{{#z}}Z{{/z}}{{^z}}notZ{{/z}}', { f: false, t: true, z: 0 }],
  ];
  it('a lambda (a view function, as Mustache supports; stored data cannot hold one) renders the same', () => {
    const view = { wrap: () => (text: string, render: (t: string) => string) => `<b>${render(text)}</b>`, name: 'n' };
    const template = '{{#wrap}}hi {{name}}{{/wrap}}';
    expect(renderBudgeted(template, view, big())).toBe(Mustache.render(template, view));
  });

  it('a partial tag with no partials given (includes are spliced before the render) renders the same: empty', () => {
    const template = 'a{{> leftover}}b';
    expect(renderBudgeted(template, {}, big())).toBe(Mustache.render(template, {}));
  });

  it.each(cases)('%s', (_name, template, view) => {
    expect(renderBudgeted(template, view, big())).toBe(Mustache.render(template, view));
  });

  it.each([['unclosed section', '{{#a}}x'], ['unopened close', 'x{{/a}}'], ['unclosed tag', 'x {{y']])(
    'a malformed template (%s) throws the same error as Mustache.render',
    (_name, template) => {
      let expected: unknown;
      try { Mustache.render(template, {}); } catch (e) { expected = (e as Error).message; }
      expect(expected).toBeTruthy();
      expect(() => renderBudgeted(template, {}, big())).toThrow(expected as string);
    },
  );

  it('compileTemplate keeps its malformed-template fallback: the stored text, not a limit refusal', async () => {
    expect(await compileTemplate('{{#a}}x', {}, memoryId, db, {})).toBe('{{#a}}x');
  });

  it('a limit inside the render is not swallowed by that fallback', async () => {
    const budget = new ResolutionBudget({ maxBytes: 3 });
    await expect(compileTemplate('{{x}}', { x: 'four' }, memoryId, db, {}, undefined, { budget }))
      .rejects.toBeInstanceOf(ContentResolutionLimitError);
  });
});
