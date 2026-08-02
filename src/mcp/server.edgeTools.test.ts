/**
 * #835 — MCP edge editing. GraphQL has had full edge CRUD since spec 037, but
 * MCP exposed only `hadron_create_edge`. So changing ONE edge's label forced
 * `hadron_update_node(edges:)`, whose argument REPLACES the node's entire
 * outgoing set — a whole-set overwrite to express a single-edge intent, which
 * returns "Node updated" and reports nothing about the edges it dropped.
 *
 * The first describe reproduces that data loss so the fix has something
 * concrete to be measured against; the rest cover the two new tools.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { createTestableMcpServer } from './server.js';
import type { AuthContext } from '../middleware/auth.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

let adminId: string;
let memId: string;
let memUrn: string;
let source: { id: string; loc: string };
let t1: { id: string };
let t2: { id: string };
let t3: { id: string };

const admin = (): Context => ({ db, roles: ['ADMIN'], userId: adminId } as Context);
const adminAuth = (): AuthContext => ({ userId: adminId, roles: ['ADMIN'], clientId: `user:${adminId}` });
const call = (tool: string, args: Record<string, unknown>): Promise<string> =>
  createTestableMcpServer(adminAuth()).callToolText(tool, args);

const node = (loc: string, name: string) =>
  db.node.create({
    data: { id: generateId(), memoryId: memId, loc, name, ownerRepo: 'test/repo', tags: [] },
  });

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'emcp-org', urn: 'emcp-org' } });
  const a = await db.user.create({ data: { githubId: 6711, githubUsername: 'emcp-admin', roles: ['ADMIN'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: a.id, role: 'ADMIN' } });
  adminId = a.id;
  const mem = await resolvers.Mutation.createMemory({}, { orgId: org.id, name: 'edges' }, admin());
  memId = mem.id;
  memUrn = mem.urn;

  source = await node('review:item', 'Item');
  t1 = await node('review', 'Review');
  t2 = await node('docs:guide', 'Guide');
  t3 = await node('rel:other', 'Other');
  // The real shape from the issue: an `applies-when` routing edge alongside
  // `documented-by` / `relates-to` siblings that must survive an edit.
  for (const [target, name] of [[t1, 'applies-when'], [t2, 'documented-by'], [t3, 'relates-to']] as const) {
    await db.edge.create({
      data: {
        id: generateId(), memoryId: memId, sourceId: source.id, targetId: target.id,
        name, loc: `${source.loc}:${name}:${(target as { id: string }).id.slice(0, 6)}`,
      },
    });
  }
});

const edgesOf = () =>
  db.edge.findMany({ where: { sourceId: source.id }, orderBy: { name: 'asc' } });

describe('the hazard #835 exists to remove', () => {
  it('hadron_update_node(edges:) silently destroys the siblings it was not given', async () => {
    expect((await edgesOf()).length).toBe(3);
    const out = await call('hadron_update_node', {
      urn: `${memUrn.replace(':', '::')}::${source.loc}`,
      edges: [{ targetUrn: t1.id, name: 'applies-when-renamed' }],
    });
    const after = await edgesOf();
    // Two unrelated edges are gone...
    expect(after.length).toBe(1);
    expect(after[0].name).toBe('applies-when-renamed');
    // ...and nothing in the response says so.
    expect(out).not.toMatch(/deleted|removed|dropped/i);
  });
});

describe('hadron_update_edge — the single-edge intent (#835)', () => {
  it('renames ONE edge and leaves every sibling intact', async () => {
    const target = (await edgesOf()).find((e) => e.name === 'applies-when')!;
    const out = await call('hadron_update_edge', { edgeRef: target.id, name: 'applies-when-v2' });
    expect(out).toMatch(/Edge updated/);
    const after = await edgesOf();
    expect(after.length).toBe(3);
    expect(after.map((e) => e.name).sort()).toEqual(
      ['applies-when-v2', 'documented-by', 'relates-to'],
    );
  });

  it('updates only the fields supplied — omitted ones are preserved', async () => {
    const target = (await edgesOf()).find((e) => e.name === 'documented-by')!;
    await call('hadron_update_edge', { edgeRef: target.id, description: 'why this applies' });
    const after = await db.edge.findUniqueOrThrow({ where: { id: target.id } });
    expect(after.description).toBe('why this applies');
    expect(after.name).toBe('documented-by'); // untouched
    expect(after.loc).toBe(target.loc);
  });

  it('accepts a fully-qualified edge URN as well as a PK', async () => {
    const target = (await edgesOf()).find((e) => e.name === 'relates-to')!;
    const urn = `hrn:edge:${memUrn.replace(':', '::')}::${target.loc}`;
    const out = await call('hadron_update_edge', { edgeRef: urn, name: 'relates-to-v2' });
    expect(out).toMatch(/Edge updated/);
    expect((await db.edge.findUniqueOrThrow({ where: { id: target.id } })).name).toBe('relates-to-v2');
  });

  it('returns tool-error text (not a crash) for an unknown edge', async () => {
    const out = await call('hadron_update_edge', { edgeRef: generateId(), name: 'x' });
    expect(out).toMatch(/not found/i);
    expect((await edgesOf()).length).toBe(3);
  });

  // PR #861 review (Codex P2): `z.string().optional()` rejected null, so a
  // caller could replace name/description but never restore them to unset —
  // even though Mutation.updateEdge uses explicit null to clear.
  it('an explicit null CLEARS a nullable field', async () => {
    const target = (await edgesOf()).find((e) => e.name === 'documented-by')!;
    await call('hadron_update_edge', { edgeRef: target.id, description: 'temporary' });
    expect((await db.edge.findUniqueOrThrow({ where: { id: target.id } })).description).toBe('temporary');
    await call('hadron_update_edge', { edgeRef: target.id, description: null });
    expect((await db.edge.findUniqueOrThrow({ where: { id: target.id } })).description).toBeNull();
  });

  // PR #861 review (Codex P2): updateEdge has always supported these; the
  // wrapper neither accepted nor forwarded them, leaving routing conditions
  // uneditable over MCP entirely (hadron_update_node(edges:) has no such field).
  it('sets and clears a JSONLogic routing condition', async () => {
    const target = (await edgesOf()).find((e) => e.name === 'applies-when')!;
    // `var` is an allowed operator and the path must carry a valid scope
    // (memory./chat./agent./message.data.) — the validator rejects anything
    // else with INVALID_EDGE_CONDITION, which the wrapper surfaces as tool
    // text rather than crashing (covered below).
    await call('hadron_update_edge', { edgeRef: target.id, condition: { var: 'message.data.stage' } });
    expect((await db.edge.findUniqueOrThrow({ where: { id: target.id } })).condition)
      .toEqual({ var: 'message.data.stage' });
    await call('hadron_update_edge', { edgeRef: target.id, condition: null });
    expect((await db.edge.findUniqueOrThrow({ where: { id: target.id } })).condition).toBeNull();
  });

  it('surfaces an INVALID_EDGE_CONDITION as tool text, leaving the edge alone', async () => {
    const target = (await edgesOf()).find((e) => e.name === 'applies-when')!;
    const out = await call('hadron_update_edge', { edgeRef: target.id, condition: { var: 'nope.stage' } });
    expect(out).toMatch(/valid scope/i);
    expect((await db.edge.findUniqueOrThrow({ where: { id: target.id } })).condition).toBeNull();
  });

  it('sets edge data', async () => {
    const target = (await edgesOf()).find((e) => e.name === 'relates-to')!;
    await call('hadron_update_edge', { edgeRef: target.id, data: { weight: 3 } });
    expect((await db.edge.findUniqueOrThrow({ where: { id: target.id } })).data).toEqual({ weight: 3 });
  });

  // PR #861 review (Copilot): priority is an Int in GraphQL and an integer
  // column, so a float must be rejected at the tool boundary rather than
  // reaching Prisma/PG.
  //
  // Asserted on the SCHEMA, not by calling: createTestableMcpServer invokes
  // the handler directly and never runs the zod parse the MCP transport does,
  // so a runtime-rejection test here would pass vacuously.
  it('declares priority as an INTEGER so a float is rejected by the transport', () => {
    const src = readFileSync(new URL('./server.ts', import.meta.url), 'utf8');
    const desc = src.slice(src.indexOf("'hadron_update_edge'"), src.indexOf("'hadron_delete_edge'"));
    expect(desc).toMatch(/priority: z\.number\(\)\.int\(\)/);
  });

  it('declares the clearable fields as NULLABLE so null reaches the resolver', () => {
    const src = readFileSync(new URL('./server.ts', import.meta.url), 'utf8');
    const desc = src.slice(src.indexOf("'hadron_update_edge'"), src.indexOf("'hadron_delete_edge'"));
    expect(desc).toMatch(/name: z\.string\(\)\.nullable\(\)\.optional\(\)/);
    expect(desc).toMatch(/description: z\.string\(\)\.nullable\(\)\.optional\(\)/);
  });

  // PR #861 review (Codex P2 / Copilot): the description used to advertise
  // "retarget", which the schema cannot express and the resolver cannot do.
  it('does not advertise retargeting, which it cannot do', () => {
    const src = readFileSync(new URL('./server.ts', import.meta.url), 'utf8');
    const desc = src.slice(src.indexOf("'hadron_update_edge'"), src.indexOf("'hadron_delete_edge'"));
    expect(desc).not.toMatch(/relabel or retarget/);
    expect(desc).toMatch(/canNOT move an edge to a different source or target/);
  });
});

describe('hadron_delete_edge — removing one relationship (#835)', () => {
  it('deletes ONE edge and leaves the others and both nodes alone', async () => {
    const target = (await edgesOf()).find((e) => e.name === 'documented-by')!;
    const out = await call('hadron_delete_edge', { edgeRef: target.id });
    expect(out).toMatch(/Edge deleted/);
    const after = await edgesOf();
    expect(after.map((e) => e.name).sort()).toEqual(['applies-when', 'relates-to']);
    // Endpoints untouched.
    expect(await db.node.findUnique({ where: { id: source.id } })).not.toBeNull();
    expect(await db.node.findUnique({ where: { id: t2.id } })).not.toBeNull();
  });

  it('returns tool-error text for an unknown edge', async () => {
    const out = await call('hadron_delete_edge', { edgeRef: generateId() });
    expect(out).toMatch(/not found/i);
    expect((await edgesOf()).length).toBe(3);
  });
});

describe('the destructive semantics are legible at the callsite (#835 item 2)', () => {
  // The MCP harness exposes handlers, not argument descriptions, so this reads
  // the source text — the same audit-by-regex shape used elsewhere in the repo
  // for schema-text guarantees.
  const serverSource = () =>
    readFileSync(new URL('./server.ts', import.meta.url), 'utf8');

  it('hadron_update_node advertises that `edges` REPLACES, not merges', () => {
    // Pre-#835 the warning lived only on the SAFE tool (hadron_create_edge
    // advertised being non-destructive) while the dangerous one said merely
    // "Replace outgoing edges (the full set on this node)".
    const src = serverSource();
    expect(src).not.toMatch(/describe\('Replace outgoing edges \(the full set on this node\)'\)/);
    // NOTE: the apostrophe is backslash-escaped in the source string literal.
    expect(src).toMatch(/REPLACES the node.{1,2}s ENTIRE outgoing edge set/);
    expect(src).toMatch(/it does NOT merge/);
    expect(src).toMatch(/is DELETED, silently and without a diff/);
  });

  it('...and points at the single-edge tools as the alternative', () => {
    const src = serverSource();
    expect(src).toMatch(/To change ONE edge, use hadron_update_edge instead/);
    expect(src).toMatch(/to add one without touching the others, use hadron_create_edge/);
  });
});
