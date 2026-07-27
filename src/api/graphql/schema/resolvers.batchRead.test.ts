/**
 * Spec cor:api:040 — batch node read, GraphQL surface (Query.nodeBatch).
 *
 * Pins:
 *   - Explicit-set form (refs): nodes returned with content in INPUT order;
 *     nothing unavailable when all are readable.
 *   - Refs are PK-or-URN (cor:api:140, #813): a fully-qualified node URN reads
 *     in the SAME call as a PK — no resolveUrn round trip first — and dedup
 *     happens on the RESOLVED node, so a PK and that node's URN return once.
 *     A malformed / unqualified ref throws instead of hiding in `unavailable`.
 *   - Per-node authorization + partial success (cor:api:040:03): a denied node
 *     (another user's personal memory) and a missing ref both land in
 *     `unavailable` — indistinguishable, no content leak, never failing the
 *     call. Widening refs to URNs does NOT widen the reachable set (#554).
 *   - `unavailable` / `omitted` echo the CALLER'S ref strings, so a URN caller
 *     gets back a URN it can act on rather than a PK it never sent.
 *   - Prefix-subtree form: nodes under the prefix in LOC order; an unreadable
 *     memory throws (no node-level partial for a whole-memory denial).
 *   - Hard caps (cor:api:040:02): over the node-count cap throws; over the
 *     response-size cap returns a partial result flagged `truncated` + `omitted`.
 *   - Form validation: exactly one of (refs) XOR (memory + locPrefix).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph, createDbNode } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { generateId } from '../../../lib/id.js';
import { BATCH_READ_MAX_NODES } from '../../../lib/batchRead.js';

let org: { id: string; urn: string };
let graph: { id: string };
let admin: { id: string };
let pmem: { id: string };

function adminCtx(): Context {
  return { db, roles: ['ADMIN'], userId: admin.id } as Context;
}
const nodeBatch = (args: Record<string, unknown>, ctx: Context = adminCtx()) =>
  (resolvers.Query as any).nodeBatch({}, args, ctx);

/** Canonical node URN for a loc in the shared knowledge memory. */
const memUrn = (loc: string) => `bg-org::bgmem::${loc}`;

beforeEach(async () => {
  await cleanDb(db);
  const made = await createDbOrgAndGraph(db, { orgName: 'bg-org', graphName: 'bgmem' });
  org = made.org;
  graph = made.graph;
  admin = await db.user.create({
    data: { githubId: 9901, githubUsername: 'bg-admin', roles: ['ADMIN'] },
  });
  await db.orgMember.create({
    data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
  });
  const user2 = await db.user.create({
    data: { githubId: 9902, githubUsername: 'bg-user2', roles: ['READER'] },
  });
  // Free-standing personal memory owned by user2 (spec 034) — ADMIN does NOT
  // bypass personal ownership, so its nodes are the clean "denied" case.
  pmem = await db.memory.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: 'bg-org:pmem',
      name: 'pmem',
      userId: user2.id,
      class: 'personal',
      visibility: null,
    },
  });
});

describe('nodeBatch — explicit set', () => {
  it('returns nodes with content in INPUT order; nothing unavailable', async () => {
    const a = await createDbNode(db, { loc: 'a', memoryId: graph.id, content: 'A body' });
    const b = await createDbNode(db, { loc: 'b', memoryId: graph.id, content: 'B body' });
    const c = await createDbNode(db, { loc: 'c', memoryId: graph.id, content: 'C body' });

    const res = await nodeBatch({ refs: [c.id, a.id, b.id] });

    expect(res.nodes.map((n: any) => n.id)).toEqual([c.id, a.id, b.id]);
    expect(res.nodes.map((n: any) => n.content)).toEqual(['C body', 'A body', 'B body']);
    expect(res.unavailable).toEqual([]);
    expect(res.truncated).toBe(false);
  });

  it('dedups a repeated id — returns it once', async () => {
    const d = await createDbNode(db, { loc: 'dup', memoryId: graph.id, content: 'd' });
    const res = await nodeBatch({ refs: [d.id, d.id] });
    expect(res.nodes.map((n: any) => n.id)).toEqual([d.id]);
  });
});

describe('nodeBatch — refs are PK-or-URN (cor:api:140, #813)', () => {
  it('reads a fully-qualified node URN in the same call as a PK, in input order', async () => {
    const a = await createDbNode(db, { loc: 'a', memoryId: graph.id, content: 'A body' });
    const b = await createDbNode(db, { loc: 'b', memoryId: graph.id, content: 'B body' });

    const res = await nodeBatch({ refs: [memUrn('b'), a.id] });

    expect(res.nodes.map((n: any) => n.id)).toEqual([b.id, a.id]);
    expect(res.nodes.map((n: any) => n.content)).toEqual(['B body', 'A body']);
    expect(res.unavailable).toEqual([]);
  });

  it('accepts the hrn:node: prefixed form', async () => {
    const a = await createDbNode(db, { loc: 'a', memoryId: graph.id, content: 'A body' });
    const res = await nodeBatch({ refs: [`hrn:node:${memUrn('a')}`] });
    expect(res.nodes.map((n: any) => n.id)).toEqual([a.id]);
  });

  it('accepts the flat grammar-v2 form, including a colon-bearing loc', async () => {
    // What hadron-cli composes from `-m <org::memory> <bare-loc>`.
    const a = await createDbNode(db, { loc: 'a', memoryId: graph.id, content: 'A body' });
    const s = await createDbNode(db, { loc: 'sec:01', memoryId: graph.id, content: 'S body' });

    const res = await nodeBatch({ refs: ['hrn:node:bg-org:bgmem:a', 'hrn:node:bg-org:bgmem:sec:01'] });

    expect(res.nodes.map((n: any) => n.id)).toEqual([a.id, s.id]);
    expect(res.unavailable).toEqual([]);
  });

  it('dedups on the RESOLVED node — a PK and its URN return once', async () => {
    const d = await createDbNode(db, { loc: 'dup', memoryId: graph.id, content: 'd' });
    const res = await nodeBatch({ refs: [d.id, memUrn('dup')] });
    expect(res.nodes.map((n: any) => n.id)).toEqual([d.id]);
  });

  it('reports an unresolvable URN in unavailable, echoing the caller ref', async () => {
    const a = await createDbNode(db, { loc: 'a', memoryId: graph.id, content: 'A body' });
    const res = await nodeBatch({ refs: [a.id, memUrn('nope')] });
    expect(res.nodes.map((n: any) => n.id)).toEqual([a.id]);
    expect(res.unavailable).toEqual([memUrn('nope')]);
  });

  it('does NOT widen the reachable set — a denied node named by URN stays denied (#554)', async () => {
    await createDbNode(db, { loc: 'secret', memoryId: pmem.id, content: 'SECRET personal' });

    const res = await nodeBatch({ refs: ['bg-org::pmem::secret'] });

    expect(res.nodes).toEqual([]);
    // Echoed as the caller's URN, and indistinguishable from a not-found ref.
    expect(res.unavailable).toEqual(['bg-org::pmem::secret']);
    expect(JSON.stringify(res)).not.toContain('SECRET personal');
  });

  it('throws on a malformed / unqualified ref rather than hiding it in unavailable', async () => {
    await createDbNode(db, { loc: 'a', memoryId: graph.id, content: 'A body' });
    // A bare loc is the relative form — never resolvable at the API boundary.
    await expect(nodeBatch({ refs: ['a'] })).rejects.toThrow(/not fully qualified/i);
  });
});

describe('nodeBatch — partial success', () => {
  it('returns the readable subset; denied + missing land in unavailable; no leak', async () => {
    const ok = await createDbNode(db, { loc: 'ok', memoryId: graph.id, content: 'readable body' });
    const secret = await createDbNode(db, { loc: 'secret', memoryId: pmem.id, content: 'SECRET personal' });
    const missing = generateId(); // ID-shaped, names no node

    const res = await nodeBatch({ refs: [ok.id, secret.id, missing] });

    expect(res.nodes.map((n: any) => n.id)).toEqual([ok.id]);
    expect([...res.unavailable].sort()).toEqual([secret.id, missing].sort());
    expect(JSON.stringify(res.nodes)).not.toContain('SECRET personal');
  });
});

describe('nodeBatch — prefix subtree', () => {
  it('returns nodes under the prefix in LOC order', async () => {
    await createDbNode(db, { loc: 'sec:03', memoryId: graph.id, content: '3' });
    await createDbNode(db, { loc: 'sec:01', memoryId: graph.id, content: '1' });
    await createDbNode(db, { loc: 'sec:02', memoryId: graph.id, content: '2' });
    await createDbNode(db, { loc: 'other', memoryId: graph.id, content: 'x' });

    const res = await nodeBatch({ memory: graph.id, locPrefix: 'sec:' });

    expect(res.nodes.map((n: any) => n.loc)).toEqual(['sec:01', 'sec:02', 'sec:03']);
    expect(res.unavailable).toEqual([]);
  });

  it('throws on a memory the caller cannot read', async () => {
    await expect(nodeBatch({ memory: pmem.id, locPrefix: '' })).rejects.toThrow(/not accessible/i);
  });
});

describe('nodeBatch — hard caps', () => {
  it('throws over the node-count cap (loud, not a silent short read)', async () => {
    // Capped on the INPUT count, before any ref is resolved.
    const refs = Array.from({ length: BATCH_READ_MAX_NODES + 1 }, () => generateId());
    await expect(nodeBatch({ refs })).rejects.toThrow(/cap/);
  });

  it('flags truncated over the response-size cap', async () => {
    const big = 'x'.repeat(600_000); // two of these blow the 1MB size cap
    const b1 = await createDbNode(db, { loc: 'big1', memoryId: graph.id, content: big });
    const b2 = await createDbNode(db, { loc: 'big2', memoryId: graph.id, content: big });

    const res = await nodeBatch({ refs: [b1.id, b2.id] });

    expect(res.nodes.map((n: any) => n.id)).toEqual([b1.id]);
    expect(res.truncated).toBe(true);
    expect(res.omitted).toEqual([b2.id]);
  });

  it('omitted echoes the caller ref when the dropped node was named by URN', async () => {
    const big = 'x'.repeat(600_000);
    const b1 = await createDbNode(db, { loc: 'big1', memoryId: graph.id, content: big });
    await createDbNode(db, { loc: 'big2', memoryId: graph.id, content: big });

    const res = await nodeBatch({ refs: [b1.id, memUrn('big2')] });

    expect(res.truncated).toBe(true);
    expect(res.omitted).toEqual([memUrn('big2')]);
  });
});

describe('nodeBatch — form validation', () => {
  it('rejects neither form', async () => {
    await expect(nodeBatch({})).rejects.toThrow(/EITHER/);
  });
  it('rejects both forms at once', async () => {
    await expect(nodeBatch({ refs: ['x'], memory: graph.id, locPrefix: 'a' })).rejects.toThrow(/EITHER/);
  });
});
