/**
 * #3927 — the sanitized `node.urn.emission_fallback` diagnostic at `resolveNodeUrnField`.
 *
 * Diagnostics only: the String! response, the canonical emission, the exact fallback bytes, `Node.portalUrl` and
 * every read gate are unchanged. What is new is ONE closed-schema warning on the existing emission-catch path,
 * replacing the old payload (raw memory URN + the library's exception, which carried the offending atom).
 * Synthetic sentinels only; stored locs are written straight to the table, bypassing `validateLoc`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { emitNodeUrnV2, nodeUrnRoundTrips } from '../../../lib/urnEmit.js';
import { portalUrlForUrn } from '../../../lib/portalUrl.js';
import { resolveNodeUrnField, typeResolvers } from './resolvers.types.js';
import { resolvers, type Context } from './resolvers.js';

const EVENT = 'node.urn.emission_fallback';
const KEYS = ['emissionError', 'locShape', 'memoryId', 'memoryShape', 'nodeId', 'schemaVersion'];
const MEM_SLUGS = { ordinary: 'sentinel-mem', compound: 'sentinel-mem:agent:app-user:abc', badSingle: '', badCharset: 'sentinel-mem:no$pe' };

let orgId: string;
const mems: Record<string, string> = {};
const ctx = (): Context => ({ db, userId: null, roles: [] } as unknown as Context);
let calls: unknown[][];

async function memory(kind: keyof typeof MEM_SLUGS): Promise<string> {
  const slug = MEM_SLUGS[kind];
  const urn = kind === 'badSingle' ? 'sentinelorg' : `sentinelorg:${slug}`;
  const m = await db.memory.create({ data: { id: generateId(), organizationId: orgId, urn, name: `m-${kind}`, class: 'knowledge' } });
  mems[kind] = m.id;
  return m.id;
}
const urnOf = async (kind: keyof typeof MEM_SLUGS) => (await db.memory.findUniqueOrThrow({ where: { id: mems[kind]! } })).urn;
const events = () => calls.filter((c) => c[0] === EVENT);
const everything = () => JSON.stringify(calls, (_k, v) => (v instanceof Error ? { error: v.message, stack: v.stack } : v));

beforeEach(async () => {
  await cleanDb(db);
  process.env.FRONTEND_URL = 'https://portal.test';
  const org = await db.organization.create({ data: { id: generateId(), name: 'sentinel org', urn: 'sentinelorg' } });
  orgId = org.id;
  for (const k of Object.keys(MEM_SLUGS) as Array<keyof typeof MEM_SLUGS>) await memory(k);
  calls = [];
  for (const m of ['log', 'warn', 'error', 'info', 'debug'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { calls.push(a); });
});
afterEach(() => { vi.restoreAllMocks(); delete process.env.FRONTEND_URL; });

const fallback = (memUrn: string, loc: string) => `hrn:node:${memUrn}:${loc}`;

describe('ordinary emission', () => {
  it('ordinary memory + ordinary loc: canonical bytes, round trip, safe link, and NO diagnostic', async () => {
    const out = await resolveNodeUrnField({ loc: 'docs:a-1', memoryId: mems.ordinary! }, ctx());
    expect(out).toBe('hrn:node:sentinelorg:sentinel-mem:docs:a-1');
    expect(nodeUrnRoundTrips('sentinelorg:sentinel-mem', 'docs:a-1')).toBe(true);
    expect(portalUrlForUrn(out)).toBe(`https://portal.test/app/u/${out}`);
    expect(calls).toEqual([]);
  });
  it('a preloaded memory relation and a memoized loader emit identically, with one memory read for many rows', async () => {
    const spy = vi.spyOn(db.memory, 'findUnique');
    const c = ctx();
    const a = await resolveNodeUrnField({ loc: 'x', memoryId: mems.ordinary! }, c);
    const b = await resolveNodeUrnField({ loc: 'y', memoryId: mems.ordinary! }, c);
    const p = await resolveNodeUrnField({ loc: 'x', memoryId: mems.ordinary!, memory: { urn: 'sentinelorg:sentinel-mem' } }, ctx());
    expect([a, b, p]).toEqual(['hrn:node:sentinelorg:sentinel-mem:x', 'hrn:node:sentinelorg:sentinel-mem:y', 'hrn:node:sentinelorg:sentinel-mem:x']);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]);
  });
  it('a missing memory row keeps its own branch: same bytes, no new event', async () => {
    const out = await resolveNodeUrnField({ loc: 'a::b', memoryId: 'no-such-memory' }, ctx());
    expect(out).toBe('hrn:node:unknown:a::b');
    expect(calls).toEqual([]);
  });
  it('a compound memory with an ordinary loc still emits (canonical-looking) without a diagnostic, and does NOT round trip', async () => {
    const out = await resolveNodeUrnField({ loc: 'a', memoryId: mems.compound! }, ctx());
    expect(out).toBe('hrn:node:sentinelorg:sentinel-mem:agent:app-user:abc:a');
    expect(nodeUrnRoundTrips('sentinelorg:sentinel-mem:agent:app-user:abc', 'a')).toBe(false);
    expect(calls).toEqual([]);
  });
});

type Row = [label: string, loc: string, locShape: string, emissionError: string];
const LOC_ROWS: Row[] = [
  ['legacy empty root', '', 'LEGACY_EMPTY_ROOT', 'WRONG_PART_COUNT'],
  ['leading empty atom', ':SECRETLOC', 'LEADING_EMPTY_ATOM', 'WRONG_PART_COUNT'],
  ['trailing empty atom', 'SECRETLOC:', 'TRAILING_EMPTY_ATOM', 'WRONG_PART_COUNT'],
  ['doubled (interior) empty atom', 'SECRETLOC::x', 'INTERIOR_EMPTY_ATOM', 'WRONG_PART_COUNT'],
  ['control codepoint', 'SECRETLOC\u0001x', 'CONTROL_CODEPOINT', 'INVALID_ATOM_SHAPE'],
  ['tab (control wins over whitespace)', 'SECRETLOC\tx', 'CONTROL_CODEPOINT', 'INVALID_ATOM_SHAPE'],
  ['whitespace', 'SECRETLOC x', 'WHITESPACE_CODEPOINT', 'INVALID_ATOM_SHAPE'],
  ['non-ASCII whitespace', 'SECRETLOC x', 'WHITESPACE_CODEPOINT', 'INVALID_ATOM_SHAPE'],
  ['URL-structural slash', 'SECRETLOC/x', 'URL_STRUCTURAL_CODEPOINT', 'INVALID_ATOM_SHAPE'],
  ['URL-structural question mark', 'SECRETLOC?x', 'URL_STRUCTURAL_CODEPOINT', 'INVALID_ATOM_SHAPE'],
  ['URL-structural hash', 'SECRETLOC#x', 'URL_STRUCTURAL_CODEPOINT', 'INVALID_ATOM_SHAPE'],
  ['URL-structural percent', 'SECRETLOC%x', 'URL_STRUCTURAL_CODEPOINT', 'INVALID_ATOM_SHAPE'],
  ['URL-structural backslash', 'SECRETLOC\\x', 'URL_STRUCTURAL_CODEPOINT', 'INVALID_ATOM_SHAPE'],
  ['non-ASCII letter', 'SECRETLOCé', 'NON_ASCII_CODEPOINT', 'INVALID_ATOM_SHAPE'],
  ['other forbidden ASCII', 'SECRETLOC$x', 'OTHER_FORBIDDEN_CODEPOINT', 'INVALID_ATOM_SHAPE'],
  ['atom of 65 charset-valid characters', 'a'.repeat(65), 'ATOM_TOO_LONG', 'ATOM_TOO_LONG'],
  ['edge punctuation (charset letters only)', '-SECRETLOC', 'OTHER', 'INVALID_ATOM_SHAPE'],
];

describe('the sanitized fallback event', () => {
  it.each(LOC_ROWS)('%s: bytes unchanged, exactly one closed-schema event, nothing raw', async (_l, loc, locShape, emissionError) => {
    const memUrn = await urnOf('ordinary');
    const nodeUrn = await resolveNodeUrnField({ loc, memoryId: mems.ordinary! }, ctx());
    const logged = [...calls]; // before the oracles below: the shared round-trip helper logs on its own
    expect(nodeUrn).toBe(fallback(memUrn, loc)); // exact fallback bytes
    expect(() => emitNodeUrnV2(memUrn, loc)).toThrow(); // canonical emission failed, separately asserted
    expect(nodeUrnRoundTrips(memUrn, loc)).toBe(false);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toHaveLength(2);
    const [msg, obj] = logged[0] as [string, Record<string, unknown>];
    expect(msg).toBe(EVENT);
    expect(Object.keys(obj).sort()).toEqual(KEYS);
    expect(obj).toEqual({ schemaVersion: 1, memoryId: mems.ordinary, nodeId: null, memoryShape: 'ORDINARY', locShape, emissionError });
    const text = JSON.stringify(logged);
    for (const raw of ['SECRETLOC', 'sentinelorg', 'sentinel-mem', 'a'.repeat(65), 'emit', 'Slug contains', 'wrong number']) expect(text).not.toContain(raw);
    // Only closed strings leave the process: every value is an enum member, an opaque id, null or the version.
    for (const v of Object.values(obj)) expect(['string', 'number'].includes(typeof v) || v === null).toBe(true);
  });
  it('the link for a fallback is exactly portalUrlForUrn(urn): null for a URL-structural loc, a link otherwise', async () => {
    const memUrn = await urnOf('ordinary');
    for (const [loc, linked] of [['a/b', false], ['a?b', false], ['a#b', false], ['a b', false], ['a\\b', false], ['a::b', true], ['', true]] as const) {
      const g = { loc, memoryId: mems.ordinary!, id: 'n1' };
      const urn = await (typeResolvers as any).Node.urn(g, {}, ctx());
      const link = await (typeResolvers as any).Node.portalUrl(g, {}, ctx());
      expect(urn).toBe(fallback(memUrn, loc));
      expect(link).toBe(portalUrlForUrn(urn));
      expect(link === null).toBe(!linked);
    }
  });
  it('a minimal {loc,memoryId} caller logs nodeId null; an id-bearing Node field logs that id, same shapes, same memory id', async () => {
    await resolveNodeUrnField({ loc: 'a::b', memoryId: mems.ordinary! }, ctx());
    await (typeResolvers as any).Node.urn({ loc: 'a::b', memoryId: mems.ordinary!, id: 'node-id-1' }, {}, ctx());
    await (typeResolvers as any).Node.portalUrl({ loc: 'a::b', memoryId: mems.ordinary!, id: 'node-id-2' }, {}, ctx());
    const objs = events().map((c) => c[1] as Record<string, unknown>);
    expect(objs.map((o) => o.nodeId)).toEqual([null, 'node-id-1', 'node-id-2']);
    for (const o of objs) expect({ ...o, nodeId: null }).toEqual({ schemaVersion: 1, memoryId: mems.ordinary, nodeId: null, memoryShape: 'ORDINARY', locShape: 'INTERIOR_EMPTY_ATOM', emissionError: 'WRONG_PART_COUNT' });
  });
  it('no query is added: the memoized memory lookup runs once for many failing rows', async () => {
    const spy = vi.spyOn(db.memory, 'findUnique');
    const nodeSpy = vi.spyOn(db.node, 'findUnique');
    const c = ctx();
    for (const loc of ['a::b', ':a', 'a:']) await resolveNodeUrnField({ loc, memoryId: mems.ordinary! }, c);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(nodeSpy).not.toHaveBeenCalled();
    expect(events()).toHaveLength(3);
  });
  it('a preloaded memory relation still logs the opaque memoryId and never its urn', async () => {
    await resolveNodeUrnField({ loc: 'a::b', memoryId: mems.ordinary!, memory: { urn: 'sentinelorg:sentinel-mem' } }, ctx());
    expect(events()).toHaveLength(1);
    expect(everything()).not.toContain('sentinel');
    expect((events()[0]![1] as any).memoryId).toBe(mems.ordinary);
  });
  it('a compound memory with a bad loc: memoryShape COMPOUND, loc classified independently', async () => {
    const out = await resolveNodeUrnField({ loc: 'a::b', memoryId: mems.compound! }, ctx());
    expect(out).toBe(fallback(await urnOf('compound'), 'a::b'));
    expect(events().map((c) => c[1])).toEqual([{ schemaVersion: 1, memoryId: mems.compound, nodeId: null, memoryShape: 'COMPOUND', locShape: 'INTERIOR_EMPTY_ATOM', emissionError: 'WRONG_PART_COUNT' }]);
  });
  it.each([['single-atom memory identity', 'badSingle'], ['out-of-charset memory identity', 'badCharset']] as const)('%s with an ORDINARY loc: memoryShape INVALID, locShape ORDINARY', async (_l, kind) => {
    const out = await resolveNodeUrnField({ loc: 'a', memoryId: mems[kind]! }, ctx());
    expect(out).toBe(fallback(await urnOf(kind), 'a'));
    expect(events()).toHaveLength(1);
    expect((events()[0]![1] as any)).toMatchObject({ memoryShape: 'INVALID', locShape: 'ORDINARY', memoryId: mems[kind] });
    expect(everything()).not.toContain('sentinel');
  });
  it('an invalid memory with an empty loc is still memoryShape INVALID (the legacy root does not hide it)', async () => {
    await resolveNodeUrnField({ loc: '', memoryId: mems.badCharset! }, ctx());
    expect((events()[0]![1] as any)).toMatchObject({ memoryShape: 'INVALID', locShape: 'LEGACY_EMPTY_ROOT' });
  });
  it('a valid memory with an empty loc is the legacy root, not a malformed row, and the old payload is gone', async () => {
    await resolveNodeUrnField({ loc: '', memoryId: mems.ordinary! }, ctx());
    expect((events()[0]![1] as any)).toMatchObject({ memoryShape: 'ORDINARY', locShape: 'LEGACY_EMPTY_ROOT' });
    expect(calls.some((c) => String(c[0]).includes('[Node.urn]'))).toBe(false);
    expect(calls).toHaveLength(1);
  });
  it('a memory whose stored root is empty fails with a non-library error: emissionError OTHER, memoryShape INVALID', async () => {
    const m = await db.memory.create({ data: { id: generateId(), organizationId: orgId, urn: ':sentinel-mem', name: 'empty-root', class: 'knowledge' } });
    const out = await resolveNodeUrnField({ loc: 'a:b', memoryId: m.id }, ctx());
    expect(out).toBe('hrn:node::sentinel-mem:a:b');
    expect(events().map((c) => c[1])).toEqual([{ schemaVersion: 1, memoryId: m.id, nodeId: null, memoryShape: 'INVALID', locShape: 'ORDINARY', emissionError: 'OTHER' }]);
  });
  it('classifyEmissionError maps only the library reasons; anything else, even null, is OTHER', async () => {
    const { classifyEmissionError } = await import('../../../lib/nodeUrnDiagnostic.js');
    expect([null, undefined, 'x', new Error('boom'), { reason: 'invalid-charset' }].map(classifyEmissionError)).toEqual(['OTHER', 'OTHER', 'OTHER', 'OTHER', 'OTHER']);
  });
  it('actual resolveUrn: a canonical node URN resolves for this caller, its stored-loc fallback does not (reported, not repaired)', async () => {
    const admin = await db.user.create({ data: { id: generateId(), handle: 'probe-admin', roles: ['ADMIN'] } });
    const rc = { db, userId: admin.id, roles: ['ADMIN'] } as unknown as Context;
    const mk = (loc: string) => db.node.create({ data: { id: generateId(), memoryId: mems.ordinary!, loc, name: loc || 'root', ownerRepo: 'x/y', tags: [] } });
    await mk('fine'); await mk('a::b');
    const good = await resolveNodeUrnField({ loc: 'fine', memoryId: mems.ordinary! }, ctx());
    const bad = await resolveNodeUrnField({ loc: 'a::b', memoryId: mems.ordinary! }, ctx());
    calls = [];
    const probe = async (urn: string) => { try { return await (resolvers.Query as any).resolveUrn({}, { urn }, rc); } catch (e) { return `threw:${(e as any).extensions?.code ?? (e as Error).name}`; } };
    const found = await probe(good);
    expect(found).not.toBeNull();
    expect(typeof found === 'string' && found.startsWith('threw')).toBe(false);
    expect(await probe(bad)).toBeNull();
    expect(JSON.stringify(calls)).not.toContain('SECRETLOC');
  });
});
