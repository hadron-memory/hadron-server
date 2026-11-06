/**
 * hadron-internal#40: pins for revision scoping, approval-page charging, the bounded literal-tag scan, the
 * request-aggregate remedy and per-segment lookup charging. Fixtures are tiny; limits are lowered through
 * `setResolutionLimits`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { computeApprovalHash } from '../approvalHash.js';
import { BROKEN_INCLUDE_NOTICE } from './resolveNodeContent.js';
import { spliceIncludes } from './spliceIncludes.js';
import { renderBudgeted } from './budgetedWriter.js';
import {
  CONTENT_RESOLUTION_LIMIT_EXCEEDED, ContentResolutionLimitError, ResolutionBudget,
  resolutionLimitMessage, setResolutionLimits, type ResolutionLimits,
} from './resolutionBudget.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let memoryId: string;
let foreignMemoryId: string;
let reader: { id: string };
const ctx = (): Context => ({ db, userId: reader.id, roles: [] });
const mk = (loc: string, content: string | null, extra: Record<string, unknown> = {}) =>
  db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, content, ...extra } });
const snapshot = (nodeId: string, revNo: number, content: string, extra: Record<string, unknown> = {}) =>
  db.nodeRevision.create({ data: { id: generateId(), nodeId, memoryId, revNo, loc: 'x', name: 't', tags: [], content, ...extra } });

/** Resolve `loc` as the reader, under `limits` (none: the defaults): its content, or the refusal. */
async function readUnder(loc: string, limits: Partial<ResolutionLimits> = {}) {
  setResolutionLimits({ limits });
  try {
    const n = await resolvers.Query.node(null, { ref: loc, memoryId } as never, ctx());
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

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Df Org', urn: 'df.example' } });
  const other = await db.organization.create({ data: { id: generateId(), name: 'Df Other', urn: 'df-other.example' } });
  reader = await db.user.create({ data: { githubId: 404301, githubUsername: 'df-reader', handle: 'df-reader', roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: reader.id, role: 'ADMIN' } });
  const m = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'df' }, ctx());
  memoryId = m.id;
  const fm = await db.memory.create({
    data: { name: 'Foreign', urn: 'df-other.example:foreign', organizationId: other.id, class: 'knowledge', visibility: 'ORGANIZATION' },
  });
  foreignMemoryId = fm.id;
});
afterEach(() => { setResolutionLimits(null); vi.restoreAllMocks(); });

describe('#40: a revision captured in a memory the include cannot serve is never charged', () => {
  // `victim` is live at revision 2 with content `v`; the parent asks for `rev=1 approved`. Whether revision 1
  // is absent or was captured in another org's memory (small or large), the reader must see the same answer.
  let victimId: string;
  beforeEach(async () => {
    victimId = (await mk('victim', 'v', { revSeq: 2 })).id;
    await mk('p', '{{> victim rev=1 approved}}');
  });
  const want = { content: BROKEN_INCLUDE_NOTICE, limit: null };

  it('absent revision: the notice', async () => {
    expect(await readUnder('p', { maxLoadedBytes: 40 })).toEqual(want);
  });

  it('foreign-captured large revision: the same notice, not a loaded refusal', async () => {
    await snapshot(victimId, 1, 'F'.repeat(100), { memoryId: foreignMemoryId });
    expect(await readUnder('p', { maxLoadedBytes: 40 })).toEqual(want);
  });

  it('foreign-captured small revision: the same notice', async () => {
    await snapshot(victimId, 1, 'f', { memoryId: foreignMemoryId });
    expect(await readUnder('p', { maxLoadedBytes: 40 })).toEqual(want);
  });

  it('control: a large revision this memory captured is still charged', async () => {
    await snapshot(victimId, 1, 'R'.repeat(100));
    expect(await readUnder('p', { maxLoadedBytes: 40 })).toMatchObject({ content: null, limit: 'loaded' });
  });
});

describe('#40: every row of a fetched approval page is charged', () => {
  // `t` is live at revision 10 (`v`). Snapshot 9 holds `H` with no approval of its own. Snapshot 1 is a valid
  // approval of `H`, so it is the earliest record; snapshots 2-8 carry the same hash over 100-byte altered text
  // (not approvals) and arrive in the same page of eight. They were loaded, so they are charged.
  beforeEach(async () => {
    const hash = computeApprovalHash({ title: 't', abstract: null, content: 'H' });
    const t = await mk('t', 'v', { revSeq: 10 });
    const approval = { approvalHash: hash, approvedAt: new Date(), approvedBy: reader.id };
    for (let revNo = 1; revNo <= 8; revNo++) await snapshot(t.id, revNo, revNo === 1 ? 'H' : 'X'.repeat(100), approval);
    await snapshot(t.id, 9, 'H');
    await mk('p', '{{> t rev=9 approved}}');
  });

  it('an early valid record does not leave the rest of its page uncharged', async () => {
    expect(await readUnder('p', { maxLoadedBytes: 200 })).toMatchObject({ content: null, limit: 'loaded' });
  });

  it('control: at the default limits the earliest record serves', async () => {
    expect(await readUnder('p')).toMatchObject({ content: 'H', limit: null });
  });
});

describe('#40: literal-tag discovery runs only within the expansions left', () => {
  /** Every match each `matchAll` call yields, in call order. */
  function countMatches(): number[] {
    const counts: number[] = [];
    const real = String.prototype.matchAll;
    vi.spyOn(String.prototype, 'matchAll').mockImplementation(function (this: string, re: RegExp) {
      const slot = counts.push(0) - 1;
      const it = real.call(this, re);
      return (function* () { for (const m of it) { counts[slot] += 1; yield m; } })() as never;
    });
    return counts;
  }

  it('twelve active tags with one expansion allowed: no pass yields more than the allowance plus one', async () => {
    setResolutionLimits({ limits: { maxExpansions: 1 } });
    const counts = countMatches();
    const content = Array.from({ length: 12 }, () => '{{> absent}}').join(' ');
    await expect(spliceIncludes(db, {}, content, { memoryId }, { literalGuard: '\u0001G\u0001', budget: new ResolutionBudget() }))
      .rejects.toMatchObject({ limit: 'expansions' });
    vi.restoreAllMocks();
    expect(Math.max(...counts)).toBeLessThanOrEqual(2);
  });

  it('control: a literal tag in code is still guarded within the bound', async () => {
    setResolutionLimits({ limits: { maxExpansions: 1 } });
    const out = await spliceIncludes(db, {}, '`{{> lit}}` {{> absent}}', { memoryId }, { literalGuard: '\u0001G\u0001', budget: new ResolutionBudget() });
    expect(out).toBe(`\`\u0001G\u0001 lit}}\` ${BROKEN_INCLUDE_NOTICE}`);
  });
});

describe('#40: the request-aggregate remedy fits every surface that meets it', () => {
  it('chat and run renders are not told to request fewer nodes', () => {
    expect(resolutionLimitMessage('requestBytes')).toBe(
      'This content could not be resolved: it exceeds the per-request size limit for a resolved read. '
        + 'Nothing partial was returned. Split the work into smaller requests, or read it with raw: true to get the stored text.',
    );
  });
});

describe('#40: a lookup is charged by every segment it walks at every level', () => {
  // Root 2; depth 2: 1 + 1 (#n) + 1 × 1 = 3; depth 3: 1 + 1 token + 2 segments (a.b) × 2 levels = 6. Total 11.
  const dotted = '{{#n}}{{#n}}{{a.b}}{{/n}}{{/n}}';
  it('a dotted name: the exact count, at the step', () => {
    expect(renderBudgeted(dotted, { n: 1 }, new ResolutionBudget({ maxRenderSteps: 11 }))).toBe('');
    expect(() => renderBudgeted(dotted, { n: 1 }, new ResolutionBudget({ maxRenderSteps: 10 })))
      .toThrow(expect.objectContaining({ limit: 'steps' }));
  });

  // The same count as plain names: {{&a}} and {{{b}}} walk the stack too (mustache parses both as '&').
  const unescaped = '{{#n}}{{#n}}{{&a}}{{{b}}}{{/n}}{{/n}}';
  it('unescaped lookups are charged by depth like plain ones', () => {
    expect(renderBudgeted(unescaped, { n: 1 }, new ResolutionBudget({ maxRenderSteps: 12 }))).toBe('');
    expect(() => renderBudgeted(unescaped, { n: 1 }, new ResolutionBudget({ maxRenderSteps: 11 })))
      .toThrow(expect.objectContaining({ limit: 'steps' }));
  });

  // The shape: 550 nested sections over 40 long dotted names that all miss, at the default limits.
  const longName = (i: number) => `q${i}` + '.a'.repeat(10_500);
  it('long dotted names in deep nesting refuse as steps at the default limits', () => {
    const body = Array.from({ length: 40 }, (_, i) => `{{${longName(i)}}}`).join('');
    const template = `${'{{#n}}'.repeat(550)}${body}${'{{/n}}'.repeat(550)}`;
    expect(() => renderBudgeted(template, { n: 1 }, new ResolutionBudget()))
      .toThrow(expect.objectContaining({ limit: 'steps' }));
  });

  it('control: the same nesting with undotted names renders', () => {
    const body = Array.from({ length: 40 }, (_, i) => `{{q${i}}}`).join('');
    expect(renderBudgeted(`${'{{#n}}'.repeat(550)}${body}${'{{/n}}'.repeat(550)}`, { n: 1 }, new ResolutionBudget())).toBe('');
  });
});
