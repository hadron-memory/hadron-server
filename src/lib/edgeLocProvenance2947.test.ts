/**
 * #2947 (Ask 5, gate pick B): the provenance flag is RECORDED on every edge write, never inferred at move time, and the
 * migration backfill classifies by derivation SHAPE with the SQL twin of `edgeLocDecodesAsDerived`.
 */
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from './id.js';
import { deriveEdgeLoc, edgeLocDecodesAsDerived, isAuthoredLoc } from './edgeLoc.js';
import { resolveEdgeRef } from './entityRef/edgeRef.js';
import { safeEdgeUrnV2 } from './urnEmit.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { createTestableMcpServer } from '../mcp/server.js';
import { cloneMemoryGraph } from '../controller/operations/cloneMemory.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../integrations/github/mirrorNodeMove.js', () => ({ mirrorNodeMoveToGit: vi.fn().mockResolvedValue(undefined) }));

let mover: { id: string };
let mem: { id: string; urn: string };
let other: { id: string; urn: string };
const ctx = (): Context => ({ db, userId: mover.id, roles: ['ADMIN'] });
const node = (memoryId: string, loc: string) => db.node.create({
  data: { id: generateId(), memoryId, loc, name: loc, content: `body of ${loc}`, mintedAt: new Date(), mintedByInfo: 'test' },
});
const flag = async (id: string) => (await db.edge.findUniqueOrThrow({ where: { id } })).locAuthored;
const nodeUrn = (m: { urn: string }, loc: string) => `hrn:node:${m.urn}:${loc}`;

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Prov Org', urn: 'prov-org.example' } });
  mover = await db.user.create({ data: { githubId: 294702, githubUsername: 'prov-mover', roles: ['ADMIN'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: mover.id, role: 'ADMIN' } });
  const m = (name: string) => db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:${name}`, name, class: 'knowledge', visibility: 'ORGANIZATION' } });
  mem = await m('src'); other = await m('dst');
});

describe('#2947 provenance is recorded by every writer', () => {
  it('GraphQL createEdge: a derived loc is derived; a supplied loc is authored, even when it equals the derivation', async () => {
    const a = await node(mem.id, 'a'); const c = await node(mem.id, 'c'); const d = await node(mem.id, 'd');
    const derived = await resolvers.Mutation.createEdge(null, { sourceRef: a.id, targetRef: c.id, name: 'uses' } as never, ctx()) as { id: string };
    const equal = await resolvers.Mutation.createEdge(null, { sourceRef: a.id, targetRef: d.id, name: 'uses', loc: 'a:uses:d' } as never, ctx()) as { id: string };
    expect(await flag(derived.id)).toBe(false);
    expect(await flag(equal.id)).toBe(true);
  });

  it('MCP hadron_create_edge: the same rule', async () => {
    const a = await node(mem.id, 'a'); const c = await node(mem.id, 'c'); const d = await node(mem.id, 'd');
    const mcp = createTestableMcpServer({ userId: mover.id, roles: ['ADMIN'], clientId: `user:${mover.id}` });
    await mcp.callToolText('hadron_create_edge', { sourceUrn: nodeUrn(mem, 'a'), targetUrn: nodeUrn(mem, 'c'), name: 'uses' });
    await mcp.callToolText('hadron_create_edge', { sourceUrn: nodeUrn(mem, 'a'), targetUrn: nodeUrn(mem, 'd'), name: 'uses', loc: 'a:uses:d' });
    expect(await flag((await db.edge.findFirstOrThrow({ where: { sourceId: a.id, targetId: c.id } })).id)).toBe(false);
    expect(await flag((await db.edge.findFirstOrThrow({ where: { sourceId: a.id, targetId: d.id } })).id)).toBe(true);
    void c; void d;
  });

  it('updateEdge: a caller-supplied loc is authored from then on', async () => {
    const a = await node(mem.id, 'a'); const c = await node(mem.id, 'c');
    const e = await resolvers.Mutation.createEdge(null, { sourceRef: a.id, targetRef: c.id, name: 'uses' } as never, ctx()) as { id: string };
    expect(await flag(e.id)).toBe(false);
    await resolvers.Mutation.updateEdge(null, { edgeRef: e.id, loc: 'my-own' } as never, ctx());
    expect(await flag(e.id)).toBe(true);
  });

  it('cloneMemory carries each edge\'s recorded flag to the clone (one derived, one authored); the DB default is authored', async () => {
    const a = await node(mem.id, 'a'); const c = await node(mem.id, 'c'); const z = await node(mem.id, 'z');
    const derived = await resolvers.Mutation.createEdge(null, { sourceRef: a.id, targetRef: c.id, name: 'uses' } as never, ctx()) as { id: string };
    const authored = await resolvers.Mutation.createEdge(null, { sourceRef: a.id, targetRef: z.id, name: 'own', loc: 'authored-1' } as never, ctx()) as { id: string };
    expect(await flag(derived.id)).toBe(false);
    expect(await flag(authored.id)).toBe(true);
    const clone = await cloneMemoryGraph(db, { sourceMemoryId: mem.id, name: 'clone', newUrn: `${mem.urn}-clone`, targetOrganizationId: (await db.memory.findUniqueOrThrow({ where: { id: mem.id } })).organizationId!, ownerUserId: null, groupOwnerUserId: null, actorId: mover.id, copierReadableMemoryIds: null });
    const cloned = await db.edge.findMany({ where: { memoryId: clone.memoryId }, select: { name: true, locAuthored: true } });
    expect(cloned.sort((x, y) => (x.name ?? '').localeCompare(y.name ?? ''))).toEqual([{ name: 'own', locAuthored: true }, { name: 'uses', locAuthored: false }]);
    const raw = await db.edge.create({ data: { id: generateId(), memoryId: mem.id, sourceId: c.id, targetId: z.id, loc: 'unsaid', name: 'x' } });
    expect(raw.locAuthored).toBe(true);
  });
});

describe('#2947 the move reads the RECORDED flag, never the loc', () => {
  it('an edge created with an explicit loc equal to its derivation is authored: a move leaves loc and URN alone, no alias', async () => {
    const a = await node(mem.id, 'a'); const c = await node(mem.id, 'c');
    const e = await resolvers.Mutation.createEdge(null, { sourceRef: a.id, targetRef: c.id, name: 'uses', loc: 'a:uses:c' } as never, ctx()) as { id: string };
    await resolvers.Mutation.moveNode(null, { sourceRef: a.id, targetUrn: nodeUrn(mem, 'b') } as never, ctx());
    expect((await db.edge.findUniqueOrThrow({ where: { id: e.id } })).loc).toBe('a:uses:c');
    expect(await db.urnAlias.count({ where: { entityType: 'EDGE' as never, entityId: e.id } })).toBe(0);
  });

  it('a derived loc made STALE before this build (flagged derived by the backfill) self-heals on its next move', async () => {
    const a = await node(mem.id, 'a'); const c = await node(mem.id, 'c');
    // `old:uses:c` decodes as a derivation (name atom interior) but not from the current endpoints.
    const e = await db.edge.create({ data: { id: generateId(), memoryId: mem.id, sourceId: a.id, targetId: c.id, loc: 'old:uses:c', name: 'uses', locAuthored: false } });
    await resolvers.Mutation.moveNode(null, { sourceRef: a.id, targetUrn: nodeUrn(mem, 'b') } as never, ctx());
    expect((await db.edge.findUniqueOrThrow({ where: { id: e.id } })).loc).toBe('b:uses:c');
    expect(await resolveEdgeRef(db, safeEdgeUrnV2(mem.urn, 'old:uses:c'))).toEqual({ id: e.id });
  });

  it('governed edges (INCLUDE, COMMENT_*) keep their id-derived loc and get no alias', async () => {
    const a = await node(mem.id, 'a'); const c = await node(mem.id, 'c');
    const g = await db.edge.create({ data: { id: generateId(), memoryId: mem.id, sourceId: a.id, targetId: c.id, loc: `inc-${generateId()}`, name: 'include', governedKind: 'INCLUDE', locAuthored: false } });  // derived on purpose: only the governed filter protects it
    const before = g.loc;
    await resolvers.Mutation.moveNode(null, { sourceRef: a.id, targetUrn: nodeUrn(mem, 'b') } as never, ctx());
    expect((await db.edge.findUniqueOrThrow({ where: { id: g.id } })).loc).toBe(before);
    expect(await db.urnAlias.count({ where: { entityType: 'EDGE' as never, entityId: g.id } })).toBe(0);
  });
});

describe('#2947 the move names the edge URNs it changed (GraphQL and MCP share one helper)', () => {
  it('GraphQL moveNode returns Node.moveEdgeUrnChanges: only edges whose URN changed', async () => {
    const a = await node(mem.id, 'a'); const c = await node(mem.id, 'c'); const z = await node(mem.id, 'z');
    const derived = await resolvers.Mutation.createEdge(null, { sourceRef: a.id, targetRef: c.id, name: 'uses' } as never, ctx()) as { id: string };
    await resolvers.Mutation.createEdge(null, { sourceRef: a.id, targetRef: z.id, name: 'own', loc: 'authored-1' } as never, ctx());
    const moved = await resolvers.Mutation.moveNode(null, { sourceRef: a.id, targetUrn: nodeUrn(mem, 'b') } as never, ctx()) as unknown as { moveEdgeUrnChanges: Array<{ edgeId: string; previousUrn: string; urn: string }> };
    expect(moved.moveEdgeUrnChanges).toEqual([
      { edgeId: derived.id, previousUrn: safeEdgeUrnV2(mem.urn, 'a:uses:c'), urn: safeEdgeUrnV2(mem.urn, 'b:uses:c') },
    ]);
  });

  it('MCP hadron_move_node says which edge URNs changed', async () => {
    const a = await node(mem.id, 'a'); const c = await node(mem.id, 'c');
    await resolvers.Mutation.createEdge(null, { sourceRef: a.id, targetRef: c.id, name: 'uses' } as never, ctx());
    const mcp = createTestableMcpServer({ userId: mover.id, roles: ['ADMIN'], clientId: `user:${mover.id}` });
    const text = await mcp.callToolText('hadron_move_node', { urn: nodeUrn(mem, 'a'), targetUrn: nodeUrn(mem, 'b') });
    expect(text).toContain('Edge URNs changed (1)');
    expect(text).toContain(`${safeEdgeUrnV2(mem.urn, 'a:uses:c')} -> ${safeEdgeUrnV2(mem.urn, 'b:uses:c')}`);
  });
});

describe('#2947 the backfill SQL and the application agree on the classification of the same rows', () => {
  const sql = (() => {
    const text = readFileSync(new URL('../../prisma/migrations/20261121110000_edge_loc_provenance/migration.sql', import.meta.url), 'utf8');
    return text.slice(text.indexOf('-- BACKFILL-BEGIN'), text.indexOf('-- BACKFILL-END'));
  })();

  const cases: Array<[string, string, string | null]> = [
    ['exact derivation', 'a:uses:c', 'uses'],
    ['stale derived (other endpoint generation)', 'old:uses:gone', 'uses'],
    ['migrated collision suffix', 'a:uses:c:2', 'uses'],
    ['no name derives via rel', 'a:rel:c', null],
    ['name with out-of-charset characters', 'a:depends-on:c', 'depends on'],
    ['long name capped at 64', `a:${'x'.repeat(64)}:c`, 'x'.repeat(80)],
    ['astral between alphanumerics, code-point spelling', 'a:a-b:c', 'a\u{1F600}b'],
    ['astral between alphanumerics, runtime spelling', 'a:a--b:c', 'a\u{1F600}b'],
    ['authored: name atom absent', 'my-own-loc', 'uses'],
    ['authored: name atom is the FIRST atom, not interior', 'uses:c:d', 'uses'],
    ['authored: too few atoms', 'a:uses', 'uses'],
    ['authored: different name', 'a:other:c', 'uses'],
  ];

  it('every row is classified identically by the migration block and edgeLocDecodesAsDerived', async () => {
    const a = await node(mem.id, 'a'); const c = await node(mem.id, 'c');
    const ids: Array<{ id: string; label: string; loc: string; name: string | null }> = [];
    for (const [label, loc, name] of cases) {
      const e = await db.edge.create({ data: { id: generateId(), memoryId: mem.id, sourceId: a.id, targetId: c.id, loc, name } });
      ids.push({ id: e.id, label, loc, name });
    }
    // The block is session-local (pg_temp) and has several statements, so it runs on ONE raw connection (simple query
    // protocol), after resetting the flag. The rows were committed above, so this connection sees them.
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      await client.query('UPDATE edges SET loc_authored = true');
      await client.query(sql);
      for (const row of ids) {
        const { rows } = await client.query('SELECT loc_authored FROM edges WHERE id = $1', [row.id]);
        expect({ label: row.label, authored: rows[0].loc_authored as boolean }, row.label)
          .toEqual({ label: row.label, authored: !edgeLocDecodesAsDerived(row.loc, row.name) });
      }
    } finally { await client.end(); }
  });

  it('the classification is the intended one for each named shape', () => {
    const want = new Map(cases.map(([label, loc, name]) => [label, edgeLocDecodesAsDerived(loc, name)]));
    expect(want.get('exact derivation')).toBe(true);
    expect(want.get('stale derived (other endpoint generation)')).toBe(true);
    expect(want.get('migrated collision suffix')).toBe(true);
    expect(want.get('no name derives via rel')).toBe(true);
    expect(want.get('astral between alphanumerics, code-point spelling')).toBe(true);
    expect(want.get('astral between alphanumerics, runtime spelling')).toBe(true);
    expect(want.get('authored: name atom absent')).toBe(false);
    expect(want.get('authored: name atom is the FIRST atom, not interior')).toBe(false);
    expect(want.get('authored: too few atoms')).toBe(false);
    expect(want.get('authored: different name')).toBe(false);
    expect(deriveEdgeLoc('a', 'uses', 'c')).toBe('a:uses:c');
  });
});

describe('#2947 a cross-memory move and a comment thread (governed COMMENT_ANCHOR edge)', () => {
  it('the anchor edge follows its thread to the destination memory with its id-derived loc untouched, and its old URN keeps resolving (ruling 0162)', async () => {
    const a = await node(mem.id, 'a');
    const comment = await resolvers.Mutation.createComment({}, { targetRef: a.id, body: 'a thread' } as never, ctx()) as { id: string };
    const anchor = await db.edge.findFirstOrThrow({ where: { sourceId: comment.id, governedKind: 'COMMENT_ANCHOR' } });
    expect(anchor.memoryId).toBe(mem.id);
    const oldUrn = safeEdgeUrnV2(mem.urn, anchor.loc);
    const newUrn = safeEdgeUrnV2(other.urn, anchor.loc);
    const result = await resolvers.Mutation.moveNode(null, { sourceRef: a.id, targetUrn: nodeUrn(other, 'a') } as never, ctx()) as unknown as { moveEdgeUrnChanges: Array<{ edgeId: string; previousUrn: string; urn: string }> };
    const after = await db.edge.findUniqueOrThrow({ where: { id: anchor.id } });
    expect(after.memoryId).toBe(other.id);
    expect(after.loc).toBe(anchor.loc);
    expect(after.deletedAt).toBeNull();
    // Its loc is id-derived and untouched (governed edges are never rebased), but its URN names the memory, so it is
    // reported and aliased like every edge whose URN a move changes.
    expect(result.moveEdgeUrnChanges.filter((c) => c.edgeId === anchor.id)).toEqual([{ edgeId: anchor.id, previousUrn: oldUrn, urn: newUrn }]);
    expect(await resolveEdgeRef(db, oldUrn)).toEqual({ id: anchor.id });
    expect(await resolveEdgeRef(db, newUrn)).toEqual({ id: anchor.id });
  });
});

describe('#2947 one predicate says whether a loc was supplied', () => {
  it('null, undefined and the empty string are not supplied; any text is', () => {
    expect([null, undefined, '', 'x', ' '].map(isAuthoredLoc)).toEqual([false, false, false, true, true]);
  });
});

describe('#2947 alias chains: a URN changed by two moves still resolves from the first', () => {
  it('a to b to c: the URN from before the first move and the one between both resolve to the edge', async () => {
    const a = await node(mem.id, 'a'); const t = await node(mem.id, 't');
    const e = await resolvers.Mutation.createEdge(null, { sourceRef: a.id, targetRef: t.id, name: 'uses' } as never, ctx()) as { id: string };
    await resolvers.Mutation.moveNode(null, { sourceRef: a.id, targetUrn: nodeUrn(mem, 'b') } as never, ctx());
    await resolvers.Mutation.moveNode(null, { sourceRef: a.id, targetUrn: nodeUrn(mem, 'c') } as never, ctx());
    expect((await db.edge.findUniqueOrThrow({ where: { id: e.id } })).loc).toBe('c:uses:t');
    for (const old of ['a:uses:t', 'b:uses:t', 'c:uses:t']) expect(await resolveEdgeRef(db, safeEdgeUrnV2(mem.urn, old))).toEqual({ id: e.id });
  });
});
