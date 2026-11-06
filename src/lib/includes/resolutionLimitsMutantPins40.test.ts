/**
 * hadron-internal#40 — pins added for the mutants the first run left alive. Each block names the guard it holds.
 * The includes-only reads matter: a full read also renders, and the render's own byte charge can hide a missing
 * splice charge, so the splice charges are pinned where nothing renders after them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { compileTemplate } from '../template.js';
import { BROKEN_INCLUDE_NOTICE, resolveNodeContent } from './resolveNodeContent.js';
import { spliceIncludes } from './spliceIncludes.js';
import { BudgetedWriter, renderBudgeted } from './budgetedWriter.js';
import { toolErrorResult } from '../../mcp/toolError.js';
import {
  CONTENT_RESOLUTION_LIMIT_EXCEEDED, ContentResolutionLimitError, RequestResolutionBudget, ResolutionBudget,
  setResolutionLimits, utf8Bytes, type ResolutionLimits,
} from './resolutionBudget.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let memoryId: string;
let reader: { id: string };
const ctx = (): Context => ({ db, userId: reader.id, roles: [] });
const mk = (loc: string, content: string | null, extra: Record<string, unknown> = {}) =>
  db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, content, ...extra } });

async function outcome(run: () => Promise<string | null>) {
  try {
    return { content: await run(), limit: null as string | null };
  } catch (e) {
    if (e instanceof ContentResolutionLimitError) {
      expect(e.extensions.code).toBe(CONTENT_RESOLUTION_LIMIT_EXCEEDED);
      return { content: null, limit: e.limit as string };
    }
    throw e;
  }
}

/** A full resolved read of `loc` (splice, then the render), with a fresh Context. */
async function readUnder(loc: string, limits: Partial<ResolutionLimits>) {
  setResolutionLimits({ limits });
  const n = await resolvers.Query.node(null, { ref: loc, memoryId } as never, ctx());
  return outcome(async () => (await (resolvers as any).Node.content(n, {}, ctx(), {})) as string);
}

/** An includes-only read of `loc` (the skill export's mode): splicing and nothing after it. */
async function spliceUnder(loc: string, limits: Partial<ResolutionLimits>) {
  setResolutionLimits({ limits });
  const n = await db.node.findFirstOrThrow({ where: { memoryId, loc } });
  return outcome(() => resolveNodeContent(ctx(), n, { mode: 'includes' }));
}

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Mp Org', urn: 'mp.example' } });
  reader = await db.user.create({ data: { githubId: 404202, githubUsername: 'mp-reader', handle: 'mp-reader', roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: reader.id, role: 'ADMIN' } });
  const m = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'mp' }, ctx());
  memoryId = m.id;
});
afterEach(() => setResolutionLimits(null));

describe('#40 the budgeted writer', () => {
  it('charges literal template text it writes, not only the values', () => {
    // 8 literal bytes + a 2-byte value = 10 rendered bytes.
    expect(renderBudgeted('RRRRRRRR{{x}}', { x: 'yy' }, new ResolutionBudget({ maxBytes: 10 }))).toBe('RRRRRRRRyy');
    expect(() => renderBudgeted('RRRRRRRR{{x}}', { x: 'yy' }, new ResolutionBudget({ maxBytes: 9 })))
      .toThrow(ContentResolutionLimitError);
  });

  it('keeps no parsed template after a render', () => {
    const writer = new BudgetedWriter(new ResolutionBudget());
    expect(writer.render('a {{x}} b', { x: 1 })).toBe('a 1 b');
    expect((writer as unknown as { templateCache?: unknown }).templateCache).toBeUndefined();
  });
});

describe('#40 spliced bytes, with nothing rendered after', () => {
  it('exactly at the byte limit resolves; one byte over refuses', async () => {
    await mk('at', 'é'.repeat(5)); // 10 bytes
    await mk('over', 'é'.repeat(5) + 'x'); // 11 bytes
    await mk('pa', '{{> at}}');
    await mk('po', '{{> over}}');
    expect(await spliceUnder('pa', { maxBytes: 10 })).toEqual({ content: 'é'.repeat(5), limit: null });
    expect(await spliceUnder('po', { maxBytes: 10 })).toEqual({ content: null, limit: 'bytes' });
  });

  it('the literal text around a tag is charged', async () => {
    await mk('t', 'y');
    await mk('p', `${'X'.repeat(20)}{{> t}}`);
    expect(await spliceUnder('p', { maxBytes: 21 })).toEqual({ content: `${'X'.repeat(20)}y`, limit: null });
    expect(await spliceUnder('p', { maxBytes: 20 })).toEqual({ content: null, limit: 'bytes' });
  });

  it('the broken-include notice is charged, the same for every cause', async () => {
    await mk('p', '{{> missing}}'.repeat(3));
    const n = utf8Bytes(BROKEN_INCLUDE_NOTICE) * 3;
    expect(await spliceUnder('p', { maxBytes: n })).toEqual({ content: BROKEN_INCLUDE_NOTICE.repeat(3), limit: null });
    expect(await spliceUnder('p', { maxBytes: n - 1 })).toEqual({ content: null, limit: 'bytes' });
  });

  it('a body with a malformed include tag is charged as the text it serves', async () => {
    const body = `${'M'.repeat(20)}{{> t bogus}}`;
    await mk('p', body);
    expect(await spliceUnder('p', { maxBytes: utf8Bytes(body) })).toEqual({ content: body, limit: null });
    expect(await spliceUnder('p', { maxBytes: utf8Bytes(body) - 1 })).toEqual({ content: null, limit: 'bytes' });
  });

  it('spliceIncludes with no budget given bounds itself with the configured limits', async () => {
    await mk('t', 'four');
    setResolutionLimits({ limits: { maxBytes: 3 } });
    await expect(spliceIncludes(db, {}, '{{> t}}', { memoryId })).rejects.toBeInstanceOf(ContentResolutionLimitError);
  });
});

describe('#40 expansions past the depth limit', () => {
  it('the tag past the deepest level is still charged as an expansion', async () => {
    // c0 includes c1 ... c11; the tag in c10 is at level 11, past MAX_RESOLVE_DEPTH (10), and serves the notice.
    for (let i = 0; i <= 11; i++) await mk(`c${i}`, `{{> c${i + 1}}}`);
    expect(await readUnder('c0', { maxExpansions: 11 })).toEqual({ content: BROKEN_INCLUDE_NOTICE, limit: null });
    expect(await readUnder('c0', { maxExpansions: 10 })).toEqual({ content: null, limit: 'expansions' });
  });
});

describe('#40 loaded text and lookups for a target', () => {
  it('a repeated target (a memo hit) charges its loaded text once', async () => {
    await mk('t', 'L'.repeat(10));
    await mk('p', '{{> t}}{{> t}}');
    expect(await readUnder('p', { maxLoadedBytes: 10 })).toEqual({ content: 'L'.repeat(20), limit: null });
  });

  it('a pinned past revision costs one lookup and charges its own loaded text', async () => {
    const t = await mk('t', 'cur', { revSeq: 2 });
    await db.nodeRevision.create({ data: {
      id: generateId(), nodeId: t.id, memoryId, loc: 't', name: 't', content: 'R'.repeat(20), tags: [], revNo: 1,
    } });
    await mk('p', '{{> t rev=1}}');
    // Lookups: the target, the revision, the default data node. Loaded: 'cur' (3) + the revision (20).
    expect(await readUnder('p', { maxLookups: 3 })).toEqual({ content: 'R'.repeat(20), limit: null });
    expect(await readUnder('p', { maxLookups: 2 })).toEqual({ content: null, limit: 'lookups' });
    expect(await readUnder('p', { maxLoadedBytes: 23 })).toMatchObject({ limit: null });
    expect(await readUnder('p', { maxLoadedBytes: 22 })).toEqual({ content: null, limit: 'loaded' });
  });
});

describe('#40 the template compile', () => {
  it('the default data node charges its data as loaded text', async () => {
    const data = { k: 'D'.repeat(50) };
    await mk('data', null, { data });
    await mk('p', '{{k}}');
    const loaded = utf8Bytes(JSON.stringify(data));
    expect(await readUnder('p', { maxLoadedBytes: loaded })).toEqual({ content: 'D'.repeat(50), limit: null });
    expect(await readUnder('p', { maxLoadedBytes: loaded - 1 })).toEqual({ content: null, limit: 'loaded' });
  });

  it('a reference node costs a lookup and charges its loaded text', async () => {
    await mk('r', 'R'.repeat(30));
    await mk('p', 'v={{r.x}}');
    // Lookups: the default data node and r.
    expect(await readUnder('p', { maxLookups: 2 })).toEqual({ content: 'v=', limit: null });
    expect(await readUnder('p', { maxLookups: 1 })).toEqual({ content: null, limit: 'lookups' });
    expect(await readUnder('p', { maxLoadedBytes: 30 })).toMatchObject({ limit: null });
    expect(await readUnder('p', { maxLoadedBytes: 29 })).toEqual({ content: null, limit: 'loaded' });
  });

  it('a direct compile with no budget shares one budget between the splice and the render', async () => {
    await mk('t', 'x');
    // The splice's target lookup and the compile's data-node lookup: 2 against one budget.
    setResolutionLimits({ limits: { maxLookups: 2 } });
    expect(await compileTemplate('{{> t}}', null, memoryId, db, {})).toBe('x');
    setResolutionLimits({ limits: { maxLookups: 1 } });
    await expect(compileTemplate('{{> t}}', null, memoryId, db, {})).rejects.toBeInstanceOf(ContentResolutionLimitError);
  });
});

describe('#40 the request aggregate', () => {
  it('exactly at the per-request limit is served; one byte over refuses', () => {
    const served = new RequestResolutionBudget(10);
    served.chargeServed('x'.repeat(10));
    expect(() => served.chargeServed('x')).toThrow(ContentResolutionLimitError);
  });
});

describe('#40 MCP refusal mapping', () => {
  it('toolErrorResult maps the refusal to its fixed text, code and limit, never the generic fault', () => {
    const e = new ContentResolutionLimitError('bytes');
    const r = toolErrorResult(e, () => 'domain text') as { isError: boolean; content: Array<{ text: string }>; structuredContent?: unknown };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe(e.message);
    expect(r.structuredContent).toEqual({ error: { code: CONTENT_RESOLUTION_LIMIT_EXCEEDED, message: e.message, limit: 'bytes' } });
  });
});
