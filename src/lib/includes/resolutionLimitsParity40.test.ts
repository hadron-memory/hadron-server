/**
 * hadron-internal#40 — pins for lookup-cost parity, approval-history charging, context-stack lookup
 * charging, the bounded include parse, the request aggregate and the refusal remedies. Fixtures are tiny
 * (limits lowered through `setResolutionLimits`) except the render-depth read, which runs at the
 * default limits on purpose and stays well under a megabyte.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { computeApprovalHash } from '../approvalHash.js';
import { BROKEN_INCLUDE_NOTICE, chargeRequestServed } from './resolveNodeContent.js';
import { renderBudgeted } from './budgetedWriter.js';
import {
  CONTENT_RESOLUTION_LIMIT_EXCEEDED, ContentResolutionLimitError, RequestResolutionBudget, ResolutionBudget,
  setResolutionLimits, type ResolutionLimits,
} from './resolutionBudget.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let memoryId: string;
let foreignUrn: string;
let foreignMemoryId: string;
let reader: { id: string };
const ctx = (): Context => ({ db, userId: reader.id, roles: [] });
const mk = (loc: string, content: string | null, extra: Record<string, unknown> = {}) =>
  db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, content, ...extra } });

/** Resolve `loc` as the reader, under `limits` (none: the defaults): its content, or the refusal. */
async function readUnder(loc: string, limits: Partial<ResolutionLimits> = {}, requestMaxBytes?: number) {
  setResolutionLimits({ limits, requestMaxBytes });
  try {
    const n = await resolvers.Query.node(null, { ref: loc, memoryId } as never, ctx());
    const content = (await (resolvers as any).Node.content(n, {}, ctx(), {})) as string;
    return { content, limit: null as string | null, message: null as string | null };
  } catch (e) {
    if (e instanceof ContentResolutionLimitError) {
      expect(e.extensions.code).toBe(CONTENT_RESOLUTION_LIMIT_EXCEEDED);
      return { content: null, limit: e.limit as string, message: e.message };
    }
    throw e;
  }
}

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Rf Org', urn: 'rf.example' } });
  const other = await db.organization.create({ data: { id: generateId(), name: 'Rf Other', urn: 'rf-other.example' } });
  reader = await db.user.create({ data: { githubId: 404201, githubUsername: 'rf-reader', handle: 'rf-reader', roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: reader.id, role: 'ADMIN' } });
  const m = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'rf' }, ctx());
  memoryId = m.id;
  const fm = await db.memory.create({
    data: { name: 'Foreign', urn: 'rf-other.example:foreign', organizationId: other.id, class: 'knowledge', visibility: 'ORGANIZATION' },
  });
  foreignMemoryId = fm.id; foreignUrn = fm.urn;
});
afterEach(() => setResolutionLimits(null));

describe('#40: a missing and an unreadable URN target cost the same at the lookup bound', () => {
  // Lookups: the URN identity and its target (charged together, before the identity is known), then the
  // default data node. A missing target and an existing one the reader may not read both cost 3.
  beforeEach(async () => {
    await db.node.create({ data: { id: generateId(), memoryId: foreignMemoryId, loc: 'there', name: 'there', content: 'S' } });
    await mk('missing', `a {{> hrn:node:${foreignUrn}:absent}} b`);
    await mk('unreadable', `a {{> hrn:node:${foreignUrn}:there}} b`);
  });

  it('at the bound both resolve to the same notice', async () => {
    const want = { content: `a ${BROKEN_INCLUDE_NOTICE} b`, limit: null, message: null };
    expect(await readUnder('missing', { maxLookups: 3 })).toEqual(want);
    expect(await readUnder('unreadable', { maxLookups: 3 })).toEqual(want);
  });

  it('one under the bound both refuse identically', async () => {
    const a = await readUnder('missing', { maxLookups: 2 });
    expect(a).toMatchObject({ content: null, limit: 'lookups' });
    expect(await readUnder('unreadable', { maxLookups: 2 })).toEqual(a);
  });
});

describe('#40: an approval history is charged as it is read', () => {
  /**
   * `t` is at revision 21. Snapshot 20 holds the text with no approval of its own; snapshot 19 is the
   * earliest valid approval of that text; snapshots 1-18 carry the same approval hash over altered text
   * (not approvals). `rev=20 approved` must page through all nineteen to find 19, and pays for each.
   */
  beforeEach(async () => {
    const text = 'H'.repeat(100);
    const hash = computeApprovalHash({ title: 't', abstract: null, content: text });
    const t = await mk('t', text, { revSeq: 21 });
    const approval = { approvalHash: hash, approvedAt: new Date(), approvedBy: reader.id };
    for (let revNo = 1; revNo <= 20; revNo++) {
      await db.nodeRevision.create({ data: {
        id: generateId(), nodeId: t.id, memoryId, revNo, loc: 't', name: 't', tags: [],
        content: revNo <= 18 ? 'X'.repeat(100) : text,
        ...(revNo <= 19 ? approval : {}),
      } });
    }
    await mk('p', '{{> t rev=20 approved}}');
  });

  // Loaded: the target row (100), the verdict's live row (1 + 100) and revision 20 (1 + 100), then
  // revisions 1-19 (19 × 101) = 2,221.
  it('loaded text: the whole history read is charged, at the byte', async () => {
    expect(await readUnder('p', { maxLoadedBytes: 2_221 })).toMatchObject({ content: 'H'.repeat(100), limit: null });
    expect(await readUnder('p', { maxLoadedBytes: 2_220 })).toMatchObject({ content: null, limit: 'loaded' });
  });

  // Lookups: the target (1), the verdict's live row, revision and memories (3), three pages of 8 (3),
  // the default data node (1) = 8.
  it('lookups: every page of history is a charged query', async () => {
    expect(await readUnder('p', { maxLookups: 8 })).toMatchObject({ content: 'H'.repeat(100), limit: null });
    expect(await readUnder('p', { maxLookups: 7 })).toMatchObject({ content: null, limit: 'lookups' });
  });
});

describe('#40: a lookup is charged by the context stack it may walk', () => {
  // Root: 1 entry + 1 token (#n), at depth 1 (no extra) = 2. Depth 2: 1 + 1 (#n) + 1 lookup × 1 = 3.
  // Depth 3: 1 + 2 (a, b) + 2 lookups × 2 = 7. Total 12.
  const template = '{{#n}}{{#n}}{{a}}{{b}}{{/n}}{{/n}}';
  it('the exact count, at the step', () => {
    expect(renderBudgeted(template, { n: 1 }, new ResolutionBudget({ maxRenderSteps: 12 }))).toBe('');
    expect(() => renderBudgeted(template, { n: 1 }, new ResolutionBudget({ maxRenderSteps: 11 })))
      .toThrow(expect.objectContaining({ limit: 'steps' }));
  });

  it('a boolean section pushes no context, so it adds no depth', () => {
    // Root 2; the section renders in the root context: 1 + 2 tokens, depth 1 = 3. Total 5.
    const flat = '{{#n}}{{a}}{{b}}{{/n}}';
    expect(renderBudgeted(flat, { n: true }, new ResolutionBudget({ maxRenderSteps: 5 }))).toBe('');
    expect(() => renderBudgeted(flat, { n: true }, new ResolutionBudget({ maxRenderSteps: 4 })))
      .toThrow(expect.objectContaining({ limit: 'steps' }));
  });

  // Scaled down: 300 nested sections over a number around 1,000 distinct names that all
  // miss. Each miss walks all 301 contexts, so the render is ~300k probes; the token visits alone are ~1.3k.
  const names = Array.from({ length: 1_000 }, (_, i) => `{{v${i}}}`).join('');
  it('deep nesting over many missing names refuses as steps at the default limits, through a GraphQL read', async () => {
    await mk('deep', `${'{{#n}}'.repeat(300)}${names}${'{{/n}}'.repeat(300)}`, { data: { n: 1 } });
    expect(await readUnder('deep')).toMatchObject({ content: null, limit: 'steps' });
  });

  it('control: the same names with no nesting resolve', async () => {
    await mk('flat', `x${names}y`, { data: { n: 1 } });
    expect(await readUnder('flat')).toMatchObject({ content: 'xy', limit: null });
  });
});

describe('#40: the include parse is bounded by the expansions left', () => {
  it('more well-formed tags than expansions allowed refuses before a later malformed tag is reached', async () => {
    await mk('a', 'A');
    await mk('p', '{{> a}}{{> a}}{{> a}}{{> a}} {{> }}');
    expect(await readUnder('p', { maxExpansions: 3 })).toMatchObject({ content: null, limit: 'expansions' });
  });

  it('control: a malformed tag met within the bound still leaves the text literal, as before', async () => {
    await mk('a', 'A');
    await mk('p', '{{> a}}{{> a}}{{> a}} {{> }}');
    expect(await readUnder('p', { maxExpansions: 3 })).toMatchObject({ limit: null });
  });

  it('control: exactly the allowed number of tags resolves', async () => {
    await mk('a', 'A');
    await mk('p', '{{> a}}{{> a}}{{> a}}');
    expect(await readUnder('p', { maxExpansions: 3 })).toMatchObject({ content: 'AAA', limit: null });
  });
});

describe('#40: a refused read consumes none of the request aggregate', () => {
  it('served, refused, then a smaller read that fits is still served', () => {
    const request = new RequestResolutionBudget(10);
    request.chargeServed('x'.repeat(6));
    expect(() => request.chargeServed('x'.repeat(6))).toThrow(expect.objectContaining({ limit: 'requestBytes' }));
    expect(() => request.chargeServed('x'.repeat(4))).not.toThrow();
    expect(() => request.chargeServed('x')).toThrow(expect.objectContaining({ limit: 'requestBytes' }));
  });
});

describe('#40: a direct compile charges the request like a resolved read', () => {
  it('a compiled template is charged; a body with no template syntax is served as stored, uncharged', () => {
    setResolutionLimits({ requestMaxBytes: 4 });
    const c = ctx();
    expect(chargeRequestServed(c, 'plain text, no template', 'plain text, no template')).toBe('plain text, no template');
    expect(chargeRequestServed(c, '{{x}}', 'abcd')).toBe('abcd');
    expect(() => chargeRequestServed(c, '{{x}}', 'e')).toThrow(expect.objectContaining({ limit: 'requestBytes' }));
  });
});

describe('#40: the refusal names a remedy the surface offers', () => {
  it('a read keeps the raw remedy', async () => {
    await mk('t', 'x'.repeat(20));
    await mk('p', '{{> t}}');
    expect((await readUnder('p', { maxBytes: 12 })).message).toBe(
      'This content could not be resolved: it exceeds the size limit for a resolved read. '
        + 'Nothing partial was returned. Read it with raw: true to get the stored text.',
    );
  });

  it('the request aggregate suggests smaller requests', async () => {
    await mk('t', 'x'.repeat(20));
    await mk('p', '{{> t}}');
    expect((await readUnder('p', {}, 8)).message).toBe(
      'This content could not be resolved: it exceeds the per-request size limit for a resolved read. '
        + 'Nothing partial was returned. Split the work into smaller requests, or read it with raw: true to get the stored text.',
    );
  });
});
