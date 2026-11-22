/**
 * #4680 (follow-up to #4671, #632): the run search tool's previews, error honesty and persistent pins.
 * F4 match-centered previews, F5 named bounds, F6 Unicode code-point-safe truncation, F7 persistent pins (keyword syntax,
 * node-URN-as-memory, ambiguous legacy memory, error propagation), F1/F2 late-page failure honesty (a fixed content-free marker,
 * cancellation stays fatal, a later fence-query failure keeps only already-fenced hits).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../id.js';
import { runContext } from '../../../jobs/appRunDeps.js';
import { resolvers } from '../../../api/graphql/schema/resolvers.js';
import { emitNodeUrnV2 } from '../../urnEmit.js';
import { AmbiguousLegacyUrnError, MemoryNotFoundError } from '../../entityRef/errors.js';
import * as memoryRef from '../../entityRef/memoryRef.js';
import { hadronFindNodes, truncateCodePoints, NAME_MAX_LENGTH, DESCRIPTION_MAX_LENGTH, SNIPPET_MAX_LENGTH } from './memorySearchTools.js';
import type { RunToolContext } from './types.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const Q = resolvers.Query as unknown as { findNodes: (...args: any[]) => Promise<any> };
let orgId: string, appId: string, agentId: string;
let mem: { id: string; urn: string };
type Hit = { urn: string; name: string; description: string | null; snippet: string; score: number | null };
type Out = { hits: Hit[]; truncated?: true; truncatedReason?: string };
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const points = (s: string) => Array.from(s).length;

async function context(): Promise<RunToolContext> {
  const run = await db.appRun.create({ data: { id: generateId(), organizationId: orgId, appId, agentId, userId: null,
    triggerKind: 'MANUAL', entryNodeUrn: 'hrn:node:s4680.example:attached:flow', status: 'RUNNING' } });
  return { db, run, principal: runContext(db, run), log: vi.fn() };
}
const call = (c: RunToolContext, args: Record<string, unknown>) => hadronFindNodes.execute(c, args) as Promise<Out>;
const node = (loc: string, extra: Record<string, unknown> = {}) =>
  db.node.create({ data: { id: generateId(), memoryId: mem.id, loc, name: `doc ${loc}`, content: 'body', ...extra } });

beforeEach(async () => {
  vi.restoreAllMocks();
  await cleanDb(db);
  orgId = (await db.organization.create({ data: { id: generateId(), name: 's4680', urn: 's4680.example' } })).id;
  appId = (await db.app.create({ data: { id: generateId(), name: 'S4680', urn: 's4680.example:app', organizationId: orgId } })).id;
  agentId = (await db.agent.create({ data: { id: generateId(), name: 'S4680', urn: 's4680.example:agent', organizationId: orgId } })).id;
  await db.appAgent.create({ data: { appId, agentId } });
  mem = await db.memory.create({ data: { id: generateId(), urn: 's4680.example:main', name: 'main', organizationId: orgId,
    class: 'app', appId, visibility: null } });
});

describe('#4680 F5 the named bounds', () => {
  it('names the three output bounds', () => {
    expect([NAME_MAX_LENGTH, DESCRIPTION_MAX_LENGTH, SNIPPET_MAX_LENGTH]).toEqual([300, 500, 500]);
  });
});

describe('#4680 F6 truncation counts code points, never half a surrogate pair', () => {
  it('truncateCodePoints: whole emoji at the boundary, exact length for plain text, and huge input is not walked past the bound', () => {
    expect(truncateCodePoints('x'.repeat(499) + '😀' + 'tail', 500)).toBe('x'.repeat(499) + '😀');
    expect(truncateCodePoints('x'.repeat(500) + '😀', 500)).toBe('x'.repeat(500));
    expect(truncateCodePoints('short', 500)).toBe('short');
    expect(truncateCodePoints('😀😀😀', 2)).toBe('😀😀');
    const huge = 'y'.repeat(10_000_000);
    const started = performance.now();
    expect(truncateCodePoints(huge, 500)).toHaveLength(500);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('name, description and snippet each end on a whole code point at their bound', async () => {
    await node('emoji', {
      name: 'edge4680 ' + 'n'.repeat(290) + '😀😀😀😀', description: 'd'.repeat(499) + '😀tail', abstract: 's'.repeat(499) + '😀tail',
    });
    const out = await call(await context(), { query: 'edge4680', memoryUrn: mem.urn });
    expect(out.hits).toHaveLength(1);
    const [hit] = out.hits;
    for (const field of [hit.name, hit.description ?? '', hit.snippet]) expect(field).not.toMatch(LONE_SURROGATE);
    expect(points(hit.name)).toBe(300);
    expect(points(hit.description ?? '')).toBe(500);
    expect(hit.description).toBe('d'.repeat(499) + '😀');
    expect(hit.snippet).toBe('s'.repeat(499) + '😀');
  });
});

describe('#4680 F4 the snippet centers on the match, within the same bound', () => {
  const filler = 'lorem ipsum dolor '.repeat(100);
  it('a match past the first window is shown (the field keeps its name, the bound its size)', async () => {
    await node('late', { name: 'late4680', content: `${filler}orchardzz is the word we want ${filler}` });
    const [hit] = (await call(await context(), { query: 'orchardzz', memoryUrn: mem.urn })).hits;
    expect(hit.snippet).toContain('orchardzz');
    expect(points(hit.snippet)).toBeLessThanOrEqual(SNIPPET_MAX_LENGTH);
    expect(hit.snippet).not.toMatch(LONE_SURROGATE);
  });

  it('a match already inside the first window keeps today\'s prefix; no match anywhere falls back to the prefix', async () => {
    await node('early', { name: 'early4680', content: `orchardzz starts here ${filler}` });
    await node('none', { name: 'orchardzz none4680', content: filler });
    const out = await call(await context(), { query: 'orchardzz', memoryUrn: mem.urn });
    const byName = new Map(out.hits.map(h => [h.name, h]));
    expect(byName.get('early4680')!.snippet.startsWith('orchardzz starts here ')).toBe(true);
    expect(byName.get('orchardzz none4680')!.snippet).toBe(filler.slice(0, SNIPPET_MAX_LENGTH));
  });

  it('operators, quotes and case do not hide the match; a non-blank abstract is the source when present', async () => {
    await node('syntax', { name: 'syntax4680', content: `${filler}ORCHARDZZ appears late ${filler}` });
    await node('abs', { name: 'abs4680', content: 'unrelated body', abstract: `${filler}orchardzz in the abstract ${filler}` });
    const out = await call(await context(), { query: '"orchardzz" AND (other OR -x)', memoryUrn: mem.urn });
    const byName = new Map(out.hits.map(h => [h.name, h]));
    expect(byName.get('syntax4680')?.snippet.toLowerCase()).toContain('orchardzz');
    expect(byName.get('abs4680')?.snippet).toContain('orchardzz in the abstract');
  });

  it('only a bounded part of a huge body is searched for the match', async () => {
    await node('huge', { name: 'huge4680', content: `${'z'.repeat(400_000)} orchardzz at the far end` });
    const out = await call(await context(), { query: 'orchardzz', memoryUrn: mem.urn });
    expect(out.hits[0].snippet).toBe('z'.repeat(SNIPPET_MAX_LENGTH));
  });
});

describe('#4680 F7 persistent pins', () => {
  it.each(['"unclosed', 'a AND', '(', ') b', 'x OR', '-excl', '\\', '%', '_', "'", 'c:d', 'a.b*', 'and or not', 'AND', '"" ""'])(
    'keyword syntax and metacharacters in %j never throw and never reach the engine as another mode', async query => {
      await node('meta', { name: 'meta4680', content: 'orchard' });
      const spy = vi.spyOn(Q, 'findNodes');
      const out = await call(await context(), { query, memoryUrn: mem.urn });
      expect(Array.isArray(out.hits)).toBe(true);
      expect(spy.mock.calls[0][1]).toMatchObject({ mode: 'keyword', query: query.trim() });
    });

  it('a node URN as memoryUrn is refused before any lookup or engine call, with the one argument error', async () => {
    const engine = vi.spyOn(Q, 'findNodes');
    const resolve = vi.spyOn(memoryRef, 'resolveMemoryRef');
    await expect(call(await context(), { query: 'x', memoryUrn: emitNodeUrnV2(mem.urn, 'some:loc') })).rejects.toThrow(/expected a non-empty query/);
    expect(engine).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('an ambiguous legacy memory and a missing memory answer an empty result, byte for byte, with no engine call', async () => {
    const engine = vi.spyOn(Q, 'findNodes');
    const c = await context();
    vi.spyOn(memoryRef, 'resolveMemoryRef').mockRejectedValueOnce(new AmbiguousLegacyUrnError('legacy', [mem.id, generateId()] as never));
    const ambiguous = await call(c, { query: 'x', memoryUrn: 'legacy:urn' });
    vi.spyOn(memoryRef, 'resolveMemoryRef').mockRejectedValueOnce(new MemoryNotFoundError('legacy:urn'));
    const missing = await call(c, { query: 'x', memoryUrn: 'legacy:urn' });
    expect(JSON.stringify(ambiguous)).toBe(JSON.stringify(missing));
    expect(ambiguous).toEqual({ hits: [] });
    expect(engine).not.toHaveBeenCalled();
  });

  it('any other lookup failure is not turned into an empty answer', async () => {
    const boom = new Error('lookup outage');
    vi.spyOn(memoryRef, 'resolveMemoryRef').mockRejectedValueOnce(boom);
    await expect(call(await context(), { query: 'x', memoryUrn: 'legacy:urn' })).rejects.toBe(boom);
  });

  it('a first-page engine error propagates as itself', async () => {
    const boom = new Error('engine down');
    vi.spyOn(Q, 'findNodes').mockRejectedValue(boom);
    await expect(call(await context(), { query: 'x' })).rejects.toBe(boom);
  });
});

describe('#4680 F1 late-page failures are honest, content-free, and never hide a cancellation', () => {
  /** Page 1 returns `n` hits of the run's own memory plus enough to force a second page; later pages follow `later`. */
  async function twoPages(later: () => unknown) {
    const nodes = [await node('a'), await node('b')];
    const spy = vi.spyOn(Q, 'findNodes').mockResolvedValueOnce({ hits: nodes.map(n => ({ node: n, score: 1 })) }).mockImplementation(async () => later() as never);
    return { nodes, spy };
  }

  it('a later-page failure returns the already-fenced hits with a fixed marker, stops at the first failure and leaks no error text', async () => {
    const { nodes, spy } = await twoPages(() => { throw new Error('private late-page failure /secret/path'); });
    const out = await call(await context(), { query: 'x', memoryUrn: mem.urn, limit: 5 });
    expect(out).toEqual({ hits: expect.any(Array), truncated: true, truncatedReason: 'LATER_PAGE_FAILED' });
    expect(out.hits.map(h => h.urn)).toEqual(nodes.map(n => emitNodeUrnV2(mem.urn, n.loc)));
    expect(JSON.stringify(out)).not.toMatch(/private|secret|path/);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('the scan cap carries its own marker', async () => {
    const nodes = [await node('a')];
    const outside = await db.node.create({ data: { id: generateId(), memoryId: (await db.memory.create({ data: { id: generateId(), urn: 's4680.example:other', name: 'o', organizationId: orgId, class: 'knowledge', visibility: 'ORGANIZATION' } })).id, loc: 'x', name: 'x', content: 'x' } });
    vi.spyOn(Q, 'findNodes').mockImplementation(async (_r, args) => ({ hits: Array.from({ length: args.limit }, (_, i) => ({ node: args.offset === 0 && i === 0 ? nodes[0] : outside, score: 1 })) }));
    const out = await call(await context(), { query: 'x', limit: 3 });
    expect(out).toMatchObject({ truncated: true, truncatedReason: 'SCAN_CAP' });
  });

  it('a cancelled run is fatal: the late-page error is rethrown, not softened into a partial page', async () => {
    const c = await context();
    const nodes = [await node('a'), await node('b')];
    const boom = new Error('late failure after cancel');
    vi.spyOn(Q, 'findNodes').mockResolvedValueOnce({ hits: nodes.map(n => ({ node: n, score: 1 })) }).mockImplementation(async () => {
      await db.appRun.update({ where: { id: c.run.id }, data: { status: 'CANCELLED' } });
      throw boom;
    });
    await expect(call(c, { query: 'x', memoryUrn: mem.urn, limit: 5 })).rejects.toBe(boom);
  });

  it('an AbortError is fatal even with hits in hand', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    await twoPages(() => { throw abort; });
    await expect(call(await context(), { query: 'x', memoryUrn: mem.urn, limit: 5 })).rejects.toBe(abort);
  });
});

describe('#4680 F2 a later fence-query failure keeps only hits already fenced', () => {
  it('the second page\'s fence read fails: page-1 hits survive with the marker, nothing from page 2 escapes', async () => {
    const first = [await node('p1a'), await node('p1b')];
    const second = [await node('p2a')];
    vi.spyOn(Q, 'findNodes')
      .mockResolvedValueOnce({ hits: first.map(n => ({ node: n, score: 1 })) })
      .mockResolvedValueOnce({ hits: second.map(n => ({ node: n, score: 1 })) });
    const c = await context();
    const real = db.node.findMany.bind(db.node);
    let calls = 0;
    vi.spyOn(db.node, 'findMany').mockImplementation(((args: unknown) => {
      calls++;
      if (calls === 2) return Promise.reject(new Error('fence outage /private'));
      return real(args as never);
    }) as never);
    const out = await call(c, { query: 'x', memoryUrn: mem.urn, limit: 5 });
    expect(out).toMatchObject({ truncated: true, truncatedReason: 'LATER_PAGE_FAILED' });
    expect(out.hits.map(h => h.urn)).toEqual(first.map(n => emitNodeUrnV2(mem.urn, n.loc)));
    expect(JSON.stringify(out)).not.toMatch(/outage|private|p2a/);
  });

  it('the FIRST page\'s fence failure is a failure, never an empty page', async () => {
    const first = [await node('p1a')];
    vi.spyOn(Q, 'findNodes').mockResolvedValueOnce({ hits: first.map(n => ({ node: n, score: 1 })) });
    const boom = new Error('fence outage first');
    vi.spyOn(db.node, 'findMany').mockRejectedValueOnce(boom);
    await expect(call(await context(), { query: 'x', memoryUrn: mem.urn })).rejects.toBe(boom);
  });
});
